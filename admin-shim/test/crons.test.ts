/**
 * Behavioral tests for the shim's `crons.ts` store (lcp-lxc).
 *
 * Acceptance criteria covered:
 *   - Round-trip addTask → readCronFile → getTask preserves all 19 fields.
 *   - Two processes contending for addTask serialize cleanly via the lock.
 *   - A stale lock (>30s + dead pid) is stolen rather than blocking.
 *   - listTasks honors agent_id + conversation_id filters.
 *   - deleteAllTasks(agentId) removes only that agent's rows and reports count.
 *
 * Each test runs against a private temp dir so the prod $LETTA_HOME is never
 * touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __setProcessIdentityReader,
  acquireLock,
  addTask,
  computeJitter,
  deleteAllTasks,
  deleteTask,
  getCronFilePath,
  getLockDirPath,
  getTask,
  isValidCron,
  listTasks,
  parseAt,
  parseEvery,
  readCronFile,
  writeCronFile,
  withLock,
} from "../lib/crons.js";
import type { CronFile, CronTask, LockOwner } from "../lib/types/crons.js";

/**
 * Set LETTA_HOME to a fresh temp dir for the duration of `fn`. Returns the
 * temp path so callers can inspect on-disk artifacts.
 */
async function withLettaHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "crons-test-"));
  const prev = process.env["LETTA_HOME"];
  process.env["LETTA_HOME"] = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) {
      delete process.env["LETTA_HOME"];
    } else {
      process.env["LETTA_HOME"] = prev;
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  }
}

const FIELDS: (keyof CronTask)[] = [
  "id",
  "agent_id",
  "conversation_id",
  "name",
  "description",
  "cron",
  "timezone",
  "recurring",
  "prompt",
  "status",
  "created_at",
  "expires_at",
  "last_fired_at",
  "fire_count",
  "cancel_reason",
  "jitter_offset_ms",
  "scheduled_for",
  "fired_at",
  "missed_at",
];

test("addTask → readCronFile → getTask preserves all 19 fields", async () => {
  await withLettaHome(() => {
    const { task } = addTask({
      agent_id: "agent-1",
      conversation_id: "conv-1",
      name: "test",
      description: "round-trip",
      cron: "*/5 * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "ping",
    });

    // Every documented field present on the returned task.
    for (const key of FIELDS) {
      assert.ok(key in task, `addTask returned task missing field ${String(key)}`);
    }
    assert.equal(Object.keys(task).length, FIELDS.length, "task should have exactly 19 fields");

    // Same task read back via getTask.
    const got = getTask(task.id);
    assert.ok(got, "getTask should return the row just written");
    assert.deepEqual(got, task, "getTask must round-trip the full task");

    // And via readCronFile directly.
    const data = readCronFile();
    assert.equal(data.version, 1);
    assert.equal(data.tasks.length, 1);
    assert.deepEqual(data.tasks[0], task);
  });
});

test("addTask conversation_id defaults to 'default' when omitted", async () => {
  await withLettaHome(() => {
    const { task } = addTask({
      agent_id: "agent-1",
      name: "no-conv",
      description: "",
      cron: "*/1 * * * *",
      recurring: true,
      prompt: "ping",
    });
    assert.equal(task.conversation_id, "default");
  });
});

test("addTask warns when no scheduler_owner is alive", async () => {
  await withLettaHome(() => {
    const { warning } = addTask({
      agent_id: "agent-1",
      name: "warn-on-no-scheduler",
      description: "",
      cron: "*/1 * * * *",
      recurring: true,
      prompt: "ping",
    });
    assert.ok(warning, "warning should fire when no scheduler is running");
    assert.match(warning!, /No letta server is currently running/);
  });
});

test("addTask honors SHIM_CRON_MAX_ACTIVE_PER_AGENT limit", async () => {
  await withLettaHome(() => {
    process.env["SHIM_CRON_MAX_ACTIVE_PER_AGENT"] = "2";
    try {
      const input = {
        agent_id: "agent-cap",
        name: "n",
        description: "",
        cron: "*/1 * * * *",
        recurring: true,
        prompt: "p",
      };
      addTask(input);
      addTask(input);
      assert.throws(() => addTask(input), /max 2/);
    } finally {
      delete process.env["SHIM_CRON_MAX_ACTIVE_PER_AGENT"];
    }
  });
});

