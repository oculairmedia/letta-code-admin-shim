# SDK history hydration evaluation (lcp-sdk.7)

Question: should the shim's history endpoints (`GET /v1/agents/{id}/messages`,
`GET /v1/agents/{id}/context`, `GET /v1/conversations/{id}/messages`)
switch from direct `messages.jsonl` reads to the SDK's
`Session.listMessages()` / `Session.bootstrapState()` over the Letta
Code control protocol?

**Decision (2026-05-22): no.** Keep `messages.jsonl` + sidecars as
authoritative. Reasoning + comparison below.

## What SDK history actually returns

Both `listMessages()` and `bootstrapState().messages` come back as `unknown[]`
— "raw Letta API message objects" per the SDK type docs. The CLI's
`list_messages` control response is the same payload the CLI would return
over a hypothetical Python-Letta-server `GET /v1/agents/{id}/messages` —
single records per LocalMessage, no projection, no run-id attribution,
no client-side sidecars.

Surface: see [`@letta-ai/letta-code-sdk` types.d.ts:488-555](../node_modules/@letta-ai/letta-code-sdk/dist/types.d.ts).

```
listMessages(opts?: { conversationId?; before?; after?; order?; limit? })
  → { messages: unknown[], nextBefore?: string | null, hasMore?: boolean }

bootstrapState(opts?: { limit?; order? })
  → { agentId, conversationId, model, tools, memfsEnabled,
       messages, nextBefore, hasMore, hasPendingApproval, timings? }
```

## What the shim's history endpoints do today

The disk reads in `lib/store.ts::listMessages` and the projection layer
in `lib/translate.ts::localMessageToConversationMessages` together apply
six transformations that SDK history cannot reproduce:

1. **Schema normalization** — old `parts`-shaped and new `content`-shaped
   LocalMessage records normalize through `normalizeMessage`. The
   post-migration transcripts are mixed on disk; the shim has to handle
   both forms transparently. (`lib/store.ts:228-…`)

2. **In-flight filter (lcp-r0m)** — drop assistant/tool messages whose
   id belongs to an active run that hasn't finalized. Without this,
   `GET /messages` races the live WS stream and mobile sees partial
   tool calls twice (once from REST, once from WS replay).
   (`lib/runs.ts::inFlightMessageIds`)

3. **Real-time sidecar (lcp-dfz)** — `_real-times.json` overlays real
   ISO wallclock onto records whose `created_at` is the Jan-1
   `2026-01-01T01:13:27.000Z` sentinel that letta-code's LocalStore
   writes. Without the overlay, conversation lists show all messages
   on Jan 1. (`lib/store.ts::readMessageTimestamps`)

4. **OTID sidecar** — `_otid-map.json` carries mobile-supplied otids
   onto the projected message rows so client-side optimistic UI can
   reconcile with server-confirmed messages. (`lib/store.ts::readOtidMap`)

5. **Shim run-id attribution (lcp-nwd)** — each projected message
   carries the shim's `run-<uuid>` (NOT the upstream `local-run-N`).
   `buildMessageRunMap` walks the runs index to map message id → run id
   so `/v1/runs/{id}/messages` and the conversation REST views agree.
   (`lib/runs.ts::buildMessageRunMap`)

6. **Tool fan-out (lcp-cox)** — `localMessageToConversationMessages`
   splits one LocalMessage with `tool_calls` + tool results into the
   vanilla Letta wire shape: separate `tool_call_message` and
   `tool_return_message` rows. The SDK's raw output preserves the
   single-record form, which mobile's vanilla-Letta-shaped renderer
   doesn't understand. (`lib/translate.ts`)

The shim's `localMessageToConversationMessages` is the authoritative
projection layer. It's tested by `test/onfdisk-translate.test.ts` +
`test/http-contract.test.ts` (~30 assertions covering tool fan-out,
sidecars, role mapping, attribution).

## Comparison table

| Concern | Disk + projection (today) | SDK listMessages |
|---|---|---|
| Mixed `parts`/`content` shapes | ✓ normalized | ✗ raw — caller normalizes |
| In-flight message filter | ✓ active-runs gate | ✗ no gate — race with live stream |
| Jan-1 sentinel overlay | ✓ real-times sidecar | ✗ sentinel surfaces verbatim |
| Mobile otid attribution | ✓ otid sidecar | ✗ not surfaced |
| Shim run-id attribution | ✓ `run-<uuid>` | ✗ raw `local-run-N` |
| Tool fan-out to vanilla wire shape | ✓ split into rows | ✗ single record |
| Pagination | by-disk-index, `before` cursor | `before`/`after`/`limit` |
| Round-trip cost | one file read | one control_request per call (CLI must be alive) |
| Source of truth | disk (LocalBackend writes it) | CLI (which reads the same disk) |

