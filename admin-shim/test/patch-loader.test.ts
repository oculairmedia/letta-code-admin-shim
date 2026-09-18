import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  patchLettaCodeSourceForTest,
  patchLettaCodeSourceResultForTest,
} from "../scripts/letta-code-patch-loader.mjs";
import { VISION_MODEL_PATTERNS } from "../lib/model-catalog.js";

// Use this for LEGACY / dev-dep assertions — the pinned admin-shim
// node_modules copy (0.19.x as of writing). For modern anchors (>=0.27.x)
// use `resolveDeployedLettaBundle()` instead, which probes the live runtime
// bundle that `LETTA_CLI_PATH_REAL` points at in production.
//
// Resolve the REAL letta.js bundle so the guard test works in CI
// (admin-shim/node_modules/...) AND locally — never a machine-specific
// absolute path. `letta.js` is NOT an exported subpath, so resolve the
// package root via package.json and join the bundle filename to its dir.
function resolveLettaBundle(): string | null {
  // The package's strict `exports` map blocks require.resolve of subpaths
  // (including package.json), so walk node_modules by filesystem: from this
  // test file up to filesystem root, check <dir>/node_modules/@letta-ai/
  // letta-code/letta.js. Covers admin-shim/node_modules (CI) and any parent.
  const rel = "node_modules/@letta-ai/letta-code/letta.js";
  let dir = dirname(new URL(import.meta.url).pathname);
  for (;;) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No deployed / global-bun fallback here — that role belongs to
  // `resolveDeployedLettaBundle()`. Keeping this resolver scoped to the
  // pinned dev dep prevents a stale global install from silently
  // satisfying a test that the deployed bundle would have failed.
  return null;
}

type ThinkingPayload = {
  model?: string;
  thinking?: { type: string; budget_tokens?: number };
};

type ModelSettingsPayload = {
  provider_type?: string;
  thinking?: { type: string; budget_tokens?: number };
};

declare global {
  var __lcpFixThinking: ((payload: ThinkingPayload) => ThinkingPayload) | undefined;
  var __lcpFixModelSettings:
    | ((payload: ModelSettingsPayload) => ModelSettingsPayload)
    | undefined;
  var __lcpFixLocalVisionInput:
    | ((providerName: string, modelId: string, input: string[]) => string[])
    | undefined;
  var __lcpCoerceToolReturnContent: ((value: unknown) => unknown) | undefined;
  var __lcpAddGenerateImageTool:
    | ((
        toolDefinitions: Record<string, unknown>,
        defineToolFn: (cfg: { schema: unknown; description: unknown; impl: unknown }) => unknown,
      ) => Record<string, unknown>)
    | undefined;
}

function readInjectedThinkingHelper(): unknown {
  return (globalThis as typeof globalThis & { __lcpFixThinking?: unknown }).__lcpFixThinking;
}

function readInjectedModelSettingsHelper(): unknown {
  return (globalThis as typeof globalThis & { __lcpFixModelSettings?: unknown })
    .__lcpFixModelSettings;
}

function readInjectedLocalVisionInputHelper(): unknown {
  return (globalThis as typeof globalThis & { __lcpFixLocalVisionInput?: unknown })
    .__lcpFixLocalVisionInput;
}

function readInjectedToolReturnContentHelper(): unknown {
  return (globalThis as typeof globalThis & { __lcpCoerceToolReturnContent?: unknown })
    .__lcpCoerceToolReturnContent;
}

