/**
 * SDK-backed Letta session adapter (sole implementation since lcp-sdk.10).
 *
 * Drives the letta-code CLI through `@letta-ai/letta-code-sdk`'s `Session`.
 * Replaces the hand-rolled subprocess adapter that lived in agent-pool.ts
 * through the lcp-sdk.* migration (1 → 10).
 *
 * Design boundary:
 *   - The SDK consumes the same wire frames the direct adapter does (both
 *     read the CLI's `--output-format stream-json` stdout). The SDK's pump
 *     forwards every `type:"stream_event"` wire frame verbatim as a
 *     `SDKStreamEventMessage{ event }` — so we can pass the raw inner event
 *     straight through to the existing collector with no projection drift.
 *   - Transformed SDK messages (`assistant`/`tool_call`/`tool_result`/
 *     `reasoning`) duplicate content already present in the stream_event
 *     stream when the CLI is in local backend mode (fixtures confirm the
 *     CLI emits no top-level `type:"message"` frames there). Skip them on
 *     this path to avoid double-counting; lcp-sdk.4 + .5 revisit if the
 *     remote backend changes that assumption.
 *   - Approval, cancellation, and error/retry mapping are explicitly
 *     out-of-scope here — those are owned by lcp-sdk.5. The MVP target is
 *     a clean text-only turn (init + send + stream + result).
 */

import { randomUUID } from "node:crypto";

import {
  resumeSession,
  type Session,
  type SDKMessage,
  type SDKResultMessage,
} from "@letta-ai/letta-code-sdk";
// CanUseToolResponse is part of letta-code's protocol package, re-exported via
// the SDK index but not in the explicit type-export list — import directly.
import type {
  CanUseToolResponse,
} from "@letta-ai/letta-code/protocol";

import type {
  LettaStreamFrame,
  LettaInnerEvent,
} from "./types/letta-stream.js";

import {
  applyFrameRunSideEffects,
  finalizeTurnLifecycle,
  waitForApprovalDecision,
  type AdapterRunTurnResult,
  type ApprovalDecision,
  type LettaSessionAdapter,
  type LettaSessionAdapterOptions,
  type LettaSessionInit,
  type RunTurnOptions,
} from "./agent-pool.js";

import {
  createRun,
  loadApprovalScopeCache,
  recordApprovalDecision,
  recordApprovalPolicy,
  setRunCancelHandler,
  type ApprovalScope,
  type ApprovalScopeCacheEntry,
  type RunHandle,
  type UsageInput,
} from "./runs.js";

import type { A2uiCapability } from "./a2ui-adapter.js";

import { listMessages } from "./store.js";

function logLine(msg: string): void {
  console.log(`[sdk-adapter] ${msg}`);
}

/**
 * Default the SDK turn-watchdog to the same envelope the direct adapter uses.
 * Both honor `SHIM_POOL_TURN_TIMEOUT` so an operator switching transports
 * doesn't get surprised by different stuck-turn semantics.
 */
const TURN_TIMEOUT_MS = Number(process.env["SHIM_POOL_TURN_TIMEOUT"] ?? 180_000);

export class SdkBackedLettaSessionAdapter implements LettaSessionAdapter {
  conversationId: string;
  agentId: string;
  session: Session | null;
  ready: boolean;
  dead: boolean;
  lastUsedAt: number;
  spawnedAt: number;
  // SDK init carries the canonical session_id; we surface it on emitted
  // frames where the wire shape requires one (StreamEventFrame.session_id).
  private sessionId: string;
  // Single-flight: serialize concurrent runTurn calls on the same adapter,
  // matching the direct adapter's per-worker chain semantics.
  private chain: Promise<unknown>;

