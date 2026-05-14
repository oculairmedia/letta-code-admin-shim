/**
 * Behavioral tests for token-usage aggregation.
 *
 * The shim exposes `/shim/v1/usage/summary` — a greenfield (non-vanilla)
 * endpoint that rolls up per-run usage records into totals + optional
 * breakdowns by agent / conversation / day / model. See lib/runs.mjs's
 * `aggregateUsage()` for the data path.
 *
 * Notes on the math:
 *   - The run-level `usage` field stores the FIRST `usage_statistics`
 *     frame from the turn (see lib/agent-pool.mjs ~L323), NOT the sum
 *     across steps. So a 2-step bash-tool run rolls up to step1's tokens.
 *   - `group_by=model` walks per-step records in steps.jsonl and sums
 *     them, which IS the across-step total.
 *
 * Numbers in assertions come from the captured fixtures in
 * test/fixtures/stream-traces/. If those are re-captured, expected values
 * must be updated to match.
 *
 *   plain.jsonl              step1: p=6  c=6   t=12   cached=0
 *   bash-tool.jsonl          step1: p=6  c=97  t=103  cached=20133
 *                            step2: p=1  c=8   t=9    cached=35257
 *   read-tool.jsonl          step1: p=6  c=83  t=89   cached=20133
 *                            step2: p=1  c=22  t=23   cached=35277
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  startShim,
  seedAgent,
  seedConversation,
  externalConvId,
  streamMessages,
} from "./helpers/index.mjs";

// ── helpers ───────────────────────────────────────────────────────

async function sendTurn(shim, agentId, content, { convId, timeoutMs = 10_000 } = {}) {
  const conv = convId ?? externalConvId(agentId);
  const { frames, status } = await streamMessages(
    `${shim.url}/v1/conversations/${conv}/messages`,
    { messages: [{ role: "user", content }], streaming: true },
    { timeoutMs },
  );
  assert.equal(status, 200);
  const runId = frames.map((f) => f.run_id).find((id) => typeof id === "string");
  return { runId, frames };
}

async function getJson(url) {
  const res = await fetch(url);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

// ── tests ─────────────────────────────────────────────────────────

test("usage: empty shim returns zeroed total + run_count=0", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { status, body } = await getJson(`${shim.url}/shim/v1/usage/summary`);
  assert.equal(status, 200);
  assert.deepEqual(body.total, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    run_count: 0,
  });
  assert.equal(body.breakdown, undefined, "no group_by → no breakdown");
});

test("usage: one plain turn → total_tokens=12, run_count=1", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-usage-plain" });
  seedConversation(shim.stateDir, agentId);
  await sendTurn(shim, agentId, "reply with pong");

  const { body } = await getJson(`${shim.url}/shim/v1/usage/summary`);
  // plain trace: prompt=6, completion=6, total=12 (single step, single frame)
  assert.equal(body.total.prompt_tokens, 6);
  assert.equal(body.total.completion_tokens, 6);
  assert.equal(body.total.total_tokens, 12);
  assert.equal(body.total.run_count, 1);
});

test("usage: multiple turns sum correctly across runs", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-usage-multi" });
  seedConversation(shim.stateDir, agentId);

  await sendTurn(shim, agentId, "reply with pong");
  await sendTurn(shim, agentId, "reply with pong");
  await sendTurn(shim, agentId, "reply with pong");

  const { body } = await getJson(`${shim.url}/shim/v1/usage/summary`);
  // 3 × plain trace
  assert.equal(body.total.prompt_tokens, 18);
  assert.equal(body.total.completion_tokens, 18);
  assert.equal(body.total.total_tokens, 36);
  assert.equal(body.total.run_count, 3);
});

test("usage: filter by agent_id isolates one agent's usage", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const a1 = seedAgent(shim.stateDir, { id: "agent-usage-fa" });
  seedConversation(shim.stateDir, a1);
  const a2 = seedAgent(shim.stateDir, { id: "agent-usage-fb" });
  seedConversation(shim.stateDir, a2);

  await sendTurn(shim, a1, "reply with pong");
  await sendTurn(shim, a2, "reply with pong");
  await sendTurn(shim, a2, "reply with pong");

  const onlyA1 = await getJson(`${shim.url}/shim/v1/usage/summary?agent_id=${a1}`);
  assert.equal(onlyA1.body.total.total_tokens, 12);
  assert.equal(onlyA1.body.total.run_count, 1);

  const onlyA2 = await getJson(`${shim.url}/shim/v1/usage/summary?agent_id=${a2}`);
  assert.equal(onlyA2.body.total.total_tokens, 24);
  assert.equal(onlyA2.body.total.run_count, 2);
});

test("usage: filter by conversation_id isolates one conversation's usage", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-usage-conv" });
  seedConversation(shim.stateDir, agentId); // "default"
  seedConversation(shim.stateDir, agentId, { id: "conv-extra" });

  await sendTurn(shim, agentId, "reply with pong");
  await sendTurn(shim, agentId, "reply with pong", { convId: "conv-extra" });

  const def = await getJson(`${shim.url}/shim/v1/usage/summary?conversation_id=default`);
  assert.equal(def.body.total.run_count, 1);
  assert.equal(def.body.total.total_tokens, 12);

  const other = await getJson(`${shim.url}/shim/v1/usage/summary?conversation_id=conv-extra`);
  assert.equal(other.body.total.run_count, 1);
  assert.equal(other.body.total.total_tokens, 12);
});

test("usage: ?statuses=completed excludes cancelled runs", async (t) => {
  // Use a smaller delay than other cancel tests — we need a fast completed
  // turn FIRST, then a slow turn we can race a cancel against. A 300ms gap
  // is enough to win the race; the cancel SIGTERM kills the worker so the
  // remaining frames never arrive and the test stays under 30s.
  const shim = await startShim({ env: { LETTA_MOCK_DELAY_MS: "300" } });
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-usage-status" });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);

  // 1) completed turn (must finish — give it room to drain at 300ms × 9 frames ≈ 3s)
  await sendTurn(shim, agentId, "reply with pong", { timeoutMs: 15_000 });

  // 2) cancelled turn — launch slow, find active run, cancel, wait.
  const turnPromise = streamMessages(
    `${shim.url}/v1/conversations/${convId}/messages`,
    { messages: [{ role: "user", content: "reply with pong" }], streaming: true },
    { timeoutMs: 15_000 },
  );
  let runId = null;
  for (let i = 0; i < 30; i += 1) {
    const { body } = await getJson(`${shim.url}/v1/runs/?active=true`);
    if (body.length >= 1) { runId = body[0].id; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(runId);
  await fetch(`${shim.url}/v1/agents/${agentId}/messages/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_ids: [runId] }),
  });
  await turnPromise;

  // No filter — both runs included; cancelled run never set usage, so totals
  // still reflect only the completed run.
  const all = await getJson(`${shim.url}/shim/v1/usage/summary`);
  assert.equal(all.body.total.run_count, 2);
  assert.equal(all.body.total.total_tokens, 12);

  // statuses=completed — one run, totals unchanged.
  const completed = await getJson(`${shim.url}/shim/v1/usage/summary?statuses=completed`);
  assert.equal(completed.body.total.run_count, 1);
  assert.equal(completed.body.total.total_tokens, 12);

  // statuses=cancelled — one run, zero tokens (cancel happened before usage frame).
  const cancelled = await getJson(`${shim.url}/shim/v1/usage/summary?statuses=cancelled`);
  assert.equal(cancelled.body.total.run_count, 1);
  assert.equal(cancelled.body.total.total_tokens, 0);
});

test("usage: start/end window filters runs by created_at", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-usage-window" });
  seedConversation(shim.stateDir, agentId);

  const before = new Date().toISOString();
  await sendTurn(shim, agentId, "reply with pong");
  const after = new Date().toISOString();

  // Window covering the run — should include it.
  const inRange = await getJson(
    `${shim.url}/shim/v1/usage/summary?start=${encodeURIComponent(before)}&end=${encodeURIComponent(after)}`,
  );
  assert.equal(inRange.body.total.run_count, 1);

  // Window strictly in the future — should exclude it.
  const future = new Date(Date.now() + 60_000).toISOString();
  const farFuture = new Date(Date.now() + 120_000).toISOString();
  const outOfRange = await getJson(
    `${shim.url}/shim/v1/usage/summary?start=${encodeURIComponent(future)}&end=${encodeURIComponent(farFuture)}`,
  );
  assert.equal(outOfRange.body.total.run_count, 0);
  assert.equal(outOfRange.body.total.total_tokens, 0);
});

test("usage: group_by=agent — breakdown per agent, sorted by total_tokens desc", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const heavy = seedAgent(shim.stateDir, { id: "agent-grp-heavy" });
  seedConversation(shim.stateDir, heavy);
  const light = seedAgent(shim.stateDir, { id: "agent-grp-light" });
  seedConversation(shim.stateDir, light);

  // heavy: 2 plain turns; light: 1 plain turn
  await sendTurn(shim, heavy, "reply with pong");
  await sendTurn(shim, heavy, "reply with pong");
  await sendTurn(shim, light, "reply with pong");

  const { body } = await getJson(`${shim.url}/shim/v1/usage/summary?group_by=agent`);
  assert.ok(Array.isArray(body.breakdown));
  assert.equal(body.breakdown.length, 2);
  // sorted by total_tokens desc → heavy first
  assert.equal(body.breakdown[0].key, heavy);
  assert.equal(body.breakdown[0].total_tokens, 24);
  assert.equal(body.breakdown[0].run_count, 2);
  assert.equal(body.breakdown[1].key, light);
  assert.equal(body.breakdown[1].total_tokens, 12);
  assert.equal(body.breakdown[1].run_count, 1);
});

test("usage: group_by=conversation — breakdown per conversation_id", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-grp-conv" });
  seedConversation(shim.stateDir, agentId); // default
  seedConversation(shim.stateDir, agentId, { id: "conv-x" });

  await sendTurn(shim, agentId, "reply with pong");
  await sendTurn(shim, agentId, "reply with pong");
  await sendTurn(shim, agentId, "reply with pong", { convId: "conv-x" });

  const { body } = await getJson(`${shim.url}/shim/v1/usage/summary?group_by=conversation`);
  const keys = body.breakdown.map((b) => b.key).sort();
  assert.deepEqual(keys, ["conv-x", "default"]);
  const byKey = Object.fromEntries(body.breakdown.map((b) => [b.key, b]));
  assert.equal(byKey["default"].run_count, 2);
  assert.equal(byKey["default"].total_tokens, 24);
  assert.equal(byKey["conv-x"].run_count, 1);
  assert.equal(byKey["conv-x"].total_tokens, 12);
});

test("usage: group_by=day — breakdown bucket per YYYY-MM-DD", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-grp-day" });
  seedConversation(shim.stateDir, agentId);

  await sendTurn(shim, agentId, "reply with pong");
  await sendTurn(shim, agentId, "reply with pong");

  const { body } = await getJson(`${shim.url}/shim/v1/usage/summary?group_by=day`);
  // Both turns happen in the same calendar day in wall-clock time.
  assert.equal(body.breakdown.length, 1);
  assert.match(body.breakdown[0].key, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.breakdown[0].run_count, 2);
  assert.equal(body.breakdown[0].total_tokens, 24);
});

test("usage: group_by=model — sums per-step usage from steps.jsonl", async (t) => {
  // group_by=model walks per-step records (not run-level). Since the mock
  // doesn't stamp a model id on its stop_reason frames, every step ends up
  // under "unknown" — and the total is the SUM across steps, not the
  // run-level first-frame value.
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-grp-model" });
  seedConversation(shim.stateDir, agentId);

  await sendTurn(shim, agentId, "run bash echo hello"); // bash-tool: 2 steps

  const { body } = await getJson(`${shim.url}/shim/v1/usage/summary?group_by=model`);
  assert.ok(Array.isArray(body.breakdown));
  assert.equal(body.breakdown.length, 1);
  assert.equal(body.breakdown[0].key, "unknown");
  // bash-tool step1+step2: p=6+1=7, c=97+8=105, t=103+9=112
  assert.equal(body.breakdown[0].prompt_tokens, 7);
  assert.equal(body.breakdown[0].completion_tokens, 105);
  assert.equal(body.breakdown[0].total_tokens, 112);
  // The run-level total in this aggregation is also the step sum:
  assert.equal(body.total.total_tokens, 112);
});

test("usage: invalid group_by → 400 listing allowed values", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { status, body } = await getJson(`${shim.url}/shim/v1/usage/summary?group_by=bogus`);
  assert.equal(status, 400);
  assert.equal(typeof body.detail, "string");
  for (const allowed of ["agent", "conversation", "model", "day"]) {
    assert.match(body.detail, new RegExp(allowed));
  }
});

test("usage: steps.jsonl per-step usages sum to the run-level total for bash-tool", async (t) => {
  // For a 2-step bash-tool turn: the run-level `usage` records only the
  // FIRST step's tokens (agent-pool grabs the first usage_statistics frame).
  // Per-step records preserve EACH step's usage. This test verifies the
  // per-step records sum to the cross-step total (p=7 c=105 t=112), which
  // is what `group_by=model` returns.
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-usage-steps" });
  seedConversation(shim.stateDir, agentId);
  const { runId } = await sendTurn(shim, agentId, "run bash echo hello");

  const { body: steps } = await getJson(`${shim.url}/v1/runs/${runId}/steps`);
  assert.equal(steps.length, 2);
  const sum = steps.reduce(
    (acc, s) => ({
      prompt_tokens: acc.prompt_tokens + (s.usage?.prompt_tokens ?? 0),
      completion_tokens: acc.completion_tokens + (s.usage?.completion_tokens ?? 0),
      total_tokens: acc.total_tokens + (s.usage?.total_tokens ?? 0),
      cached_input_tokens: acc.cached_input_tokens + (s.usage?.cached_input_tokens ?? 0),
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_input_tokens: 0 },
  );
  // step1 (p=6 c=97 t=103 cached=20133) + step2 (p=1 c=8 t=9 cached=35257)
  assert.equal(sum.prompt_tokens, 7);
  assert.equal(sum.completion_tokens, 105);
  assert.equal(sum.total_tokens, 112);
  assert.equal(sum.cached_input_tokens, 55390);
});

test("usage: cached_input_tokens propagates through aggregation", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-usage-cached" });
  seedConversation(shim.stateDir, agentId);

  // bash-tool run-level usage = first step's frame: cached=20133.
  await sendTurn(shim, agentId, "run bash echo hello");

  const { body } = await getJson(`${shim.url}/shim/v1/usage/summary`);
  assert.equal(body.total.cached_input_tokens, 20133);
  assert.equal(body.total.run_count, 1);
  // run-level total_tokens reflects step1 only (see file header):
  assert.equal(body.total.total_tokens, 103);
});

test("usage: agent_ids[] multi-match filter", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const a = seedAgent(shim.stateDir, { id: "agent-ids-a" });
  seedConversation(shim.stateDir, a);
  const b = seedAgent(shim.stateDir, { id: "agent-ids-b" });
  seedConversation(shim.stateDir, b);
  const c = seedAgent(shim.stateDir, { id: "agent-ids-c" });
  seedConversation(shim.stateDir, c);

  await sendTurn(shim, a, "reply with pong");
  await sendTurn(shim, b, "reply with pong");
  await sendTurn(shim, c, "reply with pong");

  const { body } = await getJson(
    `${shim.url}/shim/v1/usage/summary?agent_ids=${a}&agent_ids=${c}`,
  );
  assert.equal(body.total.run_count, 2);
  assert.equal(body.total.total_tokens, 24);
});
