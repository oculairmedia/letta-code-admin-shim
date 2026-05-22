# Letta Code SDK Agent Pool Migration Beads

## Purpose

Create a bead-ready work plan for replacing the admin shim's hand-rolled Letta Code subprocess/session layer with `@letta-ai/letta-code-sdk`.

The goal is not to remove the admin shim. The shim still owns the Letta-server-compatible REST surface, mobile WS protocol, A2UI handling, run records, durable frame replay, and mobile-specific projections. The migration target is narrower: replace the lower-level subprocess transport and stream/control-protocol handling currently implemented in `admin-shim/lib/agent-pool.ts` and the legacy spawn path in `admin-shim/lib/chat.ts`.

## Current State

The admin shim currently does not use `@letta-ai/letta-code-sdk`.

Evidence:

- `admin-shim/package.json` has only `ws` as a runtime dependency.
- `admin-shim/lib/agent-pool.ts` directly spawns `LETTA_BIN` with `--backend local --input-format stream-json --output-format stream-json --include-partial-messages`.
- `admin-shim/lib/chat.ts` still contains a legacy per-request direct `spawn(process.env["LETTA_BIN"] || "letta", args, ...)` path behind `SHIM_POOL_DISABLE=1`.
- The shim manually parses stdout JSON lines, handles worker lifecycle, writes stdin frames, buffers stderr, maps raw frames to shim run records, and implements approval gating.

The installed SDK reviewed locally was `@letta-ai/letta-code-sdk@0.1.14` from `/opt/stacks/vibesync/node_modules/@letta-ai/letta-code-sdk`.

Important SDK behavior:

- `SubprocessTransport.connect()` resolves `@letta-ai/letta-code` or `LETTA_CLI_PATH`, then spawns `node <cliPath> ...args`.
- The SDK uses `--input-format stream-json --output-format stream-json`.
- `CreateSessionOptions.includePartialMessages` maps to `--include-partial-messages`.
- `resumeSession("conv-...")` resumes a specific conversation.
- `resumeSession(agentId)` resumes the agent's default conversation.
- `createSession(agentId)` creates a new conversation for an agent.
- `Session.send()` writes `{ type: "user", message: { role: "user", content } }` to stdin.
- `Session.stream()` yields transformed SDK messages.
- `Session.runTurn()` performs send plus stream-to-result and includes bounded approval-conflict recovery.
- `Session.listMessages()` and `Session.bootstrapState()` use the CLI control protocol rather than reading `messages.jsonl` directly.
- `Session.abort()` sends a control `interrupt` request.
- The SDK has typed error messages, retry messages, run IDs, image helpers, external tools, and permission callbacks.

Key compatibility gap to verify:

- The SDK's generated CLI args do not include the shim's explicit `--backend local`. It may rely on environment/default CLI behavior. The migration must prove it uses the intended local backend and `LETTA_LOCAL_BACKEND_DIR` before replacing the pool.

## Migration Rules

- Preserve the mobile/REST public contract first. SDK adoption is an internal implementation change unless a bead explicitly changes a contract.
- Do not let SDK run IDs leak directly as the authoritative mobile run IDs unless a bead explicitly proves the mapping. The shim's `/v1/runs/*` records are currently local compatibility records and mobile depends on them.
- Keep the existing frame projection tests and add SDK-parity tests before swapping production paths.
- Keep a feature flag until SDK-backed dispatch is proven by tests and one live smoke.
- Treat `lcp-cm5` conversation fragmentation as related but not automatically fixed by SDK migration. The SDK may help by using `resumeSession(convId)`, but the migration must prove conversation stability separately.
- Do not remove direct disk reads from REST endpoints until `Session.listMessages()` and `bootstrapState()` parity is proven for history shape, timestamps, tool turns, pagination, and performance.

## Proposed Bead Graph

Use `lcp-sdk` as the epic ID if available. Child IDs below are suggested.

Dependency order:

