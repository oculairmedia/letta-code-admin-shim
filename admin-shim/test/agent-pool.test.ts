import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveApprovalGate,
  rejectApprovalGate,
  waitForApprovalDecision,
  AgentPool,
  type LettaSessionAdapter,
  type LettaSessionAdapterOptions,
} from "../lib/agent-pool.js";

class FakeAdapter implements LettaSessionAdapter {
  conversationId: string;
  agentId: string;
  ready = false;
  dead = false;
  lastUsedAt = Date.now();
  spawnedAt = Date.now();
  closed = false;
  activeRunId: string | null = null;

  constructor(opts: LettaSessionAdapterOptions) {
    this.conversationId = opts.conversationId;
    this.agentId = opts.agentId;
  }

  async start() {
    this.ready = true;
    return { sessionId: "fake-sess", messages: [], agentId: this.agentId, conversationId: this.conversationId };
  }

  async runTurn(input: string | unknown[], opts?: any) {
    return { done: true, cancelled: false, newUserMessageId: "msg-1", frames: [], stderr: "" };
  }

  abort() {}

  async close() {
    this.closed = true;
    this.dead = true;
  }
}

describe("agent-pool approval gates", () => {
  test("resolveApprovalGate returns false for unknown runId", () => {
    const result = resolveApprovalGate("unknown-run", {
      decision: "approve",
      scope: "Once",
      reason: "ok",
      actionId: "a1",
    });
    assert.equal(result, false);
  });

  test("resolveApprovalGate resolves a pending gate", async () => {
    const p = waitForApprovalDecision("run-resolve-1", "myTool", "tc-123");

    const result = resolveApprovalGate("run-resolve-1", {
      decision: "approve",
      scope: "Once",
      reason: "user said yes",
      actionId: "a2",
    });

    assert.equal(result, true);

    const decision = await p;
    assert.equal(decision.decision, "approve");
    assert.equal(decision.reason, "user said yes");
  });

  test("rejectApprovalGate returns false for unknown runId", () => {
    const result = rejectApprovalGate("unknown-run", new Error("foo"));
    assert.equal(result, false);
  });

  test("rejectApprovalGate rejects a pending gate", async () => {
    const p = waitForApprovalDecision("run-reject-1", "myTool", "tc-456");

    const result = rejectApprovalGate("run-reject-1", new Error("cancel"));
    assert.equal(result, true);

    await assert.rejects(p, /cancel/);
  });

  test("waitForApprovalDecision times out", async () => {
    const p = waitForApprovalDecision("run-timeout-1", "myTool", "tc-789", 10);

    await assert.rejects(p, /approval_timeout: no decision for myTool within 10ms/);
  });

  test("evicting a worker rejects its pending approval gate", async () => {
    const pool = new AgentPool();
    pool._adapterFactory = async (opts) => new FakeAdapter(opts);

    const adapter = await pool.get("conv-1", "agent-1") as unknown as FakeAdapter;
    adapter.activeRunId = "run-evict-1";

    const p = waitForApprovalDecision("run-evict-1", "myTool", "tc-1");

    await pool.evict("conv-1", "agent-1");

    await assert.rejects(p, /worker_evicted/);
    await pool.stopAll();
  });

  test("stopping the pool rejects pending approval gates on all workers", async () => {
    const pool = new AgentPool();
    pool._adapterFactory = async (opts) => new FakeAdapter(opts);

    const adapter1 = await pool.get("conv-1", "agent-1") as unknown as FakeAdapter;
    adapter1.activeRunId = "run-stop-1";
    const adapter2 = await pool.get("conv-2", "agent-1") as unknown as FakeAdapter;
    adapter2.activeRunId = "run-stop-2";

    const p1 = waitForApprovalDecision("run-stop-1", "myTool", "tc-1");
    const p2 = waitForApprovalDecision("run-stop-2", "myTool", "tc-2");

    await pool.stopAll();

    await assert.rejects(p1, /worker_evicted/);
    await assert.rejects(p2, /worker_evicted/);
  });

  test("cap eviction rejects pending approval gate on victim worker", async () => {
    // Force SHIM_POOL_MAX to 1 for this test
    const origMax = process.env["SHIM_POOL_MAX"];
    process.env["SHIM_POOL_MAX"] = "1";

    // Create a new pool to pick up the env var. Wait, MAX_WORKERS is evaluated at module load time.
    // Instead of overriding env which won't work without module reload, let's just spawn MAX_WORKERS + 1.
    const pool = new AgentPool();
    pool._adapterFactory = async (opts) => new FakeAdapter(opts);

    // Get current size of MAX_WORKERS
    const maxWorkers = pool.stats().max;

    // Fill the pool
    for (let i = 0; i < maxWorkers; i++) {
      await pool.get(`conv-${i}`, "agent-1");
    }

    // Make the first one the stalest and give it a pending gate
    const stalest = pool.workers.get(pool._key("conv-0", "agent-1")) as unknown as FakeAdapter;
    stalest.lastUsedAt = 0; // Very stale
    stalest.activeRunId = "run-cap-1";

    const p = waitForApprovalDecision("run-cap-1", "myTool", "tc-1");

    // Spawn one more to trigger cap eviction
    await pool.get(`conv-overflow`, "agent-1");

    await assert.rejects(p, /worker_evicted/);

    if (origMax) process.env["SHIM_POOL_MAX"] = origMax;
    else delete process.env["SHIM_POOL_MAX"];

    await pool.stopAll();
  });
});
