# SDK transport smoke + rollback (lcp-sdk.9)

Pre-flight checklist for promoting `SHIM_LETTA_TRANSPORT=sdk` to default,
and the rollback path if anything goes sideways in production.

> **Status**: the SDK transport is off by default. Operators opt in by
> setting `SHIM_LETTA_TRANSPORT=sdk` in the shim's environment. The
> hand-rolled `DirectSubprocessLettaSessionAdapter` remains the production
> transport until this smoke passes in a live environment and the result
> is recorded in lcp-sdk.9's close reason.

## TL;DR rollback

Set `SHIM_LETTA_TRANSPORT=direct` (or unset the variable entirely) and
restart the shim. The direct subprocess adapter is still wired in
parallel; the flag selects which one `AgentPool.get()` returns. No state
migration is required.

```bash
# /opt/stacks/letta-code-parallel/env.sh — set or remove the line
export SHIM_LETTA_TRANSPORT=direct

systemctl restart lettashim.service       # or whatever runs the shim
journalctl -u lettashim.service -f         # confirm "[pool] spawned transport=direct"
```

If both `SHIM_LETTA_TRANSPORT=sdk` AND `SHIM_POOL_DISABLE=1` are set, the
shim logs a one-time warning and falls back to direct. Unset
`SHIM_POOL_DISABLE` to make SDK transport effective.

## Environment

The SDK transport needs three envvars beyond what the direct path uses:

| Variable | Purpose | Example |
|---|---|---|
| `SHIM_LETTA_TRANSPORT` | `sdk` enables SDK transport; `direct` (or unset) keeps the hand-rolled path. | `sdk` |
| `LETTA_CLI_PATH` | Where the SDK looks for the `letta` binary. The SDK resolves in this order: `LETTA_CLI_PATH` → `require.resolve("@letta-ai/letta-code")` → a few hard-coded fallbacks. Pin this so the shim and CLI stay aligned during the migration. | `/root/.bun/install/global/node_modules/@letta-ai/letta-code/letta.js` |
| `LETTA_LOCAL_BACKEND_DIR` | The on-disk LocalBackend root that letta-code writes to. The shim reads from the same dir. | `/opt/stacks/letta-code-parallel/migrator/out` |

`LETTA_BASE_URL` on the SDK path is still set to `http://127.0.0.1:0`
(the deliberate dead URL — letta-code's startup logs
`Failed to call /v1/tools/add-base-tools: fetch failed`, which is the same
benign noise the direct path produces; not a regression).

Diagnostics envvars worth knowing:

- `DEBUG_SDK=1` — verbose `[SDK-Session]` + `[SDK-Transport]` logs to
  stderr. Useful for diagnosing "stream ended without result," approval
  conflict recovery, and CLI subprocess args.
- `SHIM_POOL_TURN_TIMEOUT` — watchdog (ms) for a single turn. Default
  180_000. The SDK adapter honors the same envvar as the direct path.
- `SHIM_POOL_IDLE_SEC` — idle eviction (seconds, default 300). Both
  adapters now heartbeat `lastUsedAt` on every inbound frame so long
  turns don't get evicted mid-stream (see lcp-rfb).

## Smoke scenarios

Each scenario lists what to run, what to expect on the wire, and how to
triage failures. The first three are the ones a fully automated script
can cover against a real letta-code binary. Scenarios 4–9 require a
mobile client (or a hand-rolled WS smoke) because A2UI capability is
negotiated on the hello frame.

### 1. Text-only REST/SSE turn

```bash
curl -s -N -X POST "http://<host>:<port>/v1/agents/<agentId>/messages" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"reply with pong"}],"stream_tokens":true}'
```

Expected SSE frames (order matters):

- `data: {"message_type":"ping",...}`
- ≥1 `data: {"message_type":"assistant_message",...}`
- `data: {"message_type":"stop_reason","stop_reason":"end_turn"}`
- `data: {"message_type":"usage_statistics",...}`
- `data: [DONE]`

The shim log should show:

```
[pool] spawned transport=sdk key=<agentId>::default size=1
[sdk-adapter] started agent=<agentId> conv=<convId> session=<sessionId>
```

