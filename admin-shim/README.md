# letta-code admin shim

Tiny zero-dep Node service that exposes a Letta-server-compatible REST surface
on top of letta-code's `LocalBackend` on-disk state, so `letta-mobile` (and any
other Letta REST client) can read agents and chat with them without the Python
Letta server.

## Status: Phase 1 ✓

Read + chat coverage proven against the migrated Meridian agent.

| Endpoint | Method | Status |
|---|---|---|
| `/v1/health/` | GET | ✓ |
| `/v1/agents` | GET | ✓ list, filter by tags / name |
| `/v1/agents/count` | GET | ✓ |
| `/v1/agents/{id}` | GET | ✓ full Letta `AgentState` shape |
| `/v1/agents/{id}/messages` | GET | ✓ list, paginated |
| `/v1/agents/{id}/messages` | POST | ✓ stream (SSE) + non-stream |
| `/v1/agents/{id}/context` | GET | ✓ context window overview |
| `/v1/agents/{id}/core-memory/blocks` | GET | ✓ |
| `/v1/blocks`, `/v1/blocks/{id}` | GET | ✓ |
| `/v1/models` | GET | ✓ (single entry, expand later) |
| `/v1/crons`, `/v1/crons/{id}`, `/v1/crons/scheduler` | GET | ✓ read-only mirror — mutations go over the mobile WS, see [§ Scheduled prompts](#scheduled-prompts) |
| anything else | * | 404 — mobile UI degrades gracefully |

## Run

```bash
source /opt/stacks/letta-code-parallel/env.sh
export LETTA_LOCAL_BACKEND_DIR=/opt/stacks/letta-code-parallel/migrator/out
node /opt/stacks/letta-code-parallel/admin-shim/server.mjs
# → listening on http://0.0.0.0:8291
```

Override port: `SHIM_PORT=8292 node …`.

Point letta-mobile at `http://<this-host>:8291` instead of the Python Letta
server (default `192.168.50.90:8289`).

## How chat works

`POST /v1/agents/{id}/messages` spawns `letta --backend local --agent <id> -p
<text> --output-format stream-json` as a subprocess per request, then either:

- **stream**: relays each stdout line as an SSE event (`event: <message_type>\ndata: <json>\n\n`)
- **non-stream**: collects all frames, returns a single JSON with the
  assistant messages, usage, and stop reason

The subprocess is killed if the HTTP client disconnects.

## Layout

```
admin-shim/
├── README.md
├── server.mjs           # HTTP server + routes
└── lib/
    ├── store.mjs        # Read LocalStore from disk
    ├── translate.mjs    # LocalAgentRecord/LocalMessage → Letta server shapes
    └── chat.mjs         # POST /v1/agents/{id}/messages
```

## What's deliberately missing in Phase 1

- POST/PATCH/DELETE on agents, blocks, archival memory, schedule — Phase 2
- Tools / providers / MCP servers / identities / folders / groups / jobs / runs — Phase 3+
- Real `/v1/models` enumeration from the lmstudio backend — Phase 2 (just returns the one we've validated)
- Auth — currently open; gate behind a bearer token once we wire up a real client
- The "cached_input_tokens" returned in usage right now includes the entire
  system prompt + history. Phase 2 cache reporting tweaks.

## Durable execution

The shim survives partial failures — mobile network drops, app
restarts, shim restarts, cron downtime — without losing user-visible
state. Four primitives:

| Primitive | What it gives you |
|---|---|
| Per-run frame log | `state/runs/<id>/frames.jsonl` — every WS frame appended with a monotonic `seq`. Replayable on reconnect. |
| `subscribe(run, cursor)` WS frame | Reconnecting clients resume from a known `seq` — see [§11 of MOBILE_WS_PROTOCOL.md](docs/MOBILE_WS_PROTOCOL.md#11-reconnect-resume). |
| Worker survives WS disconnect | A dropped socket does NOT cancel the in-flight letta-code worker. The turn continues to disk. |
| Cron `last_tick_at` + catch-up | Scheduler restart computes a catch-up window and fires missed prompts exactly once (1h cap default). |

Full design + on-disk layout + non-goals:
[`docs/DURABLE_EXECUTION.md`](docs/DURABLE_EXECUTION.md).

## Scheduled prompts

The shim exposes a cron-style "scheduled prompt" feature so an agent
can fire on a schedule (every 5 minutes, every Monday at 8am, a
one-shot in 30 minutes, etc). Writes go over the mobile WS
(`/shim/v1/mobile`), reads are mirrored to plain HTTP.

| Surface | Frames / routes |
|---|---|
| WS frames | `cron_list` / `cron_add` / `cron_get` / `cron_delete` / `cron_delete_all` (+ `*_response` replies). Live `crons_updated` push on every mutation, scheduler fire, and external write. |
| REST (read-only) | `GET /v1/crons` (filters: `?agent_id=` / `?conversation_id=`), `GET /v1/crons/{id}`, `GET /v1/crons/scheduler` |
| Store | `$LETTA_HOME/crons.json` — shared with the bundled `letta cron` CLI so the agent's self-schedule skill interoperates. |
| Scheduler | In-process under the shim's systemd unit (one process holds the lease at a time). Toggle with `SHIM_CRON_ENABLED=0` to opt out. |

Full wire contract + 19-field `CronTask` schema:
[`docs/MOBILE_WS_PROTOCOL.md` §10](docs/MOBILE_WS_PROTOCOL.md#10-cron--scheduled-prompts).

Mutation routing rationale (and why there's no `POST /v1/crons`):
[`docs/DIVERGENCE.md` §5](docs/DIVERGENCE.md).

## Letta Code transport: SDK Session (lcp-sdk.10)

The shim drives letta-code through `@letta-ai/letta-code-sdk`'s `Session`.
The hand-rolled subprocess transport was retired in lcp-sdk.10. There's
no transport flag and no fallback path — the SDK adapter is the only
implementation. The release before this one shipped both behind
`SHIM_LETTA_TRANSPORT=sdk` if you ever need to compare.

**Pool sizing (lcp-2oxb.6)**: each warm worker is a full letta-code CLI
subprocess — measured ~450 MB RSS warm with loaded conversation state
(idle letta.js baselines run ~80–100 MB). `SHIM_POOL_MAX` (default 10)
therefore budgets ~4.5 GB worst case; size it as available-RAM ÷ 450 MB
and leave headroom, since the pool will temporarily overflow the cap
rather than kill an in-flight turn (lcp-2oxb.2). Cold-starting an evicted
worker costs a full Node boot of the bundle plus session resume, so keep
`SHIM_POOL_IDLE_SEC` (default 300) generous when traffic revisits
conversations. Live perf counters (event-loop delay, frame throughput,
RSS) ride on the pool stats endpoint (`lcp-2oxb.1`).

Operational quirks worth knowing:

- **`--backend local` injection**: the SDK doesn't pass `--backend local`
  when spawning the CLI, and current letta-code versions require it
  explicitly (`LETTA_LOCAL_BACKEND_EXPERIMENTAL=1` alone isn't enough —
  tracked upstream as LET-9013). The shim points the SDK's
  `LETTA_CLI_PATH` at `admin-shim/scripts/letta-cli-sdk-wrapper.mjs`,
  a tiny node script that injects `--backend local` before exec'ing the
  real binary. `server.ts` auto-wires this on startup when
  `LETTA_CLI_PATH` is unset; if you set it explicitly, also set
  `LETTA_CLI_PATH_REAL` to the path of the real `letta-code` CLI.
- **Approvals**: letta-code is approval-by-default. The SDK invokes the
  shim's `canUseTool` callback for every tool; the adapter synthesizes
  an `approval_request_message` wire frame so mobile's A2UI surface
  works unchanged. See `_handleCanUseTool` in `lib/letta-sdk-adapter.ts`
  and `lcp-j3r` for the known synthetic-vs-real `tool_call_id`
  divergence.
- **Benign noise**: the CLI logs `Failed to call
  /v1/tools/add-base-tools: fetch failed` on startup because
  `LETTA_BASE_URL=http://127.0.0.1:0` is a deliberate dead URL. Not a
  regression.

### Run-ID ownership (decision: `lcp-sdk-decide-runid`)

The shim owns mobile-facing run IDs. The SDK's `SDKResultMessage.runIds`
(and the upstream Letta `run_id` fields on stream events) are NOT
surfaced to mobile and are NOT accepted by `/v1/runs/{id}` — the shim's
`createRun()` allocates a `run-<uuid>`, that ID is what flows through
WS frames, frame replay, `/v1/runs/*` records, and message attribution.

Why this split:

- The shim's `/v1/runs/*` store is a local compatibility surface mobile
  has historically relied on. Letta Cloud / self-hosted may also expose
  `/v1/runs/{id}` against upstream run IDs. Mixing the two caused earlier
  diagnostic confusion where a shim ID was queried against the real API.
- The SDK `Session` doesn't yet offer a stable lookup for upstream runs
  in a way that would make round-tripping safe.
- Mobile's existing UX is keyed on the shim ID — re-keying mid-migration
  would be a separate disruption with no current upside.

Concrete invariants enforced in code:

- `SdkBackedLettaSessionAdapter.runTurn` returns `run_id: runHandle.id`
  — never the SDK's `result.runIds`.
- The SDK's per-event `runId` on stream events flows through unchanged
  on the stream_event payload (downstream may use it for upstream stale-
  run detection inside one turn) but never replaces the shim ID on the
  outer wire envelope.
- Test `sdk-adapter (lcp-sdk-decide-runid): adapter never leaks SDK
  result.runIds as the wire run_id` pins this boundary.

Revisit if the Letta Code SDK exposes a full `/v1/runs/*` equivalent
with stable run lookup. Until then: shim ID is authoritative.

### History endpoints stay on disk reads (decision: lcp-sdk.7)

The SDK exposes `Session.listMessages()` / `Session.bootstrapState()`
over a CLI control protocol. After evaluation
([`docs/SDK_HISTORY_EVAL.md`](docs/SDK_HISTORY_EVAL.md)) the shim
continues to read `messages.jsonl` + sidecars directly: the projection
layer (tool fan-out, in-flight filter, real-time + otid sidecars, shim
run-id attribution) is shim-specific and can't be sourced from upstream
without re-implementing it on top of the SDK output. Revisit if the
SDK adds a vanilla-Letta-shaped projection, or when the remote-Letta
proxy mode (lcp-9he) ships.

### Smoke + rollback

Promotion checklist, scenario-by-scenario smoke (REST/SSE, mobile WS,
tool turns, approval, A2UI, cancel, disconnect/replay, conv stability),
and the one-line rollback live in
[`docs/SDK_TRANSPORT_SMOKE.md`](docs/SDK_TRANSPORT_SMOKE.md). Automated
subset (scenarios 1–3) runs via:

```bash
SHIM_URL=http://localhost:8291 \
AGENT_ID=agent-... \
MOBILE_TOKEN=... \
  node admin-shim/scripts/smoke-sdk-transport.mjs
```

## Known caveats

- letta-code splits long assistant outputs into multiple `assistant_message`
  frames. Mobile UIs that don't concatenate may show fragmented bubbles.
  Easy fix: collapse consecutive frames in the non-streaming path.
- The subprocess-per-message model has ~1–2s startup overhead per turn.
  Phase 2 idea: keep a single long-running `letta server` and pipe via a
  control socket. (Or — channels-as-transport, the mobile channel plugin.)
