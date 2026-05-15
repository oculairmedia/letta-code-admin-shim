/**
 * POST /v1/agents/{id}/messages — spawn letta-code as a subprocess and
 * relay its stream-json output as SSE (streaming case) or a single JSON
 * payload (non-streaming case).
 *
 * letta-code emits one JSON frame per stdout line:
 *   {type:"system", subtype:"init", ...}
 *   {type:"message", message_type:"assistant_message", content:[{type:"text",text:"..."}], ...}
 *   {type:"message", message_type:"usage_statistics", prompt_tokens, ...}
 *   {type:"message", message_type:"stop_reason", stop_reason:"end_turn", ...}
 *   {type:"result", subtype:"success", result:"...", ...}
 *
 * Mobile's SSE consumer expects events with name = message_type and the JSON
 * frame as data. We pass them through largely unchanged.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { getAgentPool } from "./agent-pool.js";
import { findUnmappedTailUserMessageId, writeOtidForLocalId } from "./store.js";
import { toStringArrayOrNull } from "./translate.js";
import type {
  LettaMessage,
  AssistantMessage,
  PingMessage,
  StopReasonMessage,
  ToolCall,
  ToolReturn,
  UsageStatisticsMessage,
} from "./types/wire.js";

const POOL_ENABLED = process.env["SHIM_POOL_DISABLE"] !== "1";

/**
 * Shape of the JSON body POSTed to `/v1/agents/{id}/messages`. Mobile,
 * vanilla clients, and curl all hit this endpoint with overlapping but
 * non-identical bodies. We type the body permissively here and narrow
 * inside the extractors.
 */
type MessageRequestBody = Record<string, unknown>;

/**
 * Tail-end of a message-record inside `body.messages` / `body.message`.
 * Fields are accessed via runtime guards.
 */
type RequestMessageLike = Record<string, unknown>;

function extractUserOtid(body: MessageRequestBody | null | undefined): string | null {
  // Mobile sends `{ messages: [{role:"user", content:"...", otid:"cm-..."}], ...}`.
  // Pull the first user-role otid; that's the bubble we need to reconcile.
  // Falls back to `body.otid` for legacy callers and `null` for clients
  // that don't supply one (curl, our smoke test).
  if (!body) return null;
  const messages = body["messages"] ?? body["message"];
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (m && typeof m === "object") {
        const rec = m as RequestMessageLike;
        if ((rec["role"] === "user" || !rec["role"]) && typeof rec["otid"] === "string" && rec["otid"]) {
          return rec["otid"];
        }
      }
    }
  }
  if (typeof body["otid"] === "string" && body["otid"]) return body["otid"];
  return null;
}

function extractText(body: unknown): string {
  // Mobile sends MessageCreateRequest with either:
  //   { messages: [{role:"user", content:"..."}], ... }
  //   { messages: [{role:"user", content:[{type:"text",text:"..."}]}], ... }
  //   { input: "raw text", ... }
  //   { text: "..." }  (legacy)
  if (!body) return "";
  if (typeof body === "string") return body;
  if (typeof body !== "object") return "";
  const rec = body as Record<string, unknown>;
  if (typeof rec["input"] === "string") return rec["input"];
  if (typeof rec["text"] === "string") return rec["text"];
  const messages = rec["messages"] ?? rec["message"];
  if (Array.isArray(messages)) {
    return messages
      .map((m: unknown) => {
        if (typeof m === "string") return m;
        if (m && typeof m === "object") {
          const r = m as Record<string, unknown>;
          if (typeof r["content"] === "string") return r["content"];
          if (Array.isArray(r["content"])) {
            return r["content"]
              .map((c: unknown) => {
                if (c && typeof c === "object") {
                  const cr = c as Record<string, unknown>;
                  return typeof cr["text"] === "string" ? cr["text"] : "";
                }
                return "";
              })
              .join("");
          }
        }
        return "";
      })
      .join("\n");
  }
  if (typeof messages === "string") return messages;
  return "";
}

