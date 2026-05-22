/**
 * lcp-sdk.3 — SDK-backed Letta session adapter.
 *
 * Alternate `LettaSessionAdapter` implementation that drives the letta-code
 * CLI through `@letta-ai/letta-code-sdk` instead of hand-rolled subprocess
 * spawning + stdout parsing. Gated by `SHIM_LETTA_TRANSPORT=sdk`; the
 * `DirectSubprocessLettaSessionAdapter` in agent-pool.ts remains the
 * production default until parity is proven (lcp-sdk.4 → .9).
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

import {
  resumeSession,
  type Session,
  type SDKMessage,
  type SDKResultMessage,
} from "@letta-ai/letta-code-sdk";

import type {
  LettaStreamFrame,
  LettaInnerEvent,
} from "./types/letta-stream.js";

import type {
  AdapterRunTurnResult,
  LettaSessionAdapter,
  LettaSessionAdapterOptions,
  LettaSessionInit,
  RunTurnOptions,
} from "./agent-pool.js";

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
    const runId = opts.runHandle?.id ?? "";

    const frames: LettaStreamFrame[] = [];
    let result: SDKResultMessage | null = null;
    let timedOut = false;
    let aborted = false;

    // SendMessage is `string | MessageContentItem[]`. Our adapter contract
    // accepts the same union (string for plain text, content-parts array for
    // multimodal). Cast through unknown[] → SendMessage's array branch; the
    // SDK validates shape internally.
    const sendInput = (typeof input === "string" ? input : input) as Parameters<Session["send"]>[0];

    // Watchdog: same envelope the direct adapter uses. Race the stream loop
    // against a timer; on timeout we flag and let the loop break itself by
    // checking `timedOut` after the next yielded message (or via abort).
    let watchdog: NodeJS.Timeout | null = setTimeout(() => {
      timedOut = true;
      // Best-effort interrupt; the CLI may or may not respond before the
      // session pump terminates. If it doesn't, close() in the finally
      // path tears the subprocess down.
      session.abort().catch(() => {});
    }, TURN_TIMEOUT_MS);

    try {
      await session.send(sendInput);

      for await (const msg of session.stream()) {
        if (aborted) break;
        const frame = sdkMessageToLettaFrame(msg, this.sessionId, this.agentId, this.conversationId);
        if (frame) {
          frames.push(frame);
          if (opts.onFrame) {
            try {
              opts.onFrame(frame, { runId });
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
    }

    if (timedOut) {
      return { frames, stderr: "", run_id: runId, timeout: true };
    }
    if (result) {
      return {
        frames,
        stderr: "",
        run_id: runId,
        done: result.success,
        // SDK surfaces upstream Letta run ids as `result.runIds`. We do NOT
        // expose them as the mobile-facing run id — the shim continues to
        // own /v1/runs/* (see lcp-sdk-decide-runid). Caller correlates via
        // opts.runHandle.id, which we echo back unchanged.
      };
    }
    // Stream ended without a result frame (e.g. session closed mid-turn).
    return { frames, stderr: "", run_id: runId, dead: true, error: "stream ended without result" };
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
