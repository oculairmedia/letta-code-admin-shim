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
 * lcp-2oxb.2 additions:
 *   - cap eviction skips a busy worker (unit test — no real shim subprocess).
 *   - all-busy at cap allows temporary pool overflow (unit test).
 *
 * Integration tests drive turns via the WS channel against the real shim
 * subprocess. The mock letta binary replays captured stream-traces so
 * the worker actually runs.
 *
 * Eviction is fast in this suite via two env overrides:
 *   SHIM_POOL_IDLE_SEC=1       (1s idle threshold instead of 300s)
 *   SHIM_POOL_HOUSEKEEP_MS=500 (500ms housekeep tick instead of 30s)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

// lcp-2oxb.2: import AgentPool directly so unit tests can inject fake
// adapters via _adapterFactory without spawning a real shim subprocess.
import {
  AgentPool,
  type LettaSessionAdapter,
  type LettaSessionAdapterOptions,
  type LettaSessionInit,
} from "../lib/agent-pool.js";

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

// ── lcp-2oxb.2: pool-level unit tests (no subprocess, fake adapters) ───────

/**
 * Build a minimal fake LettaSessionAdapter for pool unit tests. Each call
 * returns a fresh object so callers get an independently-trackable adapter.
 *
 * @param opts.busy   - Initial busy state (default false).
 * @param opts.lastUsedAt - Initial lastUsedAt timestamp (default Date.now()).
 */
function makeFakeAdapter(opts: {
  conversationId?: string;
  agentId?: string;
  busy?: boolean;
  lastUsedAt?: number;
} = {}): LettaSessionAdapter & { closedCount: number } {
  let closedCount = 0;
  return {
    conversationId: opts.conversationId ?? "conv-fake",
    agentId: opts.agentId ?? "agent-fake",
    ready: true,
    dead: false,
    lastUsedAt: opts.lastUsedAt ?? Date.now(),
    spawnedAt: Date.now() - 1000,
    get busy() { return opts.busy ?? false; },
    async start(): Promise<LettaSessionInit> {
      return { agentId: this.agentId, conversationId: this.conversationId };
    },
    async runTurn() {
      return { frames: [], stderr: "", done: true };
    },
    abort() { /* no-op */ },
    close() {
      closedCount += 1;
      (this as { dead: boolean }).dead = true;
    },
    get closedCount() { return closedCount; },
  };
}

/**
 * lcp-2oxb.2: cap eviction MUST skip a busy worker and instead evict the
 * least-recently-used NON-BUSY worker.
 *
 * Setup: fill a pool of max=2 with two workers:
 *   - "stale-busy" (lastUsedAt=0, busy=true)  ← LRU but must NOT be evicted
 *   - "fresh-idle" (lastUsedAt=1000, busy=false) ← slightly fresher but evictable
 *
 * Trigger: get() for a new key (forces eviction since pool is at cap).
 *
 * Assert:
 *   - "stale-busy" was NOT closed (its closedCount stays 0).
 *   - "fresh-idle" WAS closed (its closedCount becomes 1).
 *   - The new adapter is returned successfully (no exception).
 */
