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

import { getAgentPool } from "./agent-pool.mjs";
import { findUnmappedTailUserMessageId, writeOtidForLocalId } from "./store.js";

const POOL_ENABLED = process.env.SHIM_POOL_DISABLE !== "1";

function extractUserOtid(body) {
  // Mobile sends `{ messages: [{role:"user", content:"...", otid:"cm-..."}], ...}`.
  // Pull the first user-role otid; that's the bubble we need to reconcile.
  // Falls back to `body.otid` for legacy callers and `null` for clients
  // that don't supply one (curl, our smoke test).
  if (!body) return null;
  const messages = body.messages ?? body.message;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (m && typeof m === "object" && (m.role === "user" || !m.role) && typeof m.otid === "string" && m.otid) {
        return m.otid;
      }
    }
  }
  if (typeof body.otid === "string" && body.otid) return body.otid;
  return null;
}

function extractText(body) {
  // Mobile sends MessageCreateRequest with either:
  //   { messages: [{role:"user", content:"..."}], ... }
  //   { messages: [{role:"user", content:[{type:"text",text:"..."}]}], ... }
  //   { input: "raw text", ... }
  //   { text: "..." }  (legacy)
  if (!body) return "";
  if (typeof body === "string") return body;
  if (typeof body.input === "string") return body.input;
  if (typeof body.text === "string") return body.text;
  const messages = body.messages ?? body.message;
  if (Array.isArray(messages)) {
    return messages
      .map((m) => {
        if (typeof m === "string") return m;
        if (typeof m?.content === "string") return m.content;
        if (Array.isArray(m?.content)) {
          return m.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
        }
        return "";
      })
      .join("\n");
  }
  if (typeof messages === "string") return messages;
  return "";
}

