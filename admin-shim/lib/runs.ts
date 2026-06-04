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
  renameSync,
  rmSync,
  statSync,
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
  // lcp-p74.1: monotonic seq per run for frames.jsonl. Not persisted on the
  // record — seq is implicit in file line position; this is just a writer-side
  // counter to avoid re-stat'ing the file on every append.
  frameCount: number;
  // lcp-02ri: runDir(id) is created at run creation, so the hot frame append
  // path can skip mkdirSync per streamed frame.
  frameDirReady: boolean;
  // lcp-r0m: per-turn set of otids currently being streamed by this run.
  // Populated from frames during the stream (applyFrameRunSideEffects);
  // useful for any consumer that keys by otid (and a forward seam for
  // mobile if/when its merger starts keying merges off the wire otid).
  // Not persisted — purely turn-life transient.
  inFlightOtids: Set<string>;
  // lcp-r0m: snapshot of LocalMessage ids that existed on disk BEFORE
  // this turn started. The REST /messages handler subtracts the union of
  // these (across all active runs for the (agent, conv) pair) from the
  // currently-on-disk id list — any id NOT in the snapshot is in-flight
  // and must be dropped from the projection so mobile's REST hydrate
  // doesn't race the WS delta stream for the same logical message.
  // Populated at runTurn entry, never re-read on disk.
  messageIdsAtTurnStart: Set<string>;
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
  /**
   * lcp-4tv: when true, mark the run as "background" so list filters
   * (`/v1/runs?background=true`) can distinguish operator-initiated /
   * cron-driven turns from user-initiated ones. Defaults to false to
   * match the prior hardcoded behavior.
   */
  background?: boolean;
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
  /**
   * lcp-98cm: also walk the `_archive` subdir of compacted (old, terminal)
   * runs. Off by default so the hot path stays bounded; opt in only for
   * full-history reports that must see every run ever recorded.
   */
  includeArchived?: boolean | undefined;
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

// lcp-98cm: terminal runs older than the retention window are MOVED (atomic
// rename, never deleted) into this subdir so the live runs root stays small
// and `listRuns`' readdir cost stops growing without bound. getRun still
// resolves archived runs by id; no run history is lost.
const ARCHIVE_DIR_NAME = "_archive";

function archiveRoot(): string {
  return join(runsRoot(), ARCHIVE_DIR_NAME);
}

function archivedRunFile(runId: string): string {
  return join(archiveRoot(), runId, "run.json");
}

/**
 * lcp-98cm: resolve a run's directory for READ / maintenance paths. Returns
 * the live dir if the run still lives there, else the archive dir if it was
 * compacted, else the live dir as the default. Write hot paths (frame/step
 * append) deliberately do NOT call this — an in-flight run is always live, so
 * they stay on runDir() without an extra stat per write.
 */
function resolveRunDir(runId: string): string {
  if (existsSync(runFile(runId))) return runDir(runId);
  if (existsSync(archivedRunFile(runId))) return join(archiveRoot(), runId);
  return runDir(runId);
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

function framesFile(runId: string): string {
  return join(runDir(runId), "frames.jsonl");
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
  // Live dir first, then the lcp-98cm archive — a direct lookup must still
  // resolve runs that compaction has moved out of the live root.
  let parsed = readJsonOrNull(runFile(runId));
  if (!isRunRecord(parsed)) parsed = readJsonOrNull(archivedRunFile(runId));
  return isRunRecord(parsed) ? parsed : null;
}

// lcp-r6lb: per-file parse cache for run.json. listRuns readdirs the runs
// root and reads EVERY run.json on each call — and buildMessageRunMap (hit on
// every GET /messages) drives that walk over what is now ~1700+ run files,
// filtering by conversation_id only AFTER parsing each. A run.json changes
// only while its run is in flight (status/usage/message_ids updates) and then
// never again; finalized runs are immutable. So we cache the parsed record
// keyed on (mtimeMs, size): an unchanged file is reused after a single stat,
// turning the hot walk from ~1700 reads+JSON.parses into ~1700 stats with no
// parsing. Correct against in-flight updates because every writeRunRecord
// rewrites the file (changing mtime/size), which invalidates the entry.
interface RunFileCacheEntry {
  mtimeMs: number;
  size: number;
  run: RunRecord | null;
}
const runFileCache = new Map<string, RunFileCacheEntry>();
const RUN_FILE_CACHE_MAX = 4096;

function readRunAt(path: string): RunRecord | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    runFileCache.delete(path);
    return null;
  }
  const cached = runFileCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.run;
  }
  const parsed = readJsonOrNull(path);
  const run = isRunRecord(parsed) ? parsed : null;
  // LRU-ish bound: drop the oldest insertion when over cap. Runs are sharded
  // one-per-dir and grow unbounded over the agent's lifetime, so cap the map.
  if (runFileCache.size >= RUN_FILE_CACHE_MAX) {
    const oldest = runFileCache.keys().next().value;
    if (oldest !== undefined) runFileCache.delete(oldest);
  }
  runFileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, run });
  return run;
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
const FINALIZED_APPEND_GRACE_MS = 30_000;
const _finalizedAppendWindow = new Map<string, { handle: RunHandle; timeout: NodeJS.Timeout }>();

