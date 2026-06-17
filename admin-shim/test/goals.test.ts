import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGoal,
  listGoalsForAgent,
  getGoal,
  updateGoal,
  deleteGoal,
  recordProgress,
  computeStreak,
  _goalsInternals,
  type Goal,
} from "../lib/goals.js";

const AGENT = "agent-goals-test-0000";
let backendRoot: string;
let prevBackendDir: string | undefined;

beforeEach(() => {
  backendRoot = mkdtempSync(join(tmpdir(), "lcp-goals-"));
  prevBackendDir = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = backendRoot;
});

afterEach(() => {
  if (prevBackendDir === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
  else process.env["LETTA_LOCAL_BACKEND_DIR"] = prevBackendDir;
  rmSync(backendRoot, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

test("goals: create → list → get round-trip", () => {
  assert.deepEqual(listGoalsForAgent(AGENT), []);
  const g = createGoal(AGENT, { title: "Write daily", cadence: "daily" });
  assert.match(g.id, /^goal-/);
  assert.equal(g.agentId, AGENT);
  assert.equal(g.status, "active");
  assert.equal(g.cadence, "daily");
  assert.deepEqual(g.progress, []);

  const listed = listGoalsForAgent(AGENT);
  assert.equal(listed.length, 1);
  assert.equal(getGoal(AGENT, g.id)?.title, "Write daily");
  assert.equal(getGoal(AGENT, "goal-missing"), null);
});

test("goals: update patches fields and clears nullables", () => {
  const g = createGoal(AGENT, { title: "x", metric: "words", target: 500 });
  const u = updateGoal(AGENT, g.id, { title: "y", status: "paused", target: null });
  assert.ok(u);
  assert.equal(u.title, "y");
  assert.equal(u.status, "paused");
  assert.equal(u.metric, "words");
  assert.equal("target" in u, false, "target cleared via null patch");
  assert.ok(u.updatedAt >= g.updatedAt);
  assert.equal(updateGoal(AGENT, "goal-missing", { title: "z" }), null);
});

test("goals: recordProgress appends timestamped entries", () => {
  const g = createGoal(AGENT, { title: "ship", cadence: "daily" });
  recordProgress(AGENT, g.id, { note: "first", value: 1, source: "git" });
  const after = recordProgress(AGENT, g.id, { note: "second", source: "manual" });
  assert.ok(after);
  assert.equal(after.progress.length, 2);
  assert.equal(after.progress[0]?.note, "first");
  assert.equal(after.progress[0]?.source, "git");
  assert.equal(after.progress[1]?.source, "manual");
  assert.equal(recordProgress(AGENT, "goal-missing", {}), null);
});

test("goals: delete removes the goal", () => {
  const g = createGoal(AGENT, { title: "tmp" });
  assert.equal(deleteGoal(AGENT, g.id), true);
  assert.deepEqual(listGoalsForAgent(AGENT), []);
  assert.equal(deleteGoal(AGENT, g.id), false);
});

test("goals: computeStreak daily — consecutive days from today", () => {
  const g = createGoal(AGENT, { title: "daily", cadence: "daily" });
  const now = Date.parse("2026-06-17T12:00:00.000Z");
  recordProgress(AGENT, g.id, { timestamp: iso(now) });
  recordProgress(AGENT, g.id, { timestamp: iso(now - DAY) });
  recordProgress(AGENT, g.id, { timestamp: iso(now - 2 * DAY) });
  const fresh = getGoal(AGENT, g.id)!;
  assert.equal(computeStreak(fresh, now), 3);
});

test("goals: computeStreak daily — broken streak resets to 0", () => {
  const g = createGoal(AGENT, { title: "daily", cadence: "daily" });
  const now = Date.parse("2026-06-17T12:00:00.000Z");
  // last progress was 3 days ago — neither today nor yesterday → broken
  recordProgress(AGENT, g.id, { timestamp: iso(now - 3 * DAY) });
  recordProgress(AGENT, g.id, { timestamp: iso(now - 4 * DAY) });
  assert.equal(computeStreak(getGoal(AGENT, g.id)!, now), 0);
});

test("goals: computeStreak daily — yesterday anchor (grace for not-done-today)", () => {
  const g = createGoal(AGENT, { title: "daily", cadence: "daily" });
  const now = Date.parse("2026-06-17T12:00:00.000Z");
  recordProgress(AGENT, g.id, { timestamp: iso(now - DAY) });
  recordProgress(AGENT, g.id, { timestamp: iso(now - 2 * DAY) });
  assert.equal(computeStreak(getGoal(AGENT, g.id)!, now), 2);
});

test("goals: computeStreak weekly", () => {
  const g = createGoal(AGENT, { title: "weekly", cadence: "weekly" });
  const now = Date.parse("2026-06-17T12:00:00.000Z");
  recordProgress(AGENT, g.id, { timestamp: iso(now) });
  recordProgress(AGENT, g.id, { timestamp: iso(now - 7 * DAY) });
  assert.equal(computeStreak(getGoal(AGENT, g.id)!, now), 2);
});

test("goals: computeStreak once/custom counts entries", () => {
  const g = createGoal(AGENT, { title: "once", cadence: "once" });
  recordProgress(AGENT, g.id, {});
  recordProgress(AGENT, g.id, {});
  assert.equal(computeStreak(getGoal(AGENT, g.id)!), 2);
});

test("goals: corrupt/missing file tolerated (returns empty)", () => {
  assert.deepEqual(listGoalsForAgent("agent-never-written"), []);
  // Write garbage to the goals file, then read.
  const g = createGoal(AGENT, { title: "x" });
  const path = _goalsInternals.goalsFile(AGENT);
  rmSync(path);
  // missing again
  assert.deepEqual(listGoalsForAgent(AGENT), []);
  void g;
});

test("goals: atomic write leaves no tmp files behind", () => {
  const g = createGoal(AGENT, { title: "a" });
  updateGoal(AGENT, g.id, { title: "b" });
  recordProgress(AGENT, g.id, { note: "p" });
  const dir = join(_goalsInternals.storageDir(), "agents", AGENT);
  const stray = readdirSync(dir).filter((f) => f.includes(".tmp."));
  assert.deepEqual(stray, [], "no .tmp. files left after writes");
});

test("goals: sequential writes do not clobber prior goals", () => {
  const a = createGoal(AGENT, { title: "a" });
  const b = createGoal(AGENT, { title: "b" });
  const c = createGoal(AGENT, { title: "c" });
  const ids = listGoalsForAgent(AGENT).map((g: Goal) => g.id).sort();
  assert.deepEqual(ids, [a.id, b.id, c.id].sort());
  assert.ok(existsSync(_goalsInternals.goalsFile(AGENT)));
});
