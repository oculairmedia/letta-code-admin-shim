/**
 * Active-subagent registry (letta-mobile-73o2h.1).
 *
 * Surfaces an in-memory registry of subagents dispatched from a parent
 * agent turn via the `Agent` tool, so the mobile app can enumerate
 * currently-active subagents and subscribe to each one's progress
 * (TodoWrite) + lifecycle WITHOUT scanning the parent run frame stream.
 *
 * ── The correlation seam (load-bearing) ──────────────────────────────
 *
 * A subagent dispatch rides the PARENT run's frame stream as a single
 * `tool_call_message` with `tool_call.name === "Agent"`:
 *
 *   tool_call.tool_call_id  → correlation key
 *   tool_call.arguments     → JSON { subagent_type, description,
 *                                    run_in_background, prompt }
 *
 * The matching `tool_return_message` (name "Agent") for a BACKGROUND
 * dispatch carries the subagent's identity in its text body:
 *
 *   "Task running in background with task ID: task_2
 *    Agent ID: agent-local-376f41c4-...
 *    Output file: /tmp/letta-background/task_2.log"
 *
 * That gives us the THREE keys we need to reach the subagent:
 *   - task_id            (e.g. "task_2") — background poll/notify key
 *   - subagentAgentId    (agent-local-<uuid>) — the subagent's OWN agent
 *   - logFile            (/tmp/letta-background/task_N.log) — terminal signal
 *
 * CRITICAL: a subagent's OWN TodoWrite lives in the SUBAGENT's separate
 * conversation, NOT the parent frame stream. The subagent's conversation
 * is `default:<subagentAgentId>` in the lc-local-backend conversation
 * store. `lib/subagent-todos.ts` reads that store to surface the
 * subagent's latest TodoWrite snapshot.
 *
 * ── Terminal status detection ────────────────────────────────────────
 *
 * Background tasks write a plaintext log at `/tmp/letta-background/
 * task_N.log`. The log opens with `[Task started: ...]` and closes with
 * `[Task completed]` or a failure footer. Silence is not terminal: the
 * registry only finalizes started-only logs when a captured worker PID is
 * confirmed dead, or during boot rehydrate when the entry belongs to a
 * previous shim instance and no live worker PID can be verified.
 *
 * The bus is intentionally minimal (mirrors `cron-events.ts`): no replay,
 * no buffering. Late subscribers see only events emitted after they
 * register; the canonical state is the live registry and is re-readable
 * on demand via `listActiveSubagents()` / `snapshotSubagents()`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { invalidateMessagesCache, messagesJsonlPath } from "./store.js";
import { readSubagentTodos, type TodoItem, type TodoSnapshot } from "./subagent-todos.js";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type SubagentStatus = "running" | "completed" | "failed";

export interface TodoProgress {
  completed: number;
  total: number;
}

/**
 * One registry entry. `taskId` / `subagentAgentId` / `logFile` are only
 * populated once the Agent tool_return is observed (background dispatch);
 * for a synchronous dispatch the tool_return resolves the entry's
 * terminal status directly and those fields may stay null.
 */
export interface SubagentEntry {
  /** Correlation key — the parent Agent tool_call.tool_call_id. */
  toolCallId: string;
  /** Background task id (e.g. "task_2"); null for sync dispatch. */
  taskId: string | null;
  /** Human-facing description from the dispatch args. */
  description: string | null;
  /** subagent_type from the dispatch args (e.g. "general-purpose"). */
  subagentType: string | null;
  /** Whether the dispatch was run_in_background. */
  runInBackground: boolean;
  /** running | completed | failed. */
  status: SubagentStatus;
  /** Reason string when status === "failed" (e.g. "stream_timeout"). */
  failureReason: string | null;
  /** The parent run id this dispatch was streamed from. */
  parentRunId: string | null;
  /** Provenance — "letta" for Agent-tool dispatches, or the external producer's id. */
  source: string;
  /** The subagent's OWN agent id (agent-local-<uuid>); null until resolved. */
  subagentAgentId: string | null;
  /** Latest TodoWrite progress fraction for ring-fill clients; null until known. */
  todo_progress: TodoProgress | null;
  /**
   * The subagent's conversation id. letta-code subagents run in their
   * "default" conversation, so this is "default" once subagentAgentId is
   * known. The (conversationId, subagentAgentId) pair addresses the
   * subagent's message store for the TodoWrite subscription.
   */
  subagentConversationId: string | null;
  /** Background task log path; null for sync dispatch. */
  logFile: string | null;
  /** Worker process id when exposed by task metadata/logs; null when unavailable. */
  workerPid: number | null;
  /** Shim process that observed this entry in the current in-memory registry. */
  ownerShimPid: number | null;
  /** Per-process shim instance that created/owns this background worker. */
  ownerShimInstanceId: string | null;
  /** ISO timestamp the dispatch was first observed. */
  startedAt: string;
  /** ISO timestamp the entry reached a terminal status; null while running. */
  endedAt: string | null;
}

