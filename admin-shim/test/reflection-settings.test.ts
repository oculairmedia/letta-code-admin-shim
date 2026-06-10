/**
 * lcp-4d5f: per-agent reflection (sleeptime) settings store.
 *
 * Pinned contracts:
 *   - Unset agents report letta-code defaults (compaction-event / reminder / 25)
 *     with persisted=false, and sleeptimeOptionsForAgent returns undefined so
 *     session resume preserves CLI defaults.
 *   - set merges partial updates over current values, persists atomically,
 *     and survives re-read from disk.
 *   - Invalid trigger/behavior/step_count are rejected without persisting.
 *   - A successful set broadcasts a ReflectionSettingsEvent to subscribers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_REFLECTION_SETTINGS,
  getReflectionSettings,
  setReflectionSettings,
  sleeptimeOptionsForAgent,
  subscribeReflectionEvents,
  type ReflectionSettingsEvent,
} from "../lib/reflection-settings.js";

async function withBackendDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "reflection-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("unset agent reports defaults and no sleeptime override", async () => {
  await withBackendDir(async () => {
    const settings = getReflectionSettings("agent-fresh");
    assert.equal(settings.trigger, DEFAULT_REFLECTION_SETTINGS.trigger);
    assert.equal(settings.behavior, DEFAULT_REFLECTION_SETTINGS.behavior);
    assert.equal(settings.step_count, DEFAULT_REFLECTION_SETTINGS.step_count);
    assert.equal(settings.persisted, false);
    assert.equal(sleeptimeOptionsForAgent("agent-fresh"), undefined);
  });
});

test("set merges partial updates and persists", async () => {
  await withBackendDir(async () => {
    const first = setReflectionSettings("agent-a", { trigger: "step-count", step_count: 10 });
    assert.ok(first.success);
    assert.equal(first.settings.trigger, "step-count");
    assert.equal(first.settings.step_count, 10);
    assert.equal(first.settings.behavior, "reminder");

    // Partial update keeps the earlier override.
    const second = setReflectionSettings("agent-a", { behavior: "auto-launch" });
    assert.ok(second.success);
    assert.equal(second.settings.trigger, "step-count");
    assert.equal(second.settings.step_count, 10);
    assert.equal(second.settings.behavior, "auto-launch");

    // Re-read from disk (no in-memory cache in this module).
    const reread = getReflectionSettings("agent-a");
    assert.equal(reread.persisted, true);
    assert.equal(reread.trigger, "step-count");
    assert.equal(reread.behavior, "auto-launch");
    assert.equal(reread.step_count, 10);
    assert.ok(typeof reread.updated_at === "string");

    const sleeptime = sleeptimeOptionsForAgent("agent-a");
    assert.deepEqual(sleeptime, { trigger: "step-count", behavior: "auto-launch", stepCount: 10 });
  });
});

test("invalid inputs are rejected and nothing persists", async () => {
  await withBackendDir(async () => {
    const badTrigger = setReflectionSettings("agent-b", { trigger: "hourly" });
    assert.equal(badTrigger.success, false);
    const badBehavior = setReflectionSettings("agent-b", { behavior: "loud" });
    assert.equal(badBehavior.success, false);
    const badCount = setReflectionSettings("agent-b", { step_count: 0 });
    assert.equal(badCount.success, false);
    const badCount2 = setReflectionSettings("agent-b", { step_count: "soon" });
    assert.equal(badCount2.success, false);

    assert.equal(getReflectionSettings("agent-b").persisted, false);
  });
});

test("successful set broadcasts to subscribers; unsubscribe stops delivery", async () => {
  await withBackendDir(async () => {
    const events: ReflectionSettingsEvent[] = [];
    const unsubscribe = subscribeReflectionEvents((event) => events.push(event));
    try {
      const result = setReflectionSettings("agent-c", { trigger: "off" });
      assert.ok(result.success);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.agent_id, "agent-c");
      assert.equal(events[0]!.settings.trigger, "off");
      assert.ok(typeof events[0]!.at === "string");

      // Failed sets do not broadcast.
      setReflectionSettings("agent-c", { trigger: "bogus" });
      assert.equal(events.length, 1);
    } finally {
      unsubscribe();
    }
    setReflectionSettings("agent-c", { trigger: "step-count" });
    assert.equal(events.length, 1);
  });
});
