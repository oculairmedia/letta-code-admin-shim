/**
 * Behavioral tests for Run-record lifecycle.
 *
 * The admin-shim overlays a vanilla-Letta-compatible Run abstraction on
 * top of letta-code's LocalBackend (which has none). One Run is created
 * per turn; mobile polls/cancels them via /v1/runs/*. These tests pin
 * down the wire contract before the .mjs→.ts migration.
 *
 * Behaviour under test (see lib/runs.mjs + lib/agent-pool.mjs):
 *   - Run created on turn start, finalized on turn end
 *   - Listing + filtering + pagination
 *   - Per-run usage / metrics / steps projections
 *   - Cancel (POST /v1/agents/{id}/messages/cancel)
 *   - Delete (DELETE /v1/runs/{id})
 *   - On-disk persistence under ${stateDir}/runs/<id>/run.json
 *
 * Numbers in assertions come from the captured stream-trace fixtures in
 * test/fixtures/stream-traces/. If those fixtures are re-captured, the
 * expected token / step counts here must be updated to match.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  startShim,
  seedAgent,
  seedConversation,
  seedMessage,
  externalConvId,
  streamMessages,
} from "./helpers/index.js";
import type { ShimHandle } from "./helpers/shim.js";
import type { SseFrame } from "./helpers/sse.js";

// ── types ─────────────────────────────────────────────────────────

// Loose Run shape covering vanilla + shim fields the tests poke at.
interface RunRecord {
  id: string;
  agent_id: string;
  conversation_id: string;
  status: string;
  stop_reason: string;
  created_at: string;
  completed_at: string;
  total_duration_ns: number;
  ttft_ns: number;
  message_ids: string[];
  tools_used: string[];
  num_steps: number;
  usage: unknown;
}

interface RunUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  step_count: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
}

interface RunMetrics {
  id: string;
  agent_id: string;
  organization_id: string | null;
  project_id: string | null;
  run_start_ns: number;
  run_ns: number;
  num_steps: number;
  tools_used: string[];
}

interface RunStep {
  usage?: unknown;
  stop_reason?: unknown;
  run_id?: string;
}

interface SendTurnOptions {
  convId?: string;
  timeoutMs?: number;
}

interface SendTurnResult {
  runId: string | undefined;
  frames: SseFrame[];
  doneSeen: boolean;
}

// ── helpers ───────────────────────────────────────────────────────

/** Send a user message and return { runId, frames, doneSeen }. */
async function sendTurn(
  shim: ShimHandle,
  agentId: string,
  content: string,
  { convId, timeoutMs = 10_000 }: SendTurnOptions = {},
): Promise<SendTurnResult> {
  const conv = convId ?? externalConvId(agentId);
  const { frames, doneSeen, status } = await streamMessages(
    `${shim.url}/v1/conversations/${conv}/messages`,
    { messages: [{ role: "user", content }], streaming: true },
    { timeoutMs },
  );
  assert.equal(status, 200, "POST should be 200");
  // Pull run_id off the first frame that has it — every turn frame carries
  // the same id once chat.mjs has stamped it.
  const runId = frames
    .map((f) => (f as { run_id?: unknown }).run_id)
    .find((id): id is string => typeof id === "string");
  return { runId, frames, doneSeen };
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  let body: unknown = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

function readRunRecord(stateDir: string, runId: string): RunRecord | null {
  const p = join(stateDir, "runs", runId, "run.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as RunRecord;
}

// ── tests ─────────────────────────────────────────────────────────

test("runs: turn creates a Run record reachable via GET /v1/runs/{id}", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-001" });
  seedConversation(shim.stateDir, agentId);

  const { runId } = await sendTurn(shim, agentId, "reply with pong");
  assert.ok(runId, "stream frames should carry a run_id");
  assert.match(runId, /^run-/, "run_id should use the shim's run- prefix, not local-run-");

  const { status, body } = await getJson(`${shim.url}/v1/runs/${runId}`);
  const b = body as RunRecord;
  assert.equal(status, 200);
  assert.equal(b.id, runId);
  assert.equal(b.agent_id, agentId);
  assert.equal(b.conversation_id, "default");
  assert.equal(b.status, "completed");
  // plain trace ends with stop_reason="end_turn" (single step)
  assert.equal(b.stop_reason, "end_turn");
  assert.ok(typeof b.created_at === "string" && b.created_at.length > 0);
  assert.ok(typeof b.completed_at === "string" && b.completed_at.length > 0);
  assert.ok(b.total_duration_ns > 0, "wall-clock duration should be > 0");
  assert.ok(b.ttft_ns > 0, "ttft should be > 0");
});

test("runs: fresh shim returns [] from GET /v1/runs/", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { status, body } = await getJson(`${shim.url}/v1/runs/`);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test("runs: one turn → listRuns returns one record with correct ids", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-002" });
  seedConversation(shim.stateDir, agentId);
  const { runId } = await sendTurn(shim, agentId, "reply with pong");

  const { body } = await getJson(`${shim.url}/v1/runs/`);
  const arr = body as RunRecord[];
  assert.ok(Array.isArray(arr));
  assert.equal(arr.length, 1);
  assert.equal(arr[0]!.id, runId);
  assert.equal(arr[0]!.agent_id, agentId);
  assert.equal(arr[0]!.conversation_id, "default");
});

test("runs: multiple turns → listRuns ordered desc by created_at", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-003" });
  seedConversation(shim.stateDir, agentId);

  const a = await sendTurn(shim, agentId, "reply with pong");
  const b = await sendTurn(shim, agentId, "reply with pong");
  const c = await sendTurn(shim, agentId, "reply with pong");

  const { body } = await getJson(`${shim.url}/v1/runs/`);
  const arr = body as RunRecord[];
  assert.equal(arr.length, 3);
  // desc — most recent first
  assert.equal(arr[0]!.id, c.runId);
  assert.equal(arr[1]!.id, b.runId);
  assert.equal(arr[2]!.id, a.runId);
});