1. `lcp-sdk.1` SDK dependency and runtime compatibility audit.
2. `lcp-sdk.2` introduce a transport adapter seam and dual-path test harness.
3. `lcp-sdk.3` implement SDK-backed session worker behind a feature flag.
4. `lcp-sdk.4` preserve shim run records and frame replay over SDK events.
5. `lcp-sdk.5` port approval, permission, and user-action handling.
6. `lcp-sdk.6` migrate REST/SSE and mobile WS dispatch paths to the adapter.
7. `lcp-sdk.7` evaluate SDK `listMessages` and `bootstrapState` for history hydration.
8. `lcp-sdk.8` fix/prove conversation stability and close the `lcp-cm5` class of bugs.
9. `lcp-sdk.9` live smoke and rollback runbook.
10. `lcp-sdk.10` remove hand-rolled subprocess code and legacy flags.

## Epic

### ID

`lcp-sdk`

### Title

Replace hand-rolled agent-pool subprocess transport with Letta Code SDK

### Type

`epic`

### Priority

`P1`

### Description

The admin shim currently duplicates a large part of the public Letta Code SDK: it spawns the Letta Code CLI, manages stdin/stdout JSON streams, parses stream frames, tracks session readiness, handles control messages, surfaces stderr, queues turns, and implements lifecycle around a long-lived worker. The SDK is the public API for programmatic Letta Code control and already wraps the same CLI runtime.

This epic replaces the hand-rolled subprocess/session layer in `admin-shim/lib/agent-pool.ts` and the legacy spawn path in `admin-shim/lib/chat.ts` with `@letta-ai/letta-code-sdk`, while preserving all shim-owned public contracts:

- `/v1/runs/*` compatibility records.
- REST `/v1/agents/{id}/messages` and `/v1/conversations/{id}/messages`.
- `POST /v1/agents/{id}/messages` SSE behavior.
- Mobile WS `send_message`, streaming frames, `turn_started`, `turn_done`, cancellation, and replay.
- A2UI prompt injection, frame splitting, validation, approval cards, and `user_action` routing.
- Local backend state layout and message projection behavior.

### Non-Goals

- Replacing the REST compatibility shim with the real Letta server API.
- Replacing the mobile WS protocol.
- Replacing `runs.ts` as the mobile-facing run compatibility store.
- Rewriting A2UI.
- Removing direct disk history reads before SDK history parity is proven.

### Epic Acceptance Criteria

1. Production dispatch uses `@letta-ai/letta-code-sdk` for Letta Code process/session management by default.
2. Existing admin-shim tests pass, including HTTP, SSE, WS protocol, run tracking, approval, A2UI, and streaming suites.
3. The feature flag can switch back to the old direct subprocess path until cleanup lands.
4. A live smoke proves one text turn, one multi-step/tool turn, one approval turn, one A2UI turn, one cancellation, and one disconnect-mid-turn using the SDK path.
5. The SDK path uses the intended local backend and state directory.
6. Mobile-facing run IDs, frame replay, and message `run_id` attribution remain stable.
7. Conversation IDs remain stable across consecutive mobile turns on the same chat.
8. Legacy direct spawn code is removed only after the SDK path has shipped behind a flag and passed smoke.

## Child Beads

### lcp-sdk.1

### Title

Audit SDK runtime compatibility and add dependency

### Type

`task`

### Priority

`P1`

### Depends On

`lcp-sdk`

### Description

Add `@letta-ai/letta-code-sdk` to `admin-shim` and prove the SDK can drive the same Letta Code runtime as the current hand-rolled pool. The critical question is whether the SDK path respects the shim's local backend configuration without the explicit `--backend local` arg we pass today.

The SDK currently spawns `node <@letta-ai/letta-code> --input-format stream-json --output-format stream-json ...`. Our pool spawns `letta --backend local --input-format stream-json --output-format stream-json --include-partial-messages ...`.

### Design Notes