  // lcp-sdk.5: per-turn approval state. The SDK's canUseTool callback fires
  // from the session's background pump (not from inside _runTurnInner), so
  // we need closure access to "the currently active turn." Turns are
  // serialized by `chain`, so at most one runTurn is in flight; these are
  // set at the top of _runTurnInner and cleared in its finally block.
  private currentRunHandle: RunHandle | null = null;
  private currentOnFrame: ((frame: LettaStreamFrame, meta: { runId: string }) => void) | null = null;
  private currentApprovalScopeCache: Map<string, ApprovalScopeCacheEntry> | null = null;
  private currentA2uiCapability: A2uiCapability | null = null;
  // Monotonic seq counter for synthesized approval frames within the
  // current turn. Real upstream frames carry seq_id from letta-code; the
  // SDK-side synthetic ones start at a high offset so they don't collide
  // with any upstream-allocated ids in the same turn.
  private syntheticSeqId = 1_000_000;

  constructor({ conversationId, agentId }: LettaSessionAdapterOptions) {
    this.conversationId = conversationId;
    this.agentId = agentId;
    this.session = null;
    this.ready = false;
    this.dead = false;
    this.lastUsedAt = Date.now();
    this.spawnedAt = Date.now();
    this.sessionId = "";
    this.chain = Promise.resolve();
  }

  async start(): Promise<LettaSessionInit> {
    // Mirrors the direct adapter's selection rule: bare literal "default" is
    // ambiguous (every agent has its own default conv), so we route to the
    // agent id and let the SDK resume that agent's default thread.
    // Real `conv-...` ids resume the specific conversation.
    const target = this.conversationId === "default" ? this.agentId : this.conversationId;
    const session = resumeSession(target, {
      includePartialMessages: true,
      // lcp-sdk.5: interactive approval gate. letta-code is approval-by-default
      // for tool calls (the CLI emits approval_request_message frames and
      // halts on requires_approval stop_reason on the direct path). On the
      // SDK path, the CLI sends `can_use_tool` control_requests to the SDK
      // pump and the SDK invokes this callback instead — so the wire-level
      // approval_request_message never reaches us. Synthesize it here so
      // mobile A2UI still gets its approval card, and reuse the existing
      // approvalGates machinery so mobile user_action resolves it the same
      // way it does on the direct path.
      canUseTool: (toolName, toolInput) => this._handleCanUseTool(toolName, toolInput),
    });
    this.session = session;
    const init = await session.initialize();
    this.sessionId = init.sessionId;
    // letta-code's LocalStore wrote conversation files under the dir
    // resolved from the agent id; the SDK's init reports the resolved
    // conversation id back to us, which we record so the pool's external
    // keying stays consistent with what the SDK actually targeted.
    this.conversationId = init.conversationId;
    this.agentId = init.agentId;
    this.ready = true;
    logLine(`started agent=${this.agentId} conv=${this.conversationId} session=${this.sessionId}`);
    return { agentId: init.agentId, conversationId: init.conversationId };
  }

  async runTurn(input: string | unknown[], opts: RunTurnOptions = {}): Promise<AdapterRunTurnResult> {
    // Serialize: if a previous turn is in flight on this adapter, wait for
    // it before starting the next. Matches direct adapter semantics.
    const turn = this.chain.then(() => this._runTurnInner(input, opts));
    this.chain = turn.catch(() => {}); // keep the chain alive even on failure
    return turn;
  }