test("runs: listRuns filters by agent_id, conversation_id, statuses", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const a1 = seedAgent(shim.stateDir, { id: "agent-run-fa" });
  seedConversation(shim.stateDir, a1);
  const a2 = seedAgent(shim.stateDir, { id: "agent-run-fb" });
  seedConversation(shim.stateDir, a2);

  await sendTurn(shim, a1, "reply with pong");
  await sendTurn(shim, a2, "reply with pong");

  // agent_id filter
  const byA1 = await getJson(`${shim.url}/v1/runs/?agent_id=${a1}`);
  const byA1Arr = byA1.body as RunRecord[];
  assert.equal(byA1Arr.length, 1);
  assert.equal(byA1Arr[0]!.agent_id, a1);

  // conversation_id filter
  const byConv = await getJson(`${shim.url}/v1/runs/?conversation_id=default`);
  const byConvArr = byConv.body as RunRecord[];
  assert.equal(byConvArr.length, 2);

  // statuses=completed → both completed runs
  const byCompleted = await getJson(`${shim.url}/v1/runs/?statuses=completed`);
  const byCompletedArr = byCompleted.body as RunRecord[];
  assert.equal(byCompletedArr.length, 2);

  // statuses=running → no runs are still running after both turns finished
  const byRunning = await getJson(`${shim.url}/v1/runs/?statuses=running`);
  const byRunningArr = byRunning.body as RunRecord[];
  assert.equal(byRunningArr.length, 0);
});