- Add SDK dependency to `admin-shim/package.json`.
- Prefer pinning the SDK version rather than a floating range until migration is complete.
- Verify whether `LETTA_LOCAL_BACKEND_EXPERIMENTAL=1`, `LETTA_LOCAL_BACKEND_DIR`, `LETTA_BASE_URL=http://127.0.0.1:0`, and unset cloud auth are sufficient for the SDK CLI path.
- Verify `LETTA_CLI_PATH` can force the same CLI binary currently addressed by `LETTA_BIN`.
- Document any required env changes in `admin-shim/README.md` or `env.example.sh`.
- Do not change production dispatch in this bead.

### Acceptance Criteria

1. `admin-shim` installs `@letta-ai/letta-code-sdk` and type-checks.
2. A focused test or script creates/resumes a session through the SDK against the project-local backend and receives an init frame with the expected agent and conversation.
3. The SDK-backed turn writes messages under the same `LETTA_LOCAL_BACKEND_DIR` expected by the shim.
4. `includePartialMessages: true` is verified to produce partial stream events equivalent to the current `--include-partial-messages` behavior.
5. The compatibility findings are documented, including whether `LETTA_CLI_PATH` or other env variables are required.
6. No production route changes behavior in this bead.

### Files Likely Touched

- `admin-shim/package.json`
- `admin-shim/package-lock.json`
- `admin-shim/README.md`
- `env.example.sh`
- `admin-shim/test/*`

### Verification

- `npm run typecheck`
- `npm run build`
- Focused SDK compatibility test or script

## lcp-sdk.2

### Title

Introduce a Letta session adapter seam above agent-pool

### Type

`task`

### Priority

`P1`

### Depends On

`lcp-sdk.1`

### Description

Create an internal adapter interface that isolates the rest of the shim from the concrete Letta Code transport implementation. The current `Worker` class mixes transport, run lifecycle, approval gating, frame transformation, disk stamping, and worker pooling in one file. The SDK migration needs a seam so the old and new implementations can be compared and swapped safely.

### Design Notes

Create an interface similar to:

```ts
export interface LettaTurnAdapter {
  readonly agentId: string;
  readonly conversationId: string;
  start(): Promise<LettaSessionInit>;
  runTurn(input: string | unknown[], options: AdapterRunTurnOptions): Promise<AdapterRunTurnResult>;
  abort(reason?: string): Promise<void>;
  close(): Promise<void> | void;
}
```

Adapter result shape should preserve raw data needed by the shim:

- Raw or normalized stream frames.
- Terminal result.
- stderr or SDK error detail.
- run IDs reported by Letta Code, if any.
- new user message ID, if known.
- child/session exit state.

Keep this adapter private to `admin-shim/lib` until stable.

### Acceptance Criteria

1. `agent-pool.ts` is refactored so the current direct subprocess implementation sits behind an adapter interface.
2. Public exports from `agent-pool.ts` remain compatible: `getAgentPool`, `cancelRun`, approval gate helpers, and pool stats.
3. No behavior changes are introduced.
4. Existing tests pass without enabling the SDK path.
5. The adapter contract is documented in code comments with explicit ownership boundaries.

### Files Likely Touched

- `admin-shim/lib/agent-pool.ts`
- `admin-shim/lib/types/letta-stream.ts`
- `admin-shim/test/worker-ttl.test.ts`
- `admin-shim/test/ws-protocol.test.ts`
- `admin-shim/test/streaming.test.ts`

### Verification

- `npm test`
- `npm run typecheck`
- `npm run build`

## lcp-sdk.3

### Title

Implement SDK-backed session adapter behind feature flag

### Type

`task`

### Priority

`P1`

### Depends On

`lcp-sdk.2`

### Description

Implement a second adapter that uses `@letta-ai/letta-code-sdk` for process/session management. Keep it disabled by default until parity beads land.

Suggested flag:

