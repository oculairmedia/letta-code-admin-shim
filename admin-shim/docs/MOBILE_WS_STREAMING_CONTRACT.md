# Mobile WS streaming contract (lcp-cv3)

Status: **active** as of commit landing lcp-cv3 (replaces the previous
"one assistant_message per turn" coalescing in mobile-channel-host.ts).

This documents what the admin-shim emits over the `/shim/v1/mobile`
WebSocket on each turn, so the Android side can verify its dedup/merge
pipeline matches the shim's invariants.

---

## TL;DR

`assistant_message` and `reasoning_message` are streamed as **pure
content deltas**. Every chunk of the same logical message carries the
**same envelope `id`** — `cm-stream-<otid>` for assistants,
`cm-reason-<otid>` for reasoning. Mobile MUST find the existing event
by `id` and `oldText + newText` the chunks. Identical to the
lettabot-uww.11 gateway contract.

`tool_call_message` and `tool_return_message` arrive once per logical
event with ids `toolcall-<tool_call_id>` and `toolreturn-<tool_call_id>`
respectively. Mobile dedups these by `distinctBy { id }`.

`stop_reason` and `usage_statistics` arrive at the **end** of every
turn, always after the final assistant chunk. First-wins on the shim
side: if upstream emits multiple, only the first is forwarded.

`turn_done` is always the **last** frame of the turn.

---

## Turn frame sequence

A normal text-only turn looks like this on the wire (frames in order):

```
turn_started        envelope id = randomUUID, carries turn_id
assistant_message   id = cm-stream-<otid>, content = "Hel"
assistant_message   id = cm-stream-<otid>, content = "lo "
assistant_message   id = cm-stream-<otid>, content = "world"
stop_reason         end_turn (or whatever upstream said)
usage_statistics    prompt/completion/total tokens, run_ids:[runId]
turn_done           status:"completed" | "cancelled" | "failed"
```

A turn that involves a tool call looks like:

```
turn_started
assistant_message   id = cm-stream-<otid>, content = "Looking up "
assistant_message   id = cm-stream-<otid>, content = "weather…"
tool_call_message   id = toolcall-<call_id>, tool_call.name = "...", arguments = {...}
tool_return_message id = toolreturn-<call_id>, tool_return = "...", status = "success"
assistant_message   id = cm-stream-<otid>, content = "It's "
assistant_message   id = cm-stream-<otid>, content = "sunny."
stop_reason
usage_statistics
turn_done
```

Reasoning (when emitted) interleaves the same way:

```
reasoning_message   id = cm-reason-<otid>, reasoning = "Let me think "
reasoning_message   id = cm-reason-<otid>, reasoning = "about this…"
```

---

## ID prefixes (locked contract)

| Frame type             | Envelope `id` format        | Dedup strategy           |
|------------------------|-----------------------------|--------------------------|
| `assistant_message`    | `cm-stream-<otid>`          | Content-append by `id`   |
| `reasoning_message`    | `cm-reason-<otid>`          | Content-append by `id`   |
| `tool_call_message`    | `toolcall-<tool_call_id>`   | `distinctBy { id }`      |
| `tool_return_message`  | `toolreturn-<tool_call_id>` | `distinctBy { id }`      |
| `turn_started`         | random UUID                 | n/a (routing only)       |
| `stop_reason`          | random UUID                 | last-frame state         |
| `usage_statistics`     | random UUID                 | last-frame state         |
| `turn_done`            | random UUID                 | terminal signal          |
| `welcome` / `ping`     | random UUID                 | non-timeline             |
| `error`                | random UUID                 | error banner             |

`<otid>` is the otid the mobile client passed in `SendMessageFrame.otid`.
If the client did not supply one, the shim falls back to the upstream
letta-code frame id — meaning each chunk renders as its own bubble (no
merging happens). Always send an otid.

---

## Content semantics

### `assistant_message.content`

**Pure delta.** Each chunk's `content` is ONLY the new text since the
previous chunk. Mobile MUST concatenate `oldText + newText`. Do NOT
treat it as cumulative.