  private async _runTurnInner(input: string | unknown[], opts: RunTurnOptions): Promise<AdapterRunTurnResult> {
    if (!this.session) throw new Error("SDK adapter: runTurn before start()");
    if (this.dead) throw new Error("SDK adapter: runTurn on dead adapter");
    const session = this.session;

    // lcp-sdk.4: same runHandle resolution as the direct adapter. Mobile
    // WS callers pre-create the handle so turn_started can carry run_id
    // before the first content frame (lcp-99a); REST/SSE callers don't.
    // Cancellation: setRunCancelHandler binds a hook keyed by run id; for
    // the SDK path the hook calls session.abort() (the SDK's `interrupt`
    // control request), matching the direct adapter's SIGTERM semantics
    // as closely as the SDK allows. SDK-level cancellation surface
    // limitations are flagged in lcp-sdk.5 — for now best-effort.
    let cancelled = false;
    const cancelSession = (): void => {
      cancelled = true;
      void session.abort().catch(() => {});
    };
    let runHandle: RunHandle;
    if (opts.runHandle) {
      runHandle = opts.runHandle;
      setRunCancelHandler(runHandle.id, cancelSession);
    } else {
      runHandle = createRun({
        agentId: this.agentId,
        conversationId: this.conversationId,
        onCancel: cancelSession,
      });
      if (typeof opts.onRunCreated === "function") {
        try { opts.onRunCreated(runHandle.id); } catch {}
      }
    }

    // Snapshot pre-turn message ids so we can attribute new ids after
    // the turn settles. listMessages reads messages.jsonl which the CLI
    // (through the SDK pump) appends to during the turn.
    const messageIdsBefore = new Set<string>(
      (await listMessages(this.conversationId, this.agentId))
        .map((m) => m?.id)
        .filter((id): id is string => Boolean(id)),
    );

    // Anchor stamp time: caller may supply a turn-start time captured
    // before this method ran (mobile WS uses this so disk-stamped and
    // stream-emitted timestamps share a base). Fall back to `now`.
    const passedStart = opts.turnStartedAt;
    const turnStartedAt = passedStart instanceof Date
      ? passedStart
      : (typeof passedStart === "number" ? new Date(passedStart) : new Date());

    const frames: LettaStreamFrame[] = [];
    let pendingStepUsage: UsageInput | null = null;
    let result: SDKResultMessage | null = null;
    let timedOut = false;

    const sendInput = (typeof input === "string" ? input : input) as Parameters<Session["send"]>[0];

    // lcp-sdk.5: hand the canUseTool callback its turn context. The SDK's
    // background pump invokes the callback OUT-of-band from this stream
    // loop, so the callback reads these adapter fields via closure rather
    // than receiving them as args. Turn serialization (`this.chain`) means
    // at most one _runTurnInner is alive at a time, so a single set of
    // fields is enough — no per-turn map needed.
    this.currentRunHandle = runHandle;
    this.currentOnFrame = opts.onFrame ?? null;
    this.currentA2uiCapability = opts.a2uiCapability ?? null;
    this.currentApprovalScopeCache = loadApprovalScopeCache(runHandle.id, this.conversationId);
    this.syntheticSeqId = 1_000_000;

    // Watchdog: same envelope the direct adapter uses. On timeout, flag
    // and signal abort; the stream loop breaks at the next yield.
    let watchdog: NodeJS.Timeout | null = setTimeout(() => {
      timedOut = true;
      void session.abort().catch(() => {});
    }, TURN_TIMEOUT_MS);

    try {
      await session.send(sendInput);

      for await (const msg of session.stream()) {
        if (cancelled) break;
        const frame = sdkMessageToLettaFrame(msg, this.sessionId, this.agentId, this.conversationId);
        if (frame) {
          // Mirror the direct adapter: heartbeat lastUsedAt on every frame
          // so housekeep() doesn't idle-evict an in-flight long turn.
          this.lastUsedAt = Date.now();
          frames.push(frame);
          // lcp-sdk.4: same per-frame run-bookkeeping as the direct
          // adapter (markRunFirstToken / recordRunTool / recordRunStep,
          // pendingStepUsage tracking). Behavior-identical via the
          // shared helper.
          pendingStepUsage = applyFrameRunSideEffects(frame, runHandle, pendingStepUsage);
          if (opts.onFrame) {
            try {
              opts.onFrame(frame, { runId: runHandle.id });
            } catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              logLine(`onFrame error: ${m}`);
            }
          }
        }
        if (msg.type === "result") {
          result = msg;
          break;
        }
        if (timedOut) break;
      }
    } finally {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      this.lastUsedAt = Date.now();
      // lcp-sdk.5: clear per-turn approval context. Any canUseTool that
      // fires AFTER this (it shouldn't, since the stream ended) gets a
      // safe default-allow path in _handleCanUseTool.
      this.currentRunHandle = null;
      this.currentOnFrame = null;
      this.currentApprovalScopeCache = null;
      this.currentA2uiCapability = null;
    }

