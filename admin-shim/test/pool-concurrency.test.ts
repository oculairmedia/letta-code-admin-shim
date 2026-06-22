import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentPool } from "../lib/agent-pool.js";

test("concurrent get calls only spawn once", async () => {
  let spawnCount = 0;

  const pool = new AgentPool();
  pool._adapterFactory = async (opts) => {
    spawnCount++;
    await new Promise(r => setTimeout(r, 10)); // simulate async
    return { dead: false, busy: false, lastUsedAt: Date.now(), start: async () => {}, close: () => {} } as any;
  };

  const p1 = pool.get("conv1", "agent1");
  const p2 = pool.get("conv1", "agent1");

  const [w1, w2] = await Promise.all([p1, p2]);

  assert.equal(w1, w2);
  assert.equal(spawnCount, 1);

  clearInterval(pool.housekeepTimer);
});
