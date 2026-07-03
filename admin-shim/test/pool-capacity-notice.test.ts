/**
 * lcp hr5rw (§3a.7) — Matrix/room error notice for typed pool-capacity
 * rejections. handleInbound posts `poolCapacityNotice(err).text` via the
 * adapter's sendDirectReply when (and only when) the turn failed with a
 * typed capacity code; every other error keeps today's silent behavior.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const backendDir = mkdtempSync(join(tmpdir(), "capacity-notice-"));
process.env["LETTA_LOCAL_BACKEND_DIR"] = backendDir;
process.on("exit", () => rmSync(backendDir, { recursive: true, force: true }));

import { poolCapacityNotice } from "../lib/channel-registry.js";
import { PoolCapacityError } from "../lib/agent-pool.js";

test("pool_saturated / pool_queue_timeout / cancelled → typed room notice", () => {
  const saturated = poolCapacityNotice(new PoolCapacityError("pool_saturated", "queue full"));
  assert.ok(saturated);
  assert.equal(saturated.code, "pool_saturated");
  assert.match(saturated.text, /busy.*retry/i);

  const timeout = poolCapacityNotice(new PoolCapacityError("pool_queue_timeout", "no capacity"));
  assert.ok(timeout);
  assert.equal(timeout.code, "pool_queue_timeout");
  assert.match(timeout.text, /busy.*retry/i);

  const cancelled = poolCapacityNotice(new PoolCapacityError("cancelled", "cancelled while queued"));
  assert.ok(cancelled);
  assert.equal(cancelled.code, "cancelled");
  assert.match(cancelled.text, /cancelled/i);

  // Duck-typed code (error crossed a module boundary) still maps.
  const duck = poolCapacityNotice(Object.assign(new Error("x"), { code: "pool_saturated" }));
  assert.ok(duck);
  assert.equal(duck.code, "pool_saturated");
});

test("unrelated errors → no room notice (silent behavior preserved)", () => {
  assert.equal(poolCapacityNotice(new Error("boom")), null);
  assert.equal(poolCapacityNotice(Object.assign(new Error("x"), { code: "something_else" })), null);
  assert.equal(poolCapacityNotice(null), null);
  assert.equal(poolCapacityNotice(undefined), null);
  assert.equal(poolCapacityNotice("string error"), null);
});
