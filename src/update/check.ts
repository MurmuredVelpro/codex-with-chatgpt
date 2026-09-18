import { spawnSync } from "node:child_process";

export type UpdateSource = "origin" | "upstream";

export interface UpdateCheckResult {
  checked: boolean;
  updateAvailable: boolean;
  localCommit?: string;
  remoteCommit?: string;
  updateSource?: UpdateSource;
  remote?: UpdateSource;
  customizedFork?: boolean;
  manualUpdateRequired?: boolean;
  note?: string;
}

export interface UpdateGitResult {
  ok: boolean;
  stdout: string;
  code: number | null;
}

export function runUpdateGit(repoRoot: string, args: string[]): UpdateGitResult {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    code: result.status,
  };
}

function unavailable(): UpdateCheckResult {
  return {
    checked: false,
    updateAvailable: false,
    note: "无法检查更新（离线或非 git 安装），已跳过。",
  };
}

function result(
  updateAvailable: boolean,
  localCommit: string,
  remoteCommit: string,
  source: UpdateSource,
  customizedFork: boolean
): UpdateCheckResult {
  return {
    checked: true,
    updateAvailable,
    localCommit,
    remoteCommit,
    updateSource: source,
    remote: source,
    customizedFork,
    manualUpdateRequired: customizedFork && updateAvailable,
  };
}

export function checkForUpdate(repoRoot: string): UpdateCheckResult {
  const local = runUpdateGit(repoRoot, ["rev-parse", "HEAD"]);
  if (!local.ok || !local.stdout) return unavailable();
  const localCommit = local.stdout;

  const upstream = runUpdateGit(repoRoot, ["remote", "get-url", "upstream"]);
  if (upstream.ok && upstream.stdout) {
    const fetched = runUpdateGit(repoRoot, ["fetch", "--quiet", "upstream", "HEAD"]);
    if (!fetched.ok) return unavailable();

    const remote = runUpdateGit(repoRoot, ["rev-parse", "FETCH_HEAD"]);
    if (!remote.ok || !remote.stdout) return unavailable();
    const remoteCommit = remote.stdout;

    const ancestor = runUpdateGit(repoRoot, ["merge-base", "--is-ancestor", remoteCommit, localCommit]);
    if (ancestor.ok) return result(false, localCommit, remoteCommit, "upstream", true);
    if (ancestor.code === 1) return result(true, localCommit, remoteCommit, "upstream", true);
    return unavailable();
  }

  const remote = runUpdateGit(repoRoot, ["ls-remote", "origin", "HEAD"]);
  if (!remote.ok || !remote.stdout) return unavailable();
  const remoteCommit = remote.stdout.split(/\s/)[0];
  if (!remoteCommit) return unavailable();

  return result(remoteCommit !== localCommit, localCommit, remoteCommit, "origin", false);
}
