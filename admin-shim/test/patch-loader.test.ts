import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { patchLettaCodeSourceForTest } from "../scripts/letta-code-patch-loader.mjs";

type ThinkingPayload = {
  model?: string;
  thinking?: { type: string; budget_tokens?: number };
};

type ModelSettingsPayload = {
  provider_type?: string;
  thinking?: { type: string; budget_tokens?: number };
};

type GeneratedImageToolDefinition = {
  schema: Record<string, unknown>;
  description: string;
  impl: (args: Record<string, unknown>) => Promise<GeneratedImageToolResult>;
};

type GeneratedImageToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  >;
  details: {
    path: string;
    mime_type: string;
    model: string;
    size: string;
    quality: string;
    prompt: string;
  };
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
      defineToolFn: (input: GeneratedImageToolDefinition) => GeneratedImageToolDefinition,
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

function readInjectedGenerateImageToolHelper(): unknown {
  return (globalThis as typeof globalThis & { __lcpAddGenerateImageTool?: unknown })
    .__lcpAddGenerateImageTool;
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

test("patch-loader: registers native generate_image tool in built-in registries", async (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), "lcp-vw2h-images-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));

  const previousFetch = globalThis.fetch;
  const previousImageUrl = process.env["LETTA_IMAGE_GENERATION_URL"];
  const b64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: input.toString(),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  process.env["LETTA_IMAGE_GENERATION_URL"] = "http://127.0.0.1:9999/v1/images/generations";

  try {
    const input = [
      "#!/usr/bin/env node",
      "function defineTool(input) { return input; }",
      "const toolDefinitions = {};",
      "  TOOL_DEFINITIONS = toolDefinitions;",
      "});",
      "var ANTHROPIC_DEFAULT_TOOLS = [",
      "    \"TaskUpdate\",",
      "    \"Write\"",
      "  ];",
      "var OPENAI_PASCAL_TOOLS = [",
      "    \"ApplyPatch\",",
      "    \"UpdatePlan\"",
      "  ];",
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
    assert.match(patched, /"Write",\n    "generate_image"/);
    assert.match(patched, /"UpdatePlan",\n    "generate_image"/);
    assert.match(patched, /"Write",\n  "generate_image"/);
    assert.match(patched, /"UpdatePlan",\n  "generate_image"/);

    const helperStart = patched.indexOf("globalThis.__lcpAddGenerateImageTool =");
    const helperEnd = patched.indexOf("\nfunction defineTool", helperStart);
    assert.notEqual(helperStart, -1);
    assert.notEqual(helperEnd, -1);

    const helperSource = patched.slice(helperStart, helperEnd);
    globalThis.__lcpAddGenerateImageTool = undefined;
    eval(helperSource);

    const addTool = readInjectedGenerateImageToolHelper();
    if (typeof addTool !== "function") {
      assert.fail("expected __lcpAddGenerateImageTool helper to be installed");
    }

    const registry = addTool({}, (tool: GeneratedImageToolDefinition) => tool);
    const generatedTool = registry["generate_image"];
    if (!isGeneratedImageToolDefinition(generatedTool)) {
      assert.fail("expected generate_image tool definition in registry");
    }

    const result = await generatedTool.impl({
      prompt: "a small brass automaton sketch",
      size: "1536x1024",
      quality: "high",
      output_dir: outputDir,
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.body, {
      model: "gpt-image-2",
      prompt: "a small brass automaton sketch",
      size: "1536x1024",
      quality: "high",
      n: 1,
      response_format: "b64_json",
    });
    assert.ok(existsSync(result.details.path), "tool should save generated image bytes to disk");
    assert.deepEqual(readFileSync(result.details.path), Buffer.from(b64, "base64"));
    assert.deepEqual(result.content[1], {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: b64 },
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousImageUrl === undefined) {
      delete process.env["LETTA_IMAGE_GENERATION_URL"];
    } else {
      process.env["LETTA_IMAGE_GENERATION_URL"] = previousImageUrl;
    }
    globalThis.__lcpAddGenerateImageTool = undefined;
  }
});

function isGeneratedImageToolDefinition(value: unknown): value is GeneratedImageToolDefinition {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Boolean(record["schema"]) &&
    typeof record["description"] === "string" &&
    typeof record["impl"] === "function";
}

test("patch-loader leaves unrelated source untouched", () => {
  const source = "export const untouched = true;\n";

  assert.equal(patchLettaCodeSourceForTest(source), source);
});
