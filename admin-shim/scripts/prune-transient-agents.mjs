#!/usr/bin/env node
/**
 * prune-transient-agents.mjs — offline prune of subagent-leftover agents in a
 * letta-code local-backend state dir (bead aioi8, design §4 P3).
 *
 * The lc-local-backend accumulates one hidden agent record per subagent run
 * (name "Letta Code", `hidden: true`, tag `role:subagent`) plus a
 * `default:<agentId>` conversation dir holding the subagent's scratch
 * transcript. Nothing reads these after the parent turn finishes — they are
 * hidden from every list surface and unreachable from mobile/desktop — but
 * they inflate /v1/agents responses and conversation_search latency forever.
 *
 * THIS SCRIPT DELETES TRANSCRIPTS in --apply mode (the subagent scratch
 * transcripts, alongside the agent records). The dry-run output shows the
 * transcript line count per candidate so the operator consciously approves
 * transcript deletion, not just record cleanup.
 *
 * Candidate criteria — ALL required:
 *   (a) agent JSON has `hidden === true` AND tags include "role:subagent";
 *   (b) no conversation activity within the age window: max mtime across all
 *       of the agent's conversation dirs (messages.jsonl / conversation.json /
 *       the dir itself) is older than --min-age days (default 14). The age
 *       gate deliberately keys on CONVERSATION mtime, not the agent JSON:
 *       agent records get bulk-rewritten by unrelated sweeps (verified
 *       2026-07-03 — all 624 agents/*.json carried same-day mtimes while
 *       messages.jsonl p50 age was 18.7d), which would otherwise keep every
 *       candidate perpetually "too young". Agents with no conversation dirs
 *       fall back to the agent-JSON mtime;
 *   (c) no live reference: the agent id is not referenced by any conversation
 *       dir other than its own `default:<agentId>` scratch dir(s). Named
 *       `conversation:*` dirs are reachable via the shim conversation list,
 *       so an agent referenced by one is never pruned.
 *
 * Removal set per candidate (mirrors deleteAgent):
 *   - agents/<b64url(id)>.json
 *   - every conversation dir whose conversation.json.agent_id === id
 *     (post-(c), these are only the agent's own default: scratch dirs)
 *   - memfs/<id>/ if present
 *
 * Safety:
 *   - DRY-RUN is the default; nothing is written or deleted.
 *   - --apply refuses if any shim pool worker currently holds a candidate
 *     agent (checked via GET <pool-url>, default the shim admin endpoint
 *     /shim/pool). An unreachable shim is treated as stopped.
 *   - --apply first writes a tar.gz archive of the full removal set
 *     (default <state-dir>/prune-archives/), and aborts if archiving fails.
 *
 * Usage:
 *   node scripts/prune-transient-agents.mjs [--state-dir DIR] [--min-age DAYS]
 *        [--pool-url URL] [--archive-dir DIR] [--json] [--apply]
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    stateDir:
      process.env.LETTA_LOCAL_BACKEND_DIR || join(homedir(), ".letta", "lc-local-backend"),
    minAgeDays: 14,
    apply: false,
    json: false,
    poolUrl: process.env.SHIM_POOL_URL || "http://127.0.0.1:8291/shim/pool",
    archiveDir: null,
    now: Date.now(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case "--state-dir": args.stateDir = resolve(next()); break;
      case "--min-age":
      case "--min-age-days": {
        const days = Number(next());
        if (!Number.isFinite(days) || days < 0) throw new Error(`invalid --min-age: ${argv[i]}`);
        args.minAgeDays = days;
        break;
      }
      case "--apply": args.apply = true; break;
      case "--dry-run": args.apply = false; break;
      case "--json": args.json = true; break;
      case "--pool-url": args.poolUrl = next(); break;
      case "--archive-dir": args.archiveDir = resolve(next()); break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: prune-transient-agents.mjs [--state-dir DIR] [--min-age DAYS] " +
          "[--pool-url URL] [--archive-dir DIR] [--json] [--apply]\n" +
          "Default is DRY-RUN. --apply archives the removal set to a tar.gz, then deletes.\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.archiveDir) args.archiveDir = join(args.stateDir, "prune-archives");
  return args;
}

function decodePathSegment(name) {
  try {
    const decoded = Buffer.from(name, "base64url").toString("utf8");
    // Round-trip check: reject names that are not valid base64url of the text.
    if (Buffer.from(decoded, "utf8").toString("base64url") !== name) return null;
    return decoded;
  } catch {
    return null;
  }
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function mtimeSafe(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function countLinesSafe(path) {
  try {
    const text = readFileSync(path, "utf8");
    if (text.length === 0) return 0;
    return text.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

function sizeSafe(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Scan the state dir and compute prune candidates. Pure read-only.
 * Exported for tests via `scan()`.
 */
