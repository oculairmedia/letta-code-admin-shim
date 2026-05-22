/**
 * Per-conversation pool of long-running `letta` subprocesses.
 *
 * Each worker is a single `letta --conversation X [--agent Y] --input-format
 * stream-json --output-format stream-json` child process, pinned to one
 * conversation. We send user messages on stdin (`{"type":"user","message":{"content":"..."}}`)
 * and read reply frames off stdout, one per line. End-of-turn is the
 * `{"type":"result",...}` frame.
 *
 * Design constraints (plugin-style principles):
 *   - No external deps; just `child_process`.
 *   - Single-writer per worker: each worker's stdin is owned by a per-room
 *     Promise chain so two turns can never overlap. The same chain pattern
 *     we used in the Matrix typing manager.
 *   - State is in-process Map; no DB. Idle eviction + hard cap = bounded.
 *   - Cold-start fallback is automatic: pool miss → spawn → first frame.
 *   - Process death is graceful: worker is dropped, next request cold-starts.
 *
 * Tuneables (env):
 *   SHIM_POOL_MAX           default 10   hard cap on warm workers
 *   SHIM_POOL_IDLE_SEC      default 300  evict workers idle this long
 *   SHIM_POOL_SPAWN_TIMEOUT default 15000 ms to wait for the init frame
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { listMessages, stampNewMessages } from "./store.js";
import { augmentUserInputForA2ui, ensureA2uiBlockAttached, type A2uiCapability } from "./a2ui-adapter.js";
import {
  createRun,
  finalizeRun,
  markRunFirstToken,
  recordRunMessage,
  recordRunStep,
  recordRunTool,
  recordApprovalDecision,
  recordApprovalPolicy,
  loadApprovalScopeCache,
  setRunCancelHandler,
  type RunHandle,
  type UsageInput,
  type ApprovalScope,
} from "./runs.js";
import type {
  LettaStreamFrame,
  LettaInnerEvent,
  UsageStatisticsEvent,
} from "./types/letta-stream.js";

const LETTA_BIN = process.env["LETTA_BIN"] || "letta";
const MAX_WORKERS = Number(process.env["SHIM_POOL_MAX"] ?? 10);
const IDLE_EVICT_MS = Number(process.env["SHIM_POOL_IDLE_SEC"] ?? 300) * 1000;
const SPAWN_TIMEOUT_MS = Number(process.env["SHIM_POOL_SPAWN_TIMEOUT"] ?? 15000);
// Default 30s in prod. Tests override via SHIM_POOL_HOUSEKEEP_MS so they
// can exercise the idle-evict path within the suite's wall-clock budget
// rather than waiting half a minute per case.
const HOUSEKEEP_INTERVAL_MS = Number(process.env["SHIM_POOL_HOUSEKEEP_MS"] ?? 30_000);

/**
 * Synthetic frame the direct subprocess adapter injects into the active
 * turn's frame handler when the child process exits mid-turn. Not part of the
 * upstream LettaStreamFrame discriminated union — see the AdapterFrame alias
 * below.
 */
interface ExitFrame {
  type: "__exit__";
  exit_code: number | null;
  stderr: string;
}

