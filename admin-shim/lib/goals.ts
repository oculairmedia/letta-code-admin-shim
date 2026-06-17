/**
 * Goal store (epic lcp-ctz2, bead lcp-y8lv).
 *
 * Goals are a first-class user-facing concept in Letta Code: what the USER
 * said they want, tracked over time. This is the storage + pure-logic
 * foundation; REST (lcp-2eg2), the memfs projection (lcp-wt5s), WS broadcast
 * (lcp-wgn7), the /goal slash family (lcp-43t6), and agent tools (lcp-grjo)
 * all build on the exports here.
 *
 * ON-DISK SHAPE: one JSON file per agent at
 *   <storageDir>/agents/<agentId>/goals.json   (a Goal[] array)
 * One file per agent makes the writer trivially serialized (no inter-goal
 * contention) and mirrors the per-agent sharding used for skills/runs.
 * Writes are atomic (tmp + rename); reads tolerate a missing/corrupt file by
 * returning [] (never throw on the read path).
 *
 * PRODUCT GUARDRAIL (product_north_star.md): goals measure the user's real
 * progress, not app engagement. `verificationSource` records whether progress
 * was observed against real signal (git/calendar/file/vibesync) or is
 * self-reported (manual). Streaks track the actual thing.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────

export type GoalStatus = "active" | "paused" | "done" | "abandoned";
export type GoalCadence = "once" | "daily" | "weekly" | "custom";
export type GoalVerificationSource =
  | "git"
  | "calendar"
  | "file"
  | "vibesync"
  | "manual";

export interface ProgressEntry {
  timestamp: string;
  note?: string;
  value?: number;
  source?: GoalVerificationSource;
}

export interface Goal {
  id: string;
  agentId: string;
  title: string;
  description: string;
  status: GoalStatus;
  cadence: GoalCadence;
  metric?: string;
  target?: number;
  createdAt: string;
  updatedAt: string;
  progress: ProgressEntry[];
  verificationSource?: GoalVerificationSource;
}

export interface CreateGoalInput {
  title: string;
  description?: string;
  status?: GoalStatus;
  cadence?: GoalCadence;
  metric?: string;
  target?: number;
  verificationSource?: GoalVerificationSource;
}

export interface UpdateGoalPatch {
  title?: string;
  description?: string;
  status?: GoalStatus;
  cadence?: GoalCadence;
  metric?: string | null;
  target?: number | null;
  verificationSource?: GoalVerificationSource | null;
}

export interface RecordProgressInput {
  note?: string;
  value?: number;
  source?: GoalVerificationSource;
  /** Override timestamp (ISO). Defaults to now. Used by tests + backfill. */
  timestamp?: string;
}

// ── Paths ───────────────────────────────────────────────────────────────

function storageDir(): string {
  return (
    process.env["LETTA_LOCAL_BACKEND_DIR"] ||
    join(process.env["LETTA_HOME"] || join(homedir(), ".letta"), "lc-local-backend")
  );
}

function goalsFile(agentId: string): string {
  return join(storageDir(), "agents", agentId, "goals.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Read / write (atomic, tolerant) ───────────────────────────────────────

function isGoal(value: unknown): value is Goal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["agentId"] === "string" &&
    typeof v["title"] === "string" &&
    Array.isArray(v["progress"])
  );
}

/** Read an agent's goals. Missing/corrupt file → []. Never throws on read. */
export function listGoalsForAgent(agentId: string): Goal[] {
  const path = goalsFile(agentId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isGoal);
  } catch {
    return [];
  }
}

function writeGoals(agentId: string, goals: Goal[]): void {
  const path = goalsFile(agentId);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(goals, null, 2) + "\n");
  renameSync(tmp, path);
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export function getGoal(agentId: string, goalId: string): Goal | null {
  return listGoalsForAgent(agentId).find((g) => g.id === goalId) ?? null;
}

