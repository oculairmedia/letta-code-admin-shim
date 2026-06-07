# Server-Side Permissions Model — Design (lcp-indw, PHASE 1)

Status: **DESIGN — awaiting Phase 2 green-light.** No implementation in this bead yet.
Epic: lcp-456u (shim capability epic). First real feature.

## 0. TL;DR / key decisions up front

- **`default: allow`** is baked into the data-model default (per Emmanuel). A
  tool not matched by any rule is **allowed**. Restriction is opt-in. This is
  documented in the schema, enforced in the evaluator default, and asserted by
  a dedicated regression test.
- **WS frames are canonical; REST is a thin mirror.** The durable pending-
  approval store + the `approval_request_message` frame already persisted to
  `frames.jsonl` are the source of truth. REST approval endpoints read/write
  that same persisted state — never a second store.
- **The hard part is the `ask` path, and the existing in-memory gate is NOT
  durable.** Today's approval gate (`approvalGates` Map + `waitForApprovalDecision`
  in `agent-pool.ts`) is in-process with a 30s timeout. It does **not** survive
  reconnect-with-no-client, app backgrounding past 30s, or shim restart. This
  bead's load-bearing work is replacing that with a durable, replayable store.
- **Prefix-match deny is a UX guardrail, NOT a security boundary.** Documented
  explicitly below. Trivially bypassed (`Bash(rm -rf:*)` → `bash -c 'rm -rf'`).
- The natural interception point already exists: `SdkBackedLettaSessionAdapter._handleCanUseTool`
  in `lib/letta-sdk-adapter.ts`. The SDK invokes it before every tool call.
  This is where rule evaluation slots in, replacing the current
  `bypassPermissions`-by-default short-circuit.

---

## 1. Persisted state shapes & on-disk locations

All shim state lives under `storageDir()` =
`LETTA_LOCAL_BACKEND_DIR || $LETTA_HOME/lc-local-backend` (see `runs.ts`).
Two new concerns: **permissions config** and the **durable pending-approval store**.

### 1.1 Permissions config

Global fallback — single file, mirrors the `crons.json`/`approvals.json` pattern:

```
<storageDir>/permissions.json          # global fallback
<storageDir>/permissions/<agentId>.json # per-agent overrides (sharded, one file per agent)
```

Per-agent sharding (one file per agent) matches the runs.ts "one dir per run"
rationale: avoids a global read-modify-write race when two agents' permissions
are edited concurrently, and keeps each PUT touching exactly one file.

On-disk shape (identical for global and per-agent):

```jsonc
{
  "version": 1,
  "default": "allow",          // <-- PRODUCT DECISION: default action when no rule matches
  "rules": [
    { "tool": "Bash(rm -rf:*)", "action": "deny",  "reason": "destructive; guardrail only" },
    { "tool": "Bash(git:*)",    "action": "allow", "reason": "" },
    { "tool": "Bash",           "action": "ask",   "reason": "review shell commands" },
    { "tool": "*",              "action": "allow", "reason": "" }
  ],
  "updated_at": "2026-06-07T...Z"
}
```

- `version`: schema version (currently `1`). Unknown/missing version → treated
  as empty config (default-allow), never throws.
- `default`: `"allow" | "ask" | "deny"`. **Defaults to `"allow"`** when the file
  is absent or the field is missing. This is the single most important default
  in the feature and is enforced in the evaluator, not just the file.
- `rules`: ordered list. **First matching rule wins, top-to-bottom.**
- `reason`: optional human string surfaced in the approval card / deny frame.

**Resolution order at evaluation time:** per-agent rules are consulted first; if
no per-agent rule matches, the global rules are consulted; if neither matches,
the **effective default** applies. Open question (D1 below): whether the
effective default is the per-agent file's `default` (if the per-agent file
exists) or always the global `default`. Recommendation: per-agent `default`
wins when a per-agent file exists, else global `default`, else hardcoded
`"allow"`.

Writes use the same atomic tmp+rename used by `writeCronFile`
(`writeFileSync(tmp); renameSync(tmp, path)`). Because permissions are
read-modify-write on PUT/PATCH, a **single serialized writer** is required —
see §1.3.

### 1.2 Durable pending-approval store (the load-bearing piece)

