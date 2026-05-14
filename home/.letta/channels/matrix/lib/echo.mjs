/**
 * Echo filter — drop our own bot's streaming-progress messages so we don't
 * loop them back into the agent. Mirrors matrix-tuwunel-deploy's echo_filter.
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

function stripLeadingMxidPrefix(text) {
  const stripped = (text || "").trim();
  if (!stripped.startsWith("@")) return stripped;
  const [first, ...rest] = stripped.split(/\s+/, 2);
  if (!first.includes(":")) return stripped;
  if (!rest.length) return stripped;
  return rest[0];
}

export function isStreamingProgress(text) {
  const stripped = stripLeadingMxidPrefix(text);
  if (!stripped) return false;
  const nonEmpty = stripped.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (!nonEmpty.length) return false;
  return nonEmpty.every((line) =>
    STREAMING_PROGRESS_PREFIXES.some((prefix) => line.startsWith(prefix)),
  );
}

export function isNoTextFallback(text) {
  return NO_TEXT_FALLBACK_MARKERS.includes(stripLeadingMxidPrefix(text));
}

export function shouldFilterOwnEcho(event, selfUserId) {
  if (event?.sender !== selfUserId) return false;
  const body = event?.content?.body || "";
  return isStreamingProgress(body) || isNoTextFallback(body);
}
