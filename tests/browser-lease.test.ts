import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_LEASE_DEFAULT_TTL_MS,
  LOCK_CORRUPT_STALE_MS,
  BrowserLeaseError,
  acquireBrowserLease,
  acquireLeaseLock,
  browserLeaseFile,
  browserLeaseLockFile,
  getBrowserLeaseStatus,
  releaseBrowserLease,
  releaseLeaseLock,
  renewBrowserLease,
  resumeBrowserControl,
  takeBrowserControl,
  type BrowserLeaseStateV1,
  type BrowserLeaseView,
} from "../src/browser/lease.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const leaseModuleUrl = pathToFileURL(path.join(projectRoot, "src", "browser", "lease.ts")).href;

const WORKSPACE = "browser-lease-test-workspace";

function captureError(fn: () => unknown): BrowserLeaseError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BrowserLeaseError) return error;
    throw error;
  }
  throw new Error("expected a BrowserLeaseError to be thrown");
}

function readRawState(workspaceId = WORKSPACE): BrowserLeaseStateV1 {
  return JSON.parse(fs.readFileSync(browserLeaseFile(workspaceId), "utf8")) as BrowserLeaseStateV1;
}

function writeRawState(workspaceId: string, state: unknown): void {
  const file = browserLeaseFile(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function spawnAndReapChild(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => resolve(child.pid ?? 0));
  });
}

interface ChildResult {
  ok: boolean;
  code?: string;
  leaseId?: string | null;
}

interface LeaseChild {
  ready: Promise<void>;
  result: Promise<ChildResult>;
  go: () => void;
}

/**
 * Real cross-process contender for test 25. Imports the lease module through
 * tsx, announces READY, blocks on stdin, then races acquire.
 */
function spawnLeaseChild(workspaceId: string): LeaseChild {
  const script = [
    `const { acquireBrowserLease } = await import(${JSON.stringify(leaseModuleUrl)});`,
    `process.stdout.write("READY\\n");`,
    `await new Promise((resolve) => { process.stdin.once("data", () => resolve(undefined)); process.stdin.resume(); });`,
    `try {`,
    `  const result = acquireBrowserLease(process.env.C2C_RACE_WORKSPACE);`,
    `  process.stdout.write("RESULT " + JSON.stringify({ ok: true, leaseId: result.state.leaseId }) + "\\n");`,
    `} catch (error) {`,
    `  const code = error && error.code ? error.code : "UNKNOWN";`,
    `  process.stdout.write("RESULT " + JSON.stringify({ ok: false, code }) + "\\n");`,
    `}`,
    `process.exit(0);`,
  ].join("\n");

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: { ...process.env, C2C_RACE_WORKSPACE: workspaceId },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let readyResolve: () => void = () => undefined;
  let resultResolve: (value: ChildResult) => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const result = new Promise<ChildResult>((resolve) => {
    resultResolve = resolve;
  });

  let buffer = "";
  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === "READY") readyResolve();
    else if (trimmed.startsWith("RESULT ")) resultResolve(JSON.parse(trimmed.slice("RESULT ".length)) as ChildResult);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  child.on("exit", (code) => {
    if (buffer.trim() !== "") handleLine(buffer);
    resultResolve({ ok: false, code: `EXIT_${code ?? "null"}` });
  });
  child.on("error", () => resultResolve({ ok: false, code: "SPAWN_ERROR" }));

  return {
    ready,
    result,
    go: () => {
      child.stdin.write("go\n");
    },
  };
}

async function runAcquireRace(workspaceId: string): Promise<ChildResult[]> {
  const a = spawnLeaseChild(workspaceId);
  const b = spawnLeaseChild(workspaceId);
  await Promise.all([a.ready, b.ready]);
  a.go();
  b.go();
  return Promise.all([a.result, b.result]);
}

interface LockRaceChildResult {
  ok: boolean;
  code?: string;
  pid?: number;
  criticalCount?: number;
}

interface LockRaceChild {
  ready: Promise<void>;
  result: Promise<LockRaceChildResult>;
  go: () => void;
}