test("runs: listRuns?active=true returns 1 mid-turn, 0 once finished", async (t) => {
  const shim = await startShim({ env: { LETTA_MOCK_DELAY_MS: "200" } });
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-active" });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);

  // Kick the turn off in the background; while frames trickle in we sample
  // active=true via the listRuns endpoint.
  const turnPromise = streamMessages(
    `${shim.url}/v1/conversations/${convId}/messages`,
    { messages: [{ role: "user", content: "reply with pong" }], streaming: true },
    { timeoutMs: 15_000 },
  );

  // Poll for an active run for up to ~3s — startup + first frame in the mock
  // need to land before the Run record is on disk.
  let sawActive = false;
  for (let i = 0; i < 30; i += 1) {
    const { body } = await getJson(`${shim.url}/v1/runs/?active=true`);
    const arr = body as RunRecord[];
    if (arr.length >= 1) {
      assert.equal(arr[0]!.status, "running");
      sawActive = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(sawActive, "should see an active run mid-turn with LETTA_MOCK_DELAY_MS=200");

  // Wait for the turn to finish, then re-check.
  await turnPromise;
  const after = await getJson(`${shim.url}/v1/runs/?active=true`);
  const afterArr = after.body as RunRecord[];
  assert.equal(afterArr.length, 0, "no active runs after turn finishes");
});

test("runs: listRuns?active=false returns the completed runs", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-inactive" });
  seedConversation(shim.stateDir, agentId);
  await sendTurn(shim, agentId, "reply with pong");

  const { body } = await getJson(`${shim.url}/v1/runs/?active=false`);
  const arr = body as RunRecord[];
  assert.equal(arr.length, 1);
  assert.equal(arr[0]!.status, "completed");
});

test("runs: listRuns pagination — ?limit=2&before=<id>", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-page" });
  seedConversation(shim.stateDir, agentId);

  const a = await sendTurn(shim, agentId, "reply with pong");
  const b = await sendTurn(shim, agentId, "reply with pong");
  const c = await sendTurn(shim, agentId, "reply with pong");

  // Default order=desc: [c, b, a]. listRuns's `before` / `after` are
  // position-based on the sorted list:
  //   ?after=c  → entries appearing AFTER c in the list, i.e. older runs.
  // (cf. lib/runs.mjs listRuns — vanilla matches this semantic.)
  const { body } = await getJson(`${shim.url}/v1/runs/?limit=2&after=${c.runId}`);
  const arr = body as RunRecord[];
  assert.equal(arr.length, 2);
  assert.equal(arr[0]!.id, b.runId);
  assert.equal(arr[1]!.id, a.runId);

  // And ?before=a → entries appearing BEFORE a (newer) → [c, b]; limit=2.
  const fwd = await getJson(`${shim.url}/v1/runs/?limit=2&before=${a.runId}`);
  const fwdArr = fwd.body as RunRecord[];
  assert.equal(fwdArr.length, 2);
  assert.equal(fwdArr[0]!.id, c.runId);
  assert.equal(fwdArr[1]!.id, b.runId);
});

test("runs: GET /v1/runs/{id} response includes all vanilla + shim fields", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-shape" });
  seedConversation(shim.stateDir, agentId);
  const { runId } = await sendTurn(shim, agentId, "reply with pong");

  const { body } = await getJson(`${shim.url}/v1/runs/${runId}`);
  const b = body as Record<string, unknown>;
  // Vanilla Run fields
  for (const key of [
    "id",
    "agent_id",
    "conversation_id",
    "status",
    "created_at",
    "completed_at",
    "stop_reason",
    "total_duration_ns",
    "ttft_ns",
  ]) {
    assert.ok(key in b, `vanilla field "${key}" missing`);
  }
  // Shim extensions
  for (const key of ["message_ids", "tools_used", "num_steps", "usage"]) {
    assert.ok(key in b, `shim extension "${key}" missing`);
  }
});

test("runs: GET /v1/runs/{unknown} → 404 with { detail }", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { status, body } = await getJson(`${shim.url}/v1/runs/run-does-not-exist`);
  const b = body as { detail: string };
  assert.equal(status, 404);
  assert.equal(typeof b.detail, "string");
  assert.match(b.detail, /run/i);
});

test("runs: GET /v1/runs/count is an integer matching list length", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const empty = await getJson(`${shim.url}/v1/runs/count`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body, 0);

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-count" });
  seedConversation(shim.stateDir, agentId);
  await sendTurn(shim, agentId, "reply with pong");
  await sendTurn(shim, agentId, "reply with pong");

  const after = await getJson(`${shim.url}/v1/runs/count`);
  assert.equal(after.body, 2);
});

test("runs: GET /v1/runs/{id}/usage — plain trace = 12 total_tokens (p=6,c=6)", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-usage" });
  seedConversation(shim.stateDir, agentId);
  const { runId } = await sendTurn(shim, agentId, "reply with pong");

  const { body } = await getJson(`${shim.url}/v1/runs/${runId}/usage`);
  const b = body as RunUsage;
  // Numbers come from fixtures/stream-traces/plain.jsonl — if that fixture
  // is re-captured the expected values here must move with it.
  assert.equal(b.prompt_tokens, 6);
  assert.equal(b.completion_tokens, 6);
  assert.equal(b.total_tokens, 12);
  assert.equal(b.step_count, 1);
  assert.equal(b.cached_input_tokens, 0);
  assert.equal(b.cache_write_tokens, 0);
  assert.equal(b.reasoning_tokens, 0);
});

