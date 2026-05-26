/**
 * Behavioral tests for worker lifecycle (lcp-p74.3).
 *
 * Pinned contracts:
 *   - A WS disconnect does NOT cancel the in-flight turn. The worker
 *     keeps running, run.json reaches a terminal state, and frames.jsonl
 *     gets written.
 *   - An idle worker is reaped after SHIM_POOL_IDLE_SEC + the next
 *     housekeep tick.
 *   - A worker that just handled a turn stays in the pool until idle —
 *     the post-turn lastUsedAt bump defers eviction.
 *
 * Tests drive turns via the WS channel against the real shim subprocess
 * (the same one all the other integration tests use). The mock letta
 * binary replays a captured stream-trace so the worker actually runs.
 *
 * Eviction is fast in this suite via two env overrides:
 *   SHIM_POOL_IDLE_SEC=1       (1s idle threshold instead of 300s)
 *   SHIM_POOL_HOUSEKEEP_MS=500 (500ms housekeep tick instead of 30s)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { openMobileWs, startShim } from "./helpers/index.js";
import type { MobileWsHandle, MobileWsFrame } from "./helpers/ws.js";

interface PoolStats {
  size: number;
  max: number;
  idle_evict_sec: number;
  workers: Array<{
    key: string;
    conversation_id: string;
    agent_id: string;
    ready: boolean;
    dead: boolean;
    idle_sec: number;
    spawned_sec: number;
  }>;
}

async function poolStats(shimUrl: string): Promise<PoolStats> {
  const res = await fetch(`${shimUrl}/shim/pool`);
  return (await res.json()) as PoolStats;
}

async function waitNew<T extends MobileWsFrame>(
  conn: MobileWsHandle,
  type: string,
  timeoutMs = 8000,
): Promise<T> {
  const cursor = conn.frames.length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = cursor; i < conn.frames.length; i++) {
      const f = conn.frames[i];
      if (f && f.type === type) return f as T;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitNew(${type}) timeout`);
}

test("/shim/pool reports housekeep cadence and worker capacity", async () => {
  const shim = await startShim({
    env: { SHIM_POOL_IDLE_SEC: "1", SHIM_POOL_HOUSEKEEP_MS: "500" },
  });
  try {
    const stats = await poolStats(shim.url!);
    assert.equal(stats.idle_evict_sec, 1, "env override flows through to stats");
    assert.equal(typeof stats.max, "number");
    assert.equal(stats.workers.length, 0, "no workers spawned yet");
  } finally {
    await shim.stop();
  }
});

test("WS disconnect mid-turn: run still finalizes (worker survives)", async () => {
  const shim = await startShim({
    env: { SHIM_POOL_IDLE_SEC: "1", SHIM_POOL_HOUSEKEEP_MS: "500" },
  });
  try {
    // Seed an agent so the worker has something to attach to. The shim's
    // bridge creates a Run record BEFORE pool.get(), which is the path
    // we want to exercise — the run id surfaces on turn_started, then
    // disconnect.
    const agentId = "agent-disconnect-test";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { Buffer } = await import("node:buffer");
    const b64url = (s: string) =>
      Buffer.from(s, "utf8").toString("base64url");
    const agentDir = join(shim.stateDir, "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, `${b64url(agentId)}.json`),
      JSON.stringify({
        id: agentId,
        name: agentId,
        agent_type: "memgpt_v2_agent",
        tools: [],
        created_at: "2026-05-19T00:00:00.000Z",
        memory: { blocks: [] },
        system: "",
      }),
    );

    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    conn.send({
      type: "send_message",
      agent_id: agentId,
      conversation_id: `conv-default-${agentId}`,
      text: "hello",
    });
    const turnStarted = await waitNew<MobileWsFrame & { run_id: string }>(
      conn,
      "turn_started",
    );
    const runId = turnStarted.run_id;
    assert.ok(runId && runId.startsWith("run-"), `expected run_id, got: ${runId}`);

    // Yank the socket mid-turn. The worker keeps streaming to disk.
    conn.close(1000, "test disconnect");
    await sleep(50);

    // Poll the run record until it finalizes (run.json status leaves
    // "running"). With a mock that produces a captured trace this is
    // typically <2s.
    const deadline = Date.now() + 8000;
    let finalStatus: string | null = null;
    while (Date.now() < deadline) {
      const res = await fetch(`${shim.url}/v1/runs/${runId}`);
      if (res.status !== 200) {
        await sleep(100);
        continue;
      }
      const run = (await res.json()) as { status: string };
      if (run.status !== "running") {
        finalStatus = run.status;
        break;
      }
      await sleep(150);
    }
    assert.ok(
      finalStatus && finalStatus !== "running",
      `run must reach terminal status after WS disconnect, got: ${finalStatus}`,
    );
  } finally {
    await shim.stop();
  }
});

test("idle worker is reaped after SHIM_POOL_IDLE_SEC + one housekeep tick", async () => {
  const shim = await startShim({
    env: { SHIM_POOL_IDLE_SEC: "1", SHIM_POOL_HOUSEKEEP_MS: "300" },
  });
  try {
    const agentId = "agent-evict-test";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { Buffer } = await import("node:buffer");
    const b64url = (s: string) =>
      Buffer.from(s, "utf8").toString("base64url");
    mkdirSync(join(shim.stateDir, "agents"), { recursive: true });
    writeFileSync(
      join(shim.stateDir, "agents", `${b64url(agentId)}.json`),
      JSON.stringify({
        id: agentId,
        name: agentId,
        agent_type: "memgpt_v2_agent",
        tools: [],
        created_at: "2026-05-19T00:00:00.000Z",
        memory: { blocks: [] },
        system: "",
      }),
    );

    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    conn.send({
      type: "send_message",
      agent_id: agentId,
      conversation_id: `conv-default-${agentId}`,
      text: "hello",
    });
    await waitNew<MobileWsFrame>(conn, "turn_done", 15000);

    // Right after turn_done the worker is in the pool, alive, idle=0.
    const before = await poolStats(shim.url!);
    const ours = before.workers.find((w) => w.agent_id === agentId);
    assert.ok(ours, "worker should be in the pool right after the turn");
    assert.equal(ours!.ready, true);

    // Need > IDLE_EVICT_MS (1s) + one housekeep tick (300ms). Poll
    // instead of fixed-sleep so the test exits as soon as eviction
    // happens — usually ~1.3s, occasionally a bit longer.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const cur = await poolStats(shim.url!);
      if (!cur.workers.find((w) => w.agent_id === agentId)) break;
      await sleep(100);
    }

    const after = await poolStats(shim.url!);
    const stillThere = after.workers.find((w) => w.agent_id === agentId);
    assert.equal(stillThere, undefined, "idle worker should be reaped by now");

    conn.close();
  } finally {
    await shim.stop();
  }
});