/**
 * What the per-turn frame handler ("collector") receives: either an upstream
 * letta-code frame or the synthetic __exit__ injected on child/session death.
 * The collector branches on `type === "__exit__"` and never forwards that
 * branch to the caller-supplied onFrame.
 */

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
): Promise<ApprovalDecision> {
  return new Promise((resolve, reject) => {
    const APPROVAL_TIMEOUT_MS = Number(process.env["A2UI_APPROVAL_TIMEOUT_MS"] ?? 30_000);
    
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

function approvalRequestToolCall(frame: LettaStreamFrame): { toolName: string; toolCallId: string } | null {
  const ev = frameEvent(frame);
  if (!("message_type" in ev) || ev.message_type !== "approval_request_message") return null;
  if (!("tool_call" in ev) || !ev.tool_call || typeof ev.tool_call !== "object") return null;
  const toolCall = ev.tool_call as { name?: unknown; tool_call_id?: unknown };
  if (typeof toolCall.name !== "string" || typeof toolCall.tool_call_id !== "string") return null;
  return { toolName: toolCall.name, toolCallId: toolCall.tool_call_id };
}

function writeApprovalResponse(
  child: ChildProcessWithoutNullStreams | null,
  toolCallId: string,
  approved: boolean,
  reason: string,
): void {
  if (!child || child.killed || !child.stdin.writable) return;
  child.stdin.write(JSON.stringify({
    type: "approval",
    approvals: approved
      ? [{
          type: "tool",
          tool_call_id: toolCallId,
          tool_return: "approved",
          status: "success",
          reason,
        }]
      : [{
          type: "approval",
          tool_call_id: toolCallId,
          approve: false,
          reason,
        }],
  }) + "\n");
}

type AdapterFrame = LettaStreamFrame | ExitFrame;

/** Options accepted by `LettaSessionAdapter#runTurn`. */
export interface RunTurnOptions {
  onFrame?: (frame: LettaStreamFrame, meta: { runId: string }) => void;
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
}

/**
 * Resolution value of `runTurn`. Carries the collected frames, the
 * worker's recent stderr tail, the Run id, and whichever of the
 * lifecycle flags applies (only one of `done`/`exit`/`timeout`/`dead`
 * is set in practice).
 */
export interface RunTurnResult {
  frames: LettaStreamFrame[];
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

/** Return shape of `AgentPool#stats`. */
export interface PoolStats {
  size: number;
  max: number;
  idle_evict_sec: number;
  workers: WorkerStat[];
}

function logLine(msg: string): void {
  console.log(`[pool] ${msg}`);
}

/**
 * Best-effort discriminator for an upstream letta-code stream frame.
 * Subprocess stdout lines are JSON.parse'd into `unknown`; we narrow to
 * `LettaStreamFrame` only after this guard fires. Init/system frames
 * are still detected by the readiness path (which looks at the raw
 * parsed object) — this guard intentionally accepts the full top-level
 * union so the per-turn collector can branch on it.
 */
function isLettaStreamFrame(value: unknown): value is LettaStreamFrame {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["type"] === "string";
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
  } catch {}
  return pendingStepUsage;
}

/**
 * Post-turn run-lifecycle finalization. Both adapters call this AFTER
 * their stream loop ends and BEFORE returning from runTurn.
 *
 *   1. Stamp the real wallclock time on newly-persisted messages
 *      (lcp-dfz path).
 *   2. Attribute any new message ids to this turn's shim run.
 *   3. Find the FIRST stop_reason + FIRST usage_statistics frames
 *      across the turn — LOCKED CONTRACTS #4 + #5, do not switch to
 *      .findLast or summing.
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
}): Promise<{ newUserMessageId: string | null }> {
  const { runHandle, frames, conversationId, agentId, messageIdsBefore, turnStartedAt, cancelled, finishedExit, finishedTimeout } = args;
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
  const stopFrame = frames.find((f) => {
    const ev = frameEvent(f);
    const mt = "message_type" in ev ? ev.message_type : undefined;
    return mt === "stop_reason";
  });
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
  return { newUserMessageId };
}

class DirectSubprocessLettaSessionAdapter implements LettaSessionAdapter {
  conversationId: string;
  agentId: string;
  child: ChildProcessWithoutNullStreams | null;
  stdoutBuf: string;
  stderrBuf: string;
  ready: boolean;
  dead: boolean;
  lastUsedAt: number;
  spawnedAt: number;
  chain: Promise<unknown>;
  frameHandler: ((frame: AdapterFrame) => void | Promise<void>) | null;
  private _onReady: (() => void) | null = null;

  constructor({ conversationId, agentId }: LettaSessionAdapterOptions) {
    this.conversationId = conversationId;
    this.agentId = agentId;
    this.child = null;
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.ready = false;
    this.dead = false;
    this.lastUsedAt = Date.now();
    this.spawnedAt = Date.now();
    this.chain = Promise.resolve(); // serializes turns per worker
    this.frameHandler = null; // (frame) => void during a turn
  }

  async start(): Promise<LettaSessionInit> {
    // letta-code's CLI: --conversation "default" REQUIRES --agent. Other
    // conversation ids REJECT --agent.
    const scope =
      this.conversationId === "default" && this.agentId
        ? ["--agent", this.agentId, "--conversation", "default"]
        : this.conversationId
          ? ["--conversation", this.conversationId]
          : this.agentId
            ? ["--agent", this.agentId]
            : [];

    const args = [
      "--backend",
      "local",
      ...scope,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
    ];

    this.child = spawn(LETTA_BIN, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk: Buffer | string) => this._ingestStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrBuf += chunk.toString("utf8");
      if (this.stderrBuf.length > 8192) {
        this.stderrBuf = this.stderrBuf.slice(-8192);
      }
    });
    this.child.on("exit", (code: number | null) => {
      this.dead = true;
      this.ready = false;
      if (this.frameHandler) {
        const handler = this.frameHandler;
        this.frameHandler = null;
        handler({ type: "__exit__", exit_code: code, stderr: this.stderrBuf });
      }
      // lcp-gs2 follow-up: dump the worker's stderr tail on a non-zero
      // exit so spawn failures surface in the shim log instead of
      // requiring us to manually re-run letta to learn what went
      // wrong. Clamp to 1KB so a long traceback doesn't flood.
      if (code !== 0 && this.stderrBuf) {
        const tail = this.stderrBuf.slice(-1024).replace(/\n/g, " | ");
        logLine(`worker conv=${this.conversationId} exited code=${code} stderr="${tail}"`);
      } else {
        logLine(`worker conv=${this.conversationId} exited code=${code}`);
      }
    });
    this.child.on("error", (err: Error) => {
      this.dead = true;
      this.ready = false;
      logLine(`worker conv=${this.conversationId} error: ${err.message}`);
    });

    // Wait for the init frame
    await new Promise<void>((resolve, reject) => {
      const timer: NodeJS.Timeout = setTimeout(() => {
        reject(new Error(`pool spawn timeout for conv=${this.conversationId}`));
      }, SPAWN_TIMEOUT_MS);
      const onReady = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this._onReady = onReady;
    });
    return { agentId: this.agentId, conversationId: this.conversationId };
  }

  _ingestStdout(chunk: Buffer | string): void {
    this.stdoutBuf += chunk.toString("utf8");
    for (;;) {
      const idx = this.stdoutBuf.indexOf("\n");
      if (idx < 0) break;
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (!isLettaStreamFrame(parsed)) continue;
      const frame: LettaStreamFrame = parsed;

      // Init frame readies the worker.
      if (
        frame.type === "system" &&
        frame.subtype === "init" &&
        !this.ready
      ) {
        this.ready = true;
        if (this._onReady) {
          const fn = this._onReady;
          this._onReady = null;
          fn();
        }
        continue; // do NOT forward the init frame to per-turn handlers
      }

      // Skip system init frames for subsequent turns (none expected) and
      // route everything else to the active turn handler.
      if (this.frameHandler) void this.frameHandler(frame);
    }
  }

  /**
   * Run a single turn: write the user message to stdin, collect frames
   * until the `result` frame fires, return { frames, exitDuringTurn }.
   *
   * Turns are queued on the per-worker chain so two simultaneous callers
   * can't interleave.
   */
  runTurn(userInput: string | unknown[], { onFrame, turnStartedAt: passedStart, onRunCreated, runHandle: providedRunHandle, a2uiCapability }: RunTurnOptions = {}): Promise<RunTurnResult> {
    const previous = this.chain;
    let resolveTurn!: (value: RunTurnResult) => void;
    const turnPromise = new Promise<RunTurnResult>((r) => (resolveTurn = r));
    this.chain = previous.then(async () => {
      if (this.dead) {
        resolveTurn({ frames: [], dead: true, stderr: this.stderrBuf });
        return;
      }
      this.lastUsedAt = Date.now();
      // Caller (chat.mjs) can supply a turn-start anchor it captured before
      // calling pool.get(). Unifying anchors keeps stream frame timestamps
      // and disk-stamped timestamps consistent — without that, stream frames
      // can carry an EARLIER turnStart than the disk's (when the worker was
      // already warm) or LATER (when spawning was slow), and a sort-by-date
      // merge produces nonsensical order. Fall back to `now` if not supplied.
      const turnStartedAt = passedStart instanceof Date
        ? passedStart
        : (typeof passedStart === "number" ? new Date(passedStart) : new Date());

      // Create a Run record for this turn. Vanilla Letta exposes Runs at
      // /v1/runs/*; mobile polls/cancels by run_id. The Run is the
      // turn-scoped state record; finalize at end-of-turn (or on cancel).
      // We register an onCancel hook that signals the child so an in-flight
      // turn can be aborted from the cancel API.
      //
      // lcp-99a: callers that need run_id BEFORE the turn streams (mobile
      // WS) can pre-create the handle and pass it in. In that case we
      // reuse their handle and skip the onRunCreated callback (they
      // already know the id). The cancel hook still needs to wire into
      // *this* turn's state — we patch it onto the supplied handle so
      // the cancel signal kills the right child.
      let cancelled = false;
      const cancelChild = (): void => {
        cancelled = true;
        try { this.child?.kill?.("SIGTERM"); } catch {}
      };
      let runHandle: RunHandle;
      if (providedRunHandle) {
        runHandle = providedRunHandle;
        // Late-bind the cancel hook to this turn's worker. The provided
        // handle was created before the worker existed; now that we own
        // the child process, patch the SIGTERM dispatcher into the
        // cancel-handler map keyed by the existing run id.
        setRunCancelHandler(runHandle.id, cancelChild);
      } else {
        runHandle = createRun({
          agentId: this.agentId,
          conversationId: this.conversationId,
          onCancel: cancelChild,
        });
        if (typeof onRunCreated === "function") {
          try { onRunCreated(runHandle.id); } catch {}
        }
      }

      // Load approval scope cache from sidecar. Session/Forever decisions


      // auto-approve without user round-trip; Once/Deny require user action.


      const approvalScopeCache = loadApprovalScopeCache(runHandle.id, this.conversationId);



      const frames: LettaStreamFrame[] = [];
      // `finished` is the lifecycle latch the turn-wait loop polls. Each
      // shape captures one of: clean end-of-turn (`done`), child exit
      // (`exit` + `code` + `stderr`), or the safety-timeout
      // (`timeout`). At most one is set during a turn. `done`/`exit`/
      // `timeout` are optional flags because the .mjs spreads `finished`
      // into the result and downstream callsites (chat.mjs:565) check
      // `turn?.dead || turn?.exit` — preserve those property names.
      type FinishedState = {
        done?: true;
        exit?: true;
        timeout?: true;
        code?: number | null;
        stderr?: string;
      };
      let finished: FinishedState | null = null;
      // Buffer the most-recent usage_statistics frame seen in the current
      // step. letta-code emits one usage_statistics + one stop_reason per
      // model step; when stop_reason fires we attribute the buffered usage
      // to the step record. This is what makes per-step token tracking
      // possible (without it we'd only have the run-level aggregate).
      let pendingStepUsage: UsageInput | null = null;
      const collector = async (frame: AdapterFrame): Promise<void> => {
        if (frame.type === "__exit__") {
          finished = { exit: true, code: frame.exit_code, stderr: frame.stderr };
          return;
        }
        frames.push(frame);
        // lcp-sdk.4: pure run-bookkeeping side effects extracted to
        // module scope so the SDK-backed adapter calls the same logic.
        // Behavior identical to the pre-extraction inline block —
        // see `applyFrameRunSideEffects` doc comment for the contract.
        pendingStepUsage = applyFrameRunSideEffects(frame, runHandle, pendingStepUsage);
        const approvalRequest = a2uiCapability ? approvalRequestToolCall(frame) : null;
        if (approvalRequest) {
          if (onFrame) {
            try { onFrame(frame, { runId: runHandle.id }); } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logLine(`onFrame error: ${msg}`);
            }
          }
          const cached = approvalScopeCache.get(approvalRequest.toolName);
          const timestamp = new Date().toISOString();
          if (cached) {
            recordApprovalDecision(runHandle.id, {
              action_id: `cached-${approvalRequest.toolCallId}`,
              tool_name: approvalRequest.toolName,
              decision: "approve",
              scope: cached.scope,
              reason: "cached_approval",
              timestamp,
            });
            writeApprovalResponse(this.child, approvalRequest.toolCallId, true, "cached_approval");
          } else {
            try {
              const decision = await waitForApprovalDecision(
                runHandle.id,
                approvalRequest.toolName,
                approvalRequest.toolCallId,
              );
              recordApprovalDecision(runHandle.id, {
                action_id: decision.actionId,
                tool_name: approvalRequest.toolName,
                decision: decision.decision,
                scope: decision.scope,
                reason: decision.reason,
                timestamp,
                ...(decision.userId ? { user_id: decision.userId } : {}),
              });
              if (decision.decision === "approve" && (decision.scope === "Session" || decision.scope === "Forever")) {
                recordApprovalPolicy(runHandle.id, this.conversationId, {
                  action_id: decision.actionId,
                  tool_name: approvalRequest.toolName,
                  scope: decision.scope,
                  timestamp,
                  ...(decision.userId ? { user_id: decision.userId } : {}),
                });
                approvalScopeCache.set(approvalRequest.toolName, { scope: decision.scope, timestamp });
              }
              writeApprovalResponse(
                this.child,
                approvalRequest.toolCallId,
                decision.decision === "approve",
                decision.reason,
              );
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              recordApprovalDecision(runHandle.id, {
                action_id: `timeout-${approvalRequest.toolCallId}`,
                tool_name: approvalRequest.toolName,
                decision: reason.startsWith("approval_timeout") ? "timeout" : "deny",
                scope: "Deny",
                reason,
                timestamp,
              });
              writeApprovalResponse(this.child, approvalRequest.toolCallId, false, reason);
            }
          }
          if (frame.type === "result") {
            finished = { done: true };
          }
          return;
        }
        if (onFrame) {
          try { onFrame(frame, { runId: runHandle.id }); } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logLine(`onFrame error: ${msg}`);
          }
        }
        if (frame.type === "result") {
          finished = { done: true };
        }
      };
      this.frameHandler = collector;
      // Snapshot existing message ids so we can attribute newly-persisted
      // messages to this run after the turn settles. listMessages reads
      // messages.jsonl which letta-code appends to during the turn.
      const messageIdsBefore = new Set<string>(
        (await listMessages(this.conversationId, this.agentId))
          .map((m) => m?.id)
          .filter((id): id is string => Boolean(id)),
      );
      try {
        // lcp-dlj: `userInput` is either a plain string (text-only turn —
        // legacy shape and current SSE path) OR an Anthropic-style content
        // parts array carrying inline text + image blocks. letta-code's
        // headless mode (headless.ts ~L1770) accepts both shapes directly
        // — MessageCreate.content is a union of string | ContentBlock[].
        // DEBUG (lcp-dlj follow-up): log userInput shape to diagnose
        // image strip happening between shim stdin write and disk write.
        // lcp-crp: write the a2ui_protocol block to this agent's memfs if
        // missing/stale before the turn. Idempotent + cached per process so
        // it's effectively free after the first call per agent.
        if (a2uiCapability) ensureA2uiBlockAttached(this.agentId);
        const effectiveUserInput = augmentUserInputForA2ui(userInput, a2uiCapability);
        const inputShape = Array.isArray(effectiveUserInput)
          ? `array[${effectiveUserInput.length}] types=${effectiveUserInput.map((p) => (p && typeof p === "object" && "type" in (p as Record<string, unknown>)) ? (p as Record<string, unknown>)["type"] : typeof p).join(",")}`
          : `string(${effectiveUserInput.length}ch)`;
        logLine(`stdin.write conv=${this.conversationId} shape=${inputShape}`);
        this.child!.stdin.write(
          JSON.stringify({ type: "user", message: { content: effectiveUserInput } }) + "\n",
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.frameHandler = null;
        this.dead = true;
        finalizeRun(runHandle, { status: "failed", stopReason: `stdin_write_error: ${errMsg}` });
        resolveTurn({ frames: [], dead: true, error: errMsg, run_id: runHandle.id, stderr: this.stderrBuf });
        return;
      }
      // Wait for the result frame OR child exit. Add a generous safety
      // timeout so a stuck worker doesn't block the chain forever.
      const TURN_TIMEOUT_MS = Number(process.env["SHIM_POOL_TURN_TIMEOUT"] ?? 180_000);
      await new Promise<void>((r) => {
        const start = Date.now();
        const poll = setInterval(() => {
          if (finished) {
            clearInterval(poll);
            r();
          } else if (Date.now() - start > TURN_TIMEOUT_MS) {
            clearInterval(poll);
            finished = { timeout: true };
            r();
          }
        }, 50);
      });
      this.frameHandler = null;
      this.lastUsedAt = Date.now();
      // lcp-sdk.4: stampNewMessages + message attribution + finalizeRun
      // extracted so the SDK adapter shares the same lifecycle. Closure-
      // narrowing escape hatch (`finished as unknown as ...`) is preserved
      // here — TS still can't see the writes in collector / child-exit
      // callbacks, so the cast is load-bearing.
      const finishedRead = finished as unknown as FinishedState | null;
      const finishedExit = finishedRead?.exit === true;
      const finishedTimeout = finishedRead?.timeout === true;
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
      const finishedSpread: Partial<RunTurnResult> = finishedRead ?? {};
      resolveTurn({
        frames,
        ...finishedSpread,
        stderr: this.stderrBuf,
        run_id: runHandle.id,
        cancelled,
        newUserMessageId,
      });
    });
    return turnPromise;
  }

  async abort(reason?: string): Promise<void> {
    if (reason) logLine(`aborting key=${this.agentId}::${this.conversationId} reason=${reason}`);
    await this.close();
  }

  async close(): Promise<void> {
    this.dead = true;
    this.ready = false;
    try {
      if (this.child && !this.child.killed) {
        this.child.stdin.end();
        this.child.kill("SIGTERM");
        // SIGKILL after 5s if still running
        setTimeout(() => {
          if (this.child && !this.child.killed) {
            try { this.child.kill("SIGKILL"); } catch {}
          }
        }, 5000).unref?.();
      }
    } catch {}
  }
}

/**
 * lcp-sdk.3: pick the adapter implementation per `SHIM_LETTA_TRANSPORT`.
 * `direct` (default) is the production-tested hand-rolled subprocess path.
 * `sdk` routes through `@letta-ai/letta-code-sdk` (Session). The flag is
 * read at adapter-construction time so an operator can flip transports
 * with a process restart, no recompile needed.
 *
 * The SDK adapter is dynamic-imported to keep its module out of the cold
 * load path for the default transport (avoids paying SDK init cost on every
 * shim boot when the feature is off).
 */
type Transport = "direct" | "sdk";
function resolveTransport(): Transport {
  const requested = process.env["SHIM_LETTA_TRANSPORT"] === "sdk" ? "sdk" : "direct";
  // lcp-sdk.6: the legacy per-request spawn path (SHIM_POOL_DISABLE=1 in
  // chat.ts) bypasses AgentPool entirely — it calls spawn(LETTA_BIN, ...)
  // directly with no adapter seam. If an operator sets both flags we
  // can't honor SDK transport, so log a one-time warning and fall back
  // to direct (the legacy path is direct anyway, so this matches the
  // path actually in use).
  if (requested === "sdk" && process.env["SHIM_POOL_DISABLE"] === "1" && !transportWarningEmitted) {
    transportWarningEmitted = true;
    logLine(
      "WARN: SHIM_LETTA_TRANSPORT=sdk has no effect while SHIM_POOL_DISABLE=1 — " +
      "the legacy per-request spawn path bypasses the adapter seam. " +
      "Unset SHIM_POOL_DISABLE to enable SDK transport.",
    );
    return "direct";
  }
  return requested;
}
let transportWarningEmitted = false;

async function createAdapter(
  transport: Transport,
  opts: LettaSessionAdapterOptions,
): Promise<LettaSessionAdapter> {
  if (transport === "sdk") {
    const { SdkBackedLettaSessionAdapter } = await import("./letta-sdk-adapter.js");
    return new SdkBackedLettaSessionAdapter(opts);
  }
  return new DirectSubprocessLettaSessionAdapter(opts);
}

class AgentPool {
  workers: Map<string, LettaSessionAdapter>;
  spawning: Map<string, Promise<LettaSessionAdapter>>;
  housekeepTimer: NodeJS.Timeout;

  constructor() {
    this.workers = new Map(); // key: conversationId → LettaSessionAdapter
    this.spawning = new Map(); // key: conversationId → Promise<LettaSessionAdapter>
    this.housekeepTimer = setInterval(() => this.housekeep(), HOUSEKEEP_INTERVAL_MS);
    this.housekeepTimer.unref?.();
  }

  size(): number {
    return this.workers.size;
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
   */
  async get(conversationId: string, agentId: string): Promise<LettaSessionAdapter> {
    const key = this._key(conversationId, agentId);
    let worker = this.workers.get(key);
    if (worker && !worker.dead) return worker;
    if (worker && worker.dead) this.workers.delete(key);

    const inFlight = this.spawning.get(key);
    if (inFlight) return inFlight;

    const p = (async (): Promise<LettaSessionAdapter> => {
      // Evict if over cap (LRU).
      while (this.workers.size >= MAX_WORKERS) {
        const entries = [...this.workers.entries()].sort(
          (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
        );
        const first = entries[0];
        if (!first) break;
        const oldestKey = first[0];
        if (!oldestKey) break;
        const victim = this.workers.get(oldestKey);
        logLine(`evicting (cap) conv=${oldestKey}`);
        this.workers.delete(oldestKey);
        victim?.close();
      }

      const transport = resolveTransport();
      const w = await createAdapter(transport, { conversationId, agentId });
      try {
        await w.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logLine(`spawn failed transport=${transport} key=${key}: ${msg}`);
        // LettaSessionAdapter#dead is readonly on the interface; both
        // concrete classes own a mutable backing field. Casting through
        // unknown avoids leaking that mutability into the public seam.
        (w as unknown as { dead: boolean }).dead = true;
        throw err;
      }
      this.workers.set(key, w);
      logLine(`spawned transport=${transport} key=${key} size=${this.workers.size}`);
      return w;
    })();

    this.spawning.set(key, p);
    try {
      const w = await p;
      return w;
    } finally {
      this.spawning.delete(key);
    }
  }

  housekeep(): void {
    const now = Date.now();
    for (const [key, w] of this.workers) {
      if (w.dead) {
        this.workers.delete(key);
        continue;
      }
      if (now - w.lastUsedAt > IDLE_EVICT_MS) {
        logLine(`evicting (idle) conv=${key} idle=${(now - w.lastUsedAt) / 1000}s`);
        this.workers.delete(key);
        w.close();
      }
    }
  }

  async stopAll(): Promise<void> {
    if (this.housekeepTimer) clearInterval(this.housekeepTimer);
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled(all.map((w) => w.close()));
  }

  stats(): PoolStats {
    return {
      size: this.workers.size,
      max: MAX_WORKERS,
      idle_evict_sec: IDLE_EVICT_MS / 1000,
      workers: [...this.workers.entries()].map(([k, w]) => ({
        key: k,
        conversation_id: w.conversationId,
        agent_id: w.agentId,
        ready: w.ready,
        dead: w.dead,
        idle_sec: Math.round((Date.now() - w.lastUsedAt) / 1000),
        spawned_sec: Math.round((Date.now() - w.spawnedAt) / 1000),
      })),
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
