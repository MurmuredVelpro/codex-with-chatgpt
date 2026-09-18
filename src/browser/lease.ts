import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * Browser Lease: cooperative single-writer gate for the Playwright MCP surface.
 *
 * Independent of SavedSession / ProtocolState. One state file per workspace:
 *   <stateDir>/browser-leases/<workspaceId>.json
 * plus a short-lived mutation lock:
 *   <stateDir>/browser-leases/<workspaceId>.lock
 *
 * The file lock only guards the local read-modify-write critical section.
 * It must never be held across a Playwright MCP RPC.
 */

export type BrowserOwner = "available" | "agent" | "user";

export interface BrowserLeaseStateV1 {
  version: 1;
  owner: BrowserOwner;
  leaseId: string | null;
  acquiredAt: string | null;
  expiresAt: number | null;
  updatedAt: string | null;
  revision: number;
}

export interface BrowserLeaseView extends BrowserLeaseStateV1 {
  expired: boolean;
}

export interface BrowserLeaseResult {
  changed: boolean;
  state: BrowserLeaseView;
  recoveredFromCorrupt?: boolean;
}

export type BrowserLeaseErrorCode =
  | "BROWSER_BUSY"
  | "USER_CONTROL"
  | "AGENT_CONTROL"
  | "LEASE_STALE"
  | "LEASE_EXPIRED"
  | "LOCK_TIMEOUT"
  | "STATE_CORRUPT"
  | "STATE_IO";

const EXIT_CODES: Record<BrowserLeaseErrorCode, number> = {
  BROWSER_BUSY: 3,
  USER_CONTROL: 3,
  AGENT_CONTROL: 3,
  LOCK_TIMEOUT: 3,
  LEASE_STALE: 4,
  LEASE_EXPIRED: 4,
  STATE_CORRUPT: 5,
  STATE_IO: 1,
};

export class BrowserLeaseError extends Error {
  readonly code: BrowserLeaseErrorCode;
  readonly exitCode: number;
  readonly state?: BrowserLeaseView;

  constructor(code: BrowserLeaseErrorCode, message: string, state?: BrowserLeaseView) {
    super(message);
    this.name = "BrowserLeaseError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.state = state;
  }
}

export const BROWSER_LEASE_DEFAULT_TTL_MS = 30 * 60 * 1000;
/** A corrupt lock is only cleared once it is older than this. */
export const LOCK_CORRUPT_STALE_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 25;
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 2_000;
const LOCK_TIMEOUT_ENV = "C2C_LEASE_LOCK_TIMEOUT_MS";

function lockAcquireTimeoutMs(): number {
  const raw = process.env[LOCK_TIMEOUT_ENV]?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function browserLeaseFile(workspaceId: string): string {
  return path.join(getStateDir(), "browser-leases", `${workspaceId}.json`);
}

export function browserLeaseLockFile(workspaceId: string): string {
  return path.join(getStateDir(), "browser-leases", `${workspaceId}.lock`);
}

function missingState(): BrowserLeaseStateV1 {
  return {
    version: 1,
    owner: "available",
    leaseId: null,
    acquiredAt: null,
    expiresAt: null,
    updatedAt: null,
    revision: 0,
  };
}

function availableState(revision: number, now: number): BrowserLeaseStateV1 {
  return { ...missingState(), updatedAt: iso(now), revision };
}

function userState(revision: number, now: number): BrowserLeaseStateV1 {
  return {
    version: 1,
    owner: "user",
    leaseId: null,
    acquiredAt: iso(now),
    expiresAt: null,
    updatedAt: iso(now),
    revision,
  };
}

function agentState(leaseId: string, revision: number, now: number, ttlMs: number): BrowserLeaseStateV1 {
  return {
    version: 1,
    owner: "agent",
    leaseId,
    acquiredAt: iso(now),
    expiresAt: now + ttlMs,
    updatedAt: iso(now),
    revision,
  };
}

function addIssue(ctx: z.RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
}

const stateSchema = z
  .object({
    version: z.literal(1),
    owner: z.enum(["available", "agent", "user"]),
    leaseId: z.string().min(1).nullable(),
    acquiredAt: z.string().min(1).nullable(),
    expiresAt: z.number().int().nullable(),
    updatedAt: z.string().min(1).nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.owner === "available") {
      if (value.leaseId !== null) addIssue(ctx, "leaseId", "available lease must not carry a leaseId");
      if (value.expiresAt !== null) addIssue(ctx, "expiresAt", "available lease must not expire");
      if (value.acquiredAt !== null) addIssue(ctx, "acquiredAt", "available lease must not carry acquiredAt");
      return;
    }
    if (value.owner === "agent") {
      if (value.leaseId === null) addIssue(ctx, "leaseId", "agent lease requires a leaseId");
      if (value.acquiredAt === null) addIssue(ctx, "acquiredAt", "agent lease requires acquiredAt");
      if (value.expiresAt === null) addIssue(ctx, "expiresAt", "agent lease requires expiresAt");
      return;
    }
    if (value.leaseId !== null) addIssue(ctx, "leaseId", "user lease must not carry a leaseId");
    if (value.expiresAt !== null) addIssue(ctx, "expiresAt", "user lease must never expire");
    if (value.acquiredAt === null) addIssue(ctx, "acquiredAt", "user lease requires acquiredAt");
  });

