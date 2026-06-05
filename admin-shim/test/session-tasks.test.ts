/**
 * Tests for the session task-list -> self-todo mapping (letta-mobile-rp1vp).
 *
 * The MAIN/foreground agent plans with the harness session task list
 * (`manage_todo`), which rides the conversation stream as TaskCreate
 * ({subject, description, activeForm}) and TaskUpdate ({taskId, status})
 * tool calls — NOT TodoWrite. This module folds those events into the
 * canonical TodoItem[] (content / status / activeForm) mobile already
 * consumes. The shapes asserted here are the EXACT ones verified in the
 * live transcript for conversation conv-16c2f589-…:
 *
 *   TaskCreate {subject, description, activeForm}
 *   TaskUpdate {taskId: "task_<n>", status}
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyTaskCreate,
  applyTaskUpdate,
  newSessionTaskAccumulator,
  projectSessionTasks,
  reconstructSessionTasks,
} from "../lib/session-tasks.js";
import type { LocalMessage } from "../lib/types/letta-stream.js";

/** Build an assistant message carrying a tool call (on-disk `parts` shape). */
function toolCallMsg(id: string, name: string, args: unknown): LocalMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "toolCall", id: `tc-${id}`, name, arguments: args }],
  } as unknown as LocalMessage;
}

test("session-tasks: TaskCreate assigns 1-based task ids in creation order; subject->content, activeForm->activeForm", () => {
  const acc = newSessionTaskAccumulator();
  applyTaskCreate(acc, {
    subject: "Finish pbnxa chrome PR",
    description: "...",
    activeForm: "Finishing pbnxa chrome PR",
  });
  applyTaskCreate(acc, {
    subject: "Inspect the codebase",
    description: "...",
    activeForm: "Inspecting the codebase",
  });
  // ids are task_1, task_2 (creation order)
  assert.deepEqual(acc.tasks.map((t) => t.id), ["task_1", "task_2"]);
  const todos = projectSessionTasks(acc);
  assert.equal(todos.length, 2);
  assert.equal(todos[0]!.content, "Finish pbnxa chrome PR");
  assert.equal(todos[0]!.activeForm, "Finishing pbnxa chrome PR");
  // a freshly-created task defaults to pending
  assert.equal(todos[0]!.status, "pending");
  assert.equal(todos[1]!.content, "Inspect the codebase");
});

test("session-tasks: TaskUpdate mutates status by taskId; pending|in_progress|completed map straight", () => {
  const acc = newSessionTaskAccumulator();
  applyTaskCreate(acc, { subject: "A", activeForm: "Aing" });
  applyTaskCreate(acc, { subject: "B", activeForm: "Bing" });
  applyTaskUpdate(acc, { taskId: "task_1", status: "in_progress" });
  applyTaskUpdate(acc, { taskId: "task_1", status: "completed" });
  applyTaskUpdate(acc, { taskId: "task_2", status: "in_progress" });
  const todos = projectSessionTasks(acc);
  assert.deepEqual(todos.map((t) => t.status), ["completed", "in_progress"]);
});

test("session-tasks: status 'deleted' DROPS the item from the projected list", () => {
  const acc = newSessionTaskAccumulator();
  applyTaskCreate(acc, { subject: "keep me", activeForm: "Keeping" });
  applyTaskCreate(acc, { subject: "drop me", activeForm: "Dropping" });
  applyTaskCreate(acc, { subject: "also keep", activeForm: "Keeping too" });
  applyTaskUpdate(acc, { taskId: "task_2", status: "deleted" });
  const todos = projectSessionTasks(acc);
  assert.equal(todos.length, 2, "deleted task is dropped");
  assert.deepEqual(todos.map((t) => t.content), ["keep me", "also keep"]);
});

test("session-tasks: TaskUpdate referencing an unknown id is ignored (no phantom task)", () => {
  const acc = newSessionTaskAccumulator();
  applyTaskCreate(acc, { subject: "A", activeForm: "Aing" });
  applyTaskUpdate(acc, { taskId: "task_99", status: "completed" });
  const todos = projectSessionTasks(acc);
  assert.equal(todos.length, 1);
  assert.equal(todos[0]!.status, "pending");
});

test("session-tasks: arguments accepted as a JSON STRING too (OpenAI/Letta convention)", () => {
  const acc = newSessionTaskAccumulator();
  applyTaskCreate(acc, JSON.stringify({ subject: "S", activeForm: "Sing" }));
  applyTaskUpdate(acc, JSON.stringify({ taskId: "task_1", status: "in_progress" }));
  const todos = projectSessionTasks(acc);
  assert.equal(todos.length, 1);
  assert.equal(todos[0]!.content, "S");
  assert.equal(todos[0]!.status, "in_progress");
});

test("session-tasks: reconstructSessionTasks folds a whole transcript (mirrors the live conv-16c2f589 sequence)", () => {
  // Exactly the verified live sequence: create, update->in_progress,
  // update->completed, three more creates, then two updates.
  const messages: LocalMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] } as unknown as LocalMessage,
    toolCallMsg("a1", "TaskCreate", { subject: "Finish pbnxa chrome PR", description: "x", activeForm: "Finishing pbnxa chrome PR" }),
    toolCallMsg("a2", "TaskUpdate", { taskId: "task_1", status: "in_progress" }),
    toolCallMsg("a3", "TaskUpdate", { taskId: "task_1", status: "completed" }),
    toolCallMsg("a4", "TaskCreate", { subject: "Inspect the codebase", description: "x", activeForm: "Inspecting the codebase" }),
    toolCallMsg("a5", "TaskCreate", { subject: "Run the build", description: "x", activeForm: "Running the build" }),
    toolCallMsg("a6", "TaskCreate", { subject: "Write the tests", description: "x", activeForm: "Writing the tests" }),
    toolCallMsg("a7", "TaskUpdate", { taskId: "task_1", status: "completed" }),
    toolCallMsg("a8", "TaskUpdate", { taskId: "task_2", status: "in_progress" }),
  ];
  const snap = reconstructSessionTasks(messages);
  assert.equal(snap.found, true);
  assert.equal(snap.todos.length, 4);
  assert.deepEqual(
    snap.todos.map((t) => ({ content: t.content, status: t.status })),
    [
      { content: "Finish pbnxa chrome PR", status: "completed" },
      { content: "Inspect the codebase", status: "in_progress" },
      { content: "Run the build", status: "pending" },
      { content: "Write the tests", status: "pending" },
    ],
  );
  // activeForm is carried through.
  assert.equal(snap.todos[1]!.activeForm, "Inspecting the codebase");
});

test("session-tasks: reconstructSessionTasks returns not-found when no TaskCreate appears", () => {
  const messages: LocalMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } as unknown as LocalMessage,
    toolCallMsg("a1", "Bash", { command: "ls" }),
  ];
  const snap = reconstructSessionTasks(messages);
  assert.equal(snap.found, false);
  assert.equal(snap.todos.length, 0);
});

test("session-tasks: tolerates 'tool-call' part-type variant", () => {
  const msg = {
    id: "a1",
    role: "assistant",
    parts: [{ type: "tool-call", id: "tc-a1", name: "TaskCreate", arguments: { subject: "X", activeForm: "Xing" } }],
  } as unknown as LocalMessage;
  const snap = reconstructSessionTasks([msg]);
  assert.equal(snap.found, true);
  assert.equal(snap.todos[0]!.content, "X");
});