The existing `approvalGates` Map is the in-memory rendezvous between the parked
turn and the inbound decision. It is correct for the *live* case but is the
**only** record of "a turn is waiting" — nothing on disk says so, so a restart
or a >30s client gap loses it.

New durable store: **one file per pending approval**, keyed by runId, so writes
never contend (single-writer-per-run already holds — turns are serialized per
worker):

```
<storageDir>/runs/<runId>/pending-approval.json
```

Co-locating under the run dir means it travels with `frames.jsonl` and is swept
by the existing run-compaction/delete machinery for free. Shape:

```jsonc
{
  "run_id": "run-...",
  "agent_id": "agent-...",
  "conversation_id": "conv-...",
  "tool_call_id": "synthetic-...",   // synthetic id (SDK limitation, see §7)
  "tool_name": "Bash",
  "tool_input": { "command": "..." },
  "reason": "review shell commands",  // from the matched rule
  "rule_source": "agent" | "global" | "default",
  "status": "pending" | "approved" | "denied" | "expired",
  "created_at": "2026-06-07T...Z",
  "decided_at": null,
  "decided_by": null,                 // userId / deviceId if supplied
  "decision_reason": null
}
```

**Lifecycle & durability:**

1. On `ask`, the evaluator writes `pending-approval.json` with `status:"pending"`
   **before** parking the turn, and emits the canonical `approval_request_message`
   frame (which `appendRunFrame` already persists to `frames.jsonl` — so the card
   itself is already replayable today).
2. The turn parks on a durable wait (§3) keyed by runId.
3. A decision (from WS user_action OR REST) rewrites the file with
   `status:"approved"|"denied"` + `decided_at` and resolves the wait.
4. `finalizeRun` / turn end clears or finalizes the file.

**Survives restart:** on boot the shim scans `runs/*/pending-approval.json`
for `status:"pending"`. Each represents a turn that was parked when we died.
Because the parked turn's *subprocess* (the letta-code CLI session) also died
with us, the turn cannot actually resume tool execution — so the honest
behavior is: **on restart, mark surviving `pending` approvals as `expired`**,
append a synthetic terminal frame to that run's `frames.jsonl` (so a reconnecting
client sees a resolved/expired card, not an eternal spinner), and finalize the
run as failed/expired. The durability guarantee we can actually honor is
"no pending approval is silently lost / no eternal spinner", NOT "the half-run
tool call resumes after a restart" (that would require CLI-session durability we
don't have). This is called out as risk R1.

**Survives WS reconnect / backgrounding / two clients:** the gate wait is
process-resident but **no longer has a 30s hard timeout** (see §3) — it lives as
long as the turn lives. The card is replayed from `frames.jsonl` via the
existing `subscribeToRun(runId, cursor)` path; the *decision* can arrive later
from any client over WS or REST and resolves the same in-memory wait + rewrites
the same file.

### 1.3 Single serialized writer

Reuse the proven `withLock()` mkdir-lock primitive pattern from `crons.ts`
(`acquireLock`/`withLock`), but with a **separate lock dir** so permissions
writes don't contend with cron writes:

```
<storageDir>/permissions.lock/owner.json
```

Used for read-modify-write on the global `permissions.json` and on each
per-agent file (PUT/PATCH). The pending-approval files are one-per-run and
single-writer-per-run, so they do NOT need the lock — they use atomic
tmp+rename only, matching how `runs.ts` writes run.json/frames.jsonl without a
global lock.

---

## 2. Mapping to existing WS approval frames (WS-canonical / REST-mirror)

### 2.1 What already exists (studied, not assumed)

- **Frame:** `approval_request_message` is a real wire frame. The SDK adapter
  *synthesizes* it in `_handleCanUseTool` (`letta-sdk-adapter.ts` ~line 599) and
  feeds it through `onFrame`. `chat.ts` reshapes it (and remaps it to
  `tool_call_message` for the unrestricted path). It is persisted to
  `frames.jsonl` by `appendRunFrame` inside `bridgeSendMessage.emit()`.
- **Decision inbound:** mobile sends a `user_action` WS frame with
  `name:"tool_approval_response"` and `context:{ scope, decision/approve, reason }`.
  `ws-handler.mjs` (case `"user_action"`) routes it to
  `host.handleUserAction` → `mobile-channel-host.ts:handleUserAction` →
  `resolveApprovalGate(runId, decision)` in `agent-pool.ts`.
