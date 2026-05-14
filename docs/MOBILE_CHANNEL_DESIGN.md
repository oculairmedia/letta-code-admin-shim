# Mobile-as-channel design doc — Phase 0

**Status:** Phase 0 design draft. Phase 1 implementation gated on this doc
being read and the open questions in the final section answered.

**Scope:** Add `mobile` as a first-class channel in letta-code's channel
system, on the same plugin pattern as Matrix/Slack/Telegram. Mobile-side
gets a new `ChannelTransport` next to the existing Letta REST client; chat
flows through the channel; admin stays on REST through the shim.

**Out of scope for Phase 0:** anything past the Phase 1 minimum (defined
below). Phase 2–5 designs are sketched at the end so we know what we're
building toward.

---

## Why this exists

### Motivation

Today's chat path: mobile POSTs `/v1/conversations/{id}/messages` to the
admin shim. The shim spawns (or reuses, via the worker pool) a `letta`
subprocess pinned to the conv. Reply streams back.

This works. But several capabilities are out of reach:

- **Server-initiated events** (agent replies to a Matrix message, cron
  agent wakes up, multi-channel activity worth surfacing) cannot reach
  mobile because the chat path is request-response.
- **Multi-agent in one session** requires either a new POST per agent or
  multiple parallel SSE streams from mobile. Channels naturally route many
  agents over one transport.
- **Architectural duplication**: each new channel (Matrix today, Slack /
  Discord / Signal in the queue) lands typing/mention/dedupe/pairing
  independently. Mobile-as-channel collapses one more under that shared
  pipeline.

### Non-goals

- **Replace the REST shim.** Admin endpoints (agents list, blocks, models,
  CRUD) stay on REST. The shim continues to serve them.
- **Break vanilla Letta REST compatibility.** Mobile's existing REST
  transport still works against the vanilla Python Letta server. The
  channel transport is an addition behind a toggle.
- **Solve cross-device sync.** Phase 5 territory.
- **Solve push notifications now.** Phase 4 territory; designed but not
  built. Foreground-only WS is the Phase 1 baseline.

## Architecture

```
                            mobile device
                ┌──────────────────────────────┐
                │  letta-mobile (Android)      │
                │                              │
                │  ┌─────────────────────┐     │
                │  │  RestTransport      │ ────────► /v1/agents, /v1/blocks,
                │  │  (existing)         │     │      /v1/models, etc.
                │  └─────────────────────┘     │      (admin, unchanged)
                │                              │
                │  ┌─────────────────────┐     │
                │  │  ChannelTransport   │ ────────► WSS / WS to shim
                │  │  (new)              │     │
                │  └─────────────────────┘     │
                └──────────────────────────────┘
                              │
                              │
                              ▼
                ┌──────────────────────────────────┐
                │  shim (admin-shim/server.mjs)    │
                │                                  │
                │  HTTP routes:                    │
                │    /v1/*  (REST, vanilla shape)  │
                │    /shim/* (debug, ops)          │
                │                                  │
                │  WS upgrade route:               │
                │    /shim/v1/mobile  ──┐          │
                └──────────────────────────────────┘
                                       │
                                       │ in-process bridge
                                       ▼
                ┌──────────────────────────────────┐
                │  channel plugin                  │
                │  ~/.letta/channels/mobile/       │
                │                                  │
                │  - plugin.mjs (adapter)          │
                │  - state/devices/                │
                │  - state/cursor/                 │
                │  - state/pairings/               │
                │                                  │
                │  Routes inbound → agent via      │
                │  letta-code's channel pipeline   │
                │  (same Worker, same pool).       │
                └──────────────────────────────────┘
                              ▲
                              │
                              │
                ┌──────────────────────────────────┐
                │  letta-code agent runtime        │
                │  (one process, channel-bound)    │
                │                                  │
                │  Pool-managed letta workers,     │
                │  shared with the REST chat path  │
                │  so warm workers serve either    │
                │  transport.                      │
                └──────────────────────────────────┘
```

