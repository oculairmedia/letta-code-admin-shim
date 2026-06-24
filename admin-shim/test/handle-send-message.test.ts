import { test } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { handleSendMessage } from "../lib/chat.js";
import { getAgentPool } from "../lib/agent-pool.js";

class MockRequest extends IncomingMessage {
  constructor(body: unknown) {
    super(new Socket());
    this.method = "POST";
    const buf = Buffer.from(JSON.stringify(body));
    this.push(buf);
    this.push(null);
  }
}

class MockResponse extends ServerResponse {
  override statusCode = 200;
  headers: Record<string, string> = {};
  body: string = "";

  constructor() {
    super(new IncomingMessage(new Socket()));
  }

  override writeHead(statusCode: number, headers?: any) {
    this.statusCode = statusCode;
    if (headers && typeof headers === "object") Object.assign(this.headers, headers);
    return this;
  }

  override write(chunk: any) {
    this.body += chunk.toString();
    return true;
  }

  override end(chunk?: any) {
    if (chunk) this.body += chunk.toString();
    return this;
  }
}

test("handleSendMessage preserves multimodal content arrays", async () => {
  const req = new MockRequest({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this image" },
          { type: "image", source: { type: "base64", data: "abcd" } }
        ]
      }
    ],
    stream: false,
    conversation_id: "conv-1"
  });
  const res = new MockResponse();

  let capturedContent: unknown = null;
  const pool = getAgentPool();
  const originalRunTurn = pool.runTurnWithHeal;
  pool.runTurnWithHeal = async (convId: string, agentId: string, content: unknown, opts: any) => {
    capturedContent = content;
    return { frames: [], done: true, stderr: "" } as any;
  };

  try {
    await handleSendMessage(req as any, res as any, "agent-1");
    
    assert.ok(capturedContent);
    assert.ok(Array.isArray(capturedContent));
    
    const imagePart = (capturedContent as any[]).find(p => p.type === "image");
    assert.ok(imagePart);
    assert.equal(imagePart.source.data, "abcd");
  } finally {
    pool.runTurnWithHeal = originalRunTurn;
  }
});