The append contract is byte-perfect — no whitespace normalization, no
trimming, no UTF-16 boundary smoothing. The shim guarantees the
concatenated content equals the upstream frame stream's natural reply.

Empty string is a valid chunk (no-op). Implementations should skip it
without erroring.

### `reasoning_message.reasoning`

Same delta semantics as `assistant_message.content`. `signature` may be
set on a later chunk (typically the last) — implementations should
last-wins on `signature`.

### `tool_call_message.tool_call` / `tool_calls`

**MAY arrive multiple times for the same `tool_call_id` during a
turn.** Upstream letta-code emits frames as the LLM's argument JSON
accumulates — early frames may have a name and id but blank or
partial arguments; later frames fill in the rest. Each frame is
NOT a delta; it carries the full argument state KNOWN AT EMIT TIME.

Consumer requirement (locked — see lcp-sep): merge by `tool_call_id`
with last-wins-when-more-complete semantics. Concrete rule mobile
uses: `mergedCalls = if (newScore >= oldScore) newCalls else oldCalls`
where score = count of calls with non-blank arguments. This avoids a
trailing blank-args frame overwriting populated state.

`tool_call.tool_call_id` is the stable identifier the corresponding
`tool_return_message` will reference. Envelope `id` is
`toolcall-<tool_call_id>` and is stable across the merged frames.

### `tool_return_message.tool_return`, `stdout`, `stderr`

`stdout` and `stderr` are `string[] | null` (per the lcp-2zn
normalization). Implementations should iterate the array on display.

`tool_return` is the func-response body as a string (or null).

---

## End-of-turn ordering

Even if upstream emits frames in a different order, the shim guarantees
this ordering on the wire:

1. All `assistant_message` / `reasoning_message` / tool frames (in
   their upstream order — generally chronological).
2. `stop_reason` — first occurrence only.
3. `usage_statistics` — first occurrence only.
4. `turn_done` — emitted by ws-handler.mjs after `host.sendMessage`
   resolves.

`stop_reason` and `usage_statistics` are buffered server-side and
flushed at the boundary so consumers can rely on them arriving last.
The server-side first-wins rule matches the run-record contract in
`runs.ts finalizeRun` (which also keeps the first observed value).

---

## Cancellation

When mobile sends `{type: "cancel", run_id: "<id>"}` mid-turn:

- The shim calls into the worker pool's cancel hook.
- Any further upstream frames for that run are still forwarded (the
  upstream emit can outrun the cancel signal by a few frames).
- The turn closes with `turn_done.status = "cancelled"`.
- `stop_reason` may or may not appear before `turn_done` — do not
  assume it does on a cancel path.

`cancel.run_id` is REQUIRED (no implicit fallback — lcp-bll). Tracked
gap (lcp-99a): mobile cannot cancel between `turn_started` and the
first `run_id`-bearing frame because no run_id exists yet. Resolution
pending: either always emit `run_id` on `turn_started` (shim-side fix)
or specify a client-buffer rule. Until then, mobile MAY ignore cancel
requests during that window and rely on the user retrying.

Mobile MUST treat `turn_done.status != "completed"` as authoritative
for run state.

### WS disconnect mid-turn

No resume cursor (Phase 1 by design). When the WS closes while a turn
is in flight:

- The shim's worker pool keeps running the turn locally.
- `onFrame` writes into a dead socket — frames are lost on the wire.
- The Run record finalizes to disk (status `completed` / `failed` /
  `cancelled`) regardless of WS state — tracked by lcp-kfr.

**Mobile MUST reconcile from the run record on reconnect** to recover
the turn's outcome. The disk projection carries the complete text,
tool calls, and tool returns once finalize lands.

## Failure paths

Tracked by lcp-axv. Locked convention (pending): every turn that
terminates abnormally emits an `error` frame BEFORE the
`turn_done.status="failed"` frame. The error frame carries `code`,
`message`, and the in-flight `turn_id` / `run_id`.

Mobile error-banner UX should buffer the error string from the
`error` frame and flip state on the subsequent `turn_done`.