function sseDataFrame(payload: unknown): string {
  // Mobile's SseParser only reads `data:` lines. Skip the `event:` line.
  // Every payload must have `message_type` at the top level or it's treated
  // as a heartbeat. End with a blank line.
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function sseDoneFrame(): string {
  return `data: [DONE]\n\n`;
}

// Mobile's chat dedup pass (`dedupeOptimisticContentTwins` in
// ChatRenderModelBuilder.kt) collapses adjacent same-content messages
// when at least one side has an id starting with `cm-` or `client-` —
// flagging it as "optimistic, will be re-confirmed by a server fetch."
// letta-code's stream emits ids like `letta-msg-1` and the on-disk
// version stores `ui-msg-N`; without a prefix neither side is flagged,
// the dedup does not fire, and the user sees their reply rendered twice
// (once from the stream, once from the conv-list refetch). Marking the
// stream's transient ids as `cm-stream-…` lets mobile collapse them
// against the disk-fetched confirmed copy automatically.
function tagAsOptimistic<T extends LettaMessage>(frame: T): T {
  // The bare-envelope variants (stop_reason / usage_statistics) lack an
  // `id` field entirely — checking `"id" in frame` narrows them out.
  if (!frame || !("id" in frame) || typeof frame.id !== "string") return frame;
  if (frame.id.startsWith("cm-") || frame.id.startsWith("client-")) return frame;
  // tool_call_message and tool_return_message use stable ids derived
  // from tool_call_id — already matching across stream and disk. Adding
  // a `cm-stream-` prefix would BREAK strict-id dedup. Skip them.
  if (
    frame.message_type === "tool_call_message" ||
    frame.message_type === "tool_return_message" ||
    frame.message_type === "approval_request_message"
  ) {
    return frame;
  }
  return { ...frame, id: `cm-stream-${frame.id}` };
}

function partsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p: unknown) => {
      // Original: `p?.type === "text"`. Same semantics: only objects whose
      // `type` field equals "text" pass. Scalars / null / undefined / arrays
      // without a `type:"text"` field are filtered out.
      if (p == null) return false;
      return (p as { type?: unknown }).type === "text";
    })
    .map((p: unknown) => {
      // Original: `p.text || ""` — keep the `||` (falsy-coalesce) semantics,
      // not `??`, so 0 / false / "" all coerce to "" the same way.
      const t = (p as { text?: unknown }).text;
      // Cast through unknown so `||` keeps its JS short-circuit behavior;
      // TS would otherwise object to `unknown || ""`.
      return (t || "") as string;
    })
    .join("");
}

/**
 * Map a raw letta-code stream-json frame to the Letta-server-shaped frame
 * mobile expects. Returns null for frames that shouldn't reach mobile.
 *
 * Vanilla shape per type (faithfully matched here):
 *
 *   ping:               { id, date, name, message_type:"ping", otid:null,
 *                         sender_id, step_id, is_err, seq_id, run_id }
 *   reasoning_message:  + { source, reasoning, signature }
 *   assistant_message:  + { content }                       (content as string)
 *   tool_call_message:  + { tool_call:{name,arguments,tool_call_id}, tool_calls:[...] }
 *   tool_return_message:+ { tool_return, status, tool_call_id, stdout, stderr, tool_returns:[...] }
 *   stop_reason:        { message_type:"stop_reason", stop_reason:"end_turn" }      [NO envelope]
 *   usage_statistics:   { message_type:"usage_statistics", completion_tokens,
 *                         prompt_tokens, total_tokens, step_count, run_ids,
 *                         cached_input_tokens, cache_write_tokens,
 *                         reasoning_tokens, context_tokens }                          [NO envelope]
 *
 * Letta-code's stream emits the message types with `type:"message"` wrappers,
 * plus `type:"system"` (init), `type:"stream_event"` (delta wrappers), and
 * `type:"result"` (final coalesce). We drop the wrappers we don't need.
 */
function isoNow(): string {
  return new Date().toISOString();
}

