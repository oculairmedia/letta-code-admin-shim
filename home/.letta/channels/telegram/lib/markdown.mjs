/**
 * Zero-dep MarkdownV2 helpers for outbound Telegram messages.
 *
 * Telegram's MarkdownV2 dialect requires that EVERY one of these characters
 * be backslash-escaped anywhere it appears as literal text:
 *
 *     _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * `escapeMarkdownV2` escapes all of them — use it on any span that must be
 * rendered verbatim. `markdownToMarkdownV2` is a small converter that maps
 * the common Markdown an LLM emits (**bold**, *italic*, `code`, fenced
 * blocks, [text](url) links) into valid MarkdownV2 while escaping the
 * literal text around/inside those spans so the whole string is safe to send
 * with `parse_mode: "MarkdownV2"`.
 */

// The 18 reserved characters, per
// https://core.telegram.org/bots/api#markdownv2-style
const SPECIAL = new Set([
  "_", "*", "[", "]", "(", ")", "~", "`", ">",
  "#", "+", "-", "=", "|", "{", "}", ".", "!",
]);

/** Escape every reserved MarkdownV2 character in literal text. */
export function escapeMarkdownV2(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    if (SPECIAL.has(ch)) out += "\\";
    out += ch;
  }
  return out;
}

/**
 * Inside a `code`/pre entity only backtick and backslash are special
 * (everything else is literal). Telegram's docs require escaping ` and \.
 */
function escapeCodeMarkdownV2(text) {
  return String(text ?? "").replace(/[`\\]/g, (ch) => `\\${ch}`);
}

/** Inside a (url) target, only ) and \ must be escaped. */
function escapeUrlMarkdownV2(url) {
  return String(url ?? "").replace(/[)\\]/g, (ch) => `\\${ch}`);
}

// Private-use-area placeholder sentinel. escapeMarkdownV2 leaves it and
// ASCII digits untouched, so a stashed span's marker survives the
// literal-escape pass intact and can be restored afterwards.
const SENTINEL = "\uE000";

/**
 * Convert a subset of Markdown to MarkdownV2. Handles fenced code blocks,
 * inline code, links, bold (double-star / double-underscore), and italic
 * (single-star / single-underscore). Everything else is treated as literal
 * text and escaped. Not a full CommonMark parser — just enough to render
 * typical agent output without a parse error.
 */
export function markdownToMarkdownV2(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");

  const placeholders = [];
  const stash = (rendered) => {
    placeholders.push(rendered);
    return `${SENTINEL}${placeholders.length - 1}${SENTINEL}`;
  };

  let out = src;

  // Fenced code blocks ```lang\n...\n```
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) =>
    stash("```\n" + escapeCodeMarkdownV2(code.replace(/\n$/, "")) + "\n```"),
  );

  // Inline code `x`
  out = out.replace(/`([^`\n]+)`/g, (_, code) => stash("`" + escapeCodeMarkdownV2(code) + "`"));

  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    stash("[" + escapeMarkdownV2(label) + "](" + escapeUrlMarkdownV2(url) + ")"),
  );

  // Bold **x** / __x__ → *x*
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => stash("*" + escapeMarkdownV2(inner) + "*"));
  out = out.replace(/__([^_\n]+)__/g, (_, inner) => stash("*" + escapeMarkdownV2(inner) + "*"));

  // Italic *x* / _x_ → _x_
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, (_, pre, inner) =>
    pre + stash("_" + escapeMarkdownV2(inner) + "_"),
  );
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, (_, pre, inner) =>
    pre + stash("_" + escapeMarkdownV2(inner) + "_"),
  );

  // Escape all remaining literal text (sentinels + digits pass through).
  out = escapeMarkdownV2(out);

  // Restore the pre-rendered (already-escaped) spans.
  out = out.replace(new RegExp(SENTINEL + "(\\d+)" + SENTINEL, "g"), (_, i) => placeholders[Number(i)]);
  return out;
}

/**
 * Cheap "does this look like Markdown worth converting" probe. Plain prose
 * returns false so callers can skip parse_mode entirely and send raw text.
 */
export function hasMarkdownSignals(text) {
  if (!text) return false;
  return (
    /(^|\s)[*_]{1,2}[^\s*_][^*_]*[*_]{1,2}(\s|$)/.test(text) ||
    /`[^`]+`/.test(text) ||
    /```/.test(text) ||
    /\[([^\]]+)\]\(([^)]+)\)/.test(text)
  );
}