The SDK reads the same disk anyway, via the CLI. The only thing
listMessages buys us is a different consumer surface (control protocol
vs file read) — at the cost of requiring an active SDK session per
read, plus reimplementing all six projection layers on top.

## `bootstrapState` specifically

`bootstrapState` is `initialize() + listMessages() + a few flags` in one
round-trip:

- `agentId`, `conversationId`, `model`, `tools`, `memfsEnabled` — already
  resolved by the shim from the agent's on-disk record. No round-trip
  saved.
- `hasPendingApproval` — the shim already tracks pending approval gates
  per-run in memory via `lib/runs.ts::approvalGates`. Mobile reconnect
  via `subscribe(run_id, cursor)` replays the `approval_request_message`
  frame from `state/runs/<id>/frames.jsonl`. The bit is redundant with
  what the WS surface already provides.
- `messages` — same `listMessages` payload, same projection gap.

Net: `bootstrapState` saves a notional second round-trip that the shim
doesn't currently make.

## When to revisit

Three things would flip the decision:

1. **SDK projection layer.** If `@letta-ai/letta-code-sdk` adds a
   helper that emits vanilla-Letta-shaped projected messages
   (tool fan-out + role mapping) directly, comparison becomes worth
   running — we'd evaluate whether to delete the local projection
   and trust upstream.
2. **Remote-Letta upstream proxy (lcp-9he epic).** If the shim ever
   proxies to a real Letta server (not a local CLI), SDK history would
   eliminate a disk-read pathway that doesn't exist on that side. Until
   the proxy mode ships, this is moot.
3. **Disk-format churn we can't keep up with.** If LocalBackend's
   on-disk schema starts changing faster than the shim's normalizer
   can track, SDK history would become the path of least maintenance —
   at the cost of duplicating the projection layer.

None of these conditions hold today.

## Verification snippet (for future revisits)

To compare disk projection vs SDK history against a **live letta-code
binary** (the mock CLI doesn't implement the `list_messages` control
protocol), run something like:

```js
import { resumeSession } from "@letta-ai/letta-code-sdk";
import { listMessages as diskListMessages } from "/opt/stacks/letta-code-parallel/admin-shim/dist/lib/store.js";
import { localMessageToConversationMessages } from "/opt/stacks/letta-code-parallel/admin-shim/dist/lib/translate.js";
import { readMessageTimestamps, readOtidMap } from "/opt/stacks/letta-code-parallel/admin-shim/dist/lib/store.js";

const agentId = process.env.AGENT_ID;
const convId  = process.env.CONV_ID || "default";

const session = resumeSession(convId === "default" ? agentId : convId, {
  includePartialMessages: true,
  canUseTool: async () => ({ behavior: "allow" }),
});
await session.initialize();

const sdkPage = await session.listMessages({ limit: 50 });
const diskRaw = await diskListMessages(convId, agentId, { limit: 50 });
const realTimes = await readMessageTimestamps(convId, agentId);
const otidMap = await readOtidMap(convId, agentId);
const projected = diskRaw.flatMap((m) => localMessageToConversationMessages(m, { realTimes, otidMap, runIdsByMessageId: new Map() }));

console.log("sdk count:",     sdkPage.messages.length);
console.log("disk projected:", projected.length);
console.log("sample sdk[0]:",     JSON.stringify(sdkPage.messages[0], null, 2).slice(0, 800));
console.log("sample disk[0]:",    JSON.stringify(projected[0],        null, 2).slice(0, 800));

session.close();
```

Expected differences (re-confirming the decision):

- `sdkPage.messages.length` < `projected.length` because tool turns are
  one SDK message but two projected rows.
- `projected[i].date` is the real ISO timestamp; `sdkPage.messages[i].date`
  carries the Jan-1 sentinel on records that LocalBackend stamped
  pre-`_real-times.json`.
- `projected[i].run_id` is `run-<uuid>`; SDK's analog is `local-run-N`
  (the upstream id, not the shim's).
- `projected[i].otid` is set on assistant rows that mobile authored;
  SDK doesn't surface otids at all.

If those differences disappear in a future SDK release, run this
comparison again and reconsider.