    // lcp-sdk.4: shared post-turn finalization — stampNewMessages,
    // recordRunMessage attribution, finalizeRun. Mirror the direct
    // adapter's call so /v1/runs/{id}, /messages, /usage, /metrics, and
    // /steps surfaces look identical regardless of transport.
    const finishedExit = false; // no subprocess to crash
    const finishedTimeout = timedOut;
    const { newUserMessageId } = await finalizeTurnLifecycle({
      runHandle,
      frames,
      conversationId: this.conversationId,
      agentId: this.agentId,
      messageIdsBefore,
      turnStartedAt,
      cancelled,
      finishedExit,
      finishedTimeout,
    });

    if (timedOut) {
      return { frames, stderr: "", run_id: runHandle.id, timeout: true, cancelled, newUserMessageId };
    }
    if (result) {
      return {
        frames,
        stderr: "",
        run_id: runHandle.id,
        done: result.success,
        cancelled,
        newUserMessageId,
        // SDK surfaces upstream Letta run ids as `result.runIds`. We do NOT
        // expose them as the mobile-facing run id — the shim continues to
        // own /v1/runs/* (see lcp-sdk-decide-runid). Caller correlates via
        // opts.runHandle.id, which we echo back unchanged.
      };
    }
    // Stream ended without a result frame (e.g. session closed mid-turn).
    return { frames, stderr: "", run_id: runHandle.id, dead: true, cancelled, newUserMessageId, error: "stream ended without result" };
  }

  /**
   * lcp-sdk.5: the SDK invokes this for every tool the CLI wants to use
   * while permissionMode is "default" (and letta-code is approval-by-default,
   * so this fires for every tool call). Responsibilities:
   *
   *   1. Synthesize an approval_request_message wire frame matching the
   *      shape the direct adapter would emit naturally, and feed it to
   *      mobile via the active turn's onFrame so A2UI renders the
   *      approval card.
   *   2. Honor the per-conversation approval scope cache —
   *      Session/Forever decisions auto-approve without a round-trip.
   *   3. Block on waitForApprovalDecision (the SAME gate the direct
   *      adapter uses; mobile-channel-host.handleUserAction resolves it
   *      via resolveApprovalGate). Decision becomes a CanUseToolResponse.
   *   4. Record the decision and (if Session/Forever) the policy to the
   *      run sidecar via runs.ts — same audit trail as direct.
   *
   * Known limitations (worth a follow-up):
   *
   *   - The SDK doesn't expose the CLI-side tool_call_id to canUseTool,
   *     only (toolName, toolInput). We generate a synthetic id here so
   *     the approval frame has SOMETHING; mobile uses it to send
   *     user_action back. The eventual tool_return_message from the CLI
   *     will carry the REAL tool_call_id, which won't match ours —
   *     mobile UI correlation by tool_call_id will see two unconnected
   *     items. The approval gate itself is keyed by run_id, so the gate
   *     resolution works correctly; only the visual correlation is off.
   *   - When no A2UI client is connected (a2uiCapability == null) we
   *     default-allow, matching the direct adapter's behavior (the
   *     direct path only synthesizes A2UI approval cards when a2ui is
   *     negotiated; without a2ui the upstream approval_request_message
   *     passes through and the turn naturally halts at requires_approval,
   *     but that's not a path mobile can drive without A2UI anyway).
   */
  private async _handleCanUseTool(toolName: string, toolInput: Record<string, unknown>): Promise<CanUseToolResponse> {
    const runHandle = this.currentRunHandle;
    const onFrame = this.currentOnFrame;
    const cache = this.currentApprovalScopeCache;
    const a2ui = this.currentA2uiCapability;

    if (!runHandle || !cache) {
      // canUseTool fired outside of an active turn. Shouldn't happen in
      // normal flow — log and default-allow rather than block forever.
      logLine(`canUseTool fired with no active turn (tool=${toolName}) — defaulting allow`);
      return { behavior: "allow" };
    }

    // No A2UI client connected → default-allow. Matches the direct adapter's
    // `a2uiCapability ? approvalRequestToolCall(frame) : null` short-circuit.
    if (!a2ui) {
      return { behavior: "allow" };
    }

    const toolCallId = `synthetic-${randomUUID()}`;
    const timestamp = new Date().toISOString();

    // 1. Scope cache: Session/Forever pre-approval → auto-allow without
    //    showing the approval card. This diverges (intentionally) from
    //    the direct adapter, which emits the upstream
    //    approval_request_message frame unconditionally and only avoids
    //    the BLOCKING wait. On the SDK path we have explicit control
    //    over what gets emitted, so we skip the frame entirely for
    //    cached approvals — no transient card flicker on mobile.
    //    (loadApprovalScopeCache only caches APPROVE decisions per the
    //    recordApprovalPolicy contract.)
    const cached = cache.get(toolName);
    if (cached) {
      recordApprovalDecision(runHandle.id, {
        action_id: `cached-${toolCallId}`,
        tool_name: toolName,
        decision: "approve",
        scope: cached.scope,
        reason: "cached_approval",
        timestamp,
      });
      return { behavior: "allow", message: "cached_approval" };
    }

    // 2. No cache hit → synthesize the approval_request_message wire
    //    frame and emit via onFrame. Field shape matches the upstream
    //    ApprovalRequestMessageEvent in lib/types/letta-stream.ts — the
    //    synthetic toolCallId leaks into mobile's UI but the SDK won't
    //    surface a CLI-side correlation until upstream changes.
    const seqId = ++this.syntheticSeqId;
    const frame: LettaStreamFrame = {
      type: "stream_event",
      session_id: this.sessionId,
      uuid: `synthetic-${randomUUID()}`,
      timestamp,
      event: {
        message_type: "approval_request_message",
        id: `synthetic-msg-${seqId}`,
        date: new Date().toISOString(),
        agent_id: this.agentId,
        conversation_id: this.conversationId,
        run_id: runHandle.id,
        seq_id: seqId,
        tool_call: {
          tool_call_id: toolCallId,
          name: toolName,
          arguments: JSON.stringify(toolInput),
        },
      } as unknown as LettaInnerEvent,
    };
    try { onFrame?.(frame, { runId: runHandle.id }); } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logLine(`onFrame error during approval emit: ${m}`);
    }

    // 3. Block on the same approval gate the direct adapter uses. Mobile
    //    user_action arrives via mobile-channel-host.handleUserAction →
    //    resolveApprovalGate(runHandle.id, decision).
    let decision: ApprovalDecision;
    try {
      decision = await waitForApprovalDecision(runHandle.id, toolName, toolCallId);
    } catch (err) {
      // 4a. Timeout / disconnect path. Record an audit entry and deny.
      const reason = err instanceof Error ? err.message : String(err);
      recordApprovalDecision(runHandle.id, {
        action_id: `timeout-${toolCallId}`,
        tool_name: toolName,
        decision: reason.startsWith("approval_timeout") ? "timeout" : "deny",
        scope: "Deny",
        reason,
        timestamp,
      });
      return { behavior: "deny", message: reason };
    }

    // 4b. Decision received. Audit + (if Session/Forever) persist policy.
    recordApprovalDecision(runHandle.id, {
      action_id: decision.actionId,
      tool_name: toolName,
      decision: decision.decision,
      scope: decision.scope,
      reason: decision.reason,
      timestamp,
      ...(decision.userId ? { user_id: decision.userId } : {}),
    });
    if (decision.decision === "approve" && (decision.scope === "Session" || decision.scope === "Forever")) {
      recordApprovalPolicy(runHandle.id, this.conversationId, {
        action_id: decision.actionId,
        tool_name: toolName,
        scope: decision.scope as Extract<ApprovalScope, "Session" | "Forever">,
        timestamp,
        ...(decision.userId ? { user_id: decision.userId } : {}),
      });
      cache.set(toolName, { scope: decision.scope as Extract<ApprovalScope, "Session" | "Forever">, timestamp });
    }
    return decision.decision === "approve"
      ? { behavior: "allow", message: decision.reason }
      : { behavior: "deny", message: decision.reason };
  }

  async abort(reason?: string): Promise<void> {
    if (reason) logLine(`abort agent=${this.agentId} conv=${this.conversationId} reason=${reason}`);
    try {
      await this.session?.abort();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logLine(`abort failed: ${m}`);
    }
  }

  async close(): Promise<void> {
    this.dead = true;
    this.ready = false;
    try {
      this.session?.close();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logLine(`close failed: ${m}`);
    }
    this.session = null;
  }
}