**Failure triage**: if the stream stalls after `ping`, set `DEBUG_SDK=1`
and re-run; look for `[SDK-Session] [stream] starting stream` followed by
no `yield #N` lines — that means the CLI subprocess started but isn't
emitting messages. Check that `LETTA_CLI_PATH` resolves to a real binary
and the binary supports `--include-partial-messages`.

### 2. Text-only mobile WS turn

```js
// Pseudocode — see admin-shim/test/helpers/ws.ts for a working example.
const ws = new WebSocket("ws://<host>:<port>/shim/v1/mobile");
ws.send(JSON.stringify({ type: "hello", device_id: "smoke", client_version: "1.0", token: "<token>" }));
// Wait for welcome.
ws.send(JSON.stringify({
  type: "send_message",
  agent_id: "<agentId>",
  conversation_id: "conv-default-<agentId>",
  text: "reply with pong",
  otid: "ot-smoke-1",
}));
```

Expected envelope sequence:

- `turn_started` with non-null `run_id`
- ≥1 `assistant_message`
- `stop_reason`
- `usage_statistics`
- `turn_done` with `status:"completed"`, `lossy:false`

Same `[pool] spawned transport=sdk` log line.

**Failure triage**: if `turn_done` never arrives, check the shim log for
`[sdk-adapter]` lines. No `[sdk-adapter] started` means pool.get() failed
— usually a `LETTA_CLI_PATH` problem or the SDK couldn't find the binary.

### 3. Multi-step / tool turn

Ask the agent to do something that requires a tool (e.g., `"run pwd"`,
`"read /etc/hostname"`). The CLI emits:

- `tool_call_message` (function:name + arguments)
- `tool_return_message` (status, tool_return, optionally stdout/stderr)
- ≥1 `assistant_message`

The shim's run record at `/v1/runs/<runId>/steps` should show one step
per call. `/v1/runs/<runId>` lists the assistant text and stop reason.

**Failure triage**: if the tool fires but the agent never responds with
text after it, look for `stop_reason: error` and check the CLI's stderr
(captured into the run record under `error`).

### 4. Approval-required tool turn

Same as #3 but with a tool that requires approval (the CLI is
approval-by-default for tool calls). On the SDK path the CLI emits
`can_use_tool` control_requests to the SDK pump, and the shim's
`SdkBackedLettaSessionAdapter._handleCanUseTool` synthesizes an
`approval_request_message` wire frame so mobile's A2UI surface gets its
approval card. Mobile's `user_action` (approve/deny) resolves the same
approval gate the direct path uses.

Expected sequence:

- `tool_call_message` (the proposed call)
- `approval_request_message` with `tool_call_id: "synthetic-<uuid>"`
  (this is a known divergence from the direct path — see lcp-j3r)
- Mobile sends `user_action` with `decision: "approve" | "deny"` and
  `scope: "Once" | "Session" | "Forever" | "Deny"`
- If approved: `tool_return_message` follows, then `assistant_message`
- If denied: `assistant_message` carries the denial reason

**Known divergence (lcp-j3r)**: the synthetic `tool_call_id` on the
approval frame does NOT match the real `tool_call_id` the CLI eventually
emits on `tool_return_message` — UI correlation by tool_call_id will see
two unconnected items. The approval gate itself is keyed by `run_id`, so
gate resolution works correctly.

**Cache invariant**: a `Session` or `Forever` decision must NOT re-emit
an approval card on the next call to the same tool in the same
conversation. The shim short-circuits via the approval scope cache and
returns `behavior: "allow"` with no frame emission.

### 5. A2UI surface + non-approval user_action

Send an `a2ui_capability` negotiation in `hello`. After a turn that emits
an `<a2ui-json>` block in `assistant_message`, the shim splits it into a
synthetic `a2ui_frame` envelope. Mobile sends `user_action` with the
component's `action_id`; the shim records it to
`state/runs/<runId>/user-actions.jsonl` (recording-only contract, per
the `a2ui-phase-5-user-action-is-a-recording` memory).

### 6. Cancel mid-turn

```bash
# REST cancel
curl -X POST "http://<host>:<port>/v1/agents/<agentId>/messages/cancel"

# Mobile WS cancel
ws.send(JSON.stringify({ type: "cancel", run_id: "<runId>" }));
```