export type SubagentEventReason =
  | "started" // a new Agent dispatch was observed
  | "resolved" // the Agent tool_return correlated the subagent run/conversation
  | "todos_changed" // latest TodoWrite progress changed
  | "completed" // subagent reached terminal success
  | "failed"; // subagent reached terminal failure (incl. stream_timeout)

export interface SubagentEvent {
  reason: SubagentEventReason;
  subagent: SubagentEntry;
  at: string;
}

type Listener = (event: SubagentEvent) => void;

// ──────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────

const _subagents = new Map<string, SubagentEntry>(); // toolCallId → entry
const _listeners = new Set<Listener>();
const _logWatchers = new Map<string, FSWatcher>(); // toolCallId → fs.watch handle
const _todoWatchers = new Map<string, FSWatcher>(); // toolCallId → TodoWrite messages.jsonl watcher
const _todoDebounceTimers = new Map<string, NodeJS.Timeout>(); // toolCallId → TodoWrite debounce
const _timeoutTimers = new Map<string, NodeJS.Timeout>(); // toolCallId → watchdog
let _livenessSweepTimer: NodeJS.Timeout | null = null;
let currentShimInstanceId: string | null = null;

/**
 * Stream-timeout window. A background subagent still `running` after this
 * many ms is flipped to `failed` with reason `stream_timeout`. Mirrors the
 * 600s local-provider stream timeout the dispatch path tolerates. Override
 * with SHIM_SUBAGENT_TIMEOUT_MS (tests set a tiny value).
 */
