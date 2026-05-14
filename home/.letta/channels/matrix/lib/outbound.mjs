/**
 * Outbound message formatting and dispatch (reactions / edits / deletes too).
 */

import { hasMarkdownSignals, markdownToHtml } from "./markdown.mjs";

export function buildTextContent({ text, parseMode, replyToMessageId, threadId }) {
  const content = { msgtype: "m.text", body: text };
  if (parseMode === "HTML") {
    content.format = "org.matrix.custom.html";
    content.formatted_body = text;
  } else if (hasMarkdownSignals(text)) {
    content.format = "org.matrix.custom.html";
    content.formatted_body = markdownToHtml(text);
  }
  const relates = {};
  if (replyToMessageId) {
    relates["m.in_reply_to"] = { event_id: replyToMessageId };
  }
  if (threadId) {
    relates.rel_type = "m.thread";
    relates.event_id = threadId;
    relates.is_falling_back = true;
    if (replyToMessageId) {
      relates["m.in_reply_to"] = { event_id: replyToMessageId };
    }
  }
  if (Object.keys(relates).length > 0) content["m.relates_to"] = relates;
  return content;
}

export function buildReactionContent({ targetMessageId, emoji }) {
  if (!targetMessageId) throw new Error("matrix: reaction requires targetMessageId");
  if (!emoji) throw new Error("matrix: reaction requires emoji");
  return {
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: targetMessageId,
      key: emoji,
    },
  };
}

export function buildEditContent({ messageId, text }) {
  const newContent = buildTextContent({ text });
  const display = { ...newContent, body: `* ${text}` };
  if (newContent.formatted_body) display.formatted_body = `* ${newContent.formatted_body}`;
  display["m.new_content"] = newContent;
  display["m.relates_to"] = { rel_type: "m.replace", event_id: messageId };
  return display;
}

function nextTxn(prefix = "letta") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function sendText(client, { roomId, text, parseMode, replyToMessageId, threadId }) {
  const content = buildTextContent({ text, parseMode, replyToMessageId, threadId });
  const result = await client.sendEvent({
    roomId,
    type: "m.room.message",
    txnId: nextTxn("letta"),
    body: content,
  });
  return { messageId: result?.event_id ?? `local-${Date.now()}` };
}

export async function sendReaction(client, { roomId, targetMessageId, emoji }) {
  const result = await client.sendEvent({
    roomId,
    type: "m.reaction",
    txnId: nextTxn("react"),
    body: buildReactionContent({ targetMessageId, emoji }),
  });
  return { messageId: result?.event_id ?? `local-${Date.now()}` };
}

export async function editMessage(client, { roomId, messageId, text }) {
  const content = buildEditContent({ messageId, text });
  const result = await client.sendEvent({
    roomId,
    type: "m.room.message",
    txnId: nextTxn("edit"),
    body: content,
  });
  return { messageId: result?.event_id ?? `local-${Date.now()}` };
}

export async function deleteMessage(client, { roomId, messageId, reason }) {
  const result = await client.redactEvent({
    roomId,
    eventId: messageId,
    txnId: nextTxn("redact"),
    reason,
  });
  return { messageId: result?.event_id ?? `local-${Date.now()}` };
}
