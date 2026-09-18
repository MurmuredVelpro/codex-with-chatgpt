import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

interface BrowserCliPayload {
  ok: boolean;
  action?: string;
  code?: string;
  changed?: boolean;
  state?: { owner: string; leaseId: string | null; expired: boolean; revision: number };
}

function parsePayload(result: ReturnType<typeof runCli>): BrowserCliPayload {
  return JSON.parse(result.stdout) as BrowserCliPayload;
}

describe("c2c browser CLI", () => {
  let stateDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    stateDir = isolateStateDir();
    workspaceDir = makeTmpDir("browser-cli-workspace");
  });

  afterEach(() => {
    cleanup(stateDir);
    cleanup(workspaceDir);
    delete process.env.C2C_STATE_DIR;
  });

  function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
    return runCli([...args, "-w", workspaceDir, "--json"], { C2C_STATE_DIR: stateDir, ...env });
  }

  it("browser status defaults and exits 0 with available", () => {
    const result = cli(["browser"]);
    expect(result.stderr).not.toMatch(/unknown option/i);
    expect(result.status).toBe(0);
    const payload = parsePayload(result);
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("status");
    expect(payload.changed).toBe(false);
    expect(payload.state?.owner).toBe("available");
    expect(payload.state?.revision).toBe(0);
  });

  it("acquire exits 0 and a second acquire exits 3 with BROWSER_BUSY", () => {
    const acquired = cli(["browser", "acquire"]);
    expect(acquired.status).toBe(0);
    const acquiredPayload = parsePayload(acquired);
    expect(acquiredPayload.ok).toBe(true);
    expect(acquiredPayload.state?.owner).toBe("agent");
    expect(acquiredPayload.state?.leaseId).toBeTruthy();

    const second = cli(["browser", "acquire"]);
    expect(second.status).toBe(3);
    const secondPayload = parsePayload(second);
    expect(secondPayload.ok).toBe(false);
    expect(secondPayload.code).toBe("BROWSER_BUSY");
    expect(secondPayload.state?.leaseId).toBe(acquiredPayload.state?.leaseId);
  });

  it("take exits 0 and acquire under user control exits 3 with USER_CONTROL", () => {
    const taken = cli(["browser", "take"]);
    expect(taken.status).toBe(0);
    expect(parsePayload(taken).state?.owner).toBe("user");

    const blocked = cli(["browser", "acquire"]);
    expect(blocked.status).toBe(3);
    const payload = parsePayload(blocked);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("USER_CONTROL");
  });

  it("resume exits 0 and returns the lease to available", () => {
    cli(["browser", "take"]);
    const resumed = cli(["browser", "resume"]);
    expect(resumed.status).toBe(0);
    expect(parsePayload(resumed).state?.owner).toBe("available");

    const status = cli(["browser", "status"]);
    expect(status.status).toBe(0);
    expect(parsePayload(status).state?.owner).toBe("available");
  });

  it("stale renew and release exit 4 with LEASE_STALE", () => {
    const acquire = cli(["browser", "acquire"]);
    expect(acquire.status).toBe(0);

    const renew = cli(["browser", "renew", "--lease", "not-a-real-lease"]);
    expect(renew.status).toBe(4);
    expect(parsePayload(renew).code).toBe("LEASE_STALE");

    const release = cli(["browser", "release", "--lease", "not-a-real-lease"]);
    expect(release.status).toBe(4);
    expect(parsePayload(release).code).toBe("LEASE_STALE");

    const status = cli(["browser", "status"]);
    expect(parsePayload(status).state?.owner).toBe("agent");
  });

  it("renew and release with the live lease id exit 0", () => {
    const acquired = parsePayload(cli(["browser", "acquire"]));
    const leaseId = acquired.state?.leaseId ?? "";

    const renewed = cli(["browser", "renew", "--lease", leaseId]);
    expect(renewed.status).toBe(0);
    expect(parsePayload(renewed).changed).toBe(true);

    const released = cli(["browser", "release", "--lease", leaseId]);
    expect(released.status).toBe(0);
    expect(parsePayload(released).state?.owner).toBe("available");
  });

  it("corrupt state makes status exit 5 with STATE_CORRUPT", () => {
    const acquire = cli(["browser", "acquire"]);
    expect(acquire.status).toBe(0);
    const leaseDir = path.join(stateDir, "browser-leases");
    const leaseFiles = fs
      .readdirSync(leaseDir)
      .filter((name) => name.endsWith(".json") && !name.includes(".corrupt-"));
    expect(leaseFiles.length).toBe(1);
    fs.writeFileSync(path.join(leaseDir, leaseFiles[0]), "{ broken");

    const status = cli(["browser", "status"]);
    expect(status.status).toBe(5);
    const payload = parsePayload(status);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("STATE_CORRUPT");
  });
});
