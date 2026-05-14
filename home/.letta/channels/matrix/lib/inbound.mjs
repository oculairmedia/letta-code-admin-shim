/**
 * Inbound timeline event → InboundChannelMessage conversion.
 *
 * Handles text, image, audio, video, file messages. Downloads attachments
 * to a local cache and wires them into the message.attachments[] field that
 * letta-code's runtime understands. Also extracts reply-context and mention
 * info.
 */

import { extractReplyContext, detectMention } from "./mentions.mjs";
import { downloadAttachment } from "./media.mjs";
import { shouldFilterOwnEcho } from "./echo.mjs";

const TEXT_MSGTYPES = new Set(["m.text", "m.notice", "m.emote"]);
const MEDIA_MSGTYPES = new Set(["m.image", "m.audio", "m.video", "m.file"]);

function chatTypeForRoom() {
  // No reliable way to know without joined-member count. Default to "direct"
  // for now — letta-code's routing/pairing handles channel vs direct.
  return "direct";
}

function eventBodyText(event) {
  const body = event?.content?.body;
  if (typeof body === "string") return body;
  return "";
}

function eventTimestamp(event) {
  const ts = event?.origin_server_ts;
  return typeof ts === "number" ? ts : Date.now();
}

export async function inboundFromTimelineEvent({
  channelId,
  accountId,
  roomId,
  event,
  selfUserId,
  client,
  mentionPatterns,
  dedupe,
  logger = console,
}) {
  if (!event || event.type !== "m.room.message") return null;
  if (event.sender === selfUserId) {
    // Self-message → only forward if NOT a streaming progress echo (otherwise
    // skip silently so we don't loop the bot's own activity).
    if (shouldFilterOwnEcho(event, selfUserId)) return null;
    // For non-progress self messages we still skip — the bot shouldn't reply
    // to itself in any case.
    return null;
  }

  const content = event.content ?? {};
  const msgtype = content.msgtype;

  // Dedupe based on event_id — defends against /sync retries / restarts.
  if (event.event_id && dedupe && !dedupe.mark(event.event_id)) {
    return null;
  }

  const text = eventBodyText(event);
  const attachments = [];

  if (MEDIA_MSGTYPES.has(msgtype)) {
    const attachment = await downloadAttachment({ client, event, accountId, logger });
    if (attachment) attachments.push(attachment);
  } else if (msgtype && !TEXT_MSGTYPES.has(msgtype)) {
    // Unknown msgtype — skip rather than guess
    return null;
  }

  // Allow either text or media — Matrix lets users send images with captions.
  if (!text && attachments.length === 0) return null;

  const mentionResult = detectMention(event, { selfUserId, mentionPatterns });
  const reply = extractReplyContext(event);

  const inbound = {
    channel: channelId,
    accountId,
    chatId: roomId,
    senderId: event.sender,
    senderName: event.sender,
    text,
    timestamp: eventTimestamp(event),
    messageId: event.event_id,
    threadId:
      content?.["m.relates_to"]?.rel_type === "m.thread"
        ? content?.["m.relates_to"]?.event_id ?? null
        : null,
    raw: event,
    chatType: chatTypeForRoom(),
    isMention: !!mentionResult?.wasMentioned || mentionResult?.method != null,
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  if (reply) {
    inbound.threadContext = {
      starter: { messageId: reply.messageId, senderId: reply.senderId },
    };
  }
  return inbound;
}
