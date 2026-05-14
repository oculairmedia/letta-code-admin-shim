/**
 * Run tracking for the admin shim.
 *
 * Vanilla Letta exposes `Run` records — one per turn/execution — at the
 * `/v1/runs/*` endpoints. Mobile (and other vanilla clients) lean on them
 * to poll turn status, list active runs, retrieve per-run messages/usage/
 * metrics/steps, and cancel in-flight turns.
 *
 * letta-code's LocalBackend has no run abstraction (its stream frames
 * carry a `local-run-N` counter for grouping, but no persisted record).
 * This module overlays the missing layer:
 *
 *   - Generates a `run-<uuid>` id per turn.
 *   - Persists `state/runs/<run-id>.json` with status, timing, message
 *     ids created during the turn, tools used, etc.
 *   - Keeps an in-memory index of active runs for cancel + listRuns(active).
 *
 * Run lifecycle:
 *   createRun()          status: "running",   created_at set
 *   markRunFirstToken()  ttft_ns set         (idempotent — only first wins)
 *   recordRunMessage()   message_ids[]      appended as letta-code persists
 *   recordRunTool()      tools_used[]       appended on tool-call frames
 *   recordRunStep()      a step.json sidecar appended for each model step
 *   finalizeRun()        status:
 *                          "completed"      normal end-of-turn
 *                          "failed"         worker died / errored
 *                          "cancelled"      cancel was requested
 *                        completed_at, total_duration_ns, stop_reason set
 *
 * Storage: `${storageDir}/runs/<run-id>/run.json` + steps.jsonl. Top-level
 * `runs.json` is intentionally NOT used — one run per directory keeps
 * concurrent finalize safe (no read-modify-write race across runs) and
 * mirrors how conversation state is sharded.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function storageDir() {
  return (
    process.env.LETTA_LOCAL_BACKEND_DIR ||
    join(process.env.LETTA_HOME || join(homedir(), ".letta"), "lc-local-backend")
  );
}

function runsRoot() {
  return join(storageDir(), "runs");
}

function runDir(runId) {
  return join(runsRoot(), runId);
}

function runFile(runId) {
  return join(runDir(runId), "run.json");
}

function stepsFile(runId) {
  return join(runDir(runId), "steps.jsonl");
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

// In-memory index of active runs for fast list(active=true) + cancel lookup.
// Disk is authoritative; this is a cache that stays consistent because every
// run lifecycle event writes to both.
const _activeRuns = new Map(); // run_id → run record (in-memory copy)
const _cancelHandlers = new Map(); // run_id → () => void

function nowIso() {
  return new Date().toISOString();
}

function nanosSince(hrStart) {
  const hrEnd = process.hrtime(hrStart);
  return hrEnd[0] * 1_000_000_000 + hrEnd[1];
}

/**
 * Create a Run record at turn-start. Returns the in-memory handle.
 *
 * `onCancel` (optional) is a callback invoked by `cancelRun(runId)`. The
 * caller (agent-pool) registers it to SIGTERM the worker; we keep it out
 * of the persisted record because functions don't serialize.
 */
export function createRun({ agentId, conversationId, onCancel } = {}) {
  const id = `run-${randomUUID()}`;
  const record = {
    id,
    agent_id: agentId ?? null,
    background: false,
    base_template_id: null,
    callback_error: null,
    callback_sent_at: null,
    callback_status_code: null,
    callback_url: null,
    completed_at: null,
    conversation_id: conversationId ?? null,
    created_at: nowIso(),
    metadata: {},
    request_config: null,
    status: "running",
    stop_reason: null,
    total_duration_ns: null,
    ttft_ns: null,
    // Shim-specific extensions (mobile ignores unknown fields):
    message_ids: [],
    tools_used: [],
    num_steps: 0,
  };
  const hrStart = process.hrtime();
  const handle = {
    id,
    record,
    hrStart,
    firstTokenSet: false,
  };
  _activeRuns.set(id, handle);
  if (typeof onCancel === "function") {
    _cancelHandlers.set(id, onCancel);
  }
  writeJsonAtomic(runFile(id), record);
  return handle;
}

/** Set ttft on the first frame that carries assistant content. Idempotent. */
export function markRunFirstToken(handle) {
  if (!handle || handle.firstTokenSet) return;
  handle.firstTokenSet = true;
  handle.record.ttft_ns = nanosSince(handle.hrStart);
  writeJsonAtomic(runFile(handle.id), handle.record);
}

export function recordRunMessage(handle, localMessageId) {
  if (!handle || !localMessageId) return;
  if (handle.record.message_ids.includes(localMessageId)) return;
  handle.record.message_ids.push(localMessageId);
}

export function recordRunTool(handle, toolName) {
  if (!handle || !toolName) return;
  if (handle.record.tools_used.includes(toolName)) return;
  handle.record.tools_used.push(toolName);
}

