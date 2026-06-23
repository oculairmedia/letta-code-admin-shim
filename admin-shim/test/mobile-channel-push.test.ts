import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { MobileWsFrame } from "./helpers/ws.js";

interface PushResult {
  messageId: string;
  delivered: number;
}

interface MobileAdapter {
  acceptConnection(ws: unknown, request: unknown): void;
  sendMessage(msg: Record<string, unknown>): Promise<PushResult>;
  sendDirectReply(chatId: string, text: string, options?: Record<string, unknown>): Promise<PushResult>;
}

interface ChannelPluginModule {
  channelPlugin: {
    createAdapter(account: Record<string, unknown>, host: Record<string, unknown>): Promise<MobileAdapter>;
  };
}

class FakeWs extends EventEmitter {
  sent: MobileWsFrame[] = [];
  bufferedAmount = 0;

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as MobileWsFrame);
  }

  close(code = 1000, reason = "test close"): void {
    this.emit("close", code, Buffer.from(reason));
  }
}

async function loadMobileAdapter(t: { after: (fn: () => unknown) => void }): Promise<MobileAdapter> {
  const tmp = mkdtempSync(join(tmpdir(), "mobile-channel-push-"));
  const previousHome = process.env["HOME"];
  const previousLettaHome = process.env["LETTA_HOME"];
  process.env["HOME"] = tmp;
  process.env["LETTA_HOME"] = join(tmp, ".letta");
  t.after(() => {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousLettaHome === undefined) delete process.env["LETTA_HOME"];
    else process.env["LETTA_HOME"] = previousLettaHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  const moduleUrl = pathToFileURL(join(process.cwd(), "..", "home", ".letta", "channels", "mobile", "plugin.mjs")).href;
  const mod = await import(moduleUrl) as unknown as ChannelPluginModule;
  let convSeq = 0;
  return await mod.channelPlugin.createAdapter(
    {
      accountId: "test",
      channel: "mobile",
      displayName: "Test Mobile",
      config: { tokenFallback: "token" },
    },
    {
      log: () => undefined,
      getServerId: () => "server-test",
      bridgeSendMessage: async () => undefined,
      cancelRun: () => false,
      stampConversationFrame: (_conversationId: string, frame: Record<string, unknown>) => ({
        ...frame,
        conv_seq: ++convSeq,
      }),
      subscribeConversationEvents: () => {
        // Return a mock unsubscribe function
        return () => undefined;
      },
    },
  );
}

test("mobile channel: sendMessage pushes assistant frames to authenticated WS clients", async (t) => {
  const adapter = await loadMobileAdapter(t);
  const ws = new FakeWs();
  adapter.acceptConnection(ws, {});

  ws.emit("message", Buffer.from(JSON.stringify({
    v: 1,
    type: "hello",
    id: "hello-1",
    ts: new Date().toISOString(),
    token: "token",
    device_id: "device-1",
    client_version: "test/1",
  })));

  assert.ok(ws.sent.some((frame) => frame.type === "welcome"), "hello should authenticate before push registration");

  ws.emit("message", Buffer.from(JSON.stringify({
    v: 1,
    type: "subscribe_conversation",
    id: "sub-1",
    conversation_id: "conv-1",
  })));

  const result = await adapter.sendMessage({
    agent_id: "agent-1",
    conversation_id: "conv-1",
    messageId: "msg-push-1",
    text: "Background relay finished.",
  });

  assert.equal(result.messageId, "msg-push-1");
  assert.equal(result.delivered, 1);
  const pushed = ws.sent.find((frame) => frame.type === "assistant_message" && frame["source"] === "channel_push");
  assert.ok(pushed, "sendMessage should deliver a channel-push assistant_message");
  assert.equal(pushed["id"], "msg-push-1");
  assert.equal(pushed["agent_id"], "agent-1");
  assert.equal(pushed["conversation_id"], "conv-1");
  assert.equal(pushed["content"], "Background relay finished.");
  assert.equal(pushed["channel_id"], "mobile");
  assert.equal(pushed["conv_seq"], 1);

  ws.close();
  const afterClose = await adapter.sendDirectReply("conv-1", "No live client.", { agent_id: "agent-1" });
  assert.equal(afterClose.delivered, 0, "closed clients should be released from the push registry");
});

test("mobile channel: push routing sends only to subscribed conversation clients", async (t) => {
  const adapter = await loadMobileAdapter(t);

  const ws1 = new FakeWs();
  adapter.acceptConnection(ws1, {});
  ws1.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "hello", id: "h1", ts: new Date().toISOString(), token: "token", device_id: "d1" })));

  const ws2 = new FakeWs();
  adapter.acceptConnection(ws2, {});
  ws2.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "hello", id: "h2", ts: new Date().toISOString(), token: "token", device_id: "d2" })));

  // ws1 subscribes to conv-1
  ws1.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "subscribe_conversation", id: "sub1", conversation_id: "conv-1" })));
  // ws2 subscribes to conv-2
  ws2.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "subscribe_conversation", id: "sub2", conversation_id: "conv-2" })));

  ws1.sent = [];
  ws2.sent = [];

  const res1 = await adapter.sendMessage({ agent_id: "agent-1", conversation_id: "conv-1", text: "To conv-1" });
  assert.equal(res1.delivered, 1, "Should deliver to ws1");
  assert.equal(ws1.sent.length, 1);
  assert.equal(ws1.sent[0]?.["conversation_id"], "conv-1");
  assert.equal(ws2.sent.length, 0, "ws2 should not receive conv-1 message");

  ws1.sent = [];
  ws2.sent = [];

  const res2 = await adapter.sendMessage({ agent_id: "agent-1", conversation_id: "conv-2", text: "To conv-2" });
  assert.equal(res2.delivered, 1, "Should deliver to ws2");
  assert.equal(ws2.sent.length, 1);
  assert.equal(ws2.sent[0]?.["conversation_id"], "conv-2");
  assert.equal(ws1.sent.length, 0, "ws1 should not receive conv-2 message");

  ws1.close();
  ws2.close();
});

test("mobile channel: unsubscribe stops push routing for that conversation", async (t) => {
  const adapter = await loadMobileAdapter(t);

  const ws = new FakeWs();
  adapter.acceptConnection(ws, {});
  ws.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "hello", id: "h1", ts: new Date().toISOString(), token: "token", device_id: "d1" })));

  ws.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "subscribe_conversation", id: "sub1", conversation_id: "conv-1" })));

  let res = await adapter.sendMessage({ agent_id: "agent-1", conversation_id: "conv-1", text: "Delivery 1" });
  assert.equal(res.delivered, 1);

  // Unsubscribe
  ws.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "unsubscribe_conversation", id: "unsub1", conversation_id: "conv-1" })));

  res = await adapter.sendMessage({ agent_id: "agent-1", conversation_id: "conv-1", text: "Delivery 2" });
  assert.equal(res.delivered, 0, "Should not deliver after unsubscribe");

  // Reconnect ws2 and subscribe
  const ws2 = new FakeWs();
  adapter.acceptConnection(ws2, {});
  ws2.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "hello", id: "h2", ts: new Date().toISOString(), token: "token", device_id: "d1" })));
  ws2.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "subscribe_conversation", id: "sub2", conversation_id: "conv-1" })));

  res = await adapter.sendMessage({ agent_id: "agent-1", conversation_id: "conv-1", text: "Delivery 3" });
  assert.equal(res.delivered, 1, "Should deliver to new connection after subscribe");

  ws.close();
  ws2.close();
});