---

## Backpressure

The shim enforces a `bufferHighWaterBytes` (default 1MB) on
`ws.bufferedAmount`. If the client can't drain frames fast enough,
**individual frames are dropped silently** (logged server-side) rather
than the socket being closed. This is OK for the streaming path because
each chunk is a delta of bounded size — losing one means the assembled
content has a gap, but the connection survives.

Recovery contract (tracked by lcp-srk, pending implementation):
`turn_done.lossy: bool` will indicate whether any drop fired during
the turn. Mobile MUST reconcile from the disk projection iff
`turn_done.lossy === true`. Until that flag ships, mobile MAY
reconcile defensively on every clean `turn_done.status === "completed"`,
but is not required to.

---

## Run id correlation

Every typed message (`assistant_message`, `reasoning_message`,
`tool_call_message`, `tool_return_message`, `stop_reason`,
`usage_statistics`) carries `run_id` in its envelope as soon as the
run is created. Mobile correlates with `GET /v1/runs/<run_id>` for
status (lcp-bll requires an explicit run_id on cancel frames).

`turn_started` includes `turn_id` (always) and may include `run_id`
when the run is created before the upgrade completes (rare). Mobile
should keep both indexed.

---

## What changed (lcp-cv3 vs. prior behavior)

| Aspect                | Before lcp-cv3                      | After lcp-cv3                                |
|-----------------------|-------------------------------------|----------------------------------------------|
| assistant_message     | Server-side coalesced; one per turn | Streamed; one frame per delta                |
| Envelope `id`         | randomUUID per frame                | `cm-stream-<otid>` (same across chunks)      |
| Content               | Cumulative (full text in last frame)| Delta (only new text per chunk)              |
| stop_reason / usage   | Last-wins on shim                   | First-wins on shim (matches run-record)      |
| reasoning_message     | Same coalescing as assistant        | Streamed with `cm-reason-<otid>` id          |

The REST/SSE path (`chat.ts` / `coalesceAssistantFrames`) is
**unchanged** — it still emits one `assistant_message` per turn to
preserve vanilla Letta server compatibility for any non-mobile client
hitting `/v1/conversations/.../stream`.

---

## Testing checklist for the Android side

To verify the implementation against this contract:

1. **Delta append.** Send a long-reply prompt; assert that after the
   stream finishes, the rendered bubble text equals the concatenation
   of every `assistant_message.content` payload received, IN ORDER.
2. **Stable id.** Capture all `assistant_message` frames for one turn;
   assert they share the same envelope `id` and that `id ==
   "cm-stream-" + sentOtid`.
3. **First-wins stop_reason.** Inject a fixture trace with multiple
   stop_reasons; assert the wire delivers only one
   (the first chronologically).
4. **End-of-turn ordering.** Assert `stop_reason` precedes
   `usage_statistics` precedes `turn_done`, and that no
   `assistant_message` arrives after `stop_reason`.
5. **Tool interleaving.** Trace with a tool call mid-reply; assert the
   `assistant_message` ids before and after the tool both equal
   `cm-stream-<otid>` (same logical message, not two separate ones).
6. **Empty chunk.** Send a fixture with a zero-length content frame in
   the middle; assert the rendered content is unchanged across that
   frame and that the consumer doesn't error.
7. **Missing otid.** Send a `send_message` without otid; assert each
   chunk renders as its own bubble (degraded mode, but no crash). Then
   verify a normal otid-bearing send streams correctly afterwards.

---

## Frame field clarifications

### `stop_reason.stop_reason` values

Mirror of letta-code's upstream enum. Currently observed:

| Value             | When                                        | Suggested mobile UX            |
|-------------------|---------------------------------------------|--------------------------------|
| `end_turn`        | Normal turn-complete                        | (no special UI)                |
| `tool_use`        | Turn ended after tool call (waiting return) | "Tool running…"                |
| `max_tokens`      | Output truncated at the model's cap         | "Response truncated"           |
| `error`           | Upstream error mid-stream                   | Error banner                   |
| `cancelled`       | User-initiated cancel landed                | "Cancelled"                    |
| `requires_approval` | Tool call needs explicit approval         | Approval prompt                |

