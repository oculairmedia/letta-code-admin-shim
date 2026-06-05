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

/**
 * A TaskCreate call whose tool RESULT carries the harness-assigned
 * `task_<n>` id — the authoritative list-reset signal (a `task_1` after a
 * non-empty list begins a fresh working list). Returns the [call, result]
 * message pair so a realistic transcript can interleave them.
 */
function taskCreateWithResult(
  id: string,
  args: { subject: string; activeForm?: string },
  assignedTaskId: string,
) {
  const callId = `tc-${id}`;
  return [
    { id, role: "assistant", content: [{ type: "toolCall", id: callId, name: "TaskCreate", arguments: args }] },
    {
      id: `${id}-r`,
      role: "toolResult",
      toolCallId: callId,
      toolName: "TaskCreate",
      content: [{ type: "text", text: JSON.stringify({ taskId: assignedTaskId, ...args, status: "pending" }) }],
    },
  ];
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

test("self-todo: readSelfTodos reads normal conversation:<conv-id> session tasks without subagent contamination", () => {
  const mainAgentId = "agent-main-normal";
  const mainConversationId = "conv-main-normal";
  const subagentId = "agent-subagent-default";

  writeMessages("default", subagentId, [
    todoWriteMsg("sub-a1", [
      { content: "Trace shim streaming hot path", status: "in_progress", activeForm: "Tracing shim streaming hot path" },
    ]),
  ]);
  writeMessages(mainConversationId, mainAgentId, [
    userMsg("main-u1", "make session tasks"),
    taskCallMsg("main-a1", "TaskCreate", { subject: "Validate the self chip renders", activeForm: "Validating the self chip renders" }),
    taskCallMsg("main-a2", "TaskCreate", { subject: "Confirm progress updates", activeForm: "Confirming progress updates" }),
    taskCallMsg("main-a3", "TaskUpdate", { taskId: "task_1", status: "completed" }),
    taskCallMsg("main-a4", "TaskUpdate", { taskId: "task_2", status: "in_progress" }),
  ]);

  const snap = readSelfTodos(mainAgentId, mainConversationId);
  assert.equal(snap.found, true);
  assert.deepEqual(snap.todos.map((t) => t.content), [
    "Validate the self chip renders",
    "Confirm progress updates",
  ]);
  assert.deepEqual(snap.todos.map((t) => t.status), ["completed", "in_progress"]);
});

test("self-todo: main conversation session tasks win over stale default TodoWrite for same agent", () => {
  const agentId = "agent-main-with-stale-default";
  const conversationId = "conv-main-with-session-tasks";

  writeMessages("default", agentId, [
    todoWriteMsg("default-a1", [
      { content: "stale default TodoWrite", status: "in_progress", activeForm: "Reading stale default TodoWrite" },
    ]),
  ]);
  writeMessages(conversationId, agentId, [
    taskCallMsg("main-a1", "TaskCreate", { subject: "fresh normal conversation task", activeForm: "Reading fresh normal conversation task" }),
  ]);

  const snap = readSelfTodos(agentId, conversationId);
  assert.equal(snap.found, true);
  assert.deepEqual(snap.todos.map((t) => t.content), ["fresh normal conversation task"]);
});

test("self-todo: ingestSelfTodoFrame accepts run frame toolCalls and explicit effective ids", () => {
  const conv = "conv-explicit-main";
  const agentId = "agent-explicit-main";
  const created = ingestSelfTodoFrame(
    {
      type: "tool_call_message",
      toolCalls: [
        { id: "call-create", name: "TaskCreate", arguments: { subject: "Validate the self chip renders", activeForm: "Validating the self chip renders" } },
      ],
    },
    conv,
    agentId,
  );
  assert.ok(created);
  assert.equal(created!.conversationId, conv);
  assert.equal(created!.agentId, agentId);
  assert.equal(created!.todos[0]!.content, "Validate the self chip renders");

  const updated = ingestSelfTodoFrame(
    {
      type: "tool_call_message",
      toolCalls: [
        { id: "call-update", name: "TaskUpdate", arguments: { taskId: "task_1", status: "in_progress" } },
      ],
    },
    conv,
    agentId,
  );
  assert.ok(updated);
  assert.equal(getSelfTodoSnapshot(conv)!.todos[0]!.status, "in_progress");
});

test("self-todo: readSelfTodos prefers session tasks over TodoWrite when both exist in a main conversation", () => {
  const agentId = "agent-local-both";
  const conversationId = "conv-local-both";
  writeMessages(conversationId, agentId, [
    taskCallMsg("a1", "TaskCreate", { subject: "session task", activeForm: "Session tasking" }),
    todoWriteMsg("a2", [{ content: "stale todowrite", status: "in_progress", activeForm: "Reading stale TodoWrite" }]),
  ]);
  const snap = readSelfTodos(agentId, conversationId);
  assert.equal(snap.found, true);
  assert.equal(snap.todos.length, 1);
  assert.equal(snap.todos[0]!.content, "session task");
});

test("self-todo: ingestSelfTodoFrame still ignores non-plan tool calls (Bash)", () => {
  const frame = {
    message_type: "tool_call_message",
    tool_call: { tool_call_id: "tc-b", name: "Bash", arguments: JSON.stringify({ command: "ls" }) },
  };
  assert.equal(ingestSelfTodoFrame(frame, "conv-nope", "agent-local-nope"), null);
  assert.equal(getSelfTodoSnapshot("conv-nope"), null);
});

// ── letta-mobile-jb4gu defect 1: LIVE reshaped-frame shape (dual carriage) ──
//
// The reshaped frame the host emits (and persists to runs/<id>/frames.jsonl)
// carries the SAME tool call in BOTH `tool_call` (singular) AND
// `tool_calls` (array) — reshapeFrame sets `tool_calls: tcs ?? (tc ? [tc] :
// null)`. The pre-fix ingest folded BOTH, doubling every TaskCreate so a
// 2-task list projected 4 items. This is the exact live shape captured from
// runs/run-5ed0af20.../frames.jsonl.
test("self-todo: live reshaped frame carrying tool_call AND tool_calls (same call) folds ONCE, not twice", () => {
  const conv = "conv-live-dual-carriage";
  const agentId = "agent-live-dual";

  const createCall = {
    tool_call_id: "toolu_live_1",
    name: "TaskCreate",
    arguments: JSON.stringify({
      subject: "Self chip retest after #28",
      description: "Validate self-todo chip now shows main-conversation tasks.",
      activeForm: "Retesting self chip",
    }),
  };
  // EXACT live shape: singular `tool_call` duplicated into `tool_calls[]`.
  const snap = ingestSelfTodoFrame(
    {
      id: "toolcall-toolu_live_1",
      message_type: "tool_call_message",
      tool_call: createCall,
      tool_calls: [createCall],
    },
    conv,
    agentId,
  );
  assert.ok(snap, "live dual-carriage TaskCreate frame must produce a snapshot (not NULL)");
  // The defect produced length 2 (the same task twice). Must be exactly 1.
  assert.equal(snap!.todos.length, 1, "the duplicated tool_call/tool_calls entry must fold ONCE");
  assert.equal(snap!.todos[0]!.content, "Self chip retest after #28");

  // getSelfTodoSnapshot(conv) is NON-NULL after the live ingest.
  const live = getSelfTodoSnapshot(conv);
  assert.ok(live, "getSelfTodoSnapshot must be non-null after a live ingest");
  assert.equal(live!.todos.length, 1);

  // A second dual-carriage create extends the (still single) current list.
  const create2 = {
    tool_call_id: "toolu_live_2",
    name: "TaskCreate",
    arguments: JSON.stringify({ subject: "Confirm correct tasks (not stale)", activeForm: "Confirming correct tasks" }),
  };
  const snap2 = ingestSelfTodoFrame(
    { message_type: "tool_call_message", tool_call: create2, tool_calls: [create2] },
    conv,
    agentId,
  );
  assert.equal(snap2!.todos.length, 2, "two distinct creates -> two tasks (no doubling)");
  assert.deepEqual(snap2!.todos.map((t) => t.content), [
    "Self chip retest after #28",
    "Confirm correct tasks (not stale)",
  ]);
});

// ── letta-mobile-jb4gu defect 2: live ingest must scope to the CURRENT list ──
//
// A TaskCreate that follows a TaskUpdate starts a NEW working list (the
// harness `task_<n>` counter resets). The live accumulator must drop the
// prior list instead of piling up across sessions.
test("self-todo: live ingest resets the list when a new TaskCreate follows a TaskUpdate", () => {
  const conv = "conv-live-reset";
  const agentId = "agent-live-reset";
  const frame = (name: "TaskCreate" | "TaskUpdate", id: string, args: unknown) => ({
    message_type: "tool_call_message",
    tool_call: { tool_call_id: id, name, arguments: JSON.stringify(args) },
  });

  // List A: one task, then mark it in_progress.
  ingestSelfTodoFrame(frame("TaskCreate", "a1", { subject: "Old list task", activeForm: "Old listing" }), conv, agentId);
  ingestSelfTodoFrame(frame("TaskUpdate", "a2", { taskId: "task_1", status: "in_progress" }), conv, agentId);

  // List B (NEW): create-after-update resets. task_1 now refers to the new task.
  ingestSelfTodoFrame(frame("TaskCreate", "b1", { subject: "Fresh list task one", activeForm: "Freshing one" }), conv, agentId);
  const snapB2 = ingestSelfTodoFrame(
    frame("TaskCreate", "b2", { subject: "Fresh list task two", activeForm: "Freshing two" }),
    conv,
    agentId,
  );
  assert.equal(snapB2!.todos.length, 2, "current list is the NEW 2-task list, not 3 (no pile-up)");
  assert.deepEqual(snapB2!.todos.map((t) => t.content), [
    "Fresh list task one",
    "Fresh list task two",
  ]);

  // A TaskUpdate task_1 in the new list targets "Fresh list task one".
  const updated = ingestSelfTodoFrame(frame("TaskUpdate", "b3", { taskId: "task_1", status: "completed" }), conv, agentId);
  assert.equal(updated!.todos[0]!.content, "Fresh list task one");
  assert.equal(updated!.todos[0]!.status, "completed");
  assert.equal(getSelfTodoSnapshot(conv)!.todos.length, 2);
});

// ── letta-mobile-jb4gu defect 2: disk reconstruct returns ONLY the current list ──
//
// A realistic transcript folds MULTIPLE task-list sessions (each begins with
// an assigned `task_1`). reconstructSessionTasks must surface ONLY the last
// (current) list, honoring the authoritative reset signal from the
// TaskCreate tool RESULT — not pile up all 6 tasks across 3 sessions.
test("self-todo: reconstruct returns ONLY the current list across multiple reset sessions (not the whole history)", () => {
  const agentId = "agent-local-multi-session";
  const conversationId = "conv-multi-session";
  writeMessages(conversationId, agentId, [
    userMsg("u1", "plan it"),
    // Session 1: task_1 only, then completed.
    ...taskCreateWithResult("s1c1", { subject: "Old session one", activeForm: "Olding one" }, "task_1"),
    taskCallMsg("s1u1", "TaskUpdate", { taskId: "task_1", status: "completed" }),
    // Session 2 (RESET -> task_1): two tasks, worked.
    ...taskCreateWithResult("s2c1", { subject: "Mid session one", activeForm: "Midding one" }, "task_1"),
    ...taskCreateWithResult("s2c2", { subject: "Mid session two", activeForm: "Midding two" }, "task_2"),
    taskCallMsg("s2u1", "TaskUpdate", { taskId: "task_1", status: "completed" }),
    taskCallMsg("s2u2", "TaskUpdate", { taskId: "task_2", status: "in_progress" }),
    // Session 3 (CURRENT, RESET -> task_1): the live working set.
    ...taskCreateWithResult("s3c1", { subject: "Current session A", activeForm: "Currenting A" }, "task_1"),
    ...taskCreateWithResult("s3c2", { subject: "Current session B", activeForm: "Currenting B" }, "task_2"),
    taskCallMsg("s3u1", "TaskUpdate", { taskId: "task_1", status: "in_progress" }),
  ]);

  const snap = readSelfTodos(agentId, conversationId);
  assert.equal(snap.found, true);
  assert.equal(snap.todos.length, 2, "only the CURRENT 2-task list, not all 5 tasks ever created");
  assert.deepEqual(snap.todos.map((t) => t.content), ["Current session A", "Current session B"]);
  assert.deepEqual(snap.todos.map((t) => t.status), ["in_progress", "pending"]);
});

// Reconstruct heuristic fallback: even without tool results, a create that
// follows an update resets the list (the live stream has no correlated
// result for the disk fold).
test("self-todo: reconstruct without tool results falls back to create-after-update reset", () => {
  const agentId = "agent-local-heuristic";
  const conversationId = "conv-heuristic";
  writeMessages(conversationId, agentId, [
    taskCallMsg("c1", "TaskCreate", { subject: "old A", activeForm: "Old A" }),
    taskCallMsg("u1", "TaskUpdate", { taskId: "task_1", status: "completed" }),
    // create-after-update => new list
    taskCallMsg("c2", "TaskCreate", { subject: "new A", activeForm: "New A" }),
    taskCallMsg("c3", "TaskCreate", { subject: "new B", activeForm: "New B" }),
    taskCallMsg("u2", "TaskUpdate", { taskId: "task_2", status: "in_progress" }),
  ]);
  const snap = readSelfTodos(agentId, conversationId);
  assert.equal(snap.todos.length, 2, "current list only (new A, new B)");
  assert.deepEqual(snap.todos.map((t) => t.content), ["new A", "new B"]);
  assert.deepEqual(snap.todos.map((t) => t.status), ["pending", "in_progress"]);
});