The SDK adapter calls `session.abort()` (the SDK's interrupt
control_request), mirroring the direct path's SIGTERM. The in-flight
turn should end with `turn_done` carrying `status:"failed"`
+ `error_code` reflecting cancellation. `/v1/runs/<runId>` should show
`status:"cancelled"`.

**Failure triage**: if the turn doesn't terminate within
`SHIM_POOL_TURN_TIMEOUT`, the watchdog forces another abort. If THAT
times out, check the CLI subprocess — `pgrep -f letta` should show no
orphan processes; if it does, the SDK's abort didn't reach the CLI.

### 7. Disconnect mid-turn → run finalizes to disk

Open a WS, start a turn, drop the socket (`ws.close()` or kill the
client). The in-flight turn must continue to disk:

- `state/runs/<runId>/frames.jsonl` keeps growing
- `state/runs/<runId>/run.json` ends up with `status:"completed"` (or
  `failed`/`timeout`)

This is the durable-execution invariant from
[`DURABLE_EXECUTION.md`](DURABLE_EXECUTION.md). The SDK adapter
preserves it because the pool keeps the adapter alive across WS
disconnects — `runTurn` is bound to the pool entry, not the socket.

### 8. Reconnect + replay from frames.jsonl

Reconnect over WS and send:

```json
{ "type": "subscribe", "run_id": "<runId>", "cursor": <seq> }
```

The shim replays frames from `state/runs/<runId>/frames.jsonl` starting
at `cursor` and ends with `subscribe_done` carrying the run's final
status. This is wire-shape-identical between direct and SDK transports
because frame replay reads from disk, not from the live adapter.

### 9. Conversation list after multiple turns

After running scenarios 1–3 several times for the same agent, hit:

```bash
curl "http://<host>:<port>/v1/conversations?agent_id=<agentId>"
```

Expected: one entry per real conversation, `last_message_at` reflecting
the actual latest message timestamp (NOT the Jan-1 sentinel — see
lcp-dfz for the `_real-times.json` substitution). The SDK path must not
introduce conversation fragmentation beyond what letta-code's
LocalBackend already does (see lcp-cm5; shim-side stability is verified
by `admin-shim/test/sdk-conversation-stability.test.ts`).

## Failure modes specific to the SDK path

| Symptom | Likely cause | Fix |
|---|---|---|
| `[pool] spawn failed transport=sdk` | `LETTA_CLI_PATH` doesn't exist or isn't executable. | Verify the path; the SDK also falls back to `require.resolve("@letta-ai/letta-code")`. |
| `WARN: SHIM_LETTA_TRANSPORT=sdk has no effect while SHIM_POOL_DISABLE=1` | Legacy per-request spawn is on. | Unset `SHIM_POOL_DISABLE`. |
| Turn hangs, no frames after `[sdk-adapter] started` | Mock CLI without the per-turn `local-run-<n>` patch will be filtered by `lastCompletedRunIds`. Real CLI generates fresh ids — if a real CLI exhibits this, set `DEBUG_SDK=1` and look for `discarding stale message`. | See lcp-sdk.8 and the per-turn run-id patch in `test/helpers/letta-mock.mjs`. |
| Approval card never appears for a tool call | `a2uiCapability == null` on the turn — `_handleCanUseTool` default-allows without emitting a frame. | Verify the WS `hello` carried an `a2ui_version`. |
| Synthetic `tool_call_id` doesn't match `tool_return_message` | Known divergence (lcp-j3r) — the SDK doesn't surface the CLI-side `tool_call_id` to `canUseTool`. | UI correlation by tool_call_id is degraded; approval gate (keyed by run_id) still works. |
| Conversation list shows a fresh entry per turn | Likely lcp-cm5 — letta-code's LocalBackend created a new conv. | Falls outside the shim's control surface; capture the on-disk dir layout for a follow-up. |

## Promotion checklist

- [ ] Scenarios 1–9 above run cleanly under `SHIM_LETTA_TRANSPORT=sdk`
- [ ] Pool log shows exactly `transport=sdk` for new turns
- [ ] `/v1/runs/<id>` shape matches the direct path (lcp-sdk.4)
- [ ] Approval card UX matches the direct path (mod lcp-j3r)
- [ ] Conversation list is stable across N turns on the same conv
- [ ] Rollback (`SHIM_LETTA_TRANSPORT=direct` + restart) verified once
