/**
 * Mobile channel plugin — Phase 1.
 *
 * Unlike Matrix (which long-polls an external homeserver), this channel
 * is INBOUND: the shim hosts a WS upgrade route at /shim/v1/mobile and
 * hands accepted sockets to this plugin's `acceptConnection(ws, request)`.
 *
 * See docs/MOBILE_CHANNEL_DESIGN.md for the full design.
 */

import { handleConnection } from "./lib/ws-handler.mjs";
import { makeFrame } from "./lib/protocol.mjs";

function stringField(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function messageText(msg) {
  const text = stringField(msg, ["text", "content", "body", "message"]);
  if (text !== null) return text;
  return "";
}

function withoutFrameEnvelope(obj) {
  const {
    message_type: _messageType,
    type: _type,
    v: _version,
    ts: _timestamp,
    ...rest
  } = obj ?? {};
  return rest;
}

function resolveToken(account) {
  const config = account?.config ?? {};
  const envName = config.tokenEnv;
  if (envName && process.env[envName]) return process.env[envName];
  return config.tokenFallback ?? "";
}

function createMobileAdapter(account, host) {
  const accountId = account.accountId ?? "default";
  const config = account?.config ?? {};
  const clients = new Map();

  const registerPushClient = ({ sessionId, deviceId, sendFrame }) => {
    if (typeof sessionId !== "string" || typeof sendFrame !== "function") {
      return () => {};
    }
    clients.set(sessionId, { deviceId: deviceId ?? null, sendFrame });
    host.log?.(`[mobile:${accountId}] push client registered session=${sessionId} device=${deviceId ?? "?"}`);
    return () => {
      clients.delete(sessionId);
      host.log?.(`[mobile:${accountId}] push client released session=${sessionId}`);
    };
  };

  const broadcastFrame = (frame) => {
    let delivered = 0;
    for (const [sessionId, client] of clients.entries()) {
      try {
        client.sendFrame(frame);
        delivered += 1;
      } catch (err) {
        host.log?.(`[mobile:${accountId}] channel push failed session=${sessionId}: ${err.message}`);
      }
    }
    return delivered;
  };

  const pushTextMessage = (msg) => {
    const conversationId = stringField(msg, ["conversation_id", "conversationId", "chatId", "roomId"]);
    const agentId = stringField(msg, ["agent_id", "agentId"]);
    const frameType = stringField(msg, ["type", "message_type"]);
    const isStructuredFrame = frameType !== null && frameType !== "send" && frameType !== "message";
    const messageId = stringField(msg, ["messageId", "message_id", "id"])
      ?? `mobile-push-${Date.now()}`;
    const fields = isStructuredFrame
      ? withoutFrameEnvelope(msg)
      : {
          id: messageId,
          agent_id: agentId,
          conversation_id: conversationId,
          turn_id: stringField(msg, ["turn_id", "turnId"]) ?? `turn-channel-push-${Date.now()}`,
          run_id: stringField(msg, ["run_id", "runId"]),
          content: messageText(msg),
          date: stringField(msg, ["date", "created_at", "createdAt"])
            ?? new Date().toISOString(),
        };
    const frame = makeFrame(isStructuredFrame ? frameType : "assistant_message", {
      ...fields,
      source: fields.source ?? "channel_push",
      channel_id: fields.channel_id ?? "mobile",
    });
    const stamped = conversationId && typeof host.stampConversationFrame === "function"
      ? host.stampConversationFrame(conversationId, frame)
      : frame;
    const delivered = broadcastFrame(stamped);
    host.log?.(`[mobile:${accountId}] channel push delivered=${delivered} conversation=${conversationId ?? "?"}`);
    return { messageId, delivered };
  };

  const adapter = {
    id: `mobile:${accountId}`,
    channelId: "mobile",
    accountId,
    name: account.displayName ?? "Letta Mobile",

    async start() {
      host.log?.(`[mobile:${accountId}] adapter ready (accepts inbound WS via /shim/v1/mobile)`);
    },

    async stop() {
      host.log?.(`[mobile:${accountId}] adapter stopped`);
    },

    isRunning() {
      return true;
    },

    // Outbound channel sends ride already-authenticated mobile WS sessions.
    // This completes the channel contract for proactive server pushes (for
    // example background relay completions) without introducing a separate
    // mobile-only push primitive.
    async sendMessage(msg = {}) {
      return pushTextMessage(msg);
    },
    async sendDirectReply(chatId, text, options = {}) {
      return pushTextMessage({ ...options, chatId, text });
    },
    onMessage: undefined,

    /**
     * Phase-1 entrypoint called by the shim when a WS upgrade arrives on
     * /shim/v1/mobile. `host` provides token, server-id, and the
     * sendMessage bridge into the worker pool.
     */
    acceptConnection(ws, request) {
      handleConnection(ws, request, {
        config,
        log: (msg) => host.log?.(`[mobile:${accountId}] ${msg}`),
        getToken: () => resolveToken(account),
        getServerId: () => host.getServerId?.() ?? "unknown",
        getA2uiServerCapabilities: () => host.getA2uiServerCapabilities?.() ?? { enabled: false },
        sendMessage: host.bridgeSendMessage,
        cancelRun: host.cancelRun ?? (() => false),
        // Phase 5: forward user_action ingestion to the outer host's
        // sidecar recorder. ws-handler short-circuits to internal_error
        // when this is missing — so wiring it here is required for the
        // user_action round-trip to succeed.
        handleUserAction: host.handleUserAction
          ? (action) => host.handleUserAction(action)
          : undefined,
        // lcp-p74.2: replay+live-tail subscription so disconnected clients
        // can resume from a known cursor.
        subscribeToRun: host.subscribeToRun
          ? (runId, cursor, cbs) => host.subscribeToRun(runId, cursor, cbs)
          : undefined,
        mobileConversationCursorCapabilities: host.mobileConversationCursorCapabilities,
        stampConversationFrame: host.stampConversationFrame
          ? (conversationId, frame) => host.stampConversationFrame(conversationId, frame)
          : undefined,
        subscribeConversationEvents: host.subscribeConversationEvents
          ? (listener) => host.subscribeConversationEvents(listener)
          : undefined,
        registerPushClient,
        resumeConversation: host.resumeConversation
          ? (conversationId, afterSeq) => host.resumeConversation(conversationId, afterSeq)
          : undefined,
        ackConversation: host.ackConversation
          ? (conversationId, ackSeq) => host.ackConversation(conversationId, ackSeq)
          : undefined,
        // lcp-2gx: cron CRUD over WS + crons_updated push.
        handleCronList: host.handleCronList,
        handleCronAdd: host.handleCronAdd,
        handleCronGet: host.handleCronGet,
        handleCronDelete: host.handleCronDelete,
        handleCronDeleteAll: host.handleCronDeleteAll,
        subscribeCronEvents: host.subscribeCronEvents,
        // lcp-indw: approval_resolved cross-client push. MUST be explicitly
        // forwarded here (same gotcha as subscribeCronEvents) — the handler
        // only sees host methods it is handed.
        subscribeApprovalEvents: host.subscribeApprovalEvents,
        // lcp-4d5f: reflection (sleeptime) settings get/set + updated push.
        // Same explicit-forwarding gotcha as the cron/approval handlers.
        handleReflectionSettingsGet: host.handleReflectionSettingsGet,
        handleReflectionSettingsSet: host.handleReflectionSettingsSet,
        subscribeReflectionEvents: host.subscribeReflectionEvents,
        // letta-mobile-73o2h.1: active-subagent registry over WS.
        // Same explicit-forwarding gotcha as above — the ws-handler
        // only sees host methods it is explicitly handed.
        handleSubagentList: host.handleSubagentList,
        handleSubagentTodos: host.handleSubagentTodos,
        subscribeSubagentEvents: host.subscribeSubagentEvents,
      });
    },
  };

  return adapter;
}

export const channelPlugin = {
  metadata: {
    id: "mobile",
    displayName: "Letta Mobile",
    runtimePackages: ["ws@8.18.0"],
    runtimeModules: ["ws"],
  },

  async createAdapter(account, host = {}) {
    return createMobileAdapter(account, host);
  },

  messageActions: {
    describeMessageTool() {
      return { actions: ["send"] };
    },
    async handleAction() {
      return "mobile channel: send via adapter.sendMessage not supported in Phase 1";
    },
  },
};

export default channelPlugin;