/** Strict read. Returns null only for a genuinely missing file; corrupt state fails closed. */
function readLeaseState(file: string): BrowserLeaseStateV1 | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new BrowserLeaseError("STATE_IO", `cannot read browser lease state: ${describeError(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BrowserLeaseError("STATE_CORRUPT", "browser lease state is not valid JSON");
  }
  const result = stateSchema.safeParse(parsed);
  if (!result.success) {
    throw new BrowserLeaseError("STATE_CORRUPT", "browser lease state does not match BrowserLeaseStateV1");
  }
  return result.data;
}

/** Atomic replace: temp file -> fsync -> rename. Never truncate the live target in place. */
function writeLeaseStateAtomic(file: string, state: BrowserLeaseStateV1): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      /* ignore */
    }
    if (error instanceof BrowserLeaseError) throw error;
    throw new BrowserLeaseError("STATE_IO", `cannot write browser lease state: ${describeError(error)}`);
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without chmod semantics */
  }
}

function quarantineCorruptState(file: string): string {
  const target = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
  try {
    fs.renameSync(file, target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return target;
    throw new BrowserLeaseError("STATE_IO", `cannot quarantine corrupt browser lease state: ${describeError(error)}`);
  }
  return target;
}

export interface LeaseLockHandle {
  path: string;
  lockId: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    // EPERM means the process exists but is owned by another user; anything
    // else is also treated as alive so we never reap someone else's lock.
    return true;
  }
}

function lockAgeMs(lockPath: string): number | null {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

/** "recoverable" = safe to unlink and retry; "wait" = back off. */
function inspectLeaseLock(lockPath: string): "recoverable" | "wait" {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "recoverable";
    throw new BrowserLeaseError("STATE_IO", `cannot read browser lease lock: ${describeError(error)}`);
  }
  let meta: unknown = null;
  try {
    meta = JSON.parse(raw);
  } catch {
    meta = null;
  }
  const pid =
    typeof meta === "object" && meta !== null && typeof (meta as { pid?: unknown }).pid === "number"
      ? (meta as { pid: number }).pid
      : null;
  if (pid !== null && Number.isInteger(pid)) {
    return isProcessAlive(pid) ? "wait" : "recoverable";
  }
  const age = lockAgeMs(lockPath);
  if (age !== null && age > LOCK_CORRUPT_STALE_MS) return "recoverable";
  return "wait";
}

export function acquireLeaseLock(workspaceId: string): LeaseLockHandle {
  const lockPath = browserLeaseLockFile(workspaceId);
  ensureDir(path.dirname(lockPath));
  const timeoutMs = lockAcquireTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lockId = randomUUID();
    let created: number | null = null;
    try {
      created = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new BrowserLeaseError("STATE_IO", `cannot create browser lease lock: ${describeError(error)}`);
      }
    }
    if (created !== null) {
      try {
        fs.writeSync(created, JSON.stringify({ lockId, pid: process.pid, createdAt: Date.now() }));
        fs.fsyncSync(created);
        fs.closeSync(created);
      } catch (error) {
        try {
          fs.closeSync(created);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
        throw new BrowserLeaseError("STATE_IO", `cannot write browser lease lock: ${describeError(error)}`);
      }
      return { path: lockPath, lockId };
    }
    if (inspectLeaseLock(lockPath) === "recoverable") {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* another writer may have won the race; just retry */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new BrowserLeaseError("LOCK_TIMEOUT", "timed out waiting for the browser lease lock");
    }
    sleepSync(LOCK_POLL_INTERVAL_MS);
  }
}

/** Verify lockId before unlinking so we never drop a replacement lock. */
export function releaseLeaseLock(handle: LeaseLockHandle): void {
  let raw: string;
  try {
    raw = fs.readFileSync(handle.path, "utf8");
  } catch {
    return;
  }
  try {
    const meta = JSON.parse(raw) as { lockId?: unknown };
    if (meta.lockId !== handle.lockId) return;
  } catch {
    return;
  }
  try {
    fs.unlinkSync(handle.path);
  } catch {
    /* best effort */
  }
}

function withLeaseLock<T>(workspaceId: string, fn: () => T): T {
  const lock = acquireLeaseLock(workspaceId);
  try {
    return fn();
  } finally {
    releaseLeaseLock(lock);
  }
}

function isAgentExpired(state: BrowserLeaseStateV1, now: number): boolean {
  return state.owner === "agent" && state.expiresAt !== null && state.expiresAt <= now;
}

function leaseView(state: BrowserLeaseStateV1, now: number = Date.now()): BrowserLeaseView {
  return { ...state, expired: isAgentExpired(state, now) };
}

export interface BrowserLeaseOptions {
  ttlMs?: number;
}

/** Read-only. Never creates the state file. Corrupt state fails closed. */
export function getBrowserLeaseStatus(workspaceId: string): BrowserLeaseView {
  const state = readLeaseState(browserLeaseFile(workspaceId));
  return leaseView(state ?? missingState());
}

export function acquireBrowserLease(workspaceId: string, options: BrowserLeaseOptions = {}): BrowserLeaseResult {
  const ttlMs = options.ttlMs ?? BROWSER_LEASE_DEFAULT_TTL_MS;
  const file = browserLeaseFile(workspaceId);
  return withLeaseLock(workspaceId, () => {
    const current = readLeaseState(file);
    const now = Date.now();
    if (current?.owner === "user") {
      throw new BrowserLeaseError("USER_CONTROL", "the user currently holds browser control", leaseView(current, now));
    }
    if (current?.owner === "agent" && !isAgentExpired(current, now)) {
      throw new BrowserLeaseError("BROWSER_BUSY", "another agent browser lease is active", leaseView(current, now));
    }
    const next = agentState(randomUUID(), (current?.revision ?? 0) + 1, now, ttlMs);
    writeLeaseStateAtomic(file, next);
    return { changed: true, state: leaseView(next, now) };
  });
}

export function renewBrowserLease(
  workspaceId: string,
  leaseId: string,
  options: BrowserLeaseOptions = {}
): BrowserLeaseResult {
  const ttlMs = options.ttlMs ?? BROWSER_LEASE_DEFAULT_TTL_MS;
  const file = browserLeaseFile(workspaceId);
  return withLeaseLock(workspaceId, () => {
    const current = readLeaseState(file);
    const now = Date.now();
    if (!current || current.owner !== "agent" || current.leaseId !== leaseId) {
      throw new BrowserLeaseError("LEASE_STALE", "browser lease is not held by this lease id", leaseView(current ?? missingState(), now));
    }
    if (isAgentExpired(current, now)) {
      throw new BrowserLeaseError("LEASE_EXPIRED", "browser lease has expired", leaseView(current, now));
    }
    const next: BrowserLeaseStateV1 = {
      ...current,
      expiresAt: now + ttlMs,
      updatedAt: iso(now),
      revision: current.revision + 1,
    };
    writeLeaseStateAtomic(file, next);
    return { changed: true, state: leaseView(next, now) };
  });
}

export function releaseBrowserLease(workspaceId: string, leaseId: string): BrowserLeaseResult {
  const file = browserLeaseFile(workspaceId);
  return withLeaseLock(workspaceId, () => {
    const current = readLeaseState(file);
    const now = Date.now();
    if (!current || current.owner !== "agent" || current.leaseId !== leaseId) {
      throw new BrowserLeaseError("LEASE_STALE", "browser lease is not held by this lease id", leaseView(current ?? missingState(), now));
    }
    const next = availableState(current.revision + 1, now);
    writeLeaseStateAtomic(file, next);
    return { changed: true, state: leaseView(next, now) };
  });
}

/** User takeover. The only operation allowed to recover corrupt state. */
export function takeBrowserControl(workspaceId: string): BrowserLeaseResult {
  const file = browserLeaseFile(workspaceId);
  return withLeaseLock(workspaceId, () => {
    let current: BrowserLeaseStateV1 | null = null;
    let recoveredFromCorrupt = false;
    try {
      current = readLeaseState(file);
    } catch (error) {
      if (error instanceof BrowserLeaseError && error.code === "STATE_CORRUPT") {
        quarantineCorruptState(file);
        current = null;
        recoveredFromCorrupt = true;
      } else {
        throw error;
      }
    }
    const now = Date.now();
    if (current?.owner === "user") {
      return { changed: false, state: leaseView(current, now) };
    }
    const next = userState((current?.revision ?? 0) + 1, now);
    writeLeaseStateAtomic(file, next);
    return { changed: true, state: leaseView(next, now), recoveredFromCorrupt };
  });
}

/** User handback. user -> available only; never creates an agent lease. */
export function resumeBrowserControl(workspaceId: string): BrowserLeaseResult {
  const file = browserLeaseFile(workspaceId);
  return withLeaseLock(workspaceId, () => {
    const current = readLeaseState(file);
    const now = Date.now();
    if (!current || current.owner === "available") {
      return { changed: false, state: leaseView(current ?? missingState(), now) };
    }
    if (current.owner === "agent") {
      throw new BrowserLeaseError("AGENT_CONTROL", "an agent browser lease is active", leaseView(current, now));
    }
    const next = availableState(current.revision + 1, now);
    writeLeaseStateAtomic(file, next);
    return { changed: true, state: leaseView(next, now) };
  });
}
