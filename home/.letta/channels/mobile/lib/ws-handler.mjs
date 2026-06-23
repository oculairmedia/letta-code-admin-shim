/**
 * WS frame handler for one connected mobile device.
 *
 * Lifecycle:
 *   1. Server accepts WS upgrade, hands the socket to handleConnection().
 *   2. We read the first frame, expect `hello`, validate the token.
 *   3. Reply `welcome` (or `error` then close).
 *   4. Process frames in a loop:
 *        - send_message → dispatch (via the host-provided sendMessage handler)
 *        - ack          → log/observability
 *        - pong         → mark alive
 *        - bye          → close
 *   5. Server-side: periodic `ping` frame to keep the connection healthy.
 *   6. On socket close: stop the ping timer, release resources.
 *
 * `host` is provided by the channel-plugin loader and exposes:
 *   - getToken(): string                 — the currently accepted token
 *   - getServerId(): string              — for the welcome frame
 *   - sendMessage(req, onFrame): Promise — process a send_message and
 *       stream frames via onFrame (turn_started, assistant_message,
 *       stop_reason, usage_statistics).
 *   - log(...args): void
 */

import { randomUUID } from "node:crypto";
import {
  ERROR_CODES,
  makeFrame,
  parseFrame,
  PROTOCOL_VERSION,
  ProtocolError,
} from "./protocol.mjs";
import { recordDeviceConnect } from "./state.mjs";

const MOBILE_TRANSPORT_CONTRACT = Object.freeze({
  mobile_ws: true,
  ws_endpoint: "/shim/v1/mobile",
  canonical_live_transport: "ws",
  rest_role: "cold_start_reconcile_repair",
  sse_role: "legacy_non_canonical_for_mobile_ws_sessions",
  exclusivity: "after_ws_welcome_do_not_consume_sse_for_owned_conversations",
  keepalive: {
    protocol: "ws_ping_pong",
    client_ping_supported: true,
    server_ping_interval_ms: 30_000,
    server_pong_timeout_ms: 10_000,
    timeout_close_code: 4001,
  },
});

function safeSend(ws, frame, log) {
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    log?.(`send failed: ${err.message}`);
  }
}