/**
 * Real cross-process contenders for stale-lock recovery. Each child acquires
 * the raw mutation lock, records a marker while inside the critical section,
 * holds the lock briefly, and releases it. The parent polls the marker
 * directory and each child also reports how many markers it observed.
 */
function spawnLockRaceChild(workspaceId: string, criticalDir: string): LockRaceChild {
  const script = [
    `const { acquireLeaseLock, releaseLeaseLock } = await import(${JSON.stringify(leaseModuleUrl)});`,
    `const fs = await import("node:fs");`,
    `const path = await import("node:path");`,
    `process.stdout.write("READY\\n");`,
    `await new Promise((resolve) => { process.stdin.once("data", () => resolve(undefined)); process.stdin.resume(); });`,
    `let lock = null;`,
    `try {`,
    `  lock = acquireLeaseLock(process.env.C2C_RACE_WORKSPACE);`,
    `  const marker = path.join(process.env.C2C_CRITICAL_DIR, "active-" + process.pid);`,
    `  fs.writeFileSync(marker, "1");`,
    `  const active = fs.readdirSync(process.env.C2C_CRITICAL_DIR).filter((name) => name.startsWith("active-"));`,
    `  process.stdout.write("CRITICAL " + JSON.stringify({ pid: process.pid, count: active.length }) + "\\n");`,
    `  await new Promise((resolve) => setTimeout(resolve, 120));`,
    `  fs.unlinkSync(marker);`,
    `  releaseLeaseLock(lock);`,
    `  process.stdout.write("RESULT " + JSON.stringify({ ok: true, pid: process.pid }) + "\\n");`,
    `} catch (error) {`,
    `  const code = error && error.code ? error.code : "UNKNOWN";`,
    `  process.stdout.write("RESULT " + JSON.stringify({ ok: false, code, pid: process.pid }) + "\\n");`,
    `}`,
    `process.exit(0);`,
  ].join("\n");

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: { ...process.env, C2C_RACE_WORKSPACE: workspaceId, C2C_CRITICAL_DIR: criticalDir },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let readyResolve: () => void = () => undefined;
  let resultResolve: (value: LockRaceChildResult) => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const result = new Promise<LockRaceChildResult>((resolve) => {
    resultResolve = resolve;
  });

  let criticalCount: number | undefined;
  let buffer = "";
  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === "READY") readyResolve();
    else if (trimmed.startsWith("CRITICAL ")) {
      const parsed = JSON.parse(trimmed.slice("CRITICAL ".length)) as { count?: number };
      criticalCount = parsed.count;
    } else if (trimmed.startsWith("RESULT ")) {
      const parsed = JSON.parse(trimmed.slice("RESULT ".length)) as LockRaceChildResult;
      resultResolve({ ...parsed, criticalCount });
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  child.on("exit", (code) => {
    if (buffer.trim() !== "") handleLine(buffer);
    resultResolve({ ok: false, code: `EXIT_${code ?? "null"}`, criticalCount });
  });
  child.on("error", () => resultResolve({ ok: false, code: "SPAWN_ERROR", criticalCount }));
  child.stdin.on("error", () => undefined);

  return {
    ready,
    result,
    go: () => {
      child.stdin.write("go\n");
    },
  };
}

