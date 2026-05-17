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

import type { Run, RunUsage, Step } from "./types/wire.js";
import type {
  UsageStatisticsEvent,
} from "./types/letta-stream.js";

// ──────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────

/**
 * On-disk Run record. Matches the wire `Run` shape exactly (all required
 * fields are populated by createRun, `usage` is added on finalize). We
 * keep a distinct alias to make the in-module intent explicit; toWireRun()
 * is the identity right now but exists as a documented seam if disk and
 * wire ever drift (e.g. if we add bookkeeping fields not meant to leak).
 */
type RunRecord = Run;

/**
 * In-memory handle returned by createRun and consumed by every other
 * mutator. The `hrStart` tuple is used to compute ttft and total_duration
 * via `process.hrtime`; `firstTokenSet` guards markRunFirstToken's
 * idempotency.
 *
 * Not persisted — only `record` ever lands on disk.
 */
export interface RunHandle {
  id: string;
  record: RunRecord;
  hrStart: [number, number];
  firstTokenSet: boolean;
}

/**
 * Subset of `UsageStatisticsEvent` (or any compatible source) that
 * finalizeRun reads. Every field is optional because the caller can
 * pass either a freshly-shaped object or a raw upstream frame; missing
 * fields default to 0 (matches the .mjs behavior).
 */
