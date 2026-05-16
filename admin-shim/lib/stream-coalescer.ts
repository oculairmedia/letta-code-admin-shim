/**
 * StreamCoalescer — smooths chunky upstream streams into a bounded-cadence
 * wire stream for the mobile WS path.
 *
 * Problem this solves:
 *   letta-code emits assistant_message / reasoning_message frames at
 *   whatever cadence the upstream provider flushes (5, 10, 50 tokens at
 *   a time, irregular). Mobile WS sees that raw cadence as "pop pop pop"
 *   bursts. Vanilla Letta's SSE contract gets coalesced by chat.ts into
 *   one-bubble-per-otid, but the mobile WS path forwards raw frames so
 *   chunks can stream — and currently inherits the upstream chunkiness
 *   verbatim, with no smoothing.
 *
 * Approach (clean-room reimplementation of the pattern from lettabot's
 * src/api/bot-stream-coalescer.ts; no code lifted):
 *   1. Buffer assistant_message / reasoning_message frames per otid for
 *      a configurable window (default 200ms). Concat content within a
 *      window so the wire sees ~5 frames/sec for a chatty turn.
 *   2. Replace tool_call snapshots by tool_call_id (latest wins). Flush
 *      immediately when status becomes terminal — UI affordances depend
 *      on the terminal state appearing promptly.
 *   3. Pass-through every other frame type, but flush pending buffers
 *      first so order is preserved.
 *
 * Wire contract is unchanged: clients still see the same frame shape
 * (same message_type, otid, content, etc.) — just fewer, larger ones,
 * arriving on a predictable cadence.
 *
 * Concurrency: coalescing is scoped per (message_type, otid) for text
 * frames and per tool_call_id for tool frames. The shim's WS handler is
 * single-flight per session, so multi-run interleaving isn't a concern
 * in practice — but the bucket scheme is robust against it anyway.
 *
 * Lifecycle:
 *   - handle(frame) for every reshaped frame from the worker.
 *   - flushAll() at end-of-turn so any final partial buffer is emitted
 *     before stop_reason / usage_statistics.
 *   - dispose() on session close — flushes and refuses further input.
 *
 * Tests: test/stream-coalescer.test.ts.
 */

import type { LettaMessage } from "./types/wire.js";

export const DEFAULT_COALESCE_WINDOW_MS = 200;

/**
 * Injectable timer pair. Default uses real `setTimeout`/`clearTimeout`;
 * tests inject a controllable fake (`makeFakeTimers`) so we can advance
 * time deterministically without sleeping.
 */
export interface CoalescerTimers {
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const realTimers: CoalescerTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h),
};

export interface StreamCoalescerOptions {
  /** Flush window in ms. Defaults to 200ms. */
  windowMs?: number;
  /** Sink for emitted frames — called once per flushed frame, in order. */
  onFlush: (frame: LettaMessage) => void;
  /** Optional timer overrides for tests. */
  timers?: CoalescerTimers;
}

type TextMessageType = "assistant_message" | "reasoning_message";

const TEXT_TYPES: ReadonlySet<string> = new Set<string>([
  "assistant_message",
  "reasoning_message",
]);

function isTextType(mt: string): mt is TextMessageType {
  return TEXT_TYPES.has(mt);
}

/**
 * Tool-call terminal statuses. When a tool_call_message frame arrives
 * carrying one of these, we flush immediately rather than batching —
 * mobile's tool-card affordance hides loading state on terminal status,
 * and a 200ms delay there is user-visible jank.
 */
const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set<string>([
  "success",
  "error",
  "completed",
  "failed",
  "canceled",
]);

/**
 * Internal buffered entry. Each entry corresponds to a single eventual
 * outbound frame; insertion order in the per-bucket `entries` array is
 * the order on the wire.
 */
type Entry =
  | { kind: "text"; type: TextMessageType; otid: string; frame: LettaMessage }
  | { kind: "tool"; toolCallId: string; frame: LettaMessage }
  | { kind: "passthrough"; frame: LettaMessage };

/**
 * Per-bucket state. We use a single global bucket keyed by `__global__`
 * — the shim's WS handler enforces single-flight-per-session so all
 * frames belong to one logical turn, but the bucket scheme is keyed
 * abstractly so multi-bucket variants are a future option without
 * reshaping the data model.
 */
interface BucketState {
  entries: Entry[];
  /**
   * otid → index into entries[] for adjacent-text merging. Cleared on
   * flush.
   */
  textIndex: Map<string, number>;
  /**
   * tool_call_id → index into entries[] for replace-by-id. Cleared on
   * flush.
   */
  toolIndex: Map<string, number>;
  /** Pending flush timer handle; null when none scheduled. */
  timer: ReturnType<typeof setTimeout> | null;
}

const GLOBAL_BUCKET = "__global__";

