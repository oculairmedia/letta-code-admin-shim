# Handoff — TypeScript migration of admin-shim

State as of the last session. Open this in a fresh session to continue.

## Where we are

- Repo: `/opt/stacks/letta-code-parallel`
- Remote: https://github.com/oculairmedia/letta-code-admin-shim
- Branch: `master`
- Live shim (dogfood instance): tmux session `lettashim`, http://localhost:8291
- Test suite: **141 tests / 140 pass + 1 todo / ~80s serial wall-time**, 100% deterministic after the OS-port-assignment fix
- All source is still `.mjs` — the TS migration has NOT started yet

## What just shipped

Four commits on master:
- `46b9b3d` — Initial commit (admin-shim + channels + migrator + docs + LICENSE + README + CI workflow)
- `b9567dc` — Test harness: 138 behavioral tests + 9 captured letta-code stream traces + mock letta + GitHub Actions
- `6191e10` — Fix WS / SSE conv-id asymmetry in mobile-channel-host (resolveConversationId is now called on WS path; literal `"default"` is refused to prevent multi-agent mis-routing; 2 new regression tests)
- `178096f` — Stabilize test harness (OS-assigned ports via SHIM_PORT=0) + refuse ambiguous `default` in resolveConversationId + multi-agent regression test + this handoff doc

Working tree is clean. Ready to start the migration.

## Activating the sandbox

```bash
cd /opt/stacks/letta-code-parallel
source ./env.sh                 # sets HOME, LETTA_LOCAL_BACKEND_DIR, etc.
cd admin-shim
npm test                        # baseline: 140 passing + 1 todo
```

The live shim is in tmux:

```bash
tmux attach -t lettashim        # see live logs
# or restart it:
tmux kill-session -t lettashim
tmux new-session -d -s lettashim '... see HANDOFF for the full env block ...'
```

Full restart command (one-liner):

```bash
# Prerequisite: build the shim first (`cd admin-shim && npm run build`) so dist/ exists.
tmux new-session -d -s lettashim 'env HOME=/opt/stacks/letta-code-parallel/home LETTA_LOCAL_BACKEND_DIR=/opt/stacks/letta-code-parallel/migrator/out LMSTUDIO_BASE_URL=http://localhost:8082/v1 LETTA_BASE_URL=http://127.0.0.1:0 LETTA_LOCAL_BACKEND_EXPERIMENTAL=1 NODE_PATH=/opt/stacks/letta-code-parallel/admin-shim/node_modules node /opt/stacks/letta-code-parallel/admin-shim/dist/server.js 2>&1 | tee /tmp/admin-shim.log'
```

## The migration plan

Filed as 17 beads in the project's beads tracker. Entry point:

```bash
bd ready                        # shows lcp-dxa (epic) + lcp-ecg (Phase 1)
bd graph lcp-dxa                # full dependency graph
bd show lcp-ecg                 # acceptance criteria for the first task
```

### Phase summary

| Phase | Bead | Description |
|-------|------|-------------|
| Epic | `lcp-dxa` | TS migrate admin-shim — no behavior change |
| 1 | `lcp-ecg` | tsconfig + tsx + npm scripts + CI gate (no source changes) |
| 2a | `lcp-iym` | Wire-shape types: vanilla Letta wire frames |
| 2b | `lcp-9fd` | Wire-shape types: letta-code stream-json frames |
| 3a | `lcp-bma` | Convert `runs.mjs` → `runs.ts` |
| 3b | `lcp-gza` | Convert `store.mjs` → `store.ts` |
| 3c | `lcp-u3q` | Convert `translate.mjs` → `translate.ts` |
| 4a | `lcp-09h` | Convert `agent-pool.mjs` → `agent-pool.ts` |
| 4b | `lcp-ry1` | Convert `chat.mjs` → `chat.ts` |
| 4c | `lcp-7sf` | Convert `mobile-channel-host.mjs` → `mobile-channel-host.ts` |
| 5 | `lcp-iei` | Convert `server.mjs` → `server.ts` |
| 6a | `lcp-grr` | Convert `test/helpers/*` to TypeScript |
| 6b | `lcp-cve` | Convert `test/*.test.mjs` to `.test.ts` |
| 6c | `lcp-62s` | Flip `tsconfig` to emit `dist/`; `npm start` runs compiled output |
| 7a | `lcp-afr` | Enable strict-mode tightening (`noUncheckedIndexedAccess` etc.) |
| 7b | `lcp-1ek` | Update README + AGENTS.md + test/README.md |
| 7c | `lcp-dab` | Publish channel-plugin `.d.ts` for external authors |

