# Divergence from the vanilla Letta API

This shim's job is to expose a Letta-server-compatible HTTP API on top of
letta-code's `LocalBackend`. **Existing Letta clients (letta-mobile, the
Letta SDK, etc.) must work against this shim unchanged.** That's the
compatibility contract.

This document captures the places where we *intentionally* diverge from
vanilla, why, and what affordances we'd like to add later that clients can
**opt into** without breaking compat.

## Compatibility contract (what we promise)

- Every endpoint listed in the vanilla Letta server's `/v1/*` surface that
  the shim implements emits responses whose shape exactly matches vanilla's
  schema for that endpoint. JSON keys, types, nesting, casing — all match.
- Where the shim doesn't yet have data for a vanilla endpoint, it returns
  the vanilla success shape with empty values (`[]`, `0`, `null`) rather
  than 404 or any non-vanilla shape. Clients should be able to treat
  "empty" as "this server doesn't have any" and degrade gracefully.
- Stream framing for `POST /v1/conversations/{id}/messages` (and the
  agent-keyed equivalent) matches vanilla's SSE contract: `data:` lines
  only, vanilla-ordered frame types, bare-envelope `stop_reason` and
  `usage_statistics`, terminating `data: [DONE]`.

In short: **a client written against the Letta SDK against the Python Letta
server should be byte-for-byte happy against this shim.**

## Intentional divergence #1: server-side coalesced streaming

### Vanilla behavior

`POST /v1/conversations/{id}/messages` with `streaming: true` returns an
SSE stream. For each turn it emits, in order:

```
data: { ..., "message_type": "ping" }
data: { ..., "message_type": "reasoning_message", "reasoning": "..." }   (when applicable)
data: { ..., "message_type": "assistant_message", "content": "FULL REPLY TEXT" }
data: { "message_type": "stop_reason", "stop_reason": "end_turn" }
data: { "message_type": "usage_statistics", ... }
data: [DONE]
```

Critically: **one `assistant_message` frame per turn**, carrying the full
reply text as a single string. The Python Letta server buffers the LLM's
output server-side and emits it consolidated.

### What letta-code emits underneath

letta-code's `--output-format stream-json` emits the assistant reply as
*many* `assistant_message` frames — typically one per LLM-emitted chunk,
with each frame carrying a partial fragment of the reply. e.g. `"Mat"` →
`"rix is an open-stand"` → `"ard, decentralised proto"` → ... For a long
reply this can be 10–50 frames.

### Shim choice

The shim coalesces these chunks server-side: it buffers consecutive
`assistant_message` frames whose `otid` matches into a single accumulating
frame, and emits one `assistant_message` per turn — matching vanilla's
contract exactly. **The mobile client (and any other Letta SDK client)
sees what it expects: one bubble per assistant turn.**

This is the right default because:

- Mobile is built against vanilla's one-per-turn shape; chunked frames
  render as multiple separate bubbles otherwise.
- The Letta SDK's `LettaStreamingResponse` type expects one
  `assistant_message` per assistant turn.
- All existing Letta tooling expects the same.

### Cost

The end user does not see the reply progressively token-by-token. They
see "typing…" (via lifecycle events) and then the full reply arrives at
once. This is the same cost vanilla pays — the trade-off is intentional
because *vanilla also pays it*.

### What we'd like to add (affordance, not change)

There are two paths to richer streaming for clients that want it:

#### Path A: Opt-in delta channel via query parameter

Add `?stream_mode=chunked` to the streaming POST. When the client requests
this mode, the shim emits letta-code's native chunked `assistant_message`
frames (each carrying a content delta), plus a `stream_assistant_complete`
frame at end-of-turn carrying the full consolidated content.

Clients that pass the flag opt into chunked rendering; clients that don't
keep getting vanilla-shaped frames.

#### Path B: Separate SSE endpoint with a richer protocol

Add `POST /shim/v1/conversations/{id}/messages` (note the `/shim/` prefix
that namespaces our extensions). Emits a richer stream:

- `content_delta` frames per chunk
- `tool_call_start` / `tool_call_progress` / `tool_call_end` per tool
  invocation
- `reasoning_delta` per reasoning token
- `turn_complete` at end with consolidated message ids

This is the "letta-code native streaming" surface. Clients that want it
target the `/shim/` namespace; vanilla clients ignore it.

We have not built either yet. The current shim emits the vanilla shape on
the standard endpoint and nothing else.

