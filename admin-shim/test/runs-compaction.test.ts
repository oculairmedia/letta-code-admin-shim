/**
 * lcp-98cm: runs-directory compaction.
 *
 * compactRuns MOVES terminal runs older than the retention window into the
 * `_archive` subdir (atomic rename, lossless). Asserts:
 *   - the live root is bounded to `retain` after compaction,
 *   - archived (old, terminal) runs are still resolvable via getRun,
 *   - in-flight ("running") runs are never archived,
 *   - listRuns excludes archived runs by default and includes them with
 *     { includeArchived: true }.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compactRuns, listRuns, getRun, listRunSteps } from "../lib/runs.js";

function withTempBackend<T>(fn: (runsRoot: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "lcp-98cm-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return fn(join(dir, "runs"));
  } finally {
    if (prev !== undefined) process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    else delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRun(runsRoot: string, id: string, status: string, createdAt: string) {
  const d = join(runsRoot, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "run.json"),
    JSON.stringify({
      id,
      status,
      created_at: createdAt,
      agent_id: "agent-x",
      conversation_id: "conv-x",
    }),
  );
}

test("compactRuns bounds the live dir, keeps newest, archives oldest, resolves both", () => {
  withTempBackend((runsRoot) => {
    // 5 terminal runs, ascending age via created_at.
    for (let i = 0; i < 5; i++) {
      writeRun(runsRoot, `run-${i}`, "completed", `2026-05-2${i}T00:00:00.000Z`);
    }
    const { archived, scanned } = compactRuns({ retain: 2 });
    assert.equal(scanned, 5);
    assert.equal(archived, 3, "oldest 3 of 5 should be archived");

    // Live root holds only the newest 2 run dirs (+ the _archive subdir).
    const liveDirs = readdirSync(runsRoot).filter((n) => n !== "_archive");
    assert.deepEqual(liveDirs.sort(), ["run-3", "run-4"]);
    assert.ok(existsSync(join(runsRoot, "_archive", "run-0", "run.json")));

    // Archived runs still resolve by id.
    assert.equal(getRun("run-0")?.id, "run-0");
    assert.equal(getRun("run-4")?.id, "run-4");

    // Default listRuns excludes archived; includeArchived re-includes them.
    const liveIds = listRuns({ limit: 100 }).map((r) => r.id).sort();
    assert.deepEqual(liveIds, ["run-3", "run-4"]);
    const allIds = listRuns({ limit: 100, includeArchived: true }).map((r) => r.id).sort();
    assert.deepEqual(allIds, ["run-0", "run-1", "run-2", "run-3", "run-4"]);
  });
});

test("an archived run's steps still resolve after compaction", () => {
  withTempBackend((runsRoot) => {
    writeRun(runsRoot, "run-keep", "completed", "2026-05-20T00:00:00.000Z");
    writeRun(runsRoot, "run-old", "completed", "2026-05-01T00:00:00.000Z");
    // Give the soon-to-be-archived run a steps.jsonl.
    writeFileSync(
      join(runsRoot, "run-old", "steps.jsonl"),
      JSON.stringify({ id: "step-1", created_at: "2026-05-01T00:00:01.000Z" }) + "\n",
    );
    const { archived } = compactRuns({ retain: 1 });
    assert.equal(archived, 1);
    assert.ok(existsSync(join(runsRoot, "_archive", "run-old", "steps.jsonl")), "steps moved with the run");
    const steps = listRunSteps("run-old");
    assert.equal(steps.length, 1, "listRunSteps must resolve the archived steps file");
    assert.equal(steps[0]?.id, "step-1");
  });
});

test("compactRuns never archives a running run, even if old", () => {
  withTempBackend((runsRoot) => {
    writeRun(runsRoot, "run-old-running", "running", "2026-01-01T00:00:00.000Z");
    writeRun(runsRoot, "run-a", "completed", "2026-05-10T00:00:00.000Z");
    writeRun(runsRoot, "run-b", "completed", "2026-05-11T00:00:00.000Z");
    writeRun(runsRoot, "run-c", "completed", "2026-05-12T00:00:00.000Z");
    // retain=1 would normally archive the 3 oldest, but the oldest is running.
    const { archived } = compactRuns({ retain: 1 });
    assert.equal(archived, 2, "only the two old terminal runs move");
    assert.ok(existsSync(join(runsRoot, "run-old-running", "run.json")), "running run stays live");
    assert.ok(!existsSync(join(runsRoot, "_archive", "run-old-running")));
  });
});

test("compactRuns is a no-op when at or under retention", () => {
  withTempBackend((runsRoot) => {
    writeRun(runsRoot, "run-1", "completed", "2026-05-10T00:00:00.000Z");
    writeRun(runsRoot, "run-2", "completed", "2026-05-11T00:00:00.000Z");
    const { archived, scanned } = compactRuns({ retain: 5 });
    assert.equal(scanned, 2);
    assert.equal(archived, 0);
    assert.ok(!existsSync(join(runsRoot, "_archive")));
  });
});