Deps form a linear-ish chain with two parallel branches: 2a/2b and 3a/3b can each be done in parallel; 7a/7c can be done in parallel after 6c. Use `bd ready` to find what's unblocked.

### Hard rules for every phase

1. **All 140 tests must still pass after each phase.** Run `npm test` before committing.
2. **No behavior changes.** This is purely a typing exercise. Any "bug" discovered (e.g., the run-level `usage` first-frame-vs-sum thing) gets a separate bead and stays untouched in this epic.
3. **Channel plugins (`home/.letta/channels/*`) stay `.mjs`.** They're runtime-discovered, plugin-author-inspectable. Phase 7c ships `.d.ts` types for plugin authors who want to opt in.
4. **Migrator stays `.mjs`.** It's a one-off script.
5. **No new runtime deps.** `typescript`, `tsx`, `@types/*` are devDependencies only.
6. **Strict from day one.** No `any`, no `@ts-ignore` outside the documented channel-plugin import boundary. Use `unknown` + type guards.

### Suggested rhythm

For each phase task:
1. `bd update <id> --claim` — claim it
2. Read `bd show <id>` for the acceptance criteria
3. Make the changes
4. `npm test` (must stay green)
5. Commit with the bead id in the message: `git commit -m "lcp-XXX: <one-line summary>"`
6. `bd close <id>`
7. `git push` and `bd dolt push`

## Locked behavioral contracts the harness defends

These are pinned-in-place test assertions the TS refactor must preserve (don't "fix" them as part of the migration):

- **`approval_request_message` → `tool_call_message` remap** with id `toolcall-${tool_call_id}` (chat.mjs reshapeFrame). Mobile's `distinctBy { id }` depends on this.
- **`cm-stream-` prefix** on streamed assistant_message ids (tagAsOptimistic). Mobile content-dedup keys on this.
- **Per-type date offsets**: user+0ms, reasoning+10ms, tool_call+20ms, tool_return+30ms, assistant+40ms — applied identically on stream AND disk projection.
- **Run-level `usage`** captures the FIRST `usage_statistics` frame, NOT the sum. (Step-level `usage` in steps.jsonl IS per-step.) Documented in `runs.test.mjs`.
- **Run-level `stop_reason`** is the FIRST step's stop, not the final. (So bash-tool turns show `status: completed` + `stop_reason: requires_approval`.)
- **Bare literal `"default"`** does NOT resolve via `resolveConversationId` (returns null). Use `conv-default-<agentId>` or supply agent context via URL.
- **`turn_done` WS sentinel** fires AFTER disk-stamping completes — mobile can safely GET `/messages` once it sees this.
- **Single-flight per WS session**: a second `send_message` while one is in-flight returns `{code: "protocol_violation"}` and the first continues.

## Other open issues unrelated to migration (don't tackle in this epic)

- `lcp-ayo` — sidecar JSON writes are O(n) and not crash-safe
- `lcp-efg` — `resolveConversationId` does full disk scan per send (perf)
- `lcp-y88` — `findUnmappedTailUserMessageId` re-reads entire `messages.jsonl` per turn (perf)
- The 1 `t.todo` in `ws-protocol.test.mjs` for `reasoning_message` forwarding — would need a real model run to exercise

## Key file paths

- Source: `admin-shim/server.mjs`, `admin-shim/lib/*.mjs`
- Tests: `admin-shim/test/*.test.mjs`, `admin-shim/test/helpers/*.mjs`
- Captured letta-code stream fixtures: `admin-shim/test/fixtures/stream-traces/*.jsonl`
- Channel plugins: `home/.letta/channels/{mobile,matrix}/`
- Design docs: `docs/MOBILE_CHANNEL_DESIGN.md`, `admin-shim/docs/DIVERGENCE.md`
- Mobile (for cross-checking wire shapes): `/opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/*.kt`

## Memory notes (persistent context)

The session memory at `/root/.claude/projects/-opt-stacks/memory/` already holds:
- `project-mobile-otid-reconcile` — mobile reconciles by otid; shim must echo it on user_message projection
- `reference-mobile-dedup-pipeline` — `distinctBy { id }` + `dedupeOptimisticContentTwins` constraints
- `project-shim-timestamp-offsets` — the per-type stagger schedule
- `project-letta-code-tool-message-remap` — approval_request_message → tool_call_message
- `project-shim-run-tracking` — Run lifecycle + `/v1/runs/*` surface

Future sessions automatically have these via `MEMORY.md`.
