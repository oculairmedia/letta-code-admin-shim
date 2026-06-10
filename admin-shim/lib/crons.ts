/**
 * Shim-side `crons.json` store.
 *
 * Ports the lock-aware CRUD primitive from letta-code's bundled cron file
 * (see /root/.bun/install/global/node_modules/@letta-ai/letta-code/letta.js,
 * functions readCronFile / writeCronFile / withLock / addTask, etc.) into the
 * admin-shim so we can manage scheduled tasks without spawning `letta cron`
 * per call.
 *
 * Compatibility contract:
 *   - File location matches the bundled letta-code's getLettaDir() —
 *     `LETTA_HOME || join($HOME, ".letta")` — so the bundled self-schedule
 *     skill writes to the same file we read from, and our scheduler
 *     (lcp-0mw) picks up rows it added.
 *   - File shape ({version:1, scheduler_owner, tasks}) is preserved
 *     byte-for-byte. All 19 CronTask fields are written even when null.
 *   - mkdir-based lock at `<lettaDir>/crons.lock/owner.json` with token,
 *     pid, acquired_at, process_start_ticks, boot_id. Stale-lock stealing
 *     uses the same 30s threshold as the bundle.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AddTaskInput,
  AddTaskResult,
  CronFile,
  CronTask,
  ListTaskFilters,
  LockOwner,
  ParseAtResult,
  ParseEveryResult,
  SchedulerOwner,
} from "./types/crons.js";

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

const CRON_FILE_NAME = "crons.json";
const LOCK_DIR_NAME = "crons.lock";
const LOCK_TOKEN_FILE = "owner.json";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_AGE_MS = 30000;
const TASK_ID_BYTES = 4;
const GC_AGE_MS = 24 * 60 * 60 * 1000;

function maxActiveTasksPerAgent(): number {
  const raw = process.env["SHIM_CRON_MAX_ACTIVE_PER_AGENT"];
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

export function missedThresholdMs(): number {
  const raw = process.env["SHIM_CRON_MISSED_THRESHOLD_MS"];
  if (!raw) return 5 * 60_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60_000;
}

// ──────────────────────────────────────────────────────────────────────
// File paths — match bundled letta-code's getLettaDir() semantics so both
// processes see the same crons.json.
// ──────────────────────────────────────────────────────────────────────

function getLettaDir(): string {
  return process.env["LETTA_HOME"] || join(process.env["HOME"] || homedir(), ".letta");
}

export function getCronFilePath(): string {
  return join(getLettaDir(), CRON_FILE_NAME);
}

export function getLockDirPath(): string {
  return join(getLettaDir(), LOCK_DIR_NAME);
}

function emptyFile(): CronFile {
  return { version: 1, scheduler_owner: null, last_tick_at: null, tasks: [] };
}

// ──────────────────────────────────────────────────────────────────────
// Read / write (atomic via tmp+rename)
// ──────────────────────────────────────────────────────────────────────

export function readCronFile(): CronFile {
  const path = getCronFilePath();
  if (!existsSync(path)) return emptyFile();
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as CronFile;
    if (data.version !== 1) return emptyFile();
    // Back-compat: files written before lcp-915 omit last_tick_at.
    if (data.last_tick_at === undefined) data.last_tick_at = null;
    return data;
  } catch {
    return emptyFile();
  }
}

export function writeCronFile(data: CronFile): void {
  const path = getCronFilePath();
  const dir = getLettaDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { flush: true });
  renameSync(tmp, path);
}

export function getCronFileMtime(): number {
  try {
    return statSync(getCronFilePath()).mtimeMs;
  } catch {
    return 0;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Process identity (used for stale-lock detection across reboots)
// ──────────────────────────────────────────────────────────────────────

interface ProcessIdentity {
  startTicks: string | null;
  bootId: string | null;
}

function readLinuxProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endCommand = stat.lastIndexOf(")");
    if (endCommand === -1) return null;
    const fields = stat.slice(endCommand + 2).trim().split(/\s+/);
    const startTicks = fields[19] ?? null;
    if (!startTicks) return null;
    let bootId: string | null = null;
    try {
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      // boot_id is best-effort; absence on non-Linux is expected.
    }
    return { startTicks, bootId };
  } catch {
    return null;
  }
}

type ProcessIdentityReader = (pid: number) => ProcessIdentity | null;
let readProcessIdentityOverride: ProcessIdentityReader | null = null;

/** Test hook: override how we read /proc/<pid>/stat. Production code never sets this. */
export function __setProcessIdentityReader(fn: ProcessIdentityReader | null): void {
  readProcessIdentityOverride = fn;
}