export function reshapeFrame(raw: unknown): LettaMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const rawRec = raw as Record<string, unknown>;
  let f: Record<string, unknown> = rawRec;

  if (rawRec["type"] === "stream_event" && rawRec["event"] && typeof rawRec["event"] === "object") {
    // The wall-clock `timestamp` lives on the OUTER stream_event frame;
    // the inner event only carries the sentinel `date`. Forward the outer
    // timestamp onto the inner so downstream code picks it up.
    const evt = rawRec["event"] as Record<string, unknown>;
    f = { ...evt, timestamp: evt["timestamp"] ?? rawRec["timestamp"] };
  } else if (rawRec["type"] === "system") return null;
  else if (rawRec["type"] === "result") return null;

  // Original: `const mt = f.message_type; if (!mt) return null;`. TS needs
  // `mt` typed as `string` for the literal comparisons below, but the .mjs
  // accepted any truthy value (string mt's match a branch; non-string truthy
  // values fall through to the passthrough). To preserve that exactly we
  // keep the `!mt` check and cast to string for the comparisons — they're
  // all `===` against string literals, which evaluate false for non-strings
  // and still funnel non-string truthies to the passthrough block.
  const mtRaw = f["message_type"];
  if (!mtRaw) return null;
  const mt = mtRaw as string;

  // Bare-envelope frames — vanilla emits these without the id/date/otid
  // boilerplate. Match that exactly so mobile's parser sees the right shape.
  if (mt === "stop_reason") {
    return {
      message_type: "stop_reason",
      stop_reason: (f["stop_reason"] ?? "end_turn") as string,
    };
  }
  if (mt === "usage_statistics") {
    // run_ids carries the run this usage observation belongs to. The streaming
    // path's handleRawFrameWithRun stamps the active run id onto every raw
    // frame, so by the time reshape sees this frame `f.run_id` is the active
    // run id (or absent if the frame wasn't routed through that path). lcp-0c5.
    const rid = f["run_id"];
    const runIds = typeof rid === "string" && rid.length > 0 ? [rid] : null;
    const usage: UsageStatisticsMessage = {
      message_type: "usage_statistics",
      completion_tokens: (f["completion_tokens"] ?? 0) as number,
      prompt_tokens: (f["prompt_tokens"] ?? 0) as number,
      total_tokens: (f["total_tokens"] ?? 0) as number,
      step_count: 1,
      run_ids: runIds,
      cached_input_tokens: (f["cached_input_tokens"] ?? 0) as number,
      cache_write_tokens: (f["cache_write_tokens"] ?? 0) as number,
      reasoning_tokens: (f["reasoning_tokens"] ?? 0) as number,
      context_tokens: (f["context_tokens"] ?? f["total_tokens"] ?? 0) as number,
    };
    return usage;
  }
  if (mt === "ping") {
    const ping: PingMessage = {
      id: (f["id"] ?? `ping-${Date.now()}`) as string,
      date: (f["date"] ?? f["timestamp"] ?? isoNow()) as string,
      name: null,
      message_type: "ping",
      otid: null,
      sender_id: null,
      step_id: null,
      is_err: null,
      seq_id: null,
      run_id: (f["run_id"] ?? null) as string | null,
    };
    return ping;
  }

  // Content normalization: letta-code emits content as [{type:"text",text}]
  // for assistant/user; vanilla emits it as a string in conv-listed streams.
  let content: unknown = f["content"];
  if (Array.isArray(content)) content = partsToText(content);

  const base = {
    id: (f["id"] ?? f["uuid"] ?? `letta-msg-${Date.now()}`) as string,
    // letta-code emits BOTH `timestamp` (real wall-clock) and `date`
    // (sentinel: Date.UTC(2026,0,1,0,0,seqIndex+1)). The sentinel encodes
    // message order, not time. Mobile and other clients sort by `date` —
    // if we pass the sentinel, every message lands on Jan 1, 2026 and
    // recently-arrived stream messages appear duplicated against
    // disk-fetched history. Prefer the real timestamp.
    date: (f["timestamp"] ?? f["date"] ?? isoNow()) as string,
    name: (f["name"] ?? null) as string | null,
    otid: (f["otid"] ?? null) as string | null,
    sender_id: (f["sender_id"] ?? null) as string | null,
    step_id: (f["step_id"] ?? null) as string | null,
    is_err: (f["is_err"] ?? null) as boolean | null,
    seq_id: (f["seq_id"] ?? null) as number | null,
    run_id: (f["run_id"] ?? null) as string | null,
  };

  if (mt === "reasoning_message") {
    return {
      ...base,
      message_type: "reasoning_message",
      source: (f["source"] ?? "reasoner_model") as string | null,
      reasoning:
        typeof f["reasoning"] === "string"
          ? f["reasoning"]
          : typeof content === "string"
            ? content
            : "",
      signature: (f["signature"] ?? null) as string | null,
    };
  }
  if (mt === "assistant_message" || mt === "user_message" || mt === "system_message") {
    return {
      ...base,
      message_type: mt,
      content: typeof content === "string" ? content : "",
    };
  }
  if (mt === "tool_call_message" || mt === "approval_request_message") {
    // Tool-call message `content` is empty (the payload is in `tool_call`),
    // so mobile's content-based dedup can't collapse stream-vs-disk twins.
    // Use a stable id derived from tool_call_id — emitted identically by
    // both the stream and the conv-list projection — so mobile's strict
    // `distinctBy { id }` pass collapses them.
    //
    // letta-code's stream emits `approval_request_message` for ALL tool
    // calls (whether or not approval is required). The on-disk projection
    // emits the matching pair `tool_call_message` + `tool_return_message`
    // (per vanilla's shape). Remap the stream's approval_request_message
    // to tool_call_message so both paths agree on the message_type. With
    // permission_mode=unrestricted (mobile's default for this shim) the
    // tool runs without an actual approval round-trip.
    const tc = (f["tool_call"] ?? null) as ToolCall | null;
    const tcs = (f["tool_calls"] ?? null) as ToolCall[] | null;
    const tcFirst = Array.isArray(tcs) ? tcs[0] : undefined;
    const callId = tc?.tool_call_id ?? tcFirst?.tool_call_id;
    return {
      ...base,
      id: callId ? `toolcall-${callId}` : base.id,
      message_type: "tool_call_message",
      tool_call: tc,
      tool_calls: tcs ?? (tc ? [tc] : null),
    };
  }
  if (mt === "tool_return_message") {
    // Same id-matching trick for tool returns.
    const trs = (f["tool_returns"] ?? null) as ToolReturn[] | null;
    const trFirst = Array.isArray(trs) ? trs[0] : undefined;
    // Original: `f.tool_call_id ?? f.tool_returns?.[0]?.tool_call_id` — keep
    // the raw nullish chain (don't narrow on type) so non-string truthies
    // flow through identically to the .mjs.
    const callId = (f["tool_call_id"] ?? trFirst?.tool_call_id) as
      | string
      | number
      | null
      | undefined;
    return {
      ...base,
      id: callId ? `toolreturn-${callId}` : base.id,
      message_type: "tool_return_message",
      tool_return: (f["tool_return"] ?? null) as string | null,
      status: (f["status"] ?? "success") as string,
      tool_call_id: (callId ?? null) as string | null,
      stdout: toStringArrayOrNull(f["stdout"]),
      stderr: toStringArrayOrNull(f["stderr"]),
      tool_returns: trs,
    };
  }
  // Unknown message_type — pass through with minimal envelope.
  // The .mjs returned `{ ...base, ...(typeof content === "string" ? { content } : {}) }`
  // where `base.message_type` was `mt` (i.e. the raw upstream value, which
  // may be a string the wire types don't enumerate — or in rare cases not
  // a string at all). We preserve that exact runtime shape; cast through
  // unknown because the result doesn't statically match LettaMessage.
  const passthrough = {
    ...base,
    message_type: mtRaw,
    ...(typeof content === "string" ? { content } : {}),
  };
  return passthrough as unknown as LettaMessage;
}

