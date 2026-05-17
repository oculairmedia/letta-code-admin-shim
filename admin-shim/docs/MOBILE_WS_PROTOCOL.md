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
  "backend": "letta-code-local" }
```

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
  "supported_widgets": ["Text", "Button", "ToolApprovalCard"],
  "theme_hints": { "color_scheme": "dark" }
}
```

The `a2ui_*` fields are optional. When present, they request dynamic UI mode
for this WS session. The server only negotiates A2UI when `A2UI_ENABLED=1`,
the requested version matches `A2UI_VERSION`, and the requested catalogs include
`A2UI_CATALOG_ID`. Non-A2UI clients omit these fields and keep the exact Phase-1
text/tool behavior.

- `token` — **required**. Constant-time matched. Wrong → `error{invalid_token}` + close (code 4000 with reason `invalid_token`).
- `device_id` — optional; if omitted, server assigns `anon-<uuid>`. The
  same id is echoed in `welcome.device_id`.
- `client_version` — optional; logged for telemetry only.

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

### 2.2 Server → client frames

Every server frame carries the base envelope (`v`, `type`, `id`, `ts`).
Type-specific fields below.

#### `welcome`

```json
{ "v": 1, "type": "welcome", "id": "…", "ts": "…",
  "server_id": "9c2d7e4f-…",
  "session_id": "sess-1f6c8a4d-…",
  "device_id": "android-emanuel-pixel-7",
  "a2ui_negotiated": true,
  "a2ui": { "version": "0.9", "catalog_id": "basic" } }
```

- `server_id` — universe cache key (see §1).
- `session_id` — server-assigned, `sess-<uuid>`. Logging only.
- `device_id` — echoes the client's `hello.device_id` (or the assigned
  `anon-<uuid>`).
- `a2ui_negotiated` — `true` only when the client requested A2UI in `hello`
  and the server accepted it for this session. Non-A2UI clients may ignore
  this field; current server frames include `false` when not negotiated.
- `a2ui` — negotiated A2UI version/catalog summary, or `null` when A2UI is
  not active for the session.

Test: `ws: hello/welcome handshake — server_id, session_id, device_id in welcome`.
Test: `ws: hello can negotiate A2UI capability when server support is enabled`.

#### `a2ui_capabilities`

Emitted immediately after `welcome` only when A2UI was negotiated.

```json
{ "v": 1, "type": "a2ui_capabilities", "id": "…", "ts": "…",
  "version": "0.9",
  "catalog_id": "basic",
  "supported_catalogs": ["basic"],
  "supported_widgets": ["Text", "Button", "ToolApprovalCard"] }
```

This frame confirms the server-side A2UI contract for the session. Older
clients remain safe because unknown server frame types are ignored silently.

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
  "turn_id": "turn-…", "run_id": "run-…",
  "content": "pong",
  "otid": "cm-android-d6f0e2c1" }
```

- Server-side coalesced: one `assistant_message` per `otid` per turn
  (`mobile-channel-host.ts:141-197`). letta-code's underlying stream
  emits many partial chunks; the host concatenates them by `otid`.
- `id` always carries the `cm-stream-` prefix — see §4.2.
- `otid` is the **echo of the client's send_message.otid** (when
  present) so mobile can collapse stream-vs-disk twins via
  `dedupeOptimisticContentTwins`.

Test: `ws: assistant_message carries non-empty content on a normal reply`.

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

For the wire types themselves, read
`admin-shim/lib/types/wire.ts` — it documents every locked contract in
the file banner and references the Kotlin counterparts in `Message.kt`.

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