test("runs: GET /v1/runs/{id}/metrics — shape + values from a real run", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-metrics" });
  seedConversation(shim.stateDir, agentId);
  const { runId } = await sendTurn(shim, agentId, "reply with pong");

  const { status, body } = await getJson(`${shim.url}/v1/runs/${runId}/metrics`);
  const b = body as RunMetrics;
  assert.equal(status, 200);
  assert.equal(b.id, runId);
  assert.equal(b.agent_id, agentId);
  assert.equal(b.organization_id, null);
  assert.equal(b.project_id, null);
  assert.ok(typeof b.run_start_ns === "number" && b.run_start_ns > 0);
  assert.ok(typeof b.run_ns === "number" && b.run_ns > 0);
  assert.equal(b.num_steps, 1); // plain trace → 1 step
  assert.deepEqual(b.tools_used, []); // plain trace has no tool calls
});

test("runs: GET /v1/runs/{id}/steps — plain=1 step, bash-tool=2 steps with usage+stop_reason", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  // plain: single step, no tools
  const aPlain = seedAgent(shim.stateDir, { id: "agent-steps-plain" });
  seedConversation(shim.stateDir, aPlain);
  const r1 = await sendTurn(shim, aPlain, "reply with pong");
  const p1 = await getJson(`${shim.url}/v1/runs/${r1.runId}/steps`);
  const p1Arr = p1.body as RunStep[];
  assert.equal(p1.status, 200);
  assert.equal(p1Arr.length, 1);
  assert.ok(p1Arr[0]!.usage, "step record should carry per-step usage");
  assert.ok(p1Arr[0]!.stop_reason, "step record should carry stop_reason");

  // bash-tool: 2 steps (tool-call step + final assistant step)
  const aBash = seedAgent(shim.stateDir, { id: "agent-steps-bash" });
  seedConversation(shim.stateDir, aBash);
  const r2 = await sendTurn(shim, aBash, "run bash echo hello");
  const p2 = await getJson(`${shim.url}/v1/runs/${r2.runId}/steps`);
  const p2Arr = p2.body as RunStep[];
  assert.equal(p2Arr.length, 2);
  for (const step of p2Arr) {
    assert.ok(step.usage, "every step should have usage");
    assert.ok(step.stop_reason, "every step should have stop_reason");
    assert.equal(step.run_id, r2.runId);
  }
});

test("runs: GET /v1/runs/{id}/messages — mock-only turn returns []", async (t) => {
  // The captured mock doesn't append to messages.jsonl, so the Run record's
  // message_ids stays empty and the /messages projection has nothing to
  // emit. This is intentional behaviour for the mock; a real letta worker
  // writes to disk and this list is non-empty. Recapturing the fixtures or
  // adding a disk-write mock would change this; for now we pin the empty
  // shape so future migrations don't accidentally regress to non-empty.
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-msgs" });
  seedConversation(shim.stateDir, agentId);
  const { runId } = await sendTurn(shim, agentId, "reply with pong");

  const { status, body } = await getJson(`${shim.url}/v1/runs/${runId}/messages`);
  assert.equal(status, 200);
  assert.deepEqual(body, []);

  // Sanity: the run record's message_ids matches the projection.
  const run = readRunRecord(shim.stateDir, runId!);
  assert.deepEqual(run!.message_ids, []);
});

test("runs: tools_used is recorded + deduped per turn", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const a1 = seedAgent(shim.stateDir, { id: "agent-tools-bash" });
  seedConversation(shim.stateDir, a1);
  const a2 = seedAgent(shim.stateDir, { id: "agent-tools-multi" });
  seedConversation(shim.stateDir, a2);
  const a3 = seedAgent(shim.stateDir, { id: "agent-tools-inter" });
  seedConversation(shim.stateDir, a3);

  // bash-tool → ["Bash"]
  const r1 = await sendTurn(shim, a1, "run bash echo hello");
  const b1 = await getJson(`${shim.url}/v1/runs/${r1.runId}`);
  assert.deepEqual((b1.body as RunRecord).tools_used, ["Bash"]);

  // multi-tool-bash-read → ["Bash", "Read"] (insertion order preserved)
  const r2 = await sendTurn(shim, a2, "multi tool call please");
  const b2 = await getJson(`${shim.url}/v1/runs/${r2.runId}`);
  assert.deepEqual((b2.body as RunRecord).tools_used.sort(), ["Bash", "Read"]);

  // interleaved-tools → only Bash (deduped across the multiple tool steps)
  const r3 = await sendTurn(shim, a3, "interleaved one at a time");
  const b3 = await getJson(`${shim.url}/v1/runs/${r3.runId}`);
  assert.deepEqual((b3.body as RunRecord).tools_used, ["Bash"]);
});

