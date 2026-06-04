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

interface SubagentEntry {
  toolCallId: string;
  description: string;
  subagentType: string;
  status: string;
  taskId: string | null;
  subagentAgentId: string | null;
  startedAt: string;
  updatedAt: string;
}

interface SubagentEvent {
  reason: string;
  subagent: SubagentEntry;
  at: string;
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

async function loadMobileAdapter(
  t: { after: (fn: () => unknown) => void },
  hostOverrides: Record<string, unknown> = {},
): Promise<MobileAdapter> {
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
      ...hostOverrides,
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

test("mobile channel: hello wires subagent list and lifecycle push handlers", async (t) => {
  const subscription: { listener: ((event: SubagentEvent) => void) | null } = { listener: null };
  const activeSubagent: SubagentEntry = {
    toolCallId: "toolu_subagent_1",
    description: "Investigate failing mobile status bar",
    subagentType: "general-purpose",
    status: "running",
    taskId: "task_1",
    subagentAgentId: "agent-local-subagent",
    startedAt: "2026-06-04T15:00:00.000Z",
    updatedAt: "2026-06-04T15:00:00.000Z",
  };
  const adapter = await loadMobileAdapter(t, {
    handleSubagentList: () => ({ subagents: [activeSubagent] }),
    subscribeSubagentEvents: (cb: (event: SubagentEvent) => void) => {
      subscription.listener = cb;
      return () => {
        subscription.listener = null;
      };
    },
  });
  const ws = new FakeWs();
  adapter.acceptConnection(ws, {});

  ws.emit("message", Buffer.from(JSON.stringify({
    v: 1,
    type: "hello",
    id: "hello-subagents",
    ts: new Date().toISOString(),
    token: "token",
    device_id: "device-subagents",
    client_version: "test/1",
  })));

  assert.ok(subscription.listener, "hello should subscribe the socket to subagent lifecycle pushes");
  ws.emit("message", Buffer.from(JSON.stringify({
    v: 1,
    type: "subagent_list",
    id: "subagent-list",
    request_id: "r-subagents",
    ts: new Date().toISOString(),
  })));

  const list = ws.sent.find((frame) => frame.type === "subagent_list_response");
  assert.ok(list, "subagent_list should be handled by the channel host");
  assert.equal(list["success"], true);
  assert.deepEqual(list["subagents"], [activeSubagent]);

  const emitSubagent = subscription.listener;
  assert.ok(emitSubagent, "listener should remain installed until close");
  emitSubagent({
    reason: "started",
    subagent: activeSubagent,
    at: "2026-06-04T15:00:01.000Z",
  });

  const pushed = ws.sent.find((frame) => frame.type === "subagents_updated");
  assert.ok(pushed, "subagent lifecycle event should push subagents_updated");
  assert.equal(pushed["reason"], "started");
  assert.deepEqual(pushed["subagent"], activeSubagent);
  assert.deepEqual(pushed["subagents_active"], [activeSubagent]);

  ws.close();
  assert.equal(subscription.listener, null, "closing the socket should unsubscribe subagent pushes");
});