const SUBAGENT_TIMEOUT_MS = (() => {
  const n = Number(process.env["SHIM_SUBAGENT_TIMEOUT_MS"] ?? 600_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600_000;
})();

/** Periodic orphan detector cadence. Override in tests. */
const SUBAGENT_LIVENESS_SWEEP_MS = (() => {
  const n = Number(process.env["SHIM_SUBAGENT_LIVENESS_SWEEP_MS"] ?? 60_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60_000;
})();

/**
 * No-logfile orphan window. Dispatches that never produce an Output file
 * have not started streaming, so bound them sooner than the 600s stream
 * timeout while leaving healthy, log-writing subagents on the longer window.
 */
const SUBAGENT_NO_LOGFILE_TIMEOUT_MS = (() => {
  const n = Number(process.env["SHIM_SUBAGENT_NO_LOGFILE_TIMEOUT_MS"] ?? 90_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90_000;
})();

function nowIso(): string {
  return new Date().toISOString();
}

export function setSubagentRegistryInstanceId(instanceId: string | null): void {
  currentShimInstanceId = instanceId && instanceId.trim() ? instanceId.trim() : null;
}

function clone(entry: SubagentEntry): SubagentEntry {
  return { ...entry };
}

function emit(reason: SubagentEventReason, entry: SubagentEntry): void {
  const event: SubagentEvent = { reason, subagent: clone(entry), at: nowIso() };
  for (const listener of _listeners) {
    try {
      listener(event);
    } catch (err) {
      // Listeners must not break each other or the publisher.
      console.error("[subagent-registry] listener threw:", err);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Parsing helpers (exported for tests)
// ──────────────────────────────────────────────────────────────────────

/** Shape of the parsed Agent dispatch arguments we care about. */
export interface ParsedAgentDispatch {
  subagentType: string | null;
  description: string | null;
  runInBackground: boolean;
}

/**
 * Parse the `arguments` of an `Agent` tool_call. `arguments` may be a JSON
 * string (wire shape) or an already-parsed object (local store shape).
 * Unknown / malformed input yields conservative defaults.
 */
export function parseAgentDispatchArgs(args: unknown): ParsedAgentDispatch {
  let obj: Record<string, unknown> | null = null;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      obj = null;
    }
  } else if (args && typeof args === "object") {
    obj = args as Record<string, unknown>;
  }
  if (!obj) return { subagentType: null, description: null, runInBackground: false };
  const subagentType = typeof obj["subagent_type"] === "string" ? (obj["subagent_type"] as string) : null;
  const description = typeof obj["description"] === "string" ? (obj["description"] as string) : null;
  const runInBackground = obj["run_in_background"] === true;
  return { subagentType, description, runInBackground };
}

/** Resolution extracted from a background Agent tool_return body. */
export interface ParsedAgentReturn {
  taskId: string | null;
  subagentAgentId: string | null;
  logFile: string | null;
  workerPid: number | null;
}

/**
 * Parse the text body of a background `Agent` tool_return. Tolerant of
 * the multi-line plaintext shape:
 *
 *   Task running in background with task ID: task_2
 *   Agent ID: agent-local-376f41c4-...
 *   Output file: /tmp/letta-background/task_2.log
 *
 * Returns nulls for fields it can't find (e.g. a synchronous dispatch
 * whose return is the subagent's final report rather than this header).
 */
export function parseAgentReturnBody(body: unknown): ParsedAgentReturn {
  const text = toReturnText(body);
  if (!text) return { taskId: null, subagentAgentId: null, logFile: null, workerPid: null };
  const taskId = text.match(/task ID:\s*(task_\d+)/i)?.[1] ?? null;
  const subagentAgentId = text.match(/Agent ID:\s*(agent-local-[0-9a-f-]+)/i)?.[1] ?? null;
  const logFile = text.match(/Output file:\s*(\S+)/i)?.[1] ?? null;
  const pidText = text.match(/(?:Worker PID|PID):\s*(\d+)/i)?.[1] ?? null;
  const parsedPid = pidText ? Number(pidText) : null;
  const workerPid = parsedPid !== null && Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
  return { taskId, subagentAgentId, logFile, workerPid };
}

/**
 * Coerce a tool_return value to a plain string. The mobile host emits
 * tool_return either as a flat string or as a [{type:"text",text}, ...]
 * content-part array (lcp-d780); the local store carries content parts
 * under `content`/`parts`. Flatten any of those to text.
 */
function toReturnText(body: unknown): string {
  if (typeof body === "string") return body;
  if (Array.isArray(body)) {
    return body
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
        ? (p as { text: string }).text
        : ""))
      .join("");
  }
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    if (typeof rec["text"] === "string") return rec["text"] as string;
    if (typeof rec["func_response"] === "string") return rec["func_response"] as string;
  }
  return "";
}

// ──────────────────────────────────────────────────────────────────────
// Pub/sub
// ──────────────────────────────────────────────────────────────────────

/** Register a listener for subagent lifecycle events. Returns an unsubscribe. */
export function subscribeSubagentEvents(listener: Listener): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

// ──────────────────────────────────────────────────────────────────────
// Read API
// ──────────────────────────────────────────────────────────────────────

/** Snapshot every tracked subagent (any status), newest dispatch first. */
export function snapshotSubagents(): SubagentEntry[] {
  return [..._subagents.values()].map(clone).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Snapshot only currently-active (status === "running") subagents. */
export function listActiveSubagents(): SubagentEntry[] {
  return snapshotSubagents().filter((s) => s.status === "running");
}

/** Resolve a single entry by its parent Agent tool_call_id. */
export function getSubagent(toolCallId: string): SubagentEntry | null {
  const entry = _subagents.get(toolCallId);
  return entry ? clone(entry) : null;
}

// ──────────────────────────────────────────────────────────────────────
// Mutation: dispatch + return ingestion
// ──────────────────────────────────────────────────────────────────────

/**
 * Record a subagent dispatch from a parent `Agent` tool_call. Idempotent
 * by toolCallId — a re-observed dispatch (replay) updates the existing
 * entry's metadata without re-emitting `started`.
 */
export function recordSubagentDispatch(input: {
  toolCallId: string;
  parentRunId: string | null;
  args: unknown;
  source?: string;
}): SubagentEntry {
  const { toolCallId, parentRunId, args, source } = input;
  const parsed = parseAgentDispatchArgs(args);
  const existing = _subagents.get(toolCallId);
  if (existing) {
    // Backfill any newly-available metadata; do not resurrect terminal entries.
    existing.parentRunId ??= parentRunId;
    existing.description ??= parsed.description;
    existing.subagentType ??= parsed.subagentType;
    return clone(existing);
  }
  const entry: SubagentEntry = {
    toolCallId,
    taskId: null,
    description: parsed.description,
    subagentType: parsed.subagentType,
    runInBackground: parsed.runInBackground,
    source: source ?? "letta",
    status: "running",
    failureReason: null,
    parentRunId,
    subagentAgentId: null,
    todo_progress: null,
    subagentConversationId: null,
    logFile: null,
    workerPid: null,
    ownerShimPid: process.pid,
    ownerShimInstanceId: currentShimInstanceId,
    startedAt: nowIso(),
    endedAt: null,
  };
  _subagents.set(toolCallId, entry);
  emit("started", entry);
  // Arm the stream-timeout watchdog at dispatch time so even a dispatch
  // whose tool_return we never observe still terminates eventually.
  armTimeoutWatchdog(toolCallId);
  return clone(entry);
}

/**
 * Record a parent `Agent` tool_return correlated to a prior dispatch by
 * toolCallId. For a BACKGROUND dispatch this resolves the subagent's
 * agent id / task id / log file and starts watching the log for the
 * terminal marker. For a SYNCHRONOUS dispatch (no task header in the
 * body) it flips the entry to a terminal status directly.
 */
export function recordSubagentReturn(input: {
  toolCallId: string;
  body: unknown;
  isError?: boolean | null;
}): SubagentEntry | null {
  const { toolCallId, body, isError } = input;
  const entry = _subagents.get(toolCallId);
  if (!entry) return null;
  if (entry.status !== "running") return clone(entry);
  const parsed = parseAgentReturnBody(body);
  if (parsed.taskId || parsed.subagentAgentId) {
    // Background dispatch resolved: correlate to the subagent's run/conv.
    entry.taskId = parsed.taskId ?? entry.taskId;
    entry.subagentAgentId = parsed.subagentAgentId ?? entry.subagentAgentId;
    if (entry.subagentAgentId) entry.subagentConversationId = "default";
    entry.logFile = parsed.logFile ?? entry.logFile;
    entry.workerPid = parsed.workerPid ?? entry.workerPid ?? readLogWorkerPid(entry.logFile);
    entry.ownerShimPid = process.pid;
    const persistedOwnerShimInstanceId = readLogOwnerShimInstanceId(entry.logFile);
    entry.ownerShimInstanceId = persistedOwnerShimInstanceId ?? entry.ownerShimInstanceId ?? currentShimInstanceId;
    if (!persistedOwnerShimInstanceId) persistLogOwnerShimInstanceId(entry.logFile, entry.ownerShimInstanceId);
    const pendingTimeout = _timeoutTimers.get(toolCallId);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      _timeoutTimers.delete(toolCallId);
    }
    entry.runInBackground = true;
    refreshTodoProgress(toolCallId, false);
    emit("resolved", entry);
    if (entry.subagentAgentId) watchSubagentTodos(toolCallId);
    if (entry.logFile) watchBackgroundLog(toolCallId);
    return clone(entry);
  }
  // No background header → synchronous dispatch. The tool_return IS the
  // subagent's final result, so the subagent has already terminated.
  finalize(toolCallId, isError === true ? "failed" : "completed", isError === true ? "tool_error" : null);
  return getSubagent(toolCallId);
}

/**
 * Convenience ingestion entry point for the mobile host frame loop. Pass
 * each reshaped frame plus the owning parent run id; non-Agent frames are
 * ignored. Returns the affected entry (or null).
 */
export function ingestParentFrame(frame: unknown, parentRunId: string | null): SubagentEntry | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  const mt = f["message_type"];
  if (mt === "tool_call_message") {
    const tc = (f["tool_call"] ?? null) as Record<string, unknown> | null;
    if (!tc || tc["name"] !== "Agent") return null;
    const toolCallId = typeof tc["tool_call_id"] === "string" ? (tc["tool_call_id"] as string) : null;
    if (!toolCallId) return null;
    return recordSubagentDispatch({ toolCallId, parentRunId, args: tc["arguments"] });
  }
  if (mt === "tool_return_message") {
    if (f["name"] !== "Agent") return null;
    const toolCallId = typeof f["tool_call_id"] === "string" ? (f["tool_call_id"] as string) : null;
    if (!toolCallId) return null;
    return recordSubagentReturn({
      toolCallId,
      body: f["tool_return"],
      isError: f["is_err"] === true ? true : null,
    });
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Terminal detection
// ──────────────────────────────────────────────────────────────────────

/** Mark an entry terminal, clear its watchers/timers, and broadcast. */
function finalize(toolCallId: string, status: Exclude<SubagentStatus, "running">, reason: string | null): void {
  const entry = _subagents.get(toolCallId);
  if (!entry || entry.status !== "running") return;
  entry.status = status;
  entry.failureReason = reason;
  entry.endedAt = nowIso();
  clearWatchers(toolCallId);
  emit(status === "completed" ? "completed" : "failed", entry);
}

/**
 * Public terminal setters — used by the host when it learns of a terminal
 * state out-of-band (e.g. a `<task-notification>` in a later parent turn,
 * or an explicit failure). Idempotent on already-terminal entries.
 */
export function markSubagentCompleted(toolCallId: string): void {
  finalize(toolCallId, "completed", null);
}
export function markSubagentFailed(toolCallId: string, reason = "failed"): void {
  finalize(toolCallId, "failed", reason);
}

export function finalizeSubagent(
  toolCallId: string,
  status: Exclude<SubagentStatus, "running">,
  reason: string | null = null,
): SubagentEntry | null {
  finalize(toolCallId, status, status === "failed" ? reason ?? "failed" : null);
  return getSubagent(toolCallId);
}

export function updateSubagentTodoProgress(toolCallId: string, progress: TodoProgress | null): SubagentEntry | null {
  const entry = _subagents.get(toolCallId);
  if (!entry) return null;
  if (!sameTodoProgress(entry.todo_progress, progress)) {
    entry.todo_progress = progress;
    emit("todos_changed", entry);
  }
  return clone(entry);
}

const TASK_COMPLETED_MARKER = "[Task completed]";
// A background task log can close on a FAILURE footer too — e.g.
// `[Task failed]`, an `[error] ...` line, or a `subagent_status=error`
// result line. These are terminal just like `[Task completed]`; without
// recognizing them, a failed worker's log gets rehydrated as `running`
// on every shim boot and lingers forever (the orphan that survived ~22h).
const TASK_FAILED_MARKERS = ["[Task failed]", "subagent_status=error"];
const TODO_WATCH_DEBOUNCE_MS = 200;

export function computeTodoProgress(snapshotOrTodos: TodoSnapshot | TodoItem[]): TodoProgress {
  const todos = Array.isArray(snapshotOrTodos) ? snapshotOrTodos : snapshotOrTodos.todos;
  return {
    completed: todos.filter((todo) => todo.status === "completed").length,
    total: todos.length,
  };
}

function sameTodoProgress(a: TodoProgress | null, b: TodoProgress | null): boolean {
  return a?.completed === b?.completed && a?.total === b?.total;
}

function refreshTodoProgress(toolCallId: string, shouldEmit: boolean): boolean {
  const entry = _subagents.get(toolCallId);
  if (!entry || !entry.subagentAgentId) return false;
  const conversationId = entry.subagentConversationId ?? "default";
  invalidateMessagesCache(conversationId, entry.subagentAgentId);
  const snapshot = readSubagentTodos(entry.subagentAgentId, conversationId);
  const progress = snapshot.found ? computeTodoProgress(snapshot) : null;
  if (sameTodoProgress(entry.todo_progress, progress)) return false;
  entry.todo_progress = progress;
  if (shouldEmit) emit("todos_changed", entry);
  return true;
}

function scheduleTodoRefresh(toolCallId: string): void {
  const existing = _todoDebounceTimers.get(toolCallId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    _todoDebounceTimers.delete(toolCallId);
    refreshTodoProgress(toolCallId, true);
  }, TODO_WATCH_DEBOUNCE_MS);
  timer.unref?.();
  _todoDebounceTimers.set(toolCallId, timer);
}

function watchSubagentTodos(toolCallId: string): void {
  const entry = _subagents.get(toolCallId);
  if (!entry || !entry.subagentAgentId) return;
  if (_todoWatchers.has(toolCallId)) return;
  const conversationId = entry.subagentConversationId ?? "default";
  const path = messagesJsonlPath(conversationId, entry.subagentAgentId);
  const dir = dirname(path);
  const file = basename(path);
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = fsWatch(dir, (eventType, filename) => {
      if (_subagents.get(toolCallId)?.status !== "running") {
        clearWatchers(toolCallId);
        return;
      }
      if (eventType !== "rename" && eventType !== "change") return;
      if (filename && filename.toString() !== file) return;
      scheduleTodoRefresh(toolCallId);
    });
    _todoWatchers.set(toolCallId, watcher);
  } catch {
    // The conversation directory may not exist before the subagent's first write.
  }
}

