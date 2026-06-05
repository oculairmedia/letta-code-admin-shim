/**
 * Session task-list -> self-todo mapping (letta-mobile-rp1vp).
 *
 * The MAIN/foreground agent does NOT call `TodoWrite`. It is provisioned
 * with the harness "session task list" tool (`manage_todo`), which surfaces
 * in the lc-local-backend conversation stream as two distinct tool calls:
 *
 *   TaskCreate  arguments: { subject, description, activeForm }
 *   TaskUpdate  arguments: { taskId: "task_<n>", status }
 *
 * (Verified against the live transcript for conversation
 * conv-16c2f589-…: 4x TaskCreate, 4x TaskUpdate; 0 real TaskCreate-style
 * `manage_todo` toolCalls — `manage_todo` is the harness-exposed tool NAME,
 * but it rides the stream as TaskCreate / TaskUpdate parts. Subagents use
 * the separate `TodoWrite` mechanism, handled by subagent-todos.ts.)
 *
 * Tasks are assigned a stable 1-based id in creation order: the first
 * TaskCreate is `task_1`, the second `task_2`, etc. A TaskUpdate references
 * that id and mutates the task's `status` (and, if ever present, its
 * subject/activeForm).
 *
 * This module folds a TaskCreate/TaskUpdate event sequence into the CURRENT
 * task list, mapped into the canonical `TodoItem` shape the mobile
 * SelfTodoRepository already consumes (content / status / activeForm):
 *
 *   subject       -> content
 *   activeForm    -> activeForm
 *   status pending|in_progress|completed -> straight through
 *   status deleted -> the item is DROPPED from the list
 *
 * Both the live frame ingest (self-todo.ts#ingestSelfTodoFrame) and the
 * on-disk transcript read (self-todo.ts#readSelfTodos) build on the same
 * fold, so the self chip reflects the main agent's session task list
 * whether the user was watching the turn or (re)subscribes after it.
 */

import type { LocalMessage } from "./types/letta-stream.js";
import type { TodoItem } from "./subagent-todos.js";

/** Session task-list tool names the main agent's plan rides on. */
export const TASK_CREATE_TOOL = "TaskCreate";
export const TASK_UPDATE_TOOL = "TaskUpdate";

/** Status values the session task list emits. `deleted` drops the item. */
type SessionTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/**
 * Internal mutable accumulator for one task as we fold the event log. We
 * keep `deleted` here (vs the public TodoItem statuses) so a delete can be
 * filtered out at projection time without losing the slot's id ordering.
 */
interface TaskState {
  /** Stable 1-based id: `task_1`, `task_2`, ... (creation order). */
  id: string;
  content: string;
  activeForm: string;
  status: SessionTaskStatus;
}

/** Per-conversation accumulated task state for the LIVE ingest path. */
export interface SessionTaskAccumulator {
  /** Tasks in creation order (id === `task_${index+1}`). */
  tasks: TaskState[];
}

export function newSessionTaskAccumulator(): SessionTaskAccumulator {
  return { tasks: [] };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function coerceStatus(value: unknown): SessionTaskStatus | null {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "deleted"
  ) {
    return value;
  }
  return null;
}

/** Parse a tool call's `arguments` (JSON string OR object) into a record. */
function argsObject(args: unknown): Record<string, unknown> | null {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (args && typeof args === "object") return args as Record<string, unknown>;
  return null;
}

/**
 * Apply one TaskCreate to the accumulator. Appends a new task whose id is
 * `task_${tasks.length + 1}` — matching the harness's 1-based creation
 * order. A create with no subject is still recorded (empty content) so the
 * id sequence stays aligned with subsequent TaskUpdate references.
 */
export function applyTaskCreate(acc: SessionTaskAccumulator, args: unknown): void {
  const obj = argsObject(args);
  if (!obj) return;
  const id = `task_${acc.tasks.length + 1}`;
  const status = coerceStatus(obj["status"]) ?? "pending";
  acc.tasks.push({
    id,
    content: asString(obj["subject"]),
    activeForm: asString(obj["activeForm"]),
    status,
  });
}

/**
 * Apply one TaskUpdate to the accumulator. Locates the task by `taskId` and
 * mutates whichever of status / subject / activeForm the call carries. A
 * reference to an unknown id is ignored (no spurious task is created).
 */
export function applyTaskUpdate(acc: SessionTaskAccumulator, args: unknown): void {
  const obj = argsObject(args);
  if (!obj) return;
  const taskId = asString(obj["taskId"]);
  if (!taskId) return;
  const task = acc.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const status = coerceStatus(obj["status"]);
  if (status) task.status = status;
  // TaskUpdate is only ever seen with {taskId, status} in the live
  // transcript, but tolerate subject/activeForm edits if the harness ever
  // sends them so the projection stays faithful.
  if (typeof obj["subject"] === "string") task.content = obj["subject"];
  if (typeof obj["activeForm"] === "string") task.activeForm = obj["activeForm"];
}

/**
 * Project the accumulator into the canonical `TodoItem[]` mobile consumes.
 * `deleted` tasks are dropped; the remaining tasks keep their creation
 * order. The `task_<n>` ids are intentionally NOT surfaced — mobile's
 * SubagentTodo has no id, it renders content/status/activeForm.
 */
export function projectSessionTasks(acc: SessionTaskAccumulator): TodoItem[] {
  const out: TodoItem[] = [];
  for (const t of acc.tasks) {
    if (t.status === "deleted") continue;
    out.push({ content: t.content, status: t.status, activeForm: t.activeForm });
  }
  return out;
}

/**
 * Read a tool call's `(type, name, arguments)` from a message `part`,
 * tolerating the `toolCall` / `tool-call` part-type variants the on-disk
 * store uses. Returns null when the part is not a tool call.
 */
function toolCallFromPart(part: unknown): { name: string; arguments: unknown } | null {
  if (!part || typeof part !== "object") return null;
  const p = part as Record<string, unknown>;
  const isToolCall = p["type"] === "toolCall" || p["type"] === "tool-call";
  if (!isToolCall) return null;
  const name = typeof p["name"] === "string" ? (p["name"] as string) : "";
  if (!name) return null;
  return { name, arguments: p["arguments"] };
}

export interface SessionTaskSnapshot {
  /** The current session task list, mapped to TodoItem[] (may be empty). */
  todos: TodoItem[];
  /** True iff at least one TaskCreate was seen in the message list. */
  found: boolean;
}

/**
 * Fold a conversation's full message list (oldest-first store order) into
 * the current session task list. Walks forward applying every TaskCreate /
 * TaskUpdate in order, then projects to TodoItem[]. Returns `found:false`
 * (empty list) when the conversation never used the session task list — the
 * caller then leaves the TodoWrite path / empty snapshot in place.
 */
export function reconstructSessionTasks(messages: LocalMessage[]): SessionTaskSnapshot {
  const acc = newSessionTaskAccumulator();
  let sawCreate = false;
  for (const message of messages) {
    const parts = message?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const call = toolCallFromPart(part);
      if (!call) continue;
      if (call.name === TASK_CREATE_TOOL) {
        applyTaskCreate(acc, call.arguments);
        sawCreate = true;
      } else if (call.name === TASK_UPDATE_TOOL) {
        applyTaskUpdate(acc, call.arguments);
      }
    }
  }
  if (!sawCreate) return { todos: [], found: false };
  return { todos: projectSessionTasks(acc), found: true };
}
