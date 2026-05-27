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

function resolveToken(account) {
  const config = account?.config ?? {};
  const envName = config.tokenEnv;
  if (envName && process.env[envName]) return process.env[envName];
  return config.tokenFallback ?? "";
}

function createMobileAdapter(account, host) {
  const accountId = account.accountId ?? "default";
  const config = account?.config ?? {};

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

    // The channel is fully inbound for Phase 1; outbound sends ride the
    // WS established at acceptConnection time. We expose the standard
    // adapter surface so letta-code's channel registry is happy, but the
    // sendMessage hook is a no-op until Phase 3 introduces server-pushed
    // events that target a connected device.
    async sendMessage() {
      return { messageId: `mobile-noop-${Date.now()}` };
    },
    async sendDirectReply() {
      // intentionally no-op in Phase 1
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
