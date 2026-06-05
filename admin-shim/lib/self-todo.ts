/**
 * Self-todo emit (letta-mobile-gnyf7).
 *
 * The MAIN/foreground agent's OWN TodoWrite calls are NOT carried by the
 * dispatched-subagent registry (subagent-registry.ts) — they ride the
 * ordinary conversation stream as a `tool_call_message` whose
 * `tool_call.name === "TodoWrite"`. Mobile's `SelfTodoRepository`
 * (letta-mobile-gnyf7) consumes exactly that frame, keyed by
 * `conversation_id`, and renders a synthetic "self" chip from the latest
 * snapshot per conversation.
 *
 * The mobile contract (verified against
 * core/data/.../repository/SelfTodoRepository.kt +
 * sharedLogic/.../transport/MobileWsFrames.kt#ToolCallMessage):
 *
 *   {
 *     "type": "tool_call_message",
 *     "conversation_id": "<conv>",
 *     "tool_call": {
 *       "tool_call_id": "<id>",
 *       "name": "TodoWrite",
 *       "arguments": "{\"todos\":[{content,status,activeForm}, ...]}"
 *     },
 *     "tool_calls": [ ...same... ]
 *   }
 *
 * `arguments` is a JSON *string* (OpenAI/Letta convention) — mobile parses
 * it with `Json.parseToJsonElement(arguments).jsonObject["todos"]`.
 *
 * What this module adds on top of the already-live turn stream:
 *  1. An in-memory per-conversation snapshot of the main agent's latest
 *     TodoWrite, fed from the live frame stream (`ingestSelfTodoFrame`).
 *  2. A change-event bus (mirrors subagent-registry's minimal pub/sub) so a
 *     connected socket can push the fresh snapshot the instant it changes.
 *  3. A disk-backed read (`readSelfTodos`) + frame builder
 *     (`buildSelfTodoFrame`) so a (re)subscribing socket can be handed the
 *     CURRENT snapshot even if the user wasn't watching when the TodoWrite
 *     landed — the gap that left the chip empty (gnyf7).
 *
 * The bus is intentionally minimal (no replay/buffering); the canonical
 * state is the live map + the on-disk transcript, both re-readable on
 * demand.
 */

import { extractLatestTodos, readConversationTodos, type TodoItem, type TodoSnapshot } from "./subagent-todos.js";
import {
  TASK_CREATE_TOOL,
  TASK_UPDATE_TOOL,
  applyTaskCreate,
  applyTaskUpdate,
  newSessionTaskAccumulator,
  projectSessionTasks,
  reconstructSessionTasks,
  type SessionTaskAccumulator,
} from "./session-tasks.js";
import { listMessagesSync } from "./store.js";
import type { LocalMessage } from "./types/letta-stream.js";
import type { ToolCall, ToolCallMessage } from "./types/wire.js";

/** Tool name the (sub)agent's self-plan rides on (subagent path). */
export const SELF_TODO_TOOL = "TodoWrite";

/** A self-todo snapshot for one conversation. */
export interface SelfTodoSnapshot {
  conversationId: string;
  agentId: string | null;
  todos: TodoItem[];
}

export interface SelfTodoEvent {
  conversationId: string;
  agentId: string | null;
  todos: TodoItem[];
  at: string;
}

type Listener = (event: SelfTodoEvent) => void;

// conversationId -> latest known self-todo snapshot.
const _byConversation = new Map<string, SelfTodoSnapshot>();
// conversationId -> live session task-list accumulator (letta-mobile-rp1vp).
// The MAIN agent's plan rides TaskCreate/TaskUpdate, not TodoWrite; we fold
// those events here so a TaskUpdate's `task_<n>` resolves against the
// matching TaskCreate even though they arrive on separate frames.
const _sessionTasksByConversation = new Map<string, SessionTaskAccumulator>();
const _listeners = new Set<Listener>();

function nowIso(): string {
  return new Date().toISOString();
}

function emit(snapshot: SelfTodoSnapshot): void {
  const event: SelfTodoEvent = {
    conversationId: snapshot.conversationId,
    agentId: snapshot.agentId,
    todos: snapshot.todos,
    at: nowIso(),
  };
  for (const listener of _listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[self-todo] listener threw:", err);
    }
  }
}

/** Register a listener for self-todo change events. Returns an unsubscribe. */
export function subscribeSelfTodoEvents(listener: Listener): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/**
 * Tool names whose tool_call_message frames carry the main agent's plan:
 *  - TodoWrite: the subagent/legacy self-plan mechanism.
 *  - TaskCreate / TaskUpdate: the MAIN agent's session task list
 *    (letta-mobile-rp1vp) — the harness `manage_todo` tool surfaces as
 *    these two call names in the stream.
 */
const SELF_TODO_FRAME_TOOLS = new Set<string>([
  SELF_TODO_TOOL,
  TASK_CREATE_TOOL,
  TASK_UPDATE_TOOL,
]);