- **Gate:** `approvalGates` Map keyed by runId; `waitForApprovalDecision`
  creates the gate with a **30s timeout**; `resolveApprovalGate` /
  `rejectApprovalGate` settle it.
- **Scope cache / audit:** `runs.ts` already persists Session/Forever approval
  *policies* (`approvals.json`) and an append-only audit
  (`runs/<id>/approval-decisions.jsonl`). These are reusable as-is.
- **Replay:** `subscribeToRun(runId, cursor)` replays `frames.jsonl` (so the
  approval card re-renders on reconnect) and live-tails. `resume`/`hello.resume`
  drive `emitConversationResume`. **There is no pending-approval-specific replay
  today** — the card comes back only because it's in the frame log; the *gate*
  state is invisible to a reconnecting client.

### 2.2 What we reuse

- The `approval_request_message` frame shape → **canonical approval contract.**
  Keep emitting it via `onFrame` so it persists to `frames.jsonl` and replays
  unchanged. This is the one wire contract both clients already render.
- `user_action` / `tool_approval_response` inbound path and
  `resolveApprovalGate` → keep as the WS decision entrypoint.
- `recordApprovalDecision` / `recordApprovalPolicy` / `loadApprovalScopeCache`
  → keep for audit + Session/Forever scope caching, unchanged.
- `withLock` pattern from `crons.ts` → reuse for permissions config writes.
- `subscribeToRun` replay → keep; the card replays through it.

### 2.3 What we add

1. **Durable pending-approval store** (§1.2) — the missing on-disk truth for
   "a turn is waiting".
2. **Durable wait** replacing the 30s in-memory-only gate (§3). The
   `approvalGates` Map stays as the in-process resolver, but it is now a
   *cache over* the durable file, and the timeout becomes turn-lifetime, not 30s.
3. **A new WS push for cross-client resolution**: `approval_resolved`
   (broadcast), modeled on the `cron-events.ts` in-process pub/sub +
   `broadcastFrame` in `plugin.mjs` (§4).
4. **Rule evaluator** (§5) invoked in `_handleCanUseTool` before the gate.
5. **REST endpoints** (§6) that are thin mirrors over the same files/functions.

### 2.4 Confirming WS-canonical / REST-mirror

- The pending-approval **file** is the durable truth. The
  `approval_request_message` **frame** in `frames.jsonl` is the canonical wire
  representation that both clients render.
- REST `GET /pending` reads the pending-approval files (same data the WS card
  came from). REST `POST/DELETE` approval calls the **same** internal
  resolve function the WS `user_action` path calls (`resolveApprovalGate` +
  the file rewrite + the broadcast). There is no second code path that can
  diverge: WS and REST both funnel into one `resolveApproval(runId, decision)`
  internal function. ✅

---

## 3. Where the permission check intercepts, and how the turn parks WITHOUT tripping timeouts

### 3.1 Interception point

`SdkBackedLettaSessionAdapter._handleCanUseTool(toolName, toolInput)`
(`lib/letta-sdk-adapter.ts`). The SDK calls this for every tool before
execution. Today it short-circuits to allow when `permissionMode ===
"bypassPermissions"` (the current default) or when no A2UI client is connected.

New flow inside `_handleCanUseTool`:

```
1. action = evaluatePermission(agentId, conversationId, toolName, toolInput)
2. allow → recordApprovalDecision(...,"approve","rule_allow"); return {behavior:"allow"}
3. deny  → recordApprovalDecision(...,"deny","rule_deny");
           emit an error/deny frame; return {behavior:"deny", message: reason}
4. ask   → (a) check Session/Forever scope cache → auto-allow if cached
           (b) write pending-approval.json (status:"pending")
           (c) emit approval_request_message frame (persists to frames.jsonl)
           (d) await durable wait keyed by runId
           (e) on decision: rewrite file, record audit/policy, broadcast
               approval_resolved, return allow/deny
```

The `bypassPermissions`-by-default behavior is **preserved as an escape hatch**:
if `SHIM_PERMISSION_MODE=bypassPermissions` (or a feature flag is off) the
evaluator is skipped entirely and everything allows — so this feature can ship
dark and be enabled per-deployment. Recommendation: gate the whole
server-side-permissions path behind `SHIM_SERVER_PERMISSIONS=1` (default off)
for the first release so we don't change the live default behavior before review.

