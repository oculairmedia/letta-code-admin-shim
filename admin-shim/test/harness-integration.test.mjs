/**
 * Integration smoke: verify the mock letta works when spawned by the
 * agent pool. If this passes, all stream-related tests can rely on
 * mocked turns producing the expected frame shapes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  startShim,
  seedAgent,
  seedConversation,
  streamMessages,
  framesOfType,
  externalConvId,
} from "./helpers/index.mjs";

test("integration: POST /v1/conversations/{id}/messages streams plain trace", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-int-001" });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);

  const { frames, doneSeen, status } = await streamMessages(
    `${shim.url}/v1/conversations/${convId}/messages`,
    {
      messages: [{ role: "user", content: "reply with pong", otid: "cm-int-1" }],
      streaming: true,
    },
    { timeoutMs: 10_000 },
  );

  assert.equal(status, 200, "stream POST should be 200");
  assert.ok(doneSeen, "[DONE] terminator should arrive");
  assert.ok(frames.length > 0, "should have at least one SSE frame");

  // Plain trace coalesces to one assistant_message containing "pong"
  const assistants = framesOfType(frames, "assistant_message");
  assert.equal(assistants.length, 1, `expected 1 assistant_message, got ${assistants.length}`);
  assert.match(assistants[0].content, /pong/i, `assistant content should mention pong, got: ${assistants[0].content}`);

  // stop_reason + usage in vanilla order
  const stopIdx = frames.findIndex((f) => f.message_type === "stop_reason");
  const usageIdx = frames.findIndex((f) => f.message_type === "usage_statistics");
  assert.ok(stopIdx >= 0 && usageIdx >= 0, "stop_reason and usage_statistics required");
  assert.ok(stopIdx < usageIdx, "stop_reason should precede usage_statistics");
});

test("integration: bash-tool trace yields a tool_call_message", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-int-002" });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);

  const { frames } = await streamMessages(
    `${shim.url}/v1/conversations/${convId}/messages`,
    {
      messages: [{ role: "user", content: "run bash echo hello", otid: "cm-int-2" }],
      streaming: true,
    },
    { timeoutMs: 10_000 },
  );

  const tools = framesOfType(frames, "tool_call_message");
  assert.equal(tools.length, 1, "should have one tool_call_message");
  assert.equal(tools[0].tool_call?.name, "Bash");
  assert.match(tools[0].id, /^toolcall-/);
});