/**
 * Extract every plan-carrying tool call (TodoWrite / TaskCreate /
 * TaskUpdate), IN ORDER, from a reshaped `tool_call_message` frame. Mirrors
 * mobile's `allToolCalls()` union over `tool_call` (singular) + `tool_calls`
 * (array). Returns [] when the frame carries none.
 */
function planCallsFromFrame(frame: unknown): ToolCall[] {
  if (!frame || typeof frame !== "object") return [];
  const f = frame as Record<string, unknown>;
  if (f["message_type"] !== "tool_call_message" && f["type"] !== "tool_call_message") return [];
  const single = (f["tool_call"] ?? f["toolCall"] ?? null) as ToolCall | null;
  const many = (f["tool_calls"] ?? f["toolCalls"] ?? null) as ToolCall[] | null;
  const calls: ToolCall[] = [];
  if (single) calls.push(single);
  if (Array.isArray(many)) calls.push(...many);
  return calls.map(normalizeToolCall).filter(
    (call) => call && typeof call === "object" && SELF_TODO_FRAME_TOOLS.has(call.name),
  );
}

function normalizeToolCall(call: ToolCall): ToolCall {
  const raw = call as ToolCall & { id?: string };
  return raw.tool_call_id ? raw : { ...raw, tool_call_id: raw.id ?? "" };
}

/**
 * Coerce a tool call's `arguments` (JSON string or object) into the
 * canonical TodoItem[] by reusing the subagent extractor's logic. We wrap
 * the single tool call in a one-message list so `extractLatestTodos`
 * (battle-tested for the subagent path) is the single source of truth for
 * the `{todos:[...]}` parsing.
 */
function todosFromCall(call: ToolCall): TodoItem[] {
  const synthetic = {
    // Only `parts` is read by extractLatestTodos; the rest is structural.
    parts: [{ type: "toolCall", name: SELF_TODO_TOOL, arguments: call.arguments }],
  } as unknown as LocalMessage;
  return extractLatestTodos([synthetic]).todos;
}

/**
 * Feed a reshaped bridge frame to the self-todo tracker. Cheaply ignores
 * everything that is not a plan-carrying tool call (TodoWrite for the
 * subagent/legacy path; TaskCreate / TaskUpdate for the MAIN agent's
 * session task list — letta-mobile-rp1vp). On a plan frame it records the
 * latest snapshot for the frame's `conversation_id` and broadcasts a change
 * event so connected sockets can push the fresh snapshot.
 *
 * For the session task list, TaskCreate/TaskUpdate events are FOLDED into a
 * per-conversation accumulator so a TaskUpdate's `task_<n>` reference
 * resolves against its earlier TaskCreate (the two ride separate frames).
 * A TodoWrite frame still wins as a full-list snapshot.
 *
 * Returns the updated snapshot (or null if the frame was ignored).
 *
 * NOTE: dispatched-subagent TodoWrite never reaches here — a subagent runs
 * in its OWN conversation/agent, and the parent stream only carries the
 * `Agent` dispatch tool call (handled by subagent-registry), not the
 * subagent's inner TodoWrite. So a frame seen here is, by construction, the
 * main/foreground agent's own plan.
 */
export function ingestSelfTodoFrame(
  frame: unknown,
  conversationId: string | null,
  agentId: string | null,
): SelfTodoSnapshot | null {
  const calls = planCallsFromFrame(frame);
  if (calls.length === 0) return null;
  const f = frame as Record<string, unknown>;
  // Prefer the explicit conversationId the host resolved for this turn;
  // fall back to a conversation_id the frame carries (it usually doesn't —
  // reshapeFrame omits it; the ws-handler stamps it later).
  const conv =
    (typeof conversationId === "string" && conversationId.length > 0 && conversationId) ||
    (typeof f["conversation_id"] === "string" ? (f["conversation_id"] as string) : null);
  if (!conv) return null;
  const resolvedAgentId =
    agentId ?? (typeof f["agent_id"] === "string" ? (f["agent_id"] as string) : null);

  // Fold the frame's plan calls. TodoWrite carries the whole list (latest
  // wins). TaskCreate/TaskUpdate mutate the per-conversation accumulator.
  let todos: TodoItem[] | null = null;
  let sessionTouched = false;
  for (const call of calls) {
    if (call.name === SELF_TODO_TOOL) {
      todos = todosFromCall(call);
    } else if (call.name === TASK_CREATE_TOOL) {
      applyTaskCreate(getOrInitSessionTasks(conv), call.arguments);
      sessionTouched = true;
    } else if (call.name === TASK_UPDATE_TOOL) {
      applyTaskUpdate(getOrInitSessionTasks(conv), call.arguments);
      sessionTouched = true;
    }
  }
  // A TodoWrite list (if any) wins; otherwise project the folded session
  // task list. If only a TaskUpdate landed for an as-yet-unseen conv (no
  // prior TaskCreate this session), the projection is empty — but we still
  // record/emit so a later disk read can hydrate the chip.
  if (todos === null) {
    if (!sessionTouched) return null;
    todos = projectSessionTasks(getOrInitSessionTasks(conv));
  }

  const snapshot: SelfTodoSnapshot = {
    conversationId: conv,
    agentId: resolvedAgentId,
    todos,
  };
  _byConversation.set(conv, snapshot);
  emit(snapshot);
  return snapshot;
}

