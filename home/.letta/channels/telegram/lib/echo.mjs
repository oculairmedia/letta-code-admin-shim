/**
 * Echo filter — never feed the bot's own messages back into the agent.
 *
 * Two layers:
 *   1. Identity: any message whose `from.id` equals the bot's own id (cached
 *      from getMe at start) is dropped. Telegram normally does not deliver a
 *      bot its own sends, but channel/anonymous-admin edge cases and future
 *      Bot API changes make an explicit guard cheap insurance.
 *   2. Streaming-progress markers: mirrors the matrix plugin's echo filter —
 *      drop status pings the bot itself might have posted (🔧 💭 ✅ ❌ ⏳ ⚠️).
 */

const STREAMING_PROGRESS_PREFIXES = [
  "🔧 ", // tool call
  "✅ ", // success
  "❌ ", // failure
  "💭 ", // reasoning
  "⏳ ", // queued / waiting
  "⚠️ ", // error
];

const NO_TEXT_FALLBACK_MARKERS = ["(no reply)", "[no text response]"];

export function isStreamingProgress(text) {
  const stripped = (text || "").trim();
  if (!stripped) return false;
  const nonEmpty = stripped.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (!nonEmpty.length) return false;
  return nonEmpty.every((line) =>
    STREAMING_PROGRESS_PREFIXES.some((prefix) => line.startsWith(prefix)),
  );
}

export function isNoTextFallback(text) {
  return NO_TEXT_FALLBACK_MARKERS.includes((text || "").trim());
}

/**
 * Returns true when a Telegram message should be filtered as our own echo.
 * `selfId` is the numeric bot id from getMe.
 */
export function shouldFilterOwnEcho(message, selfId) {
  const fromId = message?.from?.id;
  if (selfId != null && fromId != null && fromId === selfId) return true;
  if (message?.from?.is_bot === true && message?.via_bot?.id === selfId) return true;
  const body = typeof message?.text === "string" ? message.text : "";
  return isStreamingProgress(body) || isNoTextFallback(body);
}
