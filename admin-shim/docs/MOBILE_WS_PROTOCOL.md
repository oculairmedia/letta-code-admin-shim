# Mobile WebSocket Protocol — Reference

**Status:** Phase-1 (locked). Tests in `admin-shim/test/ws-protocol.test.ts`
defend every frame shape and lifecycle invariant called out below; cite the
test name when arguing whether a behavior is in or out of the contract.

**Audience:** a Kotlin developer wiring `ChannelTransport` for
letta-mobile against the admin-shim's `/shim/v1/mobile` WebSocket
endpoint. This doc is the wire-level contract; everything emitted by the
server is documented here verbatim and everything the client is allowed
to send is enumerated.

**Scope:** Phase-1 only — single device, foreground WS, no push, no
multi-channel routing, no resume cursor. Cancel + single-flight are the
only flow-control primitives. Reconciliation back to disk is via
`GET /v1/agents/{agent_id}/messages` after `turn_done`.

**Related docs:**

- `/opt/stacks/letta-code-parallel/docs/MOBILE_CHANNEL_DESIGN.md` — design
  rationale (why this exists, the multi-phase plan)
- `/opt/stacks/letta-code-parallel/admin-shim/docs/CHANNEL_PLUGINS.md` —
  the host-side contract for *authoring* channel plugins
- `/opt/stacks/letta-code-parallel/admin-shim/lib/types/wire.ts` — the
  TypeScript discriminated-union the frames marshal to/from
- `/opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/Message.kt`
  — Kotlin `LettaMessage` sealed interface (reuse, do not re-derive)

---

## 1. Connection

### URL

```
ws://<shim-host>:<port>/shim/v1/mobile
wss://<shim-host>/shim/v1/mobile     # behind TLS terminator
```

The shim listens on the same port as the HTTP API. WS upgrade requests
to any other path get a 404 (`server.ts:1060-1066`). If the mobile
channel plugin can't be loaded, the upgrade returns 503 — the channel is
disabled (no `accounts.json` or no enabled account); see
`mobile-channel-host.ts:300-304`.

The adapter is loaded *lazily on the first WS upgrade*, not at boot — so
the first `hello` may pay an extra few ms of import latency. Subsequent
connections reuse the cached adapter. Test:
`ws: shim logs \`mobile-channel adapter ready\` on first WS upgrade`.

### Auth: token in the `hello` frame

The token is sent **inside the first WebSocket frame**, not as a URL
query parameter and not as an HTTP header on the upgrade. The client
must send a `hello` frame as its very first message; any other frame
first earns `error{code: "protocol_violation"}` (defended by test
`ws: sending a non-hello frame first → error{protocol_violation}`).

The server validates the token via a constant-time string compare
(`ws-handler.mjs:43-51`). A mismatch produces
`error{code: "invalid_token"}` followed by a close — defended by
`ws: wrong token → error{invalid_token} and connection closes`.

The accepted token comes from the configured account; the shim reads
`config.tokenEnv` (env var name) first, falling back to
`config.tokenFallback` (literal string) — see `plugin.mjs:13-18`.

### Hello / welcome handshake

```
client → server: hello
server → client: welcome   (if auth OK)
                 error     (if auth bad)  ← followed by close
```

After `welcome`, the server starts a periodic `ping` timer
(`ws-handler.mjs:78-85`) and a 120 s idle timeout
(`ws-handler.mjs:69-76`). Any inbound frame resets the idle timer.

### Idle timeout & server pings

- **Server → client `ping`:** every `pingIntervalMs` (default 25 000;
  configurable per account in `accounts.json`). Test:
  `ws: server emits periodic ping frames` (overrides to 200 ms).
- **Server-side idle close:** 120 000 ms default. If no inbound frame
  for that long, the server closes with code 1000 and reason
  `idle timeout`. Configurable via `config.idleTimeoutMs`.
- **Client → server `pong`** is accepted but is **not required** to
  keep the connection alive; any inbound frame resets the idle timer.
  The server does not currently enforce pong roundtrips
  (`ws-handler.mjs:307-309`).

### Reconnect strategy (server_id-based cache invalidation)

The welcome frame carries a `server_id` (UUID), persisted to disk on
first boot and stable across restarts (`server.ts:108-128`). The same
id is returned by `GET /v1/health`:

```json
{ "version": "shim-0.2.0", "status": "ok",
  "server_id": "…uuid…", "server_started_at": "...",
  "backend": "letta-code-local",
  "capabilities": {
    "mobile_transport": {
      "mobile_ws": true,
      "ws_endpoint": "/shim/v1/mobile",
      "canonical_live_transport": "ws",
      "rest_role": "cold_start_reconcile_repair",
      "sse_role": "legacy_non_canonical_for_mobile_ws_sessions",
      "exclusivity": "after_ws_welcome_do_not_consume_sse_for_owned_conversations"
    }
  } }
```

Shim-aware clients that need a dedicated metadata endpoint can also read
`GET /shim/v1/capabilities`. Strict Python Letta backends do not expose the
mobile WS endpoint or these shim capability fields, so mobile can distinguish
REST+SSE-only servers before attempting the WS upgrade.

A client should:

1. On welcome, compare `welcome.server_id` to the cached value.
2. If it differs, treat all locally-cached agent / conversation / message
   state as belonging to a different universe and refetch from the REST
   surface before reconnecting business logic.
3. On disconnect (any code), reconnect with exponential backoff. The
   `welcome.server_id` is the authoritative cache key — *not* the
   underlying URL.

`session_id` (also in welcome) is generated fresh per connection
(`sess-<uuid>`) and used only for server-side logging. Clients should
not persist it.

---

## 2. Frame catalog

All frames share a base envelope:

```json
{
  "v": 1,
  "type": "<frame-type>",
  "id": "<uuid>",
  "ts": "2026-05-14T16:00:00.000Z",
  ...type-specific fields
}
```

- `v` is the protocol version (currently `1`). Future versions may add
  fields; receivers MUST ignore unknown fields (see
  `protocol.mjs:8-15`).
- `id` is a per-frame UUID generated by the sender — does **not** match
  any conversation/message id.
- `ts` is the sender's wall-clock at emit time. **Not** the same as the
  per-frame `date` field on `LettaMessage` variants, which is anchored
  to turn-start + per-type offset (see §4).

Receivers MUST silently ignore unknown frame `type` values (forward-compat
rule, defended by `ws: unknown frame types are ignored silently`).

### 2.1 Client → server frames

#### `hello`

First frame on every connection. Must arrive before anything else.

```json
{
  "v": 1, "type": "hello", "id": "…", "ts": "…",
  "token": "shared-secret-from-accounts.json",
  "device_id": "android-emanuel-pixel-7",
  "client_version": "letta-mobile/0.6.1 (android)",
  "a2ui_version": "0.9",
  "supported_catalogs": ["basic"],
  "supported_widgets": ["Text", "Button", "Card"],
  "theme_hints": { "color_scheme": "dark" }
}
```

The `a2ui_*` fields are optional. When present, they request dynamic UI mode
for this WS session. The server only negotiates A2UI when `A2UI_ENABLED=1`,
the requested version matches `A2UI_VERSION`, and the requested catalogs include
`A2UI_CATALOG_ID`. Non-A2UI clients omit these fields and keep the exact Phase-1
text/tool behavior.

A2UI version strings intentionally differ by layer: handshake and capability
frames use the shim-local form (`"0.9"`, no `v` prefix), while A2UI JSON
message envelopes inside `a2ui_frame.a2ui` use the upstream spec form
(`"v0.9"`).

- `token` — **required**. Constant-time matched. Wrong → `error{invalid_token}` + close (code 4000 with reason `invalid_token`).
- `device_id` — optional; if omitted, server assigns `anon-<uuid>`. The
  same id is echoed in `welcome.device_id`.
- `client_version` — optional; logged for telemetry only.
- `a2ui_version` — optional dynamic-UI request. Use the handshake form
  (`"0.9"`) here, not the envelope form (`"v0.9"`).
- `theme_hints` — optional A2UI styling hints for the model prompt. If it
  includes `primaryColor`, the shim only forwards strict 6-digit hex values
  matching `^#[0-9a-fA-F]{6}$`; invalid shorthand (`#FFF`), `rgba()`, or
  named colors are dropped and logged. `color_scheme` (`light` / `dark` /
  `system`) is a preference hint and does **not** map directly to
  `theme.primaryColor`.

Kotlin:

```kotlin
@Serializable
data class HelloFrame(
    val v: Int = 1,
    val type: String = "hello",
    val id: String,
    val ts: String,
    val token: String,
    @SerialName("device_id") val deviceId: String?,
    @SerialName("client_version") val clientVersion: String?,
)
```

#### `send_message`

Dispatch a user turn into the shim's worker pool. Triggers the full
turn lifecycle described in §5.

```json
{
  "v": 1, "type": "send_message", "id": "…", "ts": "…",
  "agent_id": "agent-597b5756-2915-4560-ba6b-91005f085166",
  "conversation_id": "conv-default-agent-597b5756-2915-4560-ba6b-91005f085166",
  "text": "reply with pong",
  "otid": "cm-android-d6f0e2c1"
}
```

- `agent_id` — **required**. Missing → `error{protocol_violation}`,
  socket stays open. Test: `ws: send_message with missing agent_id → error{protocol_violation}, no close`.
- `conversation_id` — **required**. Accepts both the internal form
  (`"default"`, `"conv-<uuid>"`) and the external form
  (`"conv-default-<agentId>"`). See §3 for resolver semantics.
- `text` — **required**, must be a string (empty is allowed by the wire
  contract but worker pool may reject upstream).
- `otid` — optional but strongly recommended. Round-tripped onto the
  disk projection so mobile's `reconcileAfterSend` can collapse the
  optimistic Local user bubble. See §4 contract 8 and §6.

Kotlin:

```kotlin
@Serializable
data class SendMessageFrame(
    val v: Int = 1,
    val type: String = "send_message",
    val id: String,
    val ts: String,
    @SerialName("agent_id") val agentId: String,
    @SerialName("conversation_id") val conversationId: String,
    val text: String,
    val otid: String? = null,
)
```

#### `cancel`

Cancel an in-flight turn. `run_id` is REQUIRED — the server does NOT
fall back to an implicit "current run" (lcp-bll removed that path).
Track the active run from `turn_started` + post-turn_started frames
and pass it explicitly.

- `ws: cancel with run_id flips the Run to cancelled` — happy path
- `ws: cancel without run_id → error{protocol_violation} (no implicit fallback)` — missing-id error

```json
{ "v": 1, "type": "cancel", "id": "…", "ts": "…",
  "run_id": "run-…" }
```

Outcomes:

- run is in-flight and known → server cancels; subsequent `turn_done`
  arrives with `status: "completed"` or `"cancelled"` depending on the
  race (the run record will land at `cancelled` or `completed`).
- run is unknown → `error{code: "run_not_found"}`, socket stays open.
- no `run_id` field → `error{protocol_violation}`, socket stays open
  (whether or not a turn is in flight).

Kotlin:

```kotlin
@Serializable
data class CancelFrame(
    val v: Int = 1,
    val type: String = "cancel",
    val id: String,
    val ts: String,
    @SerialName("run_id") val runId: String,
)
```

#### `bye`

Polite shutdown. The server replies with a clean WS close (code 1000,
reason `bye`). Test: `ws: client \`bye\` produces a 1000 close from the server`.

```json
{ "v": 1, "type": "bye", "id": "…", "ts": "…" }
```

#### `ack` (reserved)

Phase-1 logs and ignores (`ws-handler.mjs:304-306`). Phase-2 will wire
into the sync cursor. Currently safe to send but accomplishes nothing.

#### `pong`

Server-driven keepalive reply. Accepted; resets idle timer (any inbound
frame does). The server does **not** require `pong`s in Phase 1.

```json
{ "v": 1, "type": "pong", "id": "…", "ts": "…" }
```

#### `user_action`

A2UI v0.9 client→server action. Emitted by the renderer when the user
interacts with a surface (`Action.event` from the A2UI Basic Catalog —
e.g. a `ToolApprovalCard` choice). Only meaningful when A2UI was
negotiated in `hello`; non-A2UI clients should not emit this frame.
Only `Action` shapes carrying an `event` field map to `user_action`
frames for agent processing. `functionCall` actions are renderer-local —
handle them in the client without a WebSocket round-trip.

