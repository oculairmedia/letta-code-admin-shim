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
  // A live reshaped frame carries the SAME tool call in BOTH `tool_call`
  // (singular) AND `tool_calls` (array) — reshapeFrame sets
  // `tool_calls: tcs ?? (tc ? [tc] : null)`, so the singular is duplicated
  // into the array. Mobile's `allToolCalls()` UNIONS the two (it does not
  // concat blindly); we must do the same or every TaskCreate/TaskUpdate
  // gets folded twice and the projected list doubles (the live-ingest
  // corruption behind letta-mobile-jb4gu). Dedupe by tool_call_id (falling
  // back to a structural key for synthetic calls that lack an id).
  const single = (f["tool_call"] ?? f["toolCall"] ?? null) as ToolCall | null;
  const manyRaw = (f["tool_calls"] ?? f["toolCalls"] ?? null) as ToolCall[] | null;
  const ordered: ToolCall[] = [];
  if (Array.isArray(manyRaw)) ordered.push(...manyRaw);
  // Only append the singular if the array didn't already include it.
  if (single) ordered.push(single);
  const seen = new Set<string>();
  const calls: ToolCall[] = [];
  for (const raw of ordered) {
    if (!raw || typeof raw !== "object") continue;
    const call = normalizeToolCall(raw);
    if (!SELF_TODO_FRAME_TOOLS.has(call.name)) continue;
    const key = dedupeKey(call);
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push(call);
  }
  return calls;
}

/**
 * Stable identity for a plan tool call so the singular `tool_call` and its
 * twin inside `tool_calls[]` collapse to one fold. Prefer the real
 * `tool_call_id`; for synthetic/id-less calls fall back to name+arguments
 * (two distinct same-name calls in one frame with different args stay
 * distinct, which is correct).
 */
function dedupeKey(call: ToolCall): string {
  const id = call.tool_call_id;
  if (typeof id === "string" && id.length > 0) return `id:${id}`;
  const args =
    typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? null);
  return `na:${call.name}:${args}`;
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
  if (process.env["SELF_TODO_DEBUG"]) {
    const f = (frame ?? {}) as Record<string, unknown>;
    const tc = (f["tool_call"] ?? f["toolCall"]) as Record<string, unknown> | undefined;
    // eslint-disable-next-line no-console
    console.error(
      "[self-todo] ingest frame:",
      JSON.stringify({
        message_type: f["message_type"],
        type: f["type"],
        has_tool_call: f["tool_call"] != null,
        has_toolCall: f["toolCall"] != null,
        has_tool_calls: Array.isArray(f["tool_calls"]),
        has_toolCalls: Array.isArray(f["toolCalls"]),
        has_parts: Array.isArray(f["parts"]),
        tc_name: tc?.["name"],
        tc_args_type: tc ? typeof tc["arguments"] : undefined,
        conv: conversationId,
      }),
    );
  }
  const calls = planCallsFromFrame(frame);
  if (process.env["SELF_TODO_DEBUG"]) {
    // eslint-disable-next-line no-console
    console.error("[self-todo] planCallsFromFrame ->", calls.length, "calls:", calls.map((c) => c.name));
  }
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
 * Stable, order-sensitive signature of a todo list used to dedupe snapshots.
 * Two refreshes that yield the same list (same content/status/order) collapse
 * to one emit; any add/remove/status/reorder produces a different signature.
 */
function todosSignature(todos: TodoItem[]): string {
  return JSON.stringify(
    todos.map((t) => [t.content ?? "", t.status ?? "", t.activeForm ?? ""]),
  );
}