The shim is the single process. It exposes HTTP on one port and accepts WS
upgrades on a specific path. Internally, the mobile channel plugin
registers itself the same way the Matrix plugin does — via the channel
manifest — but its "external" surface is the WS endpoint hosted *by the
shim* rather than an outbound long-poll like Matrix.

## Phase 1: minimum viable channel

### Goals

- Mobile connects via WS to `/shim/v1/mobile`.
- Authenticates with a hard-coded token from settings (no pairing flow yet).
- Sends one user message JSON frame.
- Receives one `assistant_message` frame back, with `[DONE]` semantics.
- Mobile UI renders it identically to today's REST/SSE rendering — so the
  toggle "use channel transport for chat" doesn't visibly change behavior.

### Non-goals for Phase 1

- Pairing.
- Multi-conv routing (one conv per connection is fine).
- Reconnect-with-cursor.
- Typing indicators, reactions, edits, deletes via the channel.
- Push notifications.
- Multi-device.

### Wire protocol

WebSocket. Frames are JSON, one per WS message. Every frame has:

```
{
  "v": 1,                     // protocol version
  "type": "<frame-type>",     // see vocabulary below
  "id": "<uuid>",             // unique per frame, for ack / debugging
  "ts": "2026-05-14T16:00:00.000Z"
}
```

Plus type-specific fields. Unknown frame types are ignored (forward-compat).

#### Phase 1 frame vocabulary (12 types)

**Client → Server**

| `type` | Required fields | Meaning |
|---|---|---|
| `hello` | `token`, `device_id`, `client_version` | First frame after WS opens. Server replies with `welcome` or `error`. |
| `send_message` | `agent_id`, `conversation_id`, `text` | Send a user message. Server starts processing. |
| `ack` | `target_id` | Acknowledge receipt of a server frame (e.g. `assistant_message`). |
| `bye` | — | Graceful disconnect. Server may persist state. |

**Server → Client**

| `type` | Required fields | Meaning |
|---|---|---|
| `welcome` | `server_id`, `session_id`, `device_id` | Auth succeeded. |
| `error` | `code`, `message` | Auth failed or other terminal error. Server closes WS. |
| `ping` | — | Server-side heartbeat. Mobile is encouraged to reply with a `pong`. |
| `pong` | — | (also client→server, sent in response to `ping`) |
| `turn_started` | `agent_id`, `conversation_id`, `turn_id` | Equivalent to vanilla's opening `ping` frame on the SSE stream. |
| `assistant_message` | `agent_id`, `conversation_id`, `turn_id`, `content` | Coalesced assistant reply, one per turn. Matches vanilla's shape. |
| `stop_reason` | `turn_id`, `reason` | End-of-turn signal. |
| `usage_statistics` | `turn_id`, `prompt_tokens`, `completion_tokens`, ... | Optional, after `stop_reason`. |

That's 12 frames. Enough for one round-trip. Future frames (typing,
reasoning, tool calls, reactions, etc.) layer on without changing this
base.

#### Frame ordering invariant (Phase 1)

For each `send_message`:
1. `turn_started`
2. Zero or more `assistant_message` (Phase 1: exactly one, coalesced)
3. Exactly one `stop_reason`
4. Optional `usage_statistics`

This mirrors the vanilla REST/SSE order, so the same coalescing logic on
the shim side applies.

### Auth (Phase 1)

The token model:

- Single hard-coded `MOBILE_CHANNEL_TOKEN` env var on the shim/channel
  side.
- Mobile's settings has a "channel token" field. Same string.
- First `hello` frame includes the token. Server compares constant-time and
  responds `welcome` or `error: invalid_token`.

That's it. No pairing flow, no token rotation, no device-specific tokens
in Phase 1. Phase 2 replaces this with a proper pairing-then-token flow.

`device_id` is generated client-side as a random UUID on first launch,
persisted in mobile's settings, included in `hello`. The server stores it
for observability but doesn't enforce uniqueness — Phase 1 expects one
device.

### Endpoint layout

WS upgrade on the shim:

```
GET wss://<shim-host>:8291/shim/v1/mobile
Upgrade: websocket
```