```json
{ "v": 1, "type": "user_action", "id": "…", "ts": "…",
  "run_id": "run-…",
  "turn_id": "turn-…",
  "surface_id": "approval-1",
  "name": "tool_approval_choice",
  "context": { "tool_call_id": "tcid-…", "scope": "once" },
  "action_id": "act-…" }
```

- `name` — **required**, non-empty. Matches `Action.event.name` from the
  surface. Free-form; agreed between agent and renderer.
- `context` — optional object. Mirrors `Action.event.context`. When
  present must be a JSON object (not array). Servers reject non-object
  values with `protocol_violation` and keep the socket open.
- `run_id` / `turn_id` / `surface_id` — optional but recommended for
  audit correlation. If `run_id` is omitted or `null`, the shim falls back
  to the most recent Run created on the same WebSocket session so real
  renderer actions from existing surfaces can still route back to the agent.
- `component_id` — optional widget/component id. When omitted, agents may
  still infer a component from `context.componentId`, `context.component_id`,
  or `context.id` if the renderer supplied one.
- `action_id` — optional client id for ack correlation. When omitted the
  shim mints `act-<ts>-<rand>` and echoes it in `user_action_ack`.

Outcome: server appends an entry to
`state/runs/<run_id>/user-actions.jsonl` (or `unbound-<session>/…` when
run_id is null) and replies with `user_action_ack`.

Routing:

1. `name: "tool_approval_choice"` first attempts to match a pending
   dispatcher approval gate. When it matches, `user_action_ack.routed_as`
   is `"approval"` and the gate receives the decision.
2. Any other action with a resolvable `run_id` — explicit or inferred from
   the session's most recent Run — is injected as a new agent turn on the
   same agent/conversation. `user_action_ack.routed_as` is `"synthetic_input"`.
3. Actions that cannot be routed remain audit-only with
   `user_action_ack.routed_as: "recorded_only"`.

The synthetic user message is plain text and intentionally machine-readable:

```text
[system: A2UI user action]
actionId: act-…
surfaceId: final-roundtrip-test-btn
componentId: primary-submit
event: a2ui.final.submit
context: {"componentId":"primary-submit","value":"confirmed"}
```

Agents should treat this as an A2UI event signal, not literal prose typed by
the user.

Errors:

- Missing `name` → `error{protocol_violation}`; socket stays open.
- `context` not an object → `error{protocol_violation}`; socket stays
  open.
- A2UI not negotiated for the session → `error{protocol_violation}`;
  socket stays open.
- Handler not wired (channel host built without `handleUserAction`) →
  `error{internal_error}`; socket stays open.

#### `subscribe`

Replay + live-tail a Run's frame log (lcp-p74.2). Used to *resume* a
turn after a network drop or app restart, and to *observe* a run that
was started by another client (e.g. cron-driven turns).

```json
{ "v": 1, "type": "subscribe", "id": "…", "ts": "…",
  "run_id": "run-…",
  "cursor": 0 }
```

- `run_id` — **required**, non-empty. Must reference a Run whose
  `state/runs/<id>/frames.jsonl` has been written at least once.
- `cursor` — optional. Number; the last `seq` the client has already
  received. The server emits only frames with `seq > cursor`. Omit (or
  send `0`) for a full replay from the start.

Server response sequence:

1. Replay phase. For each frame in `frames.jsonl` with `seq > cursor`,
   the server emits a `subscribe_frame` envelope (§2.2). Frames arrive
   in seq order; the client should treat each one as if it had just
   streamed live (it carries the same `message_type` as the original
   bridge frame).
2. Live-tail phase. Once the replay catches up, the server watches the
   frame log via `fs.watch` and forwards new appends as additional
   `subscribe_frame` envelopes.
3. Termination. When the Run reaches a terminal status
   (`completed` / `failed` / `cancelled` / `expired`) **and** the tail
   has caught up, the server emits a single `subscribe_done` envelope
   and stops watching.

Re-subscribing to a `run_id` you're already subscribed to *replaces*
the prior subscription (the server cancels the earlier watcher to
avoid double-emit on overlapping replays). Use a fresh `cursor` to
re-replay.

Errors:

- Missing or empty `run_id` → `error{protocol_violation}`; socket
  stays open.
- Frame log doesn't exist (unknown run id) →
  `error{run_not_found, message: "no frames recorded for run <id>"}`;
  socket stays open.
- File deleted/rotated mid-subscription → `error{internal_error}`,
  watcher is closed; client may re-subscribe with the last seen seq.

See §11 for the recommended reconnect-resume pattern.

#### `cron_list`

Request a snapshot of cron tasks. Optional `agent_id` / `conversation_id`
filters mirror `listTasks()` in `lib/crons.ts`. See §10 for the full
`CronTask` shape.

```json
{ "v": 1, "type": "cron_list", "id": "…", "ts": "…",
  "request_id": "req-1",
  "agent_id": "agent-597b…",
  "conversation_id": "default" }
```

- `request_id` — optional, echoed verbatim on `cron_list_response` for
  client-side correlation. The shim does not interpret it.
- `agent_id` — optional. Resolved through `resolveAgentIdAlias` before
  filtering (so legacy ids match the canonical row).
- `conversation_id` — optional. Exact match against persisted rows.

Reply: `cron_list_response`.

#### `cron_add`

Persist a new cron task. **Exactly one** of `cron` / `every` / `at` must
be set; the shim resolves the others. Validation is server-side
(`isValidCron` / `parseEvery` / `parseAt` from `lib/crons.ts`).

```json
{ "v": 1, "type": "cron_add", "id": "…", "ts": "…",
  "request_id": "req-2",
  "agent_id": "agent-597b…",
  "conversation_id": "default",
  "name": "morning-checkin",
  "description": "summarize overnight signals",
  "prompt": "What changed overnight in the inbox?",
  "recurring": true,
  "cron": "*/30 9-17 * * *",
  "timezone": "America/Toronto" }
```

- `agent_id` — **required**, non-empty. Resolved through alias map.
- `prompt` — **required**, non-empty. Wrapped in a `<system-reminder>`
  envelope at fire-time so the agent reads it as a scheduled prompt, not
  a user message (`wrapCronPrompt` in `lib/cron-scheduler.ts`).
- `name` — optional; defaults to `task-<ts>` when omitted. Free-form
  display label.
- `description` — optional; empty string when omitted. Free-form
  rendered alongside `name` in the agent's reminder envelope.
- `recurring` — optional. When `every` is set, forced to `true`. When
  `at` is set, forced to `false`. With raw `cron`, defaults to `true`
  unless the client explicitly sends `false`.
- `cron` — optional. Standard 5-field cron expression (minute, hour,
  day-of-month, month, day-of-week). Accepts `*`, `*/N`, ranges
  (`N-M`), and exact integers. See §10 for the validation grammar.
- `every` — optional shorthand. Accepts `Ns` / `Nm` / `Nh` / `Nd`
  (units accept long forms too: `seconds`/`minutes`/`hours`/`days`).
  Sub-minute is rounded up to 1m (the cron-floor) with a `warning`
  on the response. Non-divisor minute/hour intervals snap to the
  nearest clean divisor of 60/24 — the response carries a `note` field
  with the rounding rationale (e.g. `7h rounded to every 8h`).
- `at` — optional shorthand. Accepts `in <N>m`, `in <N>h`, or
  `H:MMam`/`H:MMpm`. Produces a one-shot with `scheduled_for` set.
- `timezone` — optional IANA tz string. Defaults to the host's
  `Intl.DateTimeFormat().resolvedOptions().timeZone`. Cron matching
  uses this tz, so `0 8 * * *` fires at 08:00 in the task's tz.
- `conversation_id` — optional. Defaults to `"default"`.

Reply: `cron_add_response` (success with `task`, or failure with `error`).

#### `cron_get`

Fetch one task by id.

```json
{ "v": 1, "type": "cron_get", "id": "…", "ts": "…",
  "request_id": "req-3",
  "task_id": "deadbeef" }
```

- `task_id` — **required**. The 8-hex-char id from a prior `cron_add_response.task.id`.

Reply: `cron_get_response` (success with `task`, or success=false with
`error: "task <id> not found"`).

#### `cron_delete`

Remove one task by id.

```json
{ "v": 1, "type": "cron_delete", "id": "…", "ts": "…",
  "request_id": "req-4",
  "task_id": "deadbeef" }
```

Reply: `cron_delete_response`. Triggers a `crons_updated` push on every
connected client (this socket included).

#### `cron_delete_all`

Remove every task belonging to one agent. Used by the "wipe schedules
for this agent" affordance.

```json
{ "v": 1, "type": "cron_delete_all", "id": "…", "ts": "…",
  "request_id": "req-5",
  "agent_id": "agent-597b…" }
```

- `agent_id` — **required**. Resolved through the alias map.

Reply: `cron_delete_all_response` with `count` (number of rows
removed). Triggers `crons_updated` push only when `count > 0`.

### 2.2 Server → client frames

Every server frame carries the base envelope (`v`, `type`, `id`, `ts`).
Type-specific fields below.

#### `welcome`

```json
{ "v": 1, "type": "welcome", "id": "…", "ts": "…",
  "server_id": "9c2d7e4f-…",
  "session_id": "sess-1f6c8a4d-…",
  "device_id": "android-emanuel-pixel-7",
  "canonical_live_transport": "ws",
  "transport_contract": {
    "mobile_ws": true,
    "ws_endpoint": "/shim/v1/mobile",
    "canonical_live_transport": "ws",
    "rest_role": "cold_start_reconcile_repair",
    "sse_role": "legacy_non_canonical_for_mobile_ws_sessions",
    "exclusivity": "after_ws_welcome_do_not_consume_sse_for_owned_conversations"
  },
  "a2ui_negotiated": true,
  "a2ui": { "version": "0.9", "catalog_id": "basic" } }
```

- `server_id` — universe cache key (see §1).
- `session_id` — server-assigned, `sess-<uuid>`. Logging only.
- `device_id` — echoes the client's `hello.device_id` (or the assigned
  `anon-<uuid>`).
- `canonical_live_transport` — currently always `"ws"` for this endpoint.
  After receiving `welcome`, mobile treats this WS session as the canonical
  live mutation source for conversations it owns.
- `transport_contract` — canonical mobile transport rule. REST remains for
  cold-start hydrate, post-turn reconciliation, and repair. SSE remains a
  legacy/non-canonical path and MUST NOT be consumed concurrently for
  conversations owned by this active WS session.
- `capabilities.mobile_transport` — same contract nested under a capability
  map for clients that prefer feature-style parsing.
- `a2ui_negotiated` — `true` only when the client requested A2UI in `hello`
  and the server accepted it for this session. Non-A2UI clients may ignore
  this field; current server frames include `false` when not negotiated.
- `a2ui` — negotiated A2UI version/catalog summary, or `null` when A2UI is
  not active for the session.
- `a2ui_rejection_reason` — present only when the client requested A2UI and
  negotiation failed. Current values are `disabled`, `version_mismatch`,
  `catalog_mismatch`, or `unsupported`.

Test: `ws: hello/welcome handshake — server_id, session_id, device_id in welcome`.
Test: `ws: hello can negotiate A2UI capability when server support is enabled`.

#### `a2ui_capabilities`

Emitted immediately after `welcome` only when A2UI was negotiated.

```json
{ "v": 1, "type": "a2ui_capabilities", "id": "…", "ts": "…",
  "version": "0.9",
  "catalog_id": "basic",
  "supported_catalogs": ["basic"],
  "supported_widgets": ["Text", "Button", "Card", "List", "TextField", "ChoicePicker"] }
```

This frame confirms the server-side A2UI contract for the session. Older
clients remain safe because unknown server frame types are ignored silently.
Like `hello.a2ui_version`, `version` uses the handshake/capability form
(`"0.9"`). A2UI message bodies carried later in `a2ui_frame.a2ui` still use
the upstream envelope form (`"v0.9"`).

#### `a2ui_frame`

