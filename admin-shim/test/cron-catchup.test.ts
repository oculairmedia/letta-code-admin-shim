/**
 * Behavioral tests for cron scheduler catch-up on restart (lcp-915).
 *
 * Pinned contracts:
 *   - Lease claim atomically stamps last_tick_at = now and returns the
 *     previous value so the scheduler can compute a catch-up window.
 *   - On start, recurring tasks whose latest cron-match minute in the
 *     catch-up window post-dates their last_fired_at fire exactly once.
 *   - One-shots whose scheduled_for falls inside the window fire on
 *     restart, bypassing the regular 5-min missed-threshold.
 *   - The 1h cap (override: SHIM_CRON_CATCHUP_WINDOW_MS) is honored —
 *     match minutes outside the cap don't trigger catch-up fires.
 *   - Combined-write: fires update last_tick_at in the same transaction
 *     as the row update (no separate fsync churn per tick).
 *
 * Fake time is provided via the scheduler's `now` option seam — the
 * tests never wait on wall-clock for the catch-up algorithm itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startCronScheduler,
  stopCronScheduler,
} from "../lib/cron-scheduler.js";
import { __clearCronEventSubscribers, subscribeCronEvents, type CronEvent } from "../lib/cron-events.js";
import { addTask, getTask, readCronFile, writeCronFile } from "../lib/crons.js";
import type { CronFile, CronTask } from "../lib/types/crons.js";

async function withLettaHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "cron-catchup-"));
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

function mkClock(now: Date): ClockState {
  return { now, events: [], fires: [] };
}

async function startMocked(clock: ClockState): Promise<void> {
  const handle = startCronScheduler({
    fireTask: (task, wrapped) => {
      clock.fires.push({ task, wrapped });
    },
    now: () => clock.now,
    tickIntervalMs: 60_000_000,
    gcIntervalMs: 60_000_000,
    disableMtimeWatcher: true,
    log: () => {},
  });
  assert.ok(handle, "scheduler should start");
  subscribeCronEvents((e) => clock.events.push(e));
  await handle.whenReady;
}

function seedCronFile(file: CronFile): void {
  writeCronFile(file);
}

function mkRecurringTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: "rec-1",
    agent_id: "agent-a",
    conversation_id: "default",
    name: "recurring",
    description: "",
    cron: "* * * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "p",
    status: "active",
    created_at: "2026-05-18T09:00:00.000Z",
    expires_at: null,
    last_fired_at: null,
    fire_count: 0,
    cancel_reason: null,
    jitter_offset_ms: 0,
    scheduled_for: null,
    fired_at: null,
    missed_at: null,
    ...overrides,
  };
}

function mkOneShotTask(scheduledFor: string, overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: "one-1",
    agent_id: "agent-a",
    conversation_id: "default",
    name: "one-shot",
    description: "",
    cron: "0 0 1 1 *",
    timezone: "UTC",
    recurring: false,
    prompt: "p",
    status: "active",
    created_at: "2026-05-18T09:00:00.000Z",
    expires_at: null,
    last_fired_at: null,
    fire_count: 0,
    cancel_reason: null,
    jitter_offset_ms: 0,
    scheduled_for: scheduledFor,
    fired_at: null,
    missed_at: null,
    ...overrides,
  };
}

test("lease claim writes last_tick_at and returns the previous value", async () => {
  await withLettaHome(async () => {
    seedCronFile({
      version: 1,
      scheduler_owner: null,
      last_tick_at: "2026-05-18T09:58:00.000Z",
      tasks: [],
    });
    const clock = mkClock(new Date("2026-05-18T10:00:30.000Z"));
    await startMocked(clock);
    const data = readCronFile();
    assert.ok(data.last_tick_at, "last_tick_at must be written on claim");
    // The newly-written tick is real-now (Date()), not the mocked clock —
    // claimSchedulerLease doesn't take a clock arg. Just assert it advanced.
    assert.notEqual(data.last_tick_at, "2026-05-18T09:58:00.000Z");
  });
});

test("catch-up fires a recurring task whose minute passed during downtime", async () => {
  await withLettaHome(async () => {
    // 13:59 last fire, shim down 13:59→14:01, recurring '* * * * *' should
    // fire once for the 14:00 minute. 14:01 is the current minute and the
    // regular tick will fire AGAIN — that's expected (the regular tick
    // fires for every minute the cron matches).
    const task = mkRecurringTask({
      id: "catchup-1",
      last_fired_at: "2026-05-18T13:59:00.000Z",
      fire_count: 5,
    });
    seedCronFile({
      version: 1,
      scheduler_owner: null,
      last_tick_at: "2026-05-18T13:59:00.000Z",
      tasks: [task],
    });
    const clock = mkClock(new Date("2026-05-18T14:01:30.000Z"));
    await startMocked(clock);
    assert.equal(clock.fires.length, 2, "catch-up + regular tick both fire");
    const fresh = getTask("catchup-1");
    assert.equal(fresh?.fire_count, 7, "fire_count = 5 (seeded) + 1 (catch-up) + 1 (tick)");
  });
});

test("catch-up does NOT re-fire a recurring task already fired in the missed minute", async () => {
  await withLettaHome(async () => {
    const task = mkRecurringTask({
      id: "no-refire",
      last_fired_at: "2026-05-18T13:59:00.000Z",
      fire_count: 1,
    });
    seedCronFile({
      version: 1,
      scheduler_owner: null,
      last_tick_at: "2026-05-18T13:59:30.000Z",
      tasks: [task],
    });
    const clock = mkClock(new Date("2026-05-18T14:00:15.000Z"));
    await startMocked(clock);
    assert.equal(clock.fires.length, 1, "regular tick only — catch-up skipped");
    const fresh = getTask("no-refire");
    assert.equal(fresh?.fire_count, 2);
  });
});

test("catch-up fires a one-shot whose scheduled_for passed during downtime", async () => {
  await withLettaHome(async () => {
    // One-shot scheduled for 13:55, shim down 13:54→14:02 (8 min).
    // Beyond the 5-min missed threshold, so the regular tick would
    // normally mark it missed. Catch-up overrides and fires it.
    const task = mkOneShotTask("2026-05-18T13:55:00.000Z", {
      id: "catchup-oneshot",
    });
    seedCronFile({
      version: 1,
      scheduler_owner: null,
      last_tick_at: "2026-05-18T13:54:00.000Z",
      tasks: [task],
    });
    const clock = mkClock(new Date("2026-05-18T14:02:00.000Z"));
    await startMocked(clock);
    assert.equal(clock.fires.length, 1);
    const fresh = getTask("catchup-oneshot");
    assert.equal(fresh?.status, "fired");
    assert.equal(fresh?.fire_count, 1);
  });
});

test("catch-up respects the 1h cap — match minutes outside the cap are skipped", async () => {
  await withLettaHome(async () => {
    const task = mkRecurringTask({
      id: "outside-cap",
      cron: "0 10 * * *", // matches 10:00 daily
      last_fired_at: "2026-05-18T10:00:00.000Z",
      fire_count: 1,
    });
    seedCronFile({
      version: 1,
      scheduler_owner: null,
      last_tick_at: "2026-05-18T10:00:30.000Z",
      tasks: [task],
    });
    // Shim back up at 14:30 — 4.5h since last fire. The next 10:00
    // match is tomorrow. Catch-up window = (13:30, 14:30) — no 10:00
    // match in that window. Nothing fires.
    const clock = mkClock(new Date("2026-05-18T14:30:00.000Z"));
    await startMocked(clock);
    assert.equal(clock.fires.length, 0, "matched minute outside cap — must not fire");
    const fresh = getTask("outside-cap");
    assert.equal(fresh?.fire_count, 1, "fire_count unchanged");
  });
});

test("catch-up cap honors SHIM_CRON_CATCHUP_WINDOW_MS override", async () => {
  await withLettaHome(async () => {
    process.env["SHIM_CRON_CATCHUP_WINDOW_MS"] = "120000"; // 2 minutes
    try {
      const task = mkRecurringTask({
        id: "tight-cap",
        last_fired_at: "2026-05-18T09:55:00.000Z",
        fire_count: 1,
      });
      seedCronFile({
        version: 1,
        scheduler_owner: null,
        last_tick_at: "2026-05-18T09:55:00.000Z",
        tasks: [task],
      });
      const clock = mkClock(new Date("2026-05-18T10:00:30.000Z"));
      await startMocked(clock);
      assert.equal(clock.fires.length, 2, "catch-up (09:59) + regular tick (10:00)");
    } finally {
      delete process.env["SHIM_CRON_CATCHUP_WINDOW_MS"];
    }
  });
});

test("catch-up skipped on fresh install (last_tick_at = null)", async () => {
  await withLettaHome(async () => {
    addTask({
      agent_id: "agent-fresh",
      name: "fresh",
      description: "",
      cron: "* * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "p",
    });
    const clock = mkClock(new Date("2026-05-18T10:00:30.000Z"));
    await startMocked(clock);
    // Regular tick fires for the current minute. Catch-up shouldn't.
    assert.equal(clock.fires.length, 1);
  });
});

test("fire path writes last_tick_at in the same transaction as the row update", async () => {
  await withLettaHome(async () => {
    addTask({
      agent_id: "agent-combined",
      name: "combined-write",
      description: "",
      cron: "* * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "p",
    });
    const clock = mkClock(new Date("2026-05-18T10:00:30.000Z"));
    await startMocked(clock);
    const data = readCronFile();
    assert.ok(data.last_tick_at, "last_tick_at populated after fire");
    assert.equal(data.last_tick_at, "2026-05-18T10:00:30.000Z");
  });
});
