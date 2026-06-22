/**
 * Shim-side cron scheduler (lcp-0mw / lcp-d5g.3).
 *
 * Holds the scheduler lease in `crons.json`, ticks every 60s, and routes
 * due tasks through the supplied fire callback so they look identical to
 * a normal mobile turn (run record, frames.jsonl, conversation history,
 * usage tracking — all reused).
 *
 * Why this lives in the shim (and not in the bundled letta-code worker):
 *   - the shim is always-on under systemd; letta-code workers are spawned
 *     per agent and evicted after 5min idle (SHIM_POOL_IDLE_SEC),
 *   - only one process should hold the lease — the shim is the natural
 *     owner because it outlives any worker.
 *
 * Compatibility:
 *   - shares `crons.json` with the bundled `letta cron` CLI, so an agent
 *     calling its own self-schedule skill is picked up here on the next
 *     mtime change (within 1s),
 *   - lease, lock, and on-disk task shape come from `crons.ts` and match
 *     the bundled letta-code byte-for-byte.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";

import { dirname, basename } from "node:path";
import {
  broadcastCronEvent,
  type CronEvent,
} from "./cron-events.js";
import {
  claimSchedulerLease,
  cronMatchesTime,
  garbageCollect,
  getActiveTasks,
  getCronFileMtime,
  getCronFilePath,
  getTask,
  missedThresholdMs,
  releaseSchedulerLease,
  updateTaskAndTickTime,
  verifySchedulerLease,
} from "./crons.js";
import type { CronTask } from "./types/crons.js";

// ──────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────

/**
 * Fire callback. Receives the task that's due and is responsible for
 * actually injecting the wrapped prompt into the agent pool (or whatever
 * the test wants). Errors are caught and logged by the scheduler.
 */
export type FireTaskFn = (task: CronTask, wrappedPrompt: string) => Promise<void> | void;

export interface CronSchedulerOptions {
  /**
   * How to fire a due task. Default (when nothing is supplied) is a
   * no-op that only logs — server.ts injects the real bridgeSendMessage
   * caller at boot.
   */
  fireTask?: FireTaskFn;
  /** Override Date.now() — test seam. */
  now?: () => Date;
  /** Override tick interval. Default 60_000ms. */
  tickIntervalMs?: number;
  /** Override GC interval. Default 60min. */
  gcIntervalMs?: number;
  /**
   * Disable the fs.watch on crons.json. Default false. Useful in unit
   * tests that want deterministic refreshes via a hand-driven tick.
   */
  disableMtimeWatcher?: boolean;
  /** Per-line logger. Defaults to console.log. */
  log?: (msg: string) => void;
}

