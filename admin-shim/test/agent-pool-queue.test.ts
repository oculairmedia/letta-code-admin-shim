/**
 * lcp hr5rw (§3a) — bounded FIFO overflow queue for cold spawns.
 *
 * Env is set BEFORE the module import (MAX_WORKERS / QUEUE_* are
 * module-level consts):
 *   SHIM_POOL_MAX=2  SHIM_POOL_QUEUE_MAX=3  SHIM_POOL_QUEUE_TIMEOUT_MS=500
 *
 * Pinned contracts (design test plan a–h):
 *   (a) 3rd cold get() queues; resolves when a turn settles
 *   (b) QUEUE_MAX overflow → typed pool_saturated rejection
 *   (c) queue timeout → typed pool_queue_timeout rejection
 *   (d) cancelQueued(runId) removes the waiter → typed cancelled rejection
 *   (e) same-key waiters coalesce (one spawn)
 *   (f) no `spawning` map leak after a rejection
 *   (g) admission control: frees during a slow spawn window never burst
 *       workers.size + inFlightSpawns past MAX
 *   (h) a worker with pendingTurns() > 0 is never a cap-eviction victim
 *   (i) a stale cancel-grace expiry (worker already replaced under the
 *       same key) never force-evicts the replacement worker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["SHIM_POOL_MAX"] = "2";
process.env["SHIM_POOL_QUEUE_MAX"] = "3";
process.env["SHIM_POOL_QUEUE_TIMEOUT_MS"] = "500";
// Isolate disk side effects (test (i) drives runTurnWithHeal, which reads
// messages.jsonl in its preflight heal check).
const backendDir = mkdtempSync(join(tmpdir(), "agent-pool-queue-"));
process.env["LETTA_LOCAL_BACKEND_DIR"] = backendDir;
process.on("exit", () => rmSync(backendDir, { recursive: true, force: true }));

const { AgentPool, PoolCapacityError } = await import("../lib/agent-pool.js");
type LettaSessionAdapterOptions = import("../lib/agent-pool.js").LettaSessionAdapterOptions;
type LettaSessionAdapter = import("../lib/agent-pool.js").LettaSessionAdapter;

const MAX = 2;

class FakeWorker implements LettaSessionAdapter {
  conversationId: string;
  agentId: string;
  ready = true;
  dead = false;
  busy = false;
  lastUsedAt = Date.now();
  spawnedAt = Date.now();
  activeRunId: string | null = null;
  closedCount = 0;
  pendingTurnCount = 0;
  onTurnSettled: (() => void) | undefined;

  constructor(opts: LettaSessionAdapterOptions) {
    this.conversationId = opts.conversationId;
    this.agentId = opts.agentId;
    this.onTurnSettled = opts.onTurnSettled;
  }

  pendingTurns(): number {
    return this.pendingTurnCount;
  }
  async start(): Promise<{ agentId: string; conversationId: string }> {
    return { agentId: this.agentId, conversationId: this.conversationId };
  }
  lastRunOpts: import("../lib/agent-pool.js").RunTurnOptions | null = null;
  async runTurn(
    _input?: string | unknown[],
    opts?: import("../lib/agent-pool.js").RunTurnOptions,
  ): Promise<import("../lib/agent-pool.js").AdapterRunTurnResult> {
    this.lastRunOpts = opts ?? null;
    return { frames: [], stderr: "" };
  }
  abort(): void {}
  close(): void {
    this.closedCount += 1;
    this.dead = true;
  }
  /** Simulate the real adapter's post-finalize settle. */
  settle(): void {
    this.busy = false;
    this.pendingTurnCount = 0;
    this.onTurnSettled?.();
  }
}

interface PoolHarness {
  pool: InstanceType<typeof AgentPool>;
  spawned: FakeWorker[];
  spawnGate: { hold: boolean; releases: Array<() => void> };
  releaseSpawns(): void;
}

function makePool(): PoolHarness {
  const pool = new AgentPool();
  clearInterval(pool.housekeepTimer);
  const spawned: FakeWorker[] = [];
  const spawnGate = { hold: false, releases: [] as Array<() => void> };
  pool._adapterFactory = async (opts: LettaSessionAdapterOptions) => {
    const w = new FakeWorker(opts);
    spawned.push(w);
    if (spawnGate.hold) {
      await new Promise<void>((resolve) => spawnGate.releases.push(resolve));
    }
    return w;
  };
  return {
    pool,
    spawned,
    spawnGate,
    releaseSpawns() {
      const rs = spawnGate.releases.splice(0);
      for (const r of rs) r();
    },
  };
}