### 3.2 The timeout trap (investigated)

There are **two** independent timers that a long-parked `ask` could trip:

1. **The approval gate's own 30s timeout** (`A2UI_APPROVAL_TIMEOUT_MS`,
   `waitForApprovalDecision`). This is the one that breaks "approve from your
   phone 5 minutes later". **We must drop the 30s hard timeout** for the
   server-side path — the wait should live as long as the turn. (Keep a very
   generous backstop or none, tied to the turn ceiling, not 30s.)

2. **The turn watchdog** in `_runTurnInner` (`SHIM_POOL_TURN_SILENCE_MS` = 120s
   silence, `SHIM_POOL_TURN_TIMEOUT` = 30min absolute). **This is the key
   finding for "don't trip the shim's turn/silence timeouts."** The existing
   approval path survives a long park ONLY because the silence watchdog
   `resetSilenceTimer()` fires on **every** SDK message — and `canUseTool`
   blocks *inside* the SDK pump. We must verify whether the SDK emits any
   keepalive while `canUseTool`'s promise is pending. If it does NOT, a parked
   `ask` longer than 120s **will** trip the silence watchdog and abort the turn
   — exactly the "known issue with long-held turns" the bead warns about.

   **How the existing path "avoids" it:** it mostly doesn't — it relies on the
   30s gate timeout firing *before* the 120s silence watchdog, so the gate
   resolves (as a timeout-deny) and the turn proceeds before silence trips.
   That is the current de-facto behavior. Once we remove the 30s gate timeout
   to allow long approvals, **we expose the silence-watchdog problem.**

   **Mitigation (follow the frame-emission pattern):** while an `ask` is
   parked, periodically emit a lightweight keepalive frame (e.g. re-emit/refresh
   a `approval_request_message`-class heartbeat, or a dedicated
   `approval_pending` keepalive) on an interval shorter than
   `SHIM_POOL_TURN_SILENCE_MS`. Each emission flows through `onFrame` →
   `resetSilenceTimer()` is NOT directly reachable from the host emit, BUT the
   watchdog resets on **incoming SDK messages**, not on our `onFrame`. So the
   correct mitigation is to **reset the silence watchdog from within the
   adapter while a gate is pending** — i.e. when `_handleCanUseTool` is awaiting,
   start an interval that calls the same `resetSilenceTimer()` the stream loop
   uses (it's in closure scope of `_runTurnInner`; we expose it to the
   canUseTool path via an adapter field, mirroring how `currentRunHandle` etc.
   are shared). This keeps the turn alive for the lifetime of the park without
   faking wire traffic. This is the cleanest fix and stays within the
   established "adapter fields shared into the canUseTool closure" pattern.

   Decision needed (D2): confirm we may reset the silence watchdog while an
   approval is pending (recommended), vs. raising the silence budget while
   parked. Resetting is preferred — it's surgical and reverts automatically when
   the gate resolves.

### 3.3 Parking without holding HTTP/WS open

The turn is driven by `bridgeSendMessage` (WS) or `handleConversationStream`
(SSE/REST). The WS path does NOT hold a request open — frames stream over the
socket and the client can disconnect/reconnect freely; the run keeps going
server-side and is replayed via `subscribeToRun`. So parking on `ask` over WS is
already safe (the socket isn't the turn's lifeline). The SSE/REST send path can
hold a long POST; that's an existing concern (server.ts already documents
"20–78 minute pending POSTs"). For the REST send path, parking is acceptable
but the canonical UX is WS — REST clients poll `GET /pending` + `POST` a
decision rather than holding the stream. (Risk R3.)

---

## 4. Multi-client semantics (two clients, one approves)

Today nothing notifies client B when client A approves. We add an in-process
broadcast modeled exactly on `cron-events.ts` + the `crons_updated` push:

- New `lib/approval-events.ts`: `subscribeApprovalEvents(listener)` /
  `broadcastApprovalEvent(event)` — minimal, no replay (canonical state is the
  pending-approval file + the frame log).
