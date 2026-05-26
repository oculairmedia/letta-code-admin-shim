import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  A2UI_BLOCK_LABEL,
  augmentUserInputForA2ui,
  buildA2uiSystemPrompt,
  ensureA2uiBlockAttached,
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

// lcp-qec: ensureA2uiBlockAttached is now strictly write-if-absent. Once
// the file exists on disk the agent owns it and the shim never overwrites.
// Pre-fix behavior overwrote any drift from the canonical template, which
// destroyed agent-curated corrections (including agents fixing bugs in the
// template itself).
test("a2ui: ensureA2uiBlockAttached scaffolds the file on first call", () => {
  const root = mkdtempSync(join(tmpdir(), "lcp-qec-a-"));
  const agentId = `agent-test-${Date.now()}-a`;
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = root;
  try {
    const blockPath = join(root, "memfs", agentId, "memory", "system", `${A2UI_BLOCK_LABEL}.md`);
    assert.equal(existsSync(blockPath), false, "precondition: file does not exist");
    ensureA2uiBlockAttached(agentId);
    assert.equal(existsSync(blockPath), true, "file was scaffolded");
    const body = readFileSync(blockPath, "utf8");
    assert.match(body, /A2UI Dynamic UI Protocol/);
    assert.match(body, /Component shape/);
  } finally {
    if (prev === undefined) {
      delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    } else {
      process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a2ui: ensureA2uiBlockAttached does NOT overwrite agent-curated content", () => {
  const root = mkdtempSync(join(tmpdir(), "lcp-qec-b-"));
  const agentId = `agent-test-${Date.now()}-b`;
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = root;
  const curated = "# Agent-owned A2UI notes\n\nMy carefully tuned protocol notes.\n";
  try {
    // Simulate an existing agent-owned file
    const sysDir = join(root, "memfs", agentId, "memory", "system");
    const blockPath = join(sysDir, `${A2UI_BLOCK_LABEL}.md`);
    mkdirSync(sysDir, { recursive: true });
    writeFileSync(blockPath, curated);

    // Call ensureA2uiBlockAttached and assert curated content survives
    ensureA2uiBlockAttached(agentId);
    const after = readFileSync(blockPath, "utf8");
    assert.equal(after, curated, "agent-curated content must NOT be overwritten");
  } finally {
    if (prev === undefined) {
      delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    } else {
      process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
