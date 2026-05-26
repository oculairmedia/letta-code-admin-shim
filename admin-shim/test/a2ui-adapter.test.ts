import { test } from "node:test";
import assert from "node:assert/strict";

import {
  augmentUserInputForA2ui,
  buildA2uiSystemPrompt,
  negotiateA2uiCapability,
  type A2uiServerCapabilities,
} from "../lib/a2ui-adapter.js";

const server: A2uiServerCapabilities = {
  enabled: true,
  version: "0.9",
  catalogId: "basic",
  roleDescription: "Test role",
  uiDescription: "Test UI",
  supportedCatalogs: ["basic"],
  supportedWidgets: ["Text", "Button", "ToolApprovalCard"],
};

test("a2ui: capability negotiation requires matching enabled server support", () => {
  const capability = negotiateA2uiCapability({
    a2ui_version: "0.9",
    supported_catalogs: ["basic"],
    supported_widgets: ["Text", "ToolApprovalCard"],
    theme_hints: { color_scheme: "dark" },
  }, server);

  assert.ok(capability, "expected valid capability");
  assert.equal(capability.version, "0.9");
  assert.equal(capability.catalogId, "basic");
  assert.deepEqual(capability.supportedWidgets, ["Text", "ToolApprovalCard"]);

  assert.equal(negotiateA2uiCapability({ a2ui_version: "0.8" }, server), null);
  assert.equal(negotiateA2uiCapability({ a2ui_version: "0.9" }, { ...server, enabled: false }), null);
});

test("a2ui: system prompt and user input augmentation include the v0.9 contract", () => {
  const capability = negotiateA2uiCapability({
    a2ui_version: "0.9",
    supported_catalogs: ["basic"],
    supported_widgets: ["Text", "Button"],
  }, server);
  assert.ok(capability, "expected capability");

  const prompt = buildA2uiSystemPrompt(capability);
  assert.match(prompt, /A2UI dynamic UI mode is enabled/);
  assert.match(prompt, /Target A2UI version: 0\.9/);
  assert.match(prompt, /`<a2ui-json>` and `<\/a2ui-json>` tags/);
  assert.match(prompt, /---BEGIN A2UI JSON SCHEMA---/);

  const augmented = augmentUserInputForA2ui("show a booking form", capability);
  assert.equal(typeof augmented, "string");
  assert.ok(typeof augmented === "string");
  assert.match(augmented, /A2UI dynamic UI mode is enabled/);
  assert.match(augmented, /User request:\nshow a booking form/);

  const contentParts = augmentUserInputForA2ui([{ type: "text", text: "hello" }], capability);
  assert.ok(Array.isArray(contentParts));
  assert.deepEqual(contentParts[1], { type: "text", text: "hello" });
});