/**
 * Watch a background task's log file for the terminal `[Task completed]`
 * marker. fs.watch can fire multiple times per append; we re-read + scan
 * on each change (logs are small). If the marker is already present at
 * attach time we finalize immediately.
 */
function logHasCompletedMarker(logFile: string): boolean {
  return readLogTerminalStatus(logFile) === "completed";
}

/**
 * Read a background task log and classify its terminal state from the
 * footer markers. Returns "completed" for a `[Task completed]` footer,
 * "failed" for any failure footer (`[Task failed]`, `subagent_status=error`,
 * or an `[error] ...` line), or null while still running / unreadable.
 * Completion wins if both markers somehow appear.
 */
function readLogWorkerPid(logFile: string | null): number | null {
  if (!logFile) return null;
  try {
    if (!existsSync(logFile)) return null;
    const text = readFileSync(logFile, "utf8");
    const pidText = text.match(/(?:Worker PID|PID):\s*(\d+)/i)?.[1] ?? null;
    const parsedPid = pidText ? Number(pidText) : null;
    return parsedPid !== null && Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
  } catch {
    return null;
  }
}

function ownerSidecarPath(logFile: string | null): string | null {
  return logFile ? `${logFile}.shim-owner.json` : null;
}

function readLogOwnerShimInstanceId(logFile: string | null): string | null {
  const sidecar = ownerSidecarPath(logFile);
  if (!sidecar) return null;
  try {
    if (!existsSync(sidecar)) return null;
    const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const owner = (parsed as Record<string, unknown>)["owner_shim_instance_id"];
    return typeof owner === "string" && owner.trim() ? owner.trim() : null;
  } catch {
    return null;
  }
}