A2UI v0.9 server→client message. Emitted only when A2UI was negotiated.
The shim parses `<a2ui-json>` blocks out of the assistant text stream
(`lib/a2ui-stream-splitter.ts`) and forwards each block as its own frame
ahead of `turn_done`. Conversational text around the blocks still flows
through `assistant_message` deltas — the renderer composes both.

```json
{ "v": 1, "type": "a2ui_frame", "id": "…", "ts": "…",
  "turn_id": "turn-…",
  "run_id": "run-…",
  "otid": "provider-assistant-…",
  "ok": true,
  "a2ui": {
    "version": "v0.9",
    "createSurface": { "surfaceId": "approval-1", "catalogId": "basic" }
  } }
```

- `ok` — `true` when JSON parse and structural validation succeeded.
  This means envelope-valid, not render-valid: renderer-side catalog/schema
  checks may still reject component trees, references, or per-widget props.
  When `false` the frame includes `parse_error` and/or `validation_error`
  diagnostic strings; the `a2ui` field may be `null` or a partially parsed
  value.
- `a2ui` — the parsed A2UI v0.9 message. Either a single message object
  (createSurface / updateComponents / updateDataModel / deleteSurface).
  Top-level arrays are rejected for upstream A2UI v0.9 interop; if a turn
  needs multiple A2UI messages, the model emits multiple adjacent
  `<a2ui-json>` blocks and the shim forwards one `a2ui_frame` per block.
  Its `version` field uses the upstream envelope form (`"v0.9"`), unlike
  the handshake/capability fields that use `"0.9"`.
- `otid` — echoes the otid of the assistant_message the block was carried
  in. Lets the renderer associate the A2UI surface with the bubble that
  introduced it.

Structural validator coverage (`validateA2uiMessage`):

- `version: "v0.9"` required at top level.
- Exactly one of `createSurface | updateComponents | updateDataModel | deleteSurface` present.
- All variants require a non-empty `surfaceId`.
- `createSurface` additionally requires a non-empty `catalogId`.
  During mobile negotiation the shim also rejects `createSurface.catalogId`
  values that do not match the negotiated catalog (`basic`). The embedded
  upstream Basic Catalog schema is rewritten in the prompt to use this same
  short wire slug, avoiding mixed URL-vs-slug catalog ids.
- `createSurface.sendDataModel: true` is rejected in this shim profile. The
  mobile `user_action` frame remains a recording/ack path and does not yet
  deliver full surface data models into the agent dispatcher, so accepting
  `sendDataModel` would make form submissions look successful while dropping
  values.
- `updateComponents` requires a non-empty `components` array; each entry
  must have a non-empty `id` and a non-empty `component` discriminator.

Deeper catalog-level validation (component property types, allowed enums)
runs in the renderer — keeping the shim's check structural keeps the
boundary clear when the v0.9 catalog evolves.

#### `user_action_ack`

Immediate receipt ack for a client `user_action` frame. It says the shim
accepted or rejected the frame for processing; the UI-facing result arrives in
the follow-up `user_action_outcome` frame.

```json
{ "v": 1, "type": "user_action_ack", "id": "…", "ts": "…",
  "action_id": "act-…",
  "status": "accepted",
  "routed_as": "synthetic_input" }
```

- `status` ∈ `"accepted" | "rejected"`. `"rejected"` adds a `reason`
  field describing the refusal (e.g. an unknown event name once the
  agent integration ships).
- `action_id` echoes the client-supplied id, or carries the
  server-minted id when the client omitted one.
- `routed_as` ∈ `"approval" | "synthetic_input" | "recorded_only"`
  when accepted. It is an observability hint; use `user_action_outcome` for
  user-visible state transitions.

#### `user_action_outcome`

UI-facing result for a client `user_action` frame. Emitted for every inbound
`user_action`, including validation failures that also produce an `error`
frame. Clients should log receipt as:
`A2UI: user_action_outcome received frameId=<id> outcome=<enum>`.

```json
{ "v": 1, "type": "user_action_outcome", "id": "…", "ts": "…",
  "frame_id": "client-frame-id",
  "action_id": "act-…",
  "outcome": "injected_as_input",
  "detail": {
    "action_id": "act-…",
    "routed_as": "synthetic_input",
    "synthetic_turn_id": "turn-…",
    "run_id": "run-…"
  } }
```

- `frame_id` correlates back to the originating `user_action` frame `id`.
  It may be `null` only for malformed/legacy clients that omit `id`.
- `action_id` echoes the action id when one exists.
- `outcome` ∈ `"matched_approval" | "injected_as_input" | "recorded_only" |
  "rejected" | "error"`.
- `detail.reason` is human-readable and safe to show for `rejected`/`error`.
  It must not contain stack traces.
- `detail.synthetic_turn_id` is present for `injected_as_input` once the
  synthetic agent turn has started.

Minimum client UI behavior:

- `matched_approval` — dismiss the surface or show a brief "decision recorded"
  state with the selected scope/context.
- `injected_as_input` — show a brief "sent"/spinner state and wait for the
  next agent turn to land in chat.
- `recorded_only` — show a subtle "recorded" caption; this is an audit-only
  action.
- `rejected` — show an error chip with `detail.reason` and keep the surface
  interactive for retry.
- `error` — show a generic error chip (using `detail.reason` if present) and
  keep the surface interactive for retry.

#### `error`

```json
{ "v": 1, "type": "error", "id": "…", "ts": "…",
  "code": "protocol_violation",
  "message": "send_message requires agent_id, conversation_id, text",
  "turn_id": "turn-…",
  "run_id": "run-…" }
```

- `code` — see §7 for the full catalog.
- `message` — human-readable, may be empty string.
- `turn_id` / `run_id` — present only for errors raised during a
  specific turn (e.g. `internal_error` mid-stream); see
  `ws-handler.mjs:276-282`.
- Whether the socket closes depends on `code` — see §7.

#### `ping`

```json
{ "v": 1, "type": "ping", "id": "…", "ts": "…" }
```

No payload. Treat as a keepalive heartbeat; reply with `pong` if
desired (not required Phase 1).

#### `turn_started`

```json
{ "v": 1, "type": "turn_started", "id": "…", "ts": "…",
  "agent_id": "agent-…",
  "conversation_id": "conv-default-agent-…",
  "turn_id": "turn-<uuid>" }
```

Always the **first** frame after a `send_message`. Carries `turn_id`
but **not yet** `run_id` — the worker pool creates the Run after
`turn_started` is emitted (`ws-handler.mjs:166-180`). Subsequent
frames carry both.

Tests:
- `ws: send_message → turn_started → assistant_message → stop_reason → usage → turn_done`
- `ws: turn_started includes agent_id, conversation_id, turn_id`

#### `reasoning_message`

```json
{ "v": 1, "type": "reasoning_message", "id": "…", "ts": "…",
  "agent_id": "agent-…", "conversation_id": "conv-default-agent-…",
  "turn_id": "turn-…", "run_id": "run-…",
  "reasoning": "thinking text…",
  "signature": null }
```

Mirrors `ReasoningMessage` in `wire.ts:114-122`. `signature` is `null`
unless the upstream model emits one.

There is **no fixture-based test** for `reasoning_message`; the smoke
mock doesn't emit reasoning frames. Test
`ws: reasoning_message forwarding` is marked `todo`. Observable only
with a real reasoning-capable model. Inner schema follows
`Message.kt` `ReasoningMessage`.

#### `tool_call_message`

```json
{ "v": 1, "type": "tool_call_message", "id": "…", "ts": "…",
  "agent_id": "agent-…", "conversation_id": "conv-default-…",
  "turn_id": "turn-…", "run_id": "run-…",
  "tool_call": {
    "tool_call_id": "tcid-abc123",
    "name": "Bash",
    "arguments": "{\"command\":\"echo hello\"}"
  },
  "tool_calls": [
    { "tool_call_id": "tcid-abc123", "name": "Bash",
      "arguments": "{\"command\":\"echo hello\"}" }
  ] }
```

- The shim emits **both** `tool_call` (legacy singular) **and**
  `tool_calls` (array form) with the same content
  (`mobile-channel-host.ts` → `chat.ts:316-326`).
- **The `id` field on the envelope is** `toolcall-${tool_call_id}` (NOT a
  random UUID). Locked contract — see §4.1.
- Inside the channel host, every raw `approval_request_message` from
  letta-code is remapped here (`reshapeFrame` in `chat.ts:302-327`).
  Mobile will rarely if ever observe a raw `approval_request_message`
  on the WS surface; treat it as a defensive case only.

Test: `ws: bash-tool trace yields a tool_call_message over the wire`.

#### `tool_return_message`

```json
{ "v": 1, "type": "tool_return_message", "id": "…", "ts": "…",
  "agent_id": "agent-…", "conversation_id": "conv-default-…",
  "turn_id": "turn-…", "run_id": "run-…",
  "tool_call_id": "tcid-abc123",
  "status": "success",
  "tool_return": "hello\n",
  "stdout": ["hello"],
  "stderr": null }
```

- `id` envelope = `toolreturn-${tool_call_id}` (chat.ts:340-342).
- `stdout` / `stderr` may be `string`, `string[]`, or `null`. Kotlin's
  `ToolReturnMessage` declares `List<String>?`; widen-to-tolerate.
- `status` defaults to `"success"`.

#### `approval_request_message`

Rare on the wire — see §4.1. The shape mirrors `tool_call_message` (same
inner `tool_call` / `tool_calls` shape). Treat exactly like a
`tool_call_message` if it ever appears.

#### `assistant_message`

```json
{ "v": 1, "type": "assistant_message", "id": "cm-stream-letta-msg-3", "ts": "…",
  "agent_id": "agent-…", "conversation_id": "conv-default-…",
  "turn_id": "turn-…", "run_id": "run-…", "seq": 17, "seq_id": 17,
  "content": "pong",
  "otid": "cm-android-d6f0e2c1" }
```

- **Pure-delta stream** (post-`lcp-cv3`): the shim does NOT coalesce
  server-side. Each frame's `content` carries only the newly-emitted
  tokens since the previous chunk. Chunks of the same logical message
  share the same envelope `id` (the `cm-stream-<otid>` prefix);
  consumers merge by `id` and concatenate in `seq` order. letta-code's
  underlying stream emits many partial chunks; the host stamps a stable
  per-otid id but forwards the deltas verbatim.
- `id` always carries the `cm-stream-` prefix — see §4.2.
- `seq` — the per-run frame-log cursor (`lcp-p74.2`). Monotonic across
  every WS frame for a given run; primary cursor for `subscribe(cursor)`
  replay.
- `seq_id` — alias of `seq` on `assistant_message` and `reasoning_message`
  frames (`lcp-pro`). Exposed under this name so the mobile client's
  existing `hasAlreadyIngestedStreamFrame` gate (which dedups by
  `seqId: Int?`) fires on the WS path without a mobile-side change.
  Strictly monotonic-increasing across the turn within one logical
  message id. Without this alias the gate is dead code on WS — every
  duplicate delta (reconnect replay, WS-vs-REST race) silently
  double-appends, producing incoherent text (the 2026-05-19 repro).
  Other frame types omit `seq_id`; the merge gate only applies to
  delta-shaped assistant/reasoning frames.
- `otid` is the **echo of the client's send_message.otid** (when
  present) so mobile can collapse stream-vs-disk twins via
  `dedupeOptimisticContentTwins`.

Test: `ws: assistant_message chunks concatenate to the full reply (lcp-cv3 streaming)`.
Test: `ws: assistant_message chunks carry monotonic seq_id (lcp-pro dedup bridge)`.

#### `stop_reason`

```json
{ "v": 1, "type": "stop_reason", "id": "…", "ts": "…",
  "turn_id": "turn-…", "run_id": "run-…",
  "stop_reason": "end_turn" }
```

- `reason` is one of `"end_turn"`, `"requires_approval"`, `"error"`,
  `"max_steps"`, etc.
- This is the **WS-envelope shape** for stop_reason. The inner field is
  the same `stop_reason:` name used by the REST/SSE path and Kotlin's
  `StopReasonMessage` — the WS handler just adds the `turn_id` / `run_id`
  routing fields. Kotlin clients can deserialize the `stop_reason:` field
  directly with `StopReason.serializer()`. See §4.7.

Test: `ws: stop_reason frame carries stop_reason field (\`end_turn\` on clean turn)`.