/**
 * letta-mobile-jb4gu — turn-settlement self-todo emit (the missing TRIGGER
 * for CLI/SDK-backend turns).
 *
 * THE PROBLEM THIS CLOSES: there are TWO ingress paths.
 *  - MOBILE send_message turns flow through bridgeSendMessage -> emit() ->
 *    ingestSelfTodoFrame, so the live snapshot is populated in-process and a
 *    change event fires (the server broadcast then reaches the phone).
 *  - CLI/SDK-backend turns (the main Meridian conversation, any local-backend
 *    turn) have the letta CLI write the conversation messages.jsonl DIRECTLY
 *    (letta-sdk-adapter.ts). The shim NEVER sees a frame for these turns, so
 *    ingestSelfTodoFrame never runs, getSelfTodoSnapshot stays NULL, and no
 *    self-todo change event ever fires — the chip stays empty even though
 *    readSelfTodos(disk) returns the correct tasks.
 *
 * THE FIX: after a turn SETTLES (the universal post-turn chokepoint
 * finalizeTurnLifecycle, called by BOTH adapters), re-read self-todos from
 * messages.jsonl, compare to the last emitted snapshot for that conversation,
 * and — only if it CHANGED — update the in-memory cache and fire the same
 * emit() the server broadcast subscribes to. That populates getSelfTodoSnapshot
 * AND delivers the change to the push-client phone.
 *
 * The "only if changed" guard is what makes this safe to call on EVERY turn
 * end on BOTH paths: the mobile path already ingested the live frame and set
 * the identical snapshot, so the post-turn disk read finds no change and emits
 * nothing (no double-emit / no spam). It only fires when disk diverges from the
 * cache — i.e. exactly the CLI/SDK case where live ingest never ran.
 *
 * Returns the freshly-emitted snapshot when a change was detected+emitted, or
 * null when the disk read found no plan or matched the cached snapshot.
 */
export function refreshSelfTodoFromDisk(
  agentId: string,
  conversationId: string,
): SelfTodoSnapshot | null {
  if (typeof conversationId !== "string" || conversationId.length === 0) return null;
  if (typeof agentId !== "string" || agentId.length === 0) return null;

  let snapshot: TodoSnapshot;
  try {
    snapshot = readSelfTodos(agentId, conversationId);
  } catch (err) {
    if (process.env["SELF_TODO_DEBUG"]) {
      // eslint-disable-next-line no-console
      console.error(
        `[self-todo] refreshFromDisk read failed conv=${conversationId} agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }

  // No plan on disk for this conversation yet — nothing to emit. Leave any
  // existing cache untouched (a transient unreadable read shouldn't clear it).
  if (!snapshot.found || snapshot.todos.length === 0) {
    if (process.env["SELF_TODO_DEBUG"]) {
      // eslint-disable-next-line no-console
      console.error(
        `[self-todo] refreshFromDisk conv=${conversationId}: no plan on disk (found=${snapshot.found}, n=${snapshot.todos.length}), skip`,
      );
    }
    return null;
  }

  const prev = _byConversation.get(conversationId);
  const nextSig = todosSignature(snapshot.todos);
  if (prev && todosSignature(prev.todos) === nextSig) {
    // Identical to the last emitted snapshot (e.g. the mobile path already
    // ingested this exact list live) — dedupe, do not re-emit.
    if (process.env["SELF_TODO_DEBUG"]) {
      // eslint-disable-next-line no-console
      console.error(
        `[self-todo] refreshFromDisk conv=${conversationId}: unchanged (${snapshot.todos.length} todos), skip emit`,
      );
    }
    return null;
  }

  const next: SelfTodoSnapshot = {
    conversationId,
    agentId,
    todos: snapshot.todos,
  };
  _byConversation.set(conversationId, next);
  if (process.env["SELF_TODO_DEBUG"]) {
    // eslint-disable-next-line no-console
    console.error(
      `[self-todo] refreshFromDisk conv=${conversationId} agent=${agentId}: CHANGED -> emit ${snapshot.todos.length} todos:`,
      JSON.stringify(snapshot.todos.map((t) => ({ content: t.content, status: t.status }))),
    );
  }
  emit(next);
  return next;
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