test("runs: num_steps mirrors model-step count from stop_reason frames", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const aPlain = seedAgent(shim.stateDir, { id: "agent-nsteps-plain" });
  seedConversation(shim.stateDir, aPlain);
  const aBash = seedAgent(shim.stateDir, { id: "agent-nsteps-bash" });
  seedConversation(shim.stateDir, aBash);
  const aInter = seedAgent(shim.stateDir, { id: "agent-nsteps-inter" });
  seedConversation(shim.stateDir, aInter);

  const r1 = await sendTurn(shim, aPlain, "reply with pong");
  const r2 = await sendTurn(shim, aBash, "run bash echo hello");
  const r3 = await sendTurn(shim, aInter, "interleaved one at a time");

  const b1 = await getJson(`${shim.url}/v1/runs/${r1.runId}`);
  const b2 = await getJson(`${shim.url}/v1/runs/${r2.runId}`);
  const b3 = await getJson(`${shim.url}/v1/runs/${r3.runId}`);

  // step counts derived from stop_reason frame count in each fixture:
  //   plain.jsonl              → 1
  //   bash-tool.jsonl          → 2
  //   interleaved-tools.jsonl  → 4  (one stop_reason per step; 3 tool steps
  //                                  + 1 final assistant step)
  assert.equal((b1.body as RunRecord).num_steps, 1);
  assert.equal((b2.body as RunRecord).num_steps, 2);
  assert.equal((b3.body as RunRecord).num_steps, 4);
});

