# Fault-Tolerant Worker Pipeline

This document designs the journal, reaper, resume, and supervision path for background `Task`/`Agent` workers. The goal is to make dead workers detectable, reportable, and resumable without manually inspecting `/tmp` worktrees.

## Current Dispatch State

Background workers are launched by letta-code through the SDK-backed shim path:

- `scripts/letta-cli-sdk-wrapper.mjs` is the CLI entrypoint used by the SDK. It injects `--backend local`, propagates the patch loader through `NODE_OPTIONS`, forwards termination signals to the real CLI child, and currently exits with the child's status.
- `lib/letta-sdk-adapter.ts` runs turns through the SDK, with silence and absolute turn watchdogs. Background `Agent`/`Task` tool calls happen inside the spawned CLI process.
- `lib/subagent-registry.ts` observes parent stream frames. An `Agent` tool call creates a running registry entry; the matching tool return provides `taskId`, `subagentAgentId`, and `logFile` from the plaintext body.
- Background logs use `/tmp/letta-background/task_N.log`. The registry watches the log for `[Task completed]`; otherwise a timer marks the entry failed with `stream_timeout`.

At worker death today, the durable evidence is partial:

- Log file: `/tmp/letta-background/task_N.log`, often without a terminal marker.
- Worktree: worker-created checkout under `/tmp` or `.letta/worktrees`, possibly dirty or committed but unpushed.
- Registry entry: in-memory only, with task id, agent id, log path, status, timestamps, and todo progress. It has no worktree, salvage data, process id, child exit, or journal.

## Worker Journal

Each background worker should maintain a small JSON journal next to the task log:

```text
/tmp/letta-background/task_N.log
/tmp/letta-background/task_N.journal.json
```

The journal is intentionally append-rewrite JSON, not JSONL, because the reaper and resume prompt need one compact snapshot.

### Schema

```json
{
  "version": 1,
  "taskId": "task_9",
  "agentId": "agent-local-...",
  "toolCallId": "toolu_...",
  "parentRunId": "run-...",
  "createdAt": "2026-06-12T00:00:00.000Z",
  "updatedAt": "2026-06-12T00:03:00.000Z",
  "lastHeartbeat": "2026-06-12T00:03:00.000Z",
  "worktree": "/tmp/lcp-dhif-design",
  "branch": "feat/lcp-dhif-design",
  "baseRef": "origin/master",
  "status": "running",
  "steps": [
    {
      "id": "study-dispatch",
      "status": "completed",
      "title": "Study dispatch path",
      "startedAt": "2026-06-12T00:01:00.000Z",
      "completedAt": "2026-06-12T00:02:00.000Z",
      "notes": "Read wrapper, sdk adapter, subagent registry."
    }
  ],
  "commits": [
    {
      "hash": "abc1234",
      "subject": "docs(shim): design worker recovery pipeline",
      "createdAt": "2026-06-12T00:10:00.000Z"
    }
  ],
  "prUrl": null,
  "salvage": null
}
```

Required fields: `version`, `taskId`, `createdAt`, `updatedAt`, `lastHeartbeat`, `worktree`, `branch`, `baseRef`, `status`, `steps`, `commits`, `prUrl`. `agentId`, `toolCallId`, and `parentRunId` should be filled by the harness or registry when known.

`status` values: `running`, `completed`, `failed`, `reaped`, `resumed`. The reaper sets `reaped` when it proves the worker is dead and attaches `salvage`.

### Writers

Use a lightweight two-layer contract:

1. Worker brief convention: every background worker prompt starts with journal instructions. The worker updates the journal after worktree creation, before and after each high-level step, after commits, after PR creation, and every heartbeat interval during long-running commands.
2. Optional harness hook: the shim should create the initial journal when it sees the background task return, then inject `taskId`, `agentId`, `toolCallId`, `parentRunId`, `logFile`, and default paths. Later harness hooks can update `lastHeartbeat` when the child emits frames.

Workers should write atomically: write `task_N.journal.json.tmp`, then rename to `task_N.journal.json`.

### Heartbeats

Default interval: 30 seconds while the worker is active, plus an immediate touch before long commands. The heartbeat is `lastHeartbeat` and the journal file mtime.

Staleness thresholds:

- Healthy: heartbeat age <= 2 minutes.
- Suspect: heartbeat age > 2 minutes and log mtime age > 2 minutes.
- Reap candidate: heartbeat age > 5 minutes and either process is gone or log mtime age > 5 minutes.
- Hard reap: heartbeat age > 15 minutes even if process state is unknown.

These should be configurable with `SHIM_WORKER_HEARTBEAT_MS`, `SHIM_WORKER_STALE_MS`, and `SHIM_WORKER_REAP_MS`.

## Reaper

The reaper runs shim-side on startup and on an interval. It does not kill workers in the first slice; it only finalizes entries that are already dead or stale.

