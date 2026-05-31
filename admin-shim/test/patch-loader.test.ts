import { test } from "node:test";
import assert from "node:assert/strict";

import { patchLettaCodeSourceForTest } from "../scripts/letta-code-patch-loader.mjs";

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

test("patch-loader leaves unrelated source untouched", () => {
  const source = "export const untouched = true;\n";

  assert.equal(patchLettaCodeSourceForTest(source), source);
});
