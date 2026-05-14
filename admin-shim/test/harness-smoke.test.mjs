/**
 * Harness self-test: prove startShim spawns, health-checks, and tears down
 * without leaks. If this fails, none of the substantive tests will run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { startShim, seedAgent, seedConversation } from "./helpers/index.mjs";

test("harness: shim starts, serves /v1/health, stops cleanly", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const res = await fetch(`${shim.url}/v1/health/`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.ok(body.server_id, "server_id should be set");
  assert.ok(body.backend, "backend should be set");
});

test("harness: seeded agent appears in GET /v1/agents", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, {
    id: "agent-harness-001",
    name: "Harness Agent",
  });
  seedConversation(shim.stateDir, agentId);

  const res = await fetch(`${shim.url}/v1/agents`);
  assert.equal(res.status, 200);
  const agents = await res.json();
  assert.ok(Array.isArray(agents), "agents should be an array");
  const found = agents.find((a) => a.id === agentId);
  assert.ok(found, `seeded agent ${agentId} should be listed (got ${agents.map((a) => a.id)})`);
  assert.equal(found.name, "Harness Agent");
});

test("harness: two shims on different ports run in parallel", async (t) => {
  const a = await startShim();
  const b = await startShim();
  t.after(() => Promise.all([a.stop(), b.stop()]));
  assert.notEqual(a.port, b.port, "ports must differ");
  const [resA, resB] = await Promise.all([
    fetch(`${a.url}/v1/health/`),
    fetch(`${b.url}/v1/health/`),
  ]);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
  assert.notEqual(bodyA.server_id, bodyB.server_id, "server_ids must differ");
});