`/shim/v1/mobile` is the only WS endpoint in Phase 1. The `/shim/v1/`
prefix marks it as a shim-only extension to the REST surface — no Letta
client other than letta-mobile-with-channel-transport-on will hit it. This
keeps the `/v1/*` namespace 100% vanilla, as committed in
`DIVERGENCE.md`.

### State on disk

In `~/.letta/channels/mobile/state/`:

- `devices/<device_id>.json` — auth-token-hash, first-seen-at,
  last-seen-at, client-version. Phase 1 has at most one entry; Phase 2
  expands.

That's it for Phase 1. Other state (cursor, pairings, push endpoints)
lands in Phase 2+.

### Integration with the shim

The shim file `admin-shim/server.mjs` adds:

1. An `http` server `upgrade` listener for the `/shim/v1/mobile` path. WS
   library: node's built-in `ws` module... wait, no — node doesn't ship
   `ws`. We need a zero-dep WS server.

   Option: use the `ws` npm package as a *runtime-installed* dep in the
   mobile channel plugin's `runtime/` directory, following the same
   pattern Matrix plugin would have for `matrix-js-sdk` if we'd used one.
   This is a deliberate exception to zero-deps — node 20 doesn't have a
   built-in WS server.

   Alternative: implement a minimal WS server in 100 lines using the raw
   `http` upgrade event and the WS frame format. Possible but not worth
   the effort.

   **Decision:** ship `ws` as a runtime dependency. Document the
   exception in `DIVERGENCE.md`. Lock the version.

2. On WS upgrade, hand the socket to the mobile channel plugin's
   `acceptConnection(socket, request)` method.

3. The plugin parses `hello`, validates the token, looks up or creates
   the device record, replies `welcome`, then loops on incoming frames.

4. For `send_message`, the plugin calls the existing agent worker pool
   (`getAgentPool().get(convId, agentId)`) and writes the user JSON line
   to the worker's stdin — same code path as the REST chat handler.

5. Streamed frames out of the worker get re-shaped (same `reshapeFrame`
   logic as REST) and emitted to the WS as `turn_started`,
   `assistant_message`, `stop_reason`, `usage_statistics`. The shim's
   existing coalescing logic for the REST path lifts directly into the
   WS path.

The agent worker pool is shared between REST and channel paths. A user
chatting via the channel and then opening the same conv via REST (or
vice versa) hits the same warm worker. **This is the major win of having
the shim host the channel** — one pool, two transports.

### Mobile-side scope

A new module:

```
core/src/main/java/com/letta/mobile/data/channel/
├── ChannelTransport.kt        # WS connect, frame send/recv loop
├── ChannelProtocol.kt         # Frame data classes + serializer
├── ChannelConfig.kt           # Settings (URL, token, device_id)
└── ChannelChatSender.kt       # Sends user messages, exposes a Flow<UiMessage>
```

Wiring:

- `AdminChatViewModel` (or `TimelineSendCoordinator`) consults a settings
  flag `chat.transport = "rest" | "channel"`. Default: `"rest"`.
- When `"channel"`: route sends through `ChannelChatSender` instead of
  `MessageRepository.sendConversationMessage`.
- Everything else (conv list, blocks, models, agent CRUD) stays on REST.
  No change.

The `ChannelTransport` is foreground-only in Phase 1: connects on chat
screen open, disconnects on chat screen close. No persistent background
connection.

### Phase 1 acceptance criteria

1. Toggle "Use channel transport for chat" → `ChannelTransport` connects
   to `wss://shim-host:8291/shim/v1/mobile` with the configured token.
2. `welcome` frame arrives within 1s. WS stays open.
3. User sends a message → mobile receives `turn_started`,
   `assistant_message` (one), `stop_reason` within 5s under warm-pool
   conditions.
4. Mobile UI renders the reply identically to the REST/SSE path.
5. Toggle off → mobile falls back to REST transport, no regressions.
6. Worker pool stats show the same warm worker serving both transports.

### Phase 1 risks

