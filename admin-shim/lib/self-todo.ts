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
import type { LocalMessage } from "./types/letta-stream.js";
import type { ToolCall, ToolCallMessage } from "./types/wire.js";

/** Tool name the main agent's self-plan rides on. */
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
 * Extract the (first) TodoWrite tool call from a reshaped
 * `tool_call_message` frame. Mirrors mobile's `allToolCalls()` union over
 * `tool_call` (singular) + `tool_calls` (array). Returns null when the
 * frame is not a TodoWrite tool call.
 */
function todoWriteCallFromFrame(frame: unknown): ToolCall | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  if (f["message_type"] !== "tool_call_message") return null;
  const single = (f["tool_call"] ?? null) as ToolCall | null;
  const many = (f["tool_calls"] ?? null) as ToolCall[] | null;
  const calls: ToolCall[] = [];
  if (single) calls.push(single);
  if (Array.isArray(many)) calls.push(...many);
  for (const call of calls) {
    if (call && typeof call === "object" && call.name === SELF_TODO_TOOL) return call;
  }
  return null;
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
 * everything that is not the main agent's TodoWrite tool call. On a
 * TodoWrite frame it records the latest snapshot for the frame's
 * `conversation_id` and broadcasts a change event so connected sockets can
 * push the fresh snapshot.
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
  const call = todoWriteCallFromFrame(frame);
  if (!call) return null;
  const f = frame as Record<string, unknown>;
  // Prefer the explicit conversationId the host resolved for this turn;
  // fall back to a conversation_id the frame carries (it usually doesn't —
  // reshapeFrame omits it; the ws-handler stamps it later).
  const conv =
    (typeof conversationId === "string" && conversationId.length > 0 && conversationId) ||
    (typeof f["conversation_id"] === "string" ? (f["conversation_id"] as string) : null);
  if (!conv) return null;
  const snapshot: SelfTodoSnapshot = {
    conversationId: conv,
    agentId: agentId ?? (typeof f["agent_id"] === "string" ? (f["agent_id"] as string) : null),
    todos: todosFromCall(call),
  };
  _byConversation.set(conv, snapshot);
  emit(snapshot);
  return snapshot;
}

/**
 * The current in-memory snapshot for a conversation (from the live stream),
 * or null if none was observed this session.
 */
export function getSelfTodoSnapshot(conversationId: string): SelfTodoSnapshot | null {
  return _byConversation.get(conversationId) ?? null;
}

/**
 * Read the main agent's latest TodoWrite snapshot for a conversation from
 * disk (the lc-local-backend transcript), used on (re)subscribe and by the
 * sheet's `todos(conversationId)` fetch path. Reuses the generic
 * `readConversationTodos` extractor. Returns an empty, not-found snapshot if
 * the store is unreadable or no TodoWrite was ever called.
 */
export function readSelfTodos(agentId: string, conversationId: string): TodoSnapshot {
  return readConversationTodos(agentId, conversationId);
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

/** Test-only: drop every snapshot + listener. */
export function __resetSelfTodo(): void {
  _byConversation.clear();
  _listeners.clear();
}
