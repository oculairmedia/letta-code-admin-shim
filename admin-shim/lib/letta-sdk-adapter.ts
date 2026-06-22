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
  type SDKErrorMessage,
  type SDKMessage,
  type PermissionMode,
  type SDKResultMessage,
  type AnyAgentTool,
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
  setMessageIdsAtTurnStart,
  setRunCancelHandler,
  type ApprovalScope,
  type ApprovalScopeCacheEntry,
  type RunHandle,
  type UsageInput,
} from "./runs.js";

import { ensureA2uiBlockAttached, type A2uiCapability } from "./a2ui-adapter.js";

import { listMessages } from "./store.js";
import { sleeptimeOptionsForAgent } from "./reflection-settings.js";

import {
  evaluatePermission,
  evaluatePermissionWithFork,
  serverPermissionsEnabled,
  forkVerdictEnabled,
  extractOverride,
  stripOverrideFields,
  checkOverrideRateLimit,
  recordOverride,
  appendOverrideAudit,
  resetOverrideTurnCounter,
  forkOverrideEnabled,
  type ForkSessionRole,
} from "./permissions.js";
import {
  clearPendingApproval,
  createPendingApproval,
} from "./pending-approval.js";
import {
  detachShimSelfRestartInput,
  emitShimRestartNotice,
  isShimSelfRestartTool,
  resolveShimRestartApproval,
} from "./restart-finalizer.js";
import {
  getSessionRole,
  setSessionRole,
} from "./runtime-introspection.js";

function logLine(msg: string): void {
  console.log(`[sdk-adapter] ${msg}`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key: string, inner: unknown) => (
      typeof inner === "bigint" ? inner.toString() : inner
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ stringify_error: message });
  }
}

function sdkErrorPayload(
  lastError: SDKErrorMessage | null,
  result: SDKResultMessage | null,
): { message?: string; errorDetail?: string; apiError?: unknown } | null {
  const message = lastError?.message ?? result?.error;
  const errorDetail = lastError?.errorDetail ?? result?.errorDetail;
  const apiError = lastError?.apiError;
  if (!message && !errorDetail && !apiError) return null;
  return {
    ...(message ? { message } : {}),
    ...(errorDetail ? { errorDetail } : {}),
    ...(apiError ? { apiError } : {}),
  };
}

/**
 * Turn watchdog configuration.
 *
 * lcp-5o2: was a single absolute-budget timer at 180s. Real agent turns
 * commonly exceed that on multi-tool investigations or long streamed
 * responses, producing false-positive 'turn timed out' toasts on the
 * mobile client even when the turn completes successfully. Replaced with
 * a silence watchdog: the timer resets on every emitted frame, and only
 * fires if the stream has been silent for `SHIM_POOL_TURN_SILENCE_MS`.
 * An absolute ceiling `SHIM_POOL_TURN_TIMEOUT` still exists as a
 * defense-in-depth backstop against pathological stuck turns that
 * somehow keep dribbling output forever.
 *
 * Defaults:
 *   SHIM_POOL_TURN_SILENCE_MS = 120_000 (2 minutes of no frames → timeout)
 *   SHIM_POOL_TURN_TIMEOUT    = 1_800_000 (30 minute absolute ceiling)
 *
 * The previous default (180s absolute) is now the silence budget rather
 * than the total budget, so most legitimate turns will reset the timer
 * regularly via frame emission and never trip.
 *
 * Both envs are honored by both adapters (this one and the direct
 * adapter) so operators get consistent semantics regardless of which
 * transport is in use.
 */
const TURN_SILENCE_MS = Number(process.env["SHIM_POOL_TURN_SILENCE_MS"] ?? 120_000);
const TURN_TIMEOUT_MS = Number(process.env["SHIM_POOL_TURN_TIMEOUT"] ?? 1_800_000);
const GOAL_CONTROL_TOOL = "goal_control";

/**
 * vibesync-uuas: permission mode for the spawned letta-code session.
 *
 * letta-code is approval-by-default. At permissionMode "default" the
 * agent's tool calls (notably the Agent/Task tool used by rig dispatch
 * to spawn role subagents) halt the run with stop_reason
 * "requires_approval" and wait for an approver. On the headless rig
 * dispatch path there is NO approver attached (no A2UI / mobile client),
 * so the run terminates having done no work — the formula step closes
 * green with empty output. This is the silent-failure the shim's own
 * chat.ts contract comment ("permission_mode=unrestricted (mobile's
 * default for this shim)") says should NOT happen.
 *
 * Restore that contract: default the spawned session to
 * "bypassPermissions" so tools run without an approval round-trip.
 * Override with SHIM_PERMISSION_MODE when a deployment genuinely wants
 * interactive approval (e.g. an A2UI/mobile-only shim where the
 * canUseTool synthesis in _handleCanUseTool should drive approval
 * cards). Valid values mirror the SDK's PermissionMode union.
 */
const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