test("runs: cancel via POST /v1/agents/{id}/messages/cancel with run_ids", async (t) => {
  const shim = await startShim({ env: { LETTA_MOCK_DELAY_MS: "1500" } });
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-cancel-run" });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);

  // Kick off a slow turn in the background.
  const turnPromise = streamMessages(
    `${shim.url}/v1/conversations/${convId}/messages`,
    { messages: [{ role: "user", content: "reply with pong" }], streaming: true },
    { timeoutMs: 20_000 },
  );

  // Find the active run.
  let runId: string | null = null;
  for (let i = 0; i < 30; i += 1) {
    const { body } = await getJson(`${shim.url}/v1/runs/?active=true`);
    const arr = body as RunRecord[];
    if (arr.length >= 1) { runId = arr[0]!.id; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(runId, "should observe an active run before cancel");

  // Issue the cancel.
  const cancelRes = await fetch(`${shim.url}/v1/agents/${agentId}/messages/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_ids: [runId] }),
  });
  assert.equal(cancelRes.status, 200);
  const cancelBody = await cancelRes.json() as Record<string, string>;
  assert.equal(cancelBody[runId], "cancelled");

  // Wait for the in-flight stream to drain (worker SIGTERM'd).
  await turnPromise;

  // Run record should reflect the cancellation.
  const { body } = await getJson(`${shim.url}/v1/runs/${runId}`);
  const b = body as RunRecord;
  assert.equal(b.status, "cancelled");
  assert.equal(b.stop_reason, "user_cancelled");
});

test("runs: cancel with empty run_ids cancels ALL active runs for the agent", async (t) => {
  const shim = await startShim({ env: { LETTA_MOCK_DELAY_MS: "1500" } });
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-cancel-all" });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);

  const turnPromise = streamMessages(
    `${shim.url}/v1/conversations/${convId}/messages`,
    { messages: [{ role: "user", content: "reply with pong" }], streaming: true },
    { timeoutMs: 20_000 },
  );

  let runId: string | null = null;
  for (let i = 0; i < 30; i += 1) {
    const { body } = await getJson(`${shim.url}/v1/runs/?active=true`);
    const arr = body as RunRecord[];
    if (arr.length >= 1) { runId = arr[0]!.id; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(runId);

  // No run_ids → cancel all active for agent.
  const cancelRes = await fetch(`${shim.url}/v1/agents/${agentId}/messages/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(cancelRes.status, 200);
  const cancelBody = await cancelRes.json() as Record<string, string>;
  assert.equal(cancelBody[runId], "cancelled");

  await turnPromise;
});

test("runs: cancel unknown run returns not_found; cancel wrong agent returns agent_mismatch", async (t) => {
  const shim = await startShim({ env: { LETTA_MOCK_DELAY_MS: "1500" } });
  t.after(() => shim.stop());

  const agentA = seedAgent(shim.stateDir, { id: "agent-cancel-mismatch-a" });
  seedConversation(shim.stateDir, agentA);
  const agentB = seedAgent(shim.stateDir, { id: "agent-cancel-mismatch-b" });
  seedConversation(shim.stateDir, agentB);
  const convA = externalConvId(agentA);

  // not_found path — no active turn at all.
  const r1 = await fetch(`${shim.url}/v1/agents/${agentA}/messages/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_ids: ["run-does-not-exist"] }),
  });
  const b1 = await r1.json() as Record<string, string>;
  assert.equal(b1["run-does-not-exist"], "not_found");

  // agent_mismatch: start a turn on agent A, attempt cancel via agent B.
  const turnPromise = streamMessages(
    `${shim.url}/v1/conversations/${convA}/messages`,
    { messages: [{ role: "user", content: "reply with pong" }], streaming: true },
    { timeoutMs: 20_000 },
  );

  let runId: string | null = null;
  for (let i = 0; i < 30; i += 1) {
    const { body } = await getJson(`${shim.url}/v1/runs/?active=true`);
    const arr = body as RunRecord[];
    if (arr.length >= 1) { runId = arr[0]!.id; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(runId);

  const r2 = await fetch(`${shim.url}/v1/agents/${agentB}/messages/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_ids: [runId] }),
  });
  const b2 = await r2.json() as Record<string, string>;
  assert.equal(b2[runId], "agent_mismatch");

  // Clean up: cancel via correct agent so the stream drains promptly.
  await fetch(`${shim.url}/v1/agents/${agentA}/messages/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_ids: [runId] }),
  });
  await turnPromise;
});

test("runs: DELETE /v1/runs/{id} removes the record + dir", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-delete" });
  seedConversation(shim.stateDir, agentId);
  const { runId } = await sendTurn(shim, agentId, "reply with pong");

  // Pre-condition: record exists.
  assert.ok(readRunRecord(shim.stateDir, runId!));

  const del = await fetch(`${shim.url}/v1/runs/${runId}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const delBody = await del.json() as { deleted: boolean; id: string };
  assert.equal(delBody.deleted, true);
  assert.equal(delBody.id, runId);

  // GET → 404 now.
  const after = await getJson(`${shim.url}/v1/runs/${runId}`);
  assert.equal(after.status, 404);

  // Directory removed.
  assert.equal(existsSync(join(shim.stateDir, "runs", runId!)), false);
});

test("runs: run record persisted on disk at ${stateDir}/runs/<id>/run.json", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-disk" });
  seedConversation(shim.stateDir, agentId);
  const { runId } = await sendTurn(shim, agentId, "reply with pong");

  const path = join(shim.stateDir, "runs", runId!, "run.json");
  assert.ok(existsSync(path), `run.json should exist at ${path}`);
  const rec = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
  assert.equal(rec.id, runId);
  assert.equal(rec.agent_id, agentId);
  assert.equal(rec.status, "completed");
  assert.ok(rec.usage, "completed run should have usage on disk");
});

