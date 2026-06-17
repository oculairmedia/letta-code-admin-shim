import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GOALS_BLOCK_LABEL,
  buildGoalsBlockContent,
  syncGoalsBlockForAgent,
} from "../lib/store.js";
import { createGoal, recordProgress, updateGoal } from "../lib/goals.js";

const AGENT = "agent-goals-block-0000";
let backendRoot: string;
let prevBackendDir: string | undefined;

beforeEach(() => {
  backendRoot = mkdtempSync(join(tmpdir(), "lcp-goals-block-"));
  prevBackendDir = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = backendRoot;
});

afterEach(() => {
  if (prevBackendDir === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
  else process.env["LETTA_LOCAL_BACKEND_DIR"] = prevBackendDir;
  rmSync(backendRoot, { recursive: true, force: true });
});

function blockPath(): string {
  return join(backendRoot, "memfs", AGENT, "memory", "system", `${GOALS_BLOCK_LABEL}.md`);
}

test("goals-block: buildGoalsBlockContent null when no active goals", () => {
  assert.equal(buildGoalsBlockContent([]), null);
});

test("goals-block: active-only, with streak, omits history + non-active", () => {
  const active = createGoal(AGENT, { title: "Write daily", cadence: "daily" });
  recordProgress(AGENT, active.id, { note: "drafted intro", source: "manual" });
  const paused = createGoal(AGENT, { title: "Paused thing", cadence: "weekly" });
  updateGoal(AGENT, paused.id, { status: "paused" });
  const done = createGoal(AGENT, { title: "Finished thing" });
  updateGoal(AGENT, done.id, { status: "done" });

  syncGoalsBlockForAgent(AGENT);
  assert.ok(existsSync(blockPath()));
  const block = readFileSync(blockPath(), "utf8");

  assert.match(block, /## Active Goals/);
  assert.match(block, /Write daily \(daily/);
  assert.match(block, /last: drafted intro/);
  // Non-active goals must NOT appear.
  assert.doesNotMatch(block, /Paused thing/);
  assert.doesNotMatch(block, /Finished thing/);
  // Compact — no raw progress array / timestamps dumped.
  assert.ok(block.length < 1024, `block should be compact, was ${block.length}`);
});

test("goals-block: write-if-changed and self-cleaning", () => {
  const g = createGoal(AGENT, { title: "Ship feature", cadence: "once" });
  syncGoalsBlockForAgent(AGENT);
  assert.ok(existsSync(blockPath()));
  const first = readFileSync(blockPath(), "utf8");

  // No change → identical content.
  syncGoalsBlockForAgent(AGENT);
  assert.equal(readFileSync(blockPath(), "utf8"), first);

  // Abandon the only goal → block removed.
  updateGoal(AGENT, g.id, { status: "abandoned" });
  syncGoalsBlockForAgent(AGENT);
  assert.equal(existsSync(blockPath()), false);
});