function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (readProcessIdentityOverride) return readProcessIdentityOverride(pid);
  return readLinuxProcessIdentity(pid);
}

export function captureProcessIdentity(pid: number): {
  process_start_ticks: string | null;
  boot_id: string | null;
} {
  const identity = readProcessIdentity(pid);
  return {
    process_start_ticks: identity?.startTicks ?? null,
    boot_id: identity?.bootId ?? null,
  };
}

function isProcessAlive(
  pid: number,
  owner?: { boot_id: string | null; process_start_ticks: string | null } | null,
): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // kill(pid, 0) succeeds on zombies. A defunct holder can pin the scheduler
  // lease indefinitely when its parent is too wedged to reap it (observed
  // live 2026-06-10: SIGKILLed shim left a zombie under a hung systemd and
  // the replacement instance could never claim). State "Z" in
  // /proc/<pid>/stat means the process is dead for every purpose we care
  // about here.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const close = stat.lastIndexOf(")");
    if (close !== -1 && stat.slice(close + 1).trim().startsWith("Z")) {
      return false;
    }
  } catch {
    // /proc unavailable (non-Linux) — fall through to identity checks.
  }
  if (owner) {
    const identity = readProcessIdentity(pid);
    if (identity) {
      if (owner.boot_id && identity.bootId && owner.boot_id !== identity.bootId) {
        return false;
      }
      if (
        owner.process_start_ticks &&
        identity.startTicks &&
        owner.process_start_ticks !== identity.startTicks
      ) {
        return false;
      }
    }
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Lock (mkdir-based)
// ──────────────────────────────────────────────────────────────────────

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const raw = readFileSync(join(lockDir, LOCK_TOKEN_FILE), "utf-8");
    return JSON.parse(raw) as LockOwner;
  } catch {
    return null;
  }
}

function writeLockOwner(lockDir: string, owner: LockOwner): void {
  writeFileSync(join(lockDir, LOCK_TOKEN_FILE), JSON.stringify(owner));
}

function isLockStale(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  if (!owner) {
    try {
      const stat = statSync(lockDir);
      return Date.now() - stat.mtimeMs > LOCK_STALE_AGE_MS;
    } catch {
      return true;
    }
  }
  const pidDead = !isProcessAlive(owner.pid, owner);
  const isOld = Date.now() - owner.acquired_at > LOCK_STALE_AGE_MS;
  return pidDead && isOld;
}

function stealLock(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best-effort — the next mkdir will surface any real failure.
  }
}

export interface LockHandle {
  release(): void;
}