function bucketKey(): string {
  // Single-flight per session means one bucket is enough. Kept as a
  // function so the future multi-bucket variant has one obvious site
  // to extend.
  return GLOBAL_BUCKET;
}

function getOtid(frame: LettaMessage): string | null {
  const otid = (frame as { otid?: unknown }).otid;
  return typeof otid === "string" && otid.length > 0 ? otid : null;
}

function getToolCallId(frame: LettaMessage): string | null {
  // Tool frames carry the id under tool_call.tool_call_id (call) or
  // tool_call_id (return). Both shapes are guarded.
  const direct = (frame as { tool_call_id?: unknown }).tool_call_id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const tc = (frame as { tool_call?: { tool_call_id?: unknown } }).tool_call;
  const nested = tc?.tool_call_id;
  if (typeof nested === "string" && nested.length > 0) return nested;
  return null;
}

function getToolStatus(frame: LettaMessage): string | null {
  const s = (frame as { status?: unknown }).status;
  return typeof s === "string" ? s : null;
}

/**
 * Concatenate two text frames' `content`. Preserves the FIRST frame's
 * metadata (otid, id, message_type, etc.) — the id field in particular
 * is mobile's dedup key (cm-stream-<otid> / cm-reason-<otid>), so it
 * must remain stable across coalesced chunks.
 *
 * The latest frame's `date` and `seq_id` overwrite the prior values so
 * sort order against the disk projection reflects the most recent flush
 * moment, not the start of the buffer.
 */
function concatTextFrame(prior: LettaMessage, incoming: LettaMessage): LettaMessage {
  const p = prior as unknown as Record<string, unknown>;
  const i = incoming as unknown as Record<string, unknown>;
  const priorContent = typeof p["content"] === "string" ? (p["content"] as string) : "";
  const incomingContent = typeof i["content"] === "string" ? (i["content"] as string) : "";
  return {
    ...prior,
    content: priorContent + incomingContent,
    ...(typeof i["date"] === "string" ? { date: i["date"] } : {}),
    ...(typeof i["seq_id"] === "number" ? { seq_id: i["seq_id"] } : {}),
  } as LettaMessage;
}

/**
 * Concat for reasoning frames: same idea as text, but the payload key is
 * `reasoning`, not `content`. Reasoning frames may also carry a `signature`
 * which is appended (not replaced) if both are non-empty — reasoning
 * signatures are continuation tokens, not snapshots.
 */
function concatReasoningFrame(prior: LettaMessage, incoming: LettaMessage): LettaMessage {
  const p = prior as unknown as Record<string, unknown>;
  const i = incoming as unknown as Record<string, unknown>;
  const priorReasoning = typeof p["reasoning"] === "string" ? (p["reasoning"] as string) : "";
  const incomingReasoning = typeof i["reasoning"] === "string" ? (i["reasoning"] as string) : "";
  const priorSig = typeof p["signature"] === "string" ? (p["signature"] as string) : "";
  const incomingSig = typeof i["signature"] === "string" ? (i["signature"] as string) : "";
  const combinedSig = priorSig && incomingSig ? priorSig + incomingSig : (incomingSig || priorSig);
  return {
    ...prior,
    reasoning: priorReasoning + incomingReasoning,
    ...(combinedSig ? { signature: combinedSig } : {}),
    ...(typeof i["date"] === "string" ? { date: i["date"] } : {}),
    ...(typeof i["seq_id"] === "number" ? { seq_id: i["seq_id"] } : {}),
  } as LettaMessage;
}

/**
 * Coalesces an inbound stream of LettaMessage frames into a smoother,
 * lower-frame-count outbound stream. One instance per WS session.
 *
 * Invariants:
 *   - Every frame that enters via `handle` exits via the `onFlush` sink
 *     exactly once (no drops, no duplicates), assuming `flushAll()` is
 *     called at end-of-turn or `dispose()` on close.
 *   - Inter-frame order is preserved across types. A passthrough or
 *     terminal-tool frame triggers a flush of all pending entries first.
 *   - Text frames sharing the same `(message_type, otid)` are merged
 *     into one outbound frame per flush window.
 *   - Tool_call snapshots sharing the same `tool_call_id` are deduped:
 *     only the latest snapshot at flush time is emitted.
 */
export class StreamCoalescer {
  private readonly windowMs: number;
  private readonly onFlush: (frame: LettaMessage) => void;
  private readonly timers: CoalescerTimers;
  private readonly buckets = new Map<string, BucketState>();
  private disposed = false;

  constructor(options: StreamCoalescerOptions) {
    this.windowMs = options.windowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.onFlush = options.onFlush;
    this.timers = options.timers ?? realTimers;
  }

