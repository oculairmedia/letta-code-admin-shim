/**
 * Matrix channel plugin for Letta Code — v2.
 *
 * Plugin metadata + adapter wiring. Heavy lifting lives in ./lib/.
 *
 * Feature set (this rev):
 *   • Long-poll /sync with persisted token, bootstrap-backlog drop
 *   • Inbound text + media (image/audio/video/file) with local cache
 *   • Image base64 embedding for vision models (size-budgeted)
 *   • Markdown → HTML auto-conversion on outbound
 *   • Reactions, edits, deletes (m.replace + redaction)
 *   • Typing indicators with heartbeat during agent turns
 *   • Mention detection (m.mentions / @localpart / regex)
 *   • Reply context preserved as threadContext.starter
 *   • Event dedupe (TTL-bounded file cache)
 *   • Echo filter (drop bot's own streaming-progress messages)
 *   • Auto-join invites
 *
 * Required account.config:
 *   homeserverUrl, accessToken, userId
 *
 * Optional account.config:
 *   autoJoinInvites      boolean   default true
 *   syncTimeoutMs        number    default 30000
 *   mentionPatterns      string[]  extra regex patterns to treat as mentions
 *   typingIndicators     boolean   default true
 *   suppressTypingErrors boolean   default true
 *   readReceipts         boolean   default false — mark inbound as read
 */

import { createMatrixClient } from "./lib/api.mjs";
import { inboundFromTimelineEvent } from "./lib/inbound.mjs";
import {
  deleteMessage,
  editMessage,
  sendReaction,
  sendText,
} from "./lib/outbound.mjs";
import { EventDedupe, loadSyncToken, saveSyncToken } from "./lib/state.mjs";
import { TypingManager } from "./lib/typing.mjs";

function nowIso() {
  return new Date().toISOString();
}