## Intentional divergence #2: extended /v1/health/

Vanilla returns `{"version":"0.16.7","status":"ok"}`.

The shim returns those PLUS:

```json
{
  "version": "shim-0.2.0",
  "status": "ok",
  "server_id": "<persistent UUID>",
  "server_started_at": "2026-05-14T15:38:22.085Z",
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
  }
}
```

Extra fields are additive. Vanilla clients ignore them; new clients (or
updated mobile) can use `server_id` to bind their cache namespace and
self-invalidate when this server is replaced by a different one with the
same URL. See `STALE_AGENT_REF.md` (future) for the cache-invalidation
flow this enables.

The `capabilities.mobile_transport` block lets mobile distinguish this
admin-shim from strict Python Letta before attempting a WS upgrade. It also
states the canonical transport rule: after `/shim/v1/mobile` returns
`welcome`, WS is the live mutation transport for conversations owned by that
session; REST is cold-start/reconcile/repair, and SSE is legacy/non-canonical
for those mobile WS-owned conversations.

## Intentional divergence #3: shim-only endpoints

Endpoints under `/shim/*` are *not* part of the Letta API. They exist for
debugging and ops:

- `GET /shim/pool` — agent-pool stats: warm worker count, idle time,
  spawn time per slot.

We'd add more shim-only endpoints rather than expanding `/v1/*` with
non-standard surfaces, to keep the `/v1/*` namespace strictly vanilla.

## Intentional divergence #4: agent id aliases

A small table in the shim maps known legacy agent IDs (from earlier
migrator revisions or stale mobile caches) to their canonical current id,
so cached mobile state doesn't 404 when the migrator changes id schemes.
This is purely a transitional convenience and should be empty in a clean
deployment.

## Intentional divergence #5: WS-only cron mutations

Scheduled prompts ("crons") are an end-to-end shim feature. The shim
holds the scheduler lease, ticks every 60s, and routes due tasks
through the agent pool (`admin-shim/lib/cron-scheduler.ts`). The wire
protocol mirrors Letta Cloud's frame style — `cron_list` / `cron_add`
/ `cron_get` / `cron_delete` / `cron_delete_all` request/response
pairs plus a `crons_updated` push — but the **mutations live on the
WebSocket only**.

Vanilla Letta (when it adds cron) is expected to expose a full HTTP
CRUD surface for parity with its other resources. We deliberately do
not, for two reasons:

1. Per the saved memory `shim-new-features-mutations-ws-reads-may-mirror-rest`,
   any net-new feature in the shim funnels writes through
   `/shim/v1/mobile` to keep the WS-first contract intact. Cron is
   the first non-trivial feature added under that rule, and we'd
   rather not split it.
2. The mobile app is the only first-class write-side consumer today
   and already holds a long-lived WS, so a parallel POST/DELETE
   surface would add maintenance without a consumer.

REST mirrors the **read** side only:

| Route | Method | Returns |
|-------|--------|---------|
| `/v1/crons` | `GET` | `{ tasks: CronTask[] }` (filters: `?agent_id=` / `?conversation_id=`) |
| `/v1/crons/{id}` | `GET` | `CronTask` (404 if missing) |
| `/v1/crons/scheduler` | `GET` | `{ lease_held, owner_pid, started_at, tasks_active, … }` |

Any non-`GET`/`OPTIONS` method on these paths returns **HTTP 405**
with a body pointing at the WS protocol (`{ detail, ws_endpoint,
ws_frames }`). Curl-from-the-terminal still works for inspection;
write attempts get a precise pointer at the actual API.

A second deliberate divergence: **the shim does not register with the
Letta Cloud device service** for cron heartbeats. The bundled
`letta-code` CLI normally expects to phone home to a Cloud-hosted cron
listener; we keep all execution in-shim so the agent's state and
schedule live entirely on the local disk. This is one of the design
constraints behind the whole shim — see
`/opt/stacks/letta-code-parallel/docs/MOBILE_CHANNEL_DESIGN.md`.