| Risk | Mitigation |
|---|---|
| `ws` dep adds attack surface | Lock to a specific version; document; review the dep tree |
| Mobile WS disconnects on network change (cellular ↔ wifi) | Foreground-only means user reopens app on reconnect anyway. Reconnect logic lands in Phase 2. |
| Hard-coded token leaks in mobile settings backup | Acceptable in Phase 1 (development only). Phase 2 pairing fixes. |
| Mid-turn WS drop loses the reply | Acceptable in Phase 1. Phase 2 sync cursor fixes. |

## Phase 2 sketch: pairing, multi-conv, reconnect

When ready:

- **Pairing**: first connect with no token issues a `pairing_required` frame
  with a code; the user enters that code via a CLI or web admin to bind
  the device; the channel returns a long-lived token on next connect.
- **Multi-conv**: a single WS multiplexes many conversations via
  `conversation_id` in every frame. Adapter routes to the right worker
  pool slot per frame.
- **Sync cursor**: every server→client frame carries an `event_seq`.
  Mobile persists last seen. On reconnect, mobile sends a `resume`
  frame with the last seq; server replays missed frames from a
  bounded buffer (e.g. last 1000 events per device).
- **Disconnect handling**: server keeps the worker warm for N minutes
  after WS drops, in case the same device reconnects with `resume`.
- **Device record expands**: pairing approval, allowed agents, push
  registration placeholder.

Files involved on the channel side:

- `state/devices/<device_id>.json` (expanded)
- `state/cursor/<device_id>.json` (new)
- `state/pairings/<code>.json` (new, short-lived)

## Phase 3 sketch: server-pushed lifecycle + tools

The frame vocabulary grows:

- `typing` (channel → mobile, when an agent is processing)
- `reasoning_message` (channel → mobile, when the model emits reasoning)
- `tool_call_message` / `tool_return_message` (channel → mobile, mirrors
  vanilla)
- `agent_initiated_message` (channel → mobile, when an agent wakes up via
  cron / channel-originated trigger and decides the user should see it)
- `channel_event` (channel → mobile, for cross-channel awareness — e.g.,
  "your Matrix agent just replied to @admin in the #ops room")

Each is push-worthy or not per the taxonomy in Phase 4. In Phase 3 they
all flow over the open WS while mobile is foregrounded; the routing-to-OS-wake
side comes in Phase 4.

## Phase 4 sketch: push notifications

(Already designed in the planning conversation; capturing the gist here.)

- **UnifiedPush** primary, FCM optional. Channel posts a small "wake"
  payload to the device's push endpoint URL on push-worthy events. Mobile
  wakes, reconnects WS, drains via sync cursor, sleeps.
- Event taxonomy controls what's push-worthy. Default: agent reply,
  direct mention, agent-flagged urgent. Everything else pulls on next
  foreground.
- State expands: `state/push-registration/<device_id>.json`,
  `state/dispatch-log/<date>.jsonl`.
- **Strictly gated on Phase 2 (sync cursor) and Phase 3 (event taxonomy
  exists).** Cannot start before those.

## Phase 5 sketch: multi-device

- Two phones with the same user account → both see new agent messages.
- Server tracks "fan-out targets" per agent. When an event fires, the
  channel iterates over all active devices for the affected user, applies
  per-device push policy, fans out.
- Conv state stays single-source (one agent, one conv on disk); only the
  delivery fan-out is per-device.

## Phase 1 decisions (locked 2026-05-14)

All six approved by the user; recorded here as the binding contract for
the build. Future divergence requires explicit revisit.

| # | Decision | Locked answer |
|---|---|---|
| 1 | `ws` npm dep — exception to zero-deps | **Yes**, lock version, document in `DIVERGENCE.md` |
| 2 | Settings toggle visibility | **Dev-only** in Phase 1; promote to user-visible when Phase 3 lands |
| 3 | WSS vs WS | **WS (plain)** for Phase 1; WSS is a deployment concern not a Phase 1 build concern |
| 4 | `device_id` semantics | **Random UUID** on first launch, persisted in settings |
| 5 | Reconnect strategy Phase 1 | **Give up** on drop; foreground-only; user reopens chat |
| 6 | Worker pool sharing | **Same pool** for REST and channel — warm workers serve either transport |