function persistLogOwnerShimInstanceId(logFile: string | null, ownerShimInstanceId: string | null): void {
  if (!logFile || !ownerShimInstanceId) return;
  const sidecar = ownerSidecarPath(logFile);
  if (!sidecar) return;
  try {
    mkdirSync(dirname(sidecar), { recursive: true });
    writeFileSync(sidecar, JSON.stringify({ owner_shim_instance_id: ownerShimInstanceId }) + "\n");
  } catch {
    // Best-effort: legacy unstamped entries fall back to PID/footer checks.
  }
}

type ProcessAliveChecker = (pid: number) => boolean;
let processAliveChecker: ProcessAliveChecker = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

function isWorkerProcessAlive(entry: SubagentEntry): boolean | null {
  entry.workerPid ??= readLogWorkerPid(entry.logFile);
  if (!entry.workerPid) return null;
  return processAliveChecker(entry.workerPid);
}

function readLogTerminalStatus(logFile: string): "completed" | "failed" | null {
  try {
    if (!existsSync(logFile)) return null;
    const text = readFileSync(logFile, "utf8");
    if (text.includes(TASK_COMPLETED_MARKER)) return "completed";
    if (TASK_FAILED_MARKERS.some((m) => text.includes(m))) return "failed";
    return null;
  } catch {
    return null;
  }
}