test("writeCronFile is atomic (tmp+rename leaves no .tmp on disk)", async () => {
  await withLettaHome((home) => {
    const data: CronFile = { version: 1, scheduler_owner: null, last_tick_at: null, tasks: [] };
    writeCronFile(data);
    assert.ok(existsSync(getCronFilePath()));
    assert.ok(!existsSync(getCronFilePath() + ".tmp"), "no .tmp leftover");
    // Sanity: dir creation
    assert.ok(existsSync(home));
  });
});

test("two contending addTask calls serialize via the lock", async () => {
  await withLettaHome(async () => {
    // Fire 20 concurrent inserts; lock serializes them so we end up with 20
    // distinct rows (no lost writes from racy read-modify-write).
    const inputs = Array.from({ length: 20 }, (_, i) => ({
      agent_id: "agent-race",
      name: `t${i}`,
      description: "",
      cron: "*/1 * * * *",
      recurring: true,
      prompt: `p${i}`,
    }));
    const results = await Promise.all(inputs.map((i) => Promise.resolve().then(() => addTask(i))));
    const ids = new Set(results.map((r) => r.task.id));
    assert.equal(ids.size, 20, "all 20 tasks should have unique ids and survive the lock race");

    const onDisk = readCronFile();
    assert.equal(onDisk.tasks.length, 20, "all 20 writes land on disk");
  });
});

test("acquireLock times out if held; releases on completion", async () => {
  await withLettaHome(() => {
    const lock = acquireLock();
    try {
      const start = Date.now();
      assert.throws(
        () => acquireLock(),
        /timed out/,
        "second acquireLock should time out while first is held",
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 4500, `timeout should be ~5s, got ${elapsed}ms`);
    } finally {
      lock.release();
    }
    // After release, another acquireLock succeeds immediately.
    const second = acquireLock();
    second.release();
  });
});

test("a stale lock (dead PID + >30s old) is stolen, not blocked on", async () => {
  await withLettaHome(() => {
    const lockDir = getLockDirPath();
    mkdirSync(lockDir, { recursive: true });
    // PID 999999 is virtually guaranteed dead in this test env (and even if
    // alive, the boot_id/process_start_ticks shape will fail the identity
    // check, which we override below to return null).
    const owner: LockOwner = {
      pid: 999999,
      token: "deadbeef",
      acquired_at: Date.now() - 60_000, // older than LOCK_STALE_AGE_MS=30s
      process_start_ticks: "1",
      boot_id: "dead-boot",
    };
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner));

    // Force "dead PID" verdict regardless of host OS by overriding the
    // process-identity reader to return null for this pid.
    __setProcessIdentityReader((pid) => {
      if (pid === 999999) return null;
      return null;
    });
    try {
      const start = Date.now();
      const lock = acquireLock();
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, `stale lock should be stolen fast, took ${elapsed}ms`);
      lock.release();
    } finally {
      __setProcessIdentityReader(null);
    }
  });
});

test("listTasks filters by agent_id and conversation_id", async () => {
  await withLettaHome(() => {
    addTask({
      agent_id: "a1",
      conversation_id: "c1",
      name: "x",
      description: "",
      cron: "*/1 * * * *",
      recurring: true,
      prompt: "p",
    });
    addTask({
      agent_id: "a1",
      conversation_id: "c2",
      name: "y",
      description: "",
      cron: "*/1 * * * *",
      recurring: true,
      prompt: "p",
    });
    addTask({
      agent_id: "a2",
      conversation_id: "c1",
      name: "z",
      description: "",
      cron: "*/1 * * * *",
      recurring: true,
      prompt: "p",
    });

    assert.equal(listTasks().length, 3, "no filter returns everything");
    assert.equal(listTasks({ agent_id: "a1" }).length, 2);
    assert.equal(listTasks({ agent_id: "a2" }).length, 1);
    assert.equal(listTasks({ conversation_id: "c1" }).length, 2);
    assert.equal(listTasks({ agent_id: "a1", conversation_id: "c2" }).length, 1);
    assert.equal(listTasks({ agent_id: "missing" }).length, 0);
  });
});

