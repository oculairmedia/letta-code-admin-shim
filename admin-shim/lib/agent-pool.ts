/**
 * Per-conversation pool of `@letta-ai/letta-code-sdk` Sessions.
 *
 * Each pool entry is one SDK Session pinned to one (agent, conversation)
 * pair. The Session owns the underlying letta-code CLI subprocess; this
 * file owns the keying, single-flight, LRU eviction, and shared
 * turn-lifecycle helpers that the SDK adapter reuses.
 *
 * Design constraints:
 *   - Single-writer per session: each adapter's `runTurn` calls are
 *     serialized through an internal Promise chain so two turns can never
 *     overlap on the same Session.
 *   - State is in-process Map; no DB. Idle eviction + hard cap = bounded.
 *   - Cold-start fallback is automatic: pool miss → resumeSession → first
 *     frame.
 *   - Session death is graceful: adapter is dropped, next request
 *     cold-starts.
 *
 * Tuneables (env):
 *   SHIM_POOL_MAX           default 10   hard cap on warm sessions
 *   SHIM_POOL_IDLE_SEC      default 300  evict sessions idle this long
 *   SHIM_POOL_SPAWN_TIMEOUT default 15000 ms to wait for the init message
 *   SHIM_POOL_TURN_TIMEOUT  default 180_000 ms watchdog per turn
 *   SHIM_POOL_QUEUE_MAX     default 16   cold spawns queued when all busy (lcp hr5rw)
 *   SHIM_POOL_QUEUE_TIMEOUT_MS default 30_000 queue wait budget before 503
 *
 * Note (lcp-sdk.10, 2026-05-22): the hand-rolled subprocess transport
 * was retired in favor of the SDK transport. The Session adapter is the
 * only implementation. Operators no longer pick a transport — there's
 * no flag, and there's no rollback path inside this codebase. The
 * release before this one shipped both behind `SHIM_LETTA_TRANSPORT=sdk`
 * if you need to revert to that codepath.
 */

import { listMessages, stampNewMessages } from "./store.js";
// lcp-2oxb.1: perf instrumentation surfaced through pool stats.
import {
  getEventLoopDelayStats,
  getFrameAppendStats,
  getRssBytes,
  type EventLoopDelayStats,
  type FrameAppendStats,
} from "./perf-metrics.js";
import { type A2uiCapability } from "./a2ui-adapter.js";
import type { AnyAgentTool } from "@letta-ai/letta-code-sdk";
import {
  detectConsecutiveUserMessageIndices,
  detectDanglingToolUses,
  detectRoleAlternationViolation,
  detectUnexpectedToolResults,
  healConsecutiveUserMessages,
  healConversation,
  healUnexpectedToolResults,
} from "./conversation-healer.js";
import {
  finalizeRun,
  markRunFirstToken,
  recordRunMessage,
  recordRunOtid,
  recordRunStep,
  recordRunTool,
  setRunCancelHandler,
  type RunHandle,
  type UsageInput,
  type ApprovalScope,
} from "./runs.js";
import {
  settleDanglingToolCallsFromFrames,
  type SettlementReason,
} from "./turn-settlement.js";
import type {
  LettaStreamFrame,
  LettaInnerEvent,
  UsageStatisticsEvent,
} from "./types/letta-stream.js";
import { runTurnWithLlmRetry } from "./llm-retry.js";

const MAX_WORKERS = Number(process.env["SHIM_POOL_MAX"] ?? 10);
const IDLE_EVICT_MS = Number(process.env["SHIM_POOL_IDLE_SEC"] ?? 300) * 1000;
// Default 30s in prod. Tests override via SHIM_POOL_HOUSEKEEP_MS so they
// can exercise the idle-evict path within the suite's wall-clock budget
// rather than waiting half a minute per case.
const HOUSEKEEP_INTERVAL_MS = Number(process.env["SHIM_POOL_HOUSEKEEP_MS"] ?? 30_000);
// lcp hr5rw (§3a): bounded FIFO overflow queue for cold spawns when every
// worker at/over cap is busy. Previously the cap loop `break`ed and spawned
// anyway — unbounded overflow at 330–445MB per extra worker.
const QUEUE_MAX = Number(process.env["SHIM_POOL_QUEUE_MAX"] ?? 16);
const QUEUE_TIMEOUT_MS = Number(process.env["SHIM_POOL_QUEUE_TIMEOUT_MS"] ?? 30_000);

/**
 * lcp hr5rw (§3a): typed capacity errors so callers can map deterministically:
 *   pool_saturated    → HTTP 429 (queue full at enqueue time)
 *   pool_queue_timeout → HTTP 503 (queued but no capacity within the window)
 *   cancelled          → the run was cancelled while queued
 */
export type PoolCapacityErrorCode = "pool_saturated" | "pool_queue_timeout" | "cancelled";

export class PoolCapacityError extends Error {
  readonly code: PoolCapacityErrorCode;
  constructor(code: PoolCapacityErrorCode, message: string) {
    super(message);
    this.name = "PoolCapacityError";
    this.code = code;
  }
}

/** Narrow an unknown error to a pool-capacity code, if it carries one. */
export function poolCapacityErrorCode(err: unknown): PoolCapacityErrorCode | null {
  if (err instanceof PoolCapacityError) return err.code;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "pool_saturated" || code === "pool_queue_timeout" || code === "cancelled"
    ? code
    : null;
}

/** One FIFO entry waiting for pool capacity (cold-spawn path only). */
interface CapacityWaiter {
  key: string;
  /** Run ids of the callers coalesced onto this waiter (for cancelQueued). */
  runIds: string[];
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** True once resolved/rejected (admit, timeout, or cancel). */
  settled: boolean;
  /**
   * Admission grants ONE spawn reservation per waiter; the first coalesced
   * caller to resume claims it, the rest re-check warm/spawning maps.
   */
  reservationClaimed: boolean;
}

/**
 * Approval gate state for a single approval_request_message.
 * Resolves when user decision arrives or timeout fires.
 */
