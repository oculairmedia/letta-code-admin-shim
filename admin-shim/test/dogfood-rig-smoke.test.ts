/**
 * Dogfood SchedulerDaemon smoke harness (vibesync-d0j3).
 *
 * Exercises the real shim subprocess cron path against the mock letta-code
 * worker: cron store mutation → scheduler fire → mobile-channel writeback →
 * natural shim shutdown. The final assertions guard the process-cleanup
 * regression target: no shim/conversation worker should remain after exit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
  externalConvId,
  openMobileWs,
  seedAgent,
  seedConversation,
  startShim,
} from "./helpers/index.js";
import type { MobileWsFrame, MobileWsHandle } from "./helpers/ws.js";
import type { CronTask } from "../lib/types/crons.js";

interface TurnDoneFrame extends MobileWsFrame {
  agent_id?: string;
  conversation_id?: string;
  run_id?: string | null;
  status?: string;
}

interface PoolStats {
  size: number;
  workers: Array<{ conversation_id: string; agent_id: string; dead: boolean }>;
}

interface CronCreateResponse extends CronTask {
  warning?: string;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childPidsOf(pid: number | undefined): number[] {
  if (!pid) return [];
  try {
    return readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .map((entry) => Number(entry))
      .filter((candidatePid) => {
        try {
          const stat = readFileSync(`/proc/${candidatePid}/stat`, "utf8");
          const closeParen = stat.lastIndexOf(")");
          const fields = stat.slice(closeParen + 2).split(" ");
          return Number(fields[1]) === pid;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

async function waitForFrameFrom<T extends MobileWsFrame>(
  conn: MobileWsHandle,
  cursor: number,
  predicate: (frame: MobileWsFrame) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = cursor; i < conn.frames.length; i++) {
      const frame = conn.frames[i];
      if (frame && predicate(frame)) return frame as T;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for fresh frame (types: ${conn.frames.map((f) => f.type).join(",")})`);
}

async function readJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url} should succeed`);
  return await res.json() as T;
}

async function createDueCronTask(url: string, agentId: string, conversationId: string): Promise<CronCreateResponse> {
  const res = await fetch(`${url}/v1/crons`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      conversation_id: conversationId,
      name: "dogfood-rig-smoke",
      description: "dogfood SchedulerDaemon cleanup smoke",
      prompt: "dogfood-rig smoke: reply with writeback-ok",
      at: "in 0m",
      timezone: "UTC",
    }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  return JSON.parse(body) as CronCreateResponse;
}

async function waitForProcessExit(pid: number | undefined, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(50);
  }
  assert.fail(`${label} process ${pid ?? "<unknown>"} remained alive after natural harness exit`);
}

test("dogfood-rig-smoke: scheduler fire writes back and natural shim exit leaves no workers", {
  skip: process.platform === "linux" ? false : "process cleanup assertions require Linux /proc",
}, async () => {
  const shim = await startShim({
    env: {
      SHIM_POOL_IDLE_SEC: "300",
      SHIM_CRON_TICK_INTERVAL_MS: "100",
    },
  });
  let stopped = false;
  try {
    const agentId = seedAgent(shim.stateDir, {
      id: "agent-dogfood-rig-smoke",
      name: "dogfood-rig-smoke",
    });
    seedConversation(shim.stateDir, agentId);
    const conversationId = externalConvId(agentId);

    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      const subscriptionCursor = conn.frames.length;
      conn.send({ type: "subscribe_conversation", conversation_id: conversationId, after_seq: 0 });
      await waitForFrameFrom(
        conn,
        subscriptionCursor,
        (frame) => frame.type === "conversation_subscribed" && frame["conversation_id"] === conversationId,
      );

      const writebackCursor = conn.frames.length;
      const created = await createDueCronTask(shim.url!, agentId, "default");
      assert.equal(created.name, "dogfood-rig-smoke");
      assert.equal(created.agent_id, agentId);

      const done = await waitForFrameFrom<TurnDoneFrame>(
        conn,
        writebackCursor,
        (frame) => frame.type === "turn_done" && frame["agent_id"] === agentId && frame["conversation_id"] === conversationId,
        20_000,
      );
      assert.equal(done.status, "completed");
      assert.equal(typeof done.run_id, "string", "writeback turn_done should carry a run_id");

      const poolDuringTurn = await readJson<PoolStats>(`${shim.url}/shim/pool`);
      assert.ok(
        poolDuringTurn.workers.some((worker) => worker.agent_id === agentId && worker.conversation_id === created.conversation_id),
        "cron fire should have spawned a conversation-scoped worker before shutdown",
      );

      const taskAfter = await readJson<CronTask>(`${shim.url}/v1/crons/${created.id}`);
      assert.equal(taskAfter.status, "fired");
      assert.equal(taskAfter.fire_count, 1);
    } finally {
      conn.close();
    }

    const shimPid = shim.pid;
    const childPids = childPidsOf(shimPid);
    assert.ok(childPids.length > 0, "cron fire should leave a conversation worker process for shutdown to reap");

    await shim.stop();
    stopped = true;
    await waitForProcessExit(shimPid, "shim");
    await Promise.all(childPids.map((pid) => waitForProcessExit(pid, "conversation child")));
    assert.equal(isProcessAlive(shimPid), false, "shim subprocess should be gone after natural harness exit");
    assert.deepEqual(childPids.filter(isProcessAlive), [], "conversation child processes should be gone after shim exit");
  } finally {
    if (!stopped) await shim.stop();
  }
});