- New host method `subscribeApprovalEvents`, forwarded through the host object
  in `mobile-channel-host.ts` and wired in `plugin.mjs`'s `acceptConnection`
  (mirrors `subscribeCronEvents` exactly, including the "must be explicitly
  forwarded" gotcha noted in the plugin).
- `ws-handler.mjs` subscribes per-connection on hello and pushes an
  `approval_resolved` frame: `{ run_id, tool_call_id, status, decided_by, at }`.

Sequence for "B learns A approved":
1. A and B both connected; both rendered the `approval_request_message` card
   (A live, B via its own live stream or `subscribeToRun` replay).
2. A sends `user_action(tool_approval_response)`. Host resolves the gate,
   rewrites `pending-approval.json` to `approved`, records audit/policy,
   and calls `broadcastApprovalEvent({run_id, tool_call_id, status:"approved"})`.
3. Both A's and B's per-connection listeners fire → both get
   `approval_resolved`. B dismisses/updates its card. The subsequent
   `tool_return_message` (synthesized from disk, existing path) flows to both.
4. **Race / double-approve:** `resolveApprovalGate` already returns `false` if
   the gate is gone (already resolved). The internal `resolveApproval(runId,
   decision)` is idempotent: first decision wins, writes the file + broadcasts;
   a second (from B, or via REST) sees `status !== "pending"` and is a no-op ack
   ("already_resolved"). No double tool execution — the gate resolves exactly
   once.

A reconnecting client that missed the resolution learns the outcome two ways:
(a) `subscribeToRun` replays the frame log including the post-resolution frames,
and (b) `GET /pending` won't list it (it's resolved) / the pending file shows
the terminal status.

---

## 5. Rule evaluator design

Pure, synchronous, no I/O (config is loaded once per turn, cached). Lives in a
new `lib/permissions.ts`.

```
type Action = "allow" | "ask" | "deny";
evaluatePermission(agentId, conversationId, toolName, toolInput) -> {
  action: Action, reason: string, source: "agent"|"global"|"default"
}
```

Algorithm:
1. Load per-agent rules (cached, invalidated on PUT/PATCH via mtime, like
   `runFileCache`). Walk top-to-bottom; first match wins → return with
   `source:"agent"`.
2. Else walk global rules top-to-bottom; first match → `source:"global"`.
3. Else return the **effective default** (§1.1 D1), `source:"default"`.

**Matching** (`ruleMatches(pattern, toolName, toolInput)`):
- `*` → matches any tool.
- Bare tool name (`"Bash"`) → exact match on tool name.
- `Name(prefix:*)` → matches tool `Name` whose serialized argument string
  starts with `prefix`. E.g. `Bash(git:*)` matches a Bash call whose command
  starts with `git`. The "argument string" for matching is tool-specific;
  v1 uses the primary string arg (Bash→`command`) and falls back to
  `JSON.stringify(toolInput)`. Prefix is compared case-sensitively, after
  trimming leading whitespace.
- Precedence is purely positional (first match wins); there is **no**
  specificity ranking. Authors order specific deny/ask rules above broad allow
  rules. This is simple and predictable and matches the spec.

**default=allow** is the evaluator's fallback constant when no config/rule
applies, and the schema default. Both are pinned by tests (§6).

> **SECURITY NOTE (must ship in user-facing docs):** prefix-match deny rules
> such as `Bash(rm -rf:*)` are a **UX guardrail to prevent accidents, NOT a
> security boundary.** They are trivially bypassed (`bash -c 'rm -rf …'`,
> aliases, env indirection, base64, etc.). Do not market this as sandboxing or
> a security control. Real isolation must come from the execution environment,
> not string matching.

---

## 6. REST endpoints (thin mirror)

All under existing `server.ts` routing (same style as `/v1/crons/*`). Per the
shim convention noted in code (`shim-new-features-mutations-ws-reads-may-mirror-rest`),
crons made *mutations WS-only*; permissions config is inherently a
config-management surface with no live turn, so **config PUT/PATCH over REST is
appropriate here** (D3 — confirm). Approval decisions are mirrored both ways.

Permissions config:
- `GET  /shim/v1/permissions/agents/:agentId` → per-agent config (404→ returns
  effective {default:"allow", rules:[]} so clients always get a usable doc).
- `PUT  /shim/v1/permissions/agents/:agentId` → replace per-agent config (lock).
- `PATCH /shim/v1/permissions/agents/:agentId` → merge (e.g. append/replace a
  rule, change default) (lock).