  /**
   * Submit a reshaped frame. The coalescer decides whether to merge it
   * with a pending entry, dedup-replace, or flush.
   */
  handle(frame: LettaMessage): void {
    if (this.disposed) {
      // After dispose, late-arriving frames pass through so we don't
      // silently drop them. This shouldn't normally happen — the WS
      // handler stops accepting frames before disposing — but it's
      // the conservative default.
      this.onFlush(frame);
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const mt = (frame as { message_type?: unknown }).message_type;
    if (typeof mt !== "string") {
      // Unrecognized shape — flush pending and pass through.
      this.flushBucket(bucketKey());
      this.onFlush(frame);
      return;
    }

    const key = bucketKey();
    const state = this.getOrCreate(key);

    // ── Text frames (assistant_message, reasoning_message) ────────
    if (isTextType(mt)) {
      const otid = getOtid(frame);
      if (otid === null) {
        // No otid → can't merge into a stable bucket. Flush pending
        // first to preserve order, then pass through.
        this.flushBucket(key);
        this.onFlush(frame);
        return;
      }
      // Composite key: same otid across different message_types is
      // semantically different (assistant vs. reasoning), so namespace.
      const textKey = `${mt}:${otid}`;
      const existingIdx = state.textIndex.get(textKey);
      if (existingIdx !== undefined) {
        const entry = state.entries[existingIdx];
        if (entry && entry.kind === "text") {
          entry.frame =
            mt === "reasoning_message"
              ? concatReasoningFrame(entry.frame, frame)
              : concatTextFrame(entry.frame, frame);
        }
      } else {
        const idx = state.entries.length;
        state.entries.push({ kind: "text", type: mt, otid, frame });
        state.textIndex.set(textKey, idx);
      }
      this.scheduleFlush(key, state);
      return;
    }

    // ── Tool-call frames (snapshot, replace-by-id) ────────────────
    if (mt === "tool_call_message") {
      const tcid = getToolCallId(frame);
      if (tcid === null) {
        // No tool_call_id — pass through (after flushing pending, to
        // preserve order). Order-without-dedup is correct here.
        this.flushBucket(key);
        this.onFlush(frame);
        return;
      }
      const existingIdx = state.toolIndex.get(tcid);
      if (existingIdx !== undefined) {
        const entry = state.entries[existingIdx];
        if (entry && entry.kind === "tool") {
          entry.frame = frame;
        }
      } else {
        const idx = state.entries.length;
        state.entries.push({ kind: "tool", toolCallId: tcid, frame });
        state.toolIndex.set(tcid, idx);
      }
      const status = getToolStatus(frame);
      if (status !== null && TERMINAL_TOOL_STATUSES.has(status)) {
        this.flushBucket(key);
      } else {
        this.scheduleFlush(key, state);
      }
      return;
    }

    // ── Tool-return frames: order-preserving passthrough ──────────
    // tool_return_message is a terminal event for the tool invocation;
    // flush pending first so the return follows its call snapshot.
    if (mt === "tool_return_message") {
      this.flushBucket(key);
      this.onFlush(frame);
      return;
    }

    // ── All other types (stop_reason, usage_statistics, ping, ...):
    // flush pending first to preserve order, then pass through.
    this.flushBucket(key);
    this.onFlush(frame);
  }

  /**
   * Flush everything pending. Called at end-of-turn so any final partial
   * assistant/reasoning buffer is emitted before the channel host
   * forwards stop_reason / usage_statistics.
   */
  flushAll(): void {
    for (const key of Array.from(this.buckets.keys())) {
      this.flushBucket(key);
    }
  }

  /**
   * Dispose. Flushes everything and refuses further input (after which
   * `handle` falls back to passthrough as a safety net).
   */
  dispose(): void {
    if (this.disposed) return;
    this.flushAll();
    this.disposed = true;
  }

  /** Test-only: number of buckets with pending entries. */
  pendingBucketCount(): number {
    return this.buckets.size;
  }

  // ── internals ────────────────────────────────────────────────

  private getOrCreate(key: string): BucketState {
    let s = this.buckets.get(key);
    if (!s) {
      s = { entries: [], textIndex: new Map(), toolIndex: new Map(), timer: null };
      this.buckets.set(key, s);
    }
    return s;
  }

  private scheduleFlush(key: string, state: BucketState): void {
    if (state.timer) return;
    state.timer = this.timers.setTimeout(() => {
      const current = this.buckets.get(key);
      if (!current) return;
      current.timer = null;
      this.flushBucket(key);
    }, this.windowMs);
  }

  private flushBucket(key: string): void {
    const state = this.buckets.get(key);
    if (!state) return;
    if (state.timer) {
      this.timers.clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.entries.length === 0) {
      this.buckets.delete(key);
      return;
    }
    // Snapshot then clear before draining so any re-entrant handle()
    // call from inside onFlush sees clean state.
    const drained = state.entries;
    state.entries = [];
    state.textIndex.clear();
    state.toolIndex.clear();
    this.buckets.delete(key);
    for (const entry of drained) {
      this.onFlush(entry.frame);
    }
  }
}
