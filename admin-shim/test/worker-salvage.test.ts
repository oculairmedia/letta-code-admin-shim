import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkerSalvageManifest } from "../lib/worker-salvage.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("worker salvage manifest captures branch, dirty files, commits, and log mtime", async () => {
  const worktree = join(tmpdir(), `shim-salvage-${Math.random().toString(36).slice(2)}`);
  mkdirSync(worktree, { recursive: true });
  git(worktree, ["init", "-b", "main"]);
  git(worktree, ["config", "user.email", "test@example.com"]);
  git(worktree, ["config", "user.name", "Test User"]);
  writeFileSync(join(worktree, "README.md"), "base\n");
  git(worktree, ["add", "README.md"]);
  git(worktree, ["commit", "-m", "base commit"]);
  git(worktree, ["checkout", "-b", "feat/salvage"]);
  writeFileSync(join(worktree, "README.md"), "base\nchanged\n");
  git(worktree, ["commit", "-am", "change readme"]);
  writeFileSync(join(worktree, "scratch.txt"), "untracked\n");
  writeFileSync(join(worktree, "README.md"), "base\nchanged\ndirty\n");
  const logFile = join(worktree, "task_9.log");
  writeFileSync(logFile, "[Task started]\n");

  const manifest = await createWorkerSalvageManifest({
    taskId: "task_9",
    worktree,
    baseRef: "main",
    logFile,
    now: new Date("2026-06-12T00:00:00.000Z"),
  });

  assert.equal(manifest.taskId, "task_9");
  assert.equal(manifest.generatedAt, "2026-06-12T00:00:00.000Z");
  assert.equal(manifest.worktreeExists, true);
  assert.equal(manifest.branch, "feat/salvage");
  assert.match(manifest.head ?? "", /^[0-9a-f]{12}$/);
  assert.deepEqual(manifest.recentCommits.map((commit) => commit.subject), ["change readme"]);
  assert.ok(manifest.dirtyFiles.some((file) => file.endsWith("README.md")));
  assert.ok(manifest.dirtyFiles.some((file) => file.endsWith("scratch.txt")));
  assert.equal(manifest.logFile, logFile);
  assert.ok(manifest.logMtime);
  assert.deepEqual(manifest.errors, []);
});

test("worker salvage manifest reports missing worktree without throwing", async () => {
  const manifest = await createWorkerSalvageManifest({
    taskId: "task_missing",
    worktree: join(tmpdir(), `missing-salvage-${Math.random().toString(36).slice(2)}`),
  });

  assert.equal(manifest.worktreeExists, false);
  assert.deepEqual(manifest.dirtyFiles, []);
  assert.deepEqual(manifest.recentCommits, []);
  assert.ok(manifest.errors.includes("worktree does not exist"));
});