- `GET  /shim/v1/permissions/global` → global fallback config.
- `PUT  /shim/v1/permissions/global` → replace global config (lock).

Preview:
- `GET  /shim/v1/permissions/preview?agent_id=&tool=&args=` → runs
  `evaluatePermission` and returns `{action, reason, source, requires_approval:
  action!=="allow"}`. Pure read; "does the next action need approval".

Approvals (mirror over the same durable store + resolve function):
- `GET    /shim/v1/approvals/pending[?agent_id=&conversation_id=]` → scan
  `runs/*/pending-approval.json` for `status:"pending"`, filtered.
- `POST   /shim/v1/approvals/:runId` body `{decision:"approve"|"deny", scope?,
  reason?, user_id?}` → calls the SAME `resolveApproval(runId, decision)` the WS
  path uses. Idempotent; returns `{status, already_resolved?}`.
- `DELETE /shim/v1/approvals/:runId` → deny shorthand (`decision:"deny",
  reason:"rest_delete"`). Same resolve function.

These endpoints contain **no business logic** — they parse/validate and call the
same `lib/permissions.ts` + approval-resolve functions the WS path uses.

### Test plan (regression tests, per AGENTS.md policy)

New `test/permissions.test.ts`:
1. **Rule precedence:** first-matching-rule-wins; agent overrides global;
   a deny above an allow yields deny and vice-versa.
2. **allow / deny / ask:** evaluator returns each; deny short-circuits (no
   execution), ask produces a pending record + frame, allow executes.
3. **Prefix match:** `Bash(git:*)` matches `git push`, not `rm`; `*` matches
   anything; bare name exact-matches.
4. **default=allow:** empty config, missing file, and config with no matching
   rule ALL resolve to `allow`. (Dedicated test — the headline product
   decision.)
5. **Reconnect-replay:** park an `ask`, drop the WS, `subscribeToRun(runId,
   cursor=0)` replays the `approval_request_message`; the pending file still
   shows `pending`.
6. **Two-client approval:** client A resolves; `broadcastApprovalEvent` fires;
   a second subscriber receives `approval_resolved`; a second decision is a
   no-op (`already_resolved`); exactly one tool execution.
7. **Restart survival:** write a `pending-approval.json`, run the boot sweep,
   assert it flips to `expired` + a terminal frame is appended + run finalized
   (no eternal spinner).
8. **WS-canonical / REST-mirror:** approve via REST `POST /approvals/:runId`,
   assert the WS gate resolves and the pending file + audit reflect it; and the
   reverse (approve via WS, `GET /pending` no longer lists it).
9. **Timeout/silence:** assert that a parked `ask` resets the silence watchdog
   (no false turn-timeout within `SHIM_POOL_TURN_SILENCE_MS`).

Tests follow existing harness conventions (`test/*.test.ts`,
`node --import tsx/esm --test`), using `__setAgentPoolForTest` and temp
`LETTA_LOCAL_BACKEND_DIR` dirs as the cron/runs tests do.

---

## 7. Risks / unknowns / where the code helps or fights us

**Where the existing code makes this EASIER than the spec assumes:**
- The canonical approval *wire frame* (`approval_request_message`) already
  exists, is already persisted to `frames.jsonl`, and already replays via
  `subscribeToRun`. So "card survives reconnect" is mostly already true.
- A clean single interception point (`_handleCanUseTool`) already exists and
  already has the turn context (runHandle, onFrame, scope cache) wired into it.
- Audit + Session/Forever scope caching (`recordApprovalDecision`,
  `recordApprovalPolicy`, `loadApprovalScopeCache`) already exist and are reusable.
- `withLock` (crons) and one-file-per-X sharding (runs) are battle-tested
  patterns to copy for config and pending stores.
- `cron-events.ts` + `crons_updated` is a turnkey template for the
  cross-client `approval_resolved` broadcast.

**Where it makes this HARDER than the spec assumes:**

- **R1 — Restart cannot truly resume a parked tool call.** The parked turn's
  letta-code CLI *session* dies with the shim. We can make the pending state
  durable and replayable and avoid eternal spinners, but the in-flight tool call
  itself is not resumable across restart. The honest guarantee is "no lost/stuck
  approval", not "the tool runs after reboot". This should be confirmed as
  acceptable. (If true resume is required, that's a much bigger CLI-durability
  bead, out of scope here.)

