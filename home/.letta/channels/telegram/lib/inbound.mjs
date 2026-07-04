/**
 * Telegram update → inbound message conversion.
 *
 * Consumes the `message` object out of a getUpdates result and maps it to
 * the host's inbound shape ({ chatId, text, messageId, timestamp, … }). Only
 * text messages are surfaced in this rev; non-text messages (photos, docs,
 * stickers, service messages) return null so the offset still advances but no
 * turn is bridged.
 *
 * Echo and dedupe are applied here so the caller only ever sees fresh,
 * non-self messages.
 */

import { shouldFilterOwnEcho } from "./echo.mjs";

/** Normalize a chat identity for allowlist comparison: id string + @username. */
export function chatIdentifiers(chat) {
  const ids = [];
  if (chat?.id != null) ids.push(String(chat.id));
  if (typeof chat?.username === "string" && chat.username) ids.push(`@${chat.username}`);
  return ids;
}

/**
 * @returns the inbound message object, or null to drop (non-text, echo,
 * duplicate, or unsupported).
 */
export function inboundFromMessage({ channelId, accountId, message, selfId, dedupe, updateId }) {
  if (!message || typeof message !== "object") return null;

  // Dedupe on update_id — defends against getUpdates retries / restarts
  // (offset not yet persisted when the process died mid-batch).
  if (dedupe && updateId != null && !dedupe.mark(updateId)) return null;

  if (shouldFilterOwnEcho(message, selfId)) return null;

  const text = typeof message.text === "string" ? message.text : "";
  if (!text) return null; // text-only for this rev

  const chat = message.chat ?? {};
  const from = message.from ?? {};
  const dateMs = typeof message.date === "number" ? message.date * 1000 : Date.now();
  const threadId =
    typeof message.message_thread_id === "number" ? message.message_thread_id : null;

  const senderName =
    [from.first_name, from.last_name].filter(Boolean).join(" ") ||
    (from.username ? `@${from.username}` : String(from.id ?? "unknown"));

  const inbound = {
    channel: channelId,
    accountId,
    chatId: String(chat.id ?? ""),
    senderId: from.id != null ? String(from.id) : null,
    senderName,
    text,
    timestamp: dateMs,
    messageId: message.message_id != null ? String(message.message_id) : null,
    threadId: threadId != null ? String(threadId) : null,
    raw: message,
    chatType: chat.type === "private" ? "direct" : "group",
    isMention: false,
  };

  if (message.reply_to_message?.message_id != null) {
    inbound.threadContext = {
      starter: {
        messageId: String(message.reply_to_message.message_id),
        senderId:
          message.reply_to_message.from?.id != null
            ? String(message.reply_to_message.from.id)
            : null,
      },
    };
  }

  return inbound;
}
