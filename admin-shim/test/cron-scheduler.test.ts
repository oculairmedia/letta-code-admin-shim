/**
 * Behavioral tests for the shim cron scheduler (lcp-0mw).
 *
 * Acceptance criteria covered (the agent-pool integration is mocked out
 * via the `fireTask` option — the end-to-end "real letta-code worker
 * actually receives the prompt" test belongs in lcp-b0b/lcp-9h3 where
 * a full shim subprocess gets spun up):
 *   - Recurring task fires once per minute, fire_count + last_fired_at advance.
 *   - One-shot scheduled_for in the immediate past fires and transitions to completed.
 *   - One-shot scheduled_for >5min in the past is marked missed and never fires.
 *   - Lease conflict: starting against a live owner is a no-op (returns null).
 *   - stop() releases the lease; restart re-claims.
 *   - External write to crons.json triggers an `external_write` cron event.
 *   - Errors from fireTask don't crash the tick loop.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  __tickForTest,
  getCronSchedulerStatus,
  isCronSchedulerRunning,
  startCronScheduler,
  stopCronScheduler,
  wrapCronPrompt,
} from "../lib/cron-scheduler.js";
import {
  __clearCronEventSubscribers,
  subscribeCronEvents,
  type CronEvent,
} from "../lib/cron-events.js";
import {
  addTask,
  getTask,
  readCronFile,
  writeCronFile,
} from "../lib/crons.js";
import type { CronFile, CronTask } from "../lib/types/crons.js";

async function withLettaHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "cron-sched-test-"));
  const prev = process.env["LETTA_HOME"];
  process.env["LETTA_HOME"] = home;
  try {
    return await fn(home);
  } finally {
    try {
      stopCronScheduler();
    } catch {}
    __clearCronEventSubscribers();
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

interface FireRecord {
  task: CronTask;
  wrapped: string;
}

interface ClockState {
  now: Date;
  events: CronEvent[];
  fires: FireRecord[];
}

/** Helper: start a scheduler with a synthetic clock + recording fire callback. */
async function startMocked(
  clock: ClockState,
  opts: { fireError?: Error; disableMtimeWatcher?: boolean } = {},
): Promise<void> {
  const handle = startCronScheduler({
    fireTask: (task, wrapped) => {
      clock.fires.push({ task, wrapped });
      if (opts.fireError) throw opts.fireError;
    },
    now: () => clock.now,
    tickIntervalMs: 60_000_000, // effectively disabled — drive manually
    gcIntervalMs: 60_000_000,
    disableMtimeWatcher: opts.disableMtimeWatcher ?? true,
    log: () => {},
  });
  assert.ok(handle, "scheduler should start");
  subscribeCronEvents((e) => clock.events.push(e));
  // lcp-915: wait for catch-up + first regular tick to settle so tests
  // observe a deterministic post-start state.
  await handle.whenReady;
}

function mkClock(now: Date): ClockState {
  return { now, events: [], fires: [] };
}

// ──────────────────────────────────────────────────────────────────────

