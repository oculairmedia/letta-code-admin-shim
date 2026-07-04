/**
 * Outbound message dispatch for Telegram.
 *
 * The channel registry calls `adapter.sendMessage({ chatId, text, threadId,
 * markdown?, replyToMessageId? })`. When `markdown` is true the text is
 * converted to MarkdownV2 (with full reserved-character escaping) and sent
 * with `parse_mode: "MarkdownV2"`; otherwise it goes out as plain text.
 *
 * `threadId` maps to Telegram's `message_thread_id` (forum topics).
 */

import { markdownToMarkdownV2 } from "./markdown.mjs";

// Telegram rejects messages longer than 4096 UTF-16 code units. Split on a
// generous boundary so long agent turns are delivered in order rather than
// erroring out.
const MAX_LEN = 4096;

function chunk(text, size) {
  if (text.length <= size) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    // Prefer to break on the last newline within the budget, else hard-cut.
    let cut = rest.lastIndexOf("\n", size);
    if (cut <= 0) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) parts.push(rest);
  return parts;
}

export async function sendText(client, { chatId, text, markdown, threadId, replyToMessageId, signal }) {
  const useMarkdown = markdown === true;
  const rendered = useMarkdown ? markdownToMarkdownV2(text ?? "") : String(text ?? "");
  const chunks = chunk(rendered, MAX_LEN);

  // Telegram wants integers for message_thread_id (forum topic id) and for
  // the reply target — the host hands these back as strings off the inbound
  // record, so coerce before they hit the Bot API.
  const threadNum =
    threadId != null && threadId !== "" && Number.isFinite(Number(threadId))
      ? Number(threadId)
      : null;
  const replyNum =
    replyToMessageId != null && replyToMessageId !== "" && Number.isFinite(Number(replyToMessageId))
      ? Number(replyToMessageId)
      : null;

  let lastMessageId = null;
  for (let i = 0; i < chunks.length; i++) {
    const result = await client.sendMessage({
      chatId,
      text: chunks[i],
      ...(useMarkdown ? { parseMode: "MarkdownV2" } : {}),
      ...(threadNum != null ? { messageThreadId: threadNum } : {}),
      // Only the first chunk carries the reply linkage.
      ...(i === 0 && replyNum != null ? { replyToMessageId: replyNum } : {}),
      signal,
    });
    lastMessageId = result?.message_id != null ? String(result.message_id) : lastMessageId;
  }
  return { messageId: lastMessageId ?? `local-${Date.now()}` };
}