export interface SchedulerStatus {
  lease_held: boolean;
  owner_pid: number | null;
  token: string | null;
  started_at: string | null;
  tasks_active: number;
  last_tick_at: string | null;
  next_tick_at: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_GC_INTERVAL_MS = 60 * 60_000;
/** Throttle for fs.watch event coalescing — many editors fire watch twice. */
const MTIME_REFRESH_DEBOUNCE_MS = 200;

/**
 * Maximum age (ms) of last_tick_at the scheduler will consider for catch-up
 * on start (lcp-915). Tasks whose missed fire-time is older than this are
 * silently skipped — we'd rather drop a stale prompt than mass-fire after a
 * long outage. Override via SHIM_CRON_CATCHUP_WINDOW_MS.
 */
function catchUpCapMs(): number {
  const raw = process.env["SHIM_CRON_CATCHUP_WINDOW_MS"];
  if (!raw) return 60 * 60_000; // 1 hour
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 60 * 60_000;
}

// ──────────────────────────────────────────────────────────────────────
// Internal state
// ──────────────────────────────────────────────────────────────────────

interface SchedulerState {
  token: string;
  startedAt: string;
  tickInterval: ReturnType<typeof setInterval>;
  gcInterval: ReturnType<typeof setInterval>;
  watcher: FSWatcher | null;
  watcherDebounce: ReturnType<typeof setTimeout> | null;
  pendingTimers: Set<ReturnType<typeof setTimeout>>;
  lastMtime: number;
  cachedTasks: CronTask[];
  firedThisMinute: Set<string>;
  lastMinuteKey: string;
  lastTickAt: Date | null;
  nextTickAt: Date | null;
  options: Required<Omit<CronSchedulerOptions, "fireTask" | "log" | "disableMtimeWatcher">> & {
    fireTask: FireTaskFn;
    log: (msg: string) => void;
    disableMtimeWatcher: boolean;
  };
}

let state: SchedulerState | null = null;

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function wrapCronPrompt(task: CronTask): string {
  const lines = [
    "<system-reminder>",
    `Scheduled task "${task.name}" is firing.`,
    `Description: ${task.description}`,
    task.recurring
      ? `This is fire #${task.fire_count + 1} (cron: ${task.cron}).`
      : `This is a one-off scheduled task.`,
    "",
    task.prompt,
    "</system-reminder>",
  ];
  return lines.join("\n");
}

function shouldFireTask(task: CronTask, now: Date): boolean {
  if (!task.recurring && task.scheduled_for) {
    const scheduledMs = new Date(task.scheduled_for).getTime() + task.jitter_offset_ms;
    return scheduledMs <= now.getTime();
  }
  return cronMatchesTime(task.cron, now, task.timezone);
}

function handleMissedOneShot(task: CronTask, now: Date): boolean {
  if (task.recurring || !task.scheduled_for) return false;
  const scheduledMs = new Date(task.scheduled_for).getTime();
  if (now.getTime() > scheduledMs + missedThresholdMs() && task.status === "active") {
    // Combined write — last_tick_at piggybacks on the row update.
    updateTaskAndTickTime(task.id, (t) => {
      t.status = "missed";
      t.missed_at = now.toISOString();
    }, now);
    return true;
  }
  return false;
}

function refreshTaskCache(s: SchedulerState): boolean {
  const mtime = getCronFileMtime();
  if (mtime !== s.lastMtime) {
    s.cachedTasks = getActiveTasks();
    s.lastMtime = mtime;
    return true;
  }
  return false;
}

function emitEvent(reason: CronEvent["reason"], at: Date, s: SchedulerState): void {
  const event: CronEvent = {
    reason,
    tasks_active: s.cachedTasks.length,
    at: at.toISOString(),
  };
  broadcastCronEvent(event);
}

async function fireWithErrorTrap(s: SchedulerState, task: CronTask): Promise<void> {
  const wrapped = wrapCronPrompt(task);
  try {
    await s.options.fireTask(task, wrapped);
  } catch (err) {
    s.options.log(`[cron-scheduler] fire error for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function tick(s: SchedulerState): Promise<void> {
  if (!verifySchedulerLease(s.token)) {
    s.options.log("[cron-scheduler] lease lost; stopping");
    stopCronScheduler();
    return;
  }

  const now = s.options.now();
  s.lastTickAt = now;
  s.nextTickAt = new Date(now.getTime() + s.options.tickIntervalMs);

  const currentMinute = minuteKey(now);
  if (currentMinute !== s.lastMinuteKey) {
    s.firedThisMinute.clear();
    s.lastMinuteKey = currentMinute;
  }

  const cacheRefreshed = refreshTaskCache(s);
  let firedSomething = false;

  for (const task of s.cachedTasks) {
    if (task.status !== "active") continue;
    if (handleMissedOneShot(task, now)) {
      firedSomething = true;
      continue;
    }
    if (s.firedThisMinute.has(task.id)) continue;
    if (!shouldFireTask(task, now)) continue;

    s.firedThisMinute.add(task.id);
    const jitterMs = task.recurring ? task.jitter_offset_ms : 0;
    const doFire = async (): Promise<void> => {
      if (!state) return; // stopped while jitter was waiting
      // Re-read in case the row was deleted/cancelled between match and fire.
      const fresh = getTask(task.id);
      if (!fresh || fresh.status !== "active") return;
      await fireWithErrorTrap(s, fresh);
      const fireMoment = s.options.now();
      const nowIso = fireMoment.toISOString();
      if (fresh.recurring) {
        // lcp-915: combined write so last_tick_at is stamped without an
        // extra fsync — the row update was happening anyway.
        updateTaskAndTickTime(fresh.id, (t) => {
          t.last_fired_at = nowIso;
          t.fire_count += 1;
        }, fireMoment);
      } else {
        // One-shot: terminal state is "fired" (matches bundled letta-code,
        // not the looser "completed" we used earlier — letta cron list and
        // mobile UI both expect the bundle's vocabulary).
        updateTaskAndTickTime(fresh.id, (t) => {
          t.status = "fired";
          t.fired_at = nowIso;
          t.last_fired_at = nowIso;
          t.fire_count = 1;
        }, fireMoment);
      }
      firedSomething = true;
      // Refresh cache so subsequent ticks see the updated row.
      s.lastMtime = 0;
      emitEvent("scheduler_write", s.options.now(), s);
    };

    if (jitterMs > 0) {
      const handle = setTimeout(() => {
        s.pendingTimers.delete(handle);
        void doFire();
      }, jitterMs);
      s.pendingTimers.add(handle);
    } else {
      await doFire();
    }
  }

  if (cacheRefreshed && !firedSomething) {
    emitEvent("external_write", now, s);
  }
}

/**
 * Catch-up pass (lcp-915). Runs once at scheduler start, BEFORE the first
 * regular tick, to fire tasks whose cron-match passed while the shim was
 * down.
 *
 * Scope:
 *   - Window = (max(previousTickAt, now - cap), startOfMinute(now)).
 *     Open on both sides: previous tick is exclusive (we may already have
 *     fired for that minute), and the current minute is left to the
 *     regular tick to avoid double-fire.
 *   - Recurring task: find the *latest* cron-match minute in the window.
 *     Fire once iff `task.last_fired_at` is before that minute.
 *   - One-shot with `scheduled_for` in the window: fire iff still active.
 *     The standard `missedThresholdMs` is *not* applied here — we know
 *     why the shim was down (the catch-up window itself), so it's right
 *     to fire rather than mark missed.
 *
 * Returns the set of task ids fired during catch-up so the caller can
 * pre-populate `firedThisMinute` if the catch-up fires happen to share
 * `now`'s minute.
 */
async function runCatchUp(
  s: SchedulerState,
  previousTickAt: string | null,
  now: Date,
): Promise<Set<string>> {
  const fired = new Set<string>();
  if (!previousTickAt) return fired; // fresh install — nothing to catch up
  const prevMs = Date.parse(previousTickAt);
  if (!Number.isFinite(prevMs)) return fired;
  const cap = catchUpCapMs();
  const windowStartMs = Math.max(prevMs, now.getTime() - cap);
  // Current minute is exclusive — regular tick handles it.
  const currentMinuteStartMs = new Date(now).setSeconds(0, 0);
  if (windowStartMs >= currentMinuteStartMs) return fired;

  const tasks = getActiveTasks();
  for (const task of tasks) {
    if (task.status !== "active") continue;

    if (!task.recurring && task.scheduled_for) {
      const schedMs = Date.parse(task.scheduled_for);
      if (
        Number.isFinite(schedMs) &&
        schedMs >= windowStartMs &&
        schedMs < currentMinuteStartMs
      ) {
        await fireWithErrorTrap(s, task);
        const nowIso = s.options.now().toISOString();
        updateTaskAndTickTime(task.id, (t) => {
          t.status = "fired";
          t.fired_at = nowIso;
          t.last_fired_at = nowIso;
          t.fire_count = 1;
        }, s.options.now());
        fired.add(task.id);
        s.options.log(`[cron-scheduler] catch-up fired one-shot task ${task.id}`);
      }
      continue;
    }

    if (task.recurring) {
      // Find the LATEST cron-match minute strictly before the current
      // minute and at or after the window start.
      let latestMatchMs: number | null = null;
      for (
        let m = currentMinuteStartMs - 60_000;
        m >= windowStartMs;
        m -= 60_000
      ) {
        const candidate = new Date(m);
        if (cronMatchesTime(task.cron, candidate, task.timezone)) {
          latestMatchMs = m;
          break;
        }
      }
      if (latestMatchMs === null) continue;

      const lastFiredMs = task.last_fired_at ? Date.parse(task.last_fired_at) : null;
      if (lastFiredMs !== null && Number.isFinite(lastFiredMs) && lastFiredMs >= latestMatchMs) {
        continue; // already fired for the missed minute (or later)
      }

      await fireWithErrorTrap(s, task);
      const fireMoment = s.options.now();
      const nowIso = fireMoment.toISOString();
      updateTaskAndTickTime(task.id, (t) => {
        t.last_fired_at = nowIso;
        t.fire_count += 1;
      }, fireMoment);
      fired.add(task.id);
      s.options.log(`[cron-scheduler] catch-up fired recurring task ${task.id} for ${new Date(latestMatchMs).toISOString()}`);
    }
  }

  if (fired.size > 0) {
    // Force-refresh the in-process cache so the next tick sees the
    // updated rows.
    s.lastMtime = 0;
    emitEvent("scheduler_write", now, s);
  }
  return fired;
}

function setupMtimeWatcher(s: SchedulerState): void {
  if (s.options.disableMtimeWatcher) return;
  const path = getCronFilePath();
  if (!existsSync(path)) return; // first fs.watch fires when file appears; tick re-checks anyway
  try {
    const watcher = watch(dirname(path), (event, filename) => {
      if (filename && filename !== basename(path)) return;
      if (s.watcherDebounce) clearTimeout(s.watcherDebounce);
      s.watcherDebounce = setTimeout(() => {
        s.watcherDebounce = null;
        if (!state) return;
        s.lastMtime = 0; // Force refresh due to sub-ms precision
        const refreshed = refreshTaskCache(s);
        if (refreshed) {
          emitEvent("external_write", s.options.now(), s);
        }
      }, MTIME_REFRESH_DEBOUNCE_MS);
    });
    watcher.on("error", (err) => {
      s.options.log(`[cron-scheduler] watcher error: ${err.message}`);
    });
    s.watcher = watcher;
  } catch (err) {
    s.options.log(`[cron-scheduler] watch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

export interface SchedulerHandle {
  token: string;
  startedAt: string;
  /**
   * Resolves once catch-up (lcp-915) and the first regular tick have
   * settled. Tests await this for deterministic ordering; production
   * code may ignore it (the scheduler is fully self-contained).
   */
  whenReady: Promise<void>;
}

/**
 * Claim the scheduler lease and begin ticking. Returns null when another
 * live process already holds the lease (this is not an error — another
 * shim instance owns scheduling).
 */
export function startCronScheduler(opts: CronSchedulerOptions = {}): SchedulerHandle | null {
  if (state) {
    return { token: state.token, startedAt: state.startedAt, whenReady: Promise.resolve() };
  }
  const log = opts.log ?? ((msg: string) => console.log(msg));

  let token: string;
  let previousTickAt: string | null;
  try {
    ({ token, previousTickAt } = claimSchedulerLease());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[cron-scheduler] cannot claim lease (another instance owns it): ${msg}`);
    return null;
  }

  const startedAt = new Date().toISOString();
  const nowFn = opts.now ?? ((): Date => new Date());
  const tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
  const fireTask: FireTaskFn = opts.fireTask ?? (() => {
    // Default fire is no-op so tests / boot-before-wire is non-fatal.
    // server.ts replaces this at boot with bridgeSendMessage-via-pool.
  });

  const initialState: SchedulerState = {
    token,
    startedAt,
    // setInterval handles get assigned below; placeholders satisfy types.
    tickInterval: setInterval(() => {}, 1_000_000),
    gcInterval: setInterval(() => {}, 1_000_000),
    watcher: null,
    watcherDebounce: null,
    pendingTimers: new Set(),
    lastMtime: 0,
    cachedTasks: [],
    firedThisMinute: new Set(),
    lastMinuteKey: minuteKey(nowFn()),
    lastTickAt: null,
    nextTickAt: null,
    options: {
      fireTask,
      now: nowFn,
      tickIntervalMs,
      gcIntervalMs,
      disableMtimeWatcher: opts.disableMtimeWatcher ?? false,
      log,
    },
  };
  // Replace the placeholders now that we own the state object.
  clearInterval(initialState.tickInterval);
  clearInterval(initialState.gcInterval);
  initialState.tickInterval = setInterval(() => {
    void tick(initialState);
  }, tickIntervalMs);
  initialState.gcInterval = setInterval(() => {
    try {
      const removed = garbageCollect();
      if (removed > 0) {
        initialState.lastMtime = 0; // force cache refresh on next tick
      }
    } catch (err) {
      log(`[cron-scheduler] gc error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, gcIntervalMs);

  state = initialState;
  setupMtimeWatcher(initialState);

  // lcp-915: durability — catch up before the first regular tick.
  // Catch-up fires tasks whose cron-match minute passed while the shim
  // was down. The window is exclusive of the current minute (see
  // runCatchUp) so catch-up fires never collide with the regular
  // first-tick's per-minute dedup — no need to seed firedThisMinute.
  const whenReady = runCatchUp(initialState, previousTickAt, nowFn())
    .catch((err) => {
      log(`[cron-scheduler] catch-up error: ${err instanceof Error ? err.message : String(err)}`);
    })
    .then(async () => {
      // Always run the first regular tick — catch-up failure shouldn't
      // block the scheduler.
      if (state) await tick(state);
    });

  emitEvent("scheduler_started", nowFn(), initialState);
  log(`[cron-scheduler] started (pid=${process.pid}, token=${token})`);

  return { token, startedAt, whenReady };
}

/** Force one synchronous tick. Test seam. */
export async function __tickForTest(): Promise<void> {
  if (!state) throw new Error("scheduler not running");
  await tick(state);
}

export function stopCronScheduler(): void {
  if (!state) return;
  const s = state;
  state = null; // null before async work so re-entry is safe

  clearInterval(s.tickInterval);
  clearInterval(s.gcInterval);
  if (s.watcherDebounce) clearTimeout(s.watcherDebounce);
  for (const t of s.pendingTimers) clearTimeout(t);
  s.pendingTimers.clear();
  if (s.watcher) {
    try {
      s.watcher.close();
    } catch {
      // Watcher close is best-effort.
    }
  }
  try {
    releaseSchedulerLease(s.token);
  } catch (err) {
    s.options.log(`[cron-scheduler] release error: ${err instanceof Error ? err.message : String(err)}`);
  }
  emitEvent("scheduler_stopped", s.options.now(), s);
  s.options.log("[cron-scheduler] stopped");
}

export function getCronSchedulerStatus(): SchedulerStatus {
  if (!state) {
    return {
      lease_held: false,
      owner_pid: null,
      token: null,
      started_at: null,
      tasks_active: 0,
      last_tick_at: null,
      next_tick_at: null,
    };
  }
  // Read fresh — the status endpoint isn't hot path and a stale cached
  // count would lie to observers right after an external write.
  return {
    lease_held: verifySchedulerLease(state.token),
    owner_pid: process.pid,
    token: state.token,
    started_at: state.startedAt,
    tasks_active: getActiveTasks().length,
    last_tick_at: state.lastTickAt?.toISOString() ?? null,
    next_tick_at: state.nextTickAt?.toISOString() ?? null,
  };
}

/** True while a scheduler is running in-process. */
export function isCronSchedulerRunning(): boolean {
  return state !== null;
}