#### `usage_statistics`

```json
{ "v": 1, "type": "usage_statistics", "id": "…", "ts": "…",
  "turn_id": "turn-…", "run_id": "run-…",
  "prompt_tokens": 1234,
  "completion_tokens": 56,
  "total_tokens": 1290,
  "cached_input_tokens": 0,
  "reasoning_tokens": 0 }
```

- All numeric counters default to 0 if upstream omits them.
- Locked contract: this is the **first** `usage_statistics` of the
  turn. Multi-step turns may produce per-step usage, but the run-level
  record (and the WS frame) reflects the first. See §4.4.

#### `turn_done`

```json
{ "v": 1, "type": "turn_done", "id": "…", "ts": "…",
  "turn_id": "turn-…", "run_id": "run-…",
  "status": "completed" }
```

- Always the **last** frame of a turn, emitted **after**
  `stop_reason` + `usage_statistics`.
- The server emits this **after** `bridgeSendMessage` settles, which
  means `stampNewMessages` and `writeOtidForLocalId` have already
  run. Mobile may safely `GET /messages` for reconciliation as soon
  as `turn_done` lands. See §4.7.
- `status` ∈ `"completed" | "cancelled" | "failed"`. Tests assert
  `"completed"` on the clean-turn path.

Tests:
- `ws: turn_done follows stop_reason (post-stamp sentinel)`
- `ws: every post-turn_started frame carries run_id`

#### `subscribe_frame`

A single replayed (or live-tailed) entry from a Run's `frames.jsonl`.
Emitted in response to `subscribe`; one envelope per frame in seq order.

```json
{ "v": 1, "type": "subscribe_frame", "id": "…", "ts": "…",
  "run_id": "run-…",
  "seq": 17,
  "frame": { "message_type": "assistant_message", "content": "…", "run_id": "run-…" } }
```

- `seq` — the cursor value to remember; on reconnect, pass `cursor: seq`
  to resume after this frame.
- `frame` — the original `BridgeFrame` shape the host emitted at write
  time. The same `message_type` discriminator the client uses for live
  frames applies here verbatim — the renderer should not need a
  different code path for replayed vs live frames.

Replayed frames carry the original `run_id` / `turn_id` and any
type-specific fields (`content`, `tool_call`, `reasoning`, etc.).
The wrapping envelope's `id` / `ts` are fresh for each subscribe
emission; the inner `frame` payload is whatever was recorded.

#### `subscribe_done`

Terminal envelope for a subscription. Emitted once the Run reaches a
terminal status (`completed` / `failed` / `cancelled` / `expired`) AND
the live-tail has caught up to the final frame.

```json
{ "v": 1, "type": "subscribe_done", "id": "…", "ts": "…",
  "run_id": "run-…",
  "last_seq": 42,
  "status": "completed" }
```

- `last_seq` — the largest `seq` the server emitted on this
  subscription. Persist this if you plan to subscribe to the same Run
  later (rare; usually a terminal subscription is the final word).
- `status` — the Run's terminal status. Mirrors `run.status` from
  `/v1/runs/{id}`.

After `subscribe_done` the server stops watching the frame log. The
client may still send a fresh `subscribe` for the same run if needed
(e.g. to fetch the full transcript for a "view history" affordance).

#### `cron_list_response`

Reply to `cron_list`. See §10 for the `CronTask` shape.

```json
{ "v": 1, "type": "cron_list_response", "id": "…", "ts": "…",
  "request_id": "req-1",
  "success": true,
  "tasks": [ /* CronTask[] */ ] }
```

- `request_id` — echoes the request's value (or `null` if the client omitted it).
- `success` — always `true` on the read path. Failures surface as a
  generic server-side internal error and the response carries
  `success: false, error: <msg>`.
- `tasks` — array; empty when the filters match nothing.

#### `cron_add_response`

Reply to `cron_add`.

```json
{ "v": 1, "type": "cron_add_response", "id": "…", "ts": "…",
  "request_id": "req-2",
  "success": true,
  "task": { /* CronTask, see §10 */ },
  "warning": "No letta server is currently running. This task will only execute when a WS listener is active." }
```

- `success: true` — `task` is the persisted row (use `task.id` for
  subsequent `cron_get` / `cron_delete`). `warning` is present only
  when the file was missing a live scheduler at write-time. With
  `SHIM_CRON_ENABLED=1` (default) this warning is essentially never
  observed in production — included for parity with the bundled letta
  CLI when running outside the shim.
- `success: false` — `error` carries the validation reason. Possible
  values: `"agent_id is required"`, `"prompt is required"`, `"one of
  \`cron\`, \`every\`, or \`at\` is required"`, `"exactly one of
  \`cron\`, \`every\`, or \`at\` may be set"`, `"invalid cron
  expression: <expr>"`, `"invalid every: <expr>"`, `"invalid at:
  <expr>"`, `"Agent <id> has <N> active tasks (max <cap>)…"`.

#### `cron_get_response`

```json
{ "v": 1, "type": "cron_get_response", "id": "…", "ts": "…",
  "request_id": "req-3",
  "success": true,
  "task": { /* CronTask */ } }
```

- `success: false` with `error: "task <id> not found"` when the id
  doesn't resolve. The 404 model carries through the WS envelope
  rather than as a separate `error` frame — the socket stays open.

#### `cron_delete_response`

```json
{ "v": 1, "type": "cron_delete_response", "id": "…", "ts": "…",
  "request_id": "req-4",
  "success": true }
```

- `success: false` with `error: "task <id> not found"` when the id is
  unknown. No `task` is returned.

#### `cron_delete_all_response`

```json
{ "v": 1, "type": "cron_delete_all_response", "id": "…", "ts": "…",
  "request_id": "req-5",
  "success": true,
  "count": 3 }
```

- `count` — number of rows removed. `0` is a valid success (the agent
  had no scheduled tasks). `crons_updated` is broadcast only when
  `count > 0`.

#### `crons_updated`

Server push emitted whenever the underlying `crons.json` changes —
mutations from this socket, mutations from a peer socket, scheduler
ticks that fired a task, and external writes (e.g. the agent calls its
own self-schedule skill via the bundled letta-code CLI).

```json
{ "v": 1, "type": "crons_updated", "id": "…", "ts": "…",
  "reason": "client_mutation",
  "tasks_active": 2,
  "at": "2026-05-19T01:23:45.678Z" }
```

- `reason` ∈
  - `"client_mutation"` — a WS client called `cron_add` / `cron_delete`
    / `cron_delete_all` on this shim (broadcast immediately, no
    fs.watch debounce);
  - `"scheduler_write"` — the scheduler's tick fired a task and updated
    its row (`fire_count`, `last_fired_at`, or terminal status);
  - `"external_write"` — the file mtime changed and our scheduler
    didn't cause it; almost always the bundled `letta cron`
    CLI or the agent's self-schedule skill writing the file (≤200ms
    after the write — fs.watch debounce window);
  - `"scheduler_started"` / `"scheduler_stopped"` — emitted on the
    socket immediately when this shim claims or releases the scheduler
    lease. Useful for surfacing "scheduler offline" state if you have
    multiple shim instances and only one holds the lease.
- `tasks_active` — current count of rows with `status: "active"`, read
  fresh at push time. Treat as an authoritative cap for any list
  rendering — it can differ from the cached list you last fetched.
- `at` — when the event was emitted, server-side ISO timestamp.

This frame is broadcast to **every** authenticated socket. Filter
client-side if your UI scopes by agent.

Subscription is automatic at hello-accept time and lasts for the
lifetime of the WS connection (`ws-handler.mjs` registers via
`host.subscribeCronEvents`, unsubscribes in `stopAll`).

#### Sealed-class strategy

Mobile already deserializes the *inner* LettaMessage variants via
`Message.kt LettaMessageSerializer`. For WS envelopes, add a thin
wrapper sealed interface that owns `v` / `id` / `ts` / `type` plus the
WS-specific `run_id` / `turn_id` fields, and either embeds a
`LettaMessage` payload (for `assistant_message`, `reasoning_message`,
`tool_call_message`, `tool_return_message`) or carries WS-only fields
directly (`welcome`, `error`, `ping`, `turn_started`, `stop_reason`,
`usage_statistics`, `turn_done`). Use `JsonContentPolymorphicSerializer`
keyed on `type` — same pattern as `LettaMessageSerializer`. See the
starter kit in §8 for an end-to-end skeleton.

---

## 3. Conversation IDs

There are two valid forms for `send_message.conversation_id`:

| Form | Example | When to send |
|------|---------|--------------|
| **Internal** | `"default"`, `"conv-9c4f…"` | When you already hold the canonical conv id from `GET /v1/conversations/{id}`. |
| **External default** | `"conv-default-agent-597b5756-…"` | Synthesized by the shim's conversation list endpoint; the *only* form that uniquely identifies an agent's default thread. |

The shim resolves both via `resolveConversationId`
(`store.ts:280-292`):

1. Empty → null (rejected).
2. **Bare literal `"default"`** → **null (refused)**. Every agent has
   its own default conv, so the id alone is ambiguous; disk-scanning
   would silently route to whichever agent's conv we find first.
3. Pattern `conv-default-<agentId>` → returns `{conversationId: "default", agentId}`.
4. Else: disk-scan, return the matching `(conv.id, conv.agent_id)`
   pair if found; null otherwise.

When the resolver returns a value, the bridge uses **the resolver's
agent_id over the client's agent_id** — the disk record wins because
it knows who owns the conv. When the resolver returns null, the bridge
falls back to the client's `(agent_id, conversation_id)` so the worker
pool can still target a fresh conv on a freshly created agent
(`mobile-channel-host.ts:121-133`).

**Multi-agent defaults are routed by client agent_id, not disk scan.**
A client may send `conversation_id: "default"` and rely on the
`agent_id` field to disambiguate; the bridge passes both pairs through
the resolver but treats the client's `agent_id` as authoritative when
the resolver refuses. Test:
`ws: literal \`default\` conv id with multiple agents routes to the CLIENT-supplied agent, not the first-on-disk`.

Practical implication for the client: **prefer the external form**
(`conv-default-<agentId>`) on every `send_message`. It works
identically over WS and REST, eliminates the ambiguity above, and
matches what the conversation-list endpoint already hands back to you.

---

## 4. Locked behavioral contracts

These are pinned-in-place quirks. They have tests. Do not regress them.

### 4.1 `approval_request_message` → `tool_call_message` remap

letta-code's raw stream emits `approval_request_message` for **every**
tool call (whether approval is required or not). `reshapeFrame`
rewrites them to `tool_call_message` with `id = toolcall-${tool_call_id}`
before they reach the wire (`chat.ts:302-327`).

- **The contract:** Mobile MUST treat `tool_call_message` and
  `approval_request_message` as interchangeable for *display*
  purposes, and MUST key its `distinctBy { id }` dedup on the
  `toolcall-` prefix.
- **Defended by:** `ws: bash-tool trace yields a tool_call_message over the wire`
  (asserts `tcs.length == 1` and `tool_call.name == "Bash"`).
- **Client implementer:** receive `tool_call_message`; the
  `id` will already be `toolcall-…`; do not strip or modify the
  prefix.

### 4.2 `cm-stream-` prefix on streamed `assistant_message` ids

`tagAsOptimistic` in `chat.ts:129-145` rewrites every streamed
`assistant_message.id` to `cm-stream-${original}`. This flags it as
optimistic for mobile's `dedupeOptimisticContentTwins`, which collapses
adjacent same-content messages when ≥1 side has a `cm-` / `client-`
prefix (no `toolCalls`).

`tool_call_message` and `tool_return_message` ids are **NOT** prefixed
— their `toolcall-` / `toolreturn-` ids are already stable across
stream and disk, so strict-id dedup handles them.

- **The contract:** `cm-stream-` on stream-side assistant_message;
  bare stable id on the disk projection (which mobile fetches via
  GET after `turn_done`). Mobile's dedupe is content-based for
  assistant messages, id-based for tool messages.
- **Defended by:** the cross-side dedup is exercised by mobile's own
  unit tests; on the shim side, see `chat.test.ts` (general suite). No
  ws-protocol.test.ts entry asserts the prefix directly — read
  `chat.ts:129-145` for the rule.
