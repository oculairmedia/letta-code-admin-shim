/**
 * Goals REST endpoint tests (lcp-2eg2, epic lcp-ctz2).
 *
 * Covers the /v1/agents/{agentId}/goals/* surface: create, list (with streak),
 * get, patch, delete, progress, 404s, and 400 validation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { startShim, seedAgent } from "./helpers/index.js";

async function getJson(url: string): Promise<{ res: Response; body: unknown }> {
  const res = await fetch(url);
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { res, body };
}

async function postJson(url: string, data: unknown): Promise<{ res: Response; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch {}
  return { res, body };
}

async function patchJson(url: string, data: unknown): Promise<{ res: Response; body: unknown }> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch {}
  return { res, body };
}

async function deleteReq(url: string): Promise<{ res: Response; body: unknown }> {
  const res = await fetch(url, { method: "DELETE" });
  let body: unknown = null;
  try { body = await res.json(); } catch {}
  return { res, body };
}

test("POST /v1/agents/{id}/goals creates a goal and returns 201 with streak", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const { res, body } = await postJson(`${shim.url}/v1/agents/${agentId}/goals`, {
    title: "Ship the feature",
    description: "Complete the MVP by Friday",
    status: "active",
    cadence: "once",
  });
  assert.equal(res.status, 201);
  const goal = body as { id: string; title: string; description: string; status: string; cadence: string; streak: number };
  assert.ok(goal.id.startsWith("goal-"));
  assert.equal(goal.title, "Ship the feature");
  assert.equal(goal.description, "Complete the MVP by Friday");
  assert.equal(goal.status, "active");
  assert.equal(goal.cadence, "once");
  assert.equal(goal.streak, 0, "no progress yet → streak 0");
});

test("POST /v1/agents/{id}/goals requires title (400)", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const { res, body } = await postJson(`${shim.url}/v1/agents/${agentId}/goals`, {
    description: "Missing title",
  });
  assert.equal(res.status, 400);
  const err = body as { detail: string };
  assert.match(err.detail, /title is required/i);
});

test("POST /v1/agents/{id}/goals validates status (400)", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const { res, body } = await postJson(`${shim.url}/v1/agents/${agentId}/goals`, {
    title: "Test",
    status: "invalid-status",
  });
  assert.equal(res.status, 400);
  const err = body as { detail: string };
  assert.match(err.detail, /status must be one of/i);
});

test("POST /v1/agents/{id}/goals validates cadence (400)", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const { res, body } = await postJson(`${shim.url}/v1/agents/${agentId}/goals`, {
    title: "Test",
    cadence: "bad-cadence",
  });
  assert.equal(res.status, 400);
  const err = body as { detail: string };
  assert.match(err.detail, /cadence must be one of/i);
});

test("GET /v1/agents/{id}/goals lists goals with streak field", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  // Create two goals
  await postJson(`${shim.url}/v1/agents/${agentId}/goals`, { title: "Goal A" });
  await postJson(`${shim.url}/v1/agents/${agentId}/goals`, { title: "Goal B", cadence: "daily" });

  const { res, body } = await getJson(`${shim.url}/v1/agents/${agentId}/goals`);
  assert.equal(res.status, 200);
  const list = body as { goals: Array<{ id: string; title: string; streak: number }> };
  assert.equal(list.goals.length, 2);
  const titles = list.goals.map((g) => g.title).sort();
  assert.deepEqual(titles, ["Goal A", "Goal B"]);
  for (const g of list.goals) {
    assert.equal(typeof g.streak, "number", "streak is present and numeric");
  }
});

test("GET /v1/agents/{id}/goals/{goalId} returns 404 if not found", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const { res } = await getJson(`${shim.url}/v1/agents/${agentId}/goals/goal-missing`);
  assert.equal(res.status, 404);
});

test("GET /v1/agents/{id}/goals/{goalId} returns goal with streak", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const created = await postJson(`${shim.url}/v1/agents/${agentId}/goals`, { title: "Test Goal" });
  const goalId = (created.body as { id: string }).id;

  const { res, body } = await getJson(`${shim.url}/v1/agents/${agentId}/goals/${goalId}`);
  assert.equal(res.status, 200);
  const goal = body as { id: string; title: string; streak: number };
  assert.equal(goal.id, goalId);
  assert.equal(goal.title, "Test Goal");
  assert.equal(typeof goal.streak, "number");
});

test("PATCH /v1/agents/{id}/goals/{goalId} updates goal", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const created = await postJson(`${shim.url}/v1/agents/${agentId}/goals`, {
    title: "Old Title",
    status: "active",
  });
  const goalId = (created.body as { id: string }).id;

  const { res, body } = await patchJson(`${shim.url}/v1/agents/${agentId}/goals/${goalId}`, {
    title: "New Title",
    status: "paused",
  });
  assert.equal(res.status, 200);
  const updated = body as { id: string; title: string; status: string };
  assert.equal(updated.id, goalId);
  assert.equal(updated.title, "New Title");
  assert.equal(updated.status, "paused");
});

test("PATCH /v1/agents/{id}/goals/{goalId} validates status", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const created = await postJson(`${shim.url}/v1/agents/${agentId}/goals`, { title: "Test" });
  const goalId = (created.body as { id: string }).id;

  const { res, body } = await patchJson(`${shim.url}/v1/agents/${agentId}/goals/${goalId}`, {
    status: "bad-status",
  });
  assert.equal(res.status, 400);
  const err = body as { detail: string };
  assert.match(err.detail, /status must be one of/i);
});

test("PATCH /v1/agents/{id}/goals/{goalId} returns 404 if not found", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const { res } = await patchJson(`${shim.url}/v1/agents/${agentId}/goals/goal-missing`, {
    title: "Updated",
  });
  assert.equal(res.status, 404);
});

test("DELETE /v1/agents/{id}/goals/{goalId} removes goal", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const created = await postJson(`${shim.url}/v1/agents/${agentId}/goals`, { title: "To Delete" });
  const goalId = (created.body as { id: string }).id;

  const { res, body } = await deleteReq(`${shim.url}/v1/agents/${agentId}/goals/${goalId}`);
  assert.equal(res.status, 200);
  const deleted = body as { id: string; deleted: boolean };
  assert.equal(deleted.id, goalId);
  assert.equal(deleted.deleted, true);

  // Verify it's gone
  const get = await getJson(`${shim.url}/v1/agents/${agentId}/goals/${goalId}`);
  assert.equal(get.res.status, 404);
});

test("DELETE /v1/agents/{id}/goals/{goalId} returns 404 if not found", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const { res } = await deleteReq(`${shim.url}/v1/agents/${agentId}/goals/goal-missing`);
  assert.equal(res.status, 404);
});

test("POST /v1/agents/{id}/goals/{goalId}/progress records progress", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const created = await postJson(`${shim.url}/v1/agents/${agentId}/goals`, {
    title: "Daily exercise",
    cadence: "daily",
  });
  const goalId = (created.body as { id: string }).id;

  const { res, body } = await postJson(`${shim.url}/v1/agents/${agentId}/goals/${goalId}/progress`, {
    note: "Ran 5k",
    value: 5,
  });
  assert.equal(res.status, 200);
  const updated = body as { id: string; progress: Array<{ note: string; value: number }>; streak: number };
  assert.equal(updated.id, goalId);
  assert.equal(updated.progress.length, 1);
  assert.equal(updated.progress[0]!.note, "Ran 5k");
  assert.equal(updated.progress[0]!.value, 5);
  // Streak should be 1 (one day with progress, current or prior period)
  assert.ok(updated.streak >= 1, "streak reflects progress");
});

test("POST /v1/agents/{id}/goals/{goalId}/progress returns 404 if not found", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const { res } = await postJson(`${shim.url}/v1/agents/${agentId}/goals/goal-missing/progress`, {
    note: "Test",
  });
  assert.equal(res.status, 404);
});

test("GET /v1/agents/{id}/goals returns 404 if agent not found", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res } = await getJson(`${shim.url}/v1/agents/agent-missing/goals`);
  assert.equal(res.status, 404);
});

test("POST /v1/agents/{id}/goals returns 404 if agent not found", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res } = await postJson(`${shim.url}/v1/agents/agent-missing/goals`, {
    title: "Test",
  });
  assert.equal(res.status, 404);
});

test("Streak computation: daily cadence with progress shows streak", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir);

  const created = await postJson(`${shim.url}/v1/agents/${agentId}/goals`, {
    title: "Daily streak test",
    cadence: "daily",
  });
  const goalId = (created.body as { id: string }).id;

  // Record progress for today
  await postJson(`${shim.url}/v1/agents/${agentId}/goals/${goalId}/progress`, {
    note: "Day 1",
  });

  const { body } = await getJson(`${shim.url}/v1/agents/${agentId}/goals/${goalId}`);
  const goal = body as { streak: number };
  // Streak should be 1 (current period has progress)
  assert.equal(goal.streak, 1);
});
