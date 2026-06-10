# Durable execution v1

This chapter explains how the shim survives partial failures — network
drops, mobile-app restarts, shim restarts, cron-schedule downtime —
without losing user-visible state. It's the design rationale behind
the bead epic `lcp-p74` and the four primitives it ships:

| Primitive | Bead | What it gives you |
|---|---|---|
| Per-run frame log | `lcp-p74.1` | Every WS frame is appended to `state/runs/<id>/frames.jsonl` with a monotonic seq. Replayable. |
| `subscribe(run_id, cursor)` | `lcp-p74.2` | Reconnecting clients resume from a known seq. See [`MOBILE_WS_PROTOCOL.md` §11](MOBILE_WS_PROTOCOL.md#11-reconnect-resume). |
| Worker survives WS disconnect | `lcp-p74.3` | A dropped WebSocket does NOT cancel the in-flight letta-code worker. The turn continues to disk. |
| Cron `last_tick_at` + catch-up | `lcp-p74.4` | Scheduler restart computes a catch-up window from disk and fires missed prompts exactly once. See [`MOBILE_WS_PROTOCOL.md` §10](MOBILE_WS_PROTOCOL.md#10-cron--scheduled-prompts) for the cron protocol; this chapter covers the durability slice. |

The shim is **not** a durable-execution engine in the Temporal/Cadence
sense — see [§5 Non-goals](#5-non-goals). It's a pragmatic v1 that
makes "I refreshed the app mid-turn" / "the shim restarted while a
cron was due" / "the user has flaky LTE on a tunnel" all work.

---

## 1. On-disk layout

Everything below lives under the shim's `storageDir`, which resolves to
`LETTA_LOCAL_BACKEND_DIR` if set, otherwise
`${LETTA_HOME or $HOME/.letta}/lc-local-backend`. The systemd unit
pins it to `/opt/stacks/letta-code-parallel/migrator/out`.

```
${storageDir}/
├── runs/
│   └── run-<uuid>/
│       ├── run.json           # vanilla-Letta Run shape + shim extensions
│       ├── steps.jsonl        # per-step usage/stop_reason records
│       ├── frames.jsonl       # ★ per-run frame log (lcp-p74.1)
│       └── user-actions.jsonl # A2UI user_action sidecar (lcp-uo5)
└── conversations/<b64url>/messages.jsonl
```

Cron state lives separately, alongside the bundled `letta cron` CLI's
expectations: `${LETTA_HOME}/crons.json` (NOT under `storageDir`),
including the `last_tick_at` field added by lcp-p74.4. See
[§4](#4-cron-catch-up) for the catch-up algorithm.

---

## 2. The frame log (`frames.jsonl`)

### 2.1 Shape

One JSON object per line, newline-terminated:

```json
{ "seq": 1, "ts": "2026-05-19T01:23:45.678Z", "frame": { /* BridgeFrame */ } }
{ "seq": 2, "ts": "2026-05-19T01:23:45.689Z", "frame": { /* BridgeFrame */ } }
{ "seq": 3, "ts": "2026-05-19T01:23:45.701Z", "frame": { /* BridgeFrame */ } }
```

- `seq` — monotonic per-run, starting at `1`. There are no gaps and no
  duplicates as long as a single shim process owns the Run (the agent
  pool serializes turns per conversation, so this holds in practice).
- `ts` — server-side ISO timestamp at append time. Subject to drift if
  the host clock jumps; do not rely on it for ordering — `seq` is
  authoritative.
- `frame` — the **same** `BridgeFrame` object that was passed through
  the channel host's `emit()`. Reads exactly like a live WS frame's
  payload: same `message_type` discriminator, same field names.

### 2.2 Writer contract

`admin-shim/lib/runs.ts:appendRunFrame(runId, frame)`:

1. Resolves the run handle from the in-memory `_activeRuns` map. If
   the run isn't tracked (e.g. a frame for a long-finalized run), the
   call is a no-op and returns `{ seq: -1 }`. Caller doesn't have to
   guard.
2. Increments `handle.frameCount` and uses that as the new `seq`.
3. `appendFileSync` of one JSONL line. POSIX guarantees atomic appends
   for writes ≤ `PIPE_BUF` (4 KiB on Linux). Larger frames are atomic
   *in practice* because the agent pool serializes turns per
   conversation — only one writer per file.

### 2.3 Reader contract (subscribe path)

`admin-shim/lib/mobile-channel-host.ts:subscribeToRun`:

1. Open `frames.jsonl` (or emit `error{run_not_found}` if it doesn't
   exist).
2. Read the whole file, split on `\n`, parse each line. Skip blank
   lines and any line that fails `JSON.parse` (defensive — covers a
   crashed-mid-write trailer even though `appendFileSync` shouldn't
   produce one).
3. Emit frames with `seq > cursor` to `subscribe_frame` envelopes,
   advancing `lastSeqSent` as we go.
4. Install `fs.watch` on the file. On `change`, re-read and emit any
   new appends. Polling guard prevents duplicate emits when the FS
   fires the same watch multiple times (some kernels coalesce, some
   don't).
5. After every read pass, check `getRun(runId).status`. If terminal
   AND `lastSeqSent` equals the final file size's seq, emit
   `subscribe_done` and close the watcher.

This is O(n) per append — fine up to thousands of frames per run.
Long-form transcripts that grow past tens of thousands of frames
would benefit from a seek-based reader; we'll add that when it
becomes a problem.

### 2.4 Crash recovery

The frame log survives anything short of disk corruption. Specifically:

- **Mobile app crash mid-turn.** Frames keep being written to disk
  (the WS drop does not interrupt the worker — see [§3](#3-worker-ttl)).
  On restart, mobile re-opens WS, sends `subscribe` with the last seen
  seq, and resumes.
- **Shim crash mid-turn.** The letta-code worker subprocess dies with
  the shim. The Run record on disk is left in `status: "running"`. The
  next shim startup doesn't yet auto-finalize stuck Runs — that's a
  known non-goal ([§5.2](#52-mid-turn-worker-crash-finalization-is-not-automatic)).
  Mobile observers see the Run hang in `running`; a manual
  `DELETE /v1/runs/<id>` cleans it up.
- **Shim restart mid-cron-fire.** The cron scheduler claims a fresh
  lease on startup and runs catch-up ([§4](#4-cron-catch-up)). The
  partially-fired cron is identified by its `last_fired_at` and either
  re-fired (if the missed window covers a later cron-match minute) or
  skipped (if already fired for that minute).

---

## 3. Worker TTL

The agent pool (`admin-shim/lib/agent-pool.ts`) holds long-lived
`@letta-ai/letta-code-sdk` Sessions (each owning a letta-code CLI
subprocess), keyed by `(conversation_id, agent_id)`. (Pre-lcp-sdk.10
this was a hand-rolled `spawn(LETTA_BIN, …)` worker.)

### 3.1 Pool lifecycle

- **Spawn.** First turn on a conv triggers `resumeSession()` via the
  SDK, which spawns the CLI (resolved through `LETTA_CLI_PATH`) with
  stream-json input/output. The Session yields the stream frames.
- **Reuse.** Subsequent turns on the same conv reuse the existing
  worker (no respawn cost). Each turn updates `worker.lastUsedAt`
  *after* the turn completes.
- **Eviction.** A housekeep timer
  (`SHIM_POOL_HOUSEKEEP_MS`, default 30s) scans the worker map. Any
  worker where `now - lastUsedAt > IDLE_EVICT_MS`
  (`SHIM_POOL_IDLE_SEC`, default 300s) gets killed and removed.
- **Cap.** `SHIM_POOL_MAX` (default 10) — exceeding this evicts the
  least-recently-used worker.

### 3.2 WS disconnect does NOT cancel the worker

This is the load-bearing invariant for durable execution. When a WS
socket closes:

1. The channel-plugin handler (`ws-handler.mjs:stopAll`) clears
   timers and any active subscriptions.
2. It does **NOT** call `cancelRun(runId)` or `worker.stop()`.
3. The letta-code subprocess keeps streaming frames; the bridge
   keeps writing them to disk via `appendRunFrame`.
4. When the turn completes, `finalizeRun` writes the terminal
   `run.json` and the worker's `lastUsedAt` updates.

The doc-comment locking this contract lives at
`home/.letta/channels/mobile/lib/ws-handler.mjs:97` (lcp-98k). Don't
add a `cancelRun` to `stopAll` without re-reading that comment.

### 3.3 Reconnect handoff

On reconnect, the client sends a fresh `hello` + a `subscribe` for
each active run id. The replay phase covers any frames written during
the disconnect window; live tail picks up from there. No state lives
on the old socket — sessions are per-WS, frame logs are per-run.

---

## 4. Cron catch-up

### 4.1 `last_tick_at` on disk

`crons.json` (in `${LETTA_HOME}`) carries a `last_tick_at: string |
null` field at the top level alongside `scheduler_owner` and `tasks`:

```json
{
  "version": 1,
  "scheduler_owner": { "pid": 12345, "token": "…", "started_at": "…", "process_start_ticks": "…", "boot_id": "…" },
  "last_tick_at": "2026-05-19T13:59:00.000Z",
  "tasks": [ /* CronTask[] */ ]
}
```

Updated atomically by two paths only:

1. **Lease claim** (scheduler boot) writes `last_tick_at = now()` in
   the same lock-transaction as the `scheduler_owner` update. This
   establishes a known floor for the catch-up window.
2. **Fire path** — every `updateTaskAndTickTime(taskId, updater, now)`
   call (used by both recurring fires and missed-one-shot transitions)
   stamps `last_tick_at = now` in the same lock-transaction as the row
   update. No extra fsync per tick — the write was happening anyway.

Idle ticks (no fires) deliberately do NOT write to disk. The catch-up
algorithm handles staleness via per-task `last_fired_at` dedup, so
there's nothing to gain from writing a heartbeat every minute.

### 4.2 Catch-up algorithm

Runs once per scheduler start, **before** the first regular tick:

```
prev = claimSchedulerLease().previousTickAt       // null on fresh install
if prev is null:
  skip catch-up

cap = SHIM_CRON_CATCHUP_WINDOW_MS (default 1h)
windowStart = max(prev, now - cap)
windowEnd   = startOfMinute(now)                  // exclusive

if windowStart >= windowEnd:
  skip catch-up                                   // nothing to catch up

for each active task:
  if task is recurring:
    latestMatch = walk minutes [windowStart, windowEnd) backward
                  → first cronMatchesTime(task.cron, m, task.timezone)
    if latestMatch and (task.last_fired_at is null
                        or parse(last_fired_at) < latestMatch):
      fire(task)
  elif task is one-shot and task.scheduled_for in [windowStart, windowEnd):
    fire(task)                                    // bypasses the
                                                  // 5-min missed
                                                  // threshold
```

After catch-up, the first regular tick runs at `now`'s minute. Since
the window is **exclusive** of the current minute, catch-up fires and
the first-tick fires can never collide — no extra dedup state needed.

### 4.3 Why the cap

Without a cap, a shim that was offline for a week would fire a
recurring `every-hour` task 168 times on restart. The default 1h cap
trades "exhaustive recovery" for "bounded fan-out". Override with
`SHIM_CRON_CATCHUP_WINDOW_MS` if you have a use case for a wider
window.

### 4.4 Why fire ONCE per catch-up

If a task should have fired N times during downtime, the catch-up
fires it once (for the *latest* matched minute) — not N times. The
prompt context is "wake up and figure out what changed"; firing it
once captures the intent. Mass-fire on recovery is almost never what
the user wants.

---

## 5. Non-goals

### 5.1 No retry / no replay of *outbound* effects

The shim doesn't track which tool calls were already executed. If a
turn fires a tool that hits an external API and the shim crashes
before the response is processed, the tool call is **not** retried.
This is the same semantic as a normal Letta server — there's no
idempotency key tracking.

### 5.2 Mid-turn worker crash: finalization is not automatic

A Run left in `status: "running"` after a shim crash will stay
`running` until manually deleted. A future bead may add a startup
sweep that marks orphaned Runs as `failed`, but v1 keeps them so the
operator notices.

### 5.3 No bounded retention on `frames.jsonl`

`state/runs/<id>/` directories grow indefinitely. The cron scheduler
GC removes terminal cron tasks after 24h (`GC_AGE_MS` in
`lib/crons.ts`), but Run records and their frame logs are kept
forever. A future GC pass (or an LRU policy on `runs/`) is the
obvious lever; not in v1.

### 5.4 No distributed coordination

The cron scheduler lease serializes *processes* via
`scheduler_owner.pid` + `boot_id`, but it assumes a single host. Two
shim instances on different machines pointing at the same
`$LETTA_HOME` (e.g. shared NFS) would each think they're the rightful
owner. Don't deploy that way.

### 5.5 Frame log is per-process, not a journal

If a different shim instance picks up an existing `frames.jsonl` and
starts writing to it (impossible today because the agent pool is
in-process, but conceivable in a future multi-shim setup), seq
collisions are possible. The seq counter is `handle.frameCount`, not
a disk-read seek. Single-writer-per-run is part of the contract.

---

## 6. Where the code lives

| Concern | File |
|---|---|
| Frame log writer | `admin-shim/lib/runs.ts` (search `appendRunFrame`) |
| Frame log reader + live-tail | `admin-shim/lib/mobile-channel-host.ts` (search `subscribeToRun`) |
| Subscribe WS routing | `home/.letta/channels/mobile/lib/ws-handler.mjs` (search `case "subscribe"`) |
| Agent-pool worker lifecycle | `admin-shim/lib/agent-pool.ts` (`Worker`, `housekeep`, `stopAll`) |
| WS handler doc-comment locking the disconnect-doesn't-cancel contract | `home/.letta/channels/mobile/lib/ws-handler.mjs:97` |
| Cron scheduler + catch-up | `admin-shim/lib/cron-scheduler.ts` (`runCatchUp`, `startCronScheduler`) |
| Combined fire+tick write | `admin-shim/lib/crons.ts` (`updateTaskAndTickTime`) |

For the wire protocol that consumes this durability layer, see
[`MOBILE_WS_PROTOCOL.md`](MOBILE_WS_PROTOCOL.md) — §2.1 `subscribe`,
§2.2 `subscribe_frame` / `subscribe_done`, §11 reconnect resume.

For the cron-feature surface that depends on the catch-up layer, see
[`MOBILE_WS_PROTOCOL.md` §10](MOBILE_WS_PROTOCOL.md#10-cron--scheduled-prompts)
and [`DIVERGENCE.md` §5](DIVERGENCE.md).

---

## 7. Tests

Coverage lives across several files; all run under `npm test`:

| Test file | What it pins |
|---|---|
| `test/frames-log.test.ts` | Monotonic seq, round-trip, concurrent serialization, partial-line resilience |
| `test/ws-subscribe.test.ts` | Full replay, tail-only with cursor, live-tail, run_not_found, terminal status, idempotent re-subscribe |
| `test/worker-ttl.test.ts` | Pool stats endpoint, WS-disconnect-mid-turn finalization, idle eviction after `SHIM_POOL_IDLE_SEC` |
| `test/cron-catchup.test.ts` | Lease writes `last_tick_at`, recurring catch-up, dedup against `last_fired_at`, one-shot catch-up, 1h cap, env override, fresh-install skip, combined-write |
| `test/cron-scheduler.test.ts` | The non-durability scheduler surface — tick loop, lease conflict, mtime watcher, etc. |

Total: ~80 tests for the durable-execution stack; suite runs in <30s
on the workstation.