/** Fill the pool to MAX with busy workers via the normal get() path. */
async function fillBusy(h: PoolHarness): Promise<FakeWorker[]> {
  const workers: FakeWorker[] = [];
  for (let i = 0; i < MAX; i++) {
    const w = (await h.pool.get(`conv-busy-${i}`, `agent-${i}`)) as FakeWorker;
    w.busy = true;
    workers.push(w);
  }
  assert.equal(h.pool.workers.size, MAX);
  return workers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("(a) 3rd cold get() queues and resolves when a turn settles; never bursts past MAX", async () => {
  const h = makePool();
  const busy = await fillBusy(h);

  let resolved = false;
  const p = h.pool.get("conv-q", "agent-q").then((w) => {
    resolved = true;
    return w;
  });
  await sleep(50);
  assert.equal(resolved, false, "3rd cold get must queue, not overflow-spawn");
  assert.equal(h.pool.stats().queued, 1);
  assert.equal(h.pool.workers.size, MAX, "no overflow worker spawned");

  busy[0]!.settle(); // turn settles → drain → evict idle LRU → admit
  const w = await p;
  assert.ok(w instanceof FakeWorker);
  assert.equal(busy[0]!.closedCount, 1, "settled idle worker was the cap-eviction victim");
  assert.equal(busy[1]!.closedCount, 0, "busy worker never closed");
  assert.ok(h.pool.workers.size <= MAX, `size ${h.pool.workers.size} must stay ≤ ${MAX}`);
  assert.equal(h.pool.stats().queued, 0);
  await h.pool.stopAll();
});

test("(b) queue overflow rejects immediately with typed pool_saturated", async () => {
  const h = makePool();
  await fillBusy(h);

  const queued = [
    h.pool.get("conv-w1", "agent-w1"),
    h.pool.get("conv-w2", "agent-w2"),
    h.pool.get("conv-w3", "agent-w3"),
  ];
  await sleep(20);
  assert.equal(h.pool.stats().queued, 3);

  await assert.rejects(
    h.pool.get("conv-w4", "agent-w4"),
    (err: unknown) => err instanceof PoolCapacityError && err.code === "pool_saturated",
  );

  // Shutdown unblocks the parked waiters (typed cancelled) — nothing leaks.
  await h.pool.stopAll();
  for (const r of await Promise.allSettled(queued)) {
    assert.equal(r.status, "rejected");
  }
});

test("(c) queue timeout rejects with typed pool_queue_timeout; (f) no spawning leak", async () => {
  const h = makePool();
  const busy = await fillBusy(h);

  const started = Date.now();
  await assert.rejects(
    h.pool.get("conv-timeout", "agent-timeout"),
    (err: unknown) => err instanceof PoolCapacityError && err.code === "pool_queue_timeout",
  );
  assert.ok(Date.now() - started >= 400, "rejection respects the queue timeout window");

  // (f) rejection leaks nothing: no spawning entry, no waiter, and the
  // pool still works once capacity frees.
  assert.equal(h.pool.spawning.size, 0, "no spawning-map leak after rejection");
  assert.equal(h.pool.stats().queued, 0);
  assert.equal(h.pool.inFlightSpawns, 0);
  busy[0]!.settle();
  const w = await h.pool.get("conv-after", "agent-after");
  assert.ok(w, "pool recovers after a queue rejection");
  await h.pool.stopAll();
});

test("(d) cancelQueued(runId) removes the waiter with typed cancelled", async () => {
  const h = makePool();
  await fillBusy(h);

  const p = h.pool.get("conv-cancel", "agent-cancel", { runId: "run-q1" });
  await sleep(20);
  assert.equal(h.pool.stats().queued, 1);
  assert.equal(h.pool.cancelQueued("run-q1"), true);
  await assert.rejects(
    p,
    (err: unknown) => err instanceof PoolCapacityError && err.code === "cancelled",
  );
  assert.equal(h.pool.stats().queued, 0);
  assert.equal(h.pool.cancelQueued("run-q1"), false, "second cancel is a no-op");
  await h.pool.stopAll();
});

test("(e) same-key waiters coalesce onto one spawn", async () => {
  const h = makePool();
  const busy = await fillBusy(h);
  const spawnsBefore = h.spawned.length;

  const p1 = h.pool.get("conv-shared", "agent-shared");
  const p2 = h.pool.get("conv-shared", "agent-shared");
  await sleep(20);
  assert.equal(h.pool.stats().queued, 1, "same-key callers share one waiter");

  busy[0]!.settle();
  const [w1, w2] = await Promise.all([p1, p2]);
  assert.equal(w1, w2, "both callers get the same adapter");
  assert.equal(h.spawned.length - spawnsBefore, 1, "exactly one spawn for the coalesced pair");
  await h.pool.stopAll();
});

test("(g) admission control: frees during a slow spawn window never burst past MAX", async () => {
  const h = makePool();
  const busy = await fillBusy(h);

  // Slow down spawns so admissions overlap the spawn window.
  h.spawnGate.hold = true;

  let maxLoad = 0;
  const sample = (): void => {
    maxLoad = Math.max(maxLoad, h.pool.workers.size + h.pool.inFlightSpawns);
  };
  const sampler = setInterval(sample, 1);

  const queued = [
    h.pool.get("conv-g1", "agent-g1"),
    h.pool.get("conv-g2", "agent-g2"),
    h.pool.get("conv-g3", "agent-g3"),
  ];
  await sleep(20);
  assert.equal(h.pool.stats().queued, 3);

  // Two capacity frees land while the admitted spawns are still in their
  // (fake) 3s start window — naive wake-all would burst to 3 spawns.
  busy[0]!.settle();
  busy[1]!.settle();
  await sleep(50);
  sample();
  assert.equal(h.pool.inFlightSpawns, 2, "exactly two waiters admitted while spawns are in flight");
  assert.equal(h.pool.stats().queued, 1, "third waiter still parked");
  assert.ok(maxLoad <= MAX, `workers.size + inFlightSpawns peaked at ${maxLoad} — must stay ≤ ${MAX}`);

  // Let the spawns land; the third waiter then admits via idle eviction.
  h.releaseSpawns();
  await sleep(50);
  h.releaseSpawns(); // third waiter's spawn
  const settled = await Promise.allSettled(queued);
  clearInterval(sampler);
  sample();
  for (const r of settled) assert.equal(r.status, "fulfilled");
  assert.ok(maxLoad <= MAX, `workers.size + inFlightSpawns peaked at ${maxLoad} — must stay ≤ ${MAX}`);
  await h.pool.stopAll();
});

test("(i) stale cancel-grace expiry never force-evicts a replacement worker under the same key", async () => {
  const h = makePool();

  // Turn A runs on W1; capture the pool-wrapped onCancelGraceExpired that
  // W1's cancel-grace timer would fire.
  await h.pool.runTurnWithHeal("conv-stale", "agent-stale", "turn A", {});
  const key = h.pool._key("conv-stale", "agent-stale");
  const w1 = h.pool.workers.get(key) as FakeWorker;
  assert.ok(w1, "W1 warm after turn A");
  const staleGraceExpired = w1.lastRunOpts?.onCancelGraceExpired;
  assert.ok(staleGraceExpired, "turn A captured the grace-expiry hook");

  // W1 leaves the pool (cap-eviction for a queued waiter / death) and a
  // re-send spawns a FRESH worker W2 under the same key.
  assert.equal(h.pool.forceEvict("conv-stale", "agent-stale", "test_cap_evict"), true);
  await h.pool.runTurnWithHeal("conv-stale", "agent-stale", "turn B", {});
  const w2 = h.pool.workers.get(key) as FakeWorker;
  assert.ok(w2, "W2 spawned under the same key");
  assert.notEqual(w2, w1, "replacement is a distinct worker instance");

  // Turn A's grace timer fires late (settled never flipped): the by-key
  // forceEvict must NO-OP because the keyed worker is not turn A's adapter.
  staleGraceExpired!("run-a");
  assert.equal(w2.closedCount, 0, "stale grace expiry must not close the replacement worker");
  assert.equal(h.pool.workers.get(key), w2, "W2 still pooled");

  // Control: W2's own grace expiry (identity matches) still force-evicts.
  const w2GraceExpired = w2.lastRunOpts?.onCancelGraceExpired;
  assert.ok(w2GraceExpired);
  w2GraceExpired!("run-b");
  assert.equal(w2.closedCount, 1, "matching-identity grace expiry still evicts");
  assert.equal(h.pool.workers.has(key), false);
  await h.pool.stopAll();
});

test("(h) worker with pendingTurns() > 0 is never a cap-eviction victim", async () => {
  const h = makePool();
  // Worker X: not busy (currentRunHandle nulled) but mid-finalize / has a
  // chained turn — pendingTurns() > 0. Worker Y: actively busy.
  const x = (await h.pool.get("conv-x", "agent-x")) as FakeWorker;
  x.busy = false;
  x.pendingTurnCount = 1;
  x.lastUsedAt = 0; // absolute LRU — the naive victim
  const y = (await h.pool.get("conv-y", "agent-y")) as FakeWorker;
  y.busy = true;

  let resolved = false;
  const p = h.pool.get("conv-z", "agent-z").then((w) => {
    resolved = true;
    return w;
  });
  await sleep(50);
  assert.equal(resolved, false, "get must queue — no evictable victim");
  assert.equal(x.closedCount, 0, "pendingTurns>0 worker must not be closed mid-finalize");
  assert.equal(y.closedCount, 0, "busy worker must not be closed");

  // X's chained turn settles → X becomes evictable → Z admits.
  x.settle();
  await p;
  assert.equal(x.closedCount, 1, "X evicted only after its chain drained");
  assert.equal(y.closedCount, 0);
  await h.pool.stopAll();
});