Unknown values: treat as `end_turn` for state, but log the literal so
new upstream values surface in telemetry.

### Idempotent retry on same otid

The shim does NOT dedupe based on `otid` for `send_message` frames.
If mobile retries a `send_message` with an otid it has already sent
(e.g. after a disconnect), the shim will run a fresh turn. The user
will see two assistant replies.

Mobile MUST NOT retry a `send_message` with the same otid unless it
has explicit evidence the previous attempt did not reach the shim
(connection refused / TCP reset before the hello/welcome handshake
completed). Once `turn_started` has fired, the turn is owned by the
shim — wait for `turn_done` or reconcile from disk.

### Ping / Pong cadence

- Shim emits `{"type":"ping"}` app-layer frames every 25s (configurable
  via `accounts.json: pingIntervalMs`).
- WS-protocol-layer PONG (RFC 6455 opcode 0xA) is **sufficient** — the
  shim measures liveness at the TCP/WS layer, not the app layer.
- Mobile is NOT required to emit `PongFrame` at the app layer. Doing
  so is allowed but has no effect on the shim's idle-timeout logic.
- Idle timeout (no inbound or outbound data for `idleTimeoutMs`,
  default 120s) closes the socket. WS-layer ping/pong satisfies this
  timer.

### `turn_started.run_id` transition window

Currently NULL until the first run_id-bearing frame arrives (lcp-99a
target: always non-null). Mobile capture path should treat the field
as optional until lcp-99a closes. After lcp-99a: mobile MAY assert
non-null and crash-loud on null (regression).

### Empty content / zero-frame turns

- The first chunk of a logical message MAY be empty (rare but valid —
  e.g. when the upstream LLM emits an empty initial token).
- A turn MAY produce zero `assistant_message` frames (e.g. all
  reasoning + a single tool call that ends the turn via
  `stop_reason: "tool_use"`).
- Mobile state machines MUST NOT use "first chunk of any specific type
  arrives" as an event-creation trigger. Use `turn_started` as the
  authoritative "turn began" signal and `turn_done` for "turn ended."

### `v` (protocol version) policy

- The shim emits `v: 1` on every frame.
- Mobile MUST accept any frame with `v: 1` per this contract.
- A future frame with `v > 1` should be parsed best-effort with v1
  semantics. Unknown fields must be ignored, not error. Unknown
  `type` values land in `ServerFrame.Unknown` per the existing mapper.
- If the shim cuts a v2, this doc gets a new section — no in-band
  capability negotiation in Phase 1.

### `reasoning_message.signature`

`signature` is included on the FINAL chunk of a logical reasoning
message and is null on prior chunks. Mobile policy:

- An **absent or null** signature on a later chunk does NOT clear a
  previously-present signature. Use "last non-null wins."
- A **present** signature on a later chunk overrides the prior value
  (which only happens in pathological upstream traces).

## References

- `admin-shim/lib/mobile-channel-host.ts` `bridgeSendMessage` — where
  the stream id stamping happens.
- `home/.letta/channels/mobile/lib/ws-handler.mjs` — passes the
  upstream id through to the envelope, emits frame types.
- `home/.letta/channels/mobile/lib/protocol.mjs` `makeFrame` — envelope
  shape (`v`, `type`, `id`, `ts`, …spread). When the caller passes
  `id` in fields, it overrides the auto-generated UUID.
- Mobile: `core/src/main/java/com/letta/mobile/data/timeline/TimelineSyncIngest.kt`
  — the `oldText + newText` merge for streaming assistants. The
  comment block around lettabot-uww.11 documents the delta-append
  contract this shim now matches.
- Mobile: `core/src/main/java/com/letta/mobile/data/transport/WsFrameMapper.kt`
  — maps `ServerFrame.AssistantMessage.id` → `LettaMessage.id`
  (preserves `cm-stream-` prefix).
- Spec: `MobileWsFrames.kt` §2.2 + §4.2 (id prefix requirement).