- `SHIM_LETTA_TRANSPORT=direct` for current behavior.
- `SHIM_LETTA_TRANSPORT=sdk` for SDK-backed sessions.

### Design Notes

SDK session selection rules must mirror current pool behavior:

- Internal conversation `"default"` plus `agentId` should map to `resumeSession(agentId, { ...options })`.
- Real `conv-...` conversation IDs should map to `resumeSession(convId, { ...options })`.
- Fresh new conversations should not be created accidentally in the send path.
- `includePartialMessages: true` must be set.
- `cwd`, `memfs`, `skillSources`, `systemInfoReminder`, `permissionMode`, and `memfsStartup` should be explicit if current behavior relies on them.

The SDK transforms messages. The adapter must decide whether to consume transformed SDK messages or raw stream events. Because the shim currently depends on raw Letta stream frames for projection and A2UI splitting, the first implementation should preserve raw `stream_event` payloads where possible.

### Acceptance Criteria

1. SDK adapter can initialize a session for `default` and for a real `conv-...` conversation.
2. SDK adapter can run a text-only turn and produce frames compatible with existing shim reshape/projection code.
3. SDK adapter can run with `includePartialMessages: true` and surface partial assistant/reasoning deltas.
4. Feature flag defaults to current direct adapter.
5. Tests can run both direct and SDK adapter paths for at least a basic text turn using the existing mock or a new SDK-specific fake.
6. SDK adapter closes sessions cleanly and does not leak subprocesses in tests.

### Files Likely Touched

- `admin-shim/lib/agent-pool.ts`
- `admin-shim/lib/letta-session-adapter.ts`
- `admin-shim/lib/letta-sdk-adapter.ts`
- `admin-shim/test/helpers/letta-mock.mjs`
- `admin-shim/test/harness-smoke.test.ts`

### Verification

- Focused adapter parity tests
- `npm run typecheck`
- `npm run build`

## lcp-sdk.4

### Title

Preserve shim Run records, frame replay, and message attribution on SDK path

### Type

`task`

### Priority

`P1`

### Depends On

`lcp-sdk.3`

### Description

The SDK may expose Letta Code run IDs, but mobile currently relies on shim-created `/v1/runs/*` records. Preserve the shim run lifecycle while using SDK sessions underneath.

Current behavior to preserve:

- `createRun()` allocates a mobile-facing `run-<uuid>` before or at turn start.
- `turn_started` can carry a non-null run ID before first assistant content.
- Every outgoing WS frame gets the shim run ID.
- Frames are appended to `state/runs/<run-id>/frames.jsonl` for replay.
- Newly persisted local messages are attributed to the shim run via `message_ids`.
- `finalizeRun()` records `status`, `stop_reason`, duration, usage, and step count.
- `buildMessageRunMap()` projects historical messages with run IDs.

### Design Notes

- Treat SDK run IDs as upstream metadata, not the primary mobile ID, unless a later decision bead changes that contract.
- Store SDK run IDs in `RunRecord.metadata.sdk_run_ids` or equivalent if useful for debugging.
- Preserve first-wins semantics for run-level `stop_reason` and `usage`.
- Ensure SDK transformed `result.runIds` and raw `stream_event` run IDs do not break stale-run filtering or frame grouping.
- If the SDK only yields transformed events for some message types, reconstruct the raw frame shape needed by existing `reshapeFrame` and A2UI code.

### Acceptance Criteria

1. SDK path creates exactly one shim run record per turn.
2. Mobile-facing frames carry the shim run ID, not a mix of SDK and shim IDs.
3. `/v1/runs/{id}`, `/messages`, `/usage`, `/metrics`, and `/steps` work for SDK-backed turns.
4. `frames.jsonl` replay works for SDK-backed mobile WS turns.
5. `buildMessageRunMap()` correctly attributes messages persisted by SDK-backed turns.
6. Existing run tests pass under direct path and focused equivalents pass under SDK path.

### Files Likely Touched

