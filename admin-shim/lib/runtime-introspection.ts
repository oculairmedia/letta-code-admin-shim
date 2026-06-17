/**
 * Passive runtime introspection (lcp-d0za).
 *
 * Provides ambient runtime state to the agent via system-reminders
 * appended to user messages — no tool call needed. The agent always
 * knows its serving model, context utilization, and session role
 * without probing.
 *
 * Scope:
 *   - Serving model handle (read from agent record on disk)
 *   - Context window utilization summary (same estimate as the REST
 *     /v1/agents/{id}/context endpoint)
 *   - Session role discriminator (main / fork / subagent) —
 *     load-bearing for lcp-wd3i fork-verdict exemptions
 *   - Model-change delta reminders: when the serving model changes
 *     mid-conversation, a delta system-reminder surfaces the change
 *     to the agent on the next turn
 *
 * Storage: all state is in-process (Map). No disk persistence — roles
 * are assigned per connection/session and are ephemeral.
 */

import { getAgentRecord, readSystemPrompt } from "./store.js";
import { listActiveSubagents, sweepOrphanedSubagents } from "./subagent-registry.js";

export type SessionRole = "main" | "fork" | "subagent";

/** Per-conversation runtime state, tracked in memory across turns. */
interface ConversationRuntimeState {
  lastKnownModel: string | null;
  sessionRole: SessionRole;
}

const conversationState = new Map<string, ConversationRuntimeState>();

function convKey(agentId: string, conversationId: string): string {
  return `${agentId}::${conversationId}`;
}

// ──────────────────────────────────────────────────────────────────────
// Session role
// ──────────────────────────────────────────────────────────────────────

/**
 * Tag a conversation with a session role. Called when a session is
 * created or when a fork/subagent is spawned. Default if never set
 * is "main".
 */
export function setSessionRole(
  agentId: string,
  conversationId: string,
  role: SessionRole,
): void {
  const key = convKey(agentId, conversationId);
  const existing = conversationState.get(key);
  if (existing) {
    existing.sessionRole = role;
  } else {
    conversationState.set(key, { lastKnownModel: null, sessionRole: role });
  }
}

/**
 * Get the session role for a conversation. Returns "main" when no
 * explicit role has been assigned (backward-compatible default).
 */
export function getSessionRole(
  agentId: string,
  conversationId: string,
): SessionRole {
  return conversationState.get(convKey(agentId, conversationId))?.sessionRole ?? "main";
}

// ──────────────────────────────────────────────────────────────────────
// Serving model handle
// ──────────────────────────────────────────────────────────────────────

/**
 * Read the serving model handle from the agent's on-disk record.
 * Returns null when the record is absent or the model field is unset.
 */
export function getServingModelHandle(agentId: string): string | null {
  const record = getAgentRecord(agentId);
  if (!record) return null;
  return typeof record.model === "string" && record.model.length > 0
    ? record.model
    : null;
}

// ──────────────────────────────────────────────────────────────────────
// Context utilization
// ──────────────────────────────────────────────────────────────────────

/**
 * Lightweight context-window utilization summary. Uses the same
 * character-counting heuristic as the REST /v1/agents/{id}/context
 * endpoint so the agent sees a consistent estimate. This is a
 * synchronous floor — the actual message count requires an async
 * listMessages() call, so we use a rough floor constant.
 */
export function getContextUtilizationSummary(
  agentId: string,
  conversationId: string,
): string | null {
  const record = getAgentRecord(agentId);
  if (!record) return null;

  // Replicate the /v1/agents/{id}/context estimate.
  const sp = readSystemPrompt(conversationId, agentId);
  const spContent =
    sp && typeof sp === "object" && "content" in sp &&
    typeof (sp as { content: unknown }).content === "string"
      ? (sp as { content: string }).content
      : undefined;
  const systemPrompt =
    spContent ??
    (typeof record.system === "string" ? record.system : "") ??
    "";

  const systemTokens = Math.ceil(systemPrompt.length / 4);
  // Rough floor for message tokens — the REST endpoint multiplies
  // message count × 50. Without awaiting listMessages(), use a
  // conservative floor so the agent sees at least a lower bound.
  const messageFloor = 200;
  const current = systemTokens + messageFloor;
  const max = 200_000;
  const pct = ((current / max) * 100).toFixed(1);

  return `${pct}% (≈${current} / ${max} tokens)`;
}

// ──────────────────────────────────────────────────────────────────────
// Model-change delta tracking
// ──────────────────────────────────────────────────────────────────────

/**
 * Check whether the serving model changed since the last turn on this
 * conversation. When it has, return a delta system-reminder surfacing
 * the change; otherwise return null. Always updates lastKnownModel so
 * subsequent calls with the same model are no-ops.
 */