- **Client implementer:** don't strip the prefix. Let mobile's
  existing `dedupeOptimisticContentTwins` collapse it.

### 4.3 Per-type ms offsets on `date`

Both the stream emit and the disk projection write `date` as
`turnStartedAt + offset` where offset is:

| Type | Offset (ms) |
|------|-------------|
| `user_message` | 0 |
| `ping` | 0 |
| `reasoning_message` | 10 |
| `tool_call_message` | 20 |
| `tool_return_message` | 30 |
| `assistant_message` | 40 |
| anything else | 50 (passthrough) |

This guarantees deterministic sort across stream + refetch *regardless
of which dedup winner wins*. Source: `chat.ts:517-531` (stream) and
`translate.ts` (disk). The same schedule lives in
`MEMORY.md/project_shim_timestamp_offsets.md`.

- **The contract:** `date` does not carry a wall-clock time. Do not
  show it. For relative time display, use `ts` (the WS envelope) or
  the disk-fetched `created_at` from `Conversation`.
- **Defended by:** indirectly — the `wire.ts` JSDoc states the
  contract; cross-side ordering is tested by the mobile dedup tests.
- **Client implementer:** sort by `date` for stable in-turn ordering
  but display `ts` or other real timestamps to the user.

### 4.4 First-frame `usage`, first-step `stop_reason`

The run-level record captured by `runs.ts finalizeRun`
(`mobile-channel-host.ts` does not directly emit, but the bridge
flows into it) uses:

- `usage` = first `usage_statistics` frame of the turn (NOT a sum)
- `stop_reason` = FIRST step's stop_reason (so a bash turn can show
  `status: "completed"` together with `stop_reason: "requires_approval"`)

The WS surface inherits both: the `usage_statistics` and `stop_reason`
frames you see are the first-step values.

- **Defended by:** locked contracts §4–5 in `wire.ts` banner;
  `runs.test.mjs` (REST suite, not WS).
- **Client implementer:** don't try to sum multiple `usage_statistics`
  frames per turn; trust the first.

### 4.5 `turn_done` after disk-stamp

`turn_done` is emitted **after** `bridgeSendMessage` settles
(`ws-handler.mjs:260-269`), which means:

1. The worker pool has finished writing `messages.jsonl`.
2. `stampNewMessages` has written the real-timestamp sidecar
   (`_real-times.json`).
3. `writeOtidForLocalId` has written the otid sidecar
   (`_otid-map.json`) IF the client supplied `otid`.

This means a GET against `/v1/agents/{agent_id}/messages?conversation_id=…`
issued *immediately* after `turn_done` will see the user_message with
the round-tripped otid and the assistant_message with stable ids and
real(-ish, per §4.3) dates.

- **Defended by:** `ws: turn_done follows stop_reason (post-stamp sentinel)`.
- **Client implementer:** wait for `turn_done` (not `stop_reason`)
  before refetching for reconciliation.

### 4.6 Single-flight per WS session

While a turn is in flight (`inFlight = true` between `send_message`
acceptance and `turn_done`), a second `send_message` on the same
socket earns `error{protocol_violation}` **without** closing the
socket. The original turn continues to completion. Cancel is the only
way to abort a turn from the same socket.

- **Defended by:** `ws: second send_message during in-flight turn → error{protocol_violation}, first completes`.
- **Client implementer:** maintain an `inFlight` flag mirroring the
  server. Queue or reject local sends accordingly. See the §8 Kotlin
  starter for a guard.

### 4.7 Bare-envelope shape for `stop_reason` / `usage_statistics`