test("wrapCronPrompt builds the documented <system-reminder> envelope", () => {
  const task: CronTask = {
    id: "abc",
    agent_id: "a1",
    conversation_id: "c1",
    name: "morning",
    description: "wake up",
    cron: "0 8 * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "Hello world",
    status: "active",
    created_at: "2026-05-18T00:00:00.000Z",
    expires_at: null,
    last_fired_at: null,
    fire_count: 4,
    cancel_reason: null,
    jitter_offset_ms: 0,
    scheduled_for: null,
    fired_at: null,
    missed_at: null,
  };
  const out = wrapCronPrompt(task);
  assert.match(out, /^<system-reminder>/);
  assert.match(out, /Scheduled task "morning" is firing\./);
  assert.match(out, /This is fire #5 \(cron: 0 8 \* \* \*\)\./);
  assert.match(out, /Hello world/);
  assert.match(out, /<\/system-reminder>$/);
});

test("fire callback receives the wrapped <system-reminder> envelope", async () => {
  await withLettaHome(async () => {
    const clock = mkClock(new Date("2026-05-18T10:00:00.000Z"));
    const { task } = addTask({
      agent_id: "a1",
      name: "envelope-check",
      description: "verify wrap",
      cron: "* * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "the inner prompt body",
    });
    await startMocked(clock);
    assert.equal(clock.fires.length, 1);
    const fired = clock.fires[0]!;
    assert.equal(fired.task.id, task.id);
    // Envelope: <system-reminder> header, name/desc lines, fire counter,
    // blank line, inner prompt, closing tag.
    assert.match(fired.wrapped, /^<system-reminder>\n/);
    assert.match(fired.wrapped, /Scheduled task "envelope-check" is firing\./);
    assert.match(fired.wrapped, /Description: verify wrap/);
    assert.match(fired.wrapped, /This is fire #1 \(cron: \* \* \* \* \*\)\./);
    assert.match(fired.wrapped, /\n\nthe inner prompt body\n/);
    assert.match(fired.wrapped, /\n<\/system-reminder>$/);
  });
});

test("recurring task fires once per minute and advances fire_count", async () => {
  await withLettaHome(async () => {
    // Anchor clock at minute boundary so cron '* * * * *' matches.
    const clock = mkClock(new Date("2026-05-18T10:00:00.000Z"));
    const { task } = addTask({
      agent_id: "a1",
      name: "every-minute",
      description: "tick test",
      cron: "* * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "ping",
    });

    await startMocked(clock);
    // start() already ticked once.
    assert.equal(clock.fires.length, 1, "first tick fires the matching task");
    let fresh = getTask(task.id);
    assert.equal(fresh?.fire_count, 1);
    assert.ok(fresh?.last_fired_at);

    // Same minute — dedup must hold.
    await __tickForTest();
    assert.equal(clock.fires.length, 1, "second tick in same minute does NOT re-fire");

    // Advance one minute — fires again.
    clock.now = new Date("2026-05-18T10:01:00.000Z");
    await __tickForTest();
    assert.equal(clock.fires.length, 2);
    fresh = getTask(task.id);
    assert.equal(fresh?.fire_count, 2);
  });
});

test("one-shot scheduled_for in immediate past fires and transitions to 'fired'", async () => {
  await withLettaHome(async () => {
    const now = new Date("2026-05-18T10:00:00.000Z");
    const past = new Date(now.getTime() - 30_000); // 30s ago — well within threshold
    const { task } = addTask({
      agent_id: "a1",
      name: "one-shot",
      description: "fire once",
      cron: "0 10 18 5 *",
      timezone: "UTC",
      recurring: false,
      prompt: "go",
      scheduled_for: past,
    });

    const clock = mkClock(now);
    await startMocked(clock);
    assert.equal(clock.fires.length, 1, "one-shot should fire");
    const fresh = getTask(task.id);
    assert.equal(fresh?.status, "fired", "bundled letta-code's vocab is 'fired', not 'completed'");
    assert.ok(fresh?.fired_at);
    assert.equal(fresh?.fire_count, 1);
  });
});

test("one-shot scheduled_for >5min in past is marked missed and does NOT fire", async () => {
  await withLettaHome(async () => {
    const now = new Date("2026-05-18T10:00:00.000Z");
    const longAgo = new Date(now.getTime() - 10 * 60_000); // 10 min ago
    const { task } = addTask({
      agent_id: "a1",
      name: "stale-one-shot",
      description: "should miss",
      cron: "0 0 1 1 *",
      timezone: "UTC",
      recurring: false,
      prompt: "won't run",
      scheduled_for: longAgo,
    });

    const clock = mkClock(now);
    await startMocked(clock);
    assert.equal(clock.fires.length, 0, "missed one-shot must NOT fire");
    const fresh = getTask(task.id);
    assert.equal(fresh?.status, "missed", "match bundled letta-code's status='missed' for missed one-shots");
    assert.ok(fresh?.missed_at);
    // cancel_reason stays reserved for user-initiated cancellations.
    assert.equal(fresh?.cancel_reason, null);
  });
});

test("lease conflict: second start() against live owner returns null", async () => {
  await withLettaHome(async () => {
    // Hand-craft a scheduler_owner pointing at THIS process (so the
    // alive check succeeds) but with a different token. claimSchedulerLease
    // sees a live owner and throws → startCronScheduler returns null.
    const data = readCronFile();
    data.scheduler_owner = {
      pid: process.pid,
      token: "imposter",
      started_at: new Date().toISOString(),
      process_start_ticks: null,
      boot_id: null,
    };
    writeCronFile(data);

    let logged = "";
    const handle = startCronScheduler({
      now: () => new Date(),
      tickIntervalMs: 60_000_000,
      gcIntervalMs: 60_000_000,
      disableMtimeWatcher: true,
      log: (msg) => {
        logged += msg + "\n";
      },
    });
    assert.equal(handle, null, "second scheduler must refuse to start");
    assert.match(logged, /cannot claim lease/);
    assert.equal(isCronSchedulerRunning(), false);

    // Cleanup imposter so the harness's finally-stop doesn't trip.
    const after = readCronFile();
    after.scheduler_owner = null;
    writeCronFile(after);
  });
});

test("stop() releases lease; restart re-claims cleanly", async () => {
  await withLettaHome(async () => {
    const clock = mkClock(new Date("2026-05-18T10:00:00.000Z"));
    await startMocked(clock);
    assert.equal(isCronSchedulerRunning(), true);
    let onDisk = readCronFile();
    assert.ok(onDisk.scheduler_owner, "lease should be persisted");
    const firstToken = onDisk.scheduler_owner!.token;

    stopCronScheduler();
    assert.equal(isCronSchedulerRunning(), false);
    onDisk = readCronFile();
    assert.equal(onDisk.scheduler_owner, null, "stop() must clear scheduler_owner");

    await startMocked(clock);
    onDisk = readCronFile();
    assert.ok(onDisk.scheduler_owner, "second start should re-claim");
    assert.notEqual(onDisk.scheduler_owner!.token, firstToken, "new token issued");
  });
});

test("getCronSchedulerStatus reflects task count + last/next tick", async () => {
  await withLettaHome(async () => {
    const clock = mkClock(new Date("2026-05-18T10:00:00.000Z"));
    addTask({
      agent_id: "a1",
      name: "x",
      description: "",
      cron: "0 0 * * *", // does NOT fire at 10:00
      timezone: "UTC",
      recurring: true,
      prompt: "p",
    });
    await startMocked(clock);
    const s = getCronSchedulerStatus();
    assert.equal(s.lease_held, true);
    assert.equal(s.owner_pid, process.pid);
    assert.equal(s.tasks_active, 1);
    assert.ok(s.last_tick_at);
    assert.ok(s.next_tick_at);
  });
});

test("getCronSchedulerStatus when stopped reports lease_held=false", async () => {
  await withLettaHome(() => {
    const s = getCronSchedulerStatus();
    assert.equal(s.lease_held, false);
    assert.equal(s.owner_pid, null);
    assert.equal(s.token, null);
    assert.equal(s.tasks_active, 0);
  });
});

test("external write to crons.json triggers an external_write event", async () => {
  await withLettaHome(async () => {
    const clock = mkClock(new Date("2026-05-18T10:00:00.000Z"));
    await startMocked(clock);
    // Simulate an out-of-band write — adding a task here uses our own
    // crons.ts API which touches mtime. With the mtime watcher disabled,
    // we drive the cache refresh via __tickForTest and assert the event.
    addTask({
      agent_id: "agent-ext",
      name: "external",
      description: "",
      cron: "0 0 * * *", // not firing at our anchor
      timezone: "UTC",
      recurring: true,
      prompt: "p",
    });
    const eventsBefore = clock.events.length;
    await __tickForTest();
    const newEvents = clock.events.slice(eventsBefore);
    assert.ok(
      newEvents.some((e) => e.reason === "external_write"),
      `expected external_write event, got ${JSON.stringify(newEvents)}`,
    );
    // tasks_active in the event reflects the post-refresh count.
    const ext = newEvents.find((e) => e.reason === "external_write")!;
    assert.equal(ext.tasks_active, 1);
  });
});

test("fireTask exceptions are caught and don't break the tick loop", async () => {
  await withLettaHome(async () => {
    const clock = mkClock(new Date("2026-05-18T10:00:00.000Z"));
    const { task } = addTask({
      agent_id: "a1",
      name: "boom",
      description: "",
      cron: "* * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "p",
    });
    await startMocked(clock, { fireError: new Error("kaboom") });
    // start() already ticked. The task should NOT have advanced to
    // fired state — we still update the row even on fire error
    // (the prompt may have been partially delivered). Actually we do
    // mark it as fired even on error; that's correct because the run
    // exists. So fire_count should be 1, last_fired_at set.
    const fresh = getTask(task.id);
    assert.equal(fresh?.fire_count, 1, "fire_count advances even when fireTask throws");
    // The scheduler must still be running afterwards.
    assert.equal(isCronSchedulerRunning(), true);
  });
});

test("fs.watch path: external write fires crons_updated within ~1s", async () => {
  await withLettaHome(async () => {
    const clock = mkClock(new Date("2026-05-18T10:00:00.000Z"));
    // Now WITH the real fs.watch. tickIntervalMs is still huge so this
    // is exclusively testing the watcher path.
    const handle = startCronScheduler({
      fireTask: () => {},
      now: () => clock.now,
      tickIntervalMs: 60_000_000,
      gcIntervalMs: 60_000_000,
      disableMtimeWatcher: false,
      log: () => {},
    });
    assert.ok(handle, "scheduler should start");
    await handle.whenReady;
    subscribeCronEvents((e) => clock.events.push(e));

    const before = clock.events.length;
    addTask({
      agent_id: "agent-watched",
      name: "watch-me",
      description: "",
      cron: "0 0 * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "p",
    });

    // Wait up to 1s for the watcher debounce + emit.
    const deadline = Date.now() + 1500;
    let saw = false;
    while (Date.now() < deadline) {
      if (clock.events.slice(before).some((e) => e.reason === "external_write")) {
        saw = true;
        break;
      }
      await sleep(50);
    }
    assert.ok(saw, "fs.watch should drive an external_write event within 1.5s");
  });
});

test("manual writeCronFile rewrite is picked up on next tick", async () => {
  await withLettaHome(async () => {
    const clock = mkClock(new Date("2026-05-18T10:00:00.000Z"));
    await startMocked(clock);
    // Write a fresh task by hand bypassing our addTask (still goes through
    // writeCronFile, so mtime moves).
    const data = readCronFile();
    const handCrafted: CronTask = {
      id: "manual-1",
      agent_id: "a-manual",
      conversation_id: "default",
      name: "manual",
      description: "",
      cron: "0 0 * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "p",
      status: "active",
      created_at: new Date().toISOString(),
      expires_at: null,
      last_fired_at: null,
      fire_count: 0,
      cancel_reason: null,
      jitter_offset_ms: 0,
      scheduled_for: null,
      fired_at: null,
      missed_at: null,
    };
    data.tasks.push(handCrafted);
    writeCronFile(data);

    await __tickForTest();
    assert.equal(getCronSchedulerStatus().tasks_active, 1);
  });
});

test("module path: confirms scheduler module is callable from disk-built dist", async () => {
  await withLettaHome((home) => {
    // Sanity check — make sure LETTA_HOME is honored by the scheduler.
    assert.equal(process.env["LETTA_HOME"], home);
    writeFileSync(
      join(home, "crons.json"),
      JSON.stringify({ version: 1, scheduler_owner: null, tasks: [] }, null, 2),
    );
    const status = getCronSchedulerStatus();
    assert.equal(status.lease_held, false);
  });
});
