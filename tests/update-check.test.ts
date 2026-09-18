import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";
import { checkForUpdate } from "../src/update/check.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
});

function track(dir: string): string {
  dirs.push(dir);
  return dir;
}

function makeBareRemote(name: string): string {
  const remote = track(makeTmpDir(name));
  git(remote, "init", "--bare");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return remote;
}

function makeOriginRepo(name: string): { root: string; origin: string } {
  const root = track(makeTmpDir(name));
  makeGitRepo(root);
  const origin = makeBareRemote(`${name}-origin`);
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-u", "origin", "main");
  return { root, origin };
}

function makeForkRepo(name: string): { root: string; origin: string; upstream: string } {
  const { root, origin } = makeOriginRepo(name);
  const upstream = makeBareRemote(`${name}-upstream`);
  git(root, "remote", "add", "upstream", upstream);
  git(root, "push", "upstream", "main");
  return { root, origin, upstream };
}

function commitFile(root: string, rel: string, content: string, message: string): void {
  write(root, rel, content);
  git(root, "add", ".");
  git(root, "commit", "-m", message);
}

describe("update-check", () => {
  it("origin-only: local == origin HEAD means no update", () => {
    const { root } = makeOriginRepo("origin-clean");
    const result = checkForUpdate(root);

    expect(result.checked).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.updateSource).toBe("origin");
    expect(result.remote).toBe("origin");
    expect(result.customizedFork).toBe(false);
    expect(result.manualUpdateRequired).toBe(false);
    expect(result.localCommit).toBe(result.remoteCommit);
  });

  it("origin-only: origin ahead means update", () => {
    const { root } = makeOriginRepo("origin-ahead");
    commitFile(root, "remote.txt", "remote\n", "origin ahead");
    git(root, "push", "origin", "main");
    git(root, "reset", "--hard", "HEAD~1");

    const result = checkForUpdate(root);

    expect(result.checked).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.updateSource).toBe("origin");
    expect(result.customizedFork).toBe(false);
    expect(result.manualUpdateRequired).toBe(false);
    expect(result.localCommit).not.toBe(result.remoteCommit);
  });

  it("fork: upstream baseline plus custom commit means no update", () => {
    const { root } = makeForkRepo("fork-custom");
    git(root, "checkout", "-b", "playwright-feature");
    commitFile(root, "custom.txt", "custom\n", "custom commit");
    git(root, "push", "-u", "origin", "playwright-feature");

    const result = checkForUpdate(root);

    expect(result.checked).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.updateSource).toBe("upstream");
    expect(result.remote).toBe("upstream");
    expect(result.customizedFork).toBe(true);
    expect(result.manualUpdateRequired).toBe(false);
  });

  it("fork: upstream new commit means update and manual sync", () => {
    const { root, upstream } = makeForkRepo("fork-upstream-ahead");
    git(root, "checkout", "-b", "playwright-feature");
    commitFile(root, "custom.txt", "custom\n", "custom commit");
    git(root, "push", "-u", "origin", "playwright-feature");

    const parent = track(makeTmpDir("upstream-work-parent"));
    const clone = path.join(parent, "clone");
    git(parent, "clone", upstream, clone);
    commitFile(clone, "upstream.txt", "upstream\n", "upstream new commit");
    git(clone, "push", "origin", "main");

    const result = checkForUpdate(root);

    expect(result.checked).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.updateSource).toBe("upstream");
    expect(result.customizedFork).toBe(true);
    expect(result.manualUpdateRequired).toBe(true);
    expect(result.localCommit).not.toBe(result.remoteCommit);
  });

  it("fork: extra local commits alone are not an upstream update", () => {
    const { root } = makeForkRepo("fork-extra-local");
    git(root, "checkout", "-b", "playwright-feature");
    commitFile(root, "custom-1.txt", "one\n", "custom one");
    commitFile(root, "custom-2.txt", "two\n", "custom two");
    git(root, "push", "-u", "origin", "playwright-feature");

    const result = checkForUpdate(root);

    expect(result.checked).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.updateSource).toBe("upstream");
    expect(result.customizedFork).toBe(true);
    expect(result.manualUpdateRequired).toBe(false);
  });
});