- `admin-shim/lib/runs.ts`
- `admin-shim/lib/agent-pool.ts`
- `admin-shim/lib/mobile-channel-host.ts`
- `admin-shim/test/runs.test.ts`
- `admin-shim/test/ws-subscribe.test.ts`
- `admin-shim/test/ws-protocol.test.ts`

### Verification

- `npm test -- test/runs.test.ts`
- `npm test -- test/ws-subscribe.test.ts`
- Focused SDK run lifecycle tests

## lcp-sdk.5

### Title

Port approvals, permission callbacks, and A2UI user actions to SDK path

### Type

`task`

### Priority

`P1`

### Depends On

`lcp-sdk.4`

### Description

The current hand-rolled pool intercepts `approval_request_message` frames and blocks tool execution until the mobile WS user action resolves the approval gate. The SDK also has `canUseTool`, `permissionMode`, and approval-conflict recovery behavior. We need one coherent approval model on the SDK path.

### Design Notes

Current shim behavior:

- Approval requests are surfaced to mobile as A2UI approval cards.
- A pending approval gate is keyed by shim run ID and tool call ID.
- Mobile `user_action` resolves the gate with Once, Session, Forever, or Deny.
- Session and Forever decisions persist in `approvals.json`.
- Approval decisions append audit records under the run sidecar.
- Non-approval A2UI user actions can inject synthetic user turns.

Potential SDK mapping:

- Use SDK `canUseTool` to block tool execution.
- Convert `canUseTool(toolName, input)` into the existing approval gate.
- Preserve the existing mobile A2UI approval card frame shape.
- Continue recording decisions through `runs.ts`.
- Disable or bound SDK automatic approval recovery if it conflicts with explicit mobile approvals.

### Acceptance Criteria

1. SDK path emits mobile approval cards for tools requiring approval.
2. Mobile Once approval allows exactly the pending tool call.
3. Session approval auto-allows later calls to the same tool in the same conversation.
4. Forever approval auto-allows later calls across conversations.
5. Deny blocks the tool and returns an error to the agent without executing the tool.
6. Approval timeout auto-denies and records an audit entry.
7. Existing non-approval A2UI `user_action` injection still triggers a synthetic agent turn.
8. Approval behavior is documented with the SDK mapping and any disabled SDK recovery settings.

### Files Likely Touched

- `admin-shim/lib/agent-pool.ts`
- `admin-shim/lib/mobile-channel-host.ts`
- `admin-shim/lib/runs.ts`
- `admin-shim/docs/MOBILE_WS_PROTOCOL.md`
- `admin-shim/test/a2ui-ws.test.ts`
- `admin-shim/test/ws-protocol.test.ts`

### Verification

- Focused approval tests under SDK path
- Existing A2UI WS tests
- Full `npm test`

## lcp-sdk.6

### Title

Migrate REST/SSE and mobile WS dispatch paths to session adapter

### Type

`task`

### Priority

`P1`

### Depends On

`lcp-sdk.5`

### Description

Switch all send paths from direct pool internals to the new adapter seam. This includes REST/SSE chat dispatch and mobile WS `send_message`.

### Design Notes

Affected paths:

- `POST /v1/agents/{id}/messages` in `admin-shim/lib/chat.ts`.
- `POST /v1/conversations/{id}/messages` in `admin-shim/server.ts` via `sendMessage`.
- Mobile WS `send_message` via `bridgeSendMessage`.
- Synthetic A2UI user-action turns.
- Cron/background turns if they use `bridgeSendMessage`.

Keep direct path available through `SHIM_LETTA_TRANSPORT=direct` until cleanup.

### Acceptance Criteria

1. `SHIM_LETTA_TRANSPORT=sdk` routes REST/SSE sends through the SDK adapter.
2. `SHIM_LETTA_TRANSPORT=sdk` routes mobile WS sends through the SDK adapter.
3. SSE output preserves existing ordering: ping, reasoning/tool/assistant, stop_reason, usage, DONE.
4. WS output preserves existing protocol envelopes and `turn_done` timing.
5. Background/cron turns still mark runs as `background: true`.
6. `SHIM_LETTA_TRANSPORT=direct` remains functional as a rollback path.