interface ApprovalGateState {
  toolName: string;
  toolCallId: string;
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

/**
 * User approval decision routed from mobile WS channel.
 */
export interface ApprovalDecision {
  decision: "approve" | "deny";
  scope: ApprovalScope;
  reason: string;
  userId?: string;
  actionId: string;
}

/**
 * Map of pending approval gates keyed by run_id.
 * Each run can have at most one active approval gate at a time
 * (turns are serialized per worker).
 */
const approvalGates = new Map<string, ApprovalGateState>();

/**
 * Resolve a pending approval gate with a user decision.
 * Called from mobile-channel-host.ts:handleUserAction() when a user_action
 * frame arrives with approval decision.
 */
export function resolveApprovalGate(
  runId: string,
  decision: ApprovalDecision,
): boolean {
  const gate = approvalGates.get(runId);
  if (!gate) return false;
  
  clearTimeout(gate.timeoutHandle);
  approvalGates.delete(runId);
  gate.resolve(decision);
  return true;
}

/**
 * Reject a pending approval gate (e.g., on worker disconnect).
 * Called from worker SIGTERM handler or on turn timeout.
 */
export function rejectApprovalGate(runId: string, error: Error): boolean {
  const gate = approvalGates.get(runId);
  if (!gate) return false;
  
  clearTimeout(gate.timeoutHandle);
  approvalGates.delete(runId);
  gate.reject(error);
  return true;
}

/**
 * Wait for an approval decision from the mobile WS channel.
 * Returns { decision, scope, reason } on success.
 * Throws on timeout or worker disconnect.
 * 
 * Timeout is 30s per approval request (separate from turn timeout).
 */
export function waitForApprovalDecision(
  runId: string,
  toolName: string,
  toolCallId: string,
  timeoutMsOverride?: number,
): Promise<ApprovalDecision> {
  return new Promise((resolve, reject) => {
    // lcp-indw: the server-side-permissions `ask` path passes an explicit
    // long timeout (tied to the turn ceiling, NOT 30s) so a human-paced
    // approval over WS/REST is not killed by the legacy 30s gate timeout.
    // The legacy A2UI path keeps the 30s default.
    const APPROVAL_TIMEOUT_MS = timeoutMsOverride ?? Number(process.env["A2UI_APPROVAL_TIMEOUT_MS"] ?? 30_000);
    
    const timeoutHandle = setTimeout(() => {
      approvalGates.delete(runId);
      reject(new Error(`approval_timeout: no decision for ${toolName} within ${APPROVAL_TIMEOUT_MS}ms`));
    }, APPROVAL_TIMEOUT_MS);
    
    const gate: ApprovalGateState = {
      toolName,
      toolCallId,
      resolve,
      reject,
      timeoutHandle,
    };
    
    approvalGates.set(runId, gate);
  });
}

/** Options accepted by `LettaSessionAdapter#runTurn`. */
export interface RunTurnOptions {
  onFrame?: (frame: LettaStreamFrame, meta: { runId: string }) => void;
  tools?: AnyAgentTool[];
  closeAfterTurn?: boolean;
  /**
   * Caller-supplied turn-start anchor. `chat.mjs` captures this BEFORE
   * calling `pool.get()` so disk-stamped and stream-emitted timestamps
   * share a base. Accepts Date or epoch-ms number; falls back to `now`.
   */
  turnStartedAt?: Date | number;
  onRunCreated?: (runId: string) => void;
  /**
   * lcp-99a: pre-created Run handle, supplied by callers that need to
   * know the run id BEFORE the turn starts streaming (mobile WS channel
   * uses this to put run_id on the very first turn_started frame so
   * cancel-during-startup is always possible). When supplied, runTurn
   * does NOT createRun() of its own and does NOT invoke onRunCreated
   * (the caller already knows the id). Cancel hook attachment still
   * happens via the handle's own onCancel, so the supplier must wire
   * that when calling createRun().
   */
  runHandle?: RunHandle;
  /** A2UI capability negotiated for this session; absent keeps legacy prompts unchanged. */
  a2uiCapability?: A2uiCapability | null;
  /** Called after user cancellation is requested but before the grace backstop fires. */
  onCancelGraceExpired?: (runId: string) => void;
}

/**
 * Resolution value of `runTurn`. Carries the collected frames, the
 * worker's recent stderr tail, the Run id, and whichever of the
 * lifecycle flags applies (only one of `done`/`exit`/`timeout`/`dead`
 * is set in practice).
 */
export interface RunTurnResult {
  /**
   * lcp-2oxb.5: retained frames only. assistant/reasoning partial deltas
   * are dropped after side-effects + onFrame delivery (they dominated
   * per-turn memory and have no post-turn consumer). `frameCountTotal`
   * preserves the true stream volume for diagnostics.
   */
  frames: LettaStreamFrame[];
  frameCountTotal?: number;
  stderr: string;
  run_id?: string;
  cancelled?: boolean;
  /** True when a `result` frame closed the turn cleanly. */
  done?: boolean;
  /** True when the child exited mid-turn. */
  exit?: boolean;
  /** Exit code captured from the synthetic __exit__ frame. */
  code?: number | null;
  /** True when TURN_TIMEOUT_MS elapsed before completion. */
  timeout?: boolean;
  /** True when the worker was already dead or stdin write failed. */
  dead?: boolean;
  /** Set when an error short-circuited the turn (e.g. stdin write). */
  error?: string;
  /**
   * lcp-0vi: structured payload of the last SDKErrorMessage observed
   * during the turn. Surfaced so the heal+retry wrapper can match the
   * dangling-tool-use signature via detectDanglingToolUses() without
   * touching the SDK union type directly. Fields mirror what the
   * detector reads off the wire (message, errorDetail, apiError); the
   * full SDKErrorMessage stays inside the adapter.
   */
  errorPayload?: { message?: string; errorDetail?: string; apiError?: unknown };
  /**
   * The id of the newest user_message persisted by letta-code during this
   * turn (computed once via the post-turn listMessages diff). Used by
   * mobile-channel-host to bind the mobile-supplied otid without
   * re-scanning messages.jsonl. See lcp-y88.
   */
  newUserMessageId?: string | null;
}

/** Internal adapter start metadata, normalized across direct CLI and SDK transports. */
export interface LettaSessionInit {
  agentId: string;
  conversationId: string;
}

/** Constructor args for Letta session adapters. */
export interface LettaSessionAdapterOptions {
  conversationId: string;
  agentId: string;
  tools?: AnyAgentTool[];
  /**
   * lcp hr5rw (§3a.5): fired once per turn AFTER finalizeTurnLifecycle
   * completes (NOT where currentRunHandle is nulled — firing earlier would
   * let the pool cap-evict a worker that is still finalizing, clobbering
   * the CLI's end-of-turn messages.jsonl flush, or one with a chained turn
   * queued). The pool uses it to drain capacity waiters.
   */
  onTurnSettled?: () => void;
}

/** Adapter-owned turn result. Public callers still see RunTurnResult via AgentPool#get(). */
export type AdapterRunTurnResult = RunTurnResult;

/**
 * Private transport seam for the lcp-sdk migration.
 *
 * Ownership boundary:
 * - Adapter owns the concrete letta-code session transport, warm-session
 *   lifecycle, stdout/stderr parsing, turn serialization, and hard abort/close.
 * - AgentPool owns pooling, LRU/idle eviction, and public stats.
 * - The current direct adapter still performs the existing run-recording and
 *   approval side effects so this bead is behavior-preserving. Follow-up SDK
 *   beads can move those concerns upward once both adapters emit the same
 *   AdapterRunTurnResult shape.
 *
 * Keep this interface private to admin-shim/lib until the SDK-backed adapter
 * ships and the stable contract is proven by tests.
 */
export interface LettaSessionAdapter {
  readonly agentId: string;
  readonly conversationId: string;
  readonly ready: boolean;
  readonly dead: boolean;
  readonly lastUsedAt: number;
  readonly spawnedAt: number;
  /** lcp-rfb: true while a turn is in flight. housekeep() skips eviction. */
  readonly busy?: boolean;
  /** Currently executing run ID, if any. Useful for cleaning up dangling state on eviction. */
  readonly activeRunId?: string | null;
  /**
   * lcp hr5rw (§3a.5): depth of the adapter's turn chain — turns chained
   * and not yet fully settled (including the finalize window after `busy`
   * flips false). Eviction paths must skip adapters with pendingTurns() > 0:
   * closing one mid-finalize can clobber the CLI's end-of-turn disk flush
   * (the lcp-0vi hazard), and closing one with a chained turn fails that
   * turn with "runTurn on dead adapter".
   */
  pendingTurns?(): number;
  start(): Promise<LettaSessionInit>;
  runTurn(input: string | unknown[], opts?: RunTurnOptions): Promise<AdapterRunTurnResult>;
  abort(reason?: string): Promise<void> | void;
  close(): Promise<void> | void;
}

/** One snapshot row in `AgentPool#stats`. */
export interface WorkerStat {
  key: string;
  conversation_id: string;
  agent_id: string;
  ready: boolean;
  dead: boolean;
  idle_sec: number;
  spawned_sec: number;
}

/**
 * lcp-2oxb.1: performance snapshot bundled into pool stats.
 * Included as an additive `perf` field — existing REST clients that
 * ignore unknown keys see no breakage.
 */
export interface PoolPerfStats {
  /** Event-loop delay percentiles for the window since the last stats() call. */
  event_loop: EventLoopDelayStats;
  /** Cumulative frame-append counters since process start. */
  frames: FrameAppendStats;
  /** Resident set size of this process in bytes. */
  rss_bytes: number;
}

/** Return shape of `AgentPool#stats`. */
export interface PoolStats {
  size: number;
  max: number;
  idle_evict_sec: number;
  workers: WorkerStat[];
  /** lcp hr5rw: additive — cold spawns queued for capacity + in-flight spawns. */
  queued: number;
  in_flight_spawns: number;
  /** lcp-2oxb.1: additive performance snapshot; never undefined. */
  perf: PoolPerfStats;
}

function logLine(msg: string): void {
  console.log(`[pool] ${msg}`);
}

/** Pull the inner event when present, else fall back to the frame itself. */
function frameEvent(frame: LettaStreamFrame): LettaInnerEvent | LettaStreamFrame {
  if (frame.type === "stream_event") return frame.event;
  return frame;
}

// ── lcp-sdk.4: shared run-lifecycle helpers ───────────────────────────
//
// Both adapters (DirectSubprocess and Sdk-backed) need identical
// run-record bookkeeping so /v1/runs/* observability stays the same
// regardless of transport. The pure-bookkeeping bits below (per-frame
// markRunFirstToken / recordRunTool / recordRunStep + post-turn
// stampNewMessages + recordRunMessage + finalizeRun) have NO
// subprocess coupling, so we lift them to module scope and call them
// from both adapters. Approval-related side effects stay adapter-local
// (lcp-sdk.5 will give the SDK path its own approval implementation).

/**
 * Apply per-frame run-bookkeeping side effects. Called once for each
 * collected frame during a turn. Returns the (possibly mutated) pending
 * usage buffer — usage_statistics frames stash here, stop_reason frames
 * drain it into a step record.
 *
 * Behavior MUST match the DirectSubprocess collector pre-extraction
 * (lines 594–669). Closely mirror those reads (including the
 * `usage: pendingStepUsage` not-coerced-to-undefined contract for steps).
 */
export function applyFrameRunSideEffects(
  frame: LettaStreamFrame,
  runHandle: RunHandle,
  pendingStepUsage: UsageInput | null,
): UsageInput | null {
  try {
    const ev = frameEvent(frame);
    const mt: string | undefined =
      "message_type" in ev && typeof ev.message_type === "string"
        ? ev.message_type
        : undefined;
    if (mt === "assistant_message" || mt === "tool_call_message" || mt === "approval_request_message") {
      markRunFirstToken(runHandle);
    }
    // lcp-r0m: stamp the frame's otid into the run's in-flight set as
    // soon as it goes past. The REST /messages handler filters disk
    // records by this set, so a mid-turn hydrate never returns the
    // cumulative assistant_message that the WS stream is still
    // delivering as deltas. Done unconditionally — any frame that
    // carries an otid is a frame whose disk twin would race the WS.
    const evOtid = "otid" in ev && typeof (ev as { otid?: unknown }).otid === "string"
      ? (ev as { otid: string }).otid
      : undefined;
    if (evOtid) recordRunOtid(runHandle, evOtid);
    const evToolCall =
      "tool_call" in ev && ev.tool_call && typeof ev.tool_call === "object"
        ? (ev.tool_call as { name?: unknown })
        : undefined;
    const frameToolCall =
      frame.type === "auto_approval" ? frame.tool_call : undefined;
    const toolName =
      (typeof evToolCall?.name === "string" ? evToolCall.name : undefined)
      ?? (typeof frameToolCall?.name === "string" ? frameToolCall.name : undefined);
    if (toolName) recordRunTool(runHandle, toolName);
    if (mt === "usage_statistics") {
      const u = ev as UsageStatisticsEvent;
      pendingStepUsage = {
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        total_tokens: u.total_tokens ?? 0,
        cached_input_tokens: u.cached_input_tokens ?? 0,
        cache_write_tokens: u.cache_write_tokens ?? 0,
        reasoning_tokens: u.reasoning_tokens ?? 0,
      };
    }
    if (mt === "stop_reason") {
      const stopReasonRaw =
        "stop_reason" in ev && typeof ev.stop_reason === "string"
          ? ev.stop_reason
          : undefined;
      const evAsRec = ev as unknown as Record<string, unknown>;
      const frameAsRec = frame as unknown as Record<string, unknown>;
      const evModel =
        "model" in ev && typeof evAsRec["model"] === "string"
          ? (evAsRec["model"] as string)
          : undefined;
      const frameModel =
        "model" in frame && typeof frameAsRec["model"] === "string"
          ? (frameAsRec["model"] as string)
          : undefined;
      recordRunStep(runHandle, {
        stop_reason: stopReasonRaw,
        usage: pendingStepUsage,
        model: evModel ?? frameModel ?? null,
      });
      pendingStepUsage = null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[agent-pool] failed to collect run step metadata: ${msg}`);
  }
  return pendingStepUsage;
}

/**
 * Post-turn run-lifecycle finalization. Both adapters call this AFTER
 * their stream loop ends and BEFORE returning from runTurn.
 *
 *   1. Stamp the real wallclock time on newly-persisted messages
 *      (lcp-dfz path).
 *   2. Attribute any new message ids to this turn's shim run.
 *   3. Find the final stop_reason + FIRST usage_statistics frames
 *      across the turn. Usage remains first-frame (locked contract #4),
 *      while the run summary stop_reason reflects the terminal state; per-step
 *      records preserve intermediate requires_approval stops for diagnostics.
 *   4. Call finalizeRun unless the turn was already cancelled
 *      (cancelRun's path already wrote its terminal record; calling
 *      finalizeRun would be a no-op but skipping is cheaper).
 *
 * Returns the partial RunTurnResult fields that depend on the run state
 * — caller spreads these into the resolved result.
 */
export async function finalizeTurnLifecycle(args: {
  runHandle: RunHandle;
  frames: LettaStreamFrame[];
  conversationId: string;
  agentId: string;
  messageIdsBefore: Set<string>;
  turnStartedAt: Date;
  cancelled: boolean;
  finishedExit: boolean;
  finishedTimeout: boolean;
}): Promise<{ newUserMessageId: string | null; synthesizedSettlements: number }> {
  const { runHandle, frames, conversationId, agentId, messageIdsBefore, turnStartedAt, cancelled, finishedExit, finishedTimeout } = args;
  // lcp hr5rw (§3c.5): count of tool_result settlements SYNTHESIZED onto
  // disk for dangling tool_calls. When > 0 the CLI's in-memory snapshot
  // disagrees with disk, so the cancel soft-grace keep-alive must NOT keep
  // the worker warm (the lcp-0vi evict-before-heal hazard).
  let synthesizedSettlements = 0;
  try {
    await stampNewMessages(conversationId, agentId, turnStartedAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine(`stampNewMessages failed conv=${conversationId}: ${msg}`);
  }
  let newUserMessageId: string | null = null;
  try {
    const after = await listMessages(conversationId, agentId);
    for (const m of after) {
      if (m?.id && !messageIdsBefore.has(m.id)) {
        recordRunMessage(runHandle, m.id);
        if (m.role === "user") newUserMessageId = m.id;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine(`run message attribution failed for ${runHandle.id}: ${msg}`);
  }
  const stopFrames = frames.filter((f) => {
    const ev = frameEvent(f);
    const mt = "message_type" in ev ? ev.message_type : undefined;
    return mt === "stop_reason";
  });
  const stopFrame = stopFrames[stopFrames.length - 1] ?? null;
  // lcp-12w: synthesize an error toolResult for any tool_call this turn
  // emitted but never returned. Cheap no-op on clean turns; only writes
  // when an interruption left tool_use orphans on disk. Pairs with the
  // lcp-ith upstream patch (which catches the same class at NEXT-turn
  // boundary) — defense in depth. Reason is sourced from the caller's
  // local lifecycle state; "stream_dropped" is the catch-all for cases
  // where no result frame arrived and none of the explicit flags fired.
  const lifecycleStopReason: string | null = (() => {
    if (!stopFrame) return null;
    const ev = frameEvent(stopFrame);
    if ("stop_reason" in ev && typeof ev.stop_reason === "string") return ev.stop_reason;
    return null;
  })();
  const requiresApproval = lifecycleStopReason === "requires_approval";
  const cleanFinish = !cancelled && !finishedTimeout && !finishedExit && Boolean(stopFrame) && !requiresApproval;
  if (!cleanFinish) {
    const settleReason: SettlementReason =
      cancelled ? "cancelled"
      : requiresApproval ? "requires_approval"
      : finishedTimeout ? "turn_timeout"
      : finishedExit ? "worker_exit"
      : "stream_dropped";
    try {
      const settled = await settleDanglingToolCallsFromFrames({
        frames,
        conversationId,
        agentId,
        runId: runHandle.id,
        reason: settleReason,
        messageIdsBefore,
      });
      if (settled.messagesAppended > 0) {
        synthesizedSettlements = settled.messagesAppended;
        logLine(`settled ${settled.messagesAppended} dangling tool_call(s) for run=${runHandle.id} reason=${settleReason}`);
        for (const s of settled.settled) {
          recordRunMessage(runHandle, `synth-settle:${runHandle.id}:${s.tool_call_id}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLine(`turn-settlement failed run=${runHandle.id}: ${msg}`);
    }
  }
  const usageFrame = frames.find((f) => {
    const ev = frameEvent(f);
    const mt = "message_type" in ev ? ev.message_type : undefined;
    return mt === "usage_statistics";
  });
  const stopReason: string | null = (() => {
    if (!stopFrame) return null;
    const ev = frameEvent(stopFrame);
    if ("stop_reason" in ev && typeof ev.stop_reason === "string") return ev.stop_reason;
    return null;
  })();
  const usage: UsageStatisticsEvent | LettaStreamFrame | null = usageFrame
    ? (usageFrame.type === "stream_event"
        ? (usageFrame.event as UsageStatisticsEvent)
        : usageFrame)
    : null;
  if (!cancelled) {
    finalizeRun(runHandle, {
      status: finishedExit ? "failed" : (finishedTimeout ? "failed" : "completed"),
      stopReason: finishedTimeout ? "timeout" : (finishedExit ? "child_exit" : stopReason),
      usage: usage as UsageStatisticsEvent | null,
    });
  }
  return { newUserMessageId, synthesizedSettlements };
}

/**
 * Construct an SDK-backed adapter. Dynamic-imported so importing this
 * module doesn't drag the SDK pump into the cold load path (also breaks
 * a would-be circular import — the adapter file imports the shared
 * lifecycle helpers from here).
 */
async function createAdapter(opts: LettaSessionAdapterOptions): Promise<LettaSessionAdapter> {
  const { SdkBackedLettaSessionAdapter } = await import("./letta-sdk-adapter.js");
  return new SdkBackedLettaSessionAdapter(opts);
}

/**
 * lcp-2oxb.2: Per-conversation pool of SDK-backed session adapters.
 *
 * Exported so unit tests can instantiate the pool directly with fake
 * adapters (via _adapterFactory override) without spawning a real shim
 * subprocess. Production callers use getAgentPool() exclusively.
 */
export class AgentPool {
  workers: Map<string, LettaSessionAdapter>;
  spawning: Map<string, Promise<LettaSessionAdapter>>;
  housekeepTimer: NodeJS.Timeout;
  /**
   * lcp hr5rw (§3a): FIFO of cold-spawn callers waiting for capacity.
   * Bounded by SHIM_POOL_QUEUE_MAX; entries time out after
   * SHIM_POOL_QUEUE_TIMEOUT_MS. Warm hits (even busy ones) never queue —
   * they serialize on the adapter's own promise chain.
   */
  capacityWaiters: CapacityWaiter[] = [];
  /**
   * lcp hr5rw (§3a.3): spawns admitted but not yet landed in `workers`
   * (start() takes ~3s). Admission control computes
   * `admit = MAX_WORKERS − workers.size − inFlightSpawns` so several
   * capacity-frees during a spawn window can never burst past MAX.
   */
  inFlightSpawns = 0;
  /**
   * lcp-2oxb.2: seam for unit tests. When set, get() calls this instead
   * of the module-level createAdapter() so tests can inject fake adapters
   * without spawning real SDK sessions. Production code never sets this.
   */
  _adapterFactory: ((opts: LettaSessionAdapterOptions) => Promise<LettaSessionAdapter>) | null = null;
  _llmRetryDeps: Parameters<typeof runTurnWithLlmRetry>[0]["deps"] | null = null;

