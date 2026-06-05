/**
 * Subagent TodoWrite snapshot reader (letta-mobile-73o2h.1).
 *
 * A subagent's OWN TodoWrite lives in the SUBAGENT's separate conversation
 * (`default:<subagentAgentId>`), NOT in the parent run frame stream. This
 * module reads that conversation's message store and extracts the LATEST
 * TodoWrite tool-call's `todos` array, so the mobile app can render a
 * subagent's progress meter.
 *
 * The store is the lc-local-backend conversation projection already used by
 * `store.ts#listMessagesSync`. A TodoWrite call is persisted as an assistant
 * message with a `{type:"toolCall", name:"TodoWrite", arguments:{todos:[…]}}`
 * content part (arguments may be a JSON string or an object). We scan
 * newest-first and return the first TodoWrite we find.
 *
 * Scope note (.1 first cut): this exposes a point-in-time SNAPSHOT, fetched
 * on demand and via a lightweight poller. A true live subscription that
 * tails the subagent conversation append stream is deferred — see the host
 * subscription wiring + docs for the TODO.
 */

import { listMessagesSync } from "./store.js";
import type { LocalMessage } from "./types/letta-stream.js";

/** One todo item, mirroring the TodoWrite tool's schema. */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export interface TodoSnapshot {
  /** The todos from the subagent's most-recent TodoWrite call (may be empty). */
  todos: TodoItem[];
  /** True iff at least one TodoWrite call was found in the conversation. */
  found: boolean;
}

function coerceTodos(args: unknown): TodoItem[] {
  let obj: Record<string, unknown> | null = null;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      return [];
    }
  } else if (args && typeof args === "object") {
    obj = args as Record<string, unknown>;
  }
  if (!obj || !Array.isArray(obj["todos"])) return [];
  const out: TodoItem[] = [];
  for (const raw of obj["todos"] as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const content = typeof r["content"] === "string" ? (r["content"] as string) : "";
    const status = r["status"];
    const activeForm = typeof r["activeForm"] === "string" ? (r["activeForm"] as string) : "";
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    out.push({ content, status, activeForm });
  }
  return out;
}

/**
 * Extract the latest TodoWrite todos from a subagent's message list. The
 * messages are oldest-first (store order); we walk backwards and return
 * the first TodoWrite call's todos. A TodoWrite call rides an assistant
 * message's `parts` as a `{type:"toolCall", name:"TodoWrite", arguments}`.
 */
export function extractLatestTodos(messages: LocalMessage[]): TodoSnapshot {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parts = messages[i]?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const isToolCall = p["type"] === "toolCall" || p["type"] === "tool-call";
      if (!isToolCall || p["name"] !== "TodoWrite") continue;
      return { todos: coerceTodos(p["arguments"]), found: true };
    }
  }
  return { todos: [], found: false };
}

/**
 * Read an agent's latest TodoWrite snapshot from a given conversation's
 * message store. This is the generic primitive: it resolves the
 * `(conversationId, agentId)` message store via `listMessagesSync` and
 * extracts the newest TodoWrite call's todos.
 *
 * Both the per-subagent reader (`readSubagentTodos`, which reads the
 * subagent's own "default" conversation) and the MAIN/foreground agent's
 * self-todo reader (letta-mobile-gnyf7, which reads the active
 * conversation) build on this. Returns an empty, not-found snapshot if the
 * store is unreadable or the agent never called TodoWrite in that
 * conversation.
 */
export function readConversationTodos(
  agentId: string,
  conversationId: string,
): TodoSnapshot {
  try {
    const messages = listMessagesSync(conversationId, agentId);
    return extractLatestTodos(messages);
  } catch {
    return { todos: [], found: false };
  }
}

/**
 * Read the subagent's latest TodoWrite snapshot from its conversation
 * store. `subagentAgentId` is the agent-local-<uuid> the registry
 * correlated; `conversationId` defaults to "default" (the subagent's
 * conversation). Returns an empty, not-found snapshot if the store is
 * unreadable or the subagent never called TodoWrite.
 *
 * Thin wrapper over `readConversationTodos` — preserved as the named entry
 * point the subagent registry/host wiring already uses.
 */
export function readSubagentTodos(
  subagentAgentId: string,
  conversationId = "default",
): TodoSnapshot {
  return readConversationTodos(subagentAgentId, conversationId);
}