### Files Likely Touched

- `admin-shim/lib/chat.ts`
- `admin-shim/lib/mobile-channel-host.ts`
- `admin-shim/lib/crons.ts`
- `admin-shim/server.ts`
- `admin-shim/test/streaming.test.ts`
- `admin-shim/test/ws-protocol.test.ts`
- `admin-shim/test/crons-ws.test.ts`

### Verification

- REST/SSE focused tests with SDK flag
- Mobile WS focused tests with SDK flag
- Cron/background focused tests if applicable

## lcp-sdk.7

### Title

Evaluate SDK listMessages/bootstrapState for history hydration

### Type

`task`

### Priority

`P2`

### Depends On

`lcp-sdk.3`

### Description

The SDK exposes `Session.listMessages()` and `Session.bootstrapState()` over the Letta Code control protocol. Evaluate whether these can replace direct `messages.jsonl` reads in the shim history endpoints, or whether the shim should continue reading disk for mobile projection.

### Design Notes

Do not switch history endpoints blindly. The shim currently performs important projection work:

- Normalizes old and new local message shapes.
- Fans out tool calls and tool results into vanilla Letta message rows.
- Applies real timestamp sidecars.
- Applies mobile OTID sidecars.
- Filters in-flight message IDs during active WS streams.
- Applies shim run ID attribution.

SDK `listMessages()` returns raw Letta API message objects in requested order. We must compare that output against the current REST projection.

### Acceptance Criteria

1. Add a comparison test that runs current disk projection and SDK `listMessages()` for the same conversation.
2. Document differences in shape, timestamps, tool rows, pagination, OTIDs, and run IDs.
3. Decide one of:
   - Keep disk projection as authoritative for mobile history.
   - Use SDK history as source data but still pass through shim projection.
   - Replace disk projection for selected endpoints only.
4. No endpoint behavior changes unless the decision and tests explicitly support it.
5. If SDK history is not adopted, document why and keep the bead closed as an evaluation.

### Files Likely Touched

- `admin-shim/lib/store.ts`
- `admin-shim/lib/translate.ts`
- `admin-shim/server.ts`
- `admin-shim/test/http-contract.test.ts`
- `admin-shim/test/onfdisk-translate.test.ts`

### Verification

- History comparison test
- Existing HTTP contract tests

## lcp-sdk.8

### Title

Prove SDK path fixes or preserves conversation stability

### Type

`bug`

### Priority

`P1`

### Depends On

`lcp-sdk.6`

### Related

`lcp-cm5`

### Description

The shim has an open conversation fragmentation bug: repeated mobile turns can create or target fresh conversation files instead of appending to one stable conversation. SDK migration must not preserve that failure mode. It may fix it if `resumeSession(convId)` reliably binds the CLI to the intended conversation.

### Design Notes

Use the existing `lcp-cm5` examples as regression data:

- History split across many conversations for the same agent.
- `conv-bb27ff60-...` is one current mobile view.
- Mobile shows whichever conversation is freshest, leaving older history invisible.

The SDK path should explicitly select `resumeSession(convId)` for real conversation IDs and `resumeSession(agentId)` only for default conversations.

### Acceptance Criteria

1. A test sends three consecutive mobile WS turns to the same real `conv-...` ID under SDK transport.
2. All three user messages and assistant replies land in the same conversation.
3. No new conversation directory is created for that sequence.
4. `GET /v1/conversations` returns one stable updated conversation entry, not a new freshest conversation each turn.
5. The same stability test passes across worker restart or session close/reopen.
6. If SDK path does not fix `lcp-cm5`, file a narrower follow-up explaining the remaining resolver/local-backend cause.

### Files Likely Touched

