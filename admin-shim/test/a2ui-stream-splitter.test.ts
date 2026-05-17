import { test } from "node:test";
import assert from "node:assert/strict";

import {
  A2uiStreamSplitter,
  validateA2uiMessage,
} from "../lib/a2ui-stream-splitter.js";

// Helper: feed a list of deltas, return the concatenated text + frames.
function runChunks(splitter: A2uiStreamSplitter, deltas: string[]): {
  text: string;
  frames: ReturnType<A2uiStreamSplitter["feed"]>["frames"];
  flush: ReturnType<A2uiStreamSplitter["flush"]>;
} {
  let text = "";
  const frames: ReturnType<A2uiStreamSplitter["feed"]>["frames"] = [];
  for (const d of deltas) {
    const out = splitter.feed(d);
    text += out.text;
    frames.push(...out.frames);
  }
  const flush = splitter.flush();
  text += flush.text;
  return { text, frames, flush };
}

test("a2ui-splitter: single feed with no tags emits text verbatim", () => {
  const sp = new A2uiStreamSplitter();
  const out = sp.feed("hello world");
  assert.equal(out.text, "hello world");
  assert.equal(out.frames.length, 0);
  assert.deepEqual(sp.flush(), { text: "", unclosed: false });
});

test("a2ui-splitter: a complete tag in one feed extracts the block and strips it from text", () => {
  const sp = new A2uiStreamSplitter();
  const out = sp.feed("hello <a2ui-json>{\"version\":\"v0.9\"}</a2ui-json> world");
  assert.equal(out.text, "hello  world");
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0]!.raw, '{"version":"v0.9"}');
  assert.deepEqual(out.frames[0]!.parsed, { version: "v0.9" });
  assert.equal(out.frames[0]!.parseError, null);
  // No validator wired — ok flips on parse-only success.
  assert.equal(out.frames[0]!.ok, true);
});

test("a2ui-splitter: tag split across many chunks reassembles correctly", () => {
  const sp = new A2uiStreamSplitter();
  const deltas = [
    "hello ",
    "<a2ui-",
    "json>",
    "{\"version\":",
    "\"v0.9\",",
    "\"deleteSurface\":{\"surfaceId\":\"s1\"}}",
    "</a2ui-",
    "json>",
    " bye",
  ];
  const out = runChunks(sp, deltas);
  assert.equal(out.text, "hello  bye");
  assert.equal(out.frames.length, 1);
  assert.deepEqual(out.frames[0]!.parsed, {
    version: "v0.9",
    deleteSurface: { surfaceId: "s1" },
  });
  assert.equal(out.flush.unclosed, false);
});

test("a2ui-splitter: hold-back keeps partial-tag bytes out of text until disambiguated", () => {
  const sp = new A2uiStreamSplitter();
  // After feeding "hello <a2ui-" the splitter must NOT emit the trailing
  // partial tag — it has to wait to see whether `json>` arrives.
  const first = sp.feed("hello <a2ui-");
  assert.equal(first.text, "hello ");
  assert.equal(first.frames.length, 0);
  // If we instead get unrelated text after the partial, the held-back
  // bytes must flush to text on the next non-matching delta.
  const second = sp.feed("nope");
  assert.equal(second.text, "<a2ui-nope");
  assert.equal(second.frames.length, 0);
});

test("a2ui-splitter: closing-tag split across chunks does not leak partial </a2ui- into json", () => {
  const sp = new A2uiStreamSplitter();
  const out = runChunks(sp, [
    "<a2ui-json>{\"version\":\"v0.9\",\"deleteSurface\":{\"surfaceId\":\"sx\"}}</a",
    "2ui-json>tail",
  ]);
  assert.equal(out.text, "tail");
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0]!.parseError, null);
  assert.deepEqual(out.frames[0]!.parsed, {
    version: "v0.9",
    deleteSurface: { surfaceId: "sx" },
  });
});

test("a2ui-splitter: multiple A2UI blocks in one stream all emit", () => {
  const sp = new A2uiStreamSplitter();
  const stream =
    "first <a2ui-json>{\"a\":1}</a2ui-json> middle " +
    "<a2ui-json>{\"a\":2}</a2ui-json> last";
  const out = sp.feed(stream);
  assert.equal(out.text, "first  middle  last");
  assert.equal(out.frames.length, 2);
  assert.deepEqual(out.frames[0]!.parsed, { a: 1 });
  assert.deepEqual(out.frames[1]!.parsed, { a: 2 });
});

test("a2ui-splitter: malformed JSON inside a tag produces a frame flagged !ok with parseError", () => {
  const sp = new A2uiStreamSplitter();
  const out = sp.feed("x <a2ui-json>{not-json</a2ui-json> y");
  assert.equal(out.text, "x  y");
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0]!.ok, false);
  assert.ok(out.frames[0]!.parseError && out.frames[0]!.parseError.length > 0);
});

