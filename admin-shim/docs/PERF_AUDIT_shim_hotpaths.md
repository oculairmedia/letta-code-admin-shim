# Admin-shim hot-path perf audit — unbounded / asymptotic work

Audit scope: `admin-shim/lib/*.ts`. Target bug class (per lcp-02ri / PR #18):
**work that scales with total run/conversation history instead of with new
data** — full-file reads/parses on a per-append/per-frame/per-request basis,
history-wide filter/map/sort/find inside per-frame or per-request loops, index
rebuilds per delta, and unbounded accumulators that are never pruned.

Method: read every target module; characterize each suspect's complexity (what
scales with what) and where it's called from (per-frame / per-request /
per-turn / per-reconnect); measure empirically where feasible with plain-`node`
micro-benchmarks against the compiled `dist/`.

> Environment note: the sandbox `node --test` runner reported every file as a
> single passing test and swallowed injected failures (a deliberate
> module-load `throw` still reported `pass 1, exit 0`). So pass/fail from
> `npm test` is **not** a reliable signal here. Verification used (a)
> `tsc --noEmit` + `tsc -p tsconfig.build.json` (real compiler checks) and (b)
> direct `node` measurements against `dist/`. The full suite was still run to
> confirm no module load/import crash was introduced.

---

## Findings

### F1 — Conversation cursor replay re-reads+reparses the ENTIRE replay log on every reconnect  ·  **HIGH**  ·  FIXED

- **Location:** `lib/mobile-conversation-cursors.ts` — `readReplayFrames()`
  (pre-fix `readFileSync(path,"utf8")` + per-line `JSON.parse` over the whole
  file), called from `resumeConversation()` (and indirectly on every WS
  reconnect / `hello.resume`).
- **What scales with what:** read+parse cost is **O(total frames ever stamped
  for the conversation)**. The on-disk replay file `<conv>.frames.jsonl` is
  **append-only and never rotated** (`appendReplayFrame` only ever appends;
  `pruneReplay` trims the in-memory `state.replay` and nothing on disk). Yet
  the function only ever **returns** the most-recent `MAX_FRAMES` (default
  1000) that are within TTL and past the ack (`.sort(...).slice(-MAX_FRAMES)`).
  So per-reconnect work grows with the whole conversation history while useful
  output stays bounded — the exact lcp-02ri class.
- **Call frequency:** per WS reconnect / resume. For a long-lived mobile client
  that reconnects frequently (backgrounding, network flaps), this recurs over a
  conversation whose replay log only ever grows.
- **Evidence (measured, plain `node` vs `dist/`):**

  | frames on disk | resume read+parse (before) | resume (after fix) |
  |---:|---:|---:|
  | 500   | 1.85 ms  | ~8 ms |
  | 2 000 | 6.80 ms  | ~10 ms |
  | 8 000 | 17.22 ms | ~9 ms |
  | 20 000 | 64.19 ms | ~8 ms |
  | 50 000 | 115.21 ms | ~22 ms |

  Before: clearly linear in history. After: ~flat (bounded to the `MAX_FRAMES`
  tail) — 20k went 64 ms → 8 ms (~8×), 50k went 115 ms → 22 ms (~5×) and, more
  importantly, no longer grows with history.
- **Fix (applied):** replace the full-file read with a **bounded tail read**
  (`readReplayTailLines`) that seeks from EOF in 64 KiB chunks until it has
  `MAX_FRAMES + 1` complete lines (or hits BOF), drops a leading partial line,
  and parses forward. Frames are appended in strict seq-ascending order, so the
  newest `MAX_FRAMES` always live at the tail — the slice/TTL/ack filtering and
  output are byte-for-byte identical to before for every realistic case. Bounds
  reconnect read+parse to **O(MAX_FRAMES)** regardless of file size. Mirrors the
  `store.ts#readTailToolResultsSinceKnownSync` tailing pattern.
- **Regression test:** `test/mobile-conversation-cursors.test.ts` stamps 5 000
  frames (MAX_FRAMES forced to 50) and asserts (a) a far-behind cursor is
  correctly `cursorExpired` with `oldestSeq` near the tail — proof the reader
  didn't surface seq 1 — and (b) an in-window cursor replays only the bounded,
  contiguous, newest tail ending at `lastSeq`.