  constructor() {
    this.workers = new Map(); // key: conversationId → LettaSessionAdapter
    this.spawning = new Map(); // key: conversationId → Promise<LettaSessionAdapter>
    this.housekeepTimer = setInterval(() => this.housekeep(), HOUSEKEEP_INTERVAL_MS);
    this.housekeepTimer.unref?.();
  }

  size(): number {
    return this.workers.size;
  }

  /** lcp hr5rw: true when the adapter may be closed by capacity eviction. */
  private _evictableForCapacity(w: LettaSessionAdapter): boolean {
    return !w.busy && (w.pendingTurns?.() ?? 0) === 0;
  }

  /**
   * Evict ONE LRU idle worker to make room for a spawn. Returns false when
   * every worker is busy / finalizing / has chained turns (nothing safe to
   * close). Invariant preserved: a busy or pending-turn worker is NEVER
   * closed here (closing mid-turn or mid-finalize clobbers the CLI's
   * end-of-turn disk flush — lcp-0vi).
   */
  private _evictIdleForCapacity(): boolean {
    const entries = [...this.workers.entries()].sort(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
    );
    const victimEntry = entries.find(([, w]) => this._evictableForCapacity(w));
    if (!victimEntry) return false;
    const [oldestKey, victim] = victimEntry;
    logLine(`evicting (cap) conv=${oldestKey}`);
    this.workers.delete(oldestKey);
    if (victim.activeRunId) {
      rejectApprovalGate(victim.activeRunId, new Error("worker_evicted"));
    }
    victim.close();
    return true;
  }