export function acquireLock(): LockHandle {
  const lockDir = getLockDirPath();
  const lettaDir = getLettaDir();
  if (!existsSync(lettaDir)) {
    mkdirSync(lettaDir, { recursive: true });
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomBytes(4).toString("hex");

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir, { recursive: false });
      const owner: LockOwner = {
        pid: process.pid,
        token,
        acquired_at: Date.now(),
        ...captureProcessIdentity(process.pid),
      };
      writeLockOwner(lockDir, owner);
      return {
        release() {
          try {
            const current = readLockOwner(lockDir);
            if (current && current.token === token) {
              rmSync(lockDir, { recursive: true, force: true });
            }
          } catch {
            // Release is best-effort; stale-lock detection covers leaks.
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        if (isLockStale(lockDir)) {
          stealLock(lockDir);
          continue;
        }
        const sleepMs = Math.min(
          LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS,
          deadline - Date.now(),
        );
        if (sleepMs > 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
        }
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to acquire crons.lock — timed out after 5s");
}

export function withLock<T>(fn: () => T): T {
  const lock = acquireLock();
  try {
    return fn();
  } finally {
    lock.release();
  }
}

// ──────────────────────────────────────────────────────────────────────
// Task id + jitter
// ──────────────────────────────────────────────────────────────────────

function generateTaskId(): string {
  return randomBytes(TASK_ID_BYTES).toString("hex");
}

function simpleHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash);
}

function estimatePeriodMs(cron: string): number {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return 0;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (minute.startsWith("*/") && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const step = Number.parseInt(minute.slice(2), 10);
    return step > 0 ? step * 60 * 1000 : 0;
  }
  if (
    !minute.startsWith("*") &&
    hour.startsWith("*/") &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    const step = Number.parseInt(hour.slice(2), 10);
    return step > 0 ? step * 60 * 60 * 1000 : 0;
  }
  if (
    !minute.includes("*") &&
    !hour.includes("*") &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    return 24 * 60 * 60 * 1000;
  }
  return 0;
}

export function computeJitter(
  taskId: string,
  cron: string,
  recurring: boolean,
  scheduledFor: Date | null,
  createdAt: Date,
): number {
  if (recurring) {
    const periodMs = estimatePeriodMs(cron);
    if (periodMs <= 0) return 0;
    const maxJitter = Math.min(periodMs * 0.1, 59999);
    return simpleHash(taskId) % Math.max(1, Math.floor(maxJitter));
  }
  if (!scheduledFor) return 0;
  const min = scheduledFor.getMinutes();
  if (min === 0 || min === 30) {
    const offset = -(simpleHash(taskId) % 90000);
    if (scheduledFor.getTime() + offset < createdAt.getTime()) return 0;
    return offset;
  }
  return 0;
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export function addTask(input: AddTaskInput): AddTaskResult {
  return withLock(() => {
    const data = readCronFile();
    const agentId = input.agent_id;
    const conversationId = input.conversation_id ?? "default";
    const activeCount = data.tasks.filter(
      (t) => t.agent_id === agentId && t.status === "active",
    ).length;
    const limit = maxActiveTasksPerAgent();
    if (activeCount >= limit) {
      throw new Error(
        `Agent ${agentId} has ${activeCount} active tasks (max ${limit}). Delete some before adding more.`,
      );
    }
    const now = new Date();
    const taskId = generateTaskId();
    const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const task: CronTask = {
      id: taskId,
      agent_id: agentId,
      conversation_id: conversationId,
      name: input.name,
      description: input.description,
      cron: input.cron,
      timezone,
      recurring: input.recurring,
      prompt: input.prompt,
      status: "active",
      created_at: now.toISOString(),
      expires_at: null,
      last_fired_at: null,
      fire_count: 0,
      cancel_reason: null,
      jitter_offset_ms: computeJitter(
        taskId,
        input.cron,
        input.recurring,
        input.scheduled_for ?? null,
        now,
      ),
      scheduled_for: input.scheduled_for?.toISOString() ?? null,
      fired_at: null,
      missed_at: null,
    };
    data.tasks.push(task);
    writeCronFile(data);
    let warning: string | undefined;
    if (
      !data.scheduler_owner ||
      !isProcessAlive(data.scheduler_owner.pid, data.scheduler_owner)
    ) {
      warning =
        "No letta server is currently running. This task will only execute when a WS listener is active.";
    }
    return warning === undefined ? { task } : { task, warning };
  });
}

export function listTasks(filters?: ListTaskFilters): CronTask[] {
  const data = readCronFile();
  let tasks = data.tasks;
  if (filters?.agent_id) {
    tasks = tasks.filter((t) => t.agent_id === filters.agent_id);
  }
  if (filters?.conversation_id) {
    tasks = tasks.filter((t) => t.conversation_id === filters.conversation_id);
  }
  return tasks;
}

export function getTask(taskId: string): CronTask | null {
  const data = readCronFile();
  return data.tasks.find((t) => t.id === taskId) ?? null;
}

export function deleteTask(taskId: string): boolean {
  return withLock(() => {
    const data = readCronFile();
    const idx = data.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    data.tasks.splice(idx, 1);
    writeCronFile(data);
    return true;
  });
}

export function deleteAllTasks(agentId: string): number {
  return withLock(() => {
    const data = readCronFile();
    const before = data.tasks.length;
    data.tasks = data.tasks.filter((t) => t.agent_id !== agentId);
    const removed = before - data.tasks.length;
    if (removed > 0) writeCronFile(data);
    return removed;
  });
}

export function updateTask(
  taskId: string,
  updater: (task: CronTask) => void,
): CronTask | null {
  return withLock(() => {
    const data = readCronFile();
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    updater(task);
    writeCronFile(data);
    return { ...task };
  });
}

/**
 * Like {@link updateTask} but also stamps `last_tick_at = now` in the
 * same lock-acquire/write transaction. The scheduler uses this on the
 * fire and missed-one-shot paths so durability metadata costs zero
 * extra fsyncs beyond what the row-update already does (lcp-915).
 */
export function updateTaskAndTickTime(
  taskId: string,
  updater: (task: CronTask) => void,
  now: Date,
): CronTask | null {
  return withLock(() => {
    const data = readCronFile();
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    updater(task);
    data.last_tick_at = now.toISOString();
    writeCronFile(data);
    return { ...task };
  });
}

export function getActiveTasks(): CronTask[] {
  const data = readCronFile();
  return data.tasks.filter((t) => t.status === "active");
}

export function garbageCollect(): number {
  return withLock(() => {
    const data = readCronFile();
    const cutoff = Date.now() - GC_AGE_MS;
    const before = data.tasks.length;
    data.tasks = data.tasks.filter((t) => {
      if (t.status === "active") return true;
      const createdAt = new Date(t.created_at).getTime();
      const terminalAt = Math.max(
        t.last_fired_at ? new Date(t.last_fired_at).getTime() : 0,
        t.fired_at ? new Date(t.fired_at).getTime() : 0,
        t.missed_at ? new Date(t.missed_at).getTime() : 0,
        createdAt,
      );
      return terminalAt > cutoff;
    });
    const removed = before - data.tasks.length;
    if (removed > 0) writeCronFile(data);
    return removed;
  });
}

// ──────────────────────────────────────────────────────────────────────
// Scheduler lease (writes/reads scheduler_owner field on crons.json)
// ──────────────────────────────────────────────────────────────────────

/**
 * Claim the scheduler lease atomically. Returns the new lease token,
 * the previous `last_tick_at` value (so the caller can compute a
 * catch-up window — lcp-915), and stamps last_tick_at = now in the
 * same write transaction.
 */
export interface ClaimLeaseResult {
  token: string;
  /** Last successful tick time prior to this claim. `null` for fresh installs. */
  previousTickAt: string | null;
}

export function claimSchedulerLease(): ClaimLeaseResult {
  return withLock(() => {
    const data = readCronFile();
    const token = randomBytes(4).toString("hex");
    if (data.scheduler_owner) {
      const existing = data.scheduler_owner;
      if (isProcessAlive(existing.pid, existing)) {
        throw new Error(
          `Scheduler lease held by PID ${existing.pid} (token ${existing.token}). Cannot claim.`,
        );
      }
    }
    const previousTickAt = data.last_tick_at;
    const owner: SchedulerOwner = {
      pid: process.pid,
      token,
      started_at: new Date().toISOString(),
      ...captureProcessIdentity(process.pid),
    };
    data.scheduler_owner = owner;
    data.last_tick_at = new Date().toISOString();
    writeCronFile(data);
    return { token, previousTickAt };
  });
}

export function verifySchedulerLease(token: string): boolean {
  const data = readCronFile();
  return (
    data.scheduler_owner !== null &&
    data.scheduler_owner.pid === process.pid &&
    data.scheduler_owner.token === token
  );
}

export function releaseSchedulerLease(token: string): void {
  withLock(() => {
    const data = readCronFile();
    if (
      data.scheduler_owner &&
      data.scheduler_owner.pid === process.pid &&
      data.scheduler_owner.token === token
    ) {
      data.scheduler_owner = null;
      writeCronFile(data);
    }
  });
}

// ──────────────────────────────────────────────────────────────────────
// Interval / cron parsing helpers (ported from letta-code's parseInterval.ts)
// ──────────────────────────────────────────────────────────────────────

const INTERVAL_RE =
  /^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days?)$/i;
const TIME_RE = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i;
const RELATIVE_RE = /^in\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/i;
const CRON_FIELD_RE = /^(\*|\d+)([/-]\d+)?$/;

function minuteCron(mins: number): ParseEveryResult {
  if (mins <= 0) return { cron: "*/1 * * * *", note: "Rounded to 1m minimum" };
  if (mins >= 60) {
    const hours = Math.round(mins / 60);
    return { cron: `0 */${Math.max(1, hours)} * * *` };
  }
  if (60 % mins === 0) {
    return { cron: `*/${mins} * * * *` };
  }
  const divisors = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
  const closest = divisors.reduce((prev, curr) =>
    Math.abs(curr - mins) < Math.abs(prev - mins) ? curr : prev,
  );
  return {
    cron: `*/${closest} * * * *`,
    note: `${mins}m rounded to every ${closest}m (nearest clean divisor of 60)`,
  };
}

export function parseEvery(input: string): ParseEveryResult | null {
  const match = input.trim().match(INTERVAL_RE);
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? "", 10);
  if (value <= 0 || !Number.isFinite(value)) return null;
  const unit = (match[2] ?? "").toLowerCase();
  if (unit.startsWith("s")) {
    if (value < 60) {
      return {
        cron: "*/1 * * * *",
        note: `Rounded ${value}s up to 1m (minimum granularity is 1 minute)`,
      };
    }
    const mins = Math.round(value / 60);
    return minuteCron(mins);
  }
  if (unit.startsWith("m")) {
    return minuteCron(value);
  }
  if (unit.startsWith("h")) {
    if (value >= 24) {
      return { cron: "0 0 * * *", note: `${value}h clamped to daily` };
    }
    if (24 % value === 0) {
      return { cron: `0 */${value} * * *` };
    }
    const divisors = [1, 2, 3, 4, 6, 8, 12, 24];
    const closest = divisors.reduce((prev, curr) =>
      Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev,
    );
    return {
      cron: `0 */${closest} * * *`,
      note: `${value}h rounded to every ${closest}h (nearest clean divisor of 24)`,
    };
  }
  if (unit.startsWith("d")) {
    if (value === 1) return { cron: "0 0 * * *" };
    return { cron: `0 0 */${value} * *` };
  }
  return null;
}

