import { test } from "node:test";
import assert from "node:assert/strict";

import { patchLettaCodeSourceForTest } from "../scripts/letta-code-patch-loader.mjs";

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
}

function readInjectedThinkingHelper(): unknown {
  return (globalThis as typeof globalThis & { __lcpFixThinking?: unknown }).__lcpFixThinking;
}

function readInjectedModelSettingsHelper(): unknown {
  return (globalThis as typeof globalThis & { __lcpFixModelSettings?: unknown })
    .__lcpFixModelSettings;
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

test("patch-loader leaves unrelated source untouched", () => {
  const source = "export const untouched = true;\n";

  assert.equal(patchLettaCodeSourceForTest(source), source);
});