Implementation:
- Store: `admin-shim/lib/crons.ts` (lock-aware CRUD on
  `$LETTA_HOME/crons.json` — same file the bundled `letta cron` CLI
  reads/writes, so the agent's own self-schedule skill interoperates).
- Scheduler: `admin-shim/lib/cron-scheduler.ts` (lease + 60s tick +
  fs.watch mtime).
- WS protocol: see `MOBILE_WS_PROTOCOL.md` §10 for the full frame
  catalog and `CronTask` schema.

## Intentional divergence #6: mobile canonical transport metadata

Strict Python Letta exposes REST + SSE only. The admin-shim additionally
exposes the mobile channel at `WS /shim/v1/mobile`, so updated mobile clients
need a deterministic way to select one live transport and avoid duplicate
timeline mutations.

The shim advertises this in two places:

| Surface | Contract |
| --- | --- |
| `GET /v1/health/` | Additive `capabilities.mobile_transport` block. Vanilla clients can ignore it. |
| `GET /shim/v1/capabilities` | Shim-native metadata endpoint with REST/SSE/WS roles. |
| WS `welcome` | `canonical_live_transport: "ws"` and `transport_contract` after a successful hello. |

Rule for mobile: once a socket successfully upgrades to `/shim/v1/mobile` and
receives `welcome`, that WS session is canonical for live mutations for the
conversations it owns. Do not also consume
`/v1/conversations/{id}/stream` for those conversations. REST `/messages`
remains the durable cold-start, post-turn reconciliation, and repair surface.

## What's NOT a divergence (and should stay that way)

- **Conversation list and detail responses** — same shape as vanilla.
- **Message shapes on `/v1/conversations/{id}/messages` GET** — same shape
  as vanilla (string content for the conv-listed view, structured fields
  for tool_call/tool_return).
- **Agent shape, block shape, models shape** — pinned to vanilla.

When in doubt, ALIGN, don't deviate. Adding fields is fine (clients
ignore them); changing existing field semantics is a contract break.

## Where future divergence will likely come from

These are the spots most likely to need shim-specific affordances:

1. **Chunked / richer streaming** (Path A or B above). Hold off until a
   client actually needs it.
2. **Server-pushed events** to mobile — channel-originated turns, agent
   heartbeats, multi-conversation activity notifications. Probably a
   shim-only WebSocket or long-poll endpoint, opt-in.
3. **Multi-agent fanout** — sending one message to N agents and getting
   N replies. Today mobile sends to one conv at a time; if the workflow
   becomes "broadcast a heads-up to all your agents", the shim might
   accept a list of conv ids in one POST.
4. **Tool-call approval flow** — vanilla's `approval_request_message` is
   passive (informational). For mobile-side approval UX we may want a
   roundtrip channel where mobile says "approved" / "denied".
5. **Background turn execution** — agent-initiated heartbeats / cron
   triggers should land in mobile somehow. Vanilla has no native path
   for this; we'll need a shim-side push channel.
6. **Pool / worker observability** — `/shim/pool` is the start; we may
   add per-conversation health checks, force-evict, restart-worker
   endpoints for ops.

When implementing any of these, the rule is: **add a new endpoint or
flag, never change the shape of an existing vanilla endpoint.** That's
how we keep `letta-mobile@vanilla` and `letta-mobile@shim-enhanced`
working off the same codebase indefinitely.

## Quick reference table

| Feature | Vanilla | Shim today | Notes |
|---|---|---|---|
| `/v1/health/` extra fields | none | `server_id`, `server_started_at`, `backend` | Additive, clients can ignore |
| `/v1/health/` mobile capability | none | `capabilities.mobile_transport` | Lets mobile detect admin-shim WS support |
| `/shim/v1/capabilities` | n/a | REST/SSE/WS role metadata | Shim-only discovery endpoint |
| WS `welcome` canonical transport | n/a | `canonical_live_transport: "ws"` | Suppress concurrent mobile SSE after welcome |
| Streaming chunked assistant | one frame per turn | one frame per turn (coalesced) | Matches vanilla |
| Streaming chunked tool calls | per-call frames | per-call frames | Matches vanilla |
| `stop_reason` envelope | bare | bare | Matches vanilla |
| `usage_statistics` envelope | bare | bare | Matches vanilla |
| Conversation id format | `conv-<uuid>` | `conv-default-<agentId>` for migrated defaults, `conv-<uuid>` for fresh | Slight shape difference; mobile parser is string-agnostic |
| Agent id aliases | n/a | maps legacy → canonical | Transitional; remove once mobile caches roll |
| `/shim/pool` | n/a | warm-worker stats | Shim-only |
| Native chunked streaming | n/a | future Path A or B | Not built yet |
| Server-pushed events to client | none | future shim WS | Not built yet |
