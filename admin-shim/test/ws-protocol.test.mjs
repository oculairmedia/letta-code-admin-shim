/**
 * Mobile WebSocket protocol tests.
 *
 * These pin the wire protocol mobile depends on. The .mjs → TypeScript
 * refactor must preserve:
 *
 *   • Handshake: client hello → server welcome (server_id, session_id, device_id)
 *   • Auth: wrong token → error{invalid_token} then close
 *   • First-frame discipline: anything but hello first → error{protocol_violation}
 *   • Turn lifecycle: turn_started → (frames...) → stop_reason → usage_statistics → turn_done
 *   • Frame remap: bash tool_calls forwarded as tool_call_message with name/id
 *   • run_id stamped on every post-turn_started frame
 *   • turn_done arrives AFTER stop_reason (post-stamp sentinel)
 *   • otid propagation to the disk-projection user_message
 *   • Single-flight: second concurrent send_message → protocol_violation, no close
 *   • cancel: must carry run_id, otherwise protocol_violation
 *   • bye: client → clean 1000 close
 *   • Unknown frame types ignored silently (forward-compat rule)
 *
 * Each test spawns its own shim with the mobile channel wired up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  startShim,
  seedAgent,
  seedConversation,
  seedMessage,
  externalConvId,
  openMobileWs,
} from "./helpers/index.mjs";

const WS_TIMEOUT_MS = 8_000;

// Convenience setup: shim + agent + default conversation + an open authed WS.
// Returns the conn handle plus the conv id / agent id for send_message bodies.
async function setupAuthed(t, opts = {}) {
  const shim = await startShim({ env: opts.env });
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir, { id: opts.agentId ?? `agent-ws-${Date.now()}` });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);
  const conn = await openMobileWs(shim.url, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());
  return { shim, conn, agentId, convId };
}

// ─── 1. Handshake happy path ───────────────────────────────────────────

test("ws: hello/welcome handshake — server_id, session_id, device_id in welcome", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const conn = await openMobileWs(shim.url, { token: shim.mobileToken, deviceId: "dev-handshake-1" });
  t.after(() => conn.close());
  const welcome = conn.frames.find((f) => f.type === "welcome");
  assert.ok(welcome, "welcome frame must be present after hello");
  assert.equal(typeof welcome.server_id, "string", "welcome.server_id required");
  assert.ok(welcome.server_id.length > 0, "server_id non-empty");
  assert.equal(typeof welcome.session_id, "string", "welcome.session_id required");
  assert.match(welcome.session_id, /^sess-/, "session_id should be sess-<uuid>");
  assert.equal(welcome.device_id, "dev-handshake-1", "welcome.device_id echoes client device_id");
});

// ─── 2. Auth failure ────────────────────────────────────────────────

test("ws: wrong token → error{invalid_token} and connection closes", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  let conn;
  try {
    conn = await openMobileWs(shim.url, { token: "totally-wrong", timeoutMs: WS_TIMEOUT_MS });
  } catch (err) {
    // openMobileWs internally awaits the welcome — if the server errors first,
    // the helper rejects with "socket closed (...) before welcome".
    assert.match(err.message, /socket closed|welcome/, "expected close-on-auth-failure");
    return;
  }
  t.after(() => conn.close());
  // If we got here, find the error frame.
  const err = conn.frames.find((f) => f.type === "error");
  assert.ok(err, "error frame must be sent before close");
  assert.equal(err.code, "invalid_token");
  // Wait briefly for the close to propagate.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(conn.closed, true, "socket should close on auth failure");
});

// ─── 3. First-frame discipline ──────────────────────────────────────

test("ws: sending a non-hello frame first → error{protocol_violation}", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const conn = await openMobileWs(shim.url, {
    token: shim.mobileToken,
    skipHello: true,
    timeoutMs: WS_TIMEOUT_MS,
  });
  t.after(() => conn.close());
  // Send a send_message before the hello.
  conn.send({ type: "send_message", agent_id: "agent-x", conversation_id: "default", text: "hi" });
  const err = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS });
  assert.equal(err.code, "protocol_violation");
  assert.match(err.message ?? "", /hello/i, "message should mention hello");
});

// ─── 4. send_message happy path: full turn lifecycle ──────────────────

test("ws: send_message → turn_started → assistant_message → stop_reason → usage → turn_done", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-1",
  });
  // collectTurn waits for turn_done.
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const types = turn.map((f) => f.type);
  // Must include turn_started, assistant_message, stop_reason, usage_statistics, turn_done.
  for (const required of ["turn_started", "assistant_message", "stop_reason", "usage_statistics", "turn_done"]) {
    assert.ok(types.includes(required), `missing ${required} (got ${types.join(",")})`);
  }
  // Order: turn_started first; turn_done last.
  assert.equal(types[0], "turn_started", "turn_started must be the first frame of the turn");
  assert.equal(types[types.length - 1], "turn_done", "turn_done must be the last frame of the turn");
});

// ─── 5. Tool call forwarded ────────────────────────────────────────

test("ws: bash-tool trace yields a tool_call_message over the wire", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "run bash echo hello",
    otid: "cm-ws-bash",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const tcs = turn.filter((f) => f.type === "tool_call_message");
  assert.equal(tcs.length, 1, `expected 1 tool_call_message, got ${tcs.length}`);
  const tc = tcs[0];
  assert.equal(tc.tool_call?.name, "Bash");
  assert.ok(tc.tool_call?.tool_call_id, "tool_call_id required");
  assert.ok(tc.run_id, "tool_call_message must carry run_id");
  assert.ok(tc.turn_id, "tool_call_message must carry turn_id");
});

// ─── 6. run_id stamped on every post-turn_started frame ───────────────

test("ws: every post-turn_started frame carries run_id", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-rid",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const turnStartedIdx = turn.findIndex((f) => f.type === "turn_started");
  // turn_started itself MAY omit run_id (fires before onRunCreated).
  // Everything after it must have one.
  const after = turn.slice(turnStartedIdx + 1);
  const missing = after.filter((f) => !f.run_id);
  assert.equal(missing.length, 0, `frames after turn_started missing run_id: ${missing.map((f) => f.type).join(",")}`);
  // All run_ids in `after` must be the same.
  const ids = new Set(after.map((f) => f.run_id));
  assert.equal(ids.size, 1, `mixed run_ids across the turn: ${[...ids].join(",")}`);
});

// ─── 7. turn_done strictly after stop_reason ────────────────────────

test("ws: turn_done follows stop_reason (post-stamp sentinel)", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-order",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const sIdx = turn.findIndex((f) => f.type === "stop_reason");
  const dIdx = turn.findIndex((f) => f.type === "turn_done");
  assert.ok(sIdx >= 0 && dIdx >= 0, "both stop_reason and turn_done required");
  assert.ok(sIdx < dIdx, `turn_done must come after stop_reason (s=${sIdx}, d=${dIdx})`);
  // turn_done.status should be "completed" on a clean turn.
  assert.equal(turn[dIdx].status, "completed");
});

// ─── 8. otid propagation ────────────────────────────────────────────

test("ws: otid in send_message propagates to disk sidecar via the otid bind", async (t) => {
  // Note: mobile WS clients pass the INTERNAL conversation id ("default" or
  // "conv-<uuid>") in send_message — the bridge calls the worker pool +
  // findUnmappedTailUserMessageId with that id directly. (Compare with the
  // SSE handler which resolves an external "conv-default-<agentId>" form via
  // resolveConversationId first.) See ws-smoke.mjs for the canonical client.
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir, { id: "agent-ws-otid" });
  seedConversation(shim.stateDir, agentId);
  // Pre-seed a user message so the unmapped-tail finder has something to
  // bind. The mock doesn't append to messages.jsonl on its own.
  const seededId = seedMessage(shim.stateDir, agentId, "default", {
    role: "user",
    content: "prior user message",
  });
  const conn = await openMobileWs(shim.url, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());

  const myOtid = "cm-ws-otid-roundtrip";
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: "default", // internal form — what mobile actually sends
    text: "reply with pong",
    otid: myOtid,
  });
  await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS });

  const b64url = Buffer.from(`default:${agentId}`).toString("base64url");
  const sidecarPath = join(shim.stateDir, "conversations", b64url, "_otid-map.json");
  assert.ok(existsSync(sidecarPath), `expected _otid-map.json at ${sidecarPath}`);
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  assert.equal(
    sidecar[seededId],
    myOtid,
    `WS-supplied otid must bind to the tail user message: ${JSON.stringify(sidecar)}`,
  );
});

// ─── 9. Single-flight ──────────────────────────────────────────────

test("ws: second send_message during in-flight turn → error{protocol_violation}, first completes", async (t) => {
  // Slow down the mock so the first turn is still emitting when we send the
  // second send_message.
  const { conn, agentId, convId } = await setupAuthed(t, { env: { LETTA_MOCK_DELAY_MS: "200" } });
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-sf-1",
  });
  // Wait until we see turn_started to know the first request is in flight.
  await conn.waitFor("turn_started", { timeoutMs: WS_TIMEOUT_MS });
  // Send a second send_message before turn_done arrives.
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "another reply",
    otid: "cm-ws-sf-2",
  });
  const err = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS });
  assert.equal(err.code, "protocol_violation");
  assert.match(err.message ?? "", /in flight/i, "should mention an in-flight turn");
  // The connection must NOT have closed — single-flight is a soft error.
  assert.equal(conn.closed, false, "single-flight error must NOT close the socket");
  // The original turn must still complete cleanly.
  const done = await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS });
  assert.equal(done.status, "completed");
});

// ─── 10. cancel happy-ish path ──────────────────────────────────────

test("ws: cancel with run_id flips the Run to cancelled", async (t) => {
  // Slow the mock so we have a window to cancel.
  const { shim, conn, agentId, convId } = await setupAuthed(t, { env: { LETTA_MOCK_DELAY_MS: "200" } });
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "bullet list three things about TCP/IP", // multi-step → 6 chunks → long enough to cancel
    otid: "cm-ws-cancel",
  });
  // Wait for the first frame that carries a run_id.
  let runId = null;
  const startWait = Date.now();
  while (Date.now() - startWait < WS_TIMEOUT_MS) {
    const f = conn.frames.find((x) => x.run_id);
    if (f) { runId = f.run_id; break; }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!runId) {
    // The mock may already have finished — assert and move on.
    t.diagnostic("could not capture run_id before turn ended; cancel race is a no-op");
    return;
  }
  conn.send({ type: "cancel", run_id: runId });
  // Drain remaining frames briefly. The cancel may race with turn_done.
  await new Promise((r) => setTimeout(r, 300));
  // Query the run record — must be cancelled or completed (race).
  const res = await fetch(`${shim.url}/v1/runs/${runId}`);
  assert.equal(res.status, 200);
  const run = await res.json();
  assert.ok(
    ["cancelled", "completed"].includes(run.status),
    `run status should settle to cancelled or completed, got ${run.status}`,
  );
});

// ─── 11. cancel without run_id → protocol_violation ────────────────

test("ws: cancel with no run_id and no active turn → error{protocol_violation}", async (t) => {
  const { conn } = await setupAuthed(t);
  conn.send({ type: "cancel" });
  const err = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS });
  assert.equal(err.code, "protocol_violation");
  assert.match(err.message ?? "", /run_id/i);
  assert.equal(conn.closed, false, "missing-run_id cancel must NOT close the socket");
});

// ─── 12. ping cadence ───────────────────────────────────────────────

test("ws: server emits periodic ping frames", async (t) => {
  // Configure a short ping interval via the channel account file. The test
  // helper writes accounts.json with pingIntervalMs=25_000 by default; we
  // override via a per-test patch.
  const shim = await startShim();
  t.after(() => shim.stop());
  // Rewrite the mobile accounts.json with a 200ms ping cadence.
  const accountsPath = join(shim.homeDir, ".letta", "channels", "mobile", "accounts.json");
  const accounts = JSON.parse(readFileSync(accountsPath, "utf8"));
  accounts.accounts[0].config.pingIntervalMs = 200;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));

  const conn = await openMobileWs(shim.url, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());
  // Wait long enough for at least 2 pings.
  const ping = await conn.waitFor("ping", { timeoutMs: 3_000 });
  assert.equal(ping.type, "ping");
});

// ─── 13. bye triggers clean close ───────────────────────────────────

test("ws: client `bye` produces a 1000 close from the server", async (t) => {
  const { conn } = await setupAuthed(t);
  conn.send({ type: "bye" });
  // Wait for the close event.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(conn.closed, true, "socket should be closed after bye");
  assert.equal(conn.closeCode, 1000, `expected close code 1000, got ${conn.closeCode}`);
});

// ─── 14. Unknown frame types ignored silently ──────────────────────

test("ws: unknown frame types are ignored silently (forward-compat)", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  const beforeLen = conn.frames.length;
  conn.send({ type: "this_is_some_future_frame", payload: { foo: 1 } });
  // No error should arrive in a short window.
  await new Promise((r) => setTimeout(r, 200));
  const errs = conn.frames.slice(beforeLen).filter((f) => f.type === "error");
  assert.equal(errs.length, 0, `unknown frame type must not produce an error, got: ${errs.map((e) => e.code).join(",")}`);
  assert.equal(conn.closed, false, "unknown frame must not close the socket");
  // Sanity check: a subsequent valid send_message still works.
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-fwdcompat",
  });
  await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS });
});

// ─── 15. Backpressure code path doesn't crash ──────────────────────

test("ws: a normal turn completes without crashing the handler (backpressure-safe smoke)", async (t) => {
  // We can't easily fill the OS send buffer in a test, but we CAN run a long
  // trace and assert the handler still emits turn_done cleanly — exercising
  // the bufferedAmount check on every outbound frame.
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "explain in detail with long text", // forces text-only-long (17 chunks)
    otid: "cm-ws-bp",
  });
  const done = await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS });
  assert.equal(done.status, "completed", "long-trace turn should complete");
});

// ─── 16. Reasoning frames forwarded — fixtures do not carry them ─────

test("ws: reasoning_message forwarding", { todo: "no fixture emits reasoning_message; observable only with a real model" }, async () => {
  // If/when a fixture is added with a reasoning_message frame, this test should
  // assert: trace produces reasoning_message → ws emits {type:"reasoning_message",
  // reasoning, signature, turn_id, run_id}. Until then, skip.
});

// ─── 17. Mobile-channel plugin loads on first WS upgrade ─────────────

test("ws: shim logs `mobile-channel adapter ready` on first WS upgrade", async (t) => {
  // The adapter is loaded lazily on the first WS upgrade (see
  // server.mjs upgrade handler), not at boot. So we open one WS first.
  const shim = await startShim();
  t.after(() => shim.stop());
  // Opening + handshake forces getMobileChannelAdapter to fire.
  const conn = await openMobileWs(shim.url, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());
  // Give the adapter-ready log line a moment to flush.
  await shim.waitForLogLine(/mobile-channel.*adapter ready|adapter ready \(accepts inbound WS/, { timeoutMs: 2_000 });
  // If we got here, the log line was found.
  const log = shim.readLog();
  assert.match(log, /adapter ready/, "mobile-channel adapter must be loaded for /shim/v1/mobile to work");
});

// ─── 18. assistant_message content arrives non-empty ────────────────

test("ws: assistant_message carries non-empty content on a normal reply", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-content",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const a = turn.find((f) => f.type === "assistant_message" && f.content && f.content.length > 0);
  assert.ok(a, "at least one assistant_message must carry content");
  assert.match(a.content.toLowerCase(), /pong/);
});

// ─── 19. turn_started carries agent + conv ids ──────────────────────

test("ws: turn_started includes agent_id, conversation_id, turn_id", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-ts",
  });
  const ts = await conn.waitFor("turn_started", { timeoutMs: WS_TIMEOUT_MS });
  assert.equal(ts.agent_id, agentId);
  assert.equal(ts.conversation_id, convId);
  assert.match(ts.turn_id, /^turn-/);
});

// ─── 20. send_message validation: missing required fields ───────────

test("ws: send_message with missing agent_id → error{protocol_violation}, no close", async (t) => {
  const { conn } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    // agent_id intentionally missing
    conversation_id: "anything",
    text: "hi",
  });
  const err = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS });
  assert.equal(err.code, "protocol_violation");
  assert.equal(conn.closed, false, "validation error must NOT close the socket");
});

// ─── 21. stop_reason frame shape on WS ──────────────────────────────

test("ws: stop_reason frame carries reason field (`end_turn` on clean turn)", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-sr",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const stop = turn.find((f) => f.type === "stop_reason");
  assert.ok(stop, "stop_reason must be present");
  assert.equal(stop.reason, "end_turn");
  assert.ok(stop.turn_id, "stop_reason must carry turn_id");
});
