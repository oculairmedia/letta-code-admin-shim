/**
 * Regression tests for the MAIN/foreground agent's self-todo emit
 * (letta-mobile-gnyf7).
 *
 * Focus:
 *  1. Extraction: the generalized `readConversationTodos` reads the MAIN
 *     conversation's message store and returns the NEWEST TodoWrite call's
 *     todos (newest-wins), not just a subagent's separate conversation.
 *  2. Live ingest: a reshaped `tool_call_message` carrying a TodoWrite tool
 *     call updates the per-conversation snapshot + fires a change event.
 *  3. Frame contract: `buildSelfTodoFrame` produces exactly the
 *     `tool_call_message` shape mobile's SelfTodoRepository consumes —
 *     non-null agent_id/conversation_id/turn_id/run_id (kotlinx requires
 *     them) and `tool_call.arguments` as the canonical `{"todos":[...]}`
 *     JSON STRING.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the local-backend store at a throwaway dir BEFORE the store module
// resolves any path (storageDir() reads this env at call time).
const STORE_DIR = mkdtempSync(join(tmpdir(), "shim-selftodo-"));
process.env["LETTA_LOCAL_BACKEND_DIR"] = STORE_DIR;

import {
  extractLatestTodos,
  readConversationTodos,
} from "../lib/subagent-todos.js";
import {
  __resetSelfTodo,
  buildSelfTodoFrame,
  getSelfTodoSnapshot,
  ingestSelfTodoFrame,
  readSelfTodos,
  subscribeSelfTodoEvents,
  SELF_TODO_TOOL,
} from "../lib/self-todo.js";

/** Mirror store.ts#conversationKey + b64url for the on-disk layout. */
function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
function conversationKey(conversationId: string, agentId: string): string {
  return conversationId === "default" ? `default:${agentId}` : `conversation:${conversationId}`;
}

/** Write a conversation's messages.jsonl (one JSON object per line). */
function writeMessages(conversationId: string, agentId: string, lines: unknown[]): void {
  const dir = join(STORE_DIR, "conversations", b64url(conversationKey(conversationId, agentId)));
  mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(dir, "messages.jsonl"), body, "utf8");
}

/** A user message row. */
function userMsg(id: string, text: string) {
  return { id, role: "user", content: [{ type: "text", text }] };
}

/** An assistant row carrying a TodoWrite tool call (on-disk `content` shape). */
function todoWriteMsg(id: string, todos: Array<{ content: string; status: string; activeForm: string }>) {
  return {
    id,
    role: "assistant",
    content: [
      { type: "toolCall", id: `tc-${id}`, name: "TodoWrite", arguments: { todos } },
    ],
  };
}

before(() => {
  __resetSelfTodo();
});
beforeEach(() => {
  __resetSelfTodo();
});

test("self-todo: extractLatestTodos returns the NEWEST TodoWrite (newest-wins) for the main conversation", () => {
  const messages = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
    {
      id: "m2",
      role: "assistant",
      parts: [{ type: "toolCall", name: "TodoWrite", arguments: JSON.stringify({ todos: [
        { content: "old", status: "pending", activeForm: "Olding" },
      ] }) }],
    },
    {
      id: "m3",
      role: "assistant",
      parts: [{ type: "toolCall", name: "TodoWrite", arguments: { todos: [
        { content: "newer A", status: "completed", activeForm: "Doing A" },
        { content: "newer B", status: "in_progress", activeForm: "Doing B" },
      ] } }],
    },
  ] as unknown as Parameters<typeof extractLatestTodos>[0];
  const snap = extractLatestTodos(messages);
  assert.equal(snap.found, true);
  assert.equal(snap.todos.length, 2);
  assert.equal(snap.todos[0]!.content, "newer A");
  assert.equal(snap.todos[1]!.status, "in_progress");
});

