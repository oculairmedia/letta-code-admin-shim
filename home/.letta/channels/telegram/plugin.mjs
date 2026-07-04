/**
 * Telegram channel plugin for Letta Code.
 *
 * Second reference plugin for the admin-shim's generic channel host, proving
 * the plugin contract is not matrix-shaped. Zero runtime dependencies — the
 * Bot API is spoken over node's built-in fetch.
 *
 * Feature set:
 *   • Long-poll getUpdates with a persisted update_id offset
 *     (state/<accountId>.json — same file the registry health-poll stats)
 *   • Bootstrap-backlog drop on a fresh install (no offset file ⇒ skip
 *     updates older than process start)
 *   • Inbound text → host onMessage with chatId
 *   • Dedupe by update_id (TTL-bounded file cache)
 *   • Echo filter (drop messages from the bot itself via from.id == me.id,
 *     cached from getMe)
 *   • allowedChats enforcement + dmPolicy for private chats
 *   • Outbound sendMessage (markdown → MarkdownV2 with escaping, threadId →
 *     message_thread_id for forum topics)
 *   • Typing indicator via sendChatAction, driven by the turn lifecycle
 *
 * Required account.config:
 *   botToken            string   — Bot API token (write-only secret)
 *
 * Optional account.config:
 *   apiBaseUrl          string   default https://api.telegram.org
 *   allowedChats        (string|number)[]  — chat ids and/or @usernames; when
 *                       non-empty, ONLY these chats flow to the agent
 *   dmPolicy            "open"|"allowlist"  default "open" — for private
 *                       chats when allowedChats is empty
 *   pollTimeoutSec      number   default 30 — getUpdates long-poll seconds
 *   typingIndicators    boolean  default true
 */

import { createTelegramClient } from "./lib/api.mjs";
import { chatIdentifiers, inboundFromMessage } from "./lib/inbound.mjs";
import { sendText } from "./lib/outbound.mjs";
import { loadOffset, saveOffset, UpdateDedupe } from "./lib/state.mjs";
import { TypingManager } from "./lib/typing.mjs";

function nowIso() {
  return new Date().toISOString();
}