function watchBackgroundLog(toolCallId: string): void {
  const entry = _subagents.get(toolCallId);
  if (!entry || !entry.logFile) return;
  if (_logWatchers.has(toolCallId)) return;
  const logFile = entry.logFile;

  const scan = (): void => {
    const terminal = readLogTerminalStatus(logFile);
    if (terminal === "completed") {
      finalize(toolCallId, "completed", null);
    } else if (terminal === "failed") {
      finalize(toolCallId, "failed", "subagent_error");
    }
  };

  // Immediate scan (handles an already-finished task).
  scan();
  if (_subagents.get(toolCallId)?.status !== "running") return;

  try {
    const watcher = fsWatch(logFile, () => {
      if (_subagents.get(toolCallId)?.status !== "running") {
        clearWatchers(toolCallId);
        return;
      }
      scan();
    });
    _logWatchers.set(toolCallId, watcher);
  } catch {
    // fs.watch can fail if the file vanished between the existsSync and
    // the watch; liveness sweep still checks terminal footers and worker PID.
  }
}

/** Arm (idempotently) the stream-timeout watchdog for an entry. */
function armTimeoutWatchdog(toolCallId: string): void {
  if (_timeoutTimers.has(toolCallId)) return;
  const timer = setTimeout(() => {
    _timeoutTimers.delete(toolCallId);
    finalize(toolCallId, "failed", "stream_timeout");
  }, SUBAGENT_TIMEOUT_MS);
  timer.unref?.();
  _timeoutTimers.set(toolCallId, timer);
}