- `admin-shim/lib/mobile-channel-host.ts`
- `admin-shim/lib/store.ts`
- `admin-shim/lib/agent-pool.ts`
- `admin-shim/test/ws-protocol.test.ts`
- `admin-shim/test/http-contract.test.ts`

### Verification

- Focused conversation stability test
- Manual disk inspection during smoke

## lcp-sdk.9

### Title

Add live SDK transport smoke test and rollback runbook

### Type

`task`

### Priority

`P1`

### Depends On

`lcp-sdk.6`
`lcp-sdk.8`

### Description

Before making SDK transport the default, add a live smoke checklist and rollback runbook. This is necessary because the migration crosses process lifecycle, local backend routing, approval behavior, and mobile transport timing.

### Smoke Coverage

The smoke must cover:

- Text-only REST/SSE turn.
- Text-only mobile WS turn.
- Multi-step/tool turn.
- Approval-required tool turn.
- A2UI surface and non-approval `user_action`.
- Cancellation through `/v1/agents/{id}/messages/cancel` or mobile WS cancel.
- Disconnect mid-turn, with run finalizing to disk.
- Reconnect/replay from `frames.jsonl`.
- Conversation list after multiple turns.

### Acceptance Criteria

1. A documented smoke script or runbook exists under `admin-shim/docs` or `scripts`.
2. The smoke can be run with `SHIM_LETTA_TRANSPORT=sdk`.
3. The smoke records expected commands, expected responses, and failure triage.
4. Rollback is documented as setting `SHIM_LETTA_TRANSPORT=direct` and restarting the shim.
5. Known SDK-specific diagnostics are documented, including `DEBUG_SDK`, `LETTA_CLI_PATH`, `LETTA_LOCAL_BACKEND_DIR`, and stderr collection.
6. Smoke is run once and the result is recorded in the bead close reason.

### Files Likely Touched

- `admin-shim/docs/SDK_TRANSPORT_SMOKE.md`
- `admin-shim/README.md`
- Optional `admin-shim/scripts/smoke-sdk-transport.mjs`

### Verification

- Manual smoke
- `npm test`
- `npm run build`

## lcp-sdk.10

### Title

Remove direct subprocess implementation after SDK transport is default

### Type

`task`

### Priority

`P2`

### Depends On

`lcp-sdk.9`

### Description

After SDK transport has passed tests and live smoke, remove the old direct subprocess implementation and any dead compatibility branches.

### Design Notes

Remove only after the SDK path has run as default long enough to be safe. If operations still want a rollback, keep the old path for one release window and split this bead into cleanup part 1 and part 2.

Cleanup candidates:

- Direct `spawn(LETTA_BIN, args)` worker implementation.
- Legacy `POOL_ENABLED` disabled path in `chat.ts` if it is no longer used.
- `LETTA_BIN` env documentation if replaced by `LETTA_CLI_PATH`.
- Mock assumptions that depend on direct spawn if tests now mock the SDK adapter.

### Acceptance Criteria

1. SDK transport is the only production Letta Code process/session implementation.
2. No direct `spawn(LETTA_BIN` or direct `spawn(process.env["LETTA_BIN"] || "letta"` remains in production code.
3. Tests no longer rely on implementation details of the deleted direct worker.
4. README/env docs refer to SDK configuration and `LETTA_CLI_PATH`.
5. Full test suite, typecheck, and build pass.

### Files Likely Touched

- `admin-shim/lib/agent-pool.ts`
- `admin-shim/lib/chat.ts`
- `admin-shim/test/helpers/letta-mock.mjs`
- `admin-shim/README.md`
- `env.example.sh`

### Verification

- `rg -n "LETTA_BIN|spawn\\(|--backend local|--output-format" admin-shim/lib admin-shim/server.ts`
- `npm test`
- `npm run typecheck`
- `npm run build`

## Optional Decision Beads

### lcp-sdk-decide-runid

### Title