export function scan(stateDir, { minAgeDays = 14, now = Date.now() } = {}) {
  const agentsDir = join(stateDir, "agents");
  const conversationsDir = join(stateDir, "conversations");
  if (!existsSync(agentsDir) || !existsSync(conversationsDir)) {
    throw new Error(
      `${stateDir} does not look like a letta-code local backend (missing agents/ or conversations/)`,
    );
  }

  // Pass 1: read every conversation dir once. Group by referenced agent id.
  /** @type {Map<string, Array<{dir: string; name: string; key: string | null; isOwnScratch: boolean; messagesPath: string; mtime: number}>>} */
  const conversationsByAgent = new Map();
  const conversationDirNames = readdirSync(conversationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of conversationDirNames) {
    const dir = join(conversationsDir, name);
    const key = decodePathSegment(name);
    const conversation = readJsonSafe(join(dir, "conversation.json"));
    const agentId = conversation && typeof conversation.agent_id === "string"
      ? conversation.agent_id
      : key && key.startsWith("default:")
        ? key.slice("default:".length)
        : null;
    if (!agentId) continue; // unattributable — never counted, never removed
    const messagesPath = join(dir, "messages.jsonl");
    const mtime = Math.max(
      mtimeSafe(messagesPath) ?? 0,
      mtimeSafe(join(dir, "conversation.json")) ?? 0,
      mtimeSafe(dir) ?? 0,
    );
    const record = {
      dir,
      name,
      key,
      isOwnScratch: key === `default:${agentId}`,
      messagesPath,
      mtime,
    };
    const list = conversationsByAgent.get(agentId);
    if (list) list.push(record);
    else conversationsByAgent.set(agentId, [record]);
  }

  // Pass 2: evaluate every agent JSON against the criteria.
  const minAgeMs = minAgeDays * DAY_MS;
  const candidates = [];
  const excluded = { notSubagent: 0, tooYoung: 0, liveReference: 0, unreadable: 0 };
  const agentFiles = readdirSync(agentsDir).filter((file) => file.endsWith(".json"));
  for (const file of agentFiles) {
    const agentPath = join(agentsDir, file);
    const agent = readJsonSafe(agentPath);
    if (!agent || typeof agent.id !== "string") {
      excluded.unreadable += 1;
      continue;
    }
    const tags = Array.isArray(agent.tags) ? agent.tags : [];
    // (a) strongest subagent-leftover signature: BOTH markers required.
    if (agent.hidden !== true || !tags.includes("role:subagent")) {
      excluded.notSubagent += 1;
      continue;
    }
    const conversations = conversationsByAgent.get(agent.id) ?? [];
    // (c) live reference: any conversation dir referencing this agent that is
    // not its own `default:<id>` scratch dir keeps the agent alive.
    if (conversations.some((conversation) => !conversation.isOwnScratch)) {
      excluded.liveReference += 1;
      continue;
    }
    // (b) age gate on conversation activity (see header for why the agent
    // JSON mtime is only a fallback for conversation-less records).
    const lastActivityMs = conversations.length > 0
      ? Math.max(...conversations.map((conversation) => conversation.mtime))
      : mtimeSafe(agentPath) ?? 0;
    if (now - lastActivityMs < minAgeMs) {
      excluded.tooYoung += 1;
      continue;
    }

    const memfsDir = join(stateDir, "memfs", agent.id);
    const removal = {
      agentFile: agentPath,
      conversationDirs: conversations.map((conversation) => conversation.dir),
      memfsDir: existsSync(memfsDir) ? memfsDir : null,
    };
    candidates.push({
      id: agent.id,
      name: typeof agent.name === "string" ? agent.name : "<unnamed>",
      tags,
      agentFile: agentPath,
      lastActivityMs,
      ageDays: (now - lastActivityMs) / DAY_MS,
      transcripts: conversations.map((conversation) => ({
        dir: conversation.dir,
        key: conversation.key,
        lines: countLinesSafe(conversation.messagesPath),
        bytes: sizeSafe(conversation.messagesPath),
      })),
      removal,
    });
  }

  candidates.sort((a, b) => a.lastActivityMs - b.lastActivityMs);
  return { candidates, excluded, agentCount: agentFiles.length };
}

async function fetchPoolAgentIds(poolUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(poolUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stats = await response.json();
    const workers = Array.isArray(stats?.workers) ? stats.workers : [];
    return { reachable: true, agentIds: new Set(workers.map((worker) => String(worker.agent_id))) };
  } catch {
    return { reachable: false, agentIds: new Set() };
  }
}

function relativeToState(stateDir, path) {
  const prefix = stateDir.endsWith("/") ? stateDir : stateDir + "/";
  if (!path.startsWith(prefix)) {
    throw new Error(`refusing to touch path outside state dir: ${path}`);
  }
  return path.slice(prefix.length);
}

/**
 * Archive the removal set, then delete it. Exported for tests via `apply()`.
 * Returns the archive path.
 */