/** Get (or lazily create) the live session-task accumulator for a conv. */
function getOrInitSessionTasks(conversationId: string): SessionTaskAccumulator {
  let acc = _sessionTasksByConversation.get(conversationId);
  if (!acc) {
    acc = newSessionTaskAccumulator();
    _sessionTasksByConversation.set(conversationId, acc);
  }
  return acc;
}

/**
 * The current in-memory snapshot for a conversation (from the live stream),
 * or null if none was observed this session.
 */
export function getSelfTodoSnapshot(conversationId: string): SelfTodoSnapshot | null {
  return _byConversation.get(conversationId) ?? null;
}

/**
 * Read the main agent's latest plan snapshot for a conversation from disk
 * (the lc-local-backend transcript), used on (re)subscribe and by the
 * sheet's `todos(conversationId)` fetch path.
 *
 * Resolution order (letta-mobile-rp1vp):
 *  1. The newest TodoWrite call (legacy/subagent path) via the generic
 *     `readConversationTodos` extractor — newest-wins, full list.
 *  2. If no TodoWrite was ever called, reconstruct the MAIN agent's session
 *     task list by folding every TaskCreate/TaskUpdate event in the
 *     transcript (this is what the foreground agent actually uses).
 *
 * Returns an empty, not-found snapshot if the store is unreadable or the
 * conversation used neither mechanism.
 */
export function readSelfTodos(agentId: string, conversationId: string): TodoSnapshot {
  // Prefer the session task list for normal conversations. The MAIN agent's
  // live plan is TaskCreate/TaskUpdate, while TodoWrite is primarily the
  // subagent/default-conversation mechanism; letting TodoWrite win here can
  // surface a stale default/subagent plan for an unrelated main conversation.
  try {
    const messages = listMessagesSync(conversationId, agentId);
    const session = reconstructSessionTasks(messages);
    if (session.found) return { todos: session.todos, found: true };
  } catch {
    /* unreadable store — fall through to not-found */
  }
  const viaTodoWrite = readConversationTodos(agentId, conversationId);
  if (viaTodoWrite.found) return viaTodoWrite;
  return viaTodoWrite;
}

/**
 * Build the synthetic `tool_call_message` frame mobile's
 * `SelfTodoRepository` consumes for a given conversation's CURRENT snapshot.
 * `todos` is serialized into `arguments` as the canonical
 * `{"todos":[...]}` JSON string, exactly as a live TodoWrite tool call
 * carries it.
 *
 * The returned frame sets `conversation_id` so the channel-push path (which
 * keys on it) and mobile's `conversationId` filter both resolve. The
 * envelope fields `v`/`ts` are stamped by the channel layer's `makeFrame`.
 * `tool_call_id` is a stable per-conversation id so repeated pushes
 * collapse on mobile's `distinctBy { id }`.
 */
export function buildSelfTodoFrame(
  conversationId: string,
  agentId: string | null,
  todos: TodoItem[],
): Record<string, unknown> {
  const toolCallId = `selftodo-${conversationId}`;
  const call: ToolCall = {
    tool_call_id: toolCallId,
    name: SELF_TODO_TOOL,
    arguments: JSON.stringify({ todos }),
    type: "tool_call",
  };
  // Mobile's ServerFrame.ToolCallMessage requires agent_id / conversation_id
  // / turn_id / run_id as NON-NULL strings (no kotlinx default). Omitting any
  // throws MissingFieldException → the frame is silently dropped → the chip
  // stays empty. Populate all four with stable synthetic values; this is a
  // re-hydration snapshot, not part of a live turn, so turn_id/run_id are
  // self-todo sentinels (mobile only reads conversation_id + tool_call here).
  const frame: Partial<ToolCallMessage> & Record<string, unknown> = {
    id: `toolcall-${toolCallId}`,
    message_type: "tool_call_message",
    type: "tool_call_message",
    conversation_id: conversationId,
    agent_id: agentId ?? "",
    turn_id: `selftodo-turn-${conversationId}`,
    run_id: `selftodo-run-${conversationId}`,
    date: nowIso(),
    name: null,
    otid: null,
    sender_id: null,
    step_id: null,
    is_err: null,
    seq_id: null,
    tool_call: call,
    tool_calls: [call],
  };
  return frame;
}

/** Test-only: drop every snapshot, session-task accumulator + listener. */
export function __resetSelfTodo(): void {
  _byConversation.clear();
  _sessionTasksByConversation.clear();
  _listeners.clear();
}