function currentPermissionMode(): PermissionMode {
  // lcp-indw / D4: when server-side permissions is enabled, the spawned
  // session MUST run in a mode where the CLI emits can_use_tool control
  // requests, otherwise the evaluator never runs and the feature is inert.
  //
  // GOTCHA (found live 2026-06-10): the SDK's "default" mode is NOT that
  // mode. buildCliArgs omits --permission-mode for "default", and letta.js's
  // DEFAULT_PERMISSION_MODE is "unrestricted" — the CLI then auto-approves
  // every tool itself ("matched_rule":"unrestricted mode") and the SDK
  // callback is never consulted. The CLI mode that requests approval is
  // "standard"; it is not part of the SDK's TS PermissionMode union but is
  // passed through verbatim to --permission-mode at runtime.
  //
  // An explicit SHIM_PERMISSION_MODE override still wins so an operator can
  // force a specific mode, but the default coupling is:
  // SHIM_SERVER_PERMISSIONS=1 ⇒ "standard" (CLI request-approval mode).
  const explicit = process.env["SHIM_PERMISSION_MODE"];
  if (explicit) return explicit as PermissionMode;
  if (serverPermissionsEnabled()) return "standard" as PermissionMode;
  return DEFAULT_PERMISSION_MODE;
}

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
  get busy(): boolean { return this.currentRunHandle !== null; }
  get activeRunId(): string | null { return this.currentRunHandle?.id ?? null; }
  private currentRunHandle: RunHandle | null = null;
  private currentOnFrame: ((frame: LettaStreamFrame, meta: { runId: string }) => void) | null = null;
  private currentApprovalScopeCache: Map<string, ApprovalScopeCacheEntry> | null = null;
  private currentA2uiCapability: A2uiCapability | null = null;
  // lcp-indw / D2: the stream loop's resetSilenceTimer, shared into the
  // canUseTool closure (same pattern as currentRunHandle above). While an
  // `ask` is parked we periodically call this so a human-paced approval does
  // NOT trip the silence watchdog (SHIM_POOL_TURN_SILENCE_MS). It reverts
  // automatically when the park ends (the keepalive interval is cleared).
  // The absolute turn ceiling (SHIM_POOL_TURN_TIMEOUT) remains the hard
  // backstop so a forgotten approval can never park a worker forever.
  private currentResetSilenceTimer: (() => void) | null = null;
  // Monotonic seq counter for synthesized approval frames within the
  // current turn. Real upstream frames carry seq_id from letta-code; the
  // SDK-side synthetic ones start at a high offset so they don't collide
  // with any upstream-allocated ids in the same turn.
  private syntheticSeqId = 1_000_000;
  private readonly externalTools: AnyAgentTool[];

  constructor({ conversationId, agentId, tools }: LettaSessionAdapterOptions) {
    this.conversationId = conversationId;
    this.agentId = agentId;
    this.externalTools = tools ?? [];
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
    // lcp-4d5f: apply the shim's persisted per-agent reflection settings on
    // every session spawn. Undefined when the agent has no override so the
    // CLI's own defaults stay in charge.
    const sleeptime = sleeptimeOptionsForAgent(this.agentId);
    const session = resumeSession(target, {
      includePartialMessages: true,
      ...(sleeptime ? { sleeptime } : {}),
      ...(this.externalTools.length > 0 ? { tools: this.externalTools } : {}),
      // vibesync-uuas: spawn at bypassPermissions by default so tool
      // calls (esp. the Agent/Task tool used by rig dispatch to spawn
      // role subagents) execute without halting on requires_approval.
      // At "default" the headless rig path deadlocks: no approver is
      // attached, the run ends on stop_reason="requires_approval", and
      // the formula step closes with empty output. Overridable via
      // SHIM_PERMISSION_MODE for interactive/A2UI-approval deployments.
      permissionMode: currentPermissionMode(),
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

    // lcp-n66y: tag this conversation as the main session role so the
    // fork-verdict evaluator can distinguish main-thread tool calls from
    // fork/subagent workers. Subagents spawned via the Agent tool and fork
    // copies created via /v1/conversations/{id}/fork will be tagged
    // separately at their spawn points (lcp-n66y-fork, lcp-n66y-subagent).
    setSessionRole(this.agentId, this.conversationId, "main");

    logLine(`started agent=${this.agentId} conv=${this.conversationId} session=${this.sessionId}`);
    return { agentId: init.agentId, conversationId: init.conversationId };
  }

  async runTurn(input: string | unknown[], opts: RunTurnOptions = {}): Promise<AdapterRunTurnResult> {
    // Serialize: if a previous turn is in flight on this adapter, wait for
    // it before starting the next. Matches direct adapter semantics.
    const turn = this.chain.then(() => this._runTurnInner(input, opts));
    this.chain = turn.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sdk-adapter] turn chain recovered after failure for ${this.conversationId}: ${msg}`);
    });
    return turn;
  }

  private async _runTurnInner(input: string | unknown[], opts: RunTurnOptions): Promise<AdapterRunTurnResult> {
    if (!this.session) throw new Error("SDK adapter: runTurn before start()");
    if (this.dead) throw new Error("SDK adapter: runTurn on dead adapter");
    const session = this.session;

    // lcp-sdk.4: same runHandle resolution as the direct adapter. Mobile
    // WS callers pre-create the handle so turn_started can carry run_id
    // before the first content frame (lcp-99a); REST/SSE callers don't.
    // lcp-0tmo: Stop is authoritative. The SDK's abort() only writes an
    // interrupt control request; it does not wake a local stream waiter. Keep
    // a per-turn cancellation deferred and race every stream read against it
    // so cancelRun() severs this turn immediately, then retain a close/evict
    // backstop for any SDK worker that ignores the interrupt.
    let cancelled = false;
    let settled = false;
    let cancelGraceTimer: NodeJS.Timeout | null = null;
    let resolveCancellation: ((reason: string) => void) | null = null;
    const cancellation = new Promise<string>((resolve) => {
      resolveCancellation = resolve;
    });
    const cancelSession = (reason = "user_cancelled"): void => {
      if (!cancelled) {
        cancelled = true;
        resolveCancellation?.(reason);
      }
      void session.abort().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[sdk-adapter] session abort failed for ${this.conversationId}: ${msg}`);
      });
      if (!cancelGraceTimer) {
        const graceMs = Math.max(0, Number(process.env["SHIM_CANCEL_GRACE_MS"] ?? 1000));
        cancelGraceTimer = setTimeout(() => {
          if (settled) return;
          try {
            opts.onCancelGraceExpired?.(runHandle.id);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[sdk-adapter] cancel grace handler failed for ${this.conversationId}: ${msg}`);
          }
          void this.close().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[sdk-adapter] cancel force-close failed for ${this.conversationId}: ${msg}`);
          });
        }, graceMs);
        cancelGraceTimer.unref?.();
      }
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
        try {
          opts.onRunCreated(runHandle.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[sdk-adapter] onRunCreated hook failed for ${runHandle.id}: ${msg}`);
        }
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
    // lcp-r0m: stash the same snapshot on the run handle so a concurrent
    // REST /messages hydrate during this turn can compute the in-flight
    // set (= current disk ids − pre-turn snapshot) and drop those rows
    // before they collide with the WS delta stream.
    setMessageIdsAtTurnStart(runHandle, messageIdsBefore);

    // lcp-wd3i: reset per-turn override counter for fork-verdict bypass.
    resetOverrideTurnCounter(this.agentId, this.conversationId);

    // Anchor stamp time: caller may supply a turn-start time captured
    // before this method ran (mobile WS uses this so disk-stamped and
    // stream-emitted timestamps share a base). Fall back to `now`.
    const passedStart = opts.turnStartedAt;
    const turnStartedAt = passedStart instanceof Date
      ? passedStart
      : (typeof passedStart === "number" ? new Date(passedStart) : new Date());

    const frames: LettaStreamFrame[] = [];
    let frameCountTotal = 0;
    // lcp-2oxb.5: retention policy for the per-turn frames[] buffer.
    // assistant_message / reasoning_message stream_events are partial
    // DELTAS — hundreds per turn, ~20 MB retained on a heavy streaming
    // turn — and nothing downstream of this adapter reads them back:
    // finalizeTurnLifecycle needs stop_reason/usage frames, turn
    // settlement needs tool_call/tool_return/approval frames, and every
    // live consumer already received the delta via onFrame. Drop them
    // from retention; everything else (tool frames, approvals, stop,
    // usage, result, auto_approval) is kept.
    const retainFrame = (f: LettaStreamFrame): boolean => {
      if (f.type !== "stream_event") return true;
      const mt = (f.event as { message_type?: unknown }).message_type;
      return mt !== "assistant_message" && mt !== "reasoning_message";
    };
    let pendingStepUsage: UsageInput | null = null;
    let result: SDKResultMessage | null = null;
    // lcp-0vi: SDK pumps an `SDKErrorMessage` when the CLI hits a recoverable
    // failure (e.g. Anthropic invalid_request_error from a dangling tool_use).
    // We drop the frame from the wire (no LettaStreamFrame variant for it),
    // but we MUST preserve the payload so the heal+retry wrapper in
    // agent-pool.ts can match the dangling-tool-use signature and trigger
    // recovery. Last-write-wins matches the CLI's emit model — only one
    // error precedes the terminating result frame.
    let lastError: SDKErrorMessage | null = null;
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

    // lcp-qec: scaffold the per-agent A2UI protocol memory file the
    // first time an A2UI-capable client lands on this agent. The bootstrap
    // is idempotent and self-cached (per process + per agent), and now
    // strictly write-if-absent — once scaffolded, the agent owns the
    // file forever. Capability-gated so non-A2UI clients don't create
    // dead memory files on agents that will never emit A2UI.
    //
    // Previous home for this call was agent-pool.ts's direct-subprocess
    // turn driver, which was excised in lcp-sdk.10. Without this re-wire,
    // newly-provisioned agents on the SDK path never see the A2UI
    // protocol contract in their memory, and A2UI emissions degrade to
    // unstructured text.
    if (this.currentA2uiCapability) {
      ensureA2uiBlockAttached(this.agentId);
    }

    // lcp-5o2: silence watchdog + absolute ceiling instead of a single
    // total-budget timer. silenceTimer resets on every emitted frame; if
    // the stream stays silent for TURN_SILENCE_MS we declare timeout. The
    // absolute ceiling is a backstop for pathological turns that keep
    // emitting one frame per minute forever.
    const fireTimeout = (reason: string) => {
      if (timedOut) return;
      timedOut = true;
      console.warn(`[sdk-adapter] turn watchdog fired (${reason}) for ${this.conversationId}`);
      void session.abort().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[sdk-adapter] watchdog abort failed for ${this.conversationId}: ${msg}`);
      });
    };

    let silenceTimer: NodeJS.Timeout | null = null;
    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => fireTimeout("silence"), TURN_SILENCE_MS);
    };
    resetSilenceTimer();
    // lcp-indw / D2: expose the silence-watchdog reset to the canUseTool
    // closure so a parked `ask` can keep the turn alive across a long,
    // human-paced approval without faking wire traffic.
    this.currentResetSilenceTimer = resetSilenceTimer;

    const absoluteTimer: NodeJS.Timeout = setTimeout(
      () => fireTimeout("absolute"),
      TURN_TIMEOUT_MS,
    );

    try {
      await session.send(sendInput);

      const iterator = session.stream()[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([
          iterator.next().then((value) => ({ kind: "message" as const, value })),
          cancellation.then((reason) => ({ kind: "cancelled" as const, reason })),
        ]);
        if (next.kind === "cancelled") break;
        const { value, done } = next.value;
        if (done) break;
        const msg = value as SDKMessage;
        if (cancelled) break;
        // lcp-5o2: any incoming SDK message is proof of life; reset the
        // silence watchdog whether or not the message produces a routable
        // frame. We reset BEFORE frame conversion so even noisy / dropped
        // messages still count as activity.
        resetSilenceTimer();
        const frame = sdkMessageToLettaFrame(msg, this.sessionId, this.agentId, this.conversationId);
        if (frame && !cancelled) {
          // Mirror the direct adapter: heartbeat lastUsedAt on every frame
          // so housekeep() doesn't idle-evict an in-flight long turn.
          this.lastUsedAt = Date.now();
          frameCountTotal += 1;
          if (retainFrame(frame)) frames.push(frame);
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
        if (cancelled) break;
        if (msg.type === "error") {
          // lcp-0vi: stash the error so the heal wrapper sees it after the
          // stream loop returns. The CLI may still emit a terminating result
          // frame after this, so we don't break here.
          lastError = msg;
          logLine(`SDK_ERROR ${safeJson(msg)}`);
        }
        if (msg.type === "result") {
          result = msg;
          if (!msg.success) {
            logLine(`SDK_RESULT_ERROR ${safeJson(msg)}`);
          }
          break;
        }
        if (timedOut) break;
      }
    } finally {
      // lcp-5o2: clear both watchdog timers introduced with the silence
      // watchdog refactor. Either or both may already have fired by now;
      // clearTimeout is idempotent on fired timers.
      settled = !cancelled;
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      if (!cancelled && cancelGraceTimer) {
        clearTimeout(cancelGraceTimer);
        cancelGraceTimer = null;
      }
      clearTimeout(absoluteTimer);
      this.lastUsedAt = Date.now();
      // lcp-sdk.5: clear per-turn approval context. Any canUseTool that
      // fires AFTER this (it shouldn't, since the stream ended) gets a
      // safe default-allow path in _handleCanUseTool.
      this.currentRunHandle = null;
      this.currentOnFrame = null;
      this.currentApprovalScopeCache = null;
      this.currentA2uiCapability = null;
      this.currentResetSilenceTimer = null;
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

    // lcp-0vi: surface the SDK error payload through every return path so
    // pool.runTurnWithHeal() can match the dangling-tool-use signature.
    // The fields we carry mirror what `detectDanglingToolUses` reads —
    // {message, errorDetail, apiError} — which is enough to fire detection
    // without hauling the full SDKErrorMessage shape upward.
    const errorPayload = sdkErrorPayload(lastError, result);
    if (timedOut) {
      return { frames, frameCountTotal, stderr: "", run_id: runHandle.id, timeout: true, cancelled, newUserMessageId, ...(errorPayload ? { errorPayload } : {}) };
    }
    if (result) {
      return {
        frames,
        frameCountTotal,
        stderr: "",
        run_id: runHandle.id,
        done: result.success,
        cancelled,
        newUserMessageId,
        // SDK surfaces upstream Letta run ids as `result.runIds`. We do NOT
        // expose them as the mobile-facing run id — the shim continues to
        // own /v1/runs/* (see lcp-sdk-decide-runid). Caller correlates via
        // opts.runHandle.id, which we echo back unchanged.
        ...(errorPayload ? { errorPayload } : {}),
      };
    }
    // Stream ended without a result frame (e.g. session closed mid-turn).
    return { frames, frameCountTotal, stderr: "", run_id: runHandle.id, dead: true, cancelled, newUserMessageId, error: "stream ended without result", ...(errorPayload ? { errorPayload } : {}) };
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

    if (runHandle.record?.metadata?.["goal_continuation"] === true && toolName === GOAL_CONTROL_TOOL) {
      recordApprovalDecision(runHandle.id, {
        action_id: `goal-continuation-${randomUUID()}`,
        tool_name: toolName,
        decision: "approve",
        scope: "Once",
        reason: "goal_continuation_lifecycle_tool",
        timestamp: new Date().toISOString(),
      });
      return { behavior: "allow", message: "goal_continuation_lifecycle_tool" };
    }

    // lcp-indw / D6: server-side permissions path is gated behind
    // SHIM_SERVER_PERMISSIONS=1 (default OFF). When the flag is off, this
    // returns null and we fall through to the byte-identical legacy behavior
    // below (bypassPermissions short-circuit / A2UI gate). When on, the
    // evaluator decides allow/deny/ask per the on-disk rules.
    if (serverPermissionsEnabled()) {
      const decided = await this._handleCanUseToolServerPermissions(
        toolName,
        toolInput,
        runHandle,
        onFrame,
        cache,
      );
      if (decided) return decided;
    }

    if (currentPermissionMode() === "bypassPermissions") {
      recordApprovalDecision(runHandle.id, {
        action_id: `bypass-${randomUUID()}`,
        tool_name: toolName,
        decision: "approve",
        scope: "Once",
        reason: "permission_mode_bypassPermissions",
        timestamp: new Date().toISOString(),
      });
      return { behavior: "allow", message: "permission_mode_bypassPermissions" };
    }

    // No A2UI client connected → default-allow. Matches the direct adapter's
    // `a2uiCapability ? approvalRequestToolCall(frame) : null` short-circuit.
    if (!a2ui) {
      return { behavior: "allow" };
    }

    const toolCallId = `synthetic-${randomUUID()}`;
    const timestamp = new Date().toISOString();

    if (isShimSelfRestartTool(toolName, toolInput)) {
      emitShimRestartNotice({
        onFrame,
        sessionId: this.sessionId,
        agentId: this.agentId,
        conversationId: this.conversationId,
        runId: runHandle.id,
        seqId: ++this.syntheticSeqId,
        toolName,
        toolCallId,
      });
      const decision = resolveShimRestartApproval(runHandle.id, toolName);
      recordApprovalDecision(runHandle.id, {
        action_id: decision.actionId,
        tool_name: toolName,
        decision: "approve",
        scope: "Once",
        reason: "shim_self_restart_auto_approved",
        timestamp,
      });
      return {
        behavior: "allow",
        message: decision.reason,
        updatedInput: detachShimSelfRestartInput(toolInput),
      };
    }

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

  /**
   * lcp-indw: server-side permissions evaluator hook. Only invoked when
   * SHIM_SERVER_PERMISSIONS=1. Returns a CanUseToolResponse (always — when
   * the flag is on the evaluator is authoritative), or null only on an
   * internal error so the caller can fall back to legacy behavior.
   *
   * Decision flow (§3.1):
   *   allow → record approve(rule_allow); allow.
   *   deny  → record deny(rule_deny); emit a deny frame; deny(reason).
   *   ask   → (a) scope cache hit → auto-allow;
   *           (b) write pending-approval.json (durable "a turn is waiting");
   *           (c) emit the canonical approval_request_message frame;
   *           (d) park on the durable wait (no 30s cap; turn-ceiling timeout);
   *           (e) on decision: record audit/policy, clear pending, return.
   *
   * D5 (headless / no-approver semantics): a `deny` rule always denies; an
   * `ask` with NO approver (no A2UI client connected) → DENY with reason
   * (NOT auto-allow), so headless/cron/rig turns keep working as long as
   * the operator's rules don't ask/deny the tools the rig needs;
   * `allow`/default-allow always allows.
   */
  private async _handleCanUseToolServerPermissions(
    toolName: string,
    toolInput: Record<string, unknown>,
    runHandle: RunHandle,
    onFrame: ((frame: LettaStreamFrame, meta: { runId: string }) => void) | null,
    cache: Map<string, ApprovalScopeCacheEntry>,
  ): Promise<CanUseToolResponse | null> {
    const a2ui = this.currentA2uiCapability;
    const timestamp = new Date().toISOString();
    if (isShimSelfRestartTool(toolName, toolInput)) {
      emitShimRestartNotice({
        onFrame,
        sessionId: this.sessionId,
        agentId: this.agentId,
        conversationId: this.conversationId,
        runId: runHandle.id,
        seqId: ++this.syntheticSeqId,
        toolName,
      });
      recordApprovalDecision(runHandle.id, {
        action_id: `shim-restart-${randomUUID()}`,
        tool_name: toolName,
        decision: "approve",
        scope: "Once",
        reason: "shim_self_restart_auto_approved",
        timestamp,
      });
      return {
        behavior: "allow",
        message: "shim_self_restart_auto_approved",
        updatedInput: detachShimSelfRestartInput(toolInput),
      };
    }

    if (runHandle.record?.metadata?.["goal_continuation"] === true && toolName === GOAL_CONTROL_TOOL) {
      recordApprovalDecision(runHandle.id, {
        action_id: `goal-continuation-${randomUUID()}`,
        tool_name: toolName,
        decision: "approve",
        scope: "Once",
        reason: "goal_continuation_lifecycle_tool",
        timestamp,
      });
      return { behavior: "allow", message: "goal_continuation_lifecycle_tool" };
    }

    // lcp-wd3i: evaluate with fork-verdict awareness, including
    // session-role based exemption (fork/subagent sessions always
    // bypass fork rules — workers must work).
    const sessionRole: ForkSessionRole = getSessionRole(this.agentId, this.conversationId);
    const result = evaluatePermissionWithFork(
      this.agentId,
      this.conversationId,
      toolName,
      toolInput,
      sessionRole,
    );

    // ── Fork verdict handling (lcp-wd3i) ───────────────────────────────
    if (result.action === "fork") {
      let forkResolved = false;

      // Check for agent-actuated override
      if (forkOverrideEnabled()) {
        const override = extractOverride(toolInput);
        if (override) {
          const rateLimitHit = checkOverrideRateLimit(this.agentId, this.conversationId);
          if (!rateLimitHit) {
            // Override accepted — execute inline + audit
            recordOverride(this.agentId, this.conversationId);
            appendOverrideAudit({
              agentId: this.agentId,
              conversationId: this.conversationId,
              toolName,
              rule: override.rule,
              justification: override.reason,
              timestamp,
            });
            logLine(`fork override accepted for ${toolName} by agent ${this.agentId}: ${override.reason}`);
            recordApprovalDecision(runHandle.id, {
              action_id: `fork-override-${randomUUID()}`,
              tool_name: toolName,
              decision: "approve",
              scope: "Once",
              reason: `fork_override: ${override.reason}`,
              timestamp,
            });
            // lcp-3ruh: pass the CLEANED input (without override fields) to
            // the tool executor via updatedInput. The audit log above
            // already captured the raw input with override fields intact.
            return {
              behavior: "allow",
              message: `fork overridden: ${override.reason}`,
              updatedInput: stripOverrideFields(toolInput),
            };
          }
          // Over limit — mutate result to "ask" and fall through to
          // the ask handling below. If no approver is connected, the
          // ask path will deny (headless safe default, D5).
          (result as { action: string }).action = "ask";
          (result as { reason: string }).reason =
            `fork override rate-limited: ${rateLimitHit} (escalated to ask)`;
          forkResolved = true;
          // Fall through to ask handling below
        }
      }

      if (!forkResolved) {
        // No override → structured fork denial
        recordApprovalDecision(runHandle.id, {
          action_id: `rule-fork-${randomUUID()}`,
          tool_name: toolName,
          decision: "deny",
          scope: "Deny",
          reason: result.reason || "rule_fork",
          timestamp,
        });

        const forkInstructions = [
          `Tool "${toolName}" requires a fork. Dispatch via Agent(subagent_type:'fork', run_in_background:true) with the intended work.`,
          result.reason ? `Reason: ${result.reason}` : null,
          forkOverrideEnabled()
            ? 'To execute inline, re-issue with permissions_override: { rule: "<matched_rule>", reason: "<one-line justification>" }'
            : null,
        ].filter(Boolean).join("\n");

        this._emitApprovalDenyFrame(toolName, forkInstructions, runHandle, onFrame);
        return { behavior: "deny", message: forkInstructions };
      }
    }

    // Existing allow/deny/ask handling below (unchanged)

    if (result.action === "allow") {
      recordApprovalDecision(runHandle.id, {
        action_id: `rule-allow-${randomUUID()}`,
        tool_name: toolName,
        decision: "approve",
        scope: "Once",
        reason: result.reason || "rule_allow",
        timestamp,
      });
      return { behavior: "allow", message: result.reason || "rule_allow" };
    }

    if (result.action === "deny") {
      recordApprovalDecision(runHandle.id, {
        action_id: `rule-deny-${randomUUID()}`,
        tool_name: toolName,
        decision: "deny",
        scope: "Deny",
        reason: result.reason || "rule_deny",
        timestamp,
      });
      // Emit a deny frame so a connected client sees WHY the tool was blocked.
      this._emitApprovalDenyFrame(toolName, result.reason || "rule_deny", runHandle, onFrame);
      return { behavior: "deny", message: result.reason || "rule_deny" };
    }

    // result.action === "ask"
    // (a) Session/Forever scope cache → auto-allow without a round-trip.
    const cached = cache.get(toolName);
    if (cached) {
      recordApprovalDecision(runHandle.id, {
        action_id: `cached-${randomUUID()}`,
        tool_name: toolName,
        decision: "approve",
        scope: cached.scope,
        reason: "cached_approval",
        timestamp,
      });
      return { behavior: "allow", message: "cached_approval" };
    }

    // D5: ask with no approver attached → DENY (headless safe default).
    if (!a2ui) {
      const reason = result.reason
        ? `${result.reason} (no approver connected; headless deny)`
        : "ask rule requires approval but no approver is connected (headless deny)";
      recordApprovalDecision(runHandle.id, {
        action_id: `no-approver-${randomUUID()}`,
        tool_name: toolName,
        decision: "deny",
        scope: "Deny",
        reason,
        timestamp,
      });
      this._emitApprovalDenyFrame(toolName, reason, runHandle, onFrame);
      return { behavior: "deny", message: reason };
    }

    const toolCallId = `synthetic-${randomUUID()}`;

    // (b) Write the durable pending-approval file BEFORE parking — the
    //     on-disk truth that "a turn is waiting", keyed by runId.
    try {
      createPendingApproval({
        runId: runHandle.id,
        agentId: this.agentId,
        conversationId: this.conversationId,
        toolCallId,
        toolName,
        toolInput,
        reason: result.reason,
        ruleSource: result.source,
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logLine(`pending-approval write failed for ${runHandle.id}: ${m}`);
    }

    // (c) Emit the canonical approval_request_message frame (persists to
    //     frames.jsonl, replays via subscribeToRun — the one wire contract
    //     both clients already render).
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
        reason: result.reason,
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

    // (d) Park on the durable wait. No 30s cap — the wait lives as long as
    //     the turn; the absolute turn ceiling (SHIM_POOL_TURN_TIMEOUT) is the
    //     hard backstop so a forgotten approval can never park forever.
    //
    //     D2 (Commit 2): while parked, reset the silence watchdog on a
    //     cadence shorter than SHIM_POOL_TURN_SILENCE_MS so a human-paced
    //     approval does not trip the turn's silence timeout. The interval is
    //     unref'd (never keeps the process alive) and is cleared the instant
    //     the wait settles, reverting to normal silence-watchdog behavior.
    const askTimeoutMs = Number(process.env["SHIM_POOL_TURN_TIMEOUT"] ?? 1_800_000);
    // Read the silence budget live (env may be overridden per-deployment/test)
    // and keep alive at half that cadence so the watchdog never trips while
    // parked. Floor of 25ms keeps the interval sane under tiny test budgets.
    const silenceBudgetMs = Number(process.env["SHIM_POOL_TURN_SILENCE_MS"] ?? TURN_SILENCE_MS);
    const keepaliveMs = Math.max(25, Math.floor(silenceBudgetMs / 2));
    const reset = this.currentResetSilenceTimer;
    // lcp-2oxb.2: while parked on an `ask`, bump lastUsedAt on each keepalive
    // tick in addition to resetting the silence watchdog. Without this, a long
    // human-paced approval parks the worker with a stale lastUsedAt — making
    // it the LRU victim in get()'s cap-eviction loop. The busy-skip in get()
    // (also lcp-2oxb.2) is the primary guard; this is defense-in-depth so
    // that if busy transitions to false between ticks the worker is still not
    // flagged as idle-stale by the time the next housekeep fires.
    const keepalive: NodeJS.Timeout | null = reset
      ? setInterval(() => {
          try { reset(); } catch { /* best-effort */ }
          this.lastUsedAt = Date.now();
        }, keepaliveMs)
      : null;
    keepalive?.unref?.();
    let decision: ApprovalDecision;
    try {
      decision = await waitForApprovalDecision(runHandle.id, toolName, toolCallId, askTimeoutMs);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      recordApprovalDecision(runHandle.id, {
        action_id: `timeout-${toolCallId}`,
        tool_name: toolName,
        decision: reason.startsWith("approval_timeout") ? "timeout" : "deny",
        scope: "Deny",
        reason,
        timestamp,
      });
      clearPendingApproval(runHandle.id);
      return { behavior: "deny", message: reason };
    } finally {
      // D2: stop refreshing the silence watchdog the instant the park ends —
      // normal silence-watchdog behavior resumes automatically.
      if (keepalive) clearInterval(keepalive);
    }

    // (e) Decision received via the resolveApproval funnel (WS or REST). The
    //     funnel already rewrote the pending file + recorded audit/policy +
    //     broadcast; we clear the pending file on turn-tool completion and
    //     update the in-process scope cache for Session/Forever approvals.
    if (
      decision.decision === "approve" &&
      (decision.scope === "Session" || decision.scope === "Forever")
    ) {
      cache.set(toolName, {
        scope: decision.scope as Extract<ApprovalScope, "Session" | "Forever">,
        timestamp,
      });
    }
    clearPendingApproval(runHandle.id);
    return decision.decision === "approve"
      ? { behavior: "allow", message: decision.reason }
      : { behavior: "deny", message: decision.reason };
  }

  /**
   * lcp-indw: emit a lightweight deny frame so a connected client sees that
   * (and why) a tool was blocked by a rule, rather than the tool silently
   * vanishing. Reuses the approval_request_message-adjacent shape with a
   * terminal status so existing renderers can surface it.
   */
  private _emitApprovalDenyFrame(
    toolName: string,
    reason: string,
    runHandle: RunHandle,
    onFrame: ((frame: LettaStreamFrame, meta: { runId: string }) => void) | null,
  ): void {
    const seqId = ++this.syntheticSeqId;
    const frame: LettaStreamFrame = {
      type: "stream_event",
      session_id: this.sessionId,
      uuid: `synthetic-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      event: {
        message_type: "approval_resolved",
        id: `synthetic-deny-${seqId}`,
        date: new Date().toISOString(),
        agent_id: this.agentId,
        conversation_id: this.conversationId,
        run_id: runHandle.id,
        seq_id: seqId,
        status: "denied",
        reason,
        tool_name: toolName,
      } as unknown as LettaInnerEvent,
    };
    try { onFrame?.(frame, { runId: runHandle.id }); } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logLine(`onFrame error during deny emit: ${m}`);
    }
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
  // PROBE 2026-05-24 (lcp-4vz / lcp-pgw debug — kept intentionally).
  //
  // Logs every SDK msg.type and (when stream_event) the inner message_type.
  // Critical for diagnosing tool-frame flow issues — empirically proved during
  // lcp-4vz that the CLI's headless SDK transport NEVER emits tool_return
  // wire frames for canUseTool-mediated tools (auto_approval path). The
  // shim works around this by reading tool results from messages.jsonl in
  // mobile-channel-host.ts (synthesizes wire tool_return_message frames).
  //
  // If you see "wait, why am I not getting tool_return on the wire?":
  //   1. grep /tmp/admin-shim.log for "SDK_MSG inner=tool_return_message"
  //   2. If absent: the CLI/SDK STILL aren't emitting them; the disk-watch
  //      workaround in mobile-channel-host (bridgeSendMessage) is what's
  //      keeping things working. Don't waste time hunting in this file.
  //   3. If present: something downstream of here is dropping them. Hunt
  //      in chat.ts:reshapeFrame and emit() in mobile-channel-host.
  //
  // Cheap if DEBUG_SDK is unset (logLine no-ops). Leave it.
  try {
    const inner = (msg as { event?: { message_type?: string } }).event?.message_type;
    logLine(`SDK_MSG type=${msg.type}${inner ? ` inner=${inner}` : ""}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logLine(`SDK_MSG logging_failed=${detail}`);
  }
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
    case "tool_result": {
      // lcp-4vz (closed 2026-05-24): DEAD CODE AS OF letta-code 0.26.1.
      //
      // This branch was originally added as a speculative fix when I thought
      // the SDK was emitting standalone SDKToolResultMessage that I was
      // dropping. Empirically verified via DEBUG_SDK=1 wire dump: the
      // CLI's headless SDK transport NEVER emits a `type:"message"` with
      // `message_type:"tool_return_message"`, so `transformMessage` never
      // produces an SDKToolResultMessage, so this case never fires.
      //
      // The actual fix lives in mobile-channel-host.ts:bridgeSendMessage —
      // post-turn (and now per-tool via incremental disk-watch in lcp-pgw)
      // it reads `role:"toolResult"` entries from the conv's messages.jsonl
      // and synthesizes wire tool_return_message frames into the WS stream.
      //
      // KEEPING THIS BRANCH because: if a future CLI/SDK update fixes the
      // upstream gap and starts emitting standalone tool_result, this
      // translation will Just Work and the shim's disk synthesis will
      // become a no-op (it diffs disk-vs-wire and only emits the difference).
      // Defense in depth, not active code path.
      //
      // If you find yourself debugging tool-return flow and this branch IS
      // firing, that's a SIGNAL — the upstream CLI changed. Update the
      // mobile-channel-host disk-synthesis logic to honor the new wire
      // events as authoritative and skip its disk pass when this branch
      // already emitted the matching tool_call_id.
      return {
        type: "stream_event",
        event: {
          message_type: "tool_return_message",
          id: msg.uuid,
          date: new Date().toISOString(),
          agent_id: agentId,
          conversation_id: conversationId,
          run_id: msg.runId ?? null,
          tool_call_id: msg.toolCallId,
          status: msg.isError ? "error" : "success",
          tool_return: msg.content,
          tool_returns: [{
            tool_call_id: msg.toolCallId,
            status: msg.isError ? "error" : "success",
            func_response: msg.content,
            stdout: null,
            stderr: null,
            type: "tool",
          }],
        } as unknown as LettaInnerEvent,
        session_id: sessionId,
        uuid: msg.uuid,
        timestamp: new Date().toISOString(),
      };
    }
    case "assistant":
    case "tool_call":
    case "reasoning":
      // These DO arrive as stream_event frames in parallel with their
      // standalone projections (verified on SDK transport 2026-05-24:
      // the assistant_message text appears in stream_event chunks AND
      // as final SDKAssistantMessage). Drop the standalone forms to
      // avoid double-emission. The stream_event path carries the full
      // delta sequence reshapeFrame and the A2UI splitter expect.
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