- **Residual (left as bead F1b):** the replay file itself still grows without
  bound on disk (a slow disk leak; reads are now bounded but storage isn't).
  Compaction/rotation of `<conv>.frames.jsonl` to the bounded window is a
  separate, slightly riskier change (rewrite-in-place) — filed, not fixed here.

---

### F2 — In-memory cursor `states` map is never pruned (per-conversation leak)  ·  **LOW**  ·  bead only

- **Location:** `lib/mobile-conversation-cursors.ts` — `const states = new
  Map<string, CursorState>()`; populated by `getState()`, never deleted.
- **What scales with what:** heap grows **O(distinct conversations seen over
  process lifetime)**. Each entry also holds a `replay: ReplayEntry[]` that IS
  bounded per-conversation (TTL + MAX_FRAMES via `pruneReplay`), so the leak is
  one bounded bucket per conversation, not unbounded per conversation — but the
  number of buckets is unbounded.
- **Call frequency:** one new entry per first-touch of a conversation.
- **Severity:** LOW — slow leak, no per-frame compute cost. Becomes relevant
  only for very long-lived servers fielding many distinct conversations.
- **Fix sketch (bead):** LRU/TTL cap on `states` (evict idle conversations;
  the on-disk sidecar is authoritative and reloads on next touch).

---

### F3 — Subagent registry retains every terminal entry forever  ·  **LOW**  ·  bead only

- **Location:** `lib/subagent-registry.ts` — `const _subagents = new
  Map<string, SubagentEntry>()`. `finalize()` flips status to
  completed/failed and clears watchers/timers, but **never removes the entry**;
  there is no `_subagents.delete` anywhere except the test reset.
- **What scales with what:** heap + `snapshotSubagents()` cost grow **O(total
  subagent dispatches over process lifetime)**. `snapshotSubagents()` does
  `[..._subagents.values()].map(clone).sort(...)` on every call;
  `listActiveSubagents()` builds on it and filters. So the mobile subagent-bar
  enumeration is O(all-time dispatches), not O(active).
- **Call frequency:** `handleSubagentList` per mobile poll/subscribe;
  `snapshotSubagents` on each registry event broadcast.
- **Severity:** LOW today (dispatch counts are modest), but it is a genuine
  unbounded accumulator + a history-wide map+sort on a read path.
- **Fix sketch (bead):** cap retained terminal entries (ring buffer / LRU of
  the last N terminal subagents) or drop terminal entries after a grace window;
  keep all `running` entries.

---

### F4 — Self-todo per-conversation maps are never pruned  ·  **LOW**  ·  bead only

- **Location:** `lib/self-todo.ts` — `_byConversation` and
  `_sessionTasksByConversation` (both `Map<string, …>`), populated by
  `ingestSelfTodoFrame` / `getOrInitSessionTasks`; only cleared by the
  test-only `__resetSelfTodo`.
- **What scales with what:** heap grows **O(distinct conversations seen)**. The
  `SessionTaskAccumulator.tasks[]` per conversation is bounded by tasks created
  in that conversation (small), so this is a per-conversation-bucket leak, not
  unbounded-per-conversation.
- **Call frequency:** one entry per first plan-carrying frame per conversation,
  fed from `bridgeSendMessage`'s per-frame `emit()`.
- **Severity:** LOW. Same shape as F2.
- **Fix sketch (bead):** LRU/TTL cap; the disk transcript (`readSelfTodos`) is
  the authoritative fallback, so eviction is lossless for correctness.

---

## Already-mitigated (verified, no action)

These are in the target class but prior work already bounds them — recorded so
future readers don't re-flag them:

- **`runs.ts#listRuns` / `buildMessageRunMap` / `aggregateUsage`** walk the runs
  root and stat/parse each `run.json`. Measured linear in run count
  (26 ms @200 → 165 ms @4000). BUT mitigated by: (1) `readRunAt` stat-gated
  per-file parse cache (lcp-r6lb) so repeated walks pay stat-only, (2)
  `buildMessageRunMap` 1 s memo (lcp-spok) collapsing poll bursts, and (3)
  `compactRuns` archiving terminal runs to `_archive` to keep the live root
  ~`SHIM_RUNS_RETENTION` (default 1000) — lcp-98cm. The hot `GET /messages`
  path is therefore bounded in practice.
- **`store.ts#listMessages*`** — stat-gated `(size,mtimeMs)` cache + LRU cap
  (lcp-h5ns), and `listNewToolResultsSync` already tails backward from EOF
  (lcp-pgw / lcp-4tv) instead of full-scan.
- **`mobile-channel-host.ts#subscribeToRun`** — byte-offset live-tail +
  seq→byteOffset checkpoint seek (lcp-02ri.2): the original lcp-02ri bug,
  already fixed and regression-tested (`subscribe-replay-index.test.ts`).
- **`runs.ts#appendRunFrame`** — tracks `frameBytes`/`frameCount`/`frameIndex`
  in memory so per-frame append is O(1) with no re-stat/re-read.
- **`chat.ts#coalesceAssistantFrames`** and the mobile-host streaming concat —
  use array-join accumulators, not `prev + chunk` per delta (lcp-86o), so the
  per-token coalesce is not O(n²).
- **`runs.ts#runFileCache` / `runMapMemo`** and `store.ts#messagesCache` all
  carry explicit size caps (LRU-ish), so those caches are not unbounded.

---

## Top 3 by severity

1. **F1 (HIGH, fixed)** — cursor replay full-file reread on every reconnect →
   O(total history). Now tail-bounded; measured 8×/5× wins at 20k/50k frames.
2. **F3 (LOW, bead)** — subagent registry keeps every terminal entry forever +
   history-wide map+sort on the enumeration read path.
3. **F2 (LOW, bead)** — in-memory cursor `states` map never pruned
   (per-conversation leak); F4 is the same shape in self-todo.
