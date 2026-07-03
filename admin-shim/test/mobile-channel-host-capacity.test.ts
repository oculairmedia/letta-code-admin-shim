/**
 * lcp hr5rw (§3a.7) — mobile WS path: pool-capacity rejections must not
 * leak the pre-created run.
 *
 * bridgeSendMessage pre-creates the Run (status "running", _activeRuns,
 * turn_started via onRunCreated) BEFORE pool.runTurnWithHeal. When the
 * pool rejects with a typed capacity error (pool_saturated 429 /
 * pool_queue_timeout 503 / cancelled), the run must be finalized with a
 * terminal frame — not left "running" forever in _activeRuns and run.json.
 *
 * Harness: pool.runTurnWithHeal monkeypatched (same pattern as
 * mobile-channel-host-coalescer.test.ts) so no real SDK session spawns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate all disk side effects (run records, frames.jsonl).
const backendDir = mkdtempSync(join(tmpdir(), "mobile-capacity-"));
process.env["LETTA_LOCAL_BACKEND_DIR"] = backendDir;
process.on("exit", () => rmSync(backendDir, { recursive: true, force: true }));

import { bridgeSendMessage } from "../lib/mobile-channel-host.js";
import { getAgentPool, PoolCapacityError } from "../lib/agent-pool.js";
import { cancelRun, getFramesFilePath, getRun, listActiveRunIds } from "../lib/runs.js";

type Frame = Record<string, unknown>;

let turnCounter = 0;

/**
 * Drive one bridgeSendMessage turn whose pool dispatch runs `impl` (usually:
 * throw a typed capacity error). Returns everything the assertions need.
 */
async function runRejectedTurn(
  impl: (opts: { runHandle?: { id: string } }) => Promise<never>,
): Promise<{ runId: string; frames: Frame[]; rejection: unknown }> {
  const pool = getAgentPool();
  const original = pool.runTurnWithHeal;
  turnCounter += 1;
  const frames: Frame[] = [];
  let runId: string | null = null;
  let rejection: unknown = null;

  pool.runTurnWithHeal = (async (
    _convId: string,
    _agentId: string,
    _input: unknown,
    turnOpts: { runHandle?: { id: string } },
  ) => impl(turnOpts)) as typeof pool.runTurnWithHeal;

  try {
    await bridgeSendMessage(
      {
        agent_id: `agent-cap-${turnCounter}`,
        conversation_id: `conv-cap-${turnCounter}`,
        text: "hello",
      },
      (frame) => frames.push(frame as unknown as Frame),
      { onRunCreated: (id) => { runId = id; } },
    );
    assert.fail("bridgeSendMessage must rethrow the capacity rejection");
  } catch (err) {
    rejection = err;
  } finally {
    pool.runTurnWithHeal = original;
  }
  assert.ok(runId, "run was pre-created (turn_started fired)");
  return { runId: runId!, frames, rejection };
}

test("pool_saturated rejection finalizes the pre-created run (failed) with a terminal frame", async () => {
  const { runId, frames, rejection } = await runRejectedTurn(async () => {
    throw new PoolCapacityError("pool_saturated", "pool queue full (3/3)");
  });

  assert.ok(rejection instanceof PoolCapacityError && rejection.code === "pool_saturated");
  // No leak: not active in memory, terminal on disk.
  assert.equal(listActiveRunIds().includes(runId), false, "run must leave _activeRuns");
  const run = getRun(runId);
  assert.equal(run?.status, "failed");
  assert.equal(run?.stop_reason, "pool_saturated");
  // Terminal stop_reason frame reached the client sink AND frames.jsonl,
  // so live consumers and reconnect-replay both see a terminal frame after
  // the turn_started they were shown.
  const stop = frames.find((f) => f["message_type"] === "stop_reason");
  assert.ok(stop, "terminal stop_reason frame emitted");
  assert.equal(stop!["stop_reason"], "error");
  assert.equal(stop!["code"], "pool_saturated");
  assert.equal(stop!["run_id"], runId);
  const persisted = readFileSync(getFramesFilePath(runId), "utf8");
  assert.ok(persisted.includes("pool_saturated"), "terminal frame persisted for replay");
});

test("pool_queue_timeout rejection finalizes the pre-created run (failed)", async () => {
  const { runId, frames, rejection } = await runRejectedTurn(async () => {
    throw new PoolCapacityError("pool_queue_timeout", "no pool capacity within 30000ms");
  });

  assert.ok(rejection instanceof PoolCapacityError && rejection.code === "pool_queue_timeout");
  assert.equal(listActiveRunIds().includes(runId), false);
  const run = getRun(runId);
  assert.equal(run?.status, "failed");
  assert.equal(run?.stop_reason, "pool_queue_timeout");
  const stop = frames.find((f) => f["message_type"] === "stop_reason");
  assert.ok(stop);
  assert.equal(stop!["code"], "pool_queue_timeout");
});

test("cancelled-while-queued: cancelRun's finalization is respected (no double-finalize)", async () => {
  // Production order: user stop → cancelRun finalizes the run (status
  // "cancelled") → its onCancel calls pool.cancelQueued → the parked get()
  // rejects with code "cancelled". The catch must NOT overwrite that.
  const { runId, frames, rejection } = await runRejectedTurn(async (turnOpts) => {
    assert.ok(turnOpts.runHandle?.id);
    assert.equal(cancelRun(turnOpts.runHandle!.id), true);
    throw new PoolCapacityError("cancelled", "cancelled while queued for pool capacity");
  });

  assert.ok(rejection instanceof PoolCapacityError && rejection.code === "cancelled");
  assert.equal(listActiveRunIds().includes(runId), false);
  const run = getRun(runId);
  assert.equal(run?.status, "cancelled", "cancelRun's status stands");
  assert.equal(run?.stop_reason, "user_cancelled", "cancelRun's stop_reason not overwritten");
  // Already finalized by cancelRun → the catch adds no extra terminal frame.
  assert.equal(frames.filter((f) => f["message_type"] === "stop_reason").length, 0);
});

test("cancelled without prior cancelRun (pool shutdown) finalizes as cancelled", async () => {
  const { runId, frames } = await runRejectedTurn(async () => {
    throw new PoolCapacityError("cancelled", "pool shutting down");
  });

  assert.equal(listActiveRunIds().includes(runId), false);
  const run = getRun(runId);
  assert.equal(run?.status, "cancelled");
  assert.equal(run?.stop_reason, "cancelled");
  const stop = frames.find((f) => f["message_type"] === "stop_reason");
  assert.ok(stop, "terminal frame emitted for the shutdown edge");
  assert.equal(stop!["stop_reason"], "user_cancelled");
});