export function detectModelChange(
  agentId: string,
  conversationId: string,
  newModel: string | null,
): string | null {
  if (!newModel) return null;
  const key = convKey(agentId, conversationId);
  let state = conversationState.get(key);
  if (!state) {
    state = { lastKnownModel: newModel, sessionRole: "main" };
    conversationState.set(key, state);
    return null;
  }
  if (state.lastKnownModel && state.lastKnownModel !== newModel) {
    const delta = `<system-reminder>\nModel changed: ${state.lastKnownModel} → ${newModel}\n</system-reminder>`;
    state.lastKnownModel = newModel;
    return delta;
  }
  state.lastKnownModel = newModel;
  return null;
}

/**
 * Force-update the tracked model without triggering a delta reminder.
 * Used at connection time so the initial system-reminder carries the
 * model without also emitting a spurious "changed" frame.
 */
export function seedModelHandle(
  agentId: string,
  conversationId: string,
  model: string | null,
): void {
  if (!model) return;
  const key = convKey(agentId, conversationId);
  let state = conversationState.get(key);
  if (!state) {
    state = { lastKnownModel: model, sessionRole: "main" };
    conversationState.set(key, state);
  } else {
    state.lastKnownModel = model;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Subagent summary
// ──────────────────────────────────────────────────────────────────────

const SUBAGENT_STUCK_SOFT_MS = (() => {
  const n = Number(process.env["SHIM_SUBAGENT_STUCK_SOFT_MS"] ?? 300_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300_000;
})();

let listActiveSubagentsForRuntime = listActiveSubagents;

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  // Trim trailing whitespace before the ellipsis so we never emit "word …".
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatElapsed(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  return `${totalHours}h`;
}

function shortSubagentId(toolCallId: string): string {
  return toolCallId.length <= 8 ? toolCallId : toolCallId.slice(-8);
}

function truncateLine(line: string, maxLength = 220): string {
  if (line.length <= maxLength) return line;
  return `${line.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * Build a compact one-line summary of currently-running subagents.
 * Returns null when no subagents are active so the connection reminder
 * stays quiet unless there is live work to surface.
 */
export function buildSubagentSummaryLine(nowMs = Date.now()): string | null {
  sweepOrphanedSubagents(nowMs);
  const active = listActiveSubagentsForRuntime();
  if (active.length === 0) return null;

  const running: string[] = [];
  const stuck: string[] = [];

  for (const entry of active) {
    const startedMs = Date.parse(entry.startedAt);
    const elapsedMs = Number.isNaN(startedMs) ? 0 : Math.max(0, nowMs - startedMs);
    const label = entry.subagentType ?? shortSubagentId(entry.toolCallId);
    const description = entry.description ? truncateText(entry.description, 30) : "no description";
    const summary = `${label} (${description}, ${formatElapsed(elapsedMs)})`;
    if (elapsedMs > SUBAGENT_STUCK_SOFT_MS) stuck.push(summary);
    else running.push(summary);
  }

  const parts: string[] = [];
  if (running.length > 0) {
    parts.push(`${running.length} running — ${running.join(", ")}`);
  }
  if (stuck.length > 0) {
    parts.push(`⚠ ${stuck.length} stuck-suspected — ${stuck.join(", ")}`);
  }

  return truncateLine(`Subagents: ${parts.join("; ")}`);
}

// ──────────────────────────────────────────────────────────────────────
// Connection reminder builder
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the connection system-reminder injected at turn start.
 * Includes serving model, context utilization, and session role.
 * Callers prepend this to the user message before sending to the
 * agent pool.
 *
 * **Fail-open**: this function must NEVER throw or block. The
 * reminder is an enhancement — if any lookup fails (missing agent
 * record, I/O error, unexpected input), the function silently
 * returns "" and the message path proceeds unblocked.
 */
export function buildConnectionReminder(
  agentId: string,
  conversationId: string,
): string {
  try {
    const role = getSessionRole(agentId, conversationId);
    const model = getServingModelHandle(agentId);
    const ctx = getContextUtilizationSummary(agentId, conversationId);

    const lines: string[] = [];
    if (model) lines.push(`Serving model: ${model}`);
    if (ctx) lines.push(`Context utilization: ${ctx}`);
    lines.push(`Session role: ${role}`);
    try {
      const subagents = buildSubagentSummaryLine();
      if (subagents) lines.push(subagents);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[runtime-introspection] subagent summary failed (fail-open): ${msg}`);
    }

    if (lines.length === 0) return "";

    return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runtime-introspection] buildConnectionReminder failed (fail-open): ${msg}`);
    return "";
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────────

/** Drop all in-process runtime state (test-only). */
export function __clearRuntimeState(): void {
  conversationState.clear();
  listActiveSubagentsForRuntime = listActiveSubagents;
}

/** Override active-subagent enumeration (test-only). */
export function __setListActiveSubagentsForTest(fn: typeof listActiveSubagents): void {
  listActiveSubagentsForRuntime = fn;
}