test("patch-loader normalizes thinking requests and model_settings inheritance", () => {
  const source = [
    "#!/usr/bin/env node",
    "this.store.settleInterruptedToolCalls(conversationId, {",
    "        reason: TURN_DID_NOT_COMPLETE",
    "      });",
    "thinking = {",
    "        type: updateArgs?.enable_reasoner === false ? \"disabled\" : \"enabled\",",
    "        ...typeof updateArgs?.max_reasoning_tokens === \"number\" && {",
    "          budget_tokens: updateArgs.max_reasoning_tokens",
    "        }",
    "      };",
    "  if (options3?.metadata) {",
    "    const userId = options3.metadata.user_id;",
    "client.beta.messages.create({ ...params, stream: true });",
    "client.beta.messages.stream({ ...params });",
    "function buildModelSettings() {",
    "  return modelSettings;",
    "}",
    "const effectiveAgent = {",
    "    model_settings: {",
    "      ...agent2.model_settings,",
    "      ...conversationModelSettings2 ?? {},",
    "      ...typeof conversationRecord.context_window_limit === \"number\" ? { context_window_limit: conversationRecord.context_window_limit } : {}",
    "    }",
    "};",
    "",
  ].join("\n");

  const patched = patchLettaCodeSourceForTest(source);

  assert.ok(patched.startsWith("#!/usr/bin/env node\nglobalThis.__lcpFixModelSettings"));
  assert.match(patched, /agentId: body\?\.agent_id \?\? this\.store\?\.resolveAgentIdForConversation/);
  assert.match(patched, /LETTA_CODE_THINKING_BUDGET_TOKENS/u);
  assert.match(patched, /messages\.create\(\{ \.\.\.globalThis\.__lcpFixThinking\(params\),/);
  assert.match(patched, /messages\.stream\(\{ \.\.\.globalThis\.__lcpFixThinking\(params\)/);
  assert.match(patched, /return globalThis\.__lcpFixModelSettings\(modelSettings\);/);
  assert.match(patched, /model_settings: globalThis\.__lcpFixModelSettings\(\{/);
});

test("patch-loader: normalizes Anthropic create and stream chokepoints", () => {
  const input = [
    "#!/usr/bin/env node",
    "const createResponse = await client.messages.create({ ...params, stream: true }, requestOptions);",
    "const stream = this.client.beta.messages.stream({ ...params }, options);",
  ].join("\n");

  const patched = patchLettaCodeSourceForTest(input);

  assert.ok(patched.startsWith("#!/usr/bin/env node\n"), "keeps the shebang on line 1");
  assert.match(patched, /globalThis\.__lcpFixThinking = globalThis\.__lcpFixThinking/);
  assert.match(
    patched,
    /client\.messages\.create\(\{ \.\.\.globalThis\.__lcpFixThinking\(params\), stream: true \}/,
  );
  assert.match(
    patched,
    /this\.client\.beta\.messages\.stream\(\{ \.\.\.globalThis\.__lcpFixThinking\(params\) \}/,
  );
});

test("patch-loader: enabled thinking without budget receives configured default", () => {
  const previousBudget = process.env["LETTA_CODE_THINKING_BUDGET_TOKENS"];
  process.env["LETTA_CODE_THINKING_BUDGET_TOKENS"] = "7777";
  try {
    const input = "const stream = this.client.beta.messages.stream({ ...params }, options);";
    const patched = patchLettaCodeSourceForTest(input);

    const helperStart = patched.indexOf("globalThis.__lcpFixThinking =");
    const helperEnd = patched.indexOf("\nconst stream", helperStart);
    assert.notEqual(helperStart, -1);
    assert.notEqual(helperEnd, -1);

    const helperSource = patched.slice(helperStart, helperEnd);
    globalThis.__lcpFixThinking = undefined;
    eval(helperSource);

    const fixThinking = readInjectedThinkingHelper();
    if (typeof fixThinking !== "function") {
      assert.fail("expected __lcpFixThinking helper to be installed");
    }
    const normalized = fixThinking({
      model: "claude-sonnet",
      thinking: { type: "enabled" },
    });

    assert.deepEqual(normalized.thinking, { type: "enabled", budget_tokens: 7777 });
  } finally {
    if (previousBudget === undefined) {
      delete process.env["LETTA_CODE_THINKING_BUDGET_TOKENS"];
    } else {
      process.env["LETTA_CODE_THINKING_BUDGET_TOKENS"] = previousBudget;
    }
    globalThis.__lcpFixThinking = undefined;
  }
});

test("patch-loader: model settings patch adds enabled thinking budget fallback", () => {
  const input = [
    "let thinking;",
    "thinking = {",
    "        type: updateArgs?.enable_reasoner === false ? \"disabled\" : \"enabled\",",
    "        ...typeof updateArgs?.max_reasoning_tokens === \"number\" && {",
    "          budget_tokens: updateArgs.max_reasoning_tokens",
    "        }",
    "      };",
  ].join("\n");

  const patched = patchLettaCodeSourceForTest(input);

  assert.match(patched, /updateArgs\?\.enable_reasoner !== false && \{/);
  assert.match(patched, /Math\.floor\(Number\(process\.env\.LETTA_CODE_THINKING_BUDGET_TOKENS \|\| 10000\)\)/);
  assert.doesNotMatch(patched, /type: updateArgs\?\.enable_reasoner === false[\s\S]*\.\.\.typeof updateArgs\?\.max_reasoning_tokens/);
});

test("patch-loader: normalizes persisted model_settings thinking", () => {
  const previousBudget = process.env["LETTA_CODE_THINKING_BUDGET_TOKENS"];
  process.env["LETTA_CODE_THINKING_BUDGET_TOKENS"] = "8888";
  try {
    const input = [
      "function supportedModelSettingsFromBody(bodyRecord) {",
      "  const modelSettings = isRecord(bodyRecord.model_settings) ? { ...bodyRecord.model_settings } : {};",
      "  return modelSettings;",
      "}",
      "function effectiveAgentForConversation(agent2, conversation) {",
      "  const conversationRecord = conversation;",
      "  const conversationModelSettings2 = isRecord(conversationRecord.model_settings) ? conversationRecord.model_settings : undefined;",
      "  return {",
      "    ...agent2,",
      "    model_settings: {",
      "      ...agent2.model_settings,",
      "      ...conversationModelSettings2 ?? {},",
      "      ...typeof conversationRecord.context_window_limit === \"number\" ? { context_window_limit: conversationRecord.context_window_limit } : {}",
      "    }",
      "  };",
      "}",
    ].join("\n");

    const patched = patchLettaCodeSourceForTest(input);

    assert.match(patched, /globalThis\.__lcpFixModelSettings = globalThis\.__lcpFixModelSettings/);
    assert.match(patched, /return globalThis\.__lcpFixModelSettings\(modelSettings\);/);
    assert.match(patched, /model_settings: globalThis\.__lcpFixModelSettings\(\{/);

    const helperStart = patched.indexOf("globalThis.__lcpFixModelSettings =");
    const helperEnd = patched.indexOf("\nfunction supportedModelSettingsFromBody", helperStart);
    assert.notEqual(helperStart, -1);
    assert.notEqual(helperEnd, -1);

    const helperSource = patched.slice(helperStart, helperEnd);
    globalThis.__lcpFixModelSettings = undefined;
    eval(helperSource);

    const fixModelSettings = readInjectedModelSettingsHelper();
    if (typeof fixModelSettings !== "function") {
      assert.fail("expected __lcpFixModelSettings helper to be installed");
    }

    assert.deepEqual(
      fixModelSettings({ provider_type: "anthropic", thinking: { type: "enabled" } }).thinking,
      { type: "enabled", budget_tokens: 8888 },
    );
    assert.deepEqual(
      fixModelSettings({ provider_type: "anthropic", thinking: { type: "disabled", budget_tokens: 8888 } }).thinking,
      { type: "disabled" },
    );
  } finally {
    if (previousBudget === undefined) {
      delete process.env["LETTA_CODE_THINKING_BUDGET_TOKENS"];
    } else {
      process.env["LETTA_CODE_THINKING_BUDGET_TOKENS"] = previousBudget;
    }
    globalThis.__lcpFixModelSettings = undefined;
  }
});

test("patch-loader: adds local vision input for discovered Claude-style models", () => {
  const previousExperimental = process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"];
  const input = [
    "function registeredModelToPiModel(input) {",
    "  return {",
    "    id: input.model.id,",
    "    input: input.model.input,",
    "  };",
    "}",
  ].join("\n");

  try {
    process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"] = "1";
    const patched = patchLettaCodeSourceForTest(input);

    assert.match(patched, /globalThis\.__lcpFixLocalVisionInput =/);
    assert.match(
      patched,
      /input: globalThis\.__lcpFixLocalVisionInput\(input\.providerName, input\.model\.id, input\.model\.input\),/,
    );

    const helperStart = patched.indexOf("globalThis.__lcpFixLocalVisionInput =");
    const helperEnd = patched.indexOf("\nfunction registeredModelToPiModel", helperStart);
    assert.notEqual(helperStart, -1);
    assert.notEqual(helperEnd, -1);

    const helperSource = patched.slice(helperStart, helperEnd);
    globalThis.__lcpFixLocalVisionInput = undefined;
    eval(helperSource);

    const fixInput = readInjectedLocalVisionInputHelper();
    if (typeof fixInput !== "function") {
      assert.fail("expected __lcpFixLocalVisionInput helper to be installed");
    }

    assert.deepEqual(fixInput("lmstudio", "claude-opus-4-8", ["text"]), ["text", "image"]);
    assert.deepEqual(fixInput("lmstudio", "plain-text-model", ["text"]), ["text"]);
    assert.deepEqual(fixInput("lmstudio", "claude-opus-4-8", ["text", "image"]), ["text", "image"]);
  } finally {
    if (previousExperimental === undefined) {
      delete process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"];
    } else {
      process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"] = previousExperimental;
    }
    globalThis.__lcpFixLocalVisionInput = undefined;
  }
});

// lcp-9d76: REGRESSION GUARD — the vision image flag must NOT depend on
// LETTA_VISION_MODELS being present in the environment. The shim sets that
// env var at runtime (server.ts, from VISION_MODEL_PATTERNS), but if it is
// ever dropped from the service environment (as happened 2026-06-21 when the
// systemd unit lacked it and the runtime process.env assignment did not
// propagate to the spawned letta.js child), images would be silently stripped
// with "(image omitted: model does not support images)". The patch-loader
// helper MUST fall back to a hardcoded vision-model regex so an unset/empty
// LETTA_VISION_MODELS still enables image input for known vision families.
// This test FAILS if someone removes that fallback and makes the helper
// rely solely on the env var.
test("patch-loader: vision input is default-safe when LETTA_VISION_MODELS is unset", () => {
  const previousExperimental = process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"];
  const previousVisionModels = process.env["LETTA_VISION_MODELS"];
  const input = [
    "function registeredModelToPiModel(input) {",
    "  return {",
    "    id: input.model.id,",
    "    input: input.model.input,",
    "  };",
    "}",
  ].join("\n");

  try {
    process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"] = "1";
    // The exact failure mode from lcp-9d76: env var absent entirely.
    delete process.env["LETTA_VISION_MODELS"];

    const patched = patchLettaCodeSourceForTest(input);
    const helperStart = patched.indexOf("globalThis.__lcpFixLocalVisionInput =");
    const helperEnd = patched.indexOf("\nfunction registeredModelToPiModel", helperStart);
    assert.notEqual(helperStart, -1);
    assert.notEqual(helperEnd, -1);

    const helperSource = patched.slice(helperStart, helperEnd);
    globalThis.__lcpFixLocalVisionInput = undefined;
    eval(helperSource);

    const fixInput = readInjectedLocalVisionInputHelper();
    if (typeof fixInput !== "function") {
      assert.fail("expected __lcpFixLocalVisionInput helper to be installed");
    }

    // Known vision families must still get "image" with NO env list present.
    assert.deepEqual(
      fixInput("lmstudio", "opus-4-8", ["text"]),
      ["text", "image"],
      "opus must be vision-capable even with LETTA_VISION_MODELS unset",
    );
    assert.deepEqual(
      fixInput("lmstudio", "claude-sonnet-4-5", ["text"]),
      ["text", "image"],
      "claude/sonnet must be vision-capable even with LETTA_VISION_MODELS unset",
    );
    assert.deepEqual(
      fixInput("lmstudio", "minimax-m3", ["text"]),
      ["text", "image"],
      "minimax must be vision-capable even with LETTA_VISION_MODELS unset",
    );
    // Non-vision model must NOT be promoted.
    assert.deepEqual(
      fixInput("lmstudio", "plain-text-model", ["text"]),
      ["text"],
      "non-vision model must not get image input",
    );
  } finally {
    if (previousExperimental === undefined) {
      delete process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"];
    } else {
      process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"] = previousExperimental;
    }
    if (previousVisionModels === undefined) {
      delete process.env["LETTA_VISION_MODELS"];
    } else {
      process.env["LETTA_VISION_MODELS"] = previousVisionModels;
    }
    globalThis.__lcpFixLocalVisionInput = undefined;
  }
});

// lcp-9d76: the patch-loader's hardcoded fallback regex (used when
// LETTA_VISION_MODELS is unset) must stay in sync with the canonical
// VISION_MODEL_PATTERNS in lib/model-catalog.ts. If a new vision family is
// added to VISION_MODEL_PATTERNS but not to the fallback regex, an env-less
// process would silently strip images for that family. This test FAILS on
// that drift.
test("patch-loader: fallback regex covers every VISION_MODEL_PATTERNS entry", () => {
  const previousExperimental = process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"];
  const previousVisionModels = process.env["LETTA_VISION_MODELS"];
  // NOTE: this must match the patch-loader's LOCAL_VISION_INPUT_TOKEN exactly
  // (`input: input.model.input,` — trailing comma, on its own line) so the
  // helper is actually injected. A single-line body without the trailing
  // comma does NOT match and the helper is never installed.
  const input = [
    "function registeredModelToPiModel(input) {",
    "  return {",
    "    id: input.model.id,",
    "    input: input.model.input,",
    "  };",
    "}",
  ].join("\n");
  try {
    process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"] = "1";
    delete process.env["LETTA_VISION_MODELS"];
    const patched = patchLettaCodeSourceForTest(input);
    const helperStart = patched.indexOf("globalThis.__lcpFixLocalVisionInput =");
    const helperEnd = patched.indexOf("\nfunction registeredModelToPiModel", helperStart);
    assert.notEqual(helperStart, -1, "vision helper must be injected");
    assert.notEqual(helperEnd, -1);
    const helperSource = patched.slice(helperStart, helperEnd);
    globalThis.__lcpFixLocalVisionInput = undefined;
    eval(helperSource);
    const fixInput = readInjectedLocalVisionInputHelper() as (
      p: string,
      m: string,
      i: string[],
    ) => string[];
    if (typeof fixInput !== "function") {
      assert.fail("expected __lcpFixLocalVisionInput helper to be installed");
    }

    for (const pattern of VISION_MODEL_PATTERNS) {
      // Build a model id that contains the pattern verbatim (lowercased).
      const modelId = `test-${pattern}-model`;
      assert.deepEqual(
        fixInput("lmstudio", modelId, ["text"]),
        ["text", "image"],
        `fallback regex must match VISION_MODEL_PATTERNS entry "${pattern}" (model id "${modelId}")`,
      );
    }
  } finally {
    if (previousExperimental === undefined) {
      delete process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"];
    } else {
      process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"] = previousExperimental;
    }
    if (previousVisionModels === undefined) {
      delete process.env["LETTA_VISION_MODELS"];
    } else {
      process.env["LETTA_VISION_MODELS"] = previousVisionModels;
    }
    globalThis.__lcpFixLocalVisionInput = undefined;
  }
});

test("patch-loader: preserves raw multimodal Read tool returns on stream chunks", () => {
  const input = [
    "const toolResult = await executeTool(decision.approval.toolName, parsedArgs, {});",
    "onChunk({",
    "  message_type: \"tool_return_message\",",
    "  tool_return: getDisplayableToolReturn(toolResult.toolReturn),",
    "  status: toolResult.status,",
    "});",
    "return {",
    "  type: \"tool\",",
    "  tool_return: toolResult.toolReturn,",
    "};",
  ].join("\n");

  const patched = patchLettaCodeSourceForTest(input);

  assert.match(patched, /tool_return: toolResult\.toolReturn,/);
  assert.doesNotMatch(patched, /tool_return: getDisplayableToolReturn\(toolResult\.toolReturn\),/);
});

test("patch-loader: converts legacy Read image tool returns before approval normalization", () => {
  const input = [
    "function normalizeToolReturnText(value) {",
    "  if (Array.isArray(value)) return value.filter((part) => part.type === \"text\").map((part) => part.text).join(\"\\n\").trim();",
    "  return typeof value === \"string\" ? value : JSON.stringify(value);",
    "}",
    "function isToolReturnContent(value) {",
    "  if (typeof value === \"string\")",
    "    return true;",
    "  if (!Array.isArray(value))",
    "    return false;",
    "  return value.every((part) => !!part && typeof part === \"object\" && (\"type\" in part) && (part.type === \"text\" && (\"text\" in part) && typeof part.text === \"string\" || part.type === \"image\" && (\"data\" in part) && typeof part.data === \"string\" && (\"mimeType\" in part) && typeof part.mimeType === \"string\"));",
    "}",
    "function coerceToolReturnContent(value) {",
    "  if (isToolReturnContent(value))",
    "    return value;",
    "  return normalizeToolReturnText(value);",
    "}",
  ].join("\n");

  const patched = patchLettaCodeSourceForTest(input);

  assert.match(patched, /globalThis\.__lcpCoerceToolReturnContent =/);
  assert.match(patched, /return globalThis\.__lcpCoerceToolReturnContent\(value\);/);

  const helperStart = patched.indexOf("globalThis.__lcpCoerceToolReturnContent =");
  const helperEnd = patched.indexOf("\nfunction normalizeToolReturnText", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);

  const helperSource = patched.slice(helperStart, helperEnd);
  globalThis.__lcpCoerceToolReturnContent = undefined;
  eval(helperSource);

  const coerce = readInjectedToolReturnContentHelper();
  if (typeof coerce !== "function") {
    assert.fail("expected __lcpCoerceToolReturnContent helper to be installed");
  }

  assert.deepEqual(
    coerce([
      { type: "text", text: "[Image: strict-png.png]" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc123" },
      },
    ]),
    [
      { type: "text", text: "[Image: strict-png.png]" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc123" },
      },
    ],
  );

  globalThis.__lcpCoerceToolReturnContent = undefined;
});

test("patch-loader: registers native generate_image tool in built-in registries", () => {
  const input = [
    "#!/usr/bin/env node",
    "const toolDefinitions = {};",
    "  TOOL_DEFINITIONS = toolDefinitions;",
    "});",
    "var ANTHROPIC_DEFAULT_TOOLS2 = [",
    "  \"TaskUpdate\",",
    "  \"Write\"",
    "];",
    "var OPENAI_PASCAL_TOOLS2 = [",
    "  \"ApplyPatch\",",
    "  \"UpdatePlan\"",
    "];",
  ].join("\n");

  const patched = patchLettaCodeSourceForTest(input);

  assert.match(patched, /globalThis\.__lcpAddGenerateImageTool =/);
  assert.match(patched, /TOOL_DEFINITIONS = globalThis\.__lcpAddGenerateImageTool\(toolDefinitions, defineTool\);/);
  assert.match(patched, /model = typeof args\?\.model === "string"[\s\S]*: "gpt-image-2";/);
  assert.doesNotMatch(patched, /gpt-image-2-medium/);
  assert.match(
    patched,
    /var ANTHROPIC_DEFAULT_TOOLS2 = \[[\s\S]*"Write",\n  "generate_image"\n\];/,
  );
  assert.match(
    patched,
    /var OPENAI_PASCAL_TOOLS2 = \[[\s\S]*"UpdatePlan",\n  "generate_image"\n\];/,
  );
});

test("patch-loader: current letta.js bundle receives generate_image registration", () => {
  const bundlePath = resolveLettaBundle();
  assert.ok(
    bundlePath,
    "could not resolve @letta-ai/letta-code bundle — generate_image registration cannot be verified against the real bundle",
  );
  const bundle = readFileSync(bundlePath, "utf8");
  const patched = patchLettaCodeSourceForTest(bundle);

  assert.match(patched, /globalThis\.__lcpAddGenerateImageTool =/);
  assert.match(patched, /TOOL_DEFINITIONS = globalThis\.__lcpAddGenerateImageTool\(toolDefinitions, defineTool\);/);
  assert.match(
    patched,
    /var ANTHROPIC_DEFAULT_TOOLS2 = \[[\s\S]*"Write",\n  "generate_image"\n\];/,
  );
  assert.match(
    patched,
    /var OPENAI_PASCAL_TOOLS2 = \[[\s\S]*"UpdatePlan",\n  "generate_image"\n\];/,
  );
});

test("patch-loader: generate_image impl applies default model and handles HTTP errors", async () => {
  const input = [
    "#!/usr/bin/env node",
    "const toolDefinitions = {};",
    "  TOOL_DEFINITIONS = toolDefinitions;",
    "});",
  ].join("\n");

  const patched = patchLettaCodeSourceForTest(input);
  const helperStart = patched.indexOf("globalThis.__lcpAddGenerateImageTool =");
  const helperEnd = patched.indexOf("\n  TOOL_DEFINITIONS = globalThis.__lcpAddGenerateImageTool");
  assert.notEqual(helperStart, -1, "__lcpAddGenerateImageTool definition missing");
  assert.notEqual(helperEnd, -1, "helperEnd missing");

  // Isolate the function definition and eval it
  const helperSource = patched.slice(helperStart, helperEnd);
  globalThis.__lcpAddGenerateImageTool = undefined;
  eval(helperSource);

  type AddGenerateImageTool = (
    toolDefinitions: Record<string, unknown>,
    defineToolFn: (cfg: { schema: unknown; description: unknown; impl: unknown }) => unknown,
  ) => Record<string, unknown>;
  const addGenerateImageTool = globalThis.__lcpAddGenerateImageTool as AddGenerateImageTool | undefined;
  if (typeof addGenerateImageTool !== "function") {
    throw new Error("__lcpAddGenerateImageTool was not injected");
  }
  const invokeAddGenerateImageTool: AddGenerateImageTool = addGenerateImageTool;

  const mockToolDefinitions: Record<string, unknown> = { existing: true };
  const mockDefineToolFn = (cfg: { schema: unknown; description: unknown; impl: unknown }) => cfg.impl;
  const result = invokeAddGenerateImageTool(mockToolDefinitions, mockDefineToolFn);

  assert.equal(result["existing"], true);
  const generateImage = result["generate_image"];
  assert.equal(typeof generateImage, "function");
  if (typeof generateImage !== "function") {
    throw new Error("generate_image tool was not added");
  }
  const invokeGenerateImage = generateImage as (args: { prompt: string; output_dir: string }) => Promise<{ details: { model: string } }>;

  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  try {
    // Test 1: Default model selection
    let capturedBody: any;
    globalThis.fetch = async (url: string | URL | Request, options?: RequestInit) => {
      capturedBody = JSON.parse(options?.body as string);
      return new Response(JSON.stringify({ data: [{ b64_json: "fakebase64" }] }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const args = { prompt: "A test image", output_dir: "/tmp/letta-test-output-dir-img" };
    const response = await invokeGenerateImage(args);

    assert.equal(capturedBody.model, "gpt-image-2", "Should default to gpt-image-2");
    assert.equal(capturedBody.prompt, "A test image");
    assert.equal(response.details.model, "gpt-image-2");

    // Test 2: Error handling (non-200 status)
    globalThis.fetch = async () => {
      return new Response("Provider overloaded", { status: 503 });
    };

    await assert.rejects(
      async () => { await invokeGenerateImage({ prompt: "Another test", output_dir: "/tmp/letta-test-output-dir-img" }); },
      (err: Error) => {
        assert.match(err.message, /image generation failed: HTTP 503 Provider overloaded/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    globalThis.__lcpAddGenerateImageTool = undefined;
  }
});

test("patch-loader leaves unrelated source untouched", () => {
  const source = "export const untouched = true;\n";

  assert.equal(patchLettaCodeSourceForTest(source), source);
});

// ---------------------------------------------------------------------------
// lcp-aioi8-p1 / lcp-aioi8-p2 — system-prompt dirty-check + clone-map
// dehydration. Anchors are byte-exact copies of letta-code 0.27.22; keep in
// sync with letta-code-patch-loader.mjs.
// ---------------------------------------------------------------------------

const SYS_PROMPT_ANCHOR =
  "  persistCompiledSystemPrompt(conversationId, agentId) {\n" +
  "    if (!this.storageDir)\n" +
  "      return;\n" +
  "    const key = this.conversationKey(conversationId, agentId);\n" +
  "    const prompt = this.compiledSystemPromptByConversationKey.get(key);\n" +
  "    if (!prompt)\n" +
  "      return;\n" +
  "    const conversationDir = join39(this.storageDir, \"conversations\", encodePathSegment(key));\n" +
  "    mkdirSync23(conversationDir, { recursive: true });\n" +
  "    writeFileSync17(join39(conversationDir, \"system-prompt.json\"), `${JSON.stringify(prompt, null, 2)}\n" +
  "`);\n" +
  "  }";

const CLONE_MAP_BULK_ANCHOR =
  "    this.persistedMessageByMessageIdByConversationKey.set(key, new Map(Array.from(transcript.messageById, ([messageId, message]) => [\n" +
  "      messageId,\n" +
  "      cloneLocalMessage(message)\n" +
  "    ])));";

const CLONE_MAP_APPEND_ANCHOR = ".set(entry.message.id, cloneLocalMessage(entry.message));";

const CLONE_MAP_COMPARE_ANCHOR = "localMessagesHaveSameSnapshot(persistedMessage, message)";

// The lcp-aioi8 patches target the DEPLOYED runtime bundle (>= 0.27.x, the
// global bun install that LETTA_CLI_PATH_REAL points at in production), not
// the pinned dev dependency in node_modules (0.19.x, which predates
// persistCompiledSystemPrompt entirely — the patches simply fail-open there).
function resolveDeployedLettaBundle(): string | null {
  // Deployment order, newest first. The stale copy under .bun is several releases behind what
  // the service runs, and asserting "nothing fails open" against it asserts nothing useful.
  const versioned = existsSync("/root")
    ? readdirSync("/root")
        .filter((entry) => entry.startsWith("letta-code-") && !entry.endsWith(".tgz"))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((entry) => join("/root", entry, "node_modules/@letta-ai/letta-code/letta.js"))
    : [];
  const candidates = [
    process.env["LETTA_CLI_PATH_REAL"] ?? "",
    ...versioned,
    "/root/.bun/install/global/node_modules/@letta-ai/letta-code/letta.js",
    resolveLettaBundle() ?? "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const source = readFileSync(candidate, "utf8");
    if (source.includes("  persistCompiledSystemPrompt(conversationId, agentId) {")) {
      return candidate;
    }
  }
  return null;
}

test("patch-loader: deployed letta.js bundle receives dirty-check + clone-map dehydration", (t) => {
  const bundlePath = resolveDeployedLettaBundle();
  if (!bundlePath) {
    t.skip("no letta-code bundle with persistCompiledSystemPrompt (>= 0.27) available on this host");
    return;
  }
  const bundle = readFileSync(bundlePath, "utf8");

  // Unique-match assertion holds on the real bundle (drift alarm on update).
  const sysPromptSites = [...bundle.matchAll(/  persistCompiledSystemPrompt\(conversationId, agentId\) \{/g)];
  assert.equal(sysPromptSites.length, 1, "P1 anchor must be unique");
  assert.equal(bundle.split(CLONE_MAP_BULK_ANCHOR).length - 1, 1, "P2 bulk anchor must be unique");
  assert.equal(bundle.split(CLONE_MAP_APPEND_ANCHOR).length - 1, 1, "P2 append anchor must be unique");
  assert.equal(bundle.split(CLONE_MAP_COMPARE_ANCHOR).length - 1, 1, "P2 compare anchor must be unique");

  const { source: patched, skippedPatches } = patchLettaCodeSourceResultForTest(bundle);
  assert.equal(skippedPatches, 0, "no patch may fail-open against the pinned bundle");

  // P1: dirty-check in place, memo helper injected, unconditional write gone.
  assert.ok(patched.includes("if (globalThis.__lcpSysPromptJson.get(key) === json)"));
  assert.ok(patched.includes("globalThis.__lcpSysPromptJson = globalThis.__lcpSysPromptJson || new Map();"));
  // Shape, not binding numbers: the minifier renumbers those on most releases and the anchor
  // is built to tolerate it, so freezing them here would fail the next upgrade for no reason.
  assert.ok(
    /writeFileSync\d+\(join\d+\(conversationDir, "system-prompt\.json"\), json \+ "\\n"\);/.test(patched),
    "the memoized write must be in place",
  );
  assert.ok(
    !/writeFileSync\d+\(join\d+\(conversationDir, "system-prompt\.json"\), `\$\{JSON\.stringify/.test(patched),
    "the unconditional write must be gone",
  );

  // P2: all three sites dehydrated atomically.
  assert.ok(patched.includes(".set(entry.message.id, JSON.stringify(entry.message));"));
  assert.ok(patched.includes("persistedMessage === JSON.stringify(message)"));
  assert.ok(!patched.includes(CLONE_MAP_BULK_ANCHOR));
  assert.ok(!patched.includes("cloneLocalMessage(entry.message)"));
  // The other cloneLocalMessage call sites (non-anchored) must be untouched.
  assert.ok(patched.includes("cloneLocalMessage("));
});

test("patch-loader: lcp-aioi8-p1 fail-open on structural anchor drift", () => {
  // Renumbered bindings (mkdirSync23 -> mkdirSync24) are what the anchor now tolerates by
  // design, so drift has to be structural to prove fail-open: the method itself is renamed.
  // Nothing may be patched and the source must come back byte-identical.
  const drifted = "const before = 1;\n" +
    SYS_PROMPT_ANCHOR.replace("persistCompiledSystemPrompt", "persistCompiledSystemPromptV2") +
    "\nconst after = 2;\n";

  const { source, appliedPatches } = patchLettaCodeSourceResultForTest(drifted);
  assert.equal(source, drifted, "drifted anchor must leave source untouched");
  assert.equal(appliedPatches, 0);
});

test("patch-loader: lcp-aioi8-p1 unique-match assertion skips duplicated anchors", () => {
  const duplicated = "class A {\n" + SYS_PROMPT_ANCHOR + "\n}\nclass B {\n" + SYS_PROMPT_ANCHOR + "\n}\n";

  const { source, appliedPatches } = patchLettaCodeSourceResultForTest(duplicated);
  assert.equal(source, duplicated, "double-matched anchor must not be patched anywhere");
  assert.equal(appliedPatches, 0);

  // Sanity: the same anchor occurring exactly once IS patched.
  const single = "class A {\n" + SYS_PROMPT_ANCHOR + "\n}\n";
  const patchedSingle = patchLettaCodeSourceForTest(single);
  assert.ok(patchedSingle.includes("globalThis.__lcpSysPromptJson.get(key) === json"));
});

test("patch-loader: lcp-aioi8-p2 applies atomically or not at all", () => {
  // Only two of the three anchors present (bulk-rebuild missing): NONE of the
  // clone-map replacements may land, or the map would mix value types.
  const partial =
    "if (persistedMessage && " + CLONE_MAP_COMPARE_ANCHOR + ") {\n  return;\n}\n" +
    "this.persistedMessagesByMessageId(key)" + CLONE_MAP_APPEND_ANCHOR + "\n";

  const { source, appliedPatches } = patchLettaCodeSourceResultForTest(partial);
  assert.equal(source, partial, "partial anchor set must not be patched");
  assert.equal(appliedPatches, 0);

  // All three present exactly once → all three replaced.
  const complete = partial + CLONE_MAP_BULK_ANCHOR + "\n";
  const patchedComplete = patchLettaCodeSourceForTest(complete);
  assert.ok(patchedComplete.includes("persistedMessage === JSON.stringify(message)"));
  assert.ok(patchedComplete.includes(".set(entry.message.id, JSON.stringify(entry.message));"));
  assert.ok(patchedComplete.includes("      JSON.stringify(message)\n    ])));"));
  assert.ok(!patchedComplete.includes("cloneLocalMessage"));
});

test("patch-loader: lcp-aioi8-p1 dirty-check skips unchanged system-prompt writes", () => {
  // Build a runnable fixture around the byte-exact anchor, patch it, eval it,
  // and drive persistCompiledSystemPrompt twice with an unchanged prompt.
  const fixture = [
    "var writes = [];",
    "function join39(...parts) { return parts.join(\"/\"); }",
    "function encodePathSegment(value) { return value; }",
    "function mkdirSync23() {}",
    "function writeFileSync17(path, data) { writes.push({ path, data }); }",
    "class FixtureStore {",
    "  constructor() {",
    "    this.storageDir = \"/fixture\";",
    "    this.compiledSystemPromptByConversationKey = new Map();",
    "  }",
    "  conversationKey(conversationId, agentId) { return `${conversationId}:${agentId}`; }",
    SYS_PROMPT_ANCHOR,
    "}",
    "({ FixtureStore, writes });",
  ].join("\n");

  const patched = patchLettaCodeSourceForTest(fixture);
  assert.ok(patched.includes("globalThis.__lcpSysPromptJson.get(key) === json"));

  const globals = globalThis as typeof globalThis & { __lcpSysPromptJson?: Map<string, string> };
  const previousMemo = globals.__lcpSysPromptJson;
  globals.__lcpSysPromptJson = undefined;
  try {
    const evaluated = eval(patched) as {
      FixtureStore: new () => {
        storageDir: string;
        compiledSystemPromptByConversationKey: Map<string, unknown>;
        persistCompiledSystemPrompt(conversationId: string, agentId: string): void;
      };
      writes: Array<{ path: string; data: string }>;
    };
    const store = new evaluated.FixtureStore();
    store.compiledSystemPromptByConversationKey.set("conv-1:agent-1", { system: "alpha" });

    store.persistCompiledSystemPrompt("conv-1", "agent-1");
    store.persistCompiledSystemPrompt("conv-1", "agent-1");
    assert.equal(evaluated.writes.length, 1, "unchanged prompt must write exactly once");
    assert.equal(evaluated.writes[0]?.data, JSON.stringify({ system: "alpha" }, null, 2) + "\n");

    store.compiledSystemPromptByConversationKey.set("conv-1:agent-1", { system: "beta" });
    store.persistCompiledSystemPrompt("conv-1", "agent-1");
    assert.equal(evaluated.writes.length, 2, "changed prompt must write again");
    assert.equal(evaluated.writes[1]?.data, JSON.stringify({ system: "beta" }, null, 2) + "\n");
  } finally {
    globals.__lcpSysPromptJson = previousMemo;
  }
});

// lcp-otid — the streamed assistant otid has to survive the durable write, or a
// client cannot pair the streamed row with the settled one except by matching
// their text, which duplicates a reply whenever a stream drops its tail.
const OTID_STAMP_ANCHOR = `            yield createLocalMessageChunk(event.message);`;
const OTID_PERSIST_ANCHOR = `    usage: message.usage ?? emptyLocalUsage(),`;
const OTID_PROJECT_ANCHOR =
  "    messages.push({\n" +
  "      id: isFirst ? message.id : `${message.id}:assistant:${pendingTextStartIndex}`,\n" +
  "      date,\n" +
  "      agent_id: agentId,\n" +
  "      conversation_id: conversationId,\n" +
  '      message_type: "assistant_message",\n' +
  '      role: "assistant",\n' +
  "      content: pendingTextContent\n" +
  "    });";

test("patch-loader: lcp-otid stamps the segment otid and persists it", () => {
  const bundle =
    "const before = 1;\n" +
    OTID_STAMP_ANCHOR + "\n" +
    OTID_PERSIST_ANCHOR + "\n" +
    OTID_PROJECT_ANCHOR + "\n" +
    "const after = 2;\n";

  const patched = patchLettaCodeSourceForTest(bundle);

  // Stamped where the otids were minted, persisted where the record is built.
  assert.ok(patched.includes("globalThis.__lcpStampAssistantOtids(event.message, assistantOtids)"));
  assert.ok(patched.includes("...message.otid ? { otid: message.otid } : {},"));
  assert.ok(patched.includes("globalThis.__lcpStampAssistantOtids = globalThis.__lcpStampAssistantOtids ||"));
});

test("patch-loader: lcp-otid stamps the first segment and records them all", () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals["__lcpStampAssistantOtids"];
  delete globals["__lcpStampAssistantOtids"];
  try {
    const patched = patchLettaCodeSourceForTest(
      OTID_STAMP_ANCHOR + "\n" + OTID_PERSIST_ANCHOR + "\n" + OTID_PROJECT_ANCHOR + "\n",
    );
    // The helper is injected ahead of the bundle; take exactly it, so the test
    // evaluates the shipped source rather than a copy that could drift from it.
    const start = patched.indexOf("globalThis.__lcpStampAssistantOtids =");
    assert.ok(start >= 0, "helper must be injected");
    const end = patched.indexOf("\n};\n", start);
    assert.ok(end > start, "helper must be terminated");
    new Function(patched.slice(start, end + "\n};".length))();
    const stamp = globals["__lcpStampAssistantOtids"] as
      (message: unknown, otids: unknown) => Record<string, unknown>;

    const otids = new Map<number, string>([
      [0, "provider-assistant-0-aaa"],
      [2, "provider-assistant-2-bbb"],
    ]);
    const message: Record<string, unknown> = { role: "assistant", content: [] };
    const stamped = stamp(message, otids);

    // The first segment names the row, because that is the id the stream opens
    // with; the rest are kept so a multi-segment reply can still be paired.
    assert.equal(stamped["otid"], "provider-assistant-0-aaa");
    // Keyed by the segment index they were minted under, so the read path can
    // look one up exactly when a stored reply projects into several frames.
    assert.deepEqual(
      (stamped["metadata"] as Record<string, unknown>)["segment_otids"],
      { "0": "provider-assistant-0-aaa", "2": "provider-assistant-2-bbb" },
    );
    // Stamping is in place: the object the caller persists is the one we edited.
    assert.equal(stamped, message);

    // An otid the turn already carries wins; a stamp must never rename a row.
    const named: Record<string, unknown> = { otid: "already-named" };
    assert.equal(stamp(named, otids)["otid"], "already-named");

    // Nothing to stamp, nothing changed.
    const empty: Record<string, unknown> = { role: "assistant" };
    assert.equal(stamp(empty, new Map())["otid"], undefined);
  } finally {
    if (previous === undefined) delete globals["__lcpStampAssistantOtids"];
    else globals["__lcpStampAssistantOtids"] = previous;
  }
});

test("patch-loader: lcp-otid projects the stored otid back onto history frames", () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals["__lcpSegmentOtid"];
  delete globals["__lcpSegmentOtid"];
  try {
    const patched = patchLettaCodeSourceForTest(
      OTID_STAMP_ANCHOR + "\n" + OTID_PERSIST_ANCHOR + "\n" + OTID_PROJECT_ANCHOR + "\n",
    );
    assert.ok(patched.includes("globalThis.__lcpSegmentOtid(message, pendingTextStartIndex, isFirst)"));

    const start = patched.indexOf("globalThis.__lcpSegmentOtid =");
    assert.ok(start >= 0, "projection helper must be injected");
    const end = patched.indexOf("\n};\n", start);
    new Function(patched.slice(start, end + "\n};".length))();
    const segmentOtid = globals["__lcpSegmentOtid"] as
      (message: unknown, index: number, isFirst: boolean) => Record<string, unknown>;

    const stored = {
      otid: "provider-assistant-0-aaa",
      metadata: {
        segment_otids: { "0": "provider-assistant-0-aaa", "2": "provider-assistant-2-bbb" },
      },
    };
    // Each projected frame carries the otid of the segment it was flushed from.
    assert.deepEqual(segmentOtid(stored, 0, true), { otid: "provider-assistant-0-aaa" });
    assert.deepEqual(segmentOtid(stored, 2, false), { otid: "provider-assistant-2-bbb" });
    // A segment with no recorded otid names nothing rather than borrowing one.
    assert.deepEqual(segmentOtid(stored, 5, false), {});
    // Records written before this patch fall back to the row otid on the first
    // frame only, and never invent one for a later segment.
    const legacy = { otid: "provider-assistant-0-ccc" };
    assert.deepEqual(segmentOtid(legacy, 0, true), { otid: "provider-assistant-0-ccc" });
    assert.deepEqual(segmentOtid(legacy, 3, false), {});
    assert.deepEqual(segmentOtid({}, 0, true), {});
  } finally {
    if (previous === undefined) delete globals["__lcpSegmentOtid"];
    else globals["__lcpSegmentOtid"] = previous;
  }
});

// lcp-clr: conversation-scoped lastRunAt for the agent-info reminder. The
// listen-path site that builds `listenAgentMetadata` is the only place that
// reads `cachedAgent.last_run_completion`, so the anchor must match the
// deployed bundle exactly once, the rewrite must install the helper via
// `globalThis.__lcpConversationLastRunAt(...)` against the in-scope
// `getBackend()`, `agentId`, and `conversationId`, and the original literal
// line must be gone — otherwise the local backend keeps reporting the
// agent's `default` conversation timestamp in non-default conversations
// (the "55 days ago" on a brand-new conversation bug).
//
// Anchors and replacements are shape-only — the minifier renumbers bindings
// on most releases and this test must keep passing across them.
const CLR_LISTEN_SITE_TOKEN =
  `      if (!runtime.reminderState.hasSentAgentInfo && cachedAgent) {\n` +
  `        listenAgentMetadata = {\n` +
  `          name: cachedAgent.name ?? null,\n` +
  `          description: cachedAgent.description ?? null,\n` +
  `          lastRunAt: cachedAgent.last_run_completion ?? null\n` +
  `        };\n` +
  `      }`;

test("patch-loader: lcp-clr rewrites the deployed listen-path lastRunAt to a conversation-scoped helper", (t) => {
  const bundlePath = resolveDeployedLettaBundle();
  if (!bundlePath) {
    t.skip(
      "no letta-code bundle with persistCompiledSystemPrompt (>= 0.27) available on this host — lcp-clr cannot be verified against the real bundle",
    );
    return;
  }
  const bundle = readFileSync(bundlePath, "utf8");

  // Unique-match assertion holds on the real bundle (drift alarm on upgrade).
  assert.equal(
    bundle.split(CLR_LISTEN_SITE_TOKEN).length - 1,
    1,
    "lcp-clr anchor must be unique on the deployed bundle",
  );

  const { source: patched, skippedPatches, appliedPatches } = patchLettaCodeSourceResultForTest(bundle);

  // The deployed-bundle test a few blocks above also asserts
  // `skippedPatches === 0` after a sequence of patches runs; that contract
  // must continue to hold with lcp-clr appended — the patch succeeds against
  // a real bundle.
  assert.equal(
    skippedPatches,
    0,
    "no patch (including lcp-clr) may fail-open against the deployed bundle",
  );
  assert.ok(
    (appliedPatches ?? 0) >= 1,
    "lcp-clr must increment appliedPatches on the deployed bundle",
  );

  // The original literal line that read `cachedAgent.last_run_completion`
  // must be gone — replacing the half-conversation-scoped, half-agent-scoped
  // reminder is the entire point of the patch.
  assert.equal(
    patched.split(
      "          lastRunAt: cachedAgent.last_run_completion ?? null",
    ).length - 1,
    0,
    "the agent-scoped lastRunAt literal must be removed",
  );

  // The rewrite calls the helper with the three in-scope identifiers plus
  // the agent-level fallback — they are the only correct seams.
  assert.ok(
    patched.includes(
      "          lastRunAt: await globalThis.__lcpConversationLastRunAt(getBackend(), agentId, conversationId, cachedAgent.last_run_completion ?? null)",
    ),
    "the helper call must thread backend / agentId / conversationId and fall back to the agent-scoped value",
  );

  // The helper is injected after the shebang so Node sees it as a top-level
  // statement; duplicate-injection is harmless because of the `|| function`
  // guard but the function body must be present at least once.
  assert.ok(
    patched.includes(
      'globalThis.__lcpConversationLastRunAt = globalThis.__lcpConversationLastRunAt || async function',
    ),
    "the __lcpConversationLastRunAt helper must be injected",
  );
  assert.ok(
    patched.includes("backend.retrieveConversation(conversationId, agentId)"),
    "the helper must resolve the conversation via the backend",
  );
  assert.ok(
    !patched.includes(`return null;\n      }\n    }\n  } catch {}\n  return agentFallback;`),
    "the helper must surface its no-conversation-match null-return without leaking the literal snippet",
  );
});

test("patch-loader: lcp-clr fail-open on a duplicate-anchor source", () => {
  // Synthesize a minimal source in which the listen-path site appears twice
  // — e.g. a future letta.js that clones the block for the warmup path.
  // lcp-clr must skip rather than patching the wrong site and silently
  // corrupting the warmup path. No other anchor from the upstream patch
  // list appears in this fragment, so applied/skipped counts are scoped
  // solely to lcp-clr.
  const doubleSource = "class A {\n" + CLR_LISTEN_SITE_TOKEN + "\n}\nclass B {\n" + CLR_LISTEN_SITE_TOKEN + "\n}\n";
  const { source, appliedPatches } = patchLettaCodeSourceResultForTest(doubleSource);
  assert.equal(source, doubleSource, "double-matched anchor must not be patched anywhere");
  assert.equal(appliedPatches, 0, "appliedPatches must be 0 when lcp-clr cannot prove uniqueness");

  // Sanity: the same anchor occurring exactly once IS patched.
  const single = "class A {\n" + CLR_LISTEN_SITE_TOKEN + "\n}\n";
  const patchedSingle = patchLettaCodeSourceForTest(single);
  assert.ok(
    patchedSingle.includes(
      "          lastRunAt: await globalThis.__lcpConversationLastRunAt(getBackend(), agentId, conversationId, cachedAgent.last_run_completion ?? null)",
    ),
    "single-occurrence anchor must be rewritten and routed through the helper",
  );
});