export function recordRunStep(handle, step = {}) {
  if (!handle) return;
  handle.record.num_steps += 1;
  const stepRecord = {
    id: step.id ?? `step-${randomUUID()}`,
    run_id: handle.id,
    agent_id: handle.record.agent_id,
    created_at: nowIso(),
    ...step,
  };
  try {
    mkdirSync(runDir(handle.id), { recursive: true });
    appendFileSync(stepsFile(handle.id), JSON.stringify(stepRecord) + "\n");
  } catch (err) {
    console.error(`[runs] step append failed for ${handle.id}: ${err.message}`);
  }
  return stepRecord;
}

/**
 * Finalize a run. `status` is "completed", "failed", or "cancelled".
 * Removes from the active index and persists the final record.
 */
export function finalizeRun(handle, { status = "completed", stopReason = null, usage = null } = {}) {
  if (!handle) return;
  handle.record.status = status;
  handle.record.stop_reason = stopReason;
  handle.record.completed_at = nowIso();
  handle.record.total_duration_ns = nanosSince(handle.hrStart);
  if (usage && typeof usage === "object") {
    handle.record.usage = {
      completion_tokens: usage.completion_tokens ?? 0,
      prompt_tokens: usage.prompt_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      step_count: handle.record.num_steps,
      cached_input_tokens: usage.cached_input_tokens ?? 0,
      cache_write_tokens: usage.cache_write_tokens ?? 0,
      reasoning_tokens: usage.reasoning_tokens ?? 0,
    };
  }
  writeJsonAtomic(runFile(handle.id), handle.record);
  _activeRuns.delete(handle.id);
  _cancelHandlers.delete(handle.id);
}

export function getRun(runId) {
  const fromMem = _activeRuns.get(runId);
  if (fromMem) return fromMem.record;
  return readJsonOrNull(runFile(runId));
}

export function listRuns({
  agentId,
  agentIds,
  conversationId,
  active,
  background,
  statuses,
  stopReason,
  before,
  after,
  limit = 50,
  order = "desc",
  ascending,
} = {}) {
  const root = runsRoot();
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const r = readJsonOrNull(join(root, name, "run.json"));
    if (!r) continue;
    if (agentId && r.agent_id !== agentId) continue;
    if (Array.isArray(agentIds) && agentIds.length && !agentIds.includes(r.agent_id)) continue;
    if (conversationId && r.conversation_id !== conversationId) continue;
    if (active === true && r.status !== "running") continue;
    if (active === false && r.status === "running") continue;
    if (typeof background === "boolean" && r.background !== background) continue;
    if (Array.isArray(statuses) && statuses.length && !statuses.includes(r.status)) continue;
    if (stopReason && r.stop_reason !== stopReason) continue;
    out.push(r);
  }
  const cmpAsc = (a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "");
  const wantAsc = ascending === true || (ascending == null && order === "asc");
  out.sort(wantAsc ? cmpAsc : (a, b) => -cmpAsc(a, b));
  // before / after pagination is by id in vanilla. Match: drop everything
  // up to (and including) `after`, then up to `before` (exclusive).
  let scoped = out;
  if (after) {
    const idx = scoped.findIndex((r) => r.id === after);
    if (idx >= 0) scoped = scoped.slice(idx + 1);
  }
  if (before) {
    const idx = scoped.findIndex((r) => r.id === before);
    if (idx >= 0) scoped = scoped.slice(0, idx);
  }
  return scoped.slice(0, Math.max(1, limit));
}

export function listRunSteps(runId, { before, after, limit, order } = {}) {
  const path = stepsFile(runId);
  if (!existsSync(path)) return [];
  const items = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
  let scoped = items;
  const cmp = (a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "");
  scoped.sort(order === "asc" ? cmp : (a, b) => -cmp(a, b));
  if (after) {
    const idx = scoped.findIndex((s) => s.id === after);
    if (idx >= 0) scoped = scoped.slice(idx + 1);
  }
  if (before) {
    const idx = scoped.findIndex((s) => s.id === before);
    if (idx >= 0) scoped = scoped.slice(0, idx);
  }
  if (limit && limit > 0) scoped = scoped.slice(0, limit);
  return scoped;
}

/**
 * Try to cancel a run. Returns true if cancel callback was found+invoked.
 * Cancelling a not-found / already-finished run is a no-op (returns false).
 *
 * Per vanilla's contract, cancelRun does NOT wait for the worker to actually
 * exit — it signals + flips the status to "cancelled" and returns. The worker
 * winds down via SIGTERM in the background; finalizeRun stays a no-op
 * because the in-memory handle is gone by then.
 */