export function apply(stateDir, candidates, archiveDir) {
  const relativePaths = [];
  for (const candidate of candidates) {
    relativePaths.push(relativeToState(stateDir, candidate.removal.agentFile));
    for (const dir of candidate.removal.conversationDirs) {
      relativePaths.push(relativeToState(stateDir, dir));
    }
    if (candidate.removal.memfsDir) {
      relativePaths.push(relativeToState(stateDir, candidate.removal.memfsDir));
    }
  }
  if (relativePaths.length === 0) return null;

  mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = join(archiveDir, `prune-transient-agents-${stamp}.tar.gz`);
  const listPath = join(tmpdir(), `prune-transient-agents-files-${process.pid}.txt`);
  writeFileSync(listPath, relativePaths.join("\n") + "\n");
  try {
    // Archive BEFORE deleting — abort on any tar failure (throws on non-zero).
    execFileSync("tar", ["-C", stateDir, "-czf", archivePath, "--files-from", listPath], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } finally {
    rmSync(listPath, { force: true });
  }
  if (!existsSync(archivePath) || statSync(archivePath).size === 0) {
    throw new Error(`archive was not written: ${archivePath}`);
  }

  for (const relativePath of relativePaths) {
    rmSync(join(stateDir, relativePath), { recursive: true, force: true });
  }
  return archivePath;
}

function formatCandidate(candidate) {
  const lines = candidate.transcripts.reduce((sum, transcript) => sum + transcript.lines, 0);
  const bytes = candidate.transcripts.reduce((sum, transcript) => sum + transcript.bytes, 0);
  return (
    `  ${candidate.id}  age=${candidate.ageDays.toFixed(1)}d  ` +
    `convs=${candidate.transcripts.length}  transcript_lines=${lines}  ` +
    `transcript_bytes=${bytes}  name=${JSON.stringify(candidate.name)}` +
    (candidate.removal.memfsDir ? "  +memfs" : "")
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { candidates, excluded, agentCount } = scan(args.stateDir, {
    minAgeDays: args.minAgeDays,
    now: args.now,
  });

  const totalLines = candidates.reduce(
    (sum, candidate) => sum + candidate.transcripts.reduce((s, t) => s + t.lines, 0),
    0,
  );
  const totalBytes = candidates.reduce(
    (sum, candidate) => sum + candidate.transcripts.reduce((s, t) => s + t.bytes, 0),
    0,
  );

  if (args.json) {
    process.stdout.write(JSON.stringify({
      mode: args.apply ? "apply" : "dry-run",
      state_dir: args.stateDir,
      min_age_days: args.minAgeDays,
      agent_count: agentCount,
      excluded,
      candidate_count: candidates.length,
      transcript_lines_total: totalLines,
      transcript_bytes_total: totalBytes,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        age_days: Number(candidate.ageDays.toFixed(1)),
        transcript_lines: candidate.transcripts.reduce((s, t) => s + t.lines, 0),
        transcript_bytes: candidate.transcripts.reduce((s, t) => s + t.bytes, 0),
        conversation_dirs: candidate.removal.conversationDirs,
        memfs_dir: candidate.removal.memfsDir,
      })),
    }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `${args.apply ? "APPLY" : "DRY-RUN"}: ${args.stateDir} ` +
      `(agents=${agentCount}, min-age=${args.minAgeDays}d)\n` +
      `candidates: ${candidates.length} ` +
      `(transcript lines to delete: ${totalLines}, bytes: ${totalBytes})\n` +
      `excluded: not-subagent=${excluded.notSubagent} too-young=${excluded.tooYoung} ` +
      `live-reference=${excluded.liveReference} unreadable=${excluded.unreadable}\n`,
    );
    for (const candidate of candidates) {
      process.stdout.write(formatCandidate(candidate) + "\n");
    }
  }

  if (!args.apply) {
    if (!args.json) {
      process.stdout.write(
        "\ndry-run only — nothing deleted. Re-run with --apply to archive + delete.\n",
      );
    }
    return;
  }

  if (candidates.length === 0) {
    process.stdout.write("nothing to prune.\n");
    return;
  }

  // Pool drain check: refuse if any pool worker holds a candidate agent.
  const pool = await fetchPoolAgentIds(args.poolUrl);
  if (pool.reachable) {
    const held = candidates.filter((candidate) => pool.agentIds.has(candidate.id));
    if (held.length > 0) {
      process.stderr.write(
        `REFUSING --apply: ${held.length} candidate agent(s) currently held by pool workers ` +
        `(${held.map((candidate) => candidate.id).join(", ")}). Drain the pool and retry.\n`,
      );
      process.exit(2);
    }
  } else {
    process.stderr.write(
      `note: shim pool endpoint unreachable (${args.poolUrl}) — treating shim as stopped.\n`,
    );
  }

  const archivePath = apply(args.stateDir, candidates, args.archiveDir);
  process.stdout.write(
    `archived removal set to ${archivePath}\n` +
    `deleted ${candidates.length} agent(s) and their conversation dirs.\n`,
  );
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`prune-transient-agents: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