function makeOpeningPing(runId?: string | null): PingMessage {
  return {
    id: `ping-${Date.now()}`,
    date: isoNow(),
    name: null,
    message_type: "ping",
    otid: null,
    sender_id: null,
    step_id: null,
    is_err: null,
    seq_id: null,
    run_id: runId ?? null,
  };
}

/**
 * Coalesce consecutive assistant_message frames that share the same otid into
 * a single message. letta-code emits assistant text in small chunks ("sh",
 * "im chat works"); mobile renders one bubble per frame, which looks ugly.
 */
export function coalesceAssistantFrames(frames: LettaMessage[]): LettaMessage[] {
  // Buffer chunks in an array and join once per group, instead of
  // `prev.content + f.content` per chunk (allocates a new growing string
  // every step — O(n^2) in total chunks for a long stream). See lcp-86o.
  const out: LettaMessage[] = [];
  let groupParts: string[] | null = null; // accumulator for out[out.length-1]
  const flushGroup = (): void => {
    const tail = out[out.length - 1];
    if (groupParts && tail && tail.message_type === "assistant_message") {
      tail.content = groupParts.join("");
    }
    groupParts = null;
  };
  for (const f of frames) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.message_type === "assistant_message" &&
      f.message_type === "assistant_message" &&
      prev.otid &&
      prev.otid === f.otid
    ) {
      // Continuation of the current group. Seed the buffer with the prev
      // content on the first continuation, then push each new chunk.
      if (!groupParts) groupParts = [prev.content ?? ""];
      groupParts.push(f.content ?? "");
      prev.id = f.id; // keep the latest id
      prev.date = f.date;
      prev.seq_id = f.seq_id;
    } else {
      flushGroup();
      out.push({ ...f });
    }
  }
  flushGroup();
  return out;
}