function sseDataFrame(payload) {
  // Mobile's SseParser only reads `data:` lines. Skip the `event:` line.
  // Every payload must have `message_type` at the top level or it's treated
  // as a heartbeat. End with a blank line.
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function sseDoneFrame() {
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
function tagAsOptimistic(frame) {
  if (!frame || typeof frame.id !== "string") return frame;
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

function partsToText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p?.type === "text")
    .map((p) => p.text || "")
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
function isoNow() { return new Date().toISOString(); }

export function reshapeFrame(raw) {
  if (!raw || typeof raw !== "object") return null;
  let f = raw;

  if (raw.type === "stream_event" && raw.event) {
    // The wall-clock `timestamp` lives on the OUTER stream_event frame;
    // the inner event only carries the sentinel `date`. Forward the outer
    // timestamp onto the inner so downstream code picks it up.
    f = { ...raw.event, timestamp: raw.event.timestamp ?? raw.timestamp };
  } else if (raw.type === "system") return null;
  else if (raw.type === "result") return null;

  const mt = f.message_type;
  if (!mt) return null;

  // Bare-envelope frames — vanilla emits these without the id/date/otid
  // boilerplate. Match that exactly so mobile's parser sees the right shape.
  if (mt === "stop_reason") {
    return { message_type: "stop_reason", stop_reason: f.stop_reason ?? "end_turn" };
  }
  if (mt === "usage_statistics") {
    return {
      message_type: "usage_statistics",
      completion_tokens: f.completion_tokens ?? 0,
      prompt_tokens: f.prompt_tokens ?? 0,
      total_tokens: f.total_tokens ?? 0,
      step_count: 1,
      run_ids: null,
      cached_input_tokens: f.cached_input_tokens ?? 0,
      cache_write_tokens: f.cache_write_tokens ?? 0,
      reasoning_tokens: f.reasoning_tokens ?? 0,
      context_tokens: f.context_tokens ?? f.total_tokens ?? 0,
    };
  }
  if (mt === "ping") {
    return {
      id: f.id ?? `ping-${Date.now()}`,
      date: f.date ?? f.timestamp ?? isoNow(),
      name: null,
      message_type: "ping",
      otid: null,
      sender_id: null,
      step_id: null,
      is_err: null,
      seq_id: null,
      run_id: f.run_id ?? null,
    };
  }

  // Content normalization: letta-code emits content as [{type:"text",text}]
  // for assistant/user; vanilla emits it as a string in conv-listed streams.
  let content = f.content;
  if (Array.isArray(content)) content = partsToText(content);

  const base = {
    id: f.id ?? f.uuid ?? `letta-msg-${Date.now()}`,
    // letta-code emits BOTH `timestamp` (real wall-clock) and `date`
    // (sentinel: Date.UTC(2026,0,1,0,0,seqIndex+1)). The sentinel encodes
    // message order, not time. Mobile and other clients sort by `date` —
    // if we pass the sentinel, every message lands on Jan 1, 2026 and
    // recently-arrived stream messages appear duplicated against
    // disk-fetched history. Prefer the real timestamp.
    date: f.timestamp ?? f.date ?? isoNow(),
    name: f.name ?? null,
    message_type: mt,
    otid: f.otid ?? null,
    sender_id: f.sender_id ?? null,
    step_id: f.step_id ?? null,
    is_err: f.is_err ?? null,
    seq_id: f.seq_id ?? null,
    run_id: f.run_id ?? null,
  };

  if (mt === "reasoning_message") {
    return {
      ...base,
      source: f.source ?? "reasoner_model",
      reasoning: typeof f.reasoning === "string" ? f.reasoning : (typeof content === "string" ? content : ""),
      signature: f.signature ?? null,
    };
  }
  if (mt === "assistant_message" || mt === "user_message" || mt === "system_message") {
    return { ...base, content: typeof content === "string" ? content : "" };
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
    const callId = f.tool_call?.tool_call_id ?? f.tool_calls?.[0]?.tool_call_id;
    return {
      ...base,
      id: callId ? `toolcall-${callId}` : base.id,
      message_type: "tool_call_message",
      tool_call: f.tool_call ?? null,
      tool_calls: f.tool_calls ?? (f.tool_call ? [f.tool_call] : null),
    };
  }
  if (mt === "tool_return_message") {
    // Same id-matching trick for tool returns.
    const callId = f.tool_call_id ?? f.tool_returns?.[0]?.tool_call_id;
    return {
      ...base,
      id: callId ? `toolreturn-${callId}` : base.id,
      tool_return: f.tool_return ?? null,
      status: f.status ?? "success",
      tool_call_id: callId ?? null,
      stdout: f.stdout ?? null,
      stderr: f.stderr ?? null,
      tool_returns: f.tool_returns ?? null,
    };
  }
  // Unknown message_type — pass through with minimal envelope.
  return { ...base, ...(typeof content === "string" ? { content } : {}) };
}

function makeOpeningPing(runId) {
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
export function coalesceAssistantFrames(frames) {
  const out = [];
  for (const f of frames) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.message_type === "assistant_message" &&
      f.message_type === "assistant_message" &&
      prev.otid &&
      prev.otid === f.otid
    ) {
      prev.content = (prev.content ?? "") + (f.content ?? "");
      prev.id = f.id; // keep the latest id
      prev.date = f.date;
      prev.seq_id = f.seq_id;
    } else {
      out.push({ ...f });
    }
  }
  return out;
}

// Legacy per-request spawn arg builder, kept for the POOL_DISABLE fallback.
function buildLettaArgs(agentId, conversationId, text, { stream } = {}) {
  let scope;
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

export async function handleSendMessage(req, res, agentId, { conversationId: explicitConv } = {}) {
  // Read body
  const buf = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  let body = {};
  try {
    body = JSON.parse(buf.toString("utf8") || "{}");
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ detail: `bad json: ${err.message}` }));
  }

  const text = extractText(body);
  if (!text) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ detail: "missing user text" }));
  }
  const conversationId =
    explicitConv ??
    body.conversation_id ??
    body.conversationId ??
    undefined;
  // Mobile uses `streaming` (and `stream_tokens`); legacy uses `stream`.
  // Default to streaming when caller didn't specify.
  const wantStream =
    body.streaming === true ||
    body.stream_tokens === true ||
    (body.streaming === undefined &&
     body.stream_tokens === undefined &&
     body.stream !== false);

  const frames = []; // collected for non-streaming + final result
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
  const TYPE_OFFSET = {
    user_message: 0,
    ping: 0,
    reasoning_message: 10,
    tool_call_message: 20,
    tool_return_message: 30,
    assistant_message: 40,
  };
  const stampStreamDate = (frame) => {
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
  let pendingStop = null;
  let pendingUsage = null;
  let pendingAssistant = null; // { ...base, content: "running concat" }
  const flushPendingAssistant = () => {
    if (pendingAssistant && wantStream && !res.writableEnded) {
      res.write(sseDataFrame(stampStreamDate(tagAsOptimistic(pendingAssistant))));
    }
    pendingAssistant = null;
  };
  const flushTail = () => {
    flushPendingAssistant();
    if (pendingStop && wantStream && !res.writableEnded) res.write(sseDataFrame(pendingStop));
    if (pendingUsage && wantStream && !res.writableEnded) res.write(sseDataFrame(pendingUsage));
    pendingStop = null;
    pendingUsage = null;
  };

  const handleRawFrame = (raw) => {
    const reshaped = reshapeFrame(raw);
    if (!reshaped) return;
    frames.push(reshaped);
    if (!wantStream) return;
    if (res.writableEnded) return;

    if (reshaped.message_type === "stop_reason") {
      pendingStop = reshaped;
      return;
    }
    if (reshaped.message_type === "usage_statistics") {
      pendingUsage = reshaped;
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

  const finalizeResponse = ({ exitCode = 0, stderrTail = "" } = {}) => {
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
    const stop = coalesced.find((f) => f.message_type === "stop_reason");
    const usageFrame = coalesced.find((f) => f.message_type === "usage_statistics");

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
      let activeRunId = null;
      const handleRawFrameWithRun = (raw, meta) => {
        if (meta?.runId && !activeRunId) activeRunId = meta.runId;
        // Override run_id on the raw frame so downstream reshape uses ours
        // instead of letta-code's `local-run-N` counter. Mobile uses this
        // to pair stream events with the /v1/runs/{id} record.
        if (activeRunId) {
          if (raw && typeof raw === "object" && raw.event && typeof raw.event === "object") {
            raw.event.run_id = activeRunId;
          } else if (raw && typeof raw === "object") {
            raw.run_id = activeRunId;
          }
        }
        handleRawFrame(raw);
      };
      const turn = await worker.runTurn(text, {
        onFrame: handleRawFrameWithRun,
        onRunCreated: (id) => { activeRunId = id; },
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
          const localId = findUnmappedTailUserMessageId(
            conversationId ?? "default",
            agentId,
          );
          if (localId) {
            writeOtidForLocalId(conversationId ?? "default", agentId, localId, userOtid);
          }
        } catch (err) {
          console.error(`[chat] otid bind failed: ${err.message}`);
        }
      }
      finalizeResponse({
        exitCode: turn?.dead || turn?.exit ? (turn.code ?? 1) : 0,
        stderrTail: stderrBuf,
      });
    } catch (err) {
      if (!res.writableEnded) {
        if (wantStream) {
          res.write(sseDataFrame({ message_type: "stop_reason", stop_reason: "error", error: err.message }));
          res.write(sseDoneFrame());
          res.end();
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: `pool dispatch failed: ${err.message}` }));
        }
      }
    }
    return;
  }

  // Legacy per-request spawn path — enabled with SHIM_POOL_DISABLE=1.
  const { spawn } = await import("node:child_process");
  const args = buildLettaArgs(agentId, conversationId, text, { stream: wantStream });
  const child = spawn(process.env.LETTA_BIN || "letta", args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    for (;;) {
      const idx = stdoutBuf.indexOf("\n");
      if (idx < 0) break;
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try { handleRawFrame(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });
  child.on("close", (code) => finalizeResponse({ exitCode: code, stderrTail: stderrBuf }));
  req.on("close", () => { try { if (!child.killed) child.kill("SIGTERM"); } catch {} });
}