test("a2ui-splitter: unclosed tag at flush is reported and dropped", () => {
  const sp = new A2uiStreamSplitter();
  const out = sp.feed("oh hello <a2ui-json>{\"version\":\"v0.9\"}");
  assert.equal(out.text, "oh hello ");
  assert.equal(out.frames.length, 0);
  const flush = sp.flush();
  assert.equal(flush.unclosed, true);
  assert.equal(flush.text, "");
});

test("a2ui-splitter: validator hook flags invalid messages without affecting parse success", () => {
  const sp = new A2uiStreamSplitter({ validate: validateA2uiMessage });
  const out = sp.feed("<a2ui-json>{\"version\":\"v0.9\"}</a2ui-json>");
  assert.equal(out.frames.length, 1);
  // Parseable but doesn't include any of the v0.9 message variants.
  assert.equal(out.frames[0]!.parseError, null);
  assert.equal(out.frames[0]!.ok, false);
  assert.match(out.frames[0]!.validationError ?? "", /createSurface|updateComponents|updateDataModel|deleteSurface/);
});

test("a2ui-splitter: validator accepts a well-formed createSurface message", () => {
  const sp = new A2uiStreamSplitter({ validate: validateA2uiMessage });
  const body = JSON.stringify({
    version: "v0.9",
    createSurface: { surfaceId: "s1", catalogId: "basic" },
  });
  const out = sp.feed(`<a2ui-json>${body}</a2ui-json>`);
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0]!.ok, true);
  assert.equal(out.frames[0]!.validationError, null);
});

test("a2ui-splitter: validator rejects top-level arrays; emit multiple blocks instead", () => {
  const sp = new A2uiStreamSplitter({ validate: validateA2uiMessage });
  const body = JSON.stringify([
    { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "s1",
        components: [{ id: "root", component: "Text" }],
      },
    },
  ]);
  const out = sp.feed(`<a2ui-json>${body}</a2ui-json>`);
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0]!.ok, false);
  assert.match(out.frames[0]!.validationError ?? "", /top-level arrays/);
});

test("validateA2uiMessage: rejects missing surfaceId, missing catalogId, empty components", () => {
  assert.match(
    validateA2uiMessage({ version: "v0.9", createSurface: { catalogId: "basic" } }) ?? "",
    /surfaceId/,
  );
  assert.match(
    validateA2uiMessage({ version: "v0.9", createSurface: { surfaceId: "s1" } }) ?? "",
    /catalogId/,
  );
  assert.match(
    validateA2uiMessage(
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json" } },
      { expectedCatalogId: "basic" },
    ) ?? "",
    /negotiated catalog basic/,
  );
  assert.match(
    validateA2uiMessage({ version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic", sendDataModel: true } }) ?? "",
    /sendDataModel=true is not supported/,
  );
  assert.match(
    validateA2uiMessage({ version: "v0.9", updateComponents: { surfaceId: "s1", components: [] } }) ?? "",
    /non-empty components/,
  );
  assert.match(
    validateA2uiMessage({
      version: "v0.9",
      updateComponents: {
        surfaceId: "s1",
        components: [{ id: "x" }],
      },
    }) ?? "",
    /component discriminator/,
  );
});

test("a2ui-splitter: metrics callback fires with stable schema on flush", () => {
  let captured: unknown = null;
  const sp = new A2uiStreamSplitter({
    validate: validateA2uiMessage,
    onMetrics: (metrics) => { captured = metrics; },
  });
  sp.feed('<a2ui-json>{"version":"v0.9","updateComponents":{"surfaceId":"s1","components":[{"id":"root","component":"Text"}]}}</a2ui-json>');
  sp.flush();

  assert.ok(captured, "expected metrics callback");
  const metrics = captured as Record<string, unknown>;
  assert.equal(metrics["total_frames"], 1);
  assert.equal(metrics["parse_ok"], 1);
  assert.equal(metrics["parse_err"], 0);
  assert.equal(metrics["validate_ok"], 1);
  assert.equal(metrics["validate_err"], 0);
  assert.deepEqual(metrics["widget_types_seen"], ["Text"]);
  assert.equal(typeof metrics["splitter_overhead_ms"], "number");
});

test("a2ui-splitter: parse and validation failure callbacks include diagnostics", () => {
  const parseErrors: string[] = [];
  const validationErrors: Array<{ error: string; widgetType: string | null }> = [];
  const sp = new A2uiStreamSplitter({
    validate: validateA2uiMessage,
    onParseError: (_raw, error) => { parseErrors.push(error); },
    onValidationError: (_raw, error, widgetType) => { validationErrors.push({ error, widgetType }); },
  });
  sp.feed('<a2ui-json>{"version":"v0.9"</a2ui-json>');
  sp.feed('<a2ui-json>{"version":"v0.9","updateComponents":{"surfaceId":"s1","components":[{"id":"root"}]}}</a2ui-json>');

  assert.equal(parseErrors.length, 1);
  assert.equal(validationErrors.length, 1);
  assert.match(validationErrors[0]!.error, /component discriminator/);
  assert.equal(validationErrors[0]!.widgetType, null);
});