Decision: keep shim run IDs or adopt SDK/Letta Code run IDs on mobile

### Type

`decision`

### Priority

`P2`

### Context

The SDK surfaces run IDs from Letta Code results and stream messages. The shim already creates local run IDs and serves `/v1/runs/*` from its own store. Mixing these IDs caused earlier diagnostic confusion when a shim run ID was queried against the real Letta API.

### Recommendation

Keep shim run IDs as the mobile-facing IDs for now. Store SDK run IDs as metadata for debugging. Revisit only if Letta Code SDK offers a full `/v1/runs/*` equivalent or a stable API for run lookup.

### Acceptance Criteria

1. Decision is documented.
2. Tests assert mobile-facing frames and `/v1/runs/*` use the same shim run ID.
3. If SDK run IDs are stored, they are clearly named as upstream metadata and never accepted by `/v1/runs/{id}` unless explicitly mapped.

## Suggested bd Create Order

If using explicit IDs:

```bash
bd create "Replace hand-rolled agent-pool subprocess transport with Letta Code SDK" --id lcp-sdk --type epic --priority 1 --description-file docs/letta-code-sdk-agent-pool-migration-beads.md
bd create "Audit SDK runtime compatibility and add dependency" --id lcp-sdk.1 --type task --priority 1 --parent lcp-sdk
bd create "Introduce a Letta session adapter seam above agent-pool" --id lcp-sdk.2 --type task --priority 1 --parent lcp-sdk --deps lcp-sdk.1
bd create "Implement SDK-backed session adapter behind feature flag" --id lcp-sdk.3 --type task --priority 1 --parent lcp-sdk --deps lcp-sdk.2
bd create "Preserve shim Run records, frame replay, and message attribution on SDK path" --id lcp-sdk.4 --type task --priority 1 --parent lcp-sdk --deps lcp-sdk.3
bd create "Port approvals, permission callbacks, and A2UI user actions to SDK path" --id lcp-sdk.5 --type task --priority 1 --parent lcp-sdk --deps lcp-sdk.4
bd create "Migrate REST/SSE and mobile WS dispatch paths to session adapter" --id lcp-sdk.6 --type task --priority 1 --parent lcp-sdk --deps lcp-sdk.5
bd create "Evaluate SDK listMessages/bootstrapState for history hydration" --id lcp-sdk.7 --type task --priority 2 --parent lcp-sdk --deps lcp-sdk.3
bd create "Prove SDK path fixes or preserves conversation stability" --id lcp-sdk.8 --type bug --priority 1 --parent lcp-sdk --deps lcp-sdk.6 --deps lcp-cm5
bd create "Add live SDK transport smoke test and rollback runbook" --id lcp-sdk.9 --type task --priority 1 --parent lcp-sdk --deps lcp-sdk.6,lcp-sdk.8
bd create "Remove direct subprocess implementation after SDK transport is default" --id lcp-sdk.10 --type task --priority 2 --parent lcp-sdk --deps lcp-sdk.9
bd create "Decision: keep shim run IDs or adopt SDK/Letta Code run IDs on mobile" --id lcp-sdk-decide-runid --type decision --priority 2 --deps lcp-sdk.3
```

Depending on local `bd` syntax, repeated `--deps` may need to be collapsed into comma-separated values.

## Review Checklist For The Implementing Agent

- Confirm SDK package version before coding. The reviewed local version was `0.1.14`.
- Inspect current SDK `dist/transport.d.ts`, `dist/session.d.ts`, and README after install in this repo.
- Re-check SDK CLI args. If the SDK gains a `backend` option in a newer version, prefer that over env-only routing.
- Keep the old transport until SDK path passes focused tests and smoke.
- Do not skip conversation stability tests.
- Do not replace message history endpoints with SDK output until projection parity is proven.
- Treat any run ID mismatch as a release blocker.
- Record SDK stderr and typed SDK errors in shim logs; do not regress debuggability.