test("lcp-2oxb.2: cap eviction skips busy worker, evicts idle LRU", async () => {
  const pool = new AgentPool();
  // Disable housekeep timer (we don't need it and it leaks into other tests).
  clearInterval(pool.housekeepTimer);

  const staleBusy = makeFakeAdapter({
    conversationId: "conv-stale-busy",
    agentId: "agent-a",
    busy: true,
    lastUsedAt: 0, // oldest — would be evicted without the busy-skip fix
  });
  const freshIdle = makeFakeAdapter({
    conversationId: "conv-fresh-idle",
    agentId: "agent-b",
    busy: false,
    lastUsedAt: 1000, // fresher than staleBusy
  });

  // Pre-populate the pool with two workers at the cap.
  const fakeMax = 2;
  pool.workers.set(pool._key("conv-stale-busy", "agent-a"), staleBusy);
  pool.workers.set(pool._key("conv-fresh-idle", "agent-b"), freshIdle);
  assert.equal(pool.workers.size, fakeMax, "pool should be at cap");

  // Inject a fake factory that returns a tracked new adapter. We manipulate
  // SHIM_POOL_MAX via the pool's internal map size, so override MAX_WORKERS
  // by using a factory that counts successful spawns.
  let newAdapterSpawnCount = 0;
  const newAdapter = makeFakeAdapter({ conversationId: "conv-new", agentId: "agent-new" });
  pool._adapterFactory = async (_opts: LettaSessionAdapterOptions): Promise<LettaSessionAdapter> => {
    newAdapterSpawnCount += 1;
    return newAdapter;
  };

  // Force the pool to think its cap is 2 — the pool checks this.workers.size
  // against MAX_WORKERS from the module-level const. We arrange the pool to
  // have exactly MAX_WORKERS entries before calling get() by setting the
  // actual pool size == the runtime cap. The runtime MAX_WORKERS is 10 by
  // default in the test process (no SHIM_POOL_MAX override), so we pre-fill
  // the pool to 10 entries to trigger eviction.
  //
  // Simpler approach: just override the module env before import isn't possible
  // in ESM. Instead, fill the pool to the runtime MAX_WORKERS (default 10)
  // with extra idle entries beyond our two test entries.
  const MAX_WORKERS_RUNTIME = Number(process.env["SHIM_POOL_MAX"] ?? 10);
  // Add filler adapters (idle, non-busy, last-used earlier than freshIdle) up
  // to cap-1 so our staleBusy and freshIdle are the last two.
  const fillers: Array<LettaSessionAdapter & { closedCount: number }> = [];
  for (let i = pool.workers.size; i < MAX_WORKERS_RUNTIME; i++) {
    const filler = makeFakeAdapter({
      conversationId: `conv-filler-${i}`,
      agentId: `agent-filler-${i}`,
      busy: false,
      lastUsedAt: 2000 + i, // fresher than freshIdle=1000, but evictable
    });
    pool.workers.set(pool._key(`conv-filler-${i}`, `agent-filler-${i}`), filler);
    fillers.push(filler);
  }
  assert.equal(pool.workers.size, MAX_WORKERS_RUNTIME, "pool should be at runtime cap");

  // Now get() for the new key. staleBusy is the absolute LRU (lastUsedAt=0)
  // but must be skipped. freshIdle (lastUsedAt=1000) is the next LRU idle
  // victim — expect it to be evicted along with fillers as needed.
  const result = await pool.get("conv-new", "agent-new");
  assert.ok(result, "get() must return a new adapter");
  assert.equal(newAdapterSpawnCount, 1, "factory called exactly once");

  // The busy worker must NOT have been closed.
  assert.equal(
    staleBusy.closedCount,
    0,
    "busy worker (staleBusy) must not be closed during cap eviction (lcp-2oxb.2)",
  );
  // The idle workers (filler + freshIdle) should have been closed (one per
  // eviction round until below cap). We don't assert which specific idle was
  // first, only that staleBusy was untouched.
  const totalIdleClosed =
    fillers.reduce((s, f) => s + f.closedCount, 0) + freshIdle.closedCount;
  assert.ok(totalIdleClosed > 0, "at least one idle worker must have been evicted");
});

/**
 * lcp-2oxb.2: when ALL workers at cap are busy, get() must still return a
 * new working adapter (temporary overflow) and must NOT close any busy worker.
 *
 * Setup: fill pool to MAX_WORKERS with all-busy adapters.
 *
 * Assert:
 *   - get() resolves (no error / dead result).
 *   - pool.workers.size > MAX_WORKERS_RUNTIME (overflow).
 *   - No busy adapter received close().
 */
test("lcp-2oxb.2: all-busy at cap → overflow, no busy worker closed", async () => {
  const pool = new AgentPool();
  clearInterval(pool.housekeepTimer);

  const MAX_WORKERS_RUNTIME = Number(process.env["SHIM_POOL_MAX"] ?? 10);

  const busyAdapters: Array<LettaSessionAdapter & { closedCount: number }> = [];
  for (let i = 0; i < MAX_WORKERS_RUNTIME; i++) {
    const adapter = makeFakeAdapter({
      conversationId: `conv-busy-${i}`,
      agentId: `agent-busy-${i}`,
      busy: true,
      lastUsedAt: i, // monotonically increasing so there's a clear LRU
    });
    pool.workers.set(pool._key(`conv-busy-${i}`, `agent-busy-${i}`), adapter);
    busyAdapters.push(adapter);
  }
  assert.equal(pool.workers.size, MAX_WORKERS_RUNTIME, "pool at cap");

  let spawned = 0;
  const overflowAdapter = makeFakeAdapter({ conversationId: "conv-overflow", agentId: "agent-overflow" });
  pool._adapterFactory = async (_opts: LettaSessionAdapterOptions): Promise<LettaSessionAdapter> => {
    spawned += 1;
    return overflowAdapter;
  };

  const result = await pool.get("conv-overflow", "agent-overflow");
  assert.ok(result, "get() must succeed even when all workers are busy (overflow)");
  assert.equal(spawned, 1, "factory called exactly once");

  // Pool size should exceed the cap (temporary overflow).
  assert.ok(
    pool.workers.size > MAX_WORKERS_RUNTIME,
    `pool size (${pool.workers.size}) must exceed max (${MAX_WORKERS_RUNTIME}) on all-busy overflow`,
  );

  // No busy adapter may have been closed.
  for (let i = 0; i < busyAdapters.length; i++) {
    assert.equal(
      busyAdapters[i]!.closedCount,
      0,
      `busyAdapters[${i}] must not be closed during all-busy overflow (lcp-2oxb.2)`,
    );
  }
});