export interface UsageInput {
  completion_tokens?: number;
  prompt_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

/** Argument bag for createRun. */
export interface CreateRunOptions {
  agentId?: string | null;
  conversationId?: string | null;
  onCancel?: (reason: string) => void;
}

/** Argument bag for finalizeRun. */
export interface FinalizeRunOptions {
  status?: "completed" | "failed" | "cancelled";
  stopReason?: string | null;
  usage?: UsageInput | UsageStatisticsEvent | null;
}

/**
 * Argument bag for recordRunStep. `id`, `run_id`, `agent_id`, `created_at`
 * are filled in by recordRunStep itself — anything else (model, stop_reason,
 * usage, …) is passed straight through.
 */
export type RecordStepInput = Partial<Step> & Record<string, unknown>;

/** Argument bag for listRuns — mirrors the parsed query-param fields. */
export interface ListRunsParams {
  agentId?: string | undefined;
  agentIds?: string[] | undefined;
  conversationId?: string | undefined;
  active?: boolean | undefined;
  background?: boolean | undefined;
  statuses?: string[] | undefined;
  stopReason?: string | undefined;
  before?: string | undefined;
  after?: string | undefined;
  limit?: number | undefined;
  order?: "asc" | "desc" | undefined;
  ascending?: boolean | undefined;
}

/** Argument bag for listRunSteps. */
export interface ListRunStepsParams {
  before?: string | undefined;
  after?: string | undefined;
  limit?: number | undefined;
  order?: "asc" | "desc" | undefined;
}

/** Argument bag for cancelRun. */
export interface CancelRunOptions {
  reason?: string;
}

/** Per-grouping totals returned by aggregateUsage. */
export interface UsageTotals {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  run_count: number;
}

export interface UsageBreakdownEntry extends UsageTotals {
  key: string;
}

export interface AggregateUsageResult {
  total: UsageTotals;
  breakdown?: UsageBreakdownEntry[];
}

export interface AggregateUsageParams {
  agentId?: string | undefined;
  agentIds?: string[] | undefined;
  conversationId?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  statuses?: string[] | undefined;
  groupBy?: "agent" | "conversation" | "model" | "day" | null | undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Storage helpers
// ──────────────────────────────────────────────────────────────────────

function storageDir(): string {
  return (
    process.env["LETTA_LOCAL_BACKEND_DIR"] ||
    join(process.env["LETTA_HOME"] || join(homedir(), ".letta"), "lc-local-backend")
  );
}

function runsRoot(): string {
  return join(storageDir(), "runs");
}

function runDir(runId: string): string {
  return join(runsRoot(), runId);
}

function runFile(runId: string): string {
  return join(runDir(runId), "run.json");
}

function stepsFile(runId: string): string {
  return join(runDir(runId), "steps.jsonl");
}

function userActionsFile(runId: string): string {
  return join(runDir(runId), "user-actions.jsonl");
}

/**
 * Best-effort read of a JSON file. Returns `null` on any error
 * (missing, malformed, permission). Caller is responsible for narrowing
 * the parsed value before use — we type it as `unknown` so the runtime
 * type-guard at the call site is explicit.
 */
function readJsonOrNull(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Narrow an arbitrary unknown value to a RunRecord. The shape we read off
 * disk was produced by writeJsonAtomic against our own RunRecord type,
 * but corrupted / partial / hand-edited records are possible — so the
 * guard checks the minimum fields the rest of the module touches.
 */
function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["id"] === "string";
}

function readRunFromDisk(runId: string): RunRecord | null {
  const parsed = readJsonOrNull(runFile(runId));
  return isRunRecord(parsed) ? parsed : null;
}

function readRunAt(path: string): RunRecord | null {
  const parsed = readJsonOrNull(path);
  return isRunRecord(parsed) ? parsed : null;
}

function isStep(value: unknown): value is Step {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["id"] === "string";
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

// In-memory index of active runs for fast list(active=true) + cancel lookup.
// Disk is authoritative; this is a cache that stays consistent because every
// run lifecycle event writes to both.
const _activeRuns = new Map<string, RunHandle>(); // run_id → run handle (in-memory copy)
const _cancelHandlers = new Map<string, (reason: string) => void>(); // run_id → onCancel

function nowIso(): string {
  return new Date().toISOString();
}

function nanosSince(hrStart: [number, number]): number {
  const hrEnd = process.hrtime(hrStart);
  return hrEnd[0] * 1_000_000_000 + hrEnd[1];
}

// ──────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────

/**
 * Convert an in-memory RunRecord to the wire Run shape. Currently the
 * identity — disk and wire are the same shape today. Kept as an explicit
 * seam so a future widening of the on-disk record (extra bookkeeping
 * fields) doesn't leak to clients without a deliberate change here.
 */
export function toWireRun(record: RunRecord): Run {
  return record;
}

/**
 * Create a Run record at turn-start. Returns the in-memory handle.
 *
 * `onCancel` (optional) is a callback invoked by `cancelRun(runId)`. The
 * caller (agent-pool) registers it to SIGTERM the worker; we keep it out
 * of the persisted record because functions don't serialize.
 */
export function createRun({ agentId, conversationId, onCancel }: CreateRunOptions = {}): RunHandle {
  const id = `run-${randomUUID()}`;
  const record: RunRecord = {
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
  const handle: RunHandle = {
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

/**
 * lcp-99a: late-bind the cancel handler for an existing Run. Used when
 * a caller creates the Run BEFORE the worker exists (e.g. mobile WS
 * channel emits turn_started with run_id before pool.get() resolves)
 * and then runTurn() patches the actual SIGTERM hook onto it once the
 * worker is in scope. Idempotent — overwrites whatever was there.
 */
export function setRunCancelHandler(
  runId: string,
  onCancel: (reason: string) => void,
): void {
  _cancelHandlers.set(runId, onCancel);
}

/** Set ttft on the first frame that carries assistant content. Idempotent. */
export function markRunFirstToken(handle: RunHandle | null | undefined): void {
  if (!handle || handle.firstTokenSet) return;
  handle.firstTokenSet = true;
  handle.record.ttft_ns = nanosSince(handle.hrStart);
  writeJsonAtomic(runFile(handle.id), handle.record);
}

export function recordRunMessage(
  handle: RunHandle | null | undefined,
  localMessageId: string | null | undefined,
): void {
  if (!handle || !localMessageId) return;
  if (handle.record.message_ids.includes(localMessageId)) return;
  handle.record.message_ids.push(localMessageId);
}

export function recordRunTool(
  handle: RunHandle | null | undefined,
  toolName: string | null | undefined,
): void {
  if (!handle || !toolName) return;
  if (handle.record.tools_used.includes(toolName)) return;
  handle.record.tools_used.push(toolName);
}

/**
 * Phase 5: append a user_action sidecar entry under
 * `state/runs/<run-id>/user-actions.jsonl`. Channel adapters call this
 * when an A2UI user_action frame arrives. The shim does NOT yet inject
 * the action into letta-code's tool dispatcher — that integration lives
 * in a follow-up bead once letta-code exposes a stable approval API.
 * Until then the sidecar is the canonical record and downstream callers
 * (debug tooling, replay) read it directly.
 *
 * `runId` may be null when the action lands outside a turn; the entry
 * is still appended under a deterministic `unbound-<sessionId>` bucket
 * so the audit trail is preserved.
 */
export function recordA2uiUserAction(entry: {
  run_id: string | null;
  session_id: string;
  turn_id: string | null;
  surface_id: string | null;
  name: string;
  context: Record<string, unknown>;
  action_id: string;
}): void {
  const bucket = entry.run_id ?? `unbound-${entry.session_id}`;
  try {
    mkdirSync(runDir(bucket), { recursive: true });
    appendFileSync(
      userActionsFile(bucket),
      JSON.stringify({ ...entry, recorded_at: nowIso() }) + "\n",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runs] user-action append failed for ${bucket}: ${msg}`);
  }
}

/**
 * Approval decision scope: Once (single call), Session (all calls in this
 * conversation), Forever (all calls across all conversations), or Deny.
 */
export type ApprovalScope = "Once" | "Session" | "Forever" | "Deny";

/**
 * Approval decision record persisted to sidecar JSONL.
 */
export interface ApprovalDecisionRecord {
  action_id: string;
  tool_name: string;
  decision: "approve" | "deny" | "timeout";
  scope: ApprovalScope;
  reason: string;
  timestamp: string;
  user_id?: string;
  recorded_at: string;
}

export interface ApprovalScopeCacheEntry {
  scope: Extract<ApprovalScope, "Session" | "Forever">;
  timestamp: string;
}

interface ApprovalPolicyRecord {
  tool_name: string;
  scope: Extract<ApprovalScope, "Session" | "Forever">;
  conversation_id: string | null;
  timestamp: string;
  run_id: string;
  action_id: string;
  user_id?: string;
}

/**
 * Record an approval decision to the sidecar JSONL file.
 * Append-only; no read-modify-write race.
 */
export function recordApprovalDecision(
  runId: string,
  entry: Omit<ApprovalDecisionRecord, "recorded_at">,
): void {
  try {
    mkdirSync(runDir(runId), { recursive: true });
    appendFileSync(
      approvalDecisionsFile(runId),
      JSON.stringify({ ...entry, recorded_at: nowIso() }) + "\n",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runs] approval-decision append failed for ${runId}: ${msg}`);
  }
}

/**
 * Persist reusable approval scopes. `Session` is keyed to the conversation;
 * `Forever` is global. The append-only audit trail remains
 * approval-decisions.jsonl under the run; this compact JSON file is the fast
 * policy cache used at turn start.
 */
export function recordApprovalPolicy(
  runId: string,
  conversationId: string | null | undefined,
  entry: {
    action_id: string;
    tool_name: string;
    scope: Extract<ApprovalScope, "Session" | "Forever">;
    timestamp: string;
    user_id?: string;
  },
): void {
  try {
    const path = approvalsFile();
    const existing = readApprovalPolicies(path);
    const nextRecord: ApprovalPolicyRecord = {
      tool_name: entry.tool_name,
      scope: entry.scope,
      conversation_id: entry.scope === "Session" ? conversationId ?? null : null,
      timestamp: entry.timestamp,
      run_id: runId,
      action_id: entry.action_id,
      ...(entry.user_id ? { user_id: entry.user_id } : {}),
    };
    const filtered = existing.filter((record) => {
      if (record.tool_name !== nextRecord.tool_name) return true;
      if (nextRecord.scope === "Forever") return record.scope !== "Forever";
      return !(record.scope === "Session" && record.conversation_id === nextRecord.conversation_id);
    });
    mkdirSync(storageDir(), { recursive: true });
    writeFileSync(path, JSON.stringify([...filtered, nextRecord], null, 2) + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runs] approval-policy write failed for ${runId}: ${msg}`);
  }
}

/**
 * Load approval decisions from sidecar and build a scope cache.
 * Returns a map of tool_name → { scope, timestamp } for Session/Forever decisions.
 * Used at turn-start to auto-approve cached decisions without user round-trip.
 */
export function loadApprovalScopeCache(
  runId: string,
  conversationId: string | null = null,
): Map<string, ApprovalScopeCacheEntry> {
  const cache = new Map<string, ApprovalScopeCacheEntry>();
  try {
    for (const record of readApprovalPolicies(approvalsFile())) {
      if (record.scope === "Forever" || record.conversation_id === conversationId) {
        cache.set(record.tool_name, { scope: record.scope, timestamp: record.timestamp });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runs] approval-policy cache load failed: ${msg}`);
  }
  try {
    const path = approvalDecisionsFile(runId);
    if (!existsSync(path)) return cache;
    
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as unknown;
        if (
          typeof record === "object" &&
          record !== null &&
          "tool_name" in record &&
          "decision" in record &&
          "scope" in record &&
          "timestamp" in record &&
          typeof (record as Record<string, unknown>)["tool_name"] === "string" &&
          typeof (record as Record<string, unknown>)["decision"] === "string" &&
          typeof (record as Record<string, unknown>)["scope"] === "string" &&
          typeof (record as Record<string, unknown>)["timestamp"] === "string"
        ) {
          const r = record as Record<string, unknown>;
          const toolName = r["tool_name"] as string;
          const decision = r["decision"] as string;
          const scope = r["scope"] as string;
          const timestamp = r["timestamp"] as string;
          
          // Only cache approve decisions with Session/Forever scope
          if (decision === "approve" && (scope === "Session" || scope === "Forever")) {
            cache.set(toolName, { scope, timestamp });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runs] approval-scope cache load failed for ${runId}: ${msg}`);
  }
  return cache;
}

function readApprovalPolicies(path: string): ApprovalPolicyRecord[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) return [];
  const records: ApprovalPolicyRecord[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const toolName = rec["tool_name"];
    const scope = rec["scope"];
    const timestamp = rec["timestamp"];
    const runId = rec["run_id"];
    const actionId = rec["action_id"];
    const conversationId = rec["conversation_id"];
    const userId = rec["user_id"];
    if (
      typeof toolName !== "string" ||
      (scope !== "Session" && scope !== "Forever") ||
      typeof timestamp !== "string" ||
      typeof runId !== "string" ||
      typeof actionId !== "string" ||
      (conversationId !== null && typeof conversationId !== "string") ||
      (userId !== undefined && typeof userId !== "string")
    ) {
      continue;
    }
    records.push({
      tool_name: toolName,
      scope,
      conversation_id: conversationId,
      timestamp,
      run_id: runId,
      action_id: actionId,
      ...(userId ? { user_id: userId } : {}),
    });
  }
  return records;
}

function approvalsFile(): string {
  return join(storageDir(), "approvals.json");
}

function approvalDecisionsFile(runId: string): string {
  return join(runDir(runId), "approval-decisions.jsonl");
}

export function recordRunStep(
  handle: RunHandle | null | undefined,
  step: RecordStepInput = {},
): Step | undefined {
  if (!handle) return undefined;
  handle.record.num_steps += 1;
  const stepRecord: Step = {
    id: typeof step.id === "string" ? step.id : `step-${randomUUID()}`,
    run_id: handle.id,
    agent_id: handle.record.agent_id,
    created_at: nowIso(),
    ...step,
  };
  try {
    mkdirSync(runDir(handle.id), { recursive: true });
    appendFileSync(stepsFile(handle.id), JSON.stringify(stepRecord) + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runs] step append failed for ${handle.id}: ${msg}`);
  }
  return stepRecord;
}

/**
 * Finalize a run. `status` is "completed", "failed", or "cancelled".
 * Removes from the active index and persists the final record.
 *
 * LOCKED CONTRACT #4 — `usage` here captures the FIRST `usage_statistics`
 * frame of the turn (the caller in agent-pool finds it via
 * `frames.find(..."usage_statistics")`), NOT the sum. Don't "fix" this
 * during the migration; runs.test.mjs defends it.
 */
export function finalizeRun(
  handle: RunHandle | null | undefined,
  { status = "completed", stopReason = null, usage = null }: FinalizeRunOptions = {},
): void {
  if (!handle) return;
  handle.record.status = status;
  handle.record.stop_reason = stopReason;
  handle.record.completed_at = nowIso();
  handle.record.total_duration_ns = nanosSince(handle.hrStart);
  if (usage && typeof usage === "object") {
    const u = usage as UsageInput;
    const finalized: RunUsage = {
      completion_tokens: u.completion_tokens ?? 0,
      prompt_tokens: u.prompt_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
      step_count: handle.record.num_steps,
      cached_input_tokens: u.cached_input_tokens ?? 0,
      cache_write_tokens: u.cache_write_tokens ?? 0,
      reasoning_tokens: u.reasoning_tokens ?? 0,
    };
    handle.record.usage = finalized;
  }
  writeJsonAtomic(runFile(handle.id), handle.record);
  _activeRuns.delete(handle.id);
  _cancelHandlers.delete(handle.id);
}

// ──────────────────────────────────────────────────────────────────────
// Read API
// ──────────────────────────────────────────────────────────────────────

export function getRun(runId: string): Run | null {
  const fromMem = _activeRuns.get(runId);
  if (fromMem) return fromMem.record;
  return readRunFromDisk(runId);
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
}: ListRunsParams = {}): Run[] {
  const root = runsRoot();
  if (!existsSync(root)) return [];
  const out: RunRecord[] = [];
  for (const name of readdirSync(root)) {
    const r = readRunAt(join(root, name, "run.json"));
    if (!r) continue;
    if (agentId && r.agent_id !== agentId) continue;
    if (Array.isArray(agentIds) && agentIds.length && !agentIds.includes(r.agent_id ?? "")) continue;
    if (conversationId && r.conversation_id !== conversationId) continue;
    if (active === true && r.status !== "running") continue;
    if (active === false && r.status === "running") continue;
    if (typeof background === "boolean" && r.background !== background) continue;
    if (Array.isArray(statuses) && statuses.length && !statuses.includes(r.status ?? "")) continue;
    if (stopReason && r.stop_reason !== stopReason) continue;
    out.push(r);
  }
  const cmpAsc = (a: RunRecord, b: RunRecord): number =>
    (a.created_at ?? "").localeCompare(b.created_at ?? "");
  const wantAsc = ascending === true || (ascending == null && order === "asc");
  out.sort(wantAsc ? cmpAsc : (a, b) => -cmpAsc(a, b));
  // before / after pagination is by id in vanilla. Match: drop everything
  // up to (and including) `after`, then up to `before` (exclusive).
  let scoped: RunRecord[] = out;
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

export function listRunSteps(
  runId: string,
  { before, after, limit, order }: ListRunStepsParams = {},
): Step[] {
  const path = stepsFile(runId);
  if (!existsSync(path)) return [];
  const items: Step[] = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l): unknown => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return null;
      }
    })
    .filter(isStep);
  let scoped: Step[] = items;
  const cmp = (a: Step, b: Step): number =>
    (a.created_at ?? "").localeCompare(b.created_at ?? "");
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
export function cancelRun(
  runId: string,
  { reason = "user_cancelled" }: CancelRunOptions = {},
): boolean {
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
    try {
      onCancel(reason);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[runs] cancel callback for ${runId} threw: ${msg}`);
    }
  }
  return true;
}

export function deleteRun(runId: string): boolean {
  const path = runFile(runId);
  if (!existsSync(path)) return false;
  try {
    rmSync(runDir(runId), { recursive: true, force: true });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runs] delete failed for ${runId}: ${msg}`);
    return false;
  }
}

