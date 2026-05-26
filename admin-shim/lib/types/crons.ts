/**
 * Types for the shim's `crons.ts` store.
 *
 * The on-disk shape must match letta-code's bundled cron file verbatim so the
 * bundled self-schedule skill and the shim's scheduler share the same file.
 * Reference: /root/.bun/install/global/node_modules/@letta-ai/letta-code/letta.js
 *   — `function readCronFile`, `function addTask`, `function captureProcessIdentity`.
 */

/**
 * Task lifecycle status. Matches the bundled letta-code's vocabulary so
 * `letta cron list` and our `/v1/crons` show identical statuses for the
 * same row.
 *   - active: scheduled and waiting to fire (recurring or pending one-shot).
 *   - fired: a one-shot completed its single fire (analogous to "completed").
 *   - missed: a one-shot's scheduled_for was >SHIM_CRON_MISSED_THRESHOLD_MS
 *     in the past when first observed; never fired.
 *   - cancelled: user-initiated termination via cron_delete-equivalent paths
 *     where the row is kept rather than removed; cancel_reason carries detail.
 *   - completed: reserved for future "recurring task hit its expires_at" path
 *     (not currently produced by the scheduler).
 */
export type CronTaskStatus = "active" | "fired" | "missed" | "cancelled" | "completed";

export interface CronTask {
  id: string;
  agent_id: string;
  conversation_id: string;
  name: string;
  description: string;
  cron: string;
  timezone: string;
  recurring: boolean;
  prompt: string;
  status: CronTaskStatus;
  created_at: string;
  expires_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
  cancel_reason: string | null;
  jitter_offset_ms: number;
  scheduled_for: string | null;
  fired_at: string | null;
  missed_at: string | null;
}

export interface LockOwner {
  pid: number;
  token: string;
  acquired_at: number;
  process_start_ticks: string | null;
  boot_id: string | null;
}

export interface SchedulerOwner {
  pid: number;
  token: string;
  started_at: string;
  process_start_ticks: string | null;
  boot_id: string | null;
}

export interface CronFile {
  version: 1;
  scheduler_owner: SchedulerOwner | null;
  /**
   * Last successful scheduler tick wall-clock time. Written in the same
   * transaction as the lease claim and as each task-fire row update, so it
   * costs no extra fsync per tick. Used at scheduler startup to compute a
   * catch-up window for tasks whose cron-match passed while the shim was
   * down (lcp-915 / lcp-p74.4). `null` for crons.json files written
   * before this field was introduced; readers must treat undefined the
   * same as null for back-compat.
   */
  last_tick_at: string | null;
  tasks: CronTask[];
}

export interface AddTaskInput {
  agent_id: string;
  conversation_id?: string;
  name: string;
  description: string;
  cron: string;
  timezone?: string;
  recurring: boolean;
  prompt: string;
  scheduled_for?: Date;
}

export interface AddTaskResult {
  task: CronTask;
  warning?: string;
}

export interface ListTaskFilters {
  agent_id?: string;
  conversation_id?: string;
}

export interface ParseEveryResult {
  cron: string;
  note?: string;
}

export interface ParseAtResult {
  scheduledFor: Date;
  cron: string;
  note?: string;
}