test("self-todo: readConversationTodos reads the MAIN agent's transcript from the store", () => {
  const agentId = "agent-local-main-1";
  const conversationId = "default";
  writeMessages(conversationId, agentId, [
    userMsg("u1", "plan it"),
    todoWriteMsg("a1", [
      { content: "step 1", status: "completed", activeForm: "Stepping 1" },
      { content: "step 2", status: "in_progress", activeForm: "Stepping 2" },
      { content: "step 3", status: "pending", activeForm: "Stepping 3" },
    ]),
  ]);

  const snap = readConversationTodos(agentId, conversationId);
  assert.equal(snap.found, true, "TodoWrite should be found on disk");
  assert.equal(snap.todos.length, 3);
  assert.deepEqual(
    snap.todos.map((t) => t.status),
    ["completed", "in_progress", "pending"],
  );
  // readSelfTodos is the named entry point the host uses — same result.
  const viaSelf = readSelfTodos(agentId, conversationId);
  assert.deepEqual(viaSelf.todos, snap.todos);
});

test("self-todo: readConversationTodos returns not-found when no TodoWrite was called", () => {
  const agentId = "agent-local-main-2";
  writeMessages("default", agentId, [userMsg("u1", "just chatting")]);
  const snap = readConversationTodos(agentId, "default");
  assert.equal(snap.found, false);
  assert.equal(snap.todos.length, 0);
});

test("self-todo: ingestSelfTodoFrame records the snapshot + fires a change event", () => {
  const events: Array<{ conversationId: string; todos: unknown[] }> = [];
  const unsub = subscribeSelfTodoEvents((e) => events.push({ conversationId: e.conversationId, todos: e.todos }));

  const frame = {
    message_type: "tool_call_message",
    tool_call: {
      tool_call_id: "tc-1",
      name: SELF_TODO_TOOL,
      arguments: JSON.stringify({ todos: [
        { content: "build the shim half", status: "in_progress", activeForm: "Building the shim half" },
      ] }),
    },
  };
  const snap = ingestSelfTodoFrame(frame, "conv-default-agent-local-main-1", "agent-local-main-1");
  assert.ok(snap, "TodoWrite frame should produce a snapshot");
  assert.equal(snap!.conversationId, "conv-default-agent-local-main-1");
  assert.equal(snap!.todos.length, 1);
  assert.equal(snap!.todos[0]!.content, "build the shim half");

  assert.equal(events.length, 1, "exactly one change event");
  assert.equal(events[0]!.conversationId, "conv-default-agent-local-main-1");

  const live = getSelfTodoSnapshot("conv-default-agent-local-main-1");
  assert.deepEqual(live!.todos, snap!.todos);
  unsub();
});

test("self-todo: ingestSelfTodoFrame ignores non-TodoWrite tool calls", () => {
  const frame = {
    message_type: "tool_call_message",
    tool_call: { tool_call_id: "tc-2", name: "Bash", arguments: JSON.stringify({ command: "ls" }) },
  };
  const snap = ingestSelfTodoFrame(frame, "conv-x", "agent-local-x");
  assert.equal(snap, null);
  assert.equal(getSelfTodoSnapshot("conv-x"), null);
});

test("self-todo: buildSelfTodoFrame matches the mobile tool_call_message contract", () => {
  const todos = [
    { content: "a", status: "completed" as const, activeForm: "A" },
    { content: "b", status: "pending" as const, activeForm: "B" },
  ];
  const frame = buildSelfTodoFrame("conv-default-agent-local-main-1", "agent-local-main-1", todos);

  // Mobile's ServerFrame.ToolCallMessage requires these as NON-NULL strings.
  assert.equal(frame["type"], "tool_call_message");
  assert.equal(frame["message_type"], "tool_call_message");
  assert.equal(frame["conversation_id"], "conv-default-agent-local-main-1");
  assert.equal(typeof frame["agent_id"], "string");
  assert.equal(typeof frame["turn_id"], "string");
  assert.equal(typeof frame["run_id"], "string");

  // tool_call (singular) + tool_calls (array) both carry the same payload.
  const tc = frame["tool_call"] as { name: string; arguments: string; tool_call_id: string };
  assert.equal(tc.name, "TodoWrite");
  assert.equal(typeof tc.arguments, "string", "arguments must be a JSON STRING (mobile parses it)");
  const parsed = JSON.parse(tc.arguments) as { todos: typeof todos };
  assert.deepEqual(parsed.todos, todos);
  const arr = frame["tool_calls"] as Array<{ tool_call_id: string }>;
  assert.equal(arr.length, 1);
  assert.equal(arr[0]!.tool_call_id, tc.tool_call_id);
});