- **R2 — Silence watchdog vs. long parks (the "known long-held-turn issue").**
  The current code only survives long parks because the **30s gate timeout fires
  before the 120s silence watchdog**. Removing the 30s timeout to allow real
  human-paced approval exposes the silence watchdog. Mitigation in §3.2 (reset
  the silence watchdog while a gate is pending) is sound but requires touching
  `_runTurnInner`/`_handleCanUseTool` timer wiring. Needs decision D2.

- **R3 — SSE/REST send path holding a long POST.** WS is fine (socket isn't the
  turn's lifeline). A long-parked `ask` on the SSE path holds a POST open
  (already a known wart per server.ts comments). Canonical UX is WS; REST send
  + REST poll/approve is the documented pattern.

- **R4 — Synthetic tool_call_id mismatch (pre-existing, documented in the SDK
  adapter).** The SDK doesn't give `canUseTool` the real CLI tool_call_id, so the
  approval card's id won't match the eventual `tool_return_message` id. The gate
  is keyed by **runId**, so resolution is correct; only visual correlation by
  tool_call_id is imperfect. We key the pending store by runId (matching the
  gate), not tool_call_id, to stay correct. This is an upstream limitation, not
  something this bead can fix.

- **R5 — `default` permissionMode interaction.** The spawned SDK session
  defaults to `bypassPermissions`, which makes `canUseTool` auto-allow before our
  evaluator runs in some paths. We must ensure the session runs at a
  permissionMode where `canUseTool` is actually invoked for every tool when
  server-side permissions are enabled (i.e. NOT `bypassPermissions`). This means
  the feature flag (`SHIM_SERVER_PERMISSIONS=1`) must also flip the session's
  permissionMode to `"default"` so the callback fires. Confirm we want that
  coupling (D4).

- **R6 — "No A2UI client" short-circuit.** `_handleCanUseTool` currently
  auto-allows when `a2uiCapability == null` (no approval-capable client). With
  server-side permissions, a `deny` rule must still deny even with no client
  attached (e.g. cron/headless turns), and an `ask` with no client attached has
  no one to ask → it should resolve per a configured policy (recommend: `ask`
  with no approver → deny, matching the headless safe default), NOT auto-allow.
  This changes the headless behavior and must be confirmed (D5) — it's the same
  class of issue `vibesync-uuas` hit (headless rig dispatch deadlocked on
  approval). Recommendation: `deny` always denies; `ask` with no approver →
  deny-with-reason; `allow`/default-allow always allows — so headless turns keep
  working as long as the operator's rules don't `ask`/`deny` the tools the rig
  needs.

**Open decisions needed before Phase 2:**
- **D1** — effective default when a per-agent file exists: per-agent `default`
  wins, else global `default`, else `"allow"`. (Recommended as stated.)
- **D2** — reset the silence watchdog while an approval is pending (recommended)
  vs. widen the budget.
- **D3** — permissions config mutation over REST PUT/PATCH allowed (recommended,
  it's config not a live turn) vs. WS-only to match the cron convention.
- **D4** — feature flag `SHIM_SERVER_PERMISSIONS=1` also forces session
  permissionMode `"default"` so `canUseTool` fires (required for the feature to
  work at all).
- **D5** — headless/no-approver semantics: `ask`→deny, `deny`→deny,
  `allow`/default→allow (recommended), confirming the change from today's
  blanket auto-allow.
- **D6** — ship dark behind a default-off flag for the first release
  (recommended) so live default behavior is unchanged until reviewed.

---

## 8. Ready for Phase 2?

**Recommendation: YES, with the six decisions above resolved (especially D2 and
D5, which change live turn behavior).** The design reuses the existing canonical
WS approval frame, keeps REST a strict mirror over one resolve function, makes
pending state durable/replayable within the limits of CLI-session lifetime
(R1), and bakes `default: allow` into both the schema and the evaluator.

The single biggest implementation risk is the silence-watchdog/long-park
interaction (R2/D2) — it is the "known long-held-turn issue" the bead flagged,
and the current code only dodges it via the 30s gate timeout we must remove.
The §3.2 mitigation is the plan; confirm it before coding.