function evaluateRunningSubagent(toolCallId: string): void {
  const entry = _subagents.get(toolCallId);
  if (!entry || entry.status !== "running") return;
  if (entry.logFile) {
    const terminal = readLogTerminalStatus(entry.logFile);
    if (terminal === "completed") {
      finalize(toolCallId, "completed", null);
      return;
    }
    if (terminal === "failed") {
      finalize(toolCallId, "failed", "subagent_error");
      return;
    }
  }
  const alive = isWorkerProcessAlive(entry);
  if (alive === false) {
    finalize(toolCallId, "failed", "worker_process_dead");
    return;
  }
  if (entry.subagentAgentId) watchSubagentTodos(toolCallId);
  if (entry.logFile) watchBackgroundLog(toolCallId);
  if (!entry.logFile) armTimeoutWatchdog(toolCallId);
}

export function rehydrateRunningSubagentWatchdogs(): void {
  for (const entry of _subagents.values()) {
    if (entry.status !== "running") continue;
    // Boot replay re-ingests historical Agent frames and stamps startedAt as
    // now. If the background log is already gone (or already terminal), do NOT
    // arm a fresh watchdog/grace window and resurrect phantom workers in the
    // app/reminder bar. The log path from the Agent tool_return is canonical.
    if (!entry.logFile) {
      finalize(entry.toolCallId, "failed", "orphaned");
      continue;
    }
    if (!existsSync(entry.logFile)) {
      finalize(entry.toolCallId, "failed", "orphaned");
      continue;
    }
    const terminal = readLogTerminalStatus(entry.logFile);
    if (terminal === "completed") {
      finalize(entry.toolCallId, "completed", null);
      continue;
    }
    if (terminal === "failed") {
      finalize(entry.toolCallId, "failed", "subagent_error");
      continue;
    }
    // Process-liveness, NOT silence: only finalize when the worker PID is
    // CONFIRMED dead. PID-unknown (alive === null) must NOT be treated as dead
    // — a subagent can legitimately be quiet for a long time, and external
    // (non-worker) entries have no PID at all. Unknown-PID entries fall through
    // to the normal watch/footer/no-logfile-timeout path; a confirmed-dead PID
    // is the only positive death signal at rehydrate.
    const alive = isWorkerProcessAlive(entry);
    if (alive === false) {
      finalize(entry.toolCallId, "failed", "worker_process_dead");
      continue;
    }
    entry.ownerShimInstanceId ??= readLogOwnerShimInstanceId(entry.logFile);
    if (alive !== true && currentShimInstanceId && entry.ownerShimInstanceId && entry.ownerShimInstanceId !== currentShimInstanceId) {
      finalize(entry.toolCallId, "failed", "prior_instance_dead");
      continue;
    }
    evaluateRunningSubagent(entry.toolCallId);
  }
  sweepOrphanedSubagents();
  startSubagentLivenessSweep();
}

