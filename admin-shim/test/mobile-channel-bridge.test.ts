import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeSendMessage } from "../lib/mobile-channel-host.js";
import { getAgentPool } from "../lib/agent-pool.js";

test("bridgeSendMessage preserves multimodal content arrays from content_parts", async () => {
  let capturedContent: unknown = null;
  const pool = getAgentPool();
  const originalRunTurn = pool.runTurnWithHeal;
  pool.runTurnWithHeal = async (convId: string, agentId: string, content: unknown, opts: any) => {
    capturedContent = content;
    return { frames: [], done: true, stderr: "" } as any;
  };

  try {
    await bridgeSendMessage({
      agent_id: "agent-1",
      conversation_id: "conv-1",
      text: "Fallback text",
      content_parts: [
        { type: "text", text: "Here is an image" },
        { type: "image", source: { type: "base64", data: "abcd" } }
      ]
    }, () => {});
    
    assert.ok(capturedContent);
    assert.ok(Array.isArray(capturedContent));
    
    const imagePart = (capturedContent as any[]).find(p => p.type === "image");
    assert.ok(imagePart);
    assert.equal(imagePart.source.data, "abcd");
  } finally {
    pool.runTurnWithHeal = originalRunTurn;
  }
});
