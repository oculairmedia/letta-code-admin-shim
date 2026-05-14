/**
 * Tiny zero-dep markdown → HTML converter for outbound Matrix messages.
 *
 * Handles the subset Letta agents actually produce: **bold**, *italic*, _italic_,
 * `code`, ```fenced```, # headings, * / - bullet lists, 1. ordered lists,
 * [text](url) links, > blockquotes, --- hr, and paragraph wrapping.
 *
 * Not a full CommonMark parser — just enough to make agent output readable
 * in Element/SchildiChat without dragging in marked/remark.
 */

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

/**
 * Determine whether text "looks like markdown" enough to bother converting.
 * Plain prose without formatting → return null so we skip the HTML body.
 */
export function hasMarkdownSignals(text) {
  if (!text) return false;
  return (
    /(^|\s)[*_]{1,2}[^\s*_][^*_]*[*_]{1,2}(\s|$)/.test(text) ||
    /`[^`]+`/.test(text) ||
    /```/.test(text) ||
    /^\s*#{1,6}\s+/m.test(text) ||
    /^\s*[*\-]\s+/m.test(text) ||
    /^\s*\d+\.\s+/m.test(text) ||
    /\[([^\]]+)\]\(([^)]+)\)/.test(text) ||
    /^\s*>\s+/m.test(text) ||
    /^\s*---\s*$/m.test(text)
  );
}

function renderInline(text) {
  // Replace fenced/inline-safe spans by placeholders so emphasis doesn't run
  // through them.
  const placeholders = [];
  function stash(html) {
    placeholders.push(html);
    return `\x00P${placeholders.length - 1}\x00`;
  }

  let out = text;

  // Inline code first
  out = out.replace(/`([^`\n]+)`/g, (_, code) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  );

  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, url) =>
    stash(`<a href="${escapeAttr(url)}">${escapeHtml(t)}</a>`),
  );

  // Escape the rest
  out = escapeHtml(out);

  // Bold **x** or __x__
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  // Italic *x* or _x_ (avoid matching inside words)
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  // Strikethrough ~~x~~
  out = out.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  // Restore placeholders
  return out.replace(/\x00P(\d+)\x00/g, (_, i) => placeholders[Number(i)]);
}

export function markdownToHtml(text) {
  if (!text) return "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let inUl = false;
  let inOl = false;

  function closeLists() {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  }

  while (i < lines.length) {
    const raw = lines[i];

    // Fenced code blocks
    const fence = raw.match(/^\s*```(\w+)?\s*$/);
    if (fence) {
      closeLists();
      const lang = fence[1];
      const code = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      const langAttr = lang ? ` class="language-${escapeAttr(lang)}"` : "";
      out.push(`<pre><code${langAttr}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // Headings
    const heading = raw.match(/^\s*(#{1,6})\s+(.*?)\s*$/);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*---+\s*$/.test(raw)) {
      closeLists();
      out.push("<hr/>");
      i += 1;
      continue;
    }

    // Blockquote
    if (/^\s*>\s+/.test(raw)) {
      closeLists();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(quote.join("\n")).replace(/\n/g, "<br/>")}</blockquote>`);
      continue;
    }

    // Unordered list
    const ul = raw.match(/^\s*[*\-]\s+(.*)$/);
    if (ul) {
      if (!inUl) { closeLists(); out.push("<ul>"); inUl = true; }
      out.push(`<li>${renderInline(ul[1])}</li>`);
      i += 1;
      continue;
    }

    // Ordered list
    const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (!inOl) { closeLists(); out.push("<ol>"); inOl = true; }
      out.push(`<li>${renderInline(ol[1])}</li>`);
      i += 1;
      continue;
    }

    // Blank line → close lists, paragraph break
    if (/^\s*$/.test(raw)) {
      closeLists();
      i += 1;
      continue;
    }

    // Paragraph: gather consecutive non-special lines, render with <br/>
    closeLists();
    const para = [raw];
    i += 1;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[*\-]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s+/.test(lines[i]) &&
      !/^\s*---+\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${renderInline(para.join("\n")).replace(/\n/g, "<br/>")}</p>`);
  }
  closeLists();
  return out.join("");
}