export function sweepOrphanedSubagents(nowMs = Date.now()): number {
  let swept = 0;
  for (const entry of _subagents.values()) {
    if (entry.status !== "running") continue;
    if (!entry.logFile) {
      const startedMs = Date.parse(entry.startedAt);
      if (Number.isFinite(startedMs) && nowMs - startedMs > SUBAGENT_NO_LOGFILE_TIMEOUT_MS) {
        finalize(entry.toolCallId, "failed", "orphaned");
        swept += 1;
      }
      continue;
    }
    const terminal = readLogTerminalStatus(entry.logFile);
    if (terminal === "completed") {
      finalize(entry.toolCallId, "completed", null);
      swept += 1;
      continue;
    }
    if (terminal === "failed") {
      finalize(entry.toolCallId, "failed", "subagent_error");
      swept += 1;
      continue;
    }
    const alive = isWorkerProcessAlive(entry);
    if (alive === false) {
      finalize(entry.toolCallId, "failed", "worker_process_dead");
      swept += 1;
      continue;
    }
    if (alive === true) continue;
    // letta-mobile-73o2h.4: the PID is unknown (the log was started before
    // the worker stamped its pid, or the worker exited without writing
    // one). Without a positive liveness signal we cannot prove the entry
    // is alive — silence is not life. Finalize as orphaned once the log
    // is stale past SUBAGENT_NO_LOGFILE_TIMEOUT_MS so the mobile chat bar
    // never surfaces a stranded "running" chip.
    if (!existsSync(entry.logFile)) {
      const startedMs = Date.parse(entry.startedAt);
      if (Number.isFinite(startedMs) && nowMs - startedMs > SUBAGENT_NO_LOGFILE_TIMEOUT_MS) {
        finalize(entry.toolCallId, "failed", "orphaned");
        swept += 1;
      }
      continue;
    }
    const startedMs = Date.parse(entry.startedAt);
    if (Number.isFinite(startedMs) && nowMs - startedMs > SUBAGENT_NO_LOGFILE_TIMEOUT_MS) {
      finalize(entry.toolCallId, "failed", "orphaned");
      swept += 1;
    }
  }
  return swept;
}

export function startSubagentLivenessSweep(): void {
  if (_livenessSweepTimer) return;
  _livenessSweepTimer = setInterval(() => {
    sweepOrphanedSubagents();
  }, SUBAGENT_LIVENESS_SWEEP_MS);
  _livenessSweepTimer.unref?.();
}

export function stopSubagentLivenessSweep(): void {
  if (!_livenessSweepTimer) return;
  clearInterval(_livenessSweepTimer);
  _livenessSweepTimer = null;
}

function clearWatchers(toolCallId: string): void {
  const watcher = _logWatchers.get(toolCallId);
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* best-effort */
    }
    _logWatchers.delete(toolCallId);
  }
  const todoWatcher = _todoWatchers.get(toolCallId);
  if (todoWatcher) {
    try {
      todoWatcher.close();
    } catch {
      /* best-effort */
    }
    _todoWatchers.delete(toolCallId);
  }
  const todoTimer = _todoDebounceTimers.get(toolCallId);
  if (todoTimer) {
    clearTimeout(todoTimer);
    _todoDebounceTimers.delete(toolCallId);
  }
  const timer = _timeoutTimers.get(toolCallId);
  if (timer) {
    clearTimeout(timer);
    _timeoutTimers.delete(toolCallId);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────────

/** Test-only: drop every entry, listener, watcher, and timer. */
export function __resetSubagentRegistry(): void {
  stopSubagentLivenessSweep();
  for (const toolCallId of [..._subagents.keys()]) clearWatchers(toolCallId);
  for (const toolCallId of [..._todoWatchers.keys()]) clearWatchers(toolCallId);
  for (const toolCallId of [..._todoDebounceTimers.keys()]) clearWatchers(toolCallId);
  _subagents.clear();
  _listeners.clear();
  __setSubagentProcessAliveCheckerForTest(null);
}

export function __setSubagentProcessAliveCheckerForTest(checker: ProcessAliveChecker | null): void {
  processAliveChecker = checker ?? ((pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  });
}

export function __getSubagentWatcherCounts(): { logs: number; todos: number; todoDebounces: number; timeouts: number; livenessSweep: number } {
  return {
    logs: _logWatchers.size,
    todos: _todoWatchers.size,
    todoDebounces: _todoDebounceTimers.size,
    timeouts: _timeoutTimers.size,
    livenessSweep: _livenessSweepTimer ? 1 : 0,
  };
}