function createTelegramAdapter(account, host) {
  const channelId = "telegram";
  const accountId = account.accountId ?? "default";
  const config = account.config ?? {};
  const botToken = String(config.botToken ?? "");
  const apiBaseUrl = config.apiBaseUrl ? String(config.apiBaseUrl) : undefined;
  const pollTimeoutSec = Number.isFinite(Number(config.pollTimeoutSec))
    ? Number(config.pollTimeoutSec)
    : 30;
  const typingEnabled = config.typingIndicators !== false;
  const dmPolicy = typeof config.dmPolicy === "string" ? config.dmPolicy : (account.dmPolicy ?? "open");
  // Optional chat allowlist. When set, ONLY these chats (by numeric id or
  // @username) reach the agent; every other chat is dropped BEFORE bridging.
  const allowedChats = Array.isArray(config.allowedChats)
    ? new Set(config.allowedChats.map((c) => String(c)))
    : null;

  const displayName = account.displayName ?? "Telegram";
  const log = (msg) => {
    if (typeof host?.log === "function") host.log(msg);
    else console.error(`[telegram:${accountId}] ${msg}`);
  };

  const client = createTelegramClient({ botToken, apiBaseUrl });
  const typing = new TypingManager({ client });
  const dedupe = new UpdateDedupe(accountId);

  let running = false;
  let abortController = null;
  let loopPromise = null;
  let selfId = null;
  let offset = loadOffset(accountId); // undefined ⇒ fresh install
  const initialBootstrap = offset === undefined;
  const startupTs = Date.now();

  /** Allowlist / dmPolicy gate. Returns true if the chat may reach the agent. */
  function chatAllowed(chat) {
    if (allowedChats && allowedChats.size > 0) {
      return chatIdentifiers(chat).some((id) => allowedChats.has(id));
    }
    // No allowlist configured: private chats obey dmPolicy; groups pass.
    if (chat?.type === "private" && dmPolicy === "allowlist") return false;
    return true;
  }

  async function dispatchUpdate(update) {
    // Always advance the offset past this update, even when we drop it, so a
    // filtered / non-text update is never re-fetched.
    if (typeof update.update_id === "number") {
      offset = update.update_id + 1;
    }
    const message = update.message ?? update.edited_message ?? null;
    if (!message) return;

    // Bootstrap-backlog drop: on a fresh install (no offset file) skip any
    // message that predates process start, so a restarted bot does not replay
    // history. Once an offset file exists this guard is inert.
    if (initialBootstrap) {
      const dateMs = typeof message.date === "number" ? message.date * 1000 : 0;
      if (dateMs && dateMs < startupTs) return;
    }

    if (!chatAllowed(message.chat ?? {})) return;

    let inbound;
    try {
      inbound = inboundFromMessage({
        channelId,
        accountId,
        message,
        selfId,
        dedupe,
        updateId: update.update_id,
      });
    } catch (err) {
      log(`parse error: ${err?.message ?? err}`);
      return;
    }
    if (!inbound || !adapter.onMessage) return;

    if (typingEnabled) typing.start(inbound.chatId, inbound.threadId).catch(() => {});
    try {
      await adapter.onMessage(inbound);
    } catch (err) {
      log(`onMessage threw: ${err?.message ?? err}`);
      if (typingEnabled) typing.stop(inbound.chatId, inbound.threadId).catch(() => {});
    }
  }

  async function pollLoop() {
    abortController = new AbortController();
    while (running) {
      try {
        const updates = await client.getUpdates({
          offset,
          timeoutSec: pollTimeoutSec,
          allowedUpdates: ["message", "edited_message"],
          signal: abortController.signal,
        });
        if (Array.isArray(updates)) {
          for (const update of updates) {
            if (!running) break;
            await dispatchUpdate(update);
          }
        }
        // Persist the offset after EVERY successful poll (even an empty
        // return) so the state file's mtime tracks liveness for the
        // registry's sync-stall health check, not just offset advances.
        saveOffset(accountId, offset ?? 0);
      } catch (err) {
        if (!running) break;
        if (err?.name === "AbortError") break;
        const wait = err?.retryAfter ? Number(err.retryAfter) * 1000 : 5000;
        log(`getUpdates error: ${err?.message ?? err}; retrying in ${wait}ms`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  const adapter = {
    id: `telegram:${accountId}`,
    channelId,
    accountId,
    name: displayName,

    async start() {
      if (running) return;
      try {
        const me = await client.getMe();
        selfId = me?.id ?? null;
        log(
          `started; bot=@${me?.username ?? "?"} id=${selfId} bootstrap=${initialBootstrap} (${nowIso()})`,
        );
      } catch (err) {
        throw new Error(
          `telegram plugin: getMe failed (${err.message}). Check botToken and apiBaseUrl.`,
        );
      }
      running = true;
      loopPromise = pollLoop();
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
      log(`stopped (${nowIso()})`);
    },

    isRunning() {
      return running;
    },

    async sendMessage(msg) {
      // A reply landing in a chat means the turn produced output → release
      // the typing indicator for that chat/topic. Fire and forget.
      if (typingEnabled && msg.chatId != null) {
        typing.stop(msg.chatId, msg.threadId).catch(() => {});
      }
      return sendText(client, {
        chatId: msg.chatId,
        text: msg.text,
        markdown: msg.markdown,
        threadId: msg.threadId,
        replyToMessageId: msg.replyToMessageId,
      });
    },

    async sendDirectReply(chatId, text, options = {}) {
      if (typingEnabled && chatId != null) typing.stop(chatId, options.threadId).catch(() => {});
      await sendText(client, {
        chatId,
        text,
        markdown: options.markdown,
        threadId: options.threadId,
        replyToMessageId: options.replyToMessageId,
      });
    },

    // Lifecycle: start typing on queued/processing, stop on finished. Mirrors
    // the matrix plugin so the registry's queued→processing→finished events
    // drive the indicator (see channel-registry safeLifecycle).
    async handleTurnLifecycleEvent(event) {
      if (!typingEnabled) return;
      try {
        if (event.type === "processing" || event.type === "queued") {
          for (const source of event.sources ?? [event.source]) {
            if (source?.chatId != null) typing.start(source.chatId, source.threadId).catch(() => {});
          }
        } else if (event.type === "finished") {
          for (const source of event.sources ?? [event.source]) {
            if (source?.chatId != null) typing.stop(source.chatId, source.threadId).catch(() => {});
          }
        }
      } catch (err) {
        log(`lifecycle hook error: ${err.message}`);
      }
    },

    onMessage: undefined,
  };

  return adapter;
}

export const channelPlugin = {
  metadata: {
    id: "telegram",
    displayName: "Telegram",
    runtimePackages: [],
    runtimeModules: [],
  },

  async createAdapter(account, host) {
    return createTelegramAdapter(account, host ?? {});
  },

  messageActions: {
    describeMessageTool() {
      return {
        actions: ["send"],
        schema: {
          properties: {
            markdown: {
              type: "boolean",
              description: "Render text as Telegram MarkdownV2 (escaped) instead of plain text.",
            },
          },
        },
      };
    },

    async handleAction({ adapter, request, formatText }) {
      switch (request.action) {
        case "send": {
          const formatted = formatText ? formatText(request.message ?? "") : { text: request.message ?? "" };
          const result = await adapter.sendMessage({
            channel: request.channel,
            chatId: request.chatId,
            text: formatted.text,
            markdown: request.markdown ?? formatted.markdown,
            threadId: request.threadId,
            replyToMessageId: request.replyToMessageId,
          });
          return `Message sent to ${request.channel}:${request.chatId} (message_id: ${result.messageId})`;
        }
        default:
          return `Unsupported telegram action: ${request.action}`;
      }
    },
  },
};

export default channelPlugin;