function dateToCron(d: Date): string {
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

export function parseAt(input: string, now?: Date): ParseAtResult | null {
  const trimmed = input.trim();
  const currentTime = now ?? new Date();
  const relMatch = trimmed.match(RELATIVE_RE);
  if (relMatch) {
    const value = Number.parseInt(relMatch[1] ?? "", 10);
    const unit = (relMatch[2] ?? "").toLowerCase();
    let ms: number;
    if (unit.startsWith("h")) {
      ms = value * 60 * 60 * 1000;
    } else {
      ms = value * 60 * 1000;
    }
    const scheduledFor = new Date(currentTime.getTime() + ms);
    return {
      scheduledFor,
      cron: dateToCron(scheduledFor),
      note: `Scheduled for ${scheduledFor.toLocaleTimeString()} (in ${value}${unit.charAt(0)})`,
    };
  }
  const timeMatch = trimmed.match(TIME_RE);
  if (timeMatch) {
    let hours = Number.parseInt(timeMatch[1] ?? "", 10);
    const minutes = Number.parseInt(timeMatch[2] ?? "", 10);
    const ampm = (timeMatch[3] ?? "").toLowerCase();
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
    if (ampm === "pm" && hours !== 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;
    const scheduledFor = new Date(currentTime);
    scheduledFor.setHours(hours, minutes, 0, 0);
    if (scheduledFor.getTime() <= currentTime.getTime()) {
      scheduledFor.setDate(scheduledFor.getDate() + 1);
    }
    return { scheduledFor, cron: dateToCron(scheduledFor) };
  }
  return null;
}

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => CRON_FIELD_RE.test(f));
}

