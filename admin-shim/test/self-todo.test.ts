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

/** An assistant row carrying a session task-list tool call (TaskCreate/TaskUpdate). */
function taskCallMsg(id: string, name: "TaskCreate" | "TaskUpdate", args: unknown) {
  return {
    id,
    role: "assistant",
    content: [{ type: "toolCall", id: `tc-${id}`, name, arguments: args }],
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

// ── letta-mobile-rp1vp: MAIN agent's session task list → self chip ──────

test("self-todo: ingestSelfTodoFrame folds TaskCreate/TaskUpdate frames into the snapshot", () => {
  const events: Array<{ todos: Array<{ content: string; status: string }> }> = [];
  const unsub = subscribeSelfTodoEvents((e) =>
    events.push({ todos: e.todos.map((t) => ({ content: t.content, status: t.status })) }),
  );
  const conv = "conv-default-agent-local-main-rp1vp";

  // TaskCreate "Build" (task_1)
  const created = ingestSelfTodoFrame(
    {
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: "tc-c1",
        name: "TaskCreate",
        arguments: JSON.stringify({ subject: "Build the shim", description: "x", activeForm: "Building the shim" }),
      },
    },
    conv,
    "agent-local-main-rp1vp",
  );
  assert.ok(created, "TaskCreate frame should produce a snapshot");
  assert.equal(created!.todos.length, 1);
  assert.equal(created!.todos[0]!.content, "Build the shim");
  assert.equal(created!.todos[0]!.status, "pending");

  // TaskUpdate task_1 -> in_progress (separate frame; must resolve via accumulator)
  const updated = ingestSelfTodoFrame(
    {
      message_type: "tool_call_message",
      tool_call: { tool_call_id: "tc-u1", name: "TaskUpdate", arguments: JSON.stringify({ taskId: "task_1", status: "in_progress" }) },
    },
    conv,
    "agent-local-main-rp1vp",
  );
  assert.ok(updated, "TaskUpdate frame should produce a snapshot");
  assert.equal(updated!.todos[0]!.status, "in_progress");

  const live = getSelfTodoSnapshot(conv);
  assert.equal(live!.todos[0]!.status, "in_progress");
  // one event per ingested frame
  assert.equal(events.length, 2);
  assert.deepEqual(events[1]!.todos, [{ content: "Build the shim", status: "in_progress" }]);
  unsub();
});

test("self-todo: ingest emits the SAME TodoWrite-shaped frame mobile parses for session tasks", () => {
  const conv = "conv-default-agent-local-main-frame";
  ingestSelfTodoFrame(
    {
      message_type: "tool_call_message",
      tool_call: { tool_call_id: "c", name: "TaskCreate", arguments: JSON.stringify({ subject: "Ship it", activeForm: "Shipping it" }) },
    },
    conv,
    "agent-local-main-frame",
  );
  const snap = getSelfTodoSnapshot(conv);
  const frame = buildSelfTodoFrame(conv, snap!.agentId, snap!.todos);
  // Still a TodoWrite-shaped frame — mobile side is unchanged.
  const tc = frame["tool_call"] as { name: string; arguments: string };
  assert.equal(tc.name, SELF_TODO_TOOL);
  const parsed = JSON.parse(tc.arguments) as { todos: Array<{ content: string; activeForm: string }> };
  assert.equal(parsed.todos[0]!.content, "Ship it");
  assert.equal(parsed.todos[0]!.activeForm, "Shipping it");
});

test("self-todo: readSelfTodos reconstructs the session task list from disk when no TodoWrite exists", () => {
  const agentId = "agent-local-session-disk";
  const conversationId = "default";
  writeMessages(conversationId, agentId, [
    userMsg("u1", "plan it"),
    taskCallMsg("a1", "TaskCreate", { subject: "step 1", description: "x", activeForm: "Stepping 1" }),
    taskCallMsg("a2", "TaskCreate", { subject: "step 2", description: "x", activeForm: "Stepping 2" }),
    taskCallMsg("a3", "TaskUpdate", { taskId: "task_1", status: "completed" }),
    taskCallMsg("a4", "TaskUpdate", { taskId: "task_2", status: "in_progress" }),
  ]);

  const snap = readSelfTodos(agentId, conversationId);
  assert.equal(snap.found, true, "session task list should be found on disk");
  assert.equal(snap.todos.length, 2);
  assert.deepEqual(snap.todos.map((t) => t.status), ["completed", "in_progress"]);
  assert.deepEqual(snap.todos.map((t) => t.content), ["step 1", "step 2"]);
});

test("self-todo: readSelfTodos prefers TodoWrite over the session task list when both exist", () => {
  const agentId = "agent-local-both";
  const conversationId = "default";
  writeMessages(conversationId, agentId, [
    taskCallMsg("a1", "TaskCreate", { subject: "session task", activeForm: "Session tasking" }),
    todoWriteMsg("a2", [{ content: "todowrite wins", status: "in_progress", activeForm: "Winning" }]),
  ]);
  const snap = readSelfTodos(agentId, conversationId);
  assert.equal(snap.found, true);
  assert.equal(snap.todos.length, 1);
  assert.equal(snap.todos[0]!.content, "todowrite wins");
});

test("self-todo: ingestSelfTodoFrame still ignores non-plan tool calls (Bash)", () => {
  const frame = {
    message_type: "tool_call_message",
    tool_call: { tool_call_id: "tc-b", name: "Bash", arguments: JSON.stringify({ command: "ls" }) },
  };
  assert.equal(ingestSelfTodoFrame(frame, "conv-nope", "agent-local-nope"), null);
  assert.equal(getSelfTodoSnapshot("conv-nope"), null);
});