function rememberFinalizedRunForAppend(runId: string, handle: RunHandle): void {
  const prev = _finalizedAppendWindow.get(runId);
  if (prev) clearTimeout(prev.timeout);
  const timeout = setTimeout(() => {
    _finalizedAppendWindow.delete(runId);
  }, FINALIZED_APPEND_GRACE_MS);
  timeout.unref?.();
  _finalizedAppendWindow.set(runId, { handle, timeout });
}

function getAppendableRunHandle(runId: string): RunHandle | undefined {
  return _activeRuns.get(runId) ?? _finalizedAppendWindow.get(runId)?.handle;
}

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
export function createRun({ agentId, conversationId, onCancel, background }: CreateRunOptions = {}): RunHandle {
  const id = `run-${randomUUID()}`;
  const record: RunRecord = {
    id,
    agent_id: agentId ?? null,
    background: background ?? false,
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
    frameCount: 0,
    frameDirReady: false,
    inFlightOtids: new Set<string>(),
    messageIdsAtTurnStart: new Set<string>(),
  };
  _activeRuns.set(id, handle);
  if (typeof onCancel === "function") {
    _cancelHandlers.set(id, onCancel);
  }
  writeJsonAtomic(runFile(id), record);
  handle.frameDirReady = true;
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

/**
 * lcp-r0m: stamp an otid into the run's in-flight set as soon as a
 * streamed frame referencing it goes past. Called by
 * `applyFrameRunSideEffects` per-frame; lets the REST /messages handler
 * filter out the corresponding disk record while the WS stream is still
 * delivering deltas for it. Idempotent — same otid in the same turn is
 * a normal multi-frame case (assistant_message chunks share an otid).
 */
export function recordRunOtid(
  handle: RunHandle | null | undefined,
  otid: string | null | undefined,
): void {
  if (!handle || !otid) return;
  handle.inFlightOtids.add(otid);
}

/**
 * lcp-r0m: snapshot the LocalMessage ids that existed on disk BEFORE
 * this turn started. Caller (adapter._runTurnInner) computes this once
 * via listMessages right before the first send, then hands it to the
 * run handle via this setter. The REST /messages filter uses it to
 * decide which currently-on-disk ids are mid-flight (= NOT in the
 * snapshot of any active run).
 */
export function setMessageIdsAtTurnStart(
  handle: RunHandle | null | undefined,
  ids: Iterable<string>,
): void {
  if (!handle) return;
  handle.messageIdsAtTurnStart = new Set(ids);
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
  component_id?: string | null;
  name: string;
  context: Record<string, unknown>;
  action_id: string;
  routed_as?: "approval" | "synthetic_input" | "recorded_only";
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
 * lcp-p74.2: absolute path to a run's frames.jsonl. May not exist yet.
 * Exported so the subscribe reader/tail (subscribeToRun) can resolve the
 * file without duplicating the storageDir + runDir logic.
 */
export function getFramesFilePath(runId: string): string {
  // Read path (subscribe replay/tail) — resolve archived runs too.
  return join(resolveRunDir(runId), "frames.jsonl");
}

/**
 * lcp-p74.1: append a single frame to <run-dir>/frames.jsonl with a
 * monotonic seq. Each line: { seq, ts, frame }. Returns the seq assigned to
 * this frame (or -1 if the run isn't tracked — caller can ignore for
 * fire-and-forget cases).
 *
 * Atomicity: one appendFileSync per line. POSIX guarantees atomic appends
 * for writes ≤ PIPE_BUF (4 KiB); single-writer-per-run holds for the agent
 * pool's serialized turns, so larger frames are also safe in practice.
 *
 * lcp-xu4l: terminal stop/usage frames can arrive just after finalizeRun()
 * removes the handle from `_activeRuns`. Keep a short post-finalize append
 * window so reconnect/replay sees the full terminal tail in frames.jsonl.
 */
export function appendRunFrame(runId: string, frame: unknown): { seq: number } {
  const handle = getAppendableRunHandle(runId);
  if (!handle) return { seq: -1 };
  handle.frameCount += 1;
  const seq = handle.frameCount;
  const line = JSON.stringify({ seq, ts: nowIso(), frame }) + "\n";
  try {
    if (!handle.frameDirReady) {
      mkdirSync(runDir(runId), { recursive: true });
      handle.frameDirReady = true;
    }
    appendFileSync(framesFile(runId), line);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runs] frame append failed for ${runId}: ${msg}`);
  }
  return { seq };
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
  rememberFinalizedRunForAppend(handle.id, handle);
  _activeRuns.delete(handle.id);
  _cancelHandlers.delete(handle.id);
  maybeCompactRuns();
}

// ── lcp-98cm: runs-directory compaction ───────────────────────────────
//
// One dir per run keeps finalize concurrency-safe but lets the runs root
// grow without bound (1700+ dirs already), inflating every listRuns readdir.
// compactRuns MOVES terminal runs older than the retention window into the
// `_archive` subdir via atomic rename — lossless (run.json + steps + frames
// move together), reversible, and resolvable by getRun. The live root stays
// bounded so the hot read path's readdir cost stops scaling with total runs.
//
// Attribution horizon: archived runs drop out of the default listRuns walk,
// so buildMessageRunMap groups by the most-recent ~retain runs (well beyond
// any window mobile renders live). Full-history callers pass includeArchived.
const DEFAULT_RUN_RETENTION = (() => {
  const n = Number(process.env["SHIM_RUNS_RETENTION"] ?? 1000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
})();
const COMPACT_BATCH = 250;
const COMPACT_THROTTLE_MS = 5 * 60 * 1000;
let lastCompactAt = 0;

export function compactRuns(
  { retain = DEFAULT_RUN_RETENTION, max = Infinity }: { retain?: number; max?: number } = {},
): { archived: number; scanned: number } {
  const root = runsRoot();
  if (!existsSync(root)) return { archived: 0, scanned: 0 };
  const live: Array<{ id: string; createdAt: string; terminal: boolean }> = [];
  for (const name of readdirSync(root)) {
    if (name === ARCHIVE_DIR_NAME) continue;
    const r = readRunAt(join(root, name, "run.json"));
    if (!r) continue;
    live.push({
      id: r.id,
      createdAt: r.created_at ?? "",
      // Never archive an in-flight run: status must be terminal AND the run
      // must not hold a live in-memory handle.
      terminal: r.status !== "running" && !_activeRuns.has(r.id),
    });
  }
  const scanned = live.length;
  if (scanned <= retain) return { archived: 0, scanned };
  // Oldest first; keep the newest `retain` in the live root.
  live.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const candidates = live.slice(0, scanned - retain);
  let archived = 0;
  try {
    mkdirSync(archiveRoot(), { recursive: true });
  } catch {
    return { archived: 0, scanned };
  }
  for (const c of candidates) {
    if (archived >= max) break;
    if (!c.terminal) continue;
    const from = runDir(c.id);
    const to = join(archiveRoot(), c.id);
    if (existsSync(to)) continue; // already archived (idempotent re-run)
    try {
      renameSync(from, to);
      runFileCache.delete(join(from, "run.json"));
      archived += 1;
    } catch {
      // Best-effort: a concurrent finalize or a vanished dir is fine to skip.
    }
  }
  return { archived, scanned };
}

// Throttled, non-blocking auto-trigger fired from finalizeRun. Compaction does
// directory renames, so we defer it off the turn-finalize path with
// setImmediate and rate-limit it. Disable with SHIM_RUNS_COMPACT=0.
function maybeCompactRuns(): void {
  if (process.env["SHIM_RUNS_COMPACT"] === "0") return;
  const now = Date.now();
  if (now - lastCompactAt < COMPACT_THROTTLE_MS) return;
  lastCompactAt = now;
  setImmediate(() => {
    try {
      compactRuns({ retain: DEFAULT_RUN_RETENTION, max: COMPACT_BATCH });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[runs] compaction pass failed: ${msg}`);
    }
  });
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
  includeArchived = false,
}: ListRunsParams = {}): Run[] {
  const root = runsRoot();
  if (!existsSync(root)) return [];
  const out: RunRecord[] = [];
  const walk = (dir: string, runFilePath: (name: string) => string): void => {
    for (const name of readdirSync(dir)) {
      // Never descend the archive subdir during the live walk (lcp-98cm).
      if (dir === root && name === ARCHIVE_DIR_NAME) continue;
      const r = readRunAt(runFilePath(name));
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
  };
  walk(root, (name) => join(root, name, "run.json"));
  if (includeArchived && existsSync(archiveRoot())) {
    walk(archiveRoot(), (name) => join(archiveRoot(), name, "run.json"));
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
  const path = join(resolveRunDir(runId), "steps.jsonl");
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
  // Resolve archived runs too so delete works regardless of compaction state.
  const dir = resolveRunDir(runId);
  if (!existsSync(join(dir, "run.json"))) return false;
  try {
    runFileCache.delete(join(dir, "run.json"));
    rmSync(dir, { recursive: true, force: true });
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
 * lcp-r0m: return active (status="running") runs scoped to a conversation.
 * Used by the REST /messages handler to filter out in-flight assistant
 * messages so they don't race the WS delta stream on the same serverId.
 *
 * Why this exists: the WS path streams pure deltas under a stable
 * cm-stream-<otid> id. If REST /messages returns the corresponding
 * cumulative assistant_message mid-stream, the client's merge appends
 * the snapshot onto the accumulated deltas and produces incoherent text
 * (the 2026-05-19 "StandStanding by..." repro). Filtering here keeps the
 * two transports from racing on the same serverId.
 *
 * On the next REST hydrate after turn_done, the run finalizes and drops
 * out of _activeRuns, so the message naturally appears in subsequent
 * /messages calls.
 */
export function listActiveRunsForConversation(
  agentId: string,
  conversationId: string,
): RunHandle[] {
  const out: RunHandle[] = [];
  for (const handle of _activeRuns.values()) {
    if (handle.record.status !== "running") continue;
    if (handle.record.agent_id !== agentId) continue;
    if (handle.record.conversation_id !== conversationId) continue;
    out.push(handle);
  }
  return out;
}

/**
 * lcp-r0m: collect the set of message_ids that are mid-flight (i.e.,
 * currently being written by an active run) for the given (agent,
 * conversation) pair, given the caller's view of the current on-disk
 * id list.
 *
 * Computed as: every id in `currentDiskIds` that is NOT in any active
 * run's `messageIdsAtTurnStart` snapshot. That set is exactly the
 * messages letta-code has appended SINCE the active turn started — the
 * cumulative assistant_message snapshot that the WS delta stream is
 * still delivering, plus any tool-result rows landing under the same
 * turn. The REST /messages handler drops these from its projection so
 * mobile's snapshot-vs-delta merge doesn't collide ("StandStanding by
 * ..." repro, 2026-05-19).
 *
 * Why we read from a caller-supplied id set rather than calling
 * listMessages ourselves: the REST handler has already paid for the
 * disk read; doing it twice would double the cost on every list call.
 *
 * The previous shape of this helper returned ids from each run's
 * `record.message_ids`, but those are only populated by
 * `recordRunMessage` at TURN END (inside finalizeTurnLifecycle) — i.e.
 * after the race window has already closed. The mid-turn race needs an
 * in-flight signal, which is what the pre-turn snapshot provides.
 *
 * On no active runs OR no snapshot recorded yet, returns an empty set
 * (i.e. nothing is in-flight, the caller's filter is a no-op).
 */
export function inFlightMessageIds(
  agentId: string,
  conversationId: string,
  currentDiskIds?: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  const handles = listActiveRunsForConversation(agentId, conversationId);
  if (handles.length === 0) return out;
  // No caller-supplied id set: legacy callers (and one test) used to read
  // record.message_ids. Preserve that fallback so a missing argument
  // gives a defined behavior (empty set + warning would be too loud).
  if (!currentDiskIds) {
    for (const handle of handles) {
      for (const mid of handle.record.message_ids) {
        if (typeof mid === "string" && mid.length > 0) out.add(mid);
      }
    }
    return out;
  }
  // Combine all active runs' pre-turn snapshots — a message id is
  // in-flight if it's present on disk now AND wasn't present at the
  // start of ANY active run.
  const preStartUnion = new Set<string>();
  for (const handle of handles) {
    for (const mid of handle.messageIdsAtTurnStart) preStartUnion.add(mid);
  }
  for (const id of currentDiskIds) {
    if (!preStartUnion.has(id)) out.add(id);
  }
  return out;
}

/**
 * lcp-r0m: collect the otid set currently being streamed by any active
 * run for the (agent, conversation) pair. The REST /messages handler
 * filters disk records whose otid is in this set so a mid-turn hydrate
 * doesn't return the cumulative assistant_message that the WS stream is
 * still delivering as deltas (the "StandStanding by..." merge collision).
 *
 * Unlike inFlightMessageIds — which only populates at finalize via
 * recordRunMessage and is therefore empty DURING the actual race — this
 * is populated from every streamed frame in real time via
 * `recordRunOtid` inside applyFrameRunSideEffects. The race window
 * closes the instant the first frame for an otid lands.
 */
export function inFlightOtids(
  agentId: string,
  conversationId: string,
): Set<string> {
  const out = new Set<string>();
  for (const handle of listActiveRunsForConversation(agentId, conversationId)) {
    for (const o of handle.inFlightOtids) {
      out.add(o);
    }
  }
  return out;
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
 * message), the OLDEST run wins. We iterate `listRuns(..., order:
 * "asc")` — oldest-first — and use `if (!out[mid]) out[mid] = r.id`,
 * so the oldest run that claimed a given messageId keeps the
 * attribution. Once a run has attributed a persisted message, later
 * runs cannot steal that attribution. This matches the "first run
 * that attributed it" intuition most callers want.
 */
/**
 * lcp-cen: hard cap on `listRuns` for the attribution walk. Long-lived
 * agents that exceed this start losing OLDEST runs from the lookup
 * (because `order: "asc"` walks oldest-first but the result is capped
 * at this size). The cap-hit warning below surfaces the problem so it
 * doesn't fail silently as "old messages suddenly render ungrouped".
 */
const BUILD_MESSAGE_RUN_MAP_CAP = 10_000;

// lcp-spok: short-TTL memo of buildMessageRunMap. The /messages handler calls
// this on every poll; mobile polls in bursts (warmup + observer + retries)
// that land within a second of each other. A 1s TTL collapses a burst to one
// computation while bounding staleness. Staleness during an ACTIVE turn is
// harmless: the only attribution that changes mid-turn is message_ids growing
// on the in-flight run, and the /messages handler already filters in-flight
// messages out of the projection (inFlightMessageIds), so they aren't grouped
// until the turn settles anyway.
const BUILD_MESSAGE_RUN_MAP_TTL_MS = 1000;
interface RunMapMemoEntry {
  at: number;
  map: Record<string, string>;
}
const runMapMemo = new Map<string, RunMapMemoEntry>();
const RUN_MAP_MEMO_MAX = 256;

export function buildMessageRunMap(
  opts: { agentId?: string | undefined; conversationId?: string | undefined } = {},
): Record<string, string> {
  const key = `${opts.agentId ?? ""}|${opts.conversationId ?? ""}`;
  const now = Date.now();
  const memo = runMapMemo.get(key);
  if (memo && now - memo.at < BUILD_MESSAGE_RUN_MAP_TTL_MS) {
    return memo.map;
  }
  const map = buildMessageRunMapUncached(opts);
  if (runMapMemo.size >= RUN_MAP_MEMO_MAX) {
    const oldest = runMapMemo.keys().next().value;
    if (oldest !== undefined) runMapMemo.delete(oldest);
  }
  runMapMemo.set(key, { at: now, map });
  return map;
}

function buildMessageRunMapUncached(
  { agentId, conversationId }: { agentId?: string | undefined; conversationId?: string | undefined } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const runs = listRuns({
    ...(agentId !== undefined ? { agentId } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    limit: BUILD_MESSAGE_RUN_MAP_CAP,
    order: "asc",
  });
  if (runs.length >= BUILD_MESSAGE_RUN_MAP_CAP) {
    // lcp-cen: structured warning. Converts a silent-incorrectness bug
    // (attribution-incomplete past the cap) into a loud-incorrectness
    // bug so operators see it in logs / metrics scrape before users
    // see ungrouped chat blocks. Logged once per call site invocation;
    // dedup belongs in a memoization layer (separate concern).
    console.warn(
      JSON.stringify({
        level: "warn",
        module: "runs",
        event: "buildMessageRunMap.cap_hit",
        agent_id: agentId ?? null,
        conversation_id: conversationId ?? null,
        cap: BUILD_MESSAGE_RUN_MAP_CAP,
        message:
          "attribution-incomplete: increase cap or paginate; oldest runs past the cap will not be reflected in the run_id projection",
      }),
    );
  }
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