test("runs: cancelled run still produces a persisted record", async (t) => {
  const shim = await startShim({ env: { LETTA_MOCK_DELAY_MS: "1500" } });
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-cancel-persist" });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);

  const turnPromise = streamMessages(
    `${shim.url}/v1/conversations/${convId}/messages`,
    { messages: [{ role: "user", content: "reply with pong" }], streaming: true },
    { timeoutMs: 20_000 },
  );

  let runId: string | null = null;
  for (let i = 0; i < 30; i += 1) {
    const { body } = await getJson(`${shim.url}/v1/runs/?active=true`);
    const arr = body as RunRecord[];
    if (arr.length >= 1) { runId = arr[0]!.id; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(runId);

  await fetch(`${shim.url}/v1/agents/${agentId}/messages/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_ids: [runId] }),
  });
  await turnPromise;

  const rec = readRunRecord(shim.stateDir, runId);
  assert.ok(rec, "cancelled run record should still be on disk");
  assert.equal(rec.status, "cancelled");
  assert.equal(rec.stop_reason, "user_cancelled");
  assert.ok(rec.completed_at, "cancel should stamp completed_at");
  assert.ok(rec.total_duration_ns > 0);
});

test("runs: frames emitted during a turn carry the matching run_id", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-run-frameid" });
  seedConversation(shim.stateDir, agentId);
  const { runId, frames } = await sendTurn(shim, agentId, "reply with pong");
  assert.ok(runId);

  // Every assistant/reasoning/tool frame should carry the shim's run_id, NOT
  // the captured `local-run-1`. (stop_reason/usage_statistics intentionally
  // omit the id per the wire contract; see chat.mjs reshapeFrame. The
  // opening `ping` frame is also exempt — it is written before the worker
  // resolves and the run_id is known.)
  const stamped = frames.filter((f) =>
    ["assistant_message", "reasoning_message", "tool_call_message"].includes(f.message_type),
  );
  assert.ok(stamped.length > 0, "should have at least one stampable frame");
  for (const f of stamped) {
    const fr = f as { message_type: string; run_id?: unknown };
    assert.equal(fr.run_id, runId, `frame ${fr.message_type} should be stamped with ${runId}`);
  }
});

test("runs: bash-tool turn summarizes final stop_reason but preserves approval step", async (t) => {
  // lcp-gukg: run-level stop_reason must represent the final effective turn
  // state so mobile does not treat a completed auto-approved tool turn as a
  // still-pending approval. The intermediate approval stop remains available
  // in steps.jsonl for diagnostics.
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-stopreason" });
  seedConversation(shim.stateDir, agentId);
  const { runId } = await sendTurn(shim, agentId, "run bash echo hello");

  const { body } = await getJson(`${shim.url}/v1/runs/${runId}`);
  const b = body as RunRecord;
  assert.equal(b.status, "completed");
  assert.equal(b.stop_reason, "end_turn");

  const stepsRes = await getJson(`${shim.url}/v1/runs/${runId}/steps`);
  const steps = stepsRes.body as { stop_reason?: string | null }[];
  assert.deepEqual(
    new Set(steps.map((step) => step.stop_reason)),
    new Set(["requires_approval", "end_turn"]),
  );
});

// ─── lcp-nwd: message-list projections must carry run_id ──────────────
//
// Regression guard: mobile groups chat bubbles by run_id for its
// collapsible run-block affordance. Previously every projected message
// had run_id: null because the wire projection hardcoded it. Fix:
// runs.buildMessageRunMap() walks run.message_ids[] to build the
// inverse index; server handlers pass it into LocalMessageScope, and
// translate.ts substitutes scope.runIdsByMessageId?.[id] ?? null.
//
// These tests seed messages + a run record directly so they don't
// depend on the mock worker persisting messages (it doesn't in the
// happy-path traces — recordRunMessage only fires when listMessages
// post-turn shows a diff, which our trace-replay mock can't simulate
// because it doesn't write messages.jsonl).

/** Write a synthetic run record claiming the given message ids. */
function seedRun(
  stateDir: string,
  {
    runId,
    agentId,
    conversationId,
    messageIds,
    status = "completed",
    stopReason = "end_turn",
  }: {
    runId: string;
    agentId: string;
    conversationId: string;
    messageIds: string[];
    status?: string;
    stopReason?: string;
  },
): void {
  const dir = join(stateDir, "runs", runId);
  mkdirSync(dir, { recursive: true });
  const now = "2026-01-01T00:00:10.000Z";
  const record = {
    id: runId,
    agent_id: agentId,
    conversation_id: conversationId,
    status,
    stop_reason: stopReason,
    message_ids: messageIds,
    tools_used: [],
    num_steps: 1,
    background: false,
    created_at: now,
    completed_at: now,
    started_at: now,
    total_duration_ns: 1_000_000_000,
    ttft_ns: 100_000_000,
    base_template_id: null,
    callback_error: null,
    callback_sent_at: null,
    callback_status_code: null,
    callback_url: null,
    metadata: {},
    request_config: null,
    usage: null,
    template_id: null,
  };
  writeFileSync(join(dir, "run.json"), JSON.stringify(record, null, 2));
}

test("lcp-nwd: GET /v1/conversations/{ext}/messages projects run_id on claimed messages", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-runid-conv" });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);

  const uMsgId = seedMessage(shim.stateDir, agentId, "default", {
    id: "ui-msg-nwd-u",
    role: "user",
    content: "hello",
    sourceMessageIndex: 0,
  });
  const aMsgId = seedMessage(shim.stateDir, agentId, "default", {
    id: "ui-msg-nwd-a",
    role: "assistant",
    content: "hi back",
    sourceMessageIndex: 1,
  });
  // Unclaimed message — must remain run_id=null.
  const orphanId = seedMessage(shim.stateDir, agentId, "default", {
    id: "ui-msg-nwd-o",
    role: "user",
    content: "later",
    sourceMessageIndex: 2,
  });

  const runId = "run-nwd-conv-001";
  seedRun(shim.stateDir, {
    runId,
    agentId,
    conversationId: "default",
    messageIds: [uMsgId, aMsgId],
  });

  const { status, body } = await getJson(`${shim.url}/v1/conversations/${convId}/messages?limit=50`);
  assert.equal(status, 200);
  const arr = body as Array<{ id: string; run_id: string | null }>;
  const byId = new Map(arr.map((m) => [m.id, m]));
  assert.equal(byId.get(uMsgId)?.run_id, runId, "claimed user message must carry run_id");
  assert.equal(byId.get(aMsgId)?.run_id, runId, "claimed assistant message must carry run_id");
  assert.equal(byId.get(orphanId)?.run_id, null, "unclaimed message must stay null");
});

test("lcp-nwd: GET /v1/agents/{id}/messages legacy shape also carries run_id", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-runid-legacy" });
  seedConversation(shim.stateDir, agentId);

  const m1 = seedMessage(shim.stateDir, agentId, "default", {
    id: "ui-msg-legacy-u",
    role: "user",
    content: "hello",
    sourceMessageIndex: 0,
  });

  const runId = "run-nwd-legacy-001";
  seedRun(shim.stateDir, {
    runId,
    agentId,
    conversationId: "default",
    messageIds: [m1],
  });

  const { status, body } = await getJson(`${shim.url}/v1/agents/${agentId}/messages?limit=50&conversation_id=default`);
  assert.equal(status, 200);
  const arr = body as Array<{ id: string; run_id?: string | null }>;
  const hit = arr.find((m) => m.id === m1);
  assert.ok(hit, "seeded message must appear in agent-messages listing");
  assert.equal(hit.run_id, runId, "legacy projection must carry run_id");
});

test("lcp-nwd: GET /v1/runs/{id}/messages keeps run_id stable across the run's messages", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-runid-runmsgs" });
  seedConversation(shim.stateDir, agentId);

  const m1 = seedMessage(shim.stateDir, agentId, "default", {
    id: "ui-msg-runmsgs-1",
    role: "user",
    content: "hello",
    sourceMessageIndex: 0,
  });
  const m2 = seedMessage(shim.stateDir, agentId, "default", {
    id: "ui-msg-runmsgs-2",
    role: "assistant",
    content: "hi back",
    sourceMessageIndex: 1,
  });
  // Unclaimed — must NOT appear in the run-messages projection.
  seedMessage(shim.stateDir, agentId, "default", {
    id: "ui-msg-runmsgs-orphan",
    role: "user",
    content: "later",
    sourceMessageIndex: 2,
  });

  const runId = "run-nwd-runmsgs-001";
  seedRun(shim.stateDir, {
    runId,
    agentId,
    conversationId: "default",
    messageIds: [m1, m2],
  });

  const { status, body } = await getJson(`${shim.url}/v1/runs/${runId}/messages?limit=50`);
  assert.equal(status, 200);
  const arr = body as Array<{ id: string; run_id: string | null }>;
  assert.ok(arr.length > 0, "expected the run's claimed messages to be returned");
  for (const m of arr) {
    assert.equal(m.run_id, runId, `every message under /v1/runs/${runId}/messages must carry run_id=${runId}`);
  }
  // Orphan must not be in the output.
  assert.ok(!arr.some((m) => m.id === "ui-msg-runmsgs-orphan"), "unclaimed messages must not appear");
});