function createMatrixAdapter(account) {
  const channelId = "matrix";
  const accountId = account.accountId ?? "default";
  const config = account.config ?? {};
  const homeserverUrl = String(config.homeserverUrl ?? "");
  const accessToken = String(config.accessToken ?? "");
  const selfUserId = String(config.userId ?? "");
  const autoJoinInvites = config.autoJoinInvites !== false;
  const syncTimeoutMs = Number(config.syncTimeoutMs ?? 30000);
  const typingEnabled = config.typingIndicators !== false;
  const readReceiptsEnabled = config.readReceipts === true;
  const mentionPatterns = Array.isArray(config.mentionPatterns)
    ? config.mentionPatterns
    : [];
  // Optional room allowlist. If set, ONLY events from these room IDs flow to
  // the agent. Events from other rooms are silently dropped (sync still
  // advances). Leave empty/undefined to accept events from every room the
  // bot is in.
  const allowedRooms = Array.isArray(config.allowedRooms)
    ? new Set(config.allowedRooms)
    : null;
  // Optional explicit denylist (e.g. production rooms we know about).
  // Applied after allowlist; denied rooms override allowlist matches.
  const deniedRooms = Array.isArray(config.deniedRooms)
    ? new Set(config.deniedRooms)
    : new Set();
  const displayName = account.displayName ?? "Matrix";

  const client = createMatrixClient({ homeserverUrl, accessToken });
  const typing = new TypingManager({ client, selfUserId });
  const dedupe = new EventDedupe(accountId);

  let running = false;
  let abortController = null;
  let loopPromise = null;
  let syncToken = loadSyncToken(accountId);
  const initialBootstrap = syncToken === undefined;
  let droppedBootstrapBacklog = !initialBootstrap;
  const startupTs = Date.now();

  async function handleInvites(syncResponse) {
    if (!autoJoinInvites) return;
    const invites = syncResponse?.rooms?.invite ?? {};
    for (const roomId of Object.keys(invites)) {
      try {
        await client.joinRoom({ roomIdOrAlias: roomId });
        console.error(`[matrix:${accountId}] joined invited room ${roomId}`);
      } catch (err) {
        console.error(`[matrix:${accountId}] join ${roomId} failed: ${err.message}`);
      }
    }
  }

  async function dispatchTimelineEvents(syncResponse) {
    if (!adapter.onMessage) return;
    if (!droppedBootstrapBacklog) {
      droppedBootstrapBacklog = true;
      console.error(
        `[matrix:${accountId}] discarded initial sync backlog; future events will dispatch normally`,
      );
      return;
    }
    const joined = syncResponse?.rooms?.join ?? {};
    for (const [roomId, payload] of Object.entries(joined)) {
      // Room allowlist / denylist enforcement — drop anything outside scope
      // BEFORE we even parse, so we cannot accidentally trigger an agent
      // response on a production room.
      if (allowedRooms && !allowedRooms.has(roomId)) continue;
      if (deniedRooms.has(roomId)) continue;
      const events = payload?.timeline?.events ?? [];
      for (const event of events) {
        if (event.type !== "m.room.message") continue;
        // Safety: don't process events that pre-date startup by more than a
        // few minutes — guards against /sync handing us older items because
        // of our previous token getting stale.
        const eventTs = typeof event.origin_server_ts === "number"
          ? event.origin_server_ts
          : 0;
        if (eventTs && eventTs < startupTs - 5 * 60_000 && initialBootstrap) {
          continue;
        }
        let inbound;
        try {
          inbound = await inboundFromTimelineEvent({
            channelId,
            accountId,
            roomId,
            event,
            selfUserId,
            client,
            mentionPatterns,
            dedupe,
          });
        } catch (err) {
          console.error(`[matrix:${accountId}] parse error: ${err?.stack ?? err}`);
          continue;
        }
        if (!inbound) continue;
        // Start typing immediately on inbound. Stop happens via either
        // handleTurnLifecycleEvent("finished") or sendMessage to the same
        // room — whichever fires first. onMessage returns fast (enqueue
        // only), so a try/finally around it would close typing prematurely.
        if (typingEnabled) typing.start(roomId).catch(() => {});
        if (readReceiptsEnabled && event.event_id) {
          client.setReadMarker({ roomId, eventId: event.event_id }).catch(() => {});
        }
        try {
          await adapter.onMessage(inbound);
        } catch (err) {
          console.error(`[matrix:${accountId}] onMessage threw: ${err?.stack ?? err}`);
          if (typingEnabled) typing.stop(roomId).catch(() => {});
        }
      }
    }
  }

  async function syncLoop() {
    abortController = new AbortController();
    while (running) {
      try {
        const response = await client.sync({
          since: syncToken,
          timeoutMs: syncToken ? syncTimeoutMs : 0,
          signal: abortController.signal,
        });
        const nextToken = response?.next_batch;
        if (nextToken && nextToken !== syncToken) {
          syncToken = nextToken;
          saveSyncToken(accountId, syncToken);
        }
        await handleInvites(response);
        await dispatchTimelineEvents(response);
      } catch (err) {
        if (!running) break;
        if (err?.name === "AbortError") break;
        console.error(`[matrix:${accountId}] sync error: ${err?.message ?? err}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  const adapter = {
    id: `matrix:${accountId}`,
    channelId,
    accountId,
    name: displayName,

    async start() {
      if (running) return;
      try {
        const who = await client.whoami();
        if (selfUserId && who?.user_id && who.user_id !== selfUserId) {
          console.error(
            `[matrix:${accountId}] WARNING: accessToken belongs to ${who.user_id} but config.userId is ${selfUserId}`,
          );
        }
      } catch (err) {
        throw new Error(
          `matrix plugin: whoami failed (${err.message}). Check homeserverUrl and accessToken.`,
        );
      }
      running = true;
      loopPromise = syncLoop();
      console.error(
        `[matrix:${accountId}] started; homeserver=${homeserverUrl} userId=${selfUserId} (${nowIso()})`,
      );
    },

    async stop() {
      if (!running) return;
      running = false;
      abortController?.abort();
      try { await loopPromise; } catch {}
      loopPromise = null;
      abortController = null;
      await typing.stopAll();
      dedupe.close();
      console.error(`[matrix:${accountId}] stopped (${nowIso()})`);
    },

    isRunning() {
      return running;
    },

    async sendMessage(msg) {
      // Reply landing in a room ⇒ stop typing for that room. Fire and forget.
      if (typingEnabled && msg.chatId) typing.stop(msg.chatId).catch(() => {});
      // Branch on the requested action when callers set reaction / edit / delete.
      if (msg.reaction && msg.targetMessageId) {
        if (msg.removeReaction) {
          // Removing a reaction = redacting the reaction event. We don't track
          // our own reaction event ids per target — best-effort: redact the
          // targetMessageId if the caller passed the reaction's own event id.
          return deleteMessage(client, {
            roomId: msg.chatId,
            messageId: msg.targetMessageId,
            reason: "remove reaction",
          });
        }
        return sendReaction(client, {
          roomId: msg.chatId,
          targetMessageId: msg.targetMessageId,
          emoji: msg.reaction,
        });
      }
      return sendText(client, {
        roomId: msg.chatId,
        text: msg.text,
        parseMode: msg.parseMode,
        replyToMessageId: msg.replyToMessageId,
        threadId: msg.threadId,
      });
    },

    async sendDirectReply(chatId, text, options = {}) {
      if (typingEnabled && chatId) typing.stop(chatId).catch(() => {});
      await sendText(client, {
        roomId: chatId,
        text,
        replyToMessageId: options.replyToMessageId,
      });
    },

    // Lifecycle hook: stop typing on every "finished" event, start on
    // "processing" (covers cases where multiple inbound messages are
    // coalesced into one turn batch).
    async handleTurnLifecycleEvent(event) {
      if (!typingEnabled) return;
      try {
        if (event.type === "processing" || event.type === "queued") {
          for (const source of event.sources ?? [event.source]) {
            if (source?.chatId) typing.start(source.chatId).catch(() => {});
          }
        } else if (event.type === "finished") {
          for (const source of event.sources ?? [event.source]) {
            if (source?.chatId) typing.stop(source.chatId).catch(() => {});
          }
        }
      } catch (err) {
        console.error(`[matrix:${accountId}] lifecycle hook error: ${err.message}`);
      }
    },

    onMessage: undefined,
  };

  // Custom action handlers exposed via messageActions (below) get a handle to
  // these helpers by capturing the closure.
  adapter._editMessage = (chatId, messageId, text) =>
    editMessage(client, { roomId: chatId, messageId, text });
  adapter._deleteMessage = (chatId, messageId, reason) =>
    deleteMessage(client, { roomId: chatId, messageId, reason });
  adapter._sendReaction = (chatId, targetMessageId, emoji) =>
    sendReaction(client, { roomId: chatId, targetMessageId, emoji });

  return adapter;
}

export const channelPlugin = {
  metadata: {
    id: "matrix",
    displayName: "Matrix",
    runtimePackages: [],
    runtimeModules: [],
  },

  async createAdapter(account) {
    return createMatrixAdapter(account);
  },

  messageActions: {
    describeMessageTool() {
      return {
        actions: ["send", "react", "remove_reaction", "edit", "delete"],
        schema: {
          properties: {
            emoji: {
              type: "string",
              description: "Emoji or custom_emoji:<id> for matrix reactions.",
            },
          },
        },
      };
    },

    async handleAction({ adapter, request, formatText }) {
      switch (request.action) {
        case "send": {
          const formatted = formatText(request.message ?? "");
          const result = await adapter.sendMessage({
            channel: request.channel,
            chatId: request.chatId,
            text: formatted.text,
            parseMode: formatted.parseMode,
            replyToMessageId: request.replyToMessageId,
            threadId: request.threadId,
          });
          return `Message sent to ${request.channel}:${request.chatId} (event_id: ${result.messageId})`;
        }
        case "react": {
          if (!request.emoji || !request.messageId) {
            return "matrix react requires emoji and messageId";
          }
          const result = await adapter._sendReaction(
            request.chatId,
            request.messageId,
            request.emoji,
          );
          return `Reacted ${request.emoji} on ${request.messageId} (event_id: ${result.messageId})`;
        }
        case "remove_reaction": {
          if (!request.messageId) return "matrix remove_reaction requires messageId";
          const result = await adapter._deleteMessage(
            request.chatId,
            request.messageId,
            "remove reaction",
          );
          return `Removed reaction ${request.messageId} (event_id: ${result.messageId})`;
        }
        case "edit": {
          if (!request.messageId) return "matrix edit requires messageId";
          const formatted = formatText(request.message ?? "");
          const result = await adapter._editMessage(
            request.chatId,
            request.messageId,
            formatted.text,
          );
          return `Edited ${request.messageId} (event_id: ${result.messageId})`;
        }
        case "delete": {
          if (!request.messageId) return "matrix delete requires messageId";
          const result = await adapter._deleteMessage(
            request.chatId,
            request.messageId,
            "agent delete",
          );
          return `Deleted ${request.messageId} (event_id: ${result.messageId})`;
        }
        default:
          return `Unsupported matrix action: ${request.action}`;
      }
    },
  },
};

export default channelPlugin;