function timingSafeEqualHexish(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function handleConnection(ws, request, host) {
  const log = (msg) => host.log(`[mobile:ws] ${msg}`);
  const sessionId = `sess-${randomUUID()}`;
  let device = null; // { device_id, ... } once authed
  let helloSeen = false;
  let closed = false;
  let pingTimer = null;
  let idleTimer = null;
  let a2uiCapability = null;
  let lastRoutableRunId = null;
  let lastClientAgentId = null;
  let lastClientConversationId = null;
  // Single-flight per session: a second send_message arriving while the
  // first is still streaming is rejected with PROTOCOL_VIOLATION. Cancel
  // is the only way to abort an in-flight turn over the same socket.
  let inFlight = false;
  // NOTE: an implicit "currentRunId" was previously tracked here so cancel
  // could fall back to the in-flight run without an explicit id (lcp-bll).
  // The contract now requires clients to send run_id explicitly, so the
  // tracking is gone. activeRunId (below, scoped per-turn) carries the
  // run-tracking state that other code still needs.

  const safeClose = (code, reason) => {
    try {
      ws.close(code, reason);
    } catch (err) {
      log(`close failed session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const safeUnsubscribe = (label, unsubscribe) => {
    try {
      unsubscribe();
    } catch (err) {
      log(`${label} unsubscribe failed session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(`idle timeout — closing ${sessionId}`);
      safeClose(1000, "idle timeout");
    }, host.config?.idleTimeoutMs ?? 120_000);
    if (idleTimer.unref) idleTimer.unref();
  };

  const touchAdapterForLiveness = () => {
    // lcp-rfb/lcp-fwo: any inbound app frame OR protocol-level WS keepalive
    // proves the mobile client is still present. Keep both this socket's idle
    // timer and the backing SDK adapter's lastUsedAt fresh while connected.
    if (helloSeen && lastClientConversationId && lastClientAgentId && typeof host.touchAdapter === "function") {
      try {
        host.touchAdapter(lastClientConversationId, lastClientAgentId);
      } catch (err) {
        log?.warn?.(`[mobile-ws] touchAdapter failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const startPings = () => {
    const interval = host.config?.pingIntervalMs ?? 25_000;
    pingTimer = setInterval(() => {
      if (closed) return;
      safeSend(ws, makeFrame("ping"), log);
    }, interval);
    if (pingTimer.unref) pingTimer.unref();
  };

  // lcp-p74.2: track active subscribeToRun handles so they're released when
  // the WS closes (or the client subscribes to the same run again).
  const activeSubscriptions = new Map(); // key: run_id, value: { unsubscribe }
  // lcp-convpush: persistent conversation subscriptions receive every stamped
  // conversation frame, including out-of-band cron/background turns that this
  // socket did not initiate and therefore cannot subscribe to by run_id.
  const activeConversationSubscriptions = new Map(); // key: conversation_id, value: { unsubscribe }
  // lcp-2gx: per-socket subscription to crons_updated push events.
  let cronEventsUnsubscribe = null;
  let agentEventsUnsubscribe = null;
  let goalEventsUnsubscribe = null;
  // lcp-indw: per-socket subscription to approval_resolved push events.
  let approvalEventsUnsubscribe = null;
  // lcp-4d5f: per-socket subscription to reflection_settings_updated push.
  let reflectionEventsUnsubscribe = null;
  // letta-mobile-73o2h.1: per-socket subscription to subagents_updated push.
  let subagentEventsUnsubscribe = null;
  // lcp-cq7x: per-socket registration for server-originated channel pushes.
  // Installed only after hello auth succeeds so outbound sendMessage never
  // targets unauthenticated sockets.
  let pushClientUnregister = null;

  // lcp-p74.3: stopAll DELIBERATELY does not cancel the in-flight worker.
  // A mobile WS drop must NOT terminate the agent turn — the worker keeps
  // running until its own completion or the explicit user-initiated cancel
  // frame. Mobile can later subscribe(run_id, cursor) to resume from the
  // persisted frame log (frames.jsonl). The only WS-scoped resources we
  // clean up here are timers and the active subscriptions opened by THIS
  // socket. Idle worker eviction lives in agent-pool's housekeep loop
  // (SHIM_POOL_IDLE_SEC, default 300s) and runs entirely on its own clock.
  const stopAll = () => {
    closed = true;
    if (pingTimer) clearInterval(pingTimer);
    if (idleTimer) clearTimeout(idleTimer);
    for (const sub of activeSubscriptions.values()) {
      safeUnsubscribe("run subscription", () => sub.unsubscribe());
    }
    activeSubscriptions.clear();
    for (const sub of activeConversationSubscriptions.values()) {
      safeUnsubscribe("conversation subscription", () => sub.unsubscribe());
    }
    activeConversationSubscriptions.clear();
    if (cronEventsUnsubscribe) {
      safeUnsubscribe("cron events", cronEventsUnsubscribe);
      cronEventsUnsubscribe = null;
    }
    if (agentEventsUnsubscribe) {
      safeUnsubscribe("agent events", agentEventsUnsubscribe);
      agentEventsUnsubscribe = null;
    }
    if (goalEventsUnsubscribe) {
      safeUnsubscribe("goal events", goalEventsUnsubscribe);
      goalEventsUnsubscribe = null;
    }
    if (approvalEventsUnsubscribe) {
      safeUnsubscribe("approval events", approvalEventsUnsubscribe);
      approvalEventsUnsubscribe = null;
    }
    if (reflectionEventsUnsubscribe) {
      safeUnsubscribe("reflection events", reflectionEventsUnsubscribe);
      reflectionEventsUnsubscribe = null;
    }
    if (subagentEventsUnsubscribe) {
      safeUnsubscribe("subagent events", subagentEventsUnsubscribe);
      subagentEventsUnsubscribe = null;
    }
    if (pushClientUnregister) {
      safeUnsubscribe("push client", pushClientUnregister);
      pushClientUnregister = null;
    }
  };

  const sendError = (code, message, { close = true } = {}) => {
    safeSend(ws, makeFrame("error", { code, message }), log);
    if (close) {
      safeClose(4000, code);
    }
  };

  const mobileTransportContract = () => ({
    ...MOBILE_TRANSPORT_CONTRACT,
    ...(typeof host.mobileConversationCursorCapabilities === "function"
      ? host.mobileConversationCursorCapabilities()
      : {}),
  });

  const stampConversationFrame = (conversationId, frame) => {
    if (typeof conversationId === "string" && conversationId.length > 0 && typeof host.stampConversationFrame === "function") {
      return host.stampConversationFrame(conversationId, frame);
    }
    return frame;
  };

  const sendConversationFrame = (conversationId, type, fields = {}) => {
    const frame = stampConversationFrame(conversationId, makeFrame(type, fields));
    safeSend(ws, frame, log);
    return frame;
  };

  const normalizeCursorSeq = (value) => {
    const n = typeof value === "number" ? value : Number(value ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  const isResumeResult = (value) => value
    && typeof value === "object"
    && typeof value.cursorExpired === "boolean"
    && typeof value.conversationId === "string"
    && typeof value.afterSeq === "number"
    && (typeof value.oldestSeq === "number" || value.oldestSeq === null)
    && typeof value.lastSeq === "number"
    && Array.isArray(value.frames);

  const emitConversationResume = (conversationId, afterSeq) => {
    if (typeof host.resumeConversation !== "function") {
      sendError(ERROR_CODES.INTERNAL, "conversation resume handler not wired", { close: false });
      return;
    }
    let result;
    try {
      result = host.resumeConversation(conversationId, normalizeCursorSeq(afterSeq));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`conversation resume failed conversation=${conversationId}: ${msg}`);
      sendError(ERROR_CODES.INTERNAL, "conversation resume failed", { close: false });
      return;
    }
    if (!isResumeResult(result)) {
      log(`conversation resume returned invalid result conversation=${conversationId}`);
      sendError(ERROR_CODES.INTERNAL, "conversation resume returned invalid result", { close: false });
      return;
    }
    if (result.cursorExpired) {
      safeSend(ws, makeFrame("error", {
        code: ERROR_CODES.CURSOR_EXPIRED,
        message: `conversation cursor expired for ${conversationId}`,
        conversation_id: conversationId,
        after_seq: result.afterSeq,
        oldest_seq: result.oldestSeq,
        last_seq: result.lastSeq,
      }), log);
      return;
    }
    for (const replayFrame of result.frames) {
      safeSend(ws, replayFrame, log);
    }
    safeSend(ws, makeFrame("conversation_resume_done", {
      conversation_id: conversationId,
      after_seq: result.afterSeq,
      last_seq: result.lastSeq,
      replayed: result.frames.length,
    }), log);
  };

  const deriveTurnOutcome = (turnResult, observedStopReason) => {
    const status = turnResult?.cancelled
      ? "cancelled"
      : (turnResult?.exit || turnResult?.timeout || turnResult?.dead || observedStopReason === "error")
        ? "failed"
        : "completed";
    if (status !== "failed") {
      return { status, errorCode: null, errorMessage: null };
    }
    const errorMessage = turnResult?.error
      ?? (turnResult?.timeout
        ? "turn timed out"
        : turnResult?.exit
          ? `worker exited before completing the turn${turnResult?.code == null ? "" : ` (code ${turnResult.code})`}`
          : turnResult?.dead
            ? "worker died before completing the turn"
            : observedStopReason === "error"
              ? "upstream reported stop_reason=error"
              : "turn failed");
    return { status, errorCode: ERROR_CODES.INTERNAL, errorMessage };
  };

  const sendUserActionOutcome = (frameId, outcome, detail = {}) => {
    safeSend(ws, makeFrame("user_action_outcome", {
      frame_id: typeof frameId === "string" && frameId.length > 0 ? frameId : null,
      ...(typeof detail.action_id === "string" ? { action_id: detail.action_id } : {}),
      outcome,
      detail,
    }), log);
  };

  const dispatchSyntheticTurn = async ({ agent_id, conversation_id, text }, outcomeMeta = {}) => {
    if (inFlight) {
      sendUserActionOutcome(outcomeMeta.frame_id, "rejected", {
        action_id: outcomeMeta.action_id,
        reason: "another send_message is in flight on this session",
      });
      sendError(
        ERROR_CODES.PROTOCOL_VIOLATION,
        "another send_message is in flight on this session",
        { close: false },
      );
      return;
    }
    inFlight = true;
    const turnId = `turn-${randomUUID()}`;
    let activeRunId = null;
    let turnStartedEmitted = false;
    let outcomeEmitted = false;
    let droppedFrameCount = 0;
    let observedStopReason = null;
    let terminalErrorFrameSent = false;
    const sendTerminalError = (message) => {
      if (terminalErrorFrameSent || closed) return;
      terminalErrorFrameSent = true;
      safeSend(ws, makeFrame("error", {
        code: ERROR_CODES.INTERNAL,
        message,
        turn_id: turnId,
        run_id: activeRunId ?? null,
        source: "a2ui_user_action",
      }), log);
    };
    const emitInjectedOutcome = () => {
      if (outcomeEmitted) return;
      outcomeEmitted = true;
      sendUserActionOutcome(outcomeMeta.frame_id, "injected_as_input", {
        action_id: outcomeMeta.action_id,
        routed_as: "synthetic_input",
        synthetic_turn_id: turnId,
        run_id: activeRunId ?? null,
      });
    };
    const emitTurnStarted = () => {
      if (turnStartedEmitted || closed) return;
      turnStartedEmitted = true;
          sendConversationFrame(conversation_id, "turn_started", {
            agent_id,
            conversation_id,
            turn_id: turnId,
            run_id: activeRunId ?? null,
            source: "a2ui_user_action",
          });
      emitInjectedOutcome();
    };
    try {
      const turnResult = await host.sendMessage(
        { agent_id, conversation_id, text, otid: null, turn_id: turnId, session_id: sessionId, a2ui_capability: null },
        (outFrame) => {
          if (closed) return;
          const mt = outFrame.message_type;
          const runId = outFrame.run_id ?? activeRunId;
          if (runId && !activeRunId) {
            activeRunId = runId;
            lastRoutableRunId = runId;
          }
          // lcp-p74.2: seq is the per-run frame-log cursor stamped by the
          // host's emit(). Propagate to wire envelopes so live clients track
          // it in lockstep with what subscribe(run_id, cursor) would replay.
          const seq = typeof outFrame.seq === "number" ? outFrame.seq : null;
          // lcp-wqy: forward the reshaped frame's `date` so mobile renders
          // a real timestamp instead of the CLI's sentinel epoch (Jan 1).
          const base = { agent_id, conversation_id, turn_id: turnId, run_id: runId ?? null, seq, date: outFrame.date ?? new Date().toISOString() };
          const HIGH_WATER = host.config?.bufferHighWaterBytes ?? 1_000_000;
          if (ws.bufferedAmount > HIGH_WATER) {
            droppedFrameCount += 1;
            log(`backpressure: bufferedAmount=${ws.bufferedAmount} > ${HIGH_WATER}, dropping ${mt} (turn=${turnId} dropped=${droppedFrameCount})`);
            return;
          }
          const upstreamId = typeof outFrame.id === "string" && outFrame.id.length > 0 ? outFrame.id : undefined;
          // lcp-pro: also expose `seq` as `seq_id` on delta-shaped frames so the
          // mobile client's existing `hasAlreadyIngestedStreamFrame` gate (which
          // dedups by `seqId`) starts firing without a mobile-side change. Without
          // this the gate is dead code on the WS path (upstream `seq_id` is null
          // on stream chunks per the post-cv3 pure-delta contract) and duplicate
          // deltas — from reconnect replay or WS-vs-REST race — silently
          // double-append, producing the "Hello worldHello world" incoherence
          // reported 2026-05-19. Only stamped on assistant_message and
          // reasoning_message; other frame types don't participate in the merge.
          if (mt === "assistant_message") {
            sendConversationFrame(conversation_id, "assistant_message", { ...base, ...(upstreamId ? { id: upstreamId } : {}), seq_id: seq, content: outFrame.content ?? "", otid: outFrame.otid ?? null });
          } else if (mt === "reasoning_message") {
            sendConversationFrame(conversation_id, "reasoning_message", { ...base, ...(upstreamId ? { id: upstreamId } : {}), seq_id: seq, reasoning: outFrame.reasoning ?? "", signature: outFrame.signature ?? null });
          } else if (mt === "tool_call_message") {
            sendConversationFrame(conversation_id, "tool_call_message", { ...base, ...(upstreamId ? { id: upstreamId } : {}), tool_call: outFrame.tool_call ?? null, tool_calls: outFrame.tool_calls ?? null });
          } else if (mt === "tool_return_message") {
            sendConversationFrame(conversation_id, "tool_return_message", { ...base, ...(upstreamId ? { id: upstreamId } : {}), tool_call_id: outFrame.tool_call_id ?? null, status: outFrame.status ?? "success", tool_return: outFrame.tool_return ?? null, stdout: outFrame.stdout ?? null, stderr: outFrame.stderr ?? null });
          } else if (mt === "stop_reason") {
            const stopReason = outFrame.stop_reason ?? "end_turn";
            if (observedStopReason === null) observedStopReason = stopReason;
            if (stopReason === "error") sendTerminalError("upstream reported stop_reason=error");
            sendConversationFrame(conversation_id, "stop_reason", { agent_id, conversation_id, turn_id: turnId, run_id: runId ?? null, seq, stop_reason: stopReason });
          } else if (mt === "usage_statistics") {
            sendConversationFrame(conversation_id, "usage_statistics", { agent_id, conversation_id, turn_id: turnId, run_id: runId ?? null, seq, prompt_tokens: outFrame.prompt_tokens, completion_tokens: outFrame.completion_tokens, total_tokens: outFrame.total_tokens, cached_input_tokens: outFrame.cached_input_tokens, reasoning_tokens: outFrame.reasoning_tokens });
          } else if (mt === "a2ui_frame") {
            sendConversationFrame(conversation_id, "a2ui_frame", { agent_id, conversation_id, turn_id: turnId, run_id: runId ?? null, seq, otid: outFrame.otid ?? null, ok: outFrame.ok !== false, a2ui: outFrame.a2ui ?? null, ...(outFrame.parse_error ? { parse_error: outFrame.parse_error } : {}), ...(outFrame.validation_error ? { validation_error: outFrame.validation_error } : {}) });
          }
        },
        {
          onRunCreated: (id) => {
            activeRunId = id;
            lastRoutableRunId = id;
            emitTurnStarted();
          },
        },
      );
      emitTurnStarted();
      if (!closed) {
        const { status, errorCode, errorMessage } = deriveTurnOutcome(turnResult, observedStopReason);
        if (status === "failed" && errorMessage) sendTerminalError(errorMessage);
        sendConversationFrame(conversation_id, "turn_done", {
          agent_id,
          conversation_id,
          turn_id: turnId,
          run_id: activeRunId ?? null,
          status,
          lossy: droppedFrameCount > 0,
          drop_count: droppedFrameCount,
          error_code: errorCode,
          error_message: errorMessage,
          source: "a2ui_user_action",
        });
      }
    } catch (err) {
      log(`a2ui synthetic action turn failed: ${err.stack ?? err.message}`);
      if (!outcomeEmitted) {
        sendUserActionOutcome(outcomeMeta.frame_id, "error", {
          action_id: outcomeMeta.action_id,
          reason: err.message ?? "send failed",
          error_code: ERROR_CODES.INTERNAL,
        });
      }
      if (!closed) {
        safeSend(ws, makeFrame("error", { code: ERROR_CODES.INTERNAL, message: err.message ?? "send failed", turn_id: turnId, run_id: activeRunId ?? null }), log);
        sendConversationFrame(conversation_id, "turn_done", { agent_id, conversation_id, turn_id: turnId, run_id: activeRunId ?? null, status: "failed", lossy: droppedFrameCount > 0, drop_count: droppedFrameCount, error_code: ERROR_CODES.INTERNAL, error_message: err.message ?? "send failed", source: "a2ui_user_action" });
      }
    } finally {
      inFlight = false;
    }
  };

  ws.on("message", async (raw) => {
    resetIdle();
    touchAdapterForLiveness();
    const frame = parseFrame(raw.toString("utf8"));
    if (!frame) {
      sendError(ERROR_CODES.PROTOCOL_VIOLATION, "unparseable frame");
      return;
    }
    if (typeof frame.v !== "number" || frame.v > PROTOCOL_VERSION + 0) {
      // We accept v=1 frames. Future versions are forward-compat noise.
      // Drop with no error.
    }

    if (!helloSeen) {
      if (frame.type !== "hello") {
        sendError(ERROR_CODES.PROTOCOL_VIOLATION, "hello must be first frame");
        return;
      }
      const expected = host.getToken();
      // Mirror REST permissiveness on this dev box: when no token is
      // configured (env unset and tokenFallback is empty), any token in
      // the hello frame is accepted. Set MOBILE_CHANNEL_TOKEN or restore
      // tokenFallback in accounts.json to re-enable strict matching.
      if (typeof expected === "string" && expected.length > 0) {
        if (!timingSafeEqualHexish(frame.token ?? "", expected)) {
          log(`auth failed for device=${frame.device_id ?? "?"}`);
          sendError(ERROR_CODES.INVALID_TOKEN, "invalid token");
          return;
        }
      } else {
        log(`auth skipped (no token configured) for device=${frame.device_id ?? "?"}`);
      }
      const deviceId = frame.device_id || `anon-${randomUUID()}`;
      const serverA2ui = typeof host.getA2uiServerCapabilities === "function"
        ? host.getA2uiServerCapabilities()
        : { enabled: false };
      let a2uiRejectionReason = null;
      if (frame.a2ui_version) {
        const supportedCatalogs = Array.isArray(frame.supported_catalogs) ? frame.supported_catalogs.filter((v) => typeof v === "string") : [];
        const supportedWidgets = Array.isArray(frame.supported_widgets) ? frame.supported_widgets.filter((v) => typeof v === "string") : [];
        const versionMatches = typeof frame.a2ui_version === "string" && frame.a2ui_version === serverA2ui.version;
        const catalogId = typeof serverA2ui.catalogId === "string" ? serverA2ui.catalogId : "basic";
        const catalogMatches = supportedCatalogs.length === 0 || supportedCatalogs.includes(catalogId);
        if (serverA2ui.enabled && versionMatches && catalogMatches) {
          const serverWidgets = Array.isArray(serverA2ui.supportedWidgets) ? serverA2ui.supportedWidgets.filter((v) => typeof v === "string") : [];
          const serverWidgetSet = new Set(serverWidgets);
          const negotiatedWidgets = supportedWidgets.filter((widget) => serverWidgetSet.has(widget));
          let themeHints = null;
          if (frame.theme_hints && typeof frame.theme_hints === "object" && !Array.isArray(frame.theme_hints)) {
            themeHints = { ...frame.theme_hints };
            if (themeHints.primaryColor !== undefined && (typeof themeHints.primaryColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(themeHints.primaryColor))) {
              log("a2ui theme_hints.primaryColor ignored: expected ^#[0-9a-fA-F]{6}$");
              delete themeHints.primaryColor;
            }
            if (Object.keys(themeHints).length === 0) themeHints = null;
          }
          a2uiCapability = {
            version: frame.a2ui_version,
            catalogId,
            supportedCatalogs: supportedCatalogs.length > 0 ? supportedCatalogs : [catalogId],
            supportedWidgets: negotiatedWidgets.length > 0 ? negotiatedWidgets : serverWidgets,
            ...(themeHints ? { themeHints } : {}),
          };
          log(`a2ui negotiated: version=${frame.a2ui_version} catalog=${catalogId} widgets=[${a2uiCapability.supportedWidgets.join(",")}]`);
        } else {
          if (!serverA2ui.enabled) a2uiRejectionReason = "disabled";
          else if (!versionMatches) a2uiRejectionReason = "version_mismatch";
          else if (!catalogMatches) a2uiRejectionReason = "catalog_mismatch";
          else a2uiRejectionReason = "unsupported";
          log(`a2ui rejected: serverEnabled=${serverA2ui.enabled} versionMatches=${versionMatches} (got=${frame.a2ui_version} want=${serverA2ui.version}) catalogMatches=${catalogMatches} (got=[${supportedCatalogs.join(",")}] want=${catalogId})`);
        }
      } else {
        log(`a2ui not requested: hello has no a2ui_version field (serverEnabled=${serverA2ui.enabled})`);
      }
      device = recordDeviceConnect({
        deviceId,
        token: frame.token,
        clientVersion: frame.client_version,
      });
      helloSeen = true;
      log(`hello accepted device=${deviceId} session=${sessionId}`);
      const transportContract = mobileTransportContract();
      safeSend(
        ws,
        makeFrame("welcome", {
          server_id: host.getServerId(),
          session_id: sessionId,
          device_id: deviceId,
          capabilities: {
            mobile_transport: transportContract,
          },
          canonical_live_transport: "ws",
          transport_contract: transportContract,
          a2ui_negotiated: Boolean(a2uiCapability),
          a2ui: a2uiCapability ? {
            version: a2uiCapability.version,
            catalog_id: a2uiCapability.catalogId,
          } : null,
          ...(a2uiRejectionReason ? { a2ui_rejection_reason: a2uiRejectionReason } : {}),
        }),
        log,
      );
      if (a2uiCapability) {
        safeSend(
          ws,
          makeFrame("a2ui_capabilities", {
            version: a2uiCapability.version,
            catalog_id: a2uiCapability.catalogId,
            supported_catalogs: serverA2ui.supportedCatalogs ?? [a2uiCapability.catalogId],
            supported_widgets: serverA2ui.supportedWidgets ?? [],
          }),
          log,
        );
      }
      const helloResume = frame.resume;
      if (helloResume && typeof helloResume === "object" && !Array.isArray(helloResume)) {
        const resumeConversationId = typeof helloResume.conversation_id === "string" ? helloResume.conversation_id : null;
        if (resumeConversationId) {
          emitConversationResume(resumeConversationId, helloResume.after_seq ?? helloResume.last_conv_seq ?? 0);
        }
      } else if (Array.isArray(helloResume)) {
        for (const item of helloResume) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const resumeConversationId = typeof item.conversation_id === "string" ? item.conversation_id : null;
          if (resumeConversationId) {
            emitConversationResume(resumeConversationId, item.after_seq ?? item.last_conv_seq ?? 0);
          }
        }
      }
      startPings();
      if (typeof host.registerPushClient === "function") {
        pushClientUnregister = host.registerPushClient({
          sessionId,
          deviceId,
          sendFrame: (outFrame) => {
            if (closed) return false;
            const cid = outFrame?.conversation_id ?? outFrame?.conversationId;
            if (typeof cid === "string" && !activeConversationSubscriptions.has(cid)) {
              return false;
            }
            safeSend(ws, outFrame, log);
            return true;
          },
        });
      }
      // lcp-2gx: subscribe to crons_updated push events for the lifetime of
      // this socket. Listener stays installed until stopAll() releases it.
      if (typeof host.subscribeCronEvents === "function") {
        cronEventsUnsubscribe = host.subscribeCronEvents((event) => {
          if (closed) return;
          safeSend(ws, makeFrame("crons_updated", {
            reason: event.reason,
            tasks_active: event.tasks_active,
            at: event.at,
          }), log);
        });
      }
      if (typeof host.subscribeAgentEvents === "function") {
        agentEventsUnsubscribe = host.subscribeAgentEvents((event) => {
          if (closed) return;
          safeSend(ws, makeFrame("agent_updated", {
            agent_id: event.agent_id,
            reason: event.reason,
            at: event.at,
            ...(event.version ? { version: event.version } : {}),
          }), log);
        });
      }
      if (typeof host.subscribeGoalEvents === "function") {
        goalEventsUnsubscribe = host.subscribeGoalEvents((event) => {
          if (closed) return;
          safeSend(ws, makeFrame("goals_updated", {
            reason: event.reason,
            at: event.at,
            status: event.status,
          }), log);
        });
      }
      // lcp-indw: subscribe to approval_resolved push events for the lifetime
      // of this socket so a SECOND connected client learns when the FIRST
      // client (or a REST caller) resolves a pending approval. Listener stays
      // installed until stopAll() releases it.
      if (typeof host.subscribeApprovalEvents === "function") {
        approvalEventsUnsubscribe = host.subscribeApprovalEvents((event) => {
          if (closed) return;
          safeSend(ws, makeFrame("approval_resolved", {
            run_id: event.run_id,
            tool_call_id: event.tool_call_id,
            status: event.status,
            decided_by: event.decided_by,
            at: event.at,
          }), log);
        });
      }
      // lcp-4d5f: subscribe to reflection_settings_updated push events so
      // peer clients see settings changes without polling.
      if (typeof host.subscribeReflectionEvents === "function") {
        reflectionEventsUnsubscribe = host.subscribeReflectionEvents((event) => {
          if (closed) return;
          safeSend(ws, makeFrame("reflection_settings_updated", {
            agent_id: event.agent_id,
            settings: event.settings,
            at: event.at,
          }), log);
        });
      }
      // letta-mobile-73o2h.1: subscribe to subagents_updated push events for
      // the lifetime of this socket so the active-subagent bar live-updates
      // as subagents start/finish without polling.
      if (typeof host.subscribeSubagentEvents === "function") {
        subagentEventsUnsubscribe = host.subscribeSubagentEvents((event) => {
          if (closed) return;
          // The event carries the single changed subagent + reason; include
          // the fresh active list so the bar can reduce by replacement.
          let subagentsActive = null;
          if (typeof host.handleSubagentList === "function") {
            try {
              subagentsActive = host.handleSubagentList({ all: false }).subagents;
            } catch { /* fall back to single-subagent delta */ }
          }
          safeSend(ws, makeFrame("subagents_updated", {
            reason: event.reason,
            subagents_active: subagentsActive,
            subagent: event.subagent ?? null,
            at: event.at,
          }), log);
        });
      }
      return;
    }

    switch (frame.type) {
      case "send_message": {
        const { agent_id, conversation_id, text, otid, content_parts } = frame;
        if (!agent_id || !conversation_id || typeof text !== "string") {
          sendError(
            ERROR_CODES.PROTOCOL_VIOLATION,
            "send_message requires agent_id, conversation_id, text",
            { close: false },
          );
          return;
        }
        lastClientAgentId = agent_id;
        lastClientConversationId = conversation_id;
        // lcp-dlj: validate optional content_parts. If supplied, it must
        // be an array; size-cap the JSON-encoded frame at 10MB to bound
        // memory pressure from oversized base64 images. Mobile is
        // expected to downsample first (≤1568px longest side, ≤2MB raw
        // per image, ≤4 images per send). The shim enforces the
        // size ceiling defensively.
        const SEND_MESSAGE_MAX_BYTES = 10 * 1024 * 1024;
        if (content_parts !== undefined && content_parts !== null) {
          if (!Array.isArray(content_parts)) {
            sendError(
              ERROR_CODES.PROTOCOL_VIOLATION,
              "content_parts must be an array when present",
              { close: false },
            );
            return;
          }
          // The raw inbound buffer is the cheapest size oracle: parseFrame
          // already produced `frame` from a string we captured at the top
          // of the message handler. Re-serialize content_parts to estimate
          // its on-wire size (worst-case parity with what mobile sent).
          let cpSize = 0;
          try { cpSize = Buffer.byteLength(JSON.stringify(content_parts), "utf8"); } catch {
            sendError(
              ERROR_CODES.PROTOCOL_VIOLATION,
              "content_parts is not JSON-serializable",
              { close: false },
            );
            return;
          }
          if (cpSize > SEND_MESSAGE_MAX_BYTES) {
            sendError(
              ERROR_CODES.PROTOCOL_VIOLATION,
              `content_parts exceeds ${SEND_MESSAGE_MAX_BYTES} bytes (${cpSize}); downsample images before send`,
              { close: false },
            );
            return;
          }
        }
        // Serialize sends per session — running two turns concurrently on
        // the same socket races state (pendingAssistant, run binding) and
        // tangles outbound frame order on the wire.
        if (inFlight) {
          sendError(
            ERROR_CODES.PROTOCOL_VIOLATION,
            "another send_message is in flight on this session",
            { close: false },
          );
          return;
        }
        inFlight = true;
        const turnId = `turn-${randomUUID()}`;
        // lcp-99a: turn_started now waits until host.sendMessage has fired
        // onRunCreated (which mobile-channel-host does synchronously before
        // any await). That guarantees run_id is non-null on turn_started,
        // closing the cancel-during-startup gap. The cost is a few-ms
        // delay before the "agent typing" indicator can flip — createRun
        // is a single atomic write.
        let activeRunId = null;
        let turnStartedEmitted = false;
        // lcp-srk: count backpressure drops within this turn so turn_done
        // can carry an authoritative lossy flag. Mobile reconciles iff
        // lossy === true; clean turns can skip the round-trip.
        let droppedFrameCount = 0;
        let observedStopReason = null;
        let terminalErrorFrameSent = false;
        const sendTerminalError = (message) => {
          if (terminalErrorFrameSent || closed) return;
          terminalErrorFrameSent = true;
          safeSend(ws, makeFrame("error", {
            code: ERROR_CODES.INTERNAL,
            message,
            turn_id: turnId,
            run_id: activeRunId ?? null,
          }), log);
        };
        const emitTurnStarted = () => {
          if (turnStartedEmitted || closed) return;
          turnStartedEmitted = true;
          sendConversationFrame(
            conversation_id,
            "turn_started",
            {
              agent_id,
              conversation_id,
              turn_id: turnId,
              run_id: activeRunId ?? null,
            },
          );
        };
        let turnResult = null;
        try {
          turnResult = await host.sendMessage(
            { agent_id, conversation_id, text, content_parts, otid, turn_id: turnId, session_id: sessionId, a2ui_capability: a2uiCapability },
            (outFrame) => {
              if (closed) return;
              const mt = outFrame.message_type;
              const runId = outFrame.run_id ?? activeRunId;
              if (runId && !activeRunId) {
                activeRunId = runId;
                lastRoutableRunId = runId;
              }
              // lcp-p74.2: see comment in send_message dispatch path.
              const seq = typeof outFrame.seq === "number" ? outFrame.seq : null;
              const base = {
                agent_id,
                conversation_id,
                turn_id: turnId,
                run_id: runId ?? null,
                seq,
                date: outFrame.date ?? new Date().toISOString(),
              };
              // Backpressure: if the socket can't drain frames fast enough,
              // pause emission. ws's bufferedAmount is the unsent byte count;
              // a slow consumer that lets this grow unbounded eats RAM.
              const HIGH_WATER = host.config?.bufferHighWaterBytes ?? 1_000_000;
              if (ws.bufferedAmount > HIGH_WATER) {
                droppedFrameCount += 1;
                log(`backpressure: bufferedAmount=${ws.bufferedAmount} > ${HIGH_WATER}, dropping ${mt} (turn=${turnId} dropped=${droppedFrameCount})`);
                return;
              }
              // lcp-cv3: pass the upstream id through to the envelope so
              // mobile's findByServerId can merge streamed chunks. For
              // assistant/reasoning the host now stamps `cm-stream-<otid>` /
              // `cm-reason-<otid>` so every chunk of the same logical
              // message shares an id. tool_call_message / tool_return_message
              // ids carry `toolcall-` / `toolreturn-` prefixes from the
              // upstream reshape — preserve them for mobile's distinctBy{id}
              // dedup. makeFrame's auto-generated random id was masking all
              // of these and made the stream look like one final chunk.
              const upstreamId = typeof outFrame.id === "string" && outFrame.id.length > 0
                ? outFrame.id
                : undefined;
              // lcp-pro: expose `seq` as `seq_id` on delta-shaped frames; see
              // matching comment in the upper send_message dispatch path.
              if (mt === "assistant_message") {
                sendConversationFrame(conversation_id, "assistant_message", {
                  ...base,
                  ...(upstreamId ? { id: upstreamId } : {}),
                  seq_id: seq,
                  content: outFrame.content ?? "",
                  otid: outFrame.otid ?? null,
                });
              } else if (mt === "reasoning_message") {
                sendConversationFrame(conversation_id, "reasoning_message", {
                  ...base,
                  ...(upstreamId ? { id: upstreamId } : {}),
                  seq_id: seq,
                  reasoning: outFrame.reasoning ?? "",
                  signature: outFrame.signature ?? null,
                });
              } else if (mt === "tool_call_message") {
                sendConversationFrame(conversation_id, "tool_call_message", {
                  ...base,
                  ...(upstreamId ? { id: upstreamId } : {}),
                  tool_call: outFrame.tool_call ?? null,
                  tool_calls: outFrame.tool_calls ?? null,
                });
              } else if (mt === "tool_return_message") {
                sendConversationFrame(conversation_id, "tool_return_message", {
                  ...base,
                  ...(upstreamId ? { id: upstreamId } : {}),
                  tool_call_id: outFrame.tool_call_id ?? null,
                  status: outFrame.status ?? "success",
                  tool_return: outFrame.tool_return ?? null,
                  stdout: outFrame.stdout ?? null,
                  stderr: outFrame.stderr ?? null,
                });
              } else if (mt === "stop_reason") {
                const stopReason = outFrame.stop_reason ?? "end_turn";
                if (observedStopReason === null) observedStopReason = stopReason;
                if (stopReason === "error") sendTerminalError("upstream reported stop_reason=error");
                sendConversationFrame(conversation_id, "stop_reason", {
                  agent_id,
                  conversation_id,
                  turn_id: turnId,
                  run_id: runId ?? null,
                  seq,
                  stop_reason: stopReason,
                });
              } else if (mt === "usage_statistics") {
                sendConversationFrame(conversation_id, "usage_statistics", {
                  agent_id,
                  conversation_id,
                  turn_id: turnId,
                  run_id: runId ?? null,
                  seq,
                  prompt_tokens: outFrame.prompt_tokens,
                  completion_tokens: outFrame.completion_tokens,
                  total_tokens: outFrame.total_tokens,
                  cached_input_tokens: outFrame.cached_input_tokens,
                  reasoning_tokens: outFrame.reasoning_tokens,
                });
              } else if (mt === "a2ui_frame") {
                // Phase 4: A2UI frame extracted from the assistant text
                // stream. Body carries the parsed A2UI v0.9 message (or
                // null + diagnostics when parse/validation failed). The
                // renderer applies the message to its surface state; the
                // shim doesn't track surface state itself.
                sendConversationFrame(conversation_id, "a2ui_frame", {
                  agent_id,
                  conversation_id,
                  turn_id: turnId,
                  run_id: runId ?? null,
                  seq,
                  otid: outFrame.otid ?? null,
                  ok: outFrame.ok !== false,
                  a2ui: outFrame.a2ui ?? null,
                  ...(outFrame.parse_error ? { parse_error: outFrame.parse_error } : {}),
                  ...(outFrame.validation_error ? { validation_error: outFrame.validation_error } : {}),
                });
              }
              // ping / unknown types: drop silently. Forward-compat rule.
            },
            {
              onRunCreated: (id) => {
                activeRunId = id;
                lastRoutableRunId = id;
                // lcp-99a: emit turn_started NOW (with the just-created
                // run_id). Subsequent frames in the onFrame closure rely
                // on turn_started having been sent first, so we sequence
                // it here on the synchronous tick where the run id lands.
                emitTurnStarted();
              },
            },
          );
          // Defensive: if onRunCreated never fired (e.g. host bug), still
          // emit turn_started so mobile doesn't stall. run_id will be null
          // in that pathological case, but the turn lifecycle stays intact.
          emitTurnStarted();
          // turn_done sentinel — emitted AFTER bridgeSendMessage settles,
          // which means stampNewMessages + writeOtidForLocalId have run.
          // Mobile can now safely GET /messages without racing the disk.
          //
          // Status derivation (lcp-axv + lcp-kfr): the turnResult carries
          // lifecycle flags from agent-pool. `cancelled` wins (cancel
          // intent is authoritative even if upstream produced a clean
          // result frame in the race). `exit` / `timeout` / `dead` mean
          // the worker died mid-turn → "failed". Otherwise "completed".
          //
          // lossy (lcp-srk): true iff any onFrame call dropped a frame
          // due to backpressure. Mobile reconciles iff lossy === true.
          if (!closed) {
            const { status, errorCode, errorMessage } = deriveTurnOutcome(turnResult, observedStopReason);
            if (status === "failed" && errorMessage) sendTerminalError(errorMessage);
            sendConversationFrame(conversation_id, "turn_done", {
              agent_id,
              conversation_id,
              turn_id: turnId,
              run_id: activeRunId ?? null,
              status,
              lossy: droppedFrameCount > 0,
              drop_count: droppedFrameCount,
              error_code: errorCode,
              error_message: errorMessage,
            });
          }
        } catch (err) {
          if (err instanceof ProtocolError) {
            sendError(err.code, err.message, { close: false });
            // Protocol-level error does NOT abort the in-flight turn (we
            // haven't started one yet on this branch in practice — the
            // validation above runs before host.sendMessage), so no
            // turn_done to emit.
          } else {
            log(`send_message failed: ${err.stack ?? err.message}`);
            // lcp-axv + lcp-gs2: emit error frame first (forward-compat
            // for consumers that still ingest standalone error frames),
            // then turn_done(status:failed) carrying the same code +
            // message inline so the failure is atomic-by-frame for
            // mobile dispatchers. Mobile MAY read either; turn_done's
            // own fields are now authoritative for terminal failures.
            const errCode = ERROR_CODES.INTERNAL;
            const errMessage = err.message ?? "send failed";
            if (!closed) {
              safeSend(ws, makeFrame("error", {
                code: errCode,
                message: errMessage,
                turn_id: turnId,
                run_id: activeRunId ?? null,
              }), log);
              sendConversationFrame(conversation_id, "turn_done", {
                agent_id,
                conversation_id,
                turn_id: turnId,
                run_id: activeRunId ?? null,
                status: "failed",
                lossy: droppedFrameCount > 0,
                drop_count: droppedFrameCount,
                error_code: errCode,
                error_message: errMessage,
              });
            }
          }
        } finally {
          inFlight = false;
        }
        break;
      }
      case "cancel": {
        // run_id is REQUIRED on cancel — the implicit fallback to the
        // current in-flight run is gone (lcp-bll). Clients should track
        // the active run_id from turn_started + post-turn_started frames
        // and pass it explicitly. Doc: admin-shim/docs/MOBILE_WS_PROTOCOL.md
        // §2.1 + §4.5.
        const targetRunId = frame.run_id;
        if (!targetRunId) {
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "cancel needs run_id", { close: false });
          return;
        }
        const ok = host.cancelRun(targetRunId);
        if (!ok) {
          sendError(ERROR_CODES.RUN_NOT_FOUND, `run ${targetRunId} not active`, { close: false });
        } else {
          log(`cancel accepted run=${targetRunId}`);
        }
        break;
      }
      case "user_action": {
        // Phase 5: A2UI user_action ingestion. Forward to the host for
        // approval-gate resolution, synthetic agent-turn routing, and
        // sidecar recording, then reply with `user_action_ack` plus a
        // user_action_outcome frame.
        if (!a2uiCapability) {
          sendUserActionOutcome(frame.id, "rejected", { reason: "user_action requires negotiated A2UI capability" });
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "user_action requires negotiated A2UI capability", { close: false });
          return;
        }
        if (typeof frame.name !== "string" || frame.name.length === 0) {
          sendUserActionOutcome(frame.id, "rejected", { reason: "user_action requires a non-empty name" });
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "user_action requires a non-empty name", { close: false });
          return;
        }
        if (frame.context !== undefined && (frame.context === null || typeof frame.context !== "object" || Array.isArray(frame.context))) {
          sendUserActionOutcome(frame.id, "rejected", { reason: "user_action.context must be an object when present" });
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "user_action.context must be an object when present", { close: false });
          return;
        }
        const handler = typeof host.handleUserAction === "function" ? host.handleUserAction : null;
        if (!handler) {
          sendUserActionOutcome(frame.id, "error", { reason: "user_action handler not wired" });
          sendError(ERROR_CODES.INTERNAL, "user_action handler not wired", { close: false });
          return;
        }
        try {
          const effectiveRunId = typeof frame.run_id === "string" && frame.run_id.length > 0
            ? frame.run_id
            : lastRoutableRunId;
          const usedSessionRunFallback = effectiveRunId != null && effectiveRunId === lastRoutableRunId && !(typeof frame.run_id === "string" && frame.run_id.length > 0);
          const ack = await handler({
            session_id: sessionId,
            run_id: effectiveRunId,
            turn_id: typeof frame.turn_id === "string" ? frame.turn_id : null,
            surface_id: typeof frame.surface_id === "string" ? frame.surface_id : null,
            component_id: typeof frame.component_id === "string" ? frame.component_id : null,
            name: frame.name,
            context: frame.context ?? {},
            action_id: typeof frame.action_id === "string" ? frame.action_id : null,
          });
          safeSend(ws, makeFrame("user_action_ack", {
            action_id: ack.action_id,
            status: ack.status,
            ...(ack.reason ? { reason: ack.reason } : {}),
            ...(ack.routed_as ? { routed_as: ack.routed_as } : {}),
          }), log);
          const outcome = ack.status === "rejected"
            ? "rejected"
            : ack.routed_as === "approval"
              ? "matched_approval"
              : ack.routed_as === "synthetic_input"
                ? "injected_as_input"
                : "recorded_only";
          if (ack.status === "accepted" && ack.synthetic_input) {
            const syntheticInput = usedSessionRunFallback && lastClientAgentId && lastClientConversationId
              ? { ...ack.synthetic_input, agent_id: lastClientAgentId, conversation_id: lastClientConversationId }
              : ack.synthetic_input;
            void dispatchSyntheticTurn(syntheticInput, { frame_id: frame.id, action_id: ack.action_id });
          } else {
            sendUserActionOutcome(frame.id, outcome, {
              action_id: ack.action_id,
              ...(ack.reason ? { reason: ack.reason } : {}),
              ...(ack.routed_as ? { routed_as: ack.routed_as } : {}),
            });
          }
        } catch (err) {
          log(`user_action handler failed: ${err.stack ?? err.message}`);
          sendUserActionOutcome(frame.id, "error", { reason: err.message ?? "user_action failed" });
          sendError(ERROR_CODES.INTERNAL, err.message ?? "user_action failed", { close: false });
        }
        break;
      }
      case "subscribe": {
        // lcp-p74.2: replay + live-tail the run's frame log to the client.
        // Cursor is the last seq the client has received; 0/null = from start.
        const runId = typeof frame.run_id === "string" && frame.run_id.length > 0 ? frame.run_id : null;
        if (!runId) {
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "subscribe requires a non-empty run_id", { close: false });
          break;
        }
        const cursor = typeof frame.cursor === "number" && Number.isFinite(frame.cursor) ? frame.cursor : 0;
        if (!host.subscribeToRun) {
          sendError(ERROR_CODES.INTERNAL, "subscribe not wired in this host", { close: false });
          break;
        }
        // Idempotency: replacing an active subscription for the same run_id
        // cancels the prior tail so we don't double-emit on overlapping
        // subscribe calls.
        const existing = activeSubscriptions.get(runId);
        if (existing) {
          safeUnsubscribe(`run ${runId}`, () => existing.unsubscribe());
          activeSubscriptions.delete(runId);
        }
        const handle = host.subscribeToRun(runId, cursor, {
          onFrame: (replayedFrame, seq) => {
            if (closed) return;
            safeSend(ws, makeFrame("subscribe_frame", { run_id: runId, seq, frame: replayedFrame }), log);
          },
          onDone: (info) => {
            if (closed) return;
            safeSend(ws, makeFrame("subscribe_done", { run_id: runId, last_seq: info.last_seq, status: info.status, ...(info.user_stopped === true ? { user_stopped: true } : {}) }), log);
            activeSubscriptions.delete(runId);
          },
          onError: (info) => {
            if (closed) return;
            sendError(info.code === "run_not_found" ? ERROR_CODES.RUN_NOT_FOUND : ERROR_CODES.INTERNAL, info.message, { close: false });
            activeSubscriptions.delete(runId);
          },
        });
        activeSubscriptions.set(runId, handle);
        break;
      }
      case "resume_conversation": {
        const conversationId = typeof frame.conversation_id === "string" ? frame.conversation_id : null;
        if (!conversationId) {
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "resume_conversation requires conversation_id", { close: false });
          break;
        }
        emitConversationResume(conversationId, frame.after_seq ?? frame.last_conv_seq ?? 0);
        break;
      }
      case "subscribe_conversation": {
        // lcp-convpush: subscribe to conversation-scoped frames, not a run.
        // This covers out-of-band turns started by cron/other clients where
        // this socket does not know the run_id up front. Replay first from the
        // durable conversation cursor, then stay attached for live stamped
        // frames from any producer in this shim process.
        const conversationId = typeof frame.conversation_id === "string" && frame.conversation_id.length > 0 ? frame.conversation_id : null;
        if (!conversationId) {
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "subscribe_conversation requires conversation_id", { close: false });
          break;
        }
        if (typeof host.subscribeConversationEvents !== "function") {
          sendError(ERROR_CODES.INTERNAL, "conversation subscription handler not wired", { close: false });
          break;
        }
        const existing = activeConversationSubscriptions.get(conversationId);
        if (existing) {
          safeUnsubscribe(`conversation ${conversationId}`, () => existing.unsubscribe());
          activeConversationSubscriptions.delete(conversationId);
        }
        emitConversationResume(conversationId, frame.after_seq ?? frame.last_conv_seq ?? 0);
        const unsubscribe = host.subscribeConversationEvents((event) => {
          if (closed) return;
          if (!event || event.conversationId !== conversationId || !event.frame) return;
          safeSend(ws, event.frame, log);
        });
        activeConversationSubscriptions.set(conversationId, { unsubscribe });
        safeSend(ws, makeFrame("conversation_subscribed", {
          conversation_id: conversationId,
          after_seq: normalizeCursorSeq(frame.after_seq ?? frame.last_conv_seq ?? 0),
        }), log);
        break;
      }
      case "unsubscribe_conversation": {
        const conversationId = typeof frame.conversation_id === "string" && frame.conversation_id.length > 0 ? frame.conversation_id : null;
        if (!conversationId) {
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "unsubscribe_conversation requires conversation_id", { close: false });
          break;
        }
        const existing = activeConversationSubscriptions.get(conversationId);
        if (existing) {
          safeUnsubscribe(`conversation ${conversationId}`, () => existing.unsubscribe());
          activeConversationSubscriptions.delete(conversationId);
        }
        break;
      }
      case "a2ui_frame":
        sendError(ERROR_CODES.PROTOCOL_VIOLATION, "a2ui_frame is server-to-client only", { close: false });
        break;
      case "cron_list": {
        // lcp-2gx: read-only enumeration of crons.json. Filters are optional.
        if (typeof host.handleCronList !== "function") {
          sendError(ERROR_CODES.INTERNAL, "cron_list handler not wired", { close: false });
          break;
        }
        try {
          const filters = {};
          if (typeof frame.agent_id === "string") filters.agent_id = frame.agent_id;
          if (typeof frame.conversation_id === "string") filters.conversation_id = frame.conversation_id;
          const { tasks } = host.handleCronList(filters);
          safeSend(ws, makeFrame("cron_list_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: true,
            tasks,
          }), log);
        } catch (err) {
          safeSend(ws, makeFrame("cron_list_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: false,
            error: err.message ?? "cron_list failed",
          }), log);
        }
        break;
      }
      case "subagent_list": {
        // letta-mobile-73o2h.1: enumerate currently-active subagents (or all,
        // with { all: true }) for the mobile status bar.
        if (typeof host.handleSubagentList !== "function") {
          sendError(ERROR_CODES.INTERNAL, "subagent_list handler not wired", { close: false });
          break;
        }
        try {
          const all = frame.all === true;
          const { subagents } = host.handleSubagentList({ all });
          safeSend(ws, makeFrame("subagent_list_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: true,
            subagents,
          }), log);
        } catch (err) {
          safeSend(ws, makeFrame("subagent_list_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: false,
            error: err.message ?? "subagent_list failed",
          }), log);
        }
        break;
      }
      case "subagent_todos": {
        // letta-mobile-73o2h.1: a single subagent's latest TodoWrite snapshot
        // + lifecycle status. Keyed by the parent Agent tool_call_id.
        if (typeof host.handleSubagentTodos !== "function") {
          sendError(ERROR_CODES.INTERNAL, "subagent_todos handler not wired", { close: false });
          break;
        }
        const toolCallId = typeof frame.tool_call_id === "string" ? frame.tool_call_id : null;
        if (!toolCallId) {
          safeSend(ws, makeFrame("subagent_todos_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: false,
            error: "tool_call_id is required",
          }), log);
          break;
        }
        try {
          const result = host.handleSubagentTodos(toolCallId);
          safeSend(ws, makeFrame("subagent_todos_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: true,
            found: result.found,
            subagent: result.subagent,
            todos: result.todos,
            todos_found: result.todos_found,
          }), log);
        } catch (err) {
          safeSend(ws, makeFrame("subagent_todos_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: false,
            error: err.message ?? "subagent_todos failed",
          }), log);
        }
        break;
      }
      case "cron_add": {
        if (typeof host.handleCronAdd !== "function") {
          sendError(ERROR_CODES.INTERNAL, "cron_add handler not wired", { close: false });
          break;
        }
        try {
          const req = {
            agent_id: frame.agent_id,
            conversation_id: typeof frame.conversation_id === "string" ? frame.conversation_id : undefined,
            name: typeof frame.name === "string" ? frame.name : undefined,
            description: typeof frame.description === "string" ? frame.description : undefined,
            prompt: typeof frame.prompt === "string" ? frame.prompt : "",
            recurring: typeof frame.recurring === "boolean" ? frame.recurring : undefined,
            cron: typeof frame.cron === "string" ? frame.cron : undefined,
            every: typeof frame.every === "string" ? frame.every : undefined,
            at: typeof frame.at === "string" ? frame.at : undefined,
            timezone: typeof frame.timezone === "string" ? frame.timezone : undefined,
          };
          const result = host.handleCronAdd(req);
          const out = {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: result.success,
          };
          if (result.success) {
            out.task = result.task;
            if (result.warning) out.warning = result.warning;
          } else {
            out.error = result.error;
          }
          safeSend(ws, makeFrame("cron_add_response", out), log);
        } catch (err) {
          safeSend(ws, makeFrame("cron_add_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: false,
            error: err.message ?? "cron_add failed",
          }), log);
        }
        break;
      }
      case "cron_get": {
        if (typeof host.handleCronGet !== "function") {
          sendError(ERROR_CODES.INTERNAL, "cron_get handler not wired", { close: false });
          break;
        }
        const taskId = typeof frame.task_id === "string" ? frame.task_id : null;
        if (!taskId) {
          safeSend(ws, makeFrame("cron_get_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: false,
            error: "task_id is required",
          }), log);
          break;
        }
        const task = host.handleCronGet(taskId);
        if (!task) {
          safeSend(ws, makeFrame("cron_get_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: false,
            error: `task ${taskId} not found`,
          }), log);
        } else {
          safeSend(ws, makeFrame("cron_get_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: true,
            task,
          }), log);
        }
        break;
      }
      case "cron_delete": {
        if (typeof host.handleCronDelete !== "function") {
          sendError(ERROR_CODES.INTERNAL, "cron_delete handler not wired", { close: false });
          break;
        }
        const taskId = typeof frame.task_id === "string" ? frame.task_id : null;
        if (!taskId) {
          safeSend(ws, makeFrame("cron_delete_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: false,
            error: "task_id is required",
          }), log);
          break;
        }
        const result = host.handleCronDelete(taskId);
        const out = {
          request_id: typeof frame.request_id === "string" ? frame.request_id : null,
          success: result.success,
        };
        if (!result.success && result.error) out.error = result.error;
        safeSend(ws, makeFrame("cron_delete_response", out), log);
        break;
      }
      case "cron_delete_all": {
        if (typeof host.handleCronDeleteAll !== "function") {
          sendError(ERROR_CODES.INTERNAL, "cron_delete_all handler not wired", { close: false });
          break;
        }
        const agentId = typeof frame.agent_id === "string" ? frame.agent_id : null;
        if (!agentId) {
          safeSend(ws, makeFrame("cron_delete_all_response", {
            request_id: typeof frame.request_id === "string" ? frame.request_id : null,
            success: false,
            count: 0,
            error: "agent_id is required",
          }), log);
          break;
        }
        const result = host.handleCronDeleteAll(agentId);
        const out = {
          request_id: typeof frame.request_id === "string" ? frame.request_id : null,
          success: result.success,
          count: result.count,
        };
        if (!result.success && result.error) out.error = result.error;
        safeSend(ws, makeFrame("cron_delete_all_response", out), log);
        break;
      }
      case "reflection_settings_get": {
        // lcp-4d5f: read the agent's reflection (sleeptime) settings.
        if (typeof host.handleReflectionSettingsGet !== "function") {
          sendError(ERROR_CODES.INTERNAL, "reflection_settings_get handler not wired", { close: false });
          break;
        }
        const requestId = typeof frame.request_id === "string" ? frame.request_id : null;
        try {
          const result = host.handleReflectionSettingsGet(
            typeof frame.agent_id === "string" ? frame.agent_id : "",
          );
          const out = { request_id: requestId, success: result.success };
          if (result.success) {
            out.agent_id = result.agent_id;
            out.settings = result.settings;
          } else {
            out.error = result.error;
          }
          safeSend(ws, makeFrame("reflection_settings_get_response", out), log);
        } catch (err) {
          safeSend(ws, makeFrame("reflection_settings_get_response", {
            request_id: requestId,
            success: false,
            error: err.message ?? "reflection_settings_get failed",
          }), log);
        }
        break;
      }
      case "reflection_settings_set": {
        // lcp-4d5f: update reflection settings; peers learn via the
        // reflection_settings_updated push the host broadcasts.
        if (typeof host.handleReflectionSettingsSet !== "function") {
          sendError(ERROR_CODES.INTERNAL, "reflection_settings_set handler not wired", { close: false });
          break;
        }
        const requestId = typeof frame.request_id === "string" ? frame.request_id : null;
        try {
          const result = host.handleReflectionSettingsSet(
            typeof frame.agent_id === "string" ? frame.agent_id : "",
            {
              trigger: frame.trigger,
              behavior: frame.behavior,
              step_count: frame.step_count,
            },
          );
          const out = { request_id: requestId, success: result.success };
          if (result.success) {
            out.agent_id = result.agent_id;
            out.settings = result.settings;
            out.workers_recycled = result.workers_recycled;
          } else {
            out.error = result.error;
          }
          safeSend(ws, makeFrame("reflection_settings_set_response", out), log);
        } catch (err) {
          safeSend(ws, makeFrame("reflection_settings_set_response", {
            request_id: requestId,
            success: false,
            error: err.message ?? "reflection_settings_set failed",
          }), log);
        }
        break;
      }
      case "ack":
        if (typeof frame.conversation_id === "string" && typeof host.ackConversation === "function") {
          try {
            host.ackConversation(frame.conversation_id, normalizeCursorSeq(frame.ack_seq ?? frame.conv_seq ?? frame.seq ?? 0));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`conversation ack failed conversation=${frame.conversation_id}: ${msg}`);
            sendError(ERROR_CODES.INTERNAL, "conversation ack failed", { close: false });
          }
        }
        break;
      case "pong":
        // Liveness signal — resetIdle above already noted it.
        break;
      case "bye":
        log(`client said bye session=${sessionId}`);
        safeClose(1000, "bye");
        break;
      default:
        // Unknown frame types: ignore per forward-compat rule.
        break;
    }
  });

  ws.on("close", () => {
    log(`closed session=${sessionId} device=${device?.device_id ?? "(unauthed)"}`);
    stopAll();
  });

  ws.on("ping", () => {
    resetIdle();
    touchAdapterForLiveness();
  });

  ws.on("pong", () => {
    resetIdle();
    touchAdapterForLiveness();
  });

  ws.on("error", (err) => {
    log(`socket error session=${sessionId}: ${err.message}`);
    stopAll();
  });

  resetIdle();
}