  /**
   * lcp hr5rw (§3a): reserve one spawn slot, cap-evicting idle workers as
   * needed. Returns false when the pool is saturated with busy workers —
   * the caller must queue (no more spawn-anyway overflow).
   */
  private _tryReserveCapacity(): boolean {
    while (this.workers.size + this.inFlightSpawns >= MAX_WORKERS) {
      if (!this._evictIdleForCapacity()) return false;
    }
    this.inFlightSpawns += 1;
    return true;
  }

  /**
   * lcp hr5rw (§3a): park a cold-spawn caller until capacity frees.
   * Same-key callers coalesce onto one waiter (one spawn on wake, like
   * `spawning` does). Resolves `true` for exactly one caller per waiter —
   * the reservation owner; the rest re-check warm/spawning maps.
   * Rejects with pool_saturated (queue full), pool_queue_timeout, or
   * cancelled (via cancelQueued).
   */
  private async _waitForCapacity(key: string, runId?: string): Promise<boolean> {
    let waiter = this.capacityWaiters.find((w) => w.key === key && !w.settled);
    if (!waiter) {
      const liveDepth = this.capacityWaiters.filter((w) => !w.settled).length;
      if (liveDepth >= QUEUE_MAX) {
        throw new PoolCapacityError(
          "pool_saturated",
          `pool queue full (${liveDepth}/${QUEUE_MAX}) — all ${MAX_WORKERS} workers busy`,
        );
      }
      let resolve!: () => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const entry: CapacityWaiter = {
        key,
        runIds: runId ? [runId] : [],
        promise,
        resolve,
        reject,
        settled: false,
        reservationClaimed: false,
        timer: setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          const idx = this.capacityWaiters.indexOf(entry);
          if (idx >= 0) this.capacityWaiters.splice(idx, 1);
          entry.reject(new PoolCapacityError(
            "pool_queue_timeout",
            `no pool capacity within ${QUEUE_TIMEOUT_MS}ms (key=${key})`,
          ));
        }, QUEUE_TIMEOUT_MS),
      };
      // Deliberately NOT unref'd: a queued caller is a live request; the
      // process must not exit from under it before the timeout resolves.
      this.capacityWaiters.push(entry);
      logLine(`pool saturated — queued cold spawn key=${key} depth=${this.capacityWaiters.filter((w) => !w.settled).length} max=${QUEUE_MAX}`);
      waiter = entry;
    } else if (runId && !waiter.runIds.includes(runId)) {
      waiter.runIds.push(runId);
    }
    await waiter.promise;
    if (!waiter.reservationClaimed) {
      waiter.reservationClaimed = true;
      return true;
    }
    return false;
  }

  /**
   * lcp hr5rw (§3a.4): admit queued cold spawns, FIFO, with admission
   * control — at most `MAX_WORKERS − workers.size − inFlightSpawns` at a
   * time (evicting idle workers to make room). Called at every
   * capacity-freeing point: cap/manual/force eviction, housekeep
   * idle-evict, dead-worker delete, failed spawn, and turn settlement.
   */
  drainCapacityWaiters(): void {
    while (this.capacityWaiters.length > 0) {
      const head = this.capacityWaiters[0]!;
      if (head.settled) {
        this.capacityWaiters.shift();
        continue;
      }
      // Make room (evict idle) or stop — head-of-line blocks, FIFO.
      let hasRoom = this.workers.size + this.inFlightSpawns < MAX_WORKERS;
      while (!hasRoom) {
        if (!this._evictIdleForCapacity()) return;
        hasRoom = this.workers.size + this.inFlightSpawns < MAX_WORKERS;
      }
      this.capacityWaiters.shift();
      head.settled = true;
      clearTimeout(head.timer);
      // Reservation is granted to the waiter; the first coalesced caller
      // to resume claims it (see _waitForCapacity) and increments nothing
      // further — the slot is held here, before any caller yields.
      this.inFlightSpawns += 1;
      logLine(`pool queue admit key=${head.key} remaining=${this.capacityWaiters.filter((w) => !w.settled).length}`);
      head.resolve();
    }
  }

  /**
   * lcp hr5rw (§3a.6): remove a queued cold spawn for `runId` and reject
   * its waiter with a typed `cancelled` error so a mobile cancel during
   * queueing doesn't strand the caller for the full queue timeout. NOTE:
   * same-key callers coalesce onto one waiter, so cancelling one run
   * rejects the whole (agent, conv) group — acceptable: they target the
   * same worker and the group is re-queueable.
   */
  cancelQueued(runId: string): boolean {
    const idx = this.capacityWaiters.findIndex((w) => !w.settled && w.runIds.includes(runId));
    if (idx < 0) return false;
    const [waiter] = this.capacityWaiters.splice(idx, 1);
    if (!waiter) return false;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    logLine(`pool queue cancel run=${runId} key=${waiter.key}`);
    waiter.reject(new PoolCapacityError("cancelled", `run ${runId} cancelled while queued for pool capacity`));
    return true;
  }

  /**
   * Compose the cache key. Conv id "default" collides across agents (every
   * agent has its own "default" thread), so we MUST include the agent id
   * in the key — otherwise two different agents share one worker and
   * messages cross-talk. For non-default conv ids the agent is derivable
   * from the conv id alone, but we still include it for symmetry.
   */
  _key(conversationId: string | null | undefined, agentId: string | null | undefined): string {
    return `${agentId ?? "?"}::${conversationId ?? "?"}`;
  }

  /**
   * Get a ready worker for (conversationId, agentId). Reuses warm one;
   * spawns + waits for init if cold. Concurrent callers for the same
   * (agent, conv) coalesce on a single spawn.
   *
   * lcp hr5rw (§3a): when every worker at/over cap is busy, the cold-spawn
   * path QUEUES on a bounded FIFO instead of spawning anyway (the old
   * `pool overflow (all busy)` path — unbounded, 330–445MB per extra
   * worker). Rejections are typed: PoolCapacityError with code
   * pool_saturated / pool_queue_timeout / cancelled. Warm hits (even busy
   * ones) never queue — they serialize via the adapter's promise chain.
   *
   * Cap eviction (lcp-2oxb.2 invariant preserved and extended): a victim
   * must be !busy AND have no pending turns (finalize window / chained
   * turn B — closing those clobbers the CLI's end-of-turn disk flush or
   * fails turn B with "runTurn on dead adapter").
   */
  async get(
    conversationId: string,
    agentId: string,
    getOpts: { runId?: string } = {},
  ): Promise<LettaSessionAdapter> {
    const key = this._key(conversationId, agentId);
    let reserved = false;
    const releaseReservation = (): void => {
      if (reserved) {
        reserved = false;
        this.inFlightSpawns = Math.max(0, this.inFlightSpawns - 1);
      }
    };

    for (;;) {
      const worker = this.workers.get(key);
      if (worker && !worker.dead) {
        if (reserved) {
          releaseReservation();
          this.drainCapacityWaiters();
        }
        return worker;
      }
      if (worker && worker.dead) {
        this.workers.delete(key);
        this.drainCapacityWaiters();
        continue;
      }
      const inFlight = this.spawning.get(key);
      if (inFlight) {
        if (reserved) {
          releaseReservation();
          this.drainCapacityWaiters();
        }
        return inFlight;
      }
      if (reserved) break; // admitted from the queue (or reserved below) → spawn
      if (this._tryReserveCapacity()) {
        reserved = true;
        break;
      }
      // All busy at/over cap → park on the bounded FIFO. Throws typed
      // pool_saturated / pool_queue_timeout / cancelled. On wake, loop
      // back: a warm worker or an in-flight spawn may now exist for key.
      try {
        reserved = await this._waitForCapacity(key, getOpts.runId);
      } catch (err) {
        releaseReservation(); // defensive; we hold none on this path
        throw err;
      }
    }

    let resolveSpawn!: (w: LettaSessionAdapter) => void;
    let rejectSpawn!: (err: any) => void;
    const p = new Promise<LettaSessionAdapter>((resolve, reject) => {
      resolveSpawn = resolve;
      rejectSpawn = reject;
    });

    this.spawning.set(key, p);

    (async (): Promise<void> => {
      try {
        const factory = this._adapterFactory ?? createAdapter;
        const w = await factory({
          conversationId,
          agentId,
          // lcp hr5rw (§3a.5): wake queued cold spawns when a turn fully
          // settles (after finalizeTurnLifecycle) — the point where the
          // worker becomes genuinely reusable/evictable.
          onTurnSettled: () => this.drainCapacityWaiters(),
        });
        try {
          await w.start();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logLine(`spawn failed key=${key}: ${msg}`);
          // LettaSessionAdapter#dead is readonly on the interface; the SDK
          // adapter owns a mutable backing field. Cast through unknown so
          // the public seam stays read-only.
          (w as unknown as { dead: boolean }).dead = true;
          throw err;
        }
        this.workers.set(key, w);
        logLine(`spawned key=${key} size=${this.workers.size}`);
        resolveSpawn(w);
      } catch (err) {
        rejectSpawn(err);
      }
    })();

    try {
      const w = await p;
      return w;
    } finally {
      this.spawning.delete(key);
      // Success: the worker now counts in workers.size, so release the
      // reservation (net capacity unchanged). Failure: the slot frees for
      // the next queued waiter. Either way, drain (no-op when full).
      releaseReservation();
      this.drainCapacityWaiters();
    }
  }

  /**
   * lcp-0vi: drain the warm adapter for (agent, conv) so a subsequent
   * heal-write to messages.jsonl isn't clobbered when the still-alive
   * session flushes its stale in-memory snapshot at end-of-turn. Closes
   * the SDK session and drops the pool entry; the next pool.get() spawns
   * a fresh adapter that loads the healed disk state.
   *
   * Returns true if a worker was evicted, false if none was warm.
   */
  async evict(conversationId: string, agentId: string): Promise<boolean> {
    const key = this._key(conversationId, agentId);
    const worker = this.workers.get(key);
    if (!worker) return false;
    this.workers.delete(key);
    if (worker.activeRunId) {
      rejectApprovalGate(worker.activeRunId, new Error("worker_evicted"));
    }
    try {
      await worker.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLine(`evict close failed key=${key}: ${msg}`);
    }
    logLine(`evicted (manual) key=${key} size=${this.workers.size}`);
    this.drainCapacityWaiters();
    return true;
  }

  forceEvict(conversationId: string, agentId: string, reason = "cancel_grace_expired"): boolean {
    const key = this._key(conversationId, agentId);
    const worker = this.workers.get(key);
    if (!worker) return false;
    this.workers.delete(key);
    if (worker.activeRunId) {
      rejectApprovalGate(worker.activeRunId, new Error("worker_evicted"));
    }
    try {
      void Promise.resolve(worker.close()).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logLine(`force-evict close failed key=${key}: ${msg}`);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLine(`force-evict close threw key=${key}: ${msg}`);
    }
    logLine(`force-evicted key=${key} reason=${reason} size=${this.workers.size}`);
    this.drainCapacityWaiters();
    return true;
  }

  /**
   * lcp-0vi: get-or-spawn a worker, run one turn, and auto-heal on the
   * dangling-tool-use failure mode.
   *
   * Flow:
   *   1. pool.get → adapter.runTurn (forwards the caller's opts/onFrame
   *      verbatim, so the mobile WS / REST lifecycle stays unchanged).
   *   2. If the result carries an errorPayload AND its content matches the
   *      Anthropic "tool_use ids without tool_result" signature, the
   *      transcript is corrupted and the next turn would hit the same
   *      error. Drain the warm adapter (so a still-alive session doesn't
   *      flush its stale in-memory snapshot over our heal), apply
   *      conversation-healer's surgical repair, and return the failure
   *      to the caller as-is so mobile sees one clean turn_done(error).
   *      The next user turn picks up the cleaned disk.
   *   3. Healing audits to `state/runs/<runId>/heal.jsonl` already (wired
   *      by lcp-ezv).
   *
   * Non-goals (deliberately deferred):
   *   - Inline retry of the same turn. The bead's "retry once" pattern
   *     means the CLI re-persists the user_message on the second attempt,
   *     producing visible duplicates on disk and over WS. Without a
   *     mobile-side coalescer, the UX is worse than a clean failure +
   *     user-driven retry. If a future cascade-corruption scenario
   *     reappears we can revisit (the existing /tmp/cascade-heal driver
   *     shows the cascade loop converges in 5-8 iterations on Meridian-
   *     class transcripts).
   *
   * Returns the underlying AdapterRunTurnResult unchanged on the happy
   * path. On a healed failure the result is identical to what runTurn
   * returned — the caller's normal failure path runs.
   */
  async runTurnWithHeal(
    conversationId: string,
    agentId: string,
    input: string | unknown[],
    opts: RunTurnOptions = {},
  ): Promise<AdapterRunTurnResult> {
    try {
      const preflightCandidates = detectConsecutiveUserMessageIndices(
        await listMessages(conversationId, agentId),
      ).length;
      if (preflightCandidates > 0) {
        logLine(`preflight role-alternation heal triggered conv=${conversationId} userMessages=${preflightCandidates}`);
        await this.evict(conversationId, agentId);
        const report = await healConsecutiveUserMessages(conversationId, agentId);
        logLine(
          `preflight role-alternation heal complete conv=${conversationId} ` +
          `removed=${report.messagesRemoved} [${report.removed.slice(0, 5).join(", ")}${report.removed.length > 5 ? ", ..." : ""}]`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLine(`preflight role-alternation heal failed conv=${conversationId}: ${msg}`);
    }

    let adapter: LettaSessionAdapter | null = null;
    if (opts.tools && opts.tools.length > 0) {
      const factory = this._adapterFactory ?? createAdapter;
      adapter = await factory({ conversationId, agentId, tools: opts.tools });
      await adapter.start();
    } else {
      // lcp hr5rw (§3a.6): while queued for capacity, route cancelRun to
      // cancelQueued so a mobile cancel doesn't strand the waiter for the
      // full queue timeout. Only pre-created handles (mobile WS) have a
      // cancellable id at this point; adapter.runTurn re-binds the real
      // cancel handler once the worker exists.
      if (opts.runHandle) {
        const runId = opts.runHandle.id;
        setRunCancelHandler(runId, () => {
          this.cancelQueued(runId);
        });
      }
      adapter = await this.get(conversationId, agentId, {
        ...(opts.runHandle ? { runId: opts.runHandle.id } : {}),
      });
    }
    const turnOpts: RunTurnOptions = {
      ...opts,
      onCancelGraceExpired: (runId) => {
        // Worker-identity guard: forceEvict is a by-KEY lookup, but the
        // grace timer can fire after THIS turn's worker already left the
        // pool (evicted, died) and a FRESH worker spawned under the same
        // key for a re-send. Evicting by key alone would close that new
        // worker mid-turn — so only evict when the keyed worker is still
        // the adapter this turn ran on. (Ephemeral opts.tools adapters are
        // never in `workers`, so they correctly skip here too — the
        // adapter's own grace-timer close() handles them.)
        const key = this._key(conversationId, agentId);
        if (this.workers.get(key) === adapter) {
          this.forceEvict(conversationId, agentId, `cancel_grace_expired run=${runId}`);
        } else {
          logLine(`cancel grace expired run=${runId} but key=${key} holds a different worker — skipping forceEvict`);
        }
        opts.onCancelGraceExpired?.(runId);
      },
    };
    let result: AdapterRunTurnResult;
    try {
      result = await runTurnWithLlmRetry({
        conversationId,
        agentId,
        input,
        opts: turnOpts,
        runOnce: (turnInput, retryOpts) => adapter.runTurn(turnInput, retryOpts),
        log: logLine,
        ...(this._llmRetryDeps ? { deps: this._llmRetryDeps } : {}),
      });
    } finally {
      if (opts.closeAfterTurn || (opts.tools && opts.tools.length > 0)) {
        await adapter.close();
      }
    }
    if (!result.errorPayload) return result;
    let ids: string[];
    let roleAlternationViolation = false;
    let unexpectedToolResultIds: string[] = [];
    try {
      ids = detectDanglingToolUses(result.errorPayload);
      roleAlternationViolation = detectRoleAlternationViolation(result.errorPayload);
      unexpectedToolResultIds = detectUnexpectedToolResults(result.errorPayload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLine(`heal error detection threw: ${msg}`);
      return result;
    }
    if (ids.length === 0 && !roleAlternationViolation && unexpectedToolResultIds.length === 0) return result;
    if (ids.length === 0 && unexpectedToolResultIds.length > 0) {
      logLine(
        `unexpected-tool-result heal triggered conv=${conversationId} run=${result.run_id ?? "?"} ids=${unexpectedToolResultIds.length}` +
        ` [${unexpectedToolResultIds.slice(0, 3).join(", ")}${unexpectedToolResultIds.length > 3 ? ", ..." : ""}]`,
      );
      await this.evict(conversationId, agentId);
      try {
        const report = await healUnexpectedToolResults(conversationId, agentId, unexpectedToolResultIds, {
          runId: result.run_id ?? null,
        });
        logLine(
          `unexpected-tool-result heal complete run=${result.run_id ?? "?"} ` +
          `removed=${report.messagesRemoved} unresolved=${report.unresolved.length}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logLine(`unexpected-tool-result heal failed run=${result.run_id ?? "?"}: ${msg}`);
      }
      return result;
    }
    if (ids.length === 0 && roleAlternationViolation) {
      let candidateCount = 0;
      try {
        candidateCount = detectConsecutiveUserMessageIndices(await listMessages(conversationId, agentId)).length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logLine(`consecutive-user detection failed run=${result.run_id ?? "?"}: ${msg}`);
        return result;
      }
      if (candidateCount === 0) {
        logLine(`role-alternation heal skipped run=${result.run_id ?? "?"}: no consecutive user messages on disk`);
        return result;
      }
      logLine(`role-alternation heal triggered conv=${conversationId} run=${result.run_id ?? "?"} userMessages=${candidateCount}`);
      await this.evict(conversationId, agentId);
      try {
        const report = await healConsecutiveUserMessages(conversationId, agentId, {
          runId: result.run_id ?? null,
        });
        logLine(
          `role-alternation heal complete run=${result.run_id ?? "?"} ` +
          `removed=${report.messagesRemoved} [${report.removed.slice(0, 5).join(", ")}${report.removed.length > 5 ? ", ..." : ""}]`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logLine(`role-alternation heal failed run=${result.run_id ?? "?"}: ${msg}`);
      }
      return result;
    }
    logLine(
      `heal triggered conv=${conversationId} run=${result.run_id ?? "?"} ids=${ids.length}` +
      (ids.length > 0 ? ` [${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", ..." : ""}]` : ""),
    );
    // Drain the warm adapter — the heal mutates messages.jsonl in place,
    // and a still-alive SDK session would clobber it on the next
    // end-of-turn flush. After eviction the next pool.get() spawns a
    // fresh session that loads the healed state.
    await this.evict(conversationId, agentId);
    try {
      const report = await healConversation(conversationId, agentId, ids, {
        runId: result.run_id ?? null,
      });
      logLine(
        `heal complete run=${result.run_id ?? "?"} ` +
        `removed=${report.removed.length} settled=${report.settled.length} ` +
        `unresolved=${report.unresolved.length} ` +
        `(messagesEdited=${report.messagesEdited} messagesRemoved=${report.messagesRemoved} messagesAppended=${report.messagesAppended})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLine(`heal failed run=${result.run_id ?? "?"}: ${msg}`);
    }
    return result;
  }

  /**
   * lcp-rfb: bump lastUsedAt on the adapter for a given conversation.
   * Called from the WS handler on every inbound frame (pong, user_action,
   * etc.) so the adapter stays alive as long as a client is connected.
   */
  touch(conversationId: string, agentId: string): void {
    const key = this._key(conversationId, agentId);
    const w = this.workers.get(key);
    if (w && !w.dead) {
      (w as { lastUsedAt: number }).lastUsedAt = Date.now();
    }
  }

  housekeep(): void {
    const now = Date.now();
    let freed = false;
    for (const [key, w] of this.workers) {
      if (w.dead) {
        this.workers.delete(key);
        freed = true;
        continue;
      }
      if (now - w.lastUsedAt > IDLE_EVICT_MS) {
        if (w.busy || (w.pendingTurns?.() ?? 0) > 0) {
          logLine(`skipping eviction (busy) conv=${key} idle=${(now - w.lastUsedAt) / 1000}s`);
          continue;
        }
        logLine(`evicting (idle) conv=${key} idle=${(now - w.lastUsedAt) / 1000}s`);
        this.workers.delete(key);
        freed = true;
        if (w.activeRunId) {
          rejectApprovalGate(w.activeRunId, new Error("worker_evicted"));
        }
        w.close();
      }
    }
    if (freed) this.drainCapacityWaiters();
  }

  async stopAll(): Promise<void> {
    if (this.housekeepTimer) clearInterval(this.housekeepTimer);
    // lcp hr5rw: unblock queued cold spawns so shutdown never hangs on the
    // queue timeout.
    for (const waiter of this.capacityWaiters.splice(0)) {
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiter.reject(new PoolCapacityError("cancelled", "pool shutting down"));
    }
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled(all.map((w) => {
      if (w.activeRunId) {
        rejectApprovalGate(w.activeRunId, new Error("worker_evicted"));
      }
      return w.close();
    }));
  }

  stats(): PoolStats {
    // lcp-2oxb.1: snapshot perf metrics once per stats() call. The ELD
    // histogram resets after each read, so this is a "since last call" window.
    const perf: PoolPerfStats = {
      event_loop: getEventLoopDelayStats(),
      frames: getFrameAppendStats(),
      rss_bytes: getRssBytes(),
    };
    return {
      size: this.workers.size,
      max: MAX_WORKERS,
      idle_evict_sec: IDLE_EVICT_MS / 1000,
      queued: this.capacityWaiters.filter((w) => !w.settled).length,
      in_flight_spawns: this.inFlightSpawns,
      workers: [...this.workers.entries()].map(([k, w]) => ({
        key: k,
        conversation_id: w.conversationId,
        agent_id: w.agentId,
        ready: w.ready,
        dead: w.dead,
        idle_sec: Math.round((Date.now() - w.lastUsedAt) / 1000),
        spawned_sec: Math.round((Date.now() - w.spawnedAt) / 1000),
      })),
      perf,
    };
  }
}

let _pool: AgentPool | null = null;
export function getAgentPool(): AgentPool {
  if (!_pool) _pool = new AgentPool();
  return _pool;
}

// Re-export cancelRun so cancel handlers don't have to import runs.mjs
// directly. `cancelRun(runId)` triggers the onCancel hook registered in
// runTurn, which SIGTERMs the worker and flips the Run's status to
// "cancelled".
export { cancelRun } from "./runs.js";
