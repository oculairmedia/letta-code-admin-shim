import { test } from "node:test";
import assert from "node:assert/strict";
import { extractText, extractContent } from "../lib/chat.js";

test("extractText preserves image attachments as placeholders", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Here is my image:" },
          { type: "image", source: { type: "base64", data: "abcd" } }
        ]
      }
    ]
  };
  assert.equal(extractText(body), "Here is my image:[image]");
});

test("extractText handles image-only messages", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", data: "abcd" } }
        ]
      }
    ]
  };
  assert.equal(extractText(body), "[image]");
});

test("extractContent returns the parts array when images are present", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look:" },
          { type: "image", source: { type: "base64", data: "abcd" } }
        ]
      }
    ]
  };
  const content = extractContent(body);
  assert.ok(Array.isArray(content), "Should return an array of parts");
  assert.equal(content.length, 2);
  assert.equal((content[0] as Record<string, unknown>)["type"], "text");
  assert.equal((content[1] as Record<string, unknown>)["type"], "image");
});

test("extractContent falls back to plain string when no images are present", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Just text here" }
        ]
      }
    ]
  };
  const content = extractContent(body);
  assert.equal(typeof content, "string");
  assert.equal(content, "Just text here");
});

test("extractContent handles scalar text messages", () => {
  const body = { text: "Legacy caller" };
  const content = extractContent(body);
  assert.equal(content, "Legacy caller");
});