export function listActiveRunIds(): string[] {
  return [..._activeRuns.keys()];
}

/**
 * lcp-nwd: build an inverse messageId -> runId index for a given scope.
 * Used by the message wire projection so each returned LettaMessage
 * carries the run_id that attributed it, enabling mobile's chat-UI
 * run-grouping affordance.
 *
 * Filters mirror listRuns: if both agentId and conversationId are
 * supplied, only runs matching BOTH are walked. Either may be
 * undefined to widen.
 *
 * When the same messageId appears in multiple runs' message_ids
 * (rare — would imply two runs both claimed the same persisted
 * message), the LAST writer wins to match the "first run that
 * attributed it" semantics most callers want. listRuns returns
 * desc-by-created-at; we iterate accordingly so older wins overall.
 */
export function buildMessageRunMap(
  { agentId, conversationId }: { agentId?: string | undefined; conversationId?: string | undefined } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const runs = listRuns({
    ...(agentId !== undefined ? { agentId } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    limit: 10_000,
    order: "asc",
  });
  for (const r of runs) {
    for (const mid of r.message_ids ?? []) {
      if (typeof mid === "string" && !out[mid]) out[mid] = r.id;
    }
  }
  return out;
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

function emptyTotals(): UsageTotals {
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

/** Minimal shape of any usage-like blob aggregateUsage can sum. */
interface AddableUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

function addUsageInto(target: UsageTotals, src: AddableUsage | null | undefined): void {
  if (!src) return;
  target.prompt_tokens += src.prompt_tokens ?? 0;
  target.completion_tokens += src.completion_tokens ?? 0;
  target.total_tokens += src.total_tokens ?? 0;
  target.cached_input_tokens += src.cached_input_tokens ?? 0;
  target.cache_write_tokens += src.cache_write_tokens ?? 0;
  target.reasoning_tokens += src.reasoning_tokens ?? 0;
}

function dayKey(iso: string | null | undefined): string {
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
}: AggregateUsageParams = {}): AggregateUsageResult {
  const root = runsRoot();
  if (!existsSync(root)) {
    return groupBy
      ? { total: emptyTotals(), breakdown: [] }
      : { total: emptyTotals() };
  }

  const total = emptyTotals();
  const groups = new Map<string, UsageTotals>(); // groupKey → UsageTotals

  for (const name of readdirSync(root)) {
    const r = readRunAt(join(root, name, "run.json"));
    if (!r) continue;
    if (agentId && r.agent_id !== agentId) continue;
    if (Array.isArray(agentIds) && agentIds.length && !agentIds.includes(r.agent_id ?? "")) continue;
    if (conversationId && r.conversation_id !== conversationId) continue;
    if (Array.isArray(statuses) && statuses.length && !statuses.includes(r.status ?? "")) continue;
    if (start && (r.created_at ?? "") < start) continue;
    if (end && (r.created_at ?? "") > end) continue;

    if (groupBy === "model") {
      // Need per-step granularity for model breakdown — each step has its
      // own model attribution that the run-level rollup doesn't preserve.
      const steps = listRunSteps(r.id, { limit: 1000 });
      const runUsageSeen = steps.length > 0;
      for (const s of steps) {
        const key = typeof s.model === "string" && s.model ? s.model : "unknown";
        let g = groups.get(key);
        if (!g) {
          g = emptyTotals();
          groups.set(key, g);
        }
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
      if (!g) {
        g = emptyTotals();
        groups.set(key, g);
      }
      addUsageInto(g, r.usage);
      g.run_count += 1;
    } else if (groupBy === "conversation") {
      const key = r.conversation_id ?? "unknown";
      let g = groups.get(key);
      if (!g) {
        g = emptyTotals();
        groups.set(key, g);
      }
      addUsageInto(g, r.usage);
      g.run_count += 1;
    } else if (groupBy === "day") {
      const key = dayKey(r.created_at);
      let g = groups.get(key);
      if (!g) {
        g = emptyTotals();
        groups.set(key, g);
      }
      addUsageInto(g, r.usage);
      g.run_count += 1;
    }
  }

  if (!groupBy) return { total };
  const breakdown: UsageBreakdownEntry[] = [...groups.entries()]
    .map(([key, totals]) => ({ key, ...totals }))
    .sort((a, b) => b.total_tokens - a.total_tokens);
  return { total, breakdown };
}