### Inputs

- `snapshotSubagents()` / internal registry entries where `status === "running"`.
- `taskId`, `logFile`, and future `pid` / `processStartTime` fields on the registry entry.
- `/tmp/letta-background/task_N.journal.json` if present.
- Worker worktree path from journal first, registry field second, or prompt convention fallback.

### Dead Worker Detection

A running registry entry becomes reaper-eligible when one of these is true:

- Registry says running and `pid` is present but process no longer exists.
- Wrapper reports child exit through the supervision hook.
- Journal/log heartbeat is stale beyond `SHIM_WORKER_REAP_MS`.
- Log contains a known fatal marker but no registry terminal event was applied.

If only the log is stale but the process is still alive, mark the entry `suspect` in diagnostics but do not finalize until the reap threshold.

### Salvage Manifest

When reaping, build a manifest by scanning the worktree. First slice implementation lives in `lib/worker-salvage.ts` and captures:

```json
{
  "taskId": "task_9",
  "generatedAt": "2026-06-12T00:15:00.000Z",
  "worktree": "/tmp/lcp-dhif-design",
  "worktreeExists": true,
  "branch": "feat/lcp-dhif-design",
  "head": "abc1234def56",
  "baseRef": "origin/master",
  "dirtyFiles": [" M admin-shim/server.ts", "?? notes.txt"],
  "recentCommits": [{ "hash": "abc1234", "subject": "docs(shim): design worker recovery" }],
  "logFile": "/tmp/letta-background/task_9.log",
  "logMtime": "2026-06-12T00:14:59.000Z",
  "errors": []
}
```

The reaper appends the manifest to the task log under a clear marker:

```text
[Task reaped: 2026-06-12T00:15:00.000Z]
Reason: process_gone
---SALVAGE MANIFEST JSON---
{ ... }
---END SALVAGE MANIFEST JSON---
```

It also stores the manifest on the registry entry in a future `salvage` field and finalizes with `status=failed`, `failureReason=worker_reaped:<reason>`.

## Resume Recipe

A resume dispatch must reuse the same worktree unless it is missing. The operator or reaper passes the journal and salvage manifest into a standard prompt preamble.

Exact preamble template:

```text
You are resuming a previously dead background worker. Do not start from scratch.

Recovery inputs:
- Task ID: {{taskId}}
- Original log: {{logFile}}
- Journal: {{journalJson}}
- Salvage manifest: {{salvageManifestJson}}

Resume rules:
1. Work in the existing worktree: `{{worktree}}`. Do not create a new worktree unless this path is missing or not a git worktree; if missing, stop and report that recovery requires manual intervention.
2. First inspect `git status`, current branch, recent commits, the journal steps, and the tail of the original log. Treat committed and dirty work as intentional salvage unless it is clearly unrelated.
3. Continue from the last incomplete journal step. Update `/tmp/letta-background/{{taskId}}.journal.json` before and after each high-level step, and heartbeat `lastHeartbeat` at least every 30 seconds during long operations.
4. Preserve existing commits. If more changes are needed, commit on the same branch unless the journal says a PR already exists and the branch is pushed.
5. If the salvage manifest includes dirty files, review them before editing. Do not discard or overwrite dirty work without explicitly explaining why in the journal.
6. When complete, push the branch, create or update the PR, write `prUrl` and final commits to the journal, and append a concise recovery summary to the task log.

Original task brief:
{{originalPrompt}}
```

## Supervision

`letta-cli-sdk-wrapper.mjs` should report child lifecycle events immediately instead of relying only on log inference:

- On spawn: write or POST `{ event: "child_spawned", pid, argv, taskId? }` when a task id is available.
- On exit: write or POST `{ event: "child_exit", pid, code, signal, at }`.
- On signal forwarding: write `{ event: "signal_forwarded", signal, at }`.

The low-friction implementation is a local shim endpoint, for example `POST /v1/worker-events`, which updates the matching registry entry. Matching can use `taskId` when the wrapper gets it via env, or `(agentId, conversationId, time window)` as a fallback.

Until task id is available at wrapper spawn time, the wrapper can append lifecycle JSON lines to a sidecar path supplied in env by the SDK/harness. The registry/reaper can ingest that sidecar during sweeps.

## Implementation Slices

This PR implements the cheap first slice:

- This design document and the exact resume preamble template.
- `lib/worker-salvage.ts`, a pure salvage-manifest helper.
- `test/worker-salvage.test.ts`, covering dirty files, branch, commits, log mtime, and missing worktrees.

Follow-up beads should implement:

- Journal creation and prompt injection at background dispatch time.
- Registry fields for `journalFile`, `worktree`, `pid`, `lastHeartbeat`, `salvage`.
- Reaper sweep loop and log/registry finalization.
- Wrapper child-exit reporting to the registry.
- Resume dispatch helper using the exact template above.