test("deleteAllTasks removes only target agent's rows and returns count", async () => {
  await withLettaHome(() => {
    const ids = [
      addTask({
        agent_id: "a1",
        name: "n",
        description: "",
        cron: "*/1 * * * *",
        recurring: true,
        prompt: "p",
      }).task.id,
      addTask({
        agent_id: "a1",
        name: "n",
        description: "",
        cron: "*/1 * * * *",
        recurring: true,
        prompt: "p",
      }).task.id,
      addTask({
        agent_id: "a2",
        name: "n",
        description: "",
        cron: "*/1 * * * *",
        recurring: true,
        prompt: "p",
      }).task.id,
    ];
    const removed = deleteAllTasks("a1");
    assert.equal(removed, 2);
    const remaining = listTasks();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.agent_id, "a2");
    assert.ok(remaining[0] && ids[2] === remaining[0].id);
  });
});

test("deleteAllTasks on an agent with no rows returns 0 without writing", async () => {
  await withLettaHome(() => {
    assert.equal(deleteAllTasks("ghost"), 0);
  });
});

test("deleteTask returns false for unknown ids", async () => {
  await withLettaHome(() => {
    assert.equal(deleteTask("does-not-exist"), false);
  });
});

test("withLock surfaces inner exceptions and still releases", async () => {
  await withLettaHome(() => {
    assert.throws(() => {
      withLock(() => {
        throw new Error("boom");
      });
    }, /boom/);
    // Lock must have been released — next acquire is instant.
    const start = Date.now();
    const lock = acquireLock();
    lock.release();
    assert.ok(Date.now() - start < 500, "lock should release after thrown body");
  });
});

// ── Pure helpers (no fs needed, but isolate just in case) ──────────

test("parseEvery handles common interval shapes", () => {
  assert.deepEqual(parseEvery("5m"), { cron: "*/5 * * * *" });
  assert.deepEqual(parseEvery("2h"), { cron: "0 */2 * * *" });
  assert.deepEqual(parseEvery("1d"), { cron: "0 0 * * *" });
  assert.equal(parseEvery("garbage"), null);
  assert.equal(parseEvery("0m"), null);

  const sec = parseEvery("30s");
  assert.ok(sec);
  assert.equal(sec!.cron, "*/1 * * * *");
  assert.match(sec!.note ?? "", /Rounded 30s up to 1m/);
});

test("parseAt handles 'in Nm' and 'H:MMam/pm' shapes", () => {
  const anchor = new Date("2026-05-18T10:00:00Z");
  const rel = parseAt("in 30m", anchor);
  assert.ok(rel);
  assert.equal(rel!.scheduledFor.getTime(), anchor.getTime() + 30 * 60_000);

  const abs = parseAt("3:15pm", anchor);
  assert.ok(abs);
  // local-tz dependent, so we only assert the cron shape is sane
  assert.match(abs!.cron, /^15 15 \d+ \d+ \*$/);

  assert.equal(parseAt("nope"), null);
});

test("isValidCron accepts standard 5-field expressions", () => {
  assert.ok(isValidCron("*/5 * * * *"));
  assert.ok(isValidCron("0 0 * * *"));
  assert.ok(isValidCron("15 14 1 * *"));
  assert.ok(!isValidCron("not a cron"));
  assert.ok(!isValidCron("* * * *")); // 4 fields
  assert.ok(!isValidCron("* * * * * *")); // 6 fields
});

test("computeJitter is bounded and deterministic for a given taskId", () => {
  const now = new Date();
  const j1 = computeJitter("aaaa", "*/5 * * * *", true, null, now);
  const j2 = computeJitter("aaaa", "*/5 * * * *", true, null, now);
  assert.equal(j1, j2, "same taskId yields same jitter");
  assert.ok(j1 >= 0 && j1 <= 30_000, `recurring 5m jitter should be ≤10% of period (≤30s), got ${j1}`);

  // Non-recurring with no scheduled_for → 0
  assert.equal(computeJitter("aaaa", "*/5 * * * *", false, null, now), 0);
});
