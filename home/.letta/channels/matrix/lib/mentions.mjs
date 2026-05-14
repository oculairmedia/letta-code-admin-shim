/**
 * Mention detection.
 *
 * Three methods, in priority order — same as matrix-tuwunel-deploy:
 *   1. Matrix pills via m.mentions.user_ids (MSC 3952)
 *   2. @localpart text matching (case-insensitive, word boundary)
 *   3. Custom regex patterns from account.config.mentionPatterns
 */

function extractLocalpart(mxid) {
  if (!mxid || !mxid.startsWith("@")) return "";
  return mxid.slice(1).split(":", 1)[0];
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkPill(event, selfUserId) {
  const userIds = event?.content?.["m.mentions"]?.user_ids;
  if (!Array.isArray(userIds)) return null;
  if (userIds.includes(selfUserId)) {
    return { method: "pill", matched: selfUserId };
  }
  return null;
}

function stripReplyFallback(text) {
  // Matrix replies often prepend a "> <@user> original\n\n" fallback. Strip it
  // so we don't match @user from the quoted text.
  if (!text || !text.startsWith("> ")) return text;
  const idx = text.indexOf("\n\n");
  return idx >= 0 ? text.slice(idx + 2) : text;
}

function checkTextMention(text, selfUserId) {
  const localpart = extractLocalpart(selfUserId);
  if (!localpart) return null;
  const stripped = stripReplyFallback(text);
  const re = new RegExp(`(^|\\W)@${escapeRegex(localpart)}\\b`, "i");
  const match = re.exec(stripped);
  if (match) return { method: "text", matched: `@${localpart}` };
  return null;
}

function checkRegex(text, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  const stripped = stripReplyFallback(text);
  for (const pattern of patterns) {
    try {
      const re = new RegExp(pattern, "i");
      const m = re.exec(stripped);
      if (m) return { method: "regex", matched: m[0] };
    } catch {
      // skip bad regex
    }
  }
  return null;
}

export function detectMention(event, { selfUserId, mentionPatterns } = {}) {
  if (!event) return { wasMentioned: false };
  const text = event?.content?.body || "";
  return (
    checkPill(event, selfUserId) ??
    checkTextMention(text, selfUserId) ??
    checkRegex(text, mentionPatterns) ??
    { wasMentioned: false }
  );
}

export function extractReplyContext(event) {
  const inReplyTo = event?.content?.["m.relates_to"]?.["m.in_reply_to"]?.event_id;
  if (!inReplyTo) return null;
  const replyToSender = event?.unsigned?.["m.in_reply_to_sender"] || null;
  return { messageId: inReplyTo, senderId: replyToSender ?? undefined };
}