The shim's REST/SSE path emits these two frame types in a **bare**
shape (no `LettaMessageBase` envelope; no `id`, no `date`,
no `otid`). The WS handler wraps them with `turn_id` / `run_id` for
routing but keeps the inner field names byte-identical to the REST/SSE
surface. Specifically the WS frame for `stop_reason` uses `stop_reason:`
(matching Kotlin's `StopReasonMessage` and the REST/SSE emit):

```json
{ "v": 1, "type": "stop_reason", "turn_id": "...", "run_id": "...",
  "stop_reason": "end_turn" }
```

The SSE-emitted bare shape:

```json
{ "message_type": "stop_reason", "stop_reason": "end_turn" }
```

- **The contract:** the WS envelope carries `type: "stop_reason"` for
  routing plus an inner `stop_reason:` payload field. Kotlin clients
  can reuse `StopReason.serializer()` directly on the WS payload
  (only the outer envelope is WS-specific).
- **Defended by:** `ws: stop_reason frame carries stop_reason field`.
- **Client implementer:** keep the WS envelope (`type`, `turn_id`,
  `run_id`) distinct from the inner LettaMessage union, but the inner
  fields match.

### 4.8 `otid` round-trip

The client sends `otid` on `send_message`. The shim does:

1. Run the turn through the worker pool.
2. Locate the user_message just persisted via
   `findUnmappedTailUserMessageId` (`store.ts:408-416`).
3. Write `{localId: otid}` to `_otid-map.json` sidecar
   (`writeOtidForLocalId`, `store.ts:380-399`).
4. On a future `GET /v1/agents/{id}/messages`, the disk projection
   reads the sidecar and substitutes the otid onto the projected
   `user_message.otid` (`translate.ts:341-389`).

Mobile's `reconcileAfterSend` matches `it.otid == sent_otid` on the GET
response and swaps the local optimistic bubble for the confirmed one.

Without `otid` from the client → no sidecar → no echo → user sees both
the optimistic Local bubble AND the disk-fetched confirmed copy. Two
prompt bubbles, side by side.

- **The contract:** clients SHOULD send `otid` on every
  `send_message`. Format is opaque but the `cm-` / `client-` prefix is
  required for mobile's own dedup branch — use `cm-android-<uuid>` or
  similar.
- **Defended by:** `ws: otid in send_message propagates to disk sidecar via the otid bind`,
  `ws: external conv id (conv-default-<agentId>) resolves like SSE — otid sidecar lands at the internal key`.
- **Client implementer:** generate `cm-<...>` otids, send on every
  message, expect them back on the GET projection.

---

## 5. Lifecycle sequence diagrams (ASCII)

### 5.1 Happy-path turn

```
Client                                    Shim
  │                                         │
  │ ─ WS open ─────────────────────────────►│
  │                                         │
  │ ─► { hello, token, device_id }          │
  │                                         │
  │ ◄─ { welcome, server_id, session_id }   │
  │                                         │
  │ ─► { send_message, agent_id, conv_id,   │
  │       text, otid:"cm-android-abc" }     │
  │                                         │
  │ ◄─ { turn_started, turn_id }            │ <- no run_id yet
  │                                         │
  │ ◄─ { tool_call_message, run_id, ... }   │ <- run_id appears
  │ ◄─ { tool_return_message, run_id }      │
  │ ◄─ { assistant_message, content,        │
  │       id:"cm-stream-...", otid }        │
  │ ◄─ { stop_reason:"end_turn" }           │
  │ ◄─ { usage_statistics, prompt_tokens... }│
  │ ◄─ { turn_done, status:"completed" }    │ <- disk stamped
  │                                         │
  │ ─ GET /v1/agents/X/messages ───────────►│  reconcile via otid
  │ ◄────────────────── 200 OK              │
  │                                         │
  │ ◄─ { ping }  (every 25s)                │
```

### 5.2 Cancel mid-turn

```
Client                                    Shim
  │ ─► { send_message, ... }                │
  │ ◄─ { turn_started, turn_id }            │
  │ ◄─ { reasoning_message, run_id }        │ <- captures run_id
  │ ◄─ { assistant_message (partial chunk) }│
  │                                         │
  │ ─► { cancel, run_id }                   │
  │                                         │
  │ ◄─ { stop_reason:"cancelled" }          │ (may race; could be "end_turn")
  │ ◄─ { usage_statistics }                 │
  │ ◄─ { turn_done, status:"cancelled" }    │ (or "completed", race)
  │                                         │
  │ ─ GET /v1/runs/{run_id} ────────────────►│ status: "cancelled" | "completed"
```

Test asserts the run status settles to `"cancelled"` OR `"completed"`
because the cancel may race with stamp-and-emit (`ws-protocol.test.ts`
test 10).

### 5.3 Single-flight rejection

```
Client                                    Shim
  │ ─► { send_message #1, otid:"cm-1" }     │
  │ ◄─ { turn_started, turn_id:"T1" }       │  inFlight=true
  │ ◄─ { reasoning_message }                │
  │                                         │
  │ ─► { send_message #2, otid:"cm-2" }     │ ← while #1 still running
  │ ◄─ { error, code:"protocol_violation",  │
  │       message:"another send_message     │
  │       is in flight on this session" }   │  socket NOT closed
  │                                         │
  │ ◄─ { assistant_message (from #1) }      │
  │ ◄─ { stop_reason }                      │
  │ ◄─ { usage_statistics }                 │
  │ ◄─ { turn_done }                        │  inFlight=false
  │                                         │
  │ ─► { send_message #3, otid:"cm-3" }     │  ← now accepted
  │ ◄─ { turn_started, turn_id:"T3" }       │
```

### 5.4 Reconnect after server_id change

```
Client                                    Shim (instance A)
  │ ◄─ { welcome, server_id:"A-uuid" }      │
  │ ... normal traffic ...                  │
  │ ◄─ close (any reason)                   │
  │                                         │
  │ <reconnect with backoff>                │
  │                                         │
Client                                    Shim (instance B, restarted)
  │ ─► { hello }                            │
  │ ◄─ { welcome, server_id:"B-uuid" }      │
  │                                         │
  │ if (B-uuid != cached "A-uuid"):         │
  │   invalidate all caches                 │
  │   refetch agents, blocks, models, ...   │
```

The `server_id` is persisted to disk on the shim (`.shim-server-id`),
so it survives a normal restart. It only changes when the state
directory is wiped or the shim is reinitialized fresh. Read
`server.ts:108-128`.

---

## 6. Reconciliation pattern

After every `turn_done`, the client SHOULD refetch the messages for
the conversation to reconcile its optimistic state. The shim writes
disk-side state inside `bridgeSendMessage` before `turn_done` is
emitted (§4.5), so the GET is race-free.

Request:

```
GET /v1/agents/{agent_id}/messages
    ?conversation_id=conv-default-<agentId>
    [&limit=50]
    [&before=<lettaMsgId>]
```

The response is a JSON array of `LettaMessage` items (the disk
projection in `translate.ts`). Notable fields:

- `user_message.otid` — echoes the `otid` the client sent on
  `send_message`, BUT ONLY for messages bound via the sidecar. Any
  other user message has `otid == localMsg.id` (a fallback that won't
  match the client's optimistic id; that's the intended signal "I
  didn't originate this").
- `assistant_message.id` — stable letta-msg-N id, NO `cm-stream-`
  prefix. Mobile's `dedupeOptimisticContentTwins` collapses
  `cm-stream-<x>` from the stream against the bare `<x>` from the
  disk on content+role match.
- `tool_call_message.id` — `toolcall-<tool_call_id>`. Identical to the
  stream-side id, so mobile's `distinctBy { id }` collapses them.
- `tool_return_message.id` — `toolreturn-<tool_call_id>`. Same.

The flow:

```
turn_done arrives ──► GET /v1/agents/X/messages ──► dedup pipeline:
                                                      1. distinctBy { id }
                                                      2. dedupeOptimisticContentTwins
                                                      3. sort by date
```

The dedup pipeline is exhaustively documented in
`MEMORY.md/reference_mobile_dedup_pipeline.md`.

---

## 7. Error codes

All `error` frames carry `code` (a stable enum) and `message`
(human-readable). Sometimes `turn_id` / `run_id` if the error
originated mid-turn.

| Code | Meaning | Socket closes? | When emitted | Suggested client action |
|------|---------|----------------|--------------|-------------------------|
| `invalid_token` | `hello.token` mismatch. | **Yes** (code 4000) | Authentication. | Stop reconnecting — token is wrong. Surface to UI. |
| `protocol_violation` | Frame malformed; missing required field (incl. `cancel.run_id`); wrong order; single-flight collision; unparseable JSON; pre-hello frame. | **Depends** — auth-time violations close (e.g. non-hello first), runtime violations do NOT (single-flight, missing send_message fields, missing cancel run_id). See `ws-handler.mjs:93-98` (`close = true` default) and the call sites overriding `close: false`. | Anywhere. | Fix the bug; do not retry blindly. |
| `agent_not_found` | (declared in `ERROR_CODES`, not currently emitted) | No (if/when added) | Bridge bound to non-existent agent. | Refetch agent list. |
| `conversation_not_found` | (declared, not currently emitted) | No (if/when added) | Bridge bound to non-existent conv. | Refetch conversations. |
| `run_not_found` | `cancel` referenced a `run_id` the host doesn't recognize as active. | **No** | On cancel. | Drop the cancel; the run already ended. |
| `internal_error` | Unhandled exception inside `bridgeSendMessage`. | **No** (frame includes `turn_id` / `run_id`). | Mid-turn. | Show "turn failed"; user may retry. |

**Important close-vs-don't-close distinction:** the shim's
`sendError(code, msg, {close: false})` is the runtime-safe path used
for validation errors during normal operation. The defaulting
`sendError(code, msg)` (close=true) is only used during the
hello/auth phase. Test
`ws: send_message with missing agent_id → error{protocol_violation}, no close`
and `ws: cancel without run_id → error{protocol_violation} (no implicit fallback)` both confirm the soft-error behavior.

The close code on auth failure is `4000` (application-defined; not the
WS standard `1008`) with the error code as the reason string. The
close code on `bye` / idle / server-side `bye` is the WS-standard
`1000`.

---

## 8. Kotlin starter kit

A minimal Ktor client skeleton. Reuses `LettaMessage` and its sub-types
from `Message.kt`.

### Ktor WS connection

```kotlin
import io.ktor.client.*
import io.ktor.client.plugins.websocket.*
import io.ktor.serialization.kotlinx.*
import io.ktor.websocket.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.Json
import java.util.UUID

class MobileChannelTransport(
    private val baseUrl: String,           // "wss://shim.example/shim/v1/mobile"
    private val token: String,
    private val deviceId: String,
    private val clientVersion: String,
    private val onEvent: (ServerFrame) -> Unit,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val client = HttpClient { install(WebSockets) { contentConverter = KotlinxWebsocketSerializationConverter(json) } }
    private val outbound = Channel<ClientFrame>(capacity = Channel.UNLIMITED)
    private var session: ClientWebSocketSession? = null

    // Single-flight guard mirroring the server's behavior.
    @Volatile private var inFlight: Boolean = false
    @Volatile private var currentRunId: String? = null

    suspend fun connect() = withContext(Dispatchers.IO) {
        client.webSocket(baseUrl) {
            session = this
            send(envelope("hello", buildJson {
                put("token", token); put("device_id", deviceId); put("client_version", clientVersion)
            }))
            // Outbound pump.
            launch { for (frame in outbound) send(frame.toWsFrame(json)) }
            // Inbound pump.
            for (frame in incoming) {
                val obj = (frame as? Frame.Text)?.readText() ?: continue
                val parsed = json.parseToJsonElement(obj).jsonObject
                when (parsed["type"]?.jsonPrimitive?.content) {
                    "welcome" -> dispatch(parsed)
                    "turn_started" -> dispatch(parsed)
                    "stop_reason", "usage_statistics", "turn_done", "ping", "error" -> dispatch(parsed)
                    "assistant_message", "reasoning_message",
                    "tool_call_message", "tool_return_message" -> {
                        dispatch(parsed)
                        // capture run_id from first non-turn_started frame
                        if (currentRunId == null) {
                            currentRunId = parsed["run_id"]?.jsonPrimitive?.contentOrNull
                        }
                    }
                    else -> { /* unknown — ignore per forward-compat rule */ }
                }
                if (parsed["type"]?.jsonPrimitive?.content == "turn_done") {
                    inFlight = false; currentRunId = null
                }
            }
        }
    }

    /** Send a user turn. Returns false if a turn is already in-flight. */
    fun trySend(agentId: String, conversationId: String, text: String, otid: String) : Boolean {
        if (inFlight) return false       // matches server-side single-flight
        inFlight = true
        outbound.trySend(SendMessageFrame(
            id = UUID.randomUUID().toString(),
            ts = nowIso(),
            agentId = agentId, conversationId = conversationId,
            text = text, otid = otid,
        ))
        return true
    }

    fun cancel() {
        val rid = currentRunId ?: return
        outbound.trySend(CancelFrame(
            id = UUID.randomUUID().toString(),
            ts = nowIso(),
            runId = rid,
        ))
    }

    private fun dispatch(parsed: kotlinx.serialization.json.JsonObject) {
        runCatching {
            val frame = json.decodeFromJsonElement(ServerFrameSerializer, parsed)
            onEvent(frame)
        }.onFailure { /* ignore unknown — forward-compat rule */ }
    }
}
```

### Reconciliation after `turn_done`

```kotlin
private suspend fun onTurnDone(turnDone: ServerFrame.TurnDone) {
    // Refetch the disk projection. Use the EXTERNAL conv id form so the
    // shim's resolver picks up the agent unambiguously.
    val messages: List<LettaMessage> = lettaRestClient.listMessages(
        agentId = currentAgentId,
        conversationId = "conv-default-${currentAgentId}",
        limit = 50,
    )
    chatStore.reconcileAfterSend(messages)
    // dedupeOptimisticContentTwins + distinctBy { id } already run inside
    // reconcileAfterSend; the cm-stream- prefix + otid round-trip make
    // the dedup fire correctly.
}
```

### Keepalive

The server pings every 25 s by default. The client does NOT need to
reply with `pong` (the server resets its idle timer on any inbound
frame). But it MAY:

```kotlin
private fun onPing() {
    outbound.trySend(PongFrame(id = UUID.randomUUID().toString(), ts = nowIso()))
}
```

If the underlying TCP/WS stack drops, Ktor surfaces a close — handle
in the `incoming` channel termination path and reconnect with
exponential backoff, comparing the new `welcome.server_id` against the
cached one.

---

## 9. Where in the shim each behavior lives

Quick reference for the implementer to read source when this doc is
ambiguous.

| Behavior | File | Lines |
|----------|------|-------|
| WS upgrade route, 404 / 503 fallback | `admin-shim/server.ts` | 1060-1087 |
| `server_id` generation + persistence | `admin-shim/server.ts` | 108-128 |
| `/v1/health/` response shape | `admin-shim/server.ts` | 130-138 |
| Channel adapter cache, lazy load | `admin-shim/lib/mobile-channel-host.ts` | 290-335 |
| `bridgeSendMessage` (the host bridge into the pool) | `admin-shim/lib/mobile-channel-host.ts` | 116-219 |
| `resolveConversationId` | `admin-shim/lib/store.ts` | 280-292 |
| `findUnmappedTailUserMessageId` | `admin-shim/lib/store.ts` | 408-416 |
| `writeOtidForLocalId` | `admin-shim/lib/store.ts` | 380-399 |
| `reshapeFrame` (raw → wire shape) | `admin-shim/lib/chat.ts` | 194-364 |
| `tagAsOptimistic` (cm-stream- prefix) | `admin-shim/lib/chat.ts` | 129-145 |
| `TYPE_OFFSET` (stream-side date offsets) | `admin-shim/lib/chat.ts` | 517-524 |
| `TYPE_OFFSET_MS` (disk-projection date offsets) | `admin-shim/lib/translate.ts` | 256-270 |
| Plugin entry point, `acceptConnection` | `home/.letta/channels/mobile/plugin.mjs` | 60-69 |
| Token resolution (env / fallback) | `home/.letta/channels/mobile/plugin.mjs` | 13-18 |
| Connection lifecycle, hello/welcome | `home/.letta/channels/mobile/lib/ws-handler.mjs` | 100-142 |
| Single-flight check | `home/.letta/channels/mobile/lib/ws-handler.mjs` | 158-166 |
| `turn_started` emit (pre-run_id) | `home/.letta/channels/mobile/lib/ws-handler.mjs` | 170-180 |
| Frame emit per `message_type` | `home/.letta/channels/mobile/lib/ws-handler.mjs` | 207-251 |
| `turn_done` post-stamp emit | `home/.letta/channels/mobile/lib/ws-handler.mjs` | 260-269 |
| `cancel` handling | `home/.letta/channels/mobile/lib/ws-handler.mjs` | 290-303 |
| `bye`, idle, ping cadence | `home/.letta/channels/mobile/lib/ws-handler.mjs` | 69-91, 310-313 |
| `ERROR_CODES` enum | `home/.letta/channels/mobile/lib/protocol.mjs` | 47-54 |
| `CLIENT_FRAMES` / `SERVER_FRAMES` lists | `home/.letta/channels/mobile/lib/protocol.mjs` | 22-45 |
| Backpressure (bufferedAmount drop) | `home/.letta/channels/mobile/lib/ws-handler.mjs` | 202-206 |
| Device state sidecar (`devices/<id>.json`) | `home/.letta/channels/mobile/lib/state.mjs` | 17-59 |
| Cron store (lock-aware CRUD on `crons.json`) | `admin-shim/lib/crons.ts` | full file |
| Cron scheduler (lease + tick + mtime watcher) | `admin-shim/lib/cron-scheduler.ts` | full file |
| Cron event bus (`crons_updated` pub/sub) | `admin-shim/lib/cron-events.ts` | full file |
| Cron WS handlers (handleCron* + agent alias resolution) | `admin-shim/lib/mobile-channel-host.ts` | search for `handleCronList` |
| Cron WS frame routing (`cron_*` cases + `crons_updated` push) | `home/.letta/channels/mobile/lib/ws-handler.mjs` | search for `case "cron_` |
| Cron REST mirror (`/v1/crons*` + 405 on mutation) | `admin-shim/server.ts` | search for `handleCronsList` |
| Frame log writer (`appendRunFrame` + monotonic seq) | `admin-shim/lib/runs.ts` | search for `appendRunFrame` |
| Subscribe replay + live-tail (`subscribeToRun`) | `admin-shim/lib/mobile-channel-host.ts` | search for `subscribeToRun` |
| Subscribe WS frame routing | `home/.letta/channels/mobile/lib/ws-handler.mjs` | search for `case "subscribe"` |

For the wire types themselves, read
`admin-shim/lib/types/wire.ts` — it documents every locked contract in
the file banner and references the Kotlin counterparts in `Message.kt`.

---

## 10. Cron / Scheduled Prompts

The cron protocol (frames defined in §2) is read-only via REST
(`/v1/crons*`) and write+read via WS. Every WS mutation is mirrored to
disk in `$LETTA_HOME/crons.json` so it interoperates byte-for-byte with
the bundled `letta cron` CLI and the agent's own self-schedule skill.

### 10.1 The `CronTask` shape

```json
{
  "id": "deadbeef",
  "agent_id": "agent-597b…",
  "conversation_id": "default",
  "name": "morning-checkin",
  "description": "summarize overnight signals",
  "cron": "*/30 9-17 * * *",
  "timezone": "America/Toronto",
  "recurring": true,
  "prompt": "What changed overnight in the inbox?",
  "status": "active",
  "created_at": "2026-05-19T13:45:21.000Z",
  "expires_at": null,
  "last_fired_at": null,
  "fire_count": 0,
  "cancel_reason": null,
  "jitter_offset_ms": 14823,
  "scheduled_for": null,
  "fired_at": null,
  "missed_at": null
}
```

All 19 fields are present on every row. Nullable timestamps are written
as JSON `null`, not omitted. TypeScript source-of-truth:
`admin-shim/lib/types/crons.ts` (`CronTask`).

| Field | Type | Semantics |
|-------|------|-----------|
| `id` | `string` | 8-char hex, generated server-side at add time. Use this for `cron_get` / `cron_delete`. |
| `agent_id` | `string` | Canonical agent id (post-alias-resolution). |
| `conversation_id` | `string` | `"default"` or `"conv-…"`. Determines which thread the fired prompt lands in. |
| `name` | `string` | Display label. Free-form. |
| `description` | `string` | Description rendered alongside `name` inside the agent's `<system-reminder>` envelope at fire time. |
| `cron` | `string` | 5-field cron expression. `"*/5 * * * *"` matches every five minutes; `"0 8 * * 1-5"` matches 08:00 on weekdays. |
| `timezone` | `string` | IANA tz. Cron matching uses this tz, not the host clock. |
| `recurring` | `boolean` | `true` for cron-driven recurring tasks; `false` for one-shots scheduled via `at`. |
| `prompt` | `string` | The agent-facing prompt body. Wrapped in `<system-reminder>` at fire time. |
| `status` | `CronTaskStatus` | See §10.2. |
| `created_at` | `string` | ISO timestamp. |
| `expires_at` | `string \| null` | Reserved for future use (no scheduler path produces it today). |
| `last_fired_at` | `string \| null` | ISO timestamp of the most recent fire. Updated on every fire (recurring or one-shot). |
| `fire_count` | `number` | Number of times the task has fired. `0` until the first fire. |
| `cancel_reason` | `string \| null` | Non-null only when `status === "cancelled"` — reserved for user-initiated cancels. Missed one-shots use `status: "missed"`, NOT `cancel_reason: "missed"`. |
| `jitter_offset_ms` | `number` | See §10.3. |
| `scheduled_for` | `string \| null` | ISO timestamp. Set only for one-shots created via `at`. |
| `fired_at` | `string \| null` | ISO timestamp. Set only for one-shots, identical to `last_fired_at` at terminal time. |
| `missed_at` | `string \| null` | ISO timestamp. Set only when a one-shot transitions to `status: "missed"`. |

### 10.2 Status vocabulary

`CronTaskStatus` values, matched to bundled letta-code so the bundle's
CLI and our REST mirror render the same string:

| Value | Set by | Meaning |
|-------|--------|---------|
| `"active"` | `cron_add` | Scheduled and waiting to fire. The default on creation. |
| `"fired"` | scheduler tick | One-shot completed its single fire. Terminal. |
| `"missed"` | scheduler tick | One-shot's `scheduled_for` was more than `SHIM_CRON_MISSED_THRESHOLD_MS` (default 5 min) in the past when first observed. Never fired. Terminal. |
| `"cancelled"` | (reserved) | User-initiated cancellation. `cancel_reason` carries detail. Not produced by current code; reserved for future "soft-delete" semantics. |
| `"completed"` | (reserved) | Recurring task hit `expires_at`. Not produced today. |

Recurring tasks stay `"active"` forever (no terminal state). To stop
them, send `cron_delete`. Mobile UIs that filter by status should
treat `"active"` as "show in the schedules tab" and the others as
"history".

### 10.3 Jitter

`jitter_offset_ms` is the per-task offset (in ms) applied to the
matched fire-time, so 100 tasks all set to `"*/5 * * * *"` don't
all fire on the same tick.

- For **recurring** tasks: a positive jitter capped at 10% of the
  estimated period (or 59.999s, whichever is smaller). Deterministically
  hashed from `id`, so the same row always picks the same jitter.
- For **one-shot** tasks landing on `:00` / `:30` boundaries: a
  *negative* jitter up to 90s before `scheduled_for`, to soften the
  "everyone scheduled for 3pm fires at exactly 3pm" pile-up. Clamped to
  not predate `created_at`.
- For everything else: `0`.

Mobile rendering tip: the user-visible "next fire" should be the
**jittered** time, not the raw cron match. The scheduler waits
`jitter_offset_ms` after the cron match before invoking the agent.

### 10.4 Schedule shorthand parsing

`cron_add` resolves `every` / `at` server-side. Edge cases:

- `every "30s"` → cron `"*/1 * * * *"` with a note about the 1-minute
  floor (cron's granularity).
- `every "7h"` → cron `"0 */8 * * *"` with a `note` field explaining
  the rounding to the nearest divisor of 24.
- `at "in 30m"` → one-shot with `scheduled_for = now + 30min`.
- `at "3:15pm"` → one-shot for today at 15:15, or tomorrow if that's
  already past.

The raw 5-field `cron` accepts `*`, `*/N`, `N-M` ranges, and exact
integers per field. **No L / W / `#` / @-aliases** — keep it simple.

### 10.5 Scheduler-lease semantics

Exactly one process holds the cron scheduler lease at any time.
Persisted in `crons.json.scheduler_owner` as `{pid, token,
started_at, process_start_ticks, boot_id}`. The shim claims this on
boot (`SHIM_CRON_ENABLED=1`, default on) and releases it on SIGTERM /
SIGINT.

- If another shim (or the bundled letta-code) holds the lease with a
  live PID, the second claim is a no-op (logs and exits without
  crashing).
- After a host crash, the next shim startup sees a stale lease,
  matches the dead `pid` + `boot_id`, and steals it within one tick.
- The lease holder ticks every 60s (`TICK_INTERVAL_MS`). The mtime
  watcher refreshes the cache out-of-band when the file changes,
  with a 200ms debounce.

Implementation: `admin-shim/lib/cron-scheduler.ts`.

### 10.6 REST read mirror

For dashboards / curl / ops scripts that don't want to hold a WS:

| Route | Method | Returns |
|-------|--------|---------|
| `/v1/crons` | `GET` | `{ tasks: CronTask[] }` (filters: `?agent_id=` / `?conversation_id=`) |
| `/v1/crons/{id}` | `GET` | `CronTask` (404 if missing) |
| `/v1/crons/scheduler` | `GET` | `{ lease_held, owner_pid, token, started_at, tasks_active, last_tick_at, next_tick_at }` |

Any non-`GET`/`OPTIONS` method on these paths returns **HTTP 405**
with a body pointing at the WS protocol:

```json
{
  "detail": "POST not allowed on cron REST endpoints — mutations are WS-only",
  "ws_endpoint": "/shim/v1/mobile",
  "ws_frames": ["cron_add", "cron_list", "cron_get", "cron_delete"]
}
```

Per the shim's WS-first-for-mutations rule (see `DIVERGENCE.md` §5),
the canonical write path is always the WS protocol. The REST mirror
exists strictly so passive observers don't need a long-lived socket.

### 10.7 Auth

All cron frames require an authenticated socket. Auth is the same
`MOBILE_CHANNEL_TOKEN` flow described in §1 — clients without a valid
token at `hello` get `error{invalid_token}` and a WS close (code 4000)
before any cron frame is dispatched. There is no per-frame re-check;
the hello result gates the whole session.

### 10.8 Error envelopes

Cron responses use a unified shape:

```json
{ "v": 1, "type": "cron_add_response", "id": "…", "ts": "…",
  "request_id": "req-2",
  "success": false,
  "error": "invalid cron expression: not a cron" }
```

This is intentionally different from the generic `error` frame
(§7) — a failed `cron_add` is **not** a protocol violation, it's a
data-validation rejection. The socket stays open, no error counter
increments, and the client can retry with corrected input. Use the
generic `error` frame's `code` for transport-level failures only.

---

## 11. Reconnect resume

A mobile app that loses its WS connection mid-turn should not lose
visible state. The shim persists every BridgeFrame to disk
(`state/runs/<run_id>/frames.jsonl`) and exposes the `subscribe`
protocol so the reconnecting client can resume from a known cursor
without re-driving the turn.

This section spells out the recommended client-side recipe end-to-end.
For the durability model (what's persisted, what isn't, recovery
non-goals) see `DURABLE_EXECUTION.md`.

### 11.1 What the client tracks per active Run

- `run_id` — captured from the first frame after `send_message`
  (`turn_started.run_id` is non-null per lcp-99a).
- `last_seq` — the largest `seq` observed on any frame for that Run.
  Every server frame for an active turn carries a `seq` field (post
  lcp-p74.2) — `assistant_message`, `reasoning_message`,
  `tool_call_message`, `tool_return_message`, `stop_reason`,
  `usage_statistics`, and `a2ui_frame` all include it. Treat
  `seq: null` (older clients, frames emitted before run_id resolved)
  as "no cursor yet" — start from `0` on resume.
- Terminal flag — flips to `true` when `turn_done` arrives. After
  that, no resume is needed.

### 11.2 Reconnect recipe

```text
on network drop:
  remember (run_id, last_seq) for every non-terminal Run
  reopen WS, send hello
  for each remembered Run:
    send { type: "subscribe", run_id, cursor: last_seq }
    consume subscribe_frame envelopes until subscribe_done
      — each envelope's `frame.message_type` matches what the
        live turn would emit; render it the same way
      — track subscribe_frame.seq as the new last_seq
    on subscribe_done: drop the Run from the active set
```

The replay arrives **before** the live tail catches up, so a partial
replay followed by live appends is a normal sequence. Don't dedupe by
`seq` on the client — the server already filters `seq > cursor` for
you.

### 11.3 Worked example

Mobile is in a turn at `run-abc`. Frames seq 1–4 have arrived:
`turn_started`, `assistant_message`, `assistant_message`,
`reasoning_message`. The TCP connection drops at seq 4.

```text
Client state:  { activeRuns: { "run-abc": { last_seq: 4 } } }
```

Client reconnects, sends `hello`, then:

```json
{ "v": 1, "type": "subscribe", "id": "…", "ts": "…",
  "run_id": "run-abc", "cursor": 4 }
```

Server replays seq 5+ from `frames.jsonl`:

```json
{ "v": 1, "type": "subscribe_frame", "seq": 5,
  "run_id": "run-abc",
  "frame": { "message_type": "tool_call_message", "tool_call": {…} } }
{ "v": 1, "type": "subscribe_frame", "seq": 6,
  "run_id": "run-abc",
  "frame": { "message_type": "tool_return_message", "tool_return": {…} } }
{ "v": 1, "type": "subscribe_frame", "seq": 7,
  "run_id": "run-abc",
  "frame": { "message_type": "assistant_message", "content": "…" } }
```

Then a live tail of new frames as they arrive:

```json
{ "v": 1, "type": "subscribe_frame", "seq": 8,
  "run_id": "run-abc",
  "frame": { "message_type": "stop_reason", "stop_reason": "end_turn" } }
{ "v": 1, "type": "subscribe_frame", "seq": 9,
  "run_id": "run-abc",
  "frame": { "message_type": "usage_statistics", "prompt_tokens": 1024, … } }
```

Final terminal envelope (the Run was already `completed` on disk;
once the tail catches up, the server stops watching):

```json
{ "v": 1, "type": "subscribe_done", "id": "…", "ts": "…",
  "run_id": "run-abc",
  "last_seq": 9,
  "status": "completed" }
```

Client drops `run-abc` from its active set.

### 11.4 Cursor caveats

- Frames are written in seq order but seq values are **per-run**, not
  global. Two different Runs each start at `seq: 1`.
- A turn that's already terminal at the time of subscribe receives the
  full replay then `subscribe_done` essentially back-to-back. Render
  the frames as you go; the terminal flag arrives last.
- The frame log is append-only — there's no rewrite. A `seq` you
  remembered yesterday is still valid tomorrow as long as the Run's
  directory hasn't been GC'd (Run TTL is currently infinite; see
  `DURABLE_EXECUTION.md` for the non-goal of bounded retention).

---

## 12. WS-canonical conversation state (deconfliction)

**Status:** draft. Tracks epic `letta-mobile-wq8v` ("Conversation state:
single source of truth across REST + WS + SSE"). This section pins the
contract; the implementation lands across phases P1–P5 of that epic.

### 12.1 Why this section exists

Through Phase-1 the shim accumulated several concurrent paths for
conversation state that don't know about each other:

1. `POST /v1/conversations/{id}/stream` — long-lived SSE-shaped agent
   run output (observed durations ~30–48 min per stream).
2. `/shim/v1/mobile` WebSocket — A2UI frames, message deltas, tool
   approvals, cron, subscribe/resume.
3. `GET /v1/conversations/{id}/messages` — REST history; called with
   inconsistent shapes (`limit=200`/`250`, `order=asc`/`desc`) from
   multiple consumers.
4. `GET /v1/runs/{id}/steps` — REST polling for the live-run pane.
5. Agent-pool stdin — the actual write path into the messages table.

Storage is fine (single Letta messages table). The chaos is in
**server→client delivery** and **client-side reconciliation**:
multiple writers into the UI, no monotonic ordering across paths,
no shared cursor on the wire. Observed symptoms include hydration
misses on reopen, A2UI surface history flashing the whole timeline,
silently-dropped actions on a stale WS, and `total_frames=0` in
a2ui turn_metrics even when A2UI is clearly rendering.

The fix is to pick a single canonical transport for conversation-state
mutations and treat everything else as observers or cold-start replay.

### 12.2 The canonical transport: WebSocket

For each conversation:

- **WS is the canonical mutator.** Every state-mutating frame
  (`assistant_message`, `tool_call_message`, `tool_return_message`,
  `reasoning_message`, `stop_reason`, `usage_statistics`, `turn_done`,
  `a2ui_frame`, `user_action_outcome`) reaches the client over WS.
- **REST is cold-start replay only.** `GET /v1/conversations/{id}/messages`
  fires exactly once per cold-open of a conversation. It does **not**
  poll while a WS session is active for that same conv.
- **SSE `/stream` is deprecated.** Phase-1 clients may continue to read
  it during transition (P3); P4-compliant clients MUST NOT open `/stream`
  for any conv that has a live WS session.
- **REST `/v1/runs/{id}/steps` is observability-only.** Live run-pane
  state arrives via WS frames; REST step polling is for offline
  dashboards (ops curl, cron-driven views).

### 12.3 Per-conversation monotonic `seq`

Every server→client WS frame for a conversation carries a per-conversation
monotonic `conv_seq` field in addition to the per-run `seq` already used for
`subscribe`/`subscribe_done` (§11). The two cursors coexist:

- `conv_seq` (per-conv) — field added by `lcp-2hf.1`. Increments by 1
  for every frame the shim emits for conversation `X` over WS,
  regardless of which run produced it.
- `frame.seq` inside `subscribe_frame` — unchanged. Per-run cursor for
  replay-after-drop.

Client semantics:

- The single `ConversationStateHolder` (§12.4) records `last_conv_seq`
  per conversation. On WS reconnect, it sends `resume_conversation`
  (`{ conversation_id, after_seq }`) or includes `{ resume: { conversation_id,
  after_seq } }` in `hello`. The shim replays durable JSONL-backed frames
  with `conv_seq > after_seq`, then emits `conversation_resume_done`.
- A frame with `conv_seq <= last_conv_seq` is a duplicate; drop it.
- A gap (`conv_seq > last_conv_seq + 1`) triggers a single REST cold-start
  refetch and resets `last_conv_seq` to the highest `conv_seq` observed.
- If the buffer no longer contains the requested cursor window, the shim
  emits `error{code:"cursor_expired", conversation_id, after_seq, oldest_seq,
  last_seq}` and keeps the socket open for REST hydrate fallback.

`conv_seq` is server-assigned. Clients MUST NOT mint or modify it. The shim
persists the high-water mark under the local backend's
`mobile-conversation-cursors/` sidecar directory so counters survive shim
restart. Replay frames are also appended to per-conversation JSONL logs in
that directory, so ordinary shim restarts do not create silent cursor gaps.
The in-memory buffer is only a hot cache; expired/pruned durable cursors fall
back to REST hydrate via `cursor_expired`.

### 12.4 Client-side: one `ConversationStateHolder`

On Android the contract is symmetrical:

- **Exactly one writer per conversation.** The WS frame pump is the
  sole writer into the per-conversation state holder. REST cold-start
  hands its result to the holder via a single `seedFromCold` call and
  then ceases to be a writer.
- **All UI subscribes through the holder.** No view binds directly to a
  raw network response. Chat list, message timeline, A2UI surface
  registry, run-step pane — all derived from the holder's observable
  state.
- **No polling.** The only acceptable triggers for `seedFromCold` are
  cold app start, explicit pull-to-refresh, or a per-conv seq gap
  detected by the holder itself.

Anti-patterns to remove (tracked under `letta-mobile-wq8v` children):

- Multiple `/v1/conversations/{id}/messages` consumers with their own
  paginators (`letta-mobile-16li`).
- SSE `/stream` reads concurrent with WS sessions for the same conv
  (`letta-mobile-c3h4`).
- A2UI surface history replayed frame-by-frame on conversation reopen
  (`letta-mobile-g2qg`) — the holder folds prior surfaces into final
  state during `seedFromCold` and renders only the live snapshot.

### 12.5 Frame metadata unification

`a2ui_frame` MUST flow through the same `turn_metrics` pipeline that
counts text/tool frames. Today the A2UI splitter operates inline on the
WS-only path and bypasses the metrics emitter, producing the
`total_frames: 0` observability blind-spot seen in `/tmp/admin-shim.log`.

P5 deliverable: every WS frame carrying a `run_id` increments
`turn_metrics.total_frames` regardless of which path inside the shim
produced it. `widget_types_seen` populates for every successfully
validated `a2ui_frame`.

### 12.6 Migration phases (cross-ref to epic `letta-mobile-wq8v`)

| Phase | Deliverable | Lands in |
|-------|-------------|----------|
| **P1** | Define WS-canonical contract: per-conv `seq` field on every server frame, `resync_conversation` frame shape, REST cold-start contract, SSE retirement plan. | `MOBILE_WS_PROTOCOL.md` (this section), `lib/types/wire.ts`, `lib/store.ts` (seq persistence). |
| **P2** | Single `ConversationStateHolder` on Android. WS pump is sole writer; REST is `seedFromCold` only. | `letta-mobile/android-compose/core/...`. |
| **P3** | Retire (or quarantine behind flag) `POST /v1/conversations/{id}/stream` for mobile clients. | `admin-shim/server.ts`, mobile transport layer. |
| **P4** | Stop REST `/v1/conversations/{id}/messages` polling. Cold-start + pull-to-refresh only. | mobile data layer. |
| **P5** | Unify A2UI metrics with the rest of the frame pipeline. `total_frames` reflects every emitted frame. | `lib/a2ui-adapter.ts`, `lib/a2ui-stream-splitter.ts`, `mobile-channel-host.ts`. |

Acceptance lives in the epic. Each phase ships behind a feature flag
where reversibility matters (P3 especially); P1/P2/P5 are
forward-compatible by construction.

### 12.7 In-flight messages MUST NOT appear in REST snapshots

**Rule (lcp-r0m):** REST `GET /v1/conversations/{id}/messages` and `GET
/v1/agents/{id}/messages` MUST NOT return content that is currently being
streamed via WS for the same conversation. The two transports MUST NOT
race on the same serverId.

Why: the WS path streams pure deltas under a stable `cm-stream-<otid>`
id. If REST returns the corresponding cumulative `assistant_message`
mid-stream, the client's merge appends the snapshot onto the accumulated
deltas and produces incoherent text (the 2026-05-19 "StandStanding
by..." repro).

Implementation: the shim tracks active runs via `_activeRuns` in
`lib/runs.ts`. A run is "active" when it has been created and not yet
finalized (`status === "running"`). Every message persisted during such
a run is recorded in `RunRecord.message_ids` via `recordRunMessage`.
The REST `/messages` handlers consult `inFlightMessageIds(agentId,
conversationId)` and filter the response — any message whose id is in
the in-flight set is dropped. On `finalizeRun` the handle leaves
`_activeRuns` and the next REST hydrate naturally picks the message up.

This is a narrow filter on top of the existing REST surface. It does
not change the WS contract, does not change the disk projection, and
does not change the response shape for any conversation that has no
active run. Tests in `admin-shim/test/ws-protocol.test.ts`
(`lcp-r0m REST /messages drops in-flight content`) defend the rule.

### 12.8 What does NOT change

- REST `/v1/agents/{agent_id}/messages` after `turn_done` (§6
  reconciliation pattern) is unaffected — that GET is a cold-start /
  post-turn reconciliation, not a poll. The new holder uses it.
- `subscribe` / `subscribe_frame` / `subscribe_done` (§11) keep their
  per-run `seq` semantics for mid-turn reconnect-resume. The new
  per-conv `seq` is additive and orthogonal.
- The locked behavioral contracts in §4 are preserved. Single-flight,
  otid round-trip, cm-stream- prefix, per-type ms offsets — all stay.

---

## 13. Active-subagent registry (letta-mobile-73o2h.1)

Lets the mobile app render a status bar of currently-active subagents and
inspect each one's TodoWrite progress, **without scanning the parent run
frame stream**.

### 13.1 Correlation seam (how it works)

A subagent dispatch rides the parent run's frame stream as a single
`tool_call_message` with `tool_call.name === "Agent"`:

- `tool_call.tool_call_id` → **correlation key** (mobile uses this everywhere)
- `tool_call.arguments` (JSON) → `{ subagent_type, description, run_in_background, prompt }`

For a **background** dispatch the matching `tool_return_message` (name
`Agent`) carries the subagent's identity in its text body:

```
Task running in background with task ID: task_2
Agent ID: agent-local-<uuid>
Output file: /tmp/letta-background/task_2.log
```

From that the shim derives `task_id`, `subagentAgentId` (the subagent's
OWN agent), and `logFile`. The subagent's TodoWrite lives in the
subagent's separate conversation (`default:<subagentAgentId>`), read on
demand. Terminal status: the background log's `[Task completed]` footer →
`completed`; a still-running subagent past the stream-timeout window →
`failed` (reason `stream_timeout`).

The registry is populated by `ingestParentFrame()` inside
`bridgeSendMessage`'s `emit()` — it cheaply ignores every non-`Agent`
frame. Implementation: `admin-shim/lib/subagent-registry.ts` +
`admin-shim/lib/subagent-todos.ts`.

### 13.2 `subagent_list` → `subagent_list_response`

Enumerate subagents. Active-only by default; `{ all: true }` includes
terminal entries.

```jsonc
// client → server
{ "type": "subagent_list", "request_id": "r1", "all": false }
// server → client
{ "type": "subagent_list_response", "request_id": "r1", "success": true,
  "subagents": [ { "toolCallId": "toolu_…", "description": "…",
                   "subagentType": "general-purpose", "status": "running",
                   "taskId": "task_2", "subagentAgentId": "agent-local-…",
                   "parentRunId": "run-…", "startedAt": "…" } ] }
```

### 13.3 `subagent_todos` → `subagent_todos_response`

One subagent's latest TodoWrite snapshot + lifecycle, keyed by the parent
Agent `tool_call_id`.

```jsonc
// client → server
{ "type": "subagent_todos", "request_id": "r2", "tool_call_id": "toolu_…" }
// server → client
{ "type": "subagent_todos_response", "request_id": "r2", "success": true,
  "found": true, "subagent": { … }, "todos_found": true,
  "todos": [ { "content": "…", "status": "in_progress", "activeForm": "…" } ] }
```

`status` enum mirrors the TodoWrite tool: `pending | in_progress | completed`.

### 13.4 `subagents_updated` (server push)

Installed per-socket after `hello` (mirrors `crons_updated`). Pushed when a
subagent starts or reaches a terminal state. Carries the changed
`subagent`, the `reason`, and a fresh `subagents_active` list so the bar
reduces by replacement:

```jsonc
{ "type": "subagents_updated", "reason": "started",
  "subagent": { … }, "subagents_active": [ … ], "at": "…" }
```

### 13.5 Deferred (first cut)

- **TodoWrite is a point-in-time snapshot** fetched on demand (and via the
  push that fires on lifecycle changes), NOT a live tail of the subagent
  conversation's append stream. A true live subscription is a follow-up.
- Synchronous (non-background) `Agent` dispatches register, but their
  subagent-conversation correlation depends on the same agent-local id
  appearing in the return body; if a future return shape differs, the
  `todos` read degrades gracefully to `todos_found: false`.

---

## Related docs

- `/opt/stacks/letta-code-parallel/docs/MOBILE_CHANNEL_DESIGN.md` —
  multi-phase design rationale (the why).
- `/opt/stacks/letta-code-parallel/admin-shim/docs/CHANNEL_PLUGINS.md`
  — plugin-authoring contract; reuse if writing a non-mobile channel.
- `/opt/stacks/letta-code-parallel/admin-shim/lib/types/wire.ts` —
  TS source-of-truth for the LettaMessage union.
- `/opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/Message.kt`
  — Kotlin sealed-class hierarchy; reuse don't reinvent.
- `/opt/stacks/letta-code-parallel/admin-shim/test/ws-protocol.test.ts`
  — the 23 tests that defend everything in §4 (some are `todo` —
  reasoning_message in particular).
