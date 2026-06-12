import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SalvageCommit {
  hash: string;
  subject: string;
}

export interface WorkerSalvageManifest {
  taskId: string;
  generatedAt: string;
  worktree: string;
  worktreeExists: boolean;
  branch: string | null;
  head: string | null;
  baseRef: string | null;
  dirtyFiles: string[];
  recentCommits: SalvageCommit[];
  logFile: string | null;
  logMtime: string | null;
  errors: string[];
}

export interface CreateWorkerSalvageManifestOptions {
  taskId: string;
  worktree: string;
  baseRef?: string | null;
  logFile?: string | null;
  now?: Date;
  maxCommits?: number;
}

async function git(worktree: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", worktree, ...args], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function parseCommits(output: string): SalvageCommit[] {
  if (!output) return [];
  return output.split("\n").map((line) => {
    const separator = line.indexOf(" ");
    if (separator === -1) return { hash: line, subject: "" };
    return { hash: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
}

export async function createWorkerSalvageManifest(
  options: CreateWorkerSalvageManifestOptions,
): Promise<WorkerSalvageManifest> {
  const errors: string[] = [];
  const generatedAt = (options.now ?? new Date()).toISOString();
  const logFile = options.logFile ?? null;
  const manifest: WorkerSalvageManifest = {
    taskId: options.taskId,
    generatedAt,
    worktree: options.worktree,
    worktreeExists: existsSync(options.worktree),
    branch: null,
    head: null,
    baseRef: options.baseRef ?? null,
    dirtyFiles: [],
    recentCommits: [],
    logFile,
    logMtime: null,
    errors,
  };

  if (logFile && existsSync(logFile)) {
    try {
      manifest.logMtime = statSync(logFile).mtime.toISOString();
    } catch (err) {
      errors.push(`log stat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!manifest.worktreeExists) {
    errors.push("worktree does not exist");
    return manifest;
  }

  try {
    manifest.branch = await git(options.worktree, ["branch", "--show-current"]);
  } catch (err) {
    errors.push(`git branch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    manifest.head = await git(options.worktree, ["rev-parse", "--short=12", "HEAD"]);
  } catch (err) {
    errors.push(`git rev-parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const status = await git(options.worktree, ["status", "--porcelain"]);
    manifest.dirtyFiles = status ? status.split("\n") : [];
  } catch (err) {
    errors.push(`git status failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const limit = String(options.maxCommits ?? 5);
    const range = options.baseRef ? `${options.baseRef}..HEAD` : "HEAD";
    const commits = await git(options.worktree, ["log", `-${limit}`, "--pretty=format:%h %s", range]);
    manifest.recentCommits = parseCommits(commits);
  } catch (err) {
    errors.push(`git log failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return manifest;
}
