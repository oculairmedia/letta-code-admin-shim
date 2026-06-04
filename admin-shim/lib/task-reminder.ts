/**
 * Background-task completion reminder (lcp-gukg / OpenCode-style recurring poll).
 *
 * ── Problem ──────────────────────────────────────────────────────────────
 *
 * When a parent agent dispatches a background `Agent`/`Task` subagent, the
 * subagent's terminal status is delivered to the PARENT conversation as a
 * SINGLE injected `<task-notification>` message (see letta.js
 * `spawnBackgroundSubagentTask` → `addToMessageQueue({ kind:"task_notification",
 * ... })`). If that one push is missed — e.g. the documented background task
 * ID / log-path collision across reconnects, a dropped queue pump, or a
 * runtime swap between dispatch and completion — the parent NEVER learns the
 * task ended. The parent turn then sits "thinking" forever, waiting on a
 * completion that already happened.
 *
 * OpenCode solves the same class of bug with a recurring reminder that
 * re-checks in-flight tasks and re-surfaces their terminal status. This module
 * is the pure, side-effect-free core of that reminder: given the live set of
 * active background subagents plus each one's `/tmp/letta-background/task_N.log`,
 * it decides which terminal notifications still need to be (re-)delivered.
 *
 * The bundle-side glue (admin-shim/scripts/letta-code-patch-loader.mjs) wires
 * the live letta.js functions (`getActiveBackgroundAgents`, `backgroundTasks`,
 * `addToMessageQueue`, `formatTaskNotification`, …) into a recurring timer that
 * calls into logic identical to {@link scanForTerminalTasks}. This TS copy
 * exists so the decision logic is unit-testable in isolation; the injected
 * helper mirrors it line-for-line.
 *
 * ── Authority ────────────────────────────────────────────────────────────
 *
 * The background task log is authoritative even when the in-memory push was
 * lost: `spawnBackgroundSubagentTask` writes `[Task completed]` / `[Task failed]`
 * footers to the log via `writeTaskTranscriptResult` BEFORE it enqueues the
 * notification, so a log footer is a strictly-stronger terminal signal than the
 * notification that may or may not have arrived.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 *
 * The reminder must never deliver the same terminal notification twice. The
 * caller threads a `delivered` set of task ids; {@link scanForTerminalTasks}
 * skips any task already present. The caller adds the task id to that set the
 * moment it delivers (and is also expected to clear the subagent from the
 * active set so the next tick sees nothing to do).
 */

/** Terminal footer markers written by letta.js `writeTaskTranscriptResult`. */
export const TASK_COMPLETED_MARKER = "[Task completed]";
export const TASK_FAILED_MARKER = "[Task failed]";

export type TerminalStatus = "completed" | "failed";

/**
 * Minimal shape of a letta.js subagent-state entry, as returned by
 * `getActiveBackgroundAgents()` — silent background subagents whose status is
 * still `pending` | `running` from the parent's point of view.
 */
export interface ActiveBackgroundAgent {
  /** Subagent id (e.g. "subagent-1700000000000-3"). */
  id: string;
  /** Human description from the dispatch args. */
  description?: string;
  /** Display type (e.g. "General-purpose"). */
  type?: string;
  /** running | pending | completed | error. */
  status?: string;
}

/**
 * Minimal shape of a letta.js background-task entry (the `backgroundTasks`
 * Map value built in `spawnBackgroundSubagentTask`). Correlated to an
 * {@link ActiveBackgroundAgent} by `subagentId`.
 */
export interface BackgroundTaskEntry {
  /** The subagent id this task drives — correlation key. */
  subagentId: string;
  /** running | completed | failed (bgTask.status). */
  status?: string;
  /** Absolute path to /tmp/letta-background/task_N.log. */
  outputFile?: string;
  /** Subagent type (e.g. "general-purpose"). */
  subagentType?: string;
  /** Description echoed from the dispatch. */
  description?: string;
}