describe("browser lease", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    dirs.push(isolateStateDir());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
    delete process.env.C2C_LEASE_LOCK_TIMEOUT_MS;
  });

  it("1. missing state file reads as available and is not created", () => {
    const state: BrowserLeaseView = getBrowserLeaseStatus(WORKSPACE);
    expect(state).toMatchObject({ owner: "available", leaseId: null, expiresAt: null, revision: 0, expired: false });
    expect(fs.existsSync(browserLeaseFile(WORKSPACE))).toBe(false);
  });

  it("2. acquire creates an agent lease with the required fields", () => {
    const result = acquireBrowserLease(WORKSPACE);
    expect(result.changed).toBe(true);
    expect(result.state.owner).toBe("agent");
    expect(result.state.leaseId).toBeTruthy();
    expect(result.state.acquiredAt).toBeTruthy();
    expect(typeof result.state.expiresAt).toBe("number");
    expect(result.state.expiresAt! - Date.now()).toBeLessThanOrEqual(BROWSER_LEASE_DEFAULT_TTL_MS);
    expect(result.state.revision).toBe(1);
    expect(getBrowserLeaseStatus(WORKSPACE).leaseId).toBe(result.state.leaseId);
  });

  it("3. a second acquire is rejected with BROWSER_BUSY", () => {
    const first = acquireBrowserLease(WORKSPACE);
    const error = captureError(() => acquireBrowserLease(WORKSPACE));
    expect(error.code).toBe("BROWSER_BUSY");
    expect(error.exitCode).toBe(3);
    expect(error.state?.leaseId).toBe(first.state.leaseId);
    expect(getBrowserLeaseStatus(WORKSPACE).leaseId).toBe(first.state.leaseId);
  });

  it("4. renew extends a matching active lease", () => {
    const first = acquireBrowserLease(WORKSPACE, { ttlMs: 1_000 });
    const renewed = renewBrowserLease(WORKSPACE, first.state.leaseId!, { ttlMs: 60_000 });
    expect(renewed.changed).toBe(true);
    expect(renewed.state.expiresAt!).toBeGreaterThan(first.state.expiresAt!);
    expect(renewed.state.revision).toBe(first.state.revision + 1);
  });

  it("5. renew with a wrong lease id is LEASE_STALE", () => {
    acquireBrowserLease(WORKSPACE);
    const error = captureError(() => renewBrowserLease(WORKSPACE, "not-the-lease"));
    expect(error.code).toBe("LEASE_STALE");
    expect(error.exitCode).toBe(4);
  });

  it("6. release hands the lease back to available", () => {
    const first = acquireBrowserLease(WORKSPACE);
    const released = releaseBrowserLease(WORKSPACE, first.state.leaseId!);
    expect(released.changed).toBe(true);
    expect(released.state.owner).toBe("available");
    expect(getBrowserLeaseStatus(WORKSPACE).owner).toBe("available");
    const again = acquireBrowserLease(WORKSPACE);
    expect(again.state.leaseId).not.toBe(first.state.leaseId);
  });

  it("7. a stale release cannot clear a newer lease", () => {
    const a = acquireBrowserLease(WORKSPACE);
    releaseBrowserLease(WORKSPACE, a.state.leaseId!);
    const b = acquireBrowserLease(WORKSPACE);
    const error = captureError(() => releaseBrowserLease(WORKSPACE, a.state.leaseId!));
    expect(error.code).toBe("LEASE_STALE");
    const current = getBrowserLeaseStatus(WORKSPACE);
    expect(current.owner).toBe("agent");
    expect(current.leaseId).toBe(b.state.leaseId);
  });

  it("8. take preempts an active agent lease", () => {
    const a = acquireBrowserLease(WORKSPACE);
    const taken = takeBrowserControl(WORKSPACE);
    expect(taken.changed).toBe(true);
    expect(taken.state.owner).toBe("user");
    expect(taken.state.leaseId).toBeNull();
    expect(taken.state.expiresAt).toBeNull();
    expect(taken.state.acquiredAt).toBeTruthy();
    expect(taken.state.revision).toBe(a.state.revision + 1);
  });

  it("9. the preempted agent lease is stale for renew and release", () => {
    const a = acquireBrowserLease(WORKSPACE);
    takeBrowserControl(WORKSPACE);
    expect(captureError(() => renewBrowserLease(WORKSPACE, a.state.leaseId!)).code).toBe("LEASE_STALE");
    expect(captureError(() => releaseBrowserLease(WORKSPACE, a.state.leaseId!)).code).toBe("LEASE_STALE");
    expect(getBrowserLeaseStatus(WORKSPACE).owner).toBe("user");
  });

  it("10. acquire is denied while the user holds control", () => {
    takeBrowserControl(WORKSPACE);
    const error = captureError(() => acquireBrowserLease(WORKSPACE));
    expect(error.code).toBe("USER_CONTROL");
    expect(error.exitCode).toBe(3);
    expect(error.state?.owner).toBe("user");
  });

  it("11. resume returns user control to available", () => {
    takeBrowserControl(WORKSPACE);
    const result = resumeBrowserControl(WORKSPACE);
    expect(result.changed).toBe(true);
    expect(result.state.owner).toBe("available");
    expect(result.state.leaseId).toBeNull();
    expect(getBrowserLeaseStatus(WORKSPACE).owner).toBe("available");
  });

  it("12. resume on available is idempotent and creates no state file", () => {
    const missing = resumeBrowserControl(WORKSPACE);
    expect(missing.changed).toBe(false);
    expect(missing.state.owner).toBe("available");
    expect(missing.state.revision).toBe(0);
    expect(fs.existsSync(browserLeaseFile(WORKSPACE))).toBe(false);

    const a = acquireBrowserLease(WORKSPACE);
    releaseBrowserLease(WORKSPACE, a.state.leaseId!);
    const before = readRawState();
    const second = resumeBrowserControl(WORKSPACE);
    const after = readRawState();
    expect(second.changed).toBe(false);
    expect(after).toEqual(before);
  });

  it("13. resume while an agent lease is active is AGENT_CONTROL", () => {
    acquireBrowserLease(WORKSPACE);
    const error = captureError(() => resumeBrowserControl(WORKSPACE));
    expect(error.code).toBe("AGENT_CONTROL");
    expect(error.exitCode).toBe(3);
  });

  it("14. user control never expires", () => {
    takeBrowserControl(WORKSPACE);
    const raw = readRawState();
    writeRawState(WORKSPACE, { ...raw, acquiredAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" });
    const state = getBrowserLeaseStatus(WORKSPACE);
    expect(state.owner).toBe("user");
    expect(state.expired).toBe(false);
    expect(state.expiresAt).toBeNull();
    expect(resumeBrowserControl(WORKSPACE).state.owner).toBe("available");
  });

  it("15. an expired agent lease can be reacquired with a new lease id", () => {
    const first = acquireBrowserLease(WORKSPACE, { ttlMs: -1_000 });
    expect(getBrowserLeaseStatus(WORKSPACE).expired).toBe(true);
    const second = acquireBrowserLease(WORKSPACE);
    expect(second.changed).toBe(true);
    expect(second.state.leaseId).not.toBe(first.state.leaseId);
    expect(second.state.revision).toBe(first.state.revision + 1);
    expect(second.state.expired).toBe(false);
  });

  it("16. renew of a matching expired lease is LEASE_EXPIRED", () => {
    const first = acquireBrowserLease(WORKSPACE, { ttlMs: -1_000 });
    const error = captureError(() => renewBrowserLease(WORKSPACE, first.state.leaseId!));
    expect(error.code).toBe("LEASE_EXPIRED");
    expect(error.exitCode).toBe(4);
  });

  it("17. release of a matching expired lease returns to available", () => {
    const first = acquireBrowserLease(WORKSPACE, { ttlMs: -1_000 });
    const released = releaseBrowserLease(WORKSPACE, first.state.leaseId!);
    expect(released.changed).toBe(true);
    expect(released.state.owner).toBe("available");
  });

  it("18. corrupt state fails closed for status/acquire/renew/release/resume", () => {
    const file = browserLeaseFile(WORKSPACE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json");

    const brokenJson: Array<[string, () => unknown]> = [
      ["status", () => getBrowserLeaseStatus(WORKSPACE)],
      ["acquire", () => acquireBrowserLease(WORKSPACE)],
      ["renew", () => renewBrowserLease(WORKSPACE, "any")],
      ["release", () => releaseBrowserLease(WORKSPACE, "any")],
      ["resume", () => resumeBrowserControl(WORKSPACE)],
    ];
    for (const [name, op] of brokenJson) {
      const error = captureError(op);
      expect(error.code, name).toBe("STATE_CORRUPT");
      expect(error.exitCode, name).toBe(5);
    }
    expect(fs.readFileSync(file, "utf8")).toBe("{ this is not json");

    writeRawState(WORKSPACE, { version: 1, owner: "agent", leaseId: null, acquiredAt: null, expiresAt: null, updatedAt: null, revision: 1 });
    const schemaError = captureError(() => getBrowserLeaseStatus(WORKSPACE));
    expect(schemaError.code).toBe("STATE_CORRUPT");
  });

  it("19. take copies corrupt state to quarantine and produces a user lease", () => {
    const file = browserLeaseFile(WORKSPACE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "totally broken");
    const result = takeBrowserControl(WORKSPACE);
    expect(result.changed).toBe(true);
    expect(result.recoveredFromCorrupt).toBe(true);
    expect(result.state.owner).toBe("user");
    expect(getBrowserLeaseStatus(WORKSPACE).owner).toBe("user");

    const dir = path.dirname(file);
    const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith(`${WORKSPACE}.json.corrupt-`));
    expect(quarantined.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, quarantined[0]), "utf8")).toBe("totally broken");
  });

  it("20. a lock held by a live PID times out with LOCK_TIMEOUT", () => {
    process.env.C2C_LEASE_LOCK_TIMEOUT_MS = "250";
    const lockPath = browserLeaseLockFile(WORKSPACE);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ lockId: "live", pid: process.pid, createdAt: Date.now() }));

    const error = captureError(() => acquireBrowserLease(WORKSPACE));
    expect(error.code).toBe("LOCK_TIMEOUT");
    expect(error.exitCode).toBe(3);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(browserLeaseFile(WORKSPACE))).toBe(false);
    fs.unlinkSync(lockPath);
  });

  it("21. a lock held by a dead PID is recovered", async () => {
    let deadPid = await spawnAndReapChild();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        process.kill(deadPid, 0);
        deadPid = await spawnAndReapChild();
      } catch {
        break;
      }
    }
    const lockPath = browserLeaseLockFile(WORKSPACE);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ lockId: "dead", pid: deadPid, createdAt: Date.now() }));

    const result = acquireBrowserLease(WORKSPACE);
    expect(result.state.owner).toBe("agent");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("22. a stale corrupt lock is cleared; a fresh corrupt lock is not", () => {
    process.env.C2C_LEASE_LOCK_TIMEOUT_MS = "200";
    const lockPath = browserLeaseLockFile(WORKSPACE);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    fs.writeFileSync(lockPath, "not-a-lock");
    expect(captureError(() => acquireBrowserLease(WORKSPACE)).code).toBe("LOCK_TIMEOUT");
    expect(fs.existsSync(lockPath)).toBe(true);

    const old = new Date(Date.now() - (LOCK_CORRUPT_STALE_MS + 60_000));
    fs.utimesSync(lockPath, old, old);
    const result = acquireBrowserLease(WORKSPACE);
    expect(result.state.owner).toBe("agent");
  });

  it("23. releasing a lock does not unlink a replacement lock", () => {
    const lock = acquireLeaseLock(WORKSPACE);
    fs.unlinkSync(lock.path);
    fs.writeFileSync(lock.path, JSON.stringify({ lockId: "someone-else", pid: process.pid, createdAt: Date.now() }));
    releaseLeaseLock(lock);
    expect(fs.existsSync(lock.path)).toBe(true);
    expect((JSON.parse(fs.readFileSync(lock.path, "utf8")) as { lockId: string }).lockId).toBe("someone-else");
  });

  it("24. state writes replace by rename and leave no temp or partial JSON", () => {
    const file = browserLeaseFile(WORKSPACE);
    const first = acquireBrowserLease(WORKSPACE);
    const inodeAfterAcquire = fs.statSync(file).ino;
    releaseBrowserLease(WORKSPACE, first.state.leaseId!);
    const inodeAfterRelease = fs.statSync(file).ino;
    expect(inodeAfterRelease).not.toBe(inodeAfterAcquire);

    const dir = path.dirname(file);
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).not.toThrow();
    expect(Object.keys(readRawState()).sort()).toEqual([
      "acquiredAt",
      "expiresAt",
      "leaseId",
      "owner",
      "revision",
      "updatedAt",
      "version",
    ]);
  });

  it(
    "25. two child processes racing acquire yield exactly one winner and one BROWSER_BUSY",
    async () => {
      const rounds = 5;
      for (let round = 0; round < rounds; round++) {
        const workspaceId = `race-${round}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const results = await runAcquireRace(workspaceId);
        const winners = results.filter((entry) => entry.ok);
        const busy = results.filter((entry) => entry.code === "BROWSER_BUSY");
        expect(winners.length, `round ${round}: ${JSON.stringify(results)}`).toBe(1);
        expect(busy.length, `round ${round}: ${JSON.stringify(results)}`).toBe(1);

        const state = readRawState(workspaceId);
        expect(state.owner).toBe("agent");
        expect(state.leaseId).toBe(winners[0].leaseId);
        expect(getBrowserLeaseStatus(workspaceId).leaseId).toBe(winners[0].leaseId);
      }
    },
    120_000
  );

  it("26. take keeps canonical corrupt state when the replacement write fails", () => {
    const file = browserLeaseFile(WORKSPACE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "totally broken");

    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("injected state rename failure");
    });

    const error = captureError(() => takeBrowserControl(WORKSPACE));
    expect(error.code).toBe("STATE_IO");
    expect(error.exitCode).toBe(1);
    renameSpy.mockRestore();

    const statusError = captureError(() => getBrowserLeaseStatus(WORKSPACE));
    expect(statusError.code).toBe("STATE_CORRUPT");
    expect(statusError.exitCode).toBe(5);
    expect(fs.readFileSync(file, "utf8")).toBe("totally broken");

    const dir = path.dirname(file);
    const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith(`${WORKSPACE}.json.corrupt-`));
    expect(quarantined.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, quarantined[0]), "utf8")).toBe("totally broken");
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it(
    "27. two child processes racing stale-lock recovery hold the mutation lock serially (12 rounds)",
    async () => {
      const rounds = 12;
      for (let round = 0; round < rounds; round++) {
        const workspaceId = `stale-race-${round}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const lockPath = browserLeaseLockFile(workspaceId);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(
          lockPath,
          JSON.stringify({ lockId: `stale-${round}`, pid: -1, createdAt: Date.now() - 60_000 })
        );

        const criticalDir = path.join(process.env.C2C_STATE_DIR!, `critical-${round}-${Date.now()}`);
        fs.mkdirSync(criticalDir, { recursive: true });

        const observed: number[] = [];
        let polling = true;
        const poll = (async () => {
          while (polling) {
            try {
              observed.push(fs.readdirSync(criticalDir).filter((name) => name.startsWith("active-")).length);
            } catch {
              /* directory is cleaned up only after the loop */
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })();

        const a = spawnLockRaceChild(workspaceId, criticalDir);
        const b = spawnLockRaceChild(workspaceId, criticalDir);
        await Promise.all([a.ready, b.ready]);
        a.go();
        b.go();
        const results = await Promise.all([a.result, b.result]);
        polling = false;
        await poll;

        expect(results.every((entry) => entry.ok), `round ${round}: ${JSON.stringify(results)}`).toBe(true);
        for (const entry of results) {
          expect(entry.criticalCount, `round ${round}: ${JSON.stringify(results)}`).toBe(1);
        }
        expect(Math.max(0, ...observed), `round ${round}: observed critical counts ${JSON.stringify(observed)}`).toBeLessThanOrEqual(1);
        expect(fs.existsSync(`${browserLeaseLockFile(workspaceId)}.recover`), `round ${round}: recovery guard leaked`).toBe(false);
        expect(fs.existsSync(lockPath), `round ${round}: mutation lock leaked`).toBe(false);
      }
    },
    180_000
  );
});