export function cancelRun(runId, { reason = "user_cancelled" } = {}) {
  const handle = _activeRuns.get(runId);
  if (!handle) return false;
  const onCancel = _cancelHandlers.get(runId);
  // Persist the cancellation state BEFORE invoking the cancel callback so
  // a concurrent finalize doesn't race us back to "completed".
  handle.record.status = "cancelled";
  handle.record.stop_reason = reason;
  handle.record.completed_at = nowIso();
  handle.record.total_duration_ns = nanosSince(handle.hrStart);
  writeJsonAtomic(runFile(handle.id), handle.record);
  _activeRuns.delete(handle.id);
  _cancelHandlers.delete(handle.id);
  if (typeof onCancel === "function") {
    try { onCancel(reason); } catch (err) {
      console.error(`[runs] cancel callback for ${runId} threw: ${err.message}`);
    }
  }
  return true;
}

export function deleteRun(runId) {
  const path = runFile(runId);
  if (!existsSync(path)) return false;
  try {
    rmSync(runDir(runId), { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error(`[runs] delete failed for ${runId}: ${err.message}`);
    return false;
  }
}

export function listActiveRunIds() {
  return [..._activeRuns.keys()];
}

// ── Usage aggregation ────────────────────────────────────────────────
//
// Sums token counts across runs matching filters. Per-step granularity
// lives in steps.jsonl; this function walks runs and either sums the
// run-level `usage` (fast path) or steps (when grouping by model needs
// the per-step model attribution).
//
// Filters:
//   agent_id        — single
//   agent_ids       — array (any-match)
//   conversation_id — single
//   start / end     — ISO strings, applied to run.created_at
//   statuses        — array; defaults to all
//   group_by        — null | "agent" | "conversation" | "model" | "day"
//
// Returns: { total: <UsageTotals>, breakdown?: [{ key, ...UsageTotals }] }
//
// UsageTotals fields: prompt_tokens, completion_tokens, total_tokens,
//   cached_input_tokens, cache_write_tokens, reasoning_tokens, run_count.

function emptyTotals() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    run_count: 0,
  };
}

function addUsageInto(target, src) {
  if (!src) return;
  target.prompt_tokens += src.prompt_tokens ?? 0;
  target.completion_tokens += src.completion_tokens ?? 0;
  target.total_tokens += src.total_tokens ?? 0;
  target.cached_input_tokens += src.cached_input_tokens ?? 0;
  target.cache_write_tokens += src.cache_write_tokens ?? 0;
  target.reasoning_tokens += src.reasoning_tokens ?? 0;
}

function dayKey(iso) {
  if (typeof iso !== "string") return "unknown";
  return iso.slice(0, 10);
}

export function aggregateUsage({
  agentId,
  agentIds,
  conversationId,
  start,
  end,
  statuses,
  groupBy = null,
} = {}) {
  const root = runsRoot();
  if (!existsSync(root)) return { total: emptyTotals(), breakdown: groupBy ? [] : undefined };

  const total = emptyTotals();
  const groups = new Map(); // groupKey → UsageTotals

  for (const name of readdirSync(root)) {
    const r = readJsonOrNull(join(root, name, "run.json"));
    if (!r) continue;
    if (agentId && r.agent_id !== agentId) continue;
    if (Array.isArray(agentIds) && agentIds.length && !agentIds.includes(r.agent_id)) continue;
    if (conversationId && r.conversation_id !== conversationId) continue;
    if (Array.isArray(statuses) && statuses.length && !statuses.includes(r.status)) continue;
    if (start && (r.created_at ?? "") < start) continue;
    if (end && (r.created_at ?? "") > end) continue;

    if (groupBy === "model") {
      // Need per-step granularity for model breakdown — each step has its
      // own model attribution that the run-level rollup doesn't preserve.
      const steps = listRunSteps(r.id, { limit: 1000 });
      const runUsageSeen = steps.length > 0;
      for (const s of steps) {
        const key = s.model ?? "unknown";
        let g = groups.get(key);
        if (!g) { g = emptyTotals(); groups.set(key, g); }
        addUsageInto(g, s.usage);
        addUsageInto(total, s.usage);
      }
      if (runUsageSeen) total.run_count += 1;
      continue;
    }

    addUsageInto(total, r.usage);
    total.run_count += 1;

    if (groupBy === "agent") {
      const key = r.agent_id ?? "unknown";
      let g = groups.get(key);
      if (!g) { g = emptyTotals(); groups.set(key, g); }
      addUsageInto(g, r.usage);
      g.run_count += 1;
    } else if (groupBy === "conversation") {
      const key = r.conversation_id ?? "unknown";
      let g = groups.get(key);
      if (!g) { g = emptyTotals(); groups.set(key, g); }
      addUsageInto(g, r.usage);
      g.run_count += 1;
    } else if (groupBy === "day") {
      const key = dayKey(r.created_at);
      let g = groups.get(key);
      if (!g) { g = emptyTotals(); groups.set(key, g); }
      addUsageInto(g, r.usage);
      g.run_count += 1;
    }
  }

  if (!groupBy) return { total };
  const breakdown = [...groups.entries()]
    .map(([key, totals]) => ({ key, ...totals }))
    .sort((a, b) => b.total_tokens - a.total_tokens);
  return { total, breakdown };
}