/**
 * Map one SDKMessage back to a raw LettaStreamFrame. Returns null for
 * messages that don't have a wire-frame analog or that the existing
 * collector doesn't need to see (transformed message duplicates).
 *
 * The collector cases on `frame.type === "result"` to end the turn and on
 * `frameEvent(frame).message_type` for run/step bookkeeping. Both branches
 * are preserved here:
 *   - `stream_event` → forwarded with the raw inner event so message_type
 *     branches (assistant_message / tool_call_message / usage_statistics /
 *     stop_reason / approval_request_message) keep firing.
 *   - `result` → forwarded so the collector's `finished = { done: true }`
 *     branch fires identically.
 */
/**
 * Internal surface for unit tests — kept off the main export so production
 * callers can't accidentally couple to the conversion shape. Tests import
 * the symbol explicitly and assert against it.
 */
export const _internals = { sdkMessageToLettaFrame };

function sdkMessageToLettaFrame(
  msg: SDKMessage,
  sessionId: string,
  agentId: string,
  conversationId: string,
): LettaStreamFrame | null {
  switch (msg.type) {
    case "stream_event": {
      // Pass-through. The SDK's pump preserves the raw wire `event` payload
      // verbatim, so reshapeFrame / A2UI splitter / approval gate logic all
      // see exactly what they'd see on the direct path.
      return {
        type: "stream_event",
        event: msg.event as unknown as LettaInnerEvent,
        session_id: sessionId,
        uuid: msg.uuid,
        timestamp: new Date().toISOString(),
      };
    }
    case "result": {
      // Synthesize the wire-shape ResultFrame the collector expects.
      // duration_api_ms, num_turns, and `usage:null` mirror what letta-code's
      // own emitter produces today; the SDK doesn't surface those separately
      // so we stub safe defaults. `result` (final assistant text) is what
      // the SDK reports; downstream projection re-derives from the
      // stream_event chain so this field is informational.
      return {
        type: "result",
        subtype: msg.success ? "success" : "error",
        session_id: sessionId,
        duration_ms: msg.durationMs,
        duration_api_ms: 0,
        num_turns: 1,
        result: msg.result ?? "",
        agent_id: agentId,
        conversation_id: msg.conversationId ?? conversationId,
        run_ids: msg.runIds ?? [],
        usage: null,
        uuid: "",
        timestamp: new Date().toISOString(),
      };
    }
    case "init":
      // Init fires during start(), not during a turn. The CLI does NOT
      // re-emit it on subsequent turns, but if a future SDK version surfaces
      // it inside stream() we ignore it here — start() already recorded the
      // ids and the collector doesn't case on system frames.
      return null;
    case "assistant":
    case "tool_call":
    case "tool_result":
    case "reasoning":
      // Local-backend CLI delivers these inside stream_event frames; the
      // transformed standalone forms are SDK-side projections only. Skip to
      // avoid double-counting in run records. Revisit in lcp-sdk.4 if a
      // remote-backend path proves they're the only source.
      return null;
    case "error":
    case "retry":
      // lcp-sdk.5 will route these to the run record's stop_reason /
      // approval-conflict gate. For the MVP we drop them — a subsequent
      // result frame still terminates the turn.
      return null;
    default:
      return null;
  }
}