export function createGoal(agentId: string, input: CreateGoalInput): Goal {
  const ts = nowIso();
  const goal: Goal = {
    id: `goal-${randomUUID()}`,
    agentId,
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "active",
    cadence: input.cadence ?? "once",
    ...(input.metric !== undefined ? { metric: input.metric } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    createdAt: ts,
    updatedAt: ts,
    progress: [],
    ...(input.verificationSource !== undefined
      ? { verificationSource: input.verificationSource }
      : {}),
  };
  const goals = listGoalsForAgent(agentId);
  goals.push(goal);
  writeGoals(agentId, goals);
  return goal;
}

export function updateGoal(
  agentId: string,
  goalId: string,
  patch: UpdateGoalPatch,
): Goal | null {
  const goals = listGoalsForAgent(agentId);
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx < 0) return null;
  const current = goals[idx]!;
  const next: Goal = { ...current, updatedAt: nowIso() };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.cadence !== undefined) next.cadence = patch.cadence;
  applyNullable(next, "metric", patch.metric);
  applyNullable(next, "target", patch.target);
  applyNullable(next, "verificationSource", patch.verificationSource);
  goals[idx] = next;
  writeGoals(agentId, goals);
  return next;
}

function applyNullable<K extends keyof Goal>(
  goal: Goal,
  key: K,
  value: Goal[K] | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    delete goal[key];
  } else {
    goal[key] = value;
  }
}

export function deleteGoal(agentId: string, goalId: string): boolean {
  const goals = listGoalsForAgent(agentId);
  const next = goals.filter((g) => g.id !== goalId);
  if (next.length === goals.length) return false;
  writeGoals(agentId, next);
  return true;
}

export function recordProgress(
  agentId: string,
  goalId: string,
  input: RecordProgressInput,
): Goal | null {
  const goals = listGoalsForAgent(agentId);
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx < 0) return null;
  const goal = goals[idx]!;
  const entry: ProgressEntry = {
    timestamp: input.timestamp ?? nowIso(),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
  const next: Goal = {
    ...goal,
    progress: [...goal.progress, entry],
    updatedAt: nowIso(),
  };
  goals[idx] = next;
  writeGoals(agentId, goals);
  return next;
}

// ── Streak ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Current consecutive-period streak for daily/weekly cadence, derived purely
 * from progress timestamps. A streak counts back from the most recent period
 * that has progress: today/this-week counts, and each prior contiguous period
 * with at least one progress entry extends it. `once`/`custom` cadence returns
 * the number of progress entries (no period notion).
 *
 * `nowMs` is injectable for deterministic tests.
 */
export function computeStreak(goal: Goal, nowMs: number = Date.now()): number {
  if (goal.progress.length === 0) return 0;
  if (goal.cadence !== "daily" && goal.cadence !== "weekly") {
    return goal.progress.length;
  }
  const periodMs = goal.cadence === "daily" ? DAY_MS : 7 * DAY_MS;
  // Bucket each progress timestamp to its period index (floor since epoch).
  const periods = new Set<number>();
  for (const entry of goal.progress) {
    const t = Date.parse(entry.timestamp);
    if (!Number.isFinite(t)) continue;
    periods.add(Math.floor(t / periodMs));
  }
  if (periods.size === 0) return 0;
  const currentPeriod = Math.floor(nowMs / periodMs);
  // The streak's most recent period must be the current period or the one
  // immediately prior (grace for "not done yet today/this week"). Otherwise
  // the streak is broken (0).
  let anchor: number;
  if (periods.has(currentPeriod)) anchor = currentPeriod;
  else if (periods.has(currentPeriod - 1)) anchor = currentPeriod - 1;
  else return 0;
  let streak = 0;
  let p = anchor;
  while (periods.has(p)) {
    streak += 1;
    p -= 1;
  }
  return streak;
}

// ── Test/debug hook ─────────────────────────────────────────────────────────

export const _goalsInternals = Object.freeze({
  goalsFile,
  storageDir,
});