/** Options accepted by the legacy per-request spawn arg builder. */
interface BuildLettaArgsOptions {
  stream?: boolean;
}

// Legacy per-request spawn arg builder, kept for the POOL_DISABLE fallback.
function buildLettaArgs(
  agentId: string | null | undefined,
  conversationId: string | null | undefined,
  text: string,
  { stream }: BuildLettaArgsOptions = {},
): string[] {
  let scope: string[];
  if (conversationId === "default" && agentId) {
    scope = ["--agent", agentId, "--conversation", "default"];
  } else if (conversationId) {
    scope = ["--conversation", conversationId];
  } else if (agentId) {
    scope = ["--agent", agentId];
  } else {
    scope = [];
  }
  return [
    "--backend",
    "local",
    ...scope,
    "-p",
    text,
    "--output-format",
    "stream-json",
    ...(stream ? ["--include-partial-messages"] : []),
  ];
}

/** Optional handler args supplied by the route. */
export interface HandleSendMessageOptions {
  conversationId?: string | undefined;
}

export async function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  { conversationId: explicitConv }: HandleSendMessageOptions = {},
): Promise<void> {
  // Read body
  const buf: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  let body: MessageRequestBody = {};
  try {
    const parsed = JSON.parse(buf.toString("utf8") || "{}");
    body = (parsed && typeof parsed === "object" ? parsed : {}) as MessageRequestBody;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: `bad json: ${msg}` }));
    return;
  }

  const text = extractText(body);
  if (!text) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "missing user text" }));
    return;
  }
  // Original chained `explicitConv ?? body.conversation_id ?? body.conversationId ?? undefined`.
  // Keep the exact nullish chain — including the possibility that body.conversation_id
  // could be a non-string truthy value (it always is a string in mobile, but
  // legacy callers might pass other shapes; widen to `unknown` to preserve
  // behavior, then narrow at use-sites).
  const conversationId: string | undefined = (
    explicitConv ?? body["conversation_id"] ?? body["conversationId"] ?? undefined
  ) as string | undefined;
  // Mobile uses `streaming` (and `stream_tokens`); legacy uses `stream`.
  // Default to streaming when caller didn't specify.
  const wantStream =
    body["streaming"] === true ||
    body["stream_tokens"] === true ||
    (body["streaming"] === undefined &&
      body["stream_tokens"] === undefined &&
      body["stream"] !== false);

  const frames: LettaMessage[] = []; // collected for non-streaming + final result
  let stderrBuf = "";

  // Anchor stream-frame timestamps to turn-start with FIXED per-type offsets
  // so they sort consistently against the disk projection. Mobile renders
  // the union of stream + refetch and sorts by `date`; without a shared
  // schedule the user's prompt (disk-only) can land in the middle of an
  // agent's reply, or a tool_return can appear before its tool_call.
  //
  // Schedule (per turn, applied on BOTH sides):
  //   user_message        + 0 ms
  //   reasoning_message   +10 ms
  //   tool_call_message   +20 ms
  //   tool_return_message +30 ms
  //   assistant_message   +40 ms
  //   ping                 + 0 ms (sorts with user but mobile usually drops)
  //
  // Same anchor is threaded into the worker so disk-side `stampNewMessages`
  // uses these same offsets — keeps cross-side ordering deterministic
  // regardless of which dedup-winner wins (distinctBy keeps first by id;
  // content dedup keeps the cm-stream- twin).
  const turnStartedAt = Date.now();
  const TYPE_OFFSET: Record<string, number> = {
    user_message: 0,
    ping: 0,
    reasoning_message: 10,
    tool_call_message: 20,
    tool_return_message: 30,
    assistant_message: 40,
  };
  const stampStreamDate = <T extends LettaMessage>(frame: T): T => {
    if (!frame || frame.message_type === "stop_reason" || frame.message_type === "usage_statistics") {
      return frame;
    }
    const off = TYPE_OFFSET[frame.message_type] ?? 50;
    return { ...frame, date: new Date(turnStartedAt + off).toISOString() };
  };

  if (wantStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    // Vanilla opens every stream with a ping frame. Mobile uses it as a
    // "stream-alive" signal; emit ours immediately so the UI knows the
    // request was accepted before the model starts generating.
    res.write(sseDataFrame(makeOpeningPing()));
  }

  // Vanilla emits ONE assistant_message per turn (server-side buffered) plus
  // ping/reasoning/stop_reason/usage in a specific order:
  //   ping → reasoning_message → assistant_message → stop_reason → usage → [DONE]
  // Letta-code emits the assistant reply in many chunked assistant_message
  // frames (one per partial-emit), plus usage BEFORE stop_reason. To match
  // vanilla's contract we coalesce consecutive assistant chunks (by otid)
  // and re-order stop_reason / usage at end-of-turn.
  let pendingStop: StopReasonMessage | null = null;
  let pendingUsage: UsageStatisticsMessage | null = null;
  let pendingAssistant: AssistantMessage | null = null; // { ...base, content: "running concat" }
  const flushPendingAssistant = (): void => {
    if (pendingAssistant && wantStream && !res.writableEnded) {
      res.write(sseDataFrame(stampStreamDate(tagAsOptimistic(pendingAssistant))));
    }
    pendingAssistant = null;
  };
  const flushTail = (): void => {
    flushPendingAssistant();
    if (pendingStop && wantStream && !res.writableEnded) res.write(sseDataFrame(pendingStop));
    if (pendingUsage && wantStream && !res.writableEnded) res.write(sseDataFrame(pendingUsage));
    pendingStop = null;
    pendingUsage = null;
  };

  const handleRawFrame = (raw: unknown): void => {
    const reshaped = reshapeFrame(raw);
    if (!reshaped) return;
    frames.push(reshaped);
    if (!wantStream) return;
    if (res.writableEnded) return;

    if (reshaped.message_type === "stop_reason") {
      // lcp-c4d: first-wins. Multi-step turns can emit several stop_reason
      // frames upstream; the run-level contract (runs.ts finalizeRun) keeps
      // the FIRST observed value. Align the SSE-stream contract by ignoring
      // subsequent stop_reason frames once one is buffered.
      if (pendingStop === null) pendingStop = reshaped;
      return;
    }
    if (reshaped.message_type === "usage_statistics") {
      // lcp-c4d: first-wins, matching the run-level contract above.
      if (pendingUsage === null) pendingUsage = reshaped;
      return;
    }
    if (reshaped.message_type === "assistant_message") {
      // Coalesce chunks that share an otid. If otid changes (different
      // turn / different bubble) flush the previous chunk first.
      if (pendingAssistant && pendingAssistant.otid && pendingAssistant.otid === reshaped.otid) {
        pendingAssistant.content = (pendingAssistant.content ?? "") + (reshaped.content ?? "");
        pendingAssistant.id = reshaped.id; // keep latest id
        pendingAssistant.date = reshaped.date;
        pendingAssistant.seq_id = reshaped.seq_id;
        return;
      }
      flushPendingAssistant();
      pendingAssistant = { ...reshaped };
      return;
    }
    // Any other frame (tool_call_message, tool_return_message, reasoning,
    // ping, etc.) flushes whatever assistant chunk we were coalescing —
    // can't combine across different message types.
    flushPendingAssistant();
    res.write(sseDataFrame(stampStreamDate(tagAsOptimistic(reshaped))));
  };

  interface FinalizeArgs {
    exitCode?: number | null;
    stderrTail?: string;
  }

  const finalizeResponse = ({ exitCode = 0, stderrTail = "" }: FinalizeArgs = {}): void => {
    if (wantStream) {
      if (!res.writableEnded) {
        flushTail();
        res.write(sseDoneFrame());
        res.end();
      }
      return;
    }
    const coalesced = coalesceAssistantFrames(frames);
    const messages = coalesced.filter(
      (f) =>
        f.message_type === "assistant_message" ||
        f.message_type === "tool_call_message" ||
        f.message_type === "tool_return_message" ||
        f.message_type === "reasoning_message",
    );
    const stop = coalesced.find((f): f is StopReasonMessage => f.message_type === "stop_reason");
    const usageFrame = coalesced.find(
      (f): f is UsageStatisticsMessage => f.message_type === "usage_statistics",
    );

    res.writeHead(exitCode === 0 ? 200 : 500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        messages,
        stop_reason: stop
          ? { stop_reason: stop.stop_reason ?? "end_turn", message_type: "stop_reason" }
          : { stop_reason: "end_turn", message_type: "stop_reason" },
        usage: usageFrame
          ? {
              completion_tokens: usageFrame.completion_tokens ?? 0,
              prompt_tokens: usageFrame.prompt_tokens ?? 0,
              total_tokens: usageFrame.total_tokens ?? 0,
              step_count: 1,
            }
          : { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0, step_count: 0 },
        agent_id: agentId,
        conversation_id: conversationId ?? null,
        ...(exitCode !== 0 ? { stderr: stderrTail.slice(0, 2000) } : {}),
      }),
    );
  };

  if (POOL_ENABLED) {
    try {
      const userOtid = extractUserOtid(body);
      const pool = getAgentPool();
      const worker = await pool.get(conversationId ?? "default", agentId);
      // Track the active run for this request. We surface its id on every
      // outgoing frame so mobile can correlate stream events with the
      // /v1/runs/{id} record it polls. Captured via the onRunCreated hook
      // (fires before the first frame).
      let activeRunId: string | null = null;
      const handleRawFrameWithRun = (raw: unknown, meta?: { runId?: string }): void => {
        if (meta?.runId && !activeRunId) activeRunId = meta.runId;
        // Override run_id on the raw frame so downstream reshape uses ours
        // instead of letta-code's `local-run-N` counter. Mobile uses this
        // to pair stream events with the /v1/runs/{id} record.
        if (activeRunId) {
          if (raw && typeof raw === "object") {
            const rRec = raw as Record<string, unknown>;
            if (rRec["event"] && typeof rRec["event"] === "object") {
              (rRec["event"] as Record<string, unknown>)["run_id"] = activeRunId;
            } else {
              rRec["run_id"] = activeRunId;
            }
          }
        }
        handleRawFrame(raw);
      };
      const turn = await worker.runTurn(text, {
        onFrame: handleRawFrameWithRun,
        onRunCreated: (id: string) => {
          activeRunId = id;
        },
        turnStartedAt,
      });
      stderrBuf = turn?.stderr ?? "";
      // Bind the mobile-supplied otid to the user_message letta-code just
      // persisted. Mobile's reconcileAfterSend looks up `it.otid == cm-...`
      // on the server-fetched user message; without this mapping it finds
      // none, leaves the Local in place, and the disk-fetched copy
      // ALSO appears — user sees two prompt bubbles.
      if (userOtid) {
        try {
          const localId = await findUnmappedTailUserMessageId(
            conversationId ?? "default",
            agentId,
          );
          if (localId) {
            await writeOtidForLocalId(conversationId ?? "default", agentId, localId, userOtid);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[chat] otid bind failed: ${msg}`);
        }
      }
      finalizeResponse({
        exitCode: turn?.dead || turn?.exit ? (turn.code ?? 1) : 0,
        stderrTail: stderrBuf,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.writableEnded) {
        if (wantStream) {
          res.write(
            sseDataFrame({
              message_type: "stop_reason",
              stop_reason: "error",
              error: msg,
            }),
          );
          res.write(sseDoneFrame());
          res.end();
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: `pool dispatch failed: ${msg}` }));
        }
      }
    }
    return;
  }

  // Legacy per-request spawn path — enabled with SHIM_POOL_DISABLE=1.
  const { spawn } = await import("node:child_process");
  const args = buildLettaArgs(agentId, conversationId, text, { stream: wantStream });
  const child = spawn(process.env["LETTA_BIN"] || "letta", args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    for (;;) {
      const idx = stdoutBuf.indexOf("\n");
      if (idx < 0) break;
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        handleRawFrame(JSON.parse(line));
      } catch {
        /* swallow malformed lines */
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });
  child.on("close", (code: number | null) =>
    finalizeResponse({ exitCode: code, stderrTail: stderrBuf }),
  );
  req.on("close", () => {
    try {
      if (!child.killed) child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  });
}