// ──────────────────────────────────────────────────────────────────────
// Cron matching (used by the scheduler to decide if a task fires this tick)
// ──────────────────────────────────────────────────────────────────────

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = Number.parseInt(field.slice(2), 10);
    if (step <= 0 || !Number.isFinite(step)) return false;
    return value % step === 0;
  }
  if (field.includes("-")) {
    const [startStr, endStr] = field.split("-");
    const start = Number.parseInt(startStr ?? "", 10);
    const end = Number.parseInt(endStr ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return value >= start && value <= end;
  }
  const exact = Number.parseInt(field, 10);
  return Number.isFinite(exact) && value === exact;
}

function getTimeComponents(date: Date, timezone?: string): [number, number, number, number, number] {
  if (!timezone) {
    return [
      date.getMinutes(),
      date.getHours(),
      date.getDate(),
      date.getMonth() + 1,
      date.getDay(),
    ];
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
      hour12: false,
    });
    const parts = new Map(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    const dayOfWeekStr = parts.get("weekday") ?? "";
    const dowMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    return [
      Number.parseInt(parts.get("minute") ?? "0", 10),
      Number.parseInt(parts.get("hour") ?? "0", 10),
      Number.parseInt(parts.get("day") ?? "1", 10),
      Number.parseInt(parts.get("month") ?? "1", 10),
      dowMap[dayOfWeekStr] ?? date.getDay(),
    ];
  } catch {
    return [
      date.getMinutes(),
      date.getHours(),
      date.getDate(),
      date.getMonth() + 1,
      date.getDay(),
    ];
  }
}

export function cronMatchesTime(expr: string, date: Date, timezone?: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = getTimeComponents(date, timezone);
  const [fMinute, fHour, fDom, fMonth, fDow] = fields as [string, string, string, string, string];
  if (!fieldMatches(fMinute, minute)) return false;
  if (!fieldMatches(fHour, hour)) return false;
  if (!fieldMatches(fMonth, month)) return false;
  const domConstrained = fDom !== "*";
  const dowConstrained = fDow !== "*";
  if (domConstrained && dowConstrained) {
    return fieldMatches(fDom, dayOfMonth) || fieldMatches(fDow, dayOfWeek);
  }
  return fieldMatches(fDom, dayOfMonth) && fieldMatches(fDow, dayOfWeek);
}