/** A terminal task the reminder has decided still needs (re-)delivery. */
export interface PendingTerminalTask {
  /** The background task id (e.g. "task_3") — the notification's task-id. */
  taskId: string;
  /** Correlated subagent id, so the caller can clear it from the active set. */
  subagentId: string;
  /** Terminal status derived from the log footer (authoritative). */
  status: TerminalStatus;
  /** Description for the synthesized summary. */
  description: string;
  /** Subagent type for the synthesized header. */
  subagentType: string;
  /** Output file path, surfaced in the notification's transcript line. */
  outputFile: string;
}

/**
 * Classify a task log's terminal state from its raw text. `[Task failed]`
 * wins over `[Task completed]` if (pathologically) both are present, since a
 * failure footer is only written on the error path. Returns null while the
 * task is still genuinely in flight (no terminal footer yet).
 */
export function classifyTaskLog(logText: string): TerminalStatus | null {
  if (logText.includes(TASK_FAILED_MARKER)) return "failed";
  if (logText.includes(TASK_COMPLETED_MARKER)) return "completed";
  return null;
}

export interface ScanInput {
  /** Live active (silent, pending|running) background subagents. */
  activeAgents: ActiveBackgroundAgent[];
  /** Live background task entries (taskId → entry). */
  backgroundTasks: Map<string, BackgroundTaskEntry>;
  /** Task ids whose terminal notification was already delivered this session. */
  delivered: Set<string>;
  /**
   * Reads a task log file, returning its text (or null if unreadable/missing).
   * Injected so the core stays pure and unit-testable without fs.
   */
  readLog: (outputFile: string) => string | null;
}

/**
 * Decide which terminal notifications still need (re-)delivery.
 *
 * For every subagent that the PARENT still believes is active, we look up its
 * background task entry and read the authoritative log footer. If the log says
 * the task is terminal but the parent's active set still lists it (and we have
 * not already delivered for that task id), it is returned for delivery.
 *
 * Pure: performs no I/O beyond the injected `readLog`, mutates nothing.
 */
export function scanForTerminalTasks(input: ScanInput): PendingTerminalTask[] {
  const { activeAgents, backgroundTasks, delivered, readLog } = input;
  if (activeAgents.length === 0) return [];

  // Index background tasks by subagentId once (subagentId → [taskId, entry]).
  const bySubagent = new Map<string, { taskId: string; entry: BackgroundTaskEntry }>();
  for (const [taskId, entry] of backgroundTasks) {
    if (entry && typeof entry.subagentId === "string") {
      bySubagent.set(entry.subagentId, { taskId, entry });
    }
  }

  const pending: PendingTerminalTask[] = [];
  const seenTaskIds = new Set<string>();

  for (const agent of activeAgents) {
    const match = bySubagent.get(agent.id);
    if (!match) continue;
    const { taskId, entry } = match;
    // Idempotent: never deliver the same task twice (already delivered, or a
    // duplicate active entry pointing at the same task in one scan).
    if (delivered.has(taskId) || seenTaskIds.has(taskId)) continue;
    if (!entry.outputFile) continue;

    const logText = readLog(entry.outputFile);
    if (logText == null) continue;
    const status = classifyTaskLog(logText);
    if (status == null) continue; // still genuinely running

    seenTaskIds.add(taskId);
    pending.push({
      taskId,
      subagentId: agent.id,
      status,
      description: entry.description ?? agent.description ?? "background task",
      subagentType: entry.subagentType ?? "general-purpose",
      outputFile: entry.outputFile,
    });
  }

  return pending;
}

/**
 * Build the human summary line for a synthesized terminal notification. Mirrors
 * the `defaultSummary` letta.js produces in `spawnBackgroundSubagentTask`.
 */
export function synthesizeSummary(task: PendingTerminalTask): string {
  return `Agent "${task.description}" ${task.status === "completed" ? "completed" : "failed"} (recovered)`;
}
