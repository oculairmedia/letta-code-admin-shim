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
  supportedWidgets: ["Text", "Button", "Card", "List", "TextField", "ChoicePicker"],
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
  assert.deepEqual(capability.supportedWidgets, ["Text"]);

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
  assert.match(prompt, /Catalog: basic/);
  assert.doesNotMatch(prompt, /https:\/\/a2ui\.org\/specification\/v0_9\/basic_catalog\.json/);
  assert.match(prompt, /Do not set createSurface\.sendDataModel to true/);
  assert.match(prompt, /`<a2ui-json>` and `<\/a2ui-json>` tags/);
  assert.match(prompt, /---BEGIN A2UI JSON SCHEMA---/);

  // lcp-crp: per-turn injection retired (overflowed context on existing
  // chats). The A2UI contract now lives in a per-agent core-memory block;
  // augmentUserInputForA2ui is a no-op.
  const augmented = augmentUserInputForA2ui("show a booking form", capability);
  assert.equal(augmented, "show a booking form");

  const original = [{ type: "text", text: "hello" }];
  const contentParts = augmentUserInputForA2ui(original, capability);
  assert.equal(contentParts, original);
});

test("a2ui: system prompt includes sanitized client theme hints", () => {
  const capability = negotiateA2uiCapability({
    a2ui_version: "0.9",
    supported_catalogs: ["basic"],
    supported_widgets: ["Text", "Button"],
    theme_hints: { color_scheme: "dark", primaryColor: "#A1b2C3" },
  }, server);
  assert.ok(capability, "expected capability");

  const prompt = buildA2uiSystemPrompt(capability);
  assert.match(prompt, /Client theme hints for A2UI surfaces/);
  assert.match(prompt, /"color_scheme":"dark"/);
  assert.match(prompt, /"primaryColor":"#A1b2C3"/);
  assert.match(prompt, /strict 6-digit hex string/);
});

test("a2ui: invalid theme_hints.primaryColor is dropped before prompt injection", () => {
  const capability = negotiateA2uiCapability({
    a2ui_version: "0.9",
    supported_catalogs: ["basic"],
    supported_widgets: ["Text", "Button"],
    theme_hints: { color_scheme: "system", primaryColor: "#FFF" },
  }, server);
  assert.ok(capability, "expected capability");
  assert.deepEqual(capability.themeHints, { color_scheme: "system" });

  const prompt = buildA2uiSystemPrompt(capability);
  assert.match(prompt, /"color_scheme":"system"/);
  assert.doesNotMatch(prompt, /#FFF/);
});
