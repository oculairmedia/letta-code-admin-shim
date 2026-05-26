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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  startShim,
  seedAgent,
  seedConversation,
  seedMessage,
  externalConvId,
  openMobileWs,
} from "./helpers/index.js";
import type { ShimHandle } from "./helpers/shim.js";
import type { MobileWsHandle } from "./helpers/ws.js";

// ── types ─────────────────────────────────────────────────────────

interface SetupAuthedOptions {
  env?: Record<string, string | undefined>;
  agentId?: string;
}

interface SetupAuthedResult {
  shim: ShimHandle;
  conn: MobileWsHandle;
  agentId: string;
  convId: string;
}

const WS_TIMEOUT_MS = 8_000;

// Convenience setup: shim + agent + default conversation + an open authed WS.
// Returns the conn handle plus the conv id / agent id for send_message bodies.
async function setupAuthed(
  t: { after: (fn: () => unknown) => void },
  opts: SetupAuthedOptions = {},
): Promise<SetupAuthedResult> {
  const shim = await startShim({ env: opts.env });
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir, { id: opts.agentId ?? `agent-ws-${Date.now()}` });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);
  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());
  return { shim, conn, agentId, convId };
}

// ─── 1. Handshake happy path ───────────────────────────────────────────

test("ws: hello/welcome handshake — server_id, session_id, device_id in welcome", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, deviceId: "dev-handshake-1" });
  t.after(() => conn.close());
  const welcome = conn.frames.find((f) => f.type === "welcome") as unknown as
    | {
        server_id: string;
        session_id: string;
        device_id: string;
        canonical_live_transport?: string;
        transport_contract?: {
          mobile_ws?: boolean;
          ws_endpoint?: string;
          canonical_live_transport?: string;
          rest_role?: string;
          sse_role?: string;
          exclusivity?: string;
        };
        capabilities?: {
          mobile_transport?: {
            canonical_live_transport?: string;
          };
        };
      }
    | undefined;
  assert.ok(welcome, "welcome frame must be present after hello");
  assert.equal(typeof welcome.server_id, "string", "welcome.server_id required");
  assert.ok(welcome.server_id.length > 0, "server_id non-empty");
  assert.equal(typeof welcome.session_id, "string", "welcome.session_id required");
  assert.match(welcome.session_id, /^sess-/, "session_id should be sess-<uuid>");
  assert.equal(welcome.device_id, "dev-handshake-1", "welcome.device_id echoes client device_id");
  assert.equal(welcome.canonical_live_transport, "ws");
  assert.equal(welcome.transport_contract?.mobile_ws, true);
  assert.equal(welcome.transport_contract?.ws_endpoint, "/shim/v1/mobile");
  assert.equal(welcome.transport_contract?.canonical_live_transport, "ws");
  assert.equal(welcome.transport_contract?.rest_role, "cold_start_reconcile_repair");
  assert.equal(welcome.transport_contract?.sse_role, "legacy_non_canonical_for_mobile_ws_sessions");
  assert.equal(
    welcome.transport_contract?.exclusivity,
    "after_ws_welcome_do_not_consume_sse_for_owned_conversations",
  );
  assert.equal(welcome.capabilities?.mobile_transport?.canonical_live_transport, "ws");
});

test("ws: hello can negotiate A2UI capability when server support is enabled", async (t) => {
  const shim = await startShim({ env: { A2UI_ENABLED: "1", A2UI_VERSION: "0.9", A2UI_CATALOG_ID: "basic" } });
  t.after(() => shim.stop());
  const conn = await openMobileWs(shim.url!, {
    token: shim.mobileToken,
    deviceId: "dev-a2ui-1",
    helloExtras: {
      a2ui_version: "0.9",
      supported_catalogs: ["basic"],
      supported_widgets: ["Text", "Button", "ToolApprovalCard"],
      theme_hints: { color_scheme: "dark" },
    },
  });
  t.after(() => conn.close());
  const welcome = conn.frames.find((f) => f.type === "welcome") as unknown as
    | { a2ui_negotiated?: boolean; a2ui?: { version?: string; catalog_id?: string } | null }
    | undefined;
  assert.ok(welcome, "welcome frame must be present");
  assert.equal(welcome.a2ui_negotiated, true);
  assert.equal(welcome.a2ui?.version, "0.9");
  assert.equal(welcome.a2ui?.catalog_id, "basic");

  const capabilities = await conn.waitFor("a2ui_capabilities", { timeoutMs: WS_TIMEOUT_MS }) as unknown as {
    version?: string;
    catalog_id?: string;
    supported_widgets?: unknown;
  };
  assert.equal(capabilities.version, "0.9");
  assert.equal(capabilities.catalog_id, "basic");
  assert.ok(Array.isArray(capabilities.supported_widgets));
  assert.deepEqual(capabilities.supported_widgets, ["Text", "Button", "Card", "List", "TextField", "ChoicePicker"]);
});

test("ws: tokenless A2UI hello does not crash when mobile auth is unconfigured", async (t) => {
  const shim = await startShim({
    mobileToken: "",
    env: { A2UI_ENABLED: "1", A2UI_VERSION: "0.9", A2UI_CATALOG_ID: "basic", MOBILE_CHANNEL_TOKEN: "" },
  });
  t.after(() => shim.stop());
  const conn = await openMobileWs(shim.url!, {
    token: null,
    deviceId: "dev-a2ui-tokenless",
    helloExtras: {
      a2ui_version: "0.9",
      supported_catalogs: ["basic"],
      supported_widgets: ["Text", "Button", "ToolApprovalCard"],
    },
    timeoutMs: WS_TIMEOUT_MS,
  });
  t.after(() => conn.close());

  const welcome = conn.frames.find((f) => f.type === "welcome") as unknown as
    | { a2ui_negotiated?: boolean; a2ui?: { version?: string; catalog_id?: string } | null }
    | undefined;
  assert.ok(welcome, "welcome frame must be present");
  assert.equal(welcome.a2ui_negotiated, true);
  assert.equal(welcome.a2ui?.version, "0.9");
  assert.equal(welcome.a2ui?.catalog_id, "basic");
  await conn.waitFor("a2ui_capabilities", { timeoutMs: WS_TIMEOUT_MS });
  assert.equal(conn.closed, false, "tokenless negotiated hello must keep the server process alive");
  assert.doesNotMatch(shim.readLog(), /ERR_INVALID_ARG_TYPE|TypeError/, "tokenless hello must not crash device state hashing");
});

test("ws: A2UI request is ignored when server support is disabled", async (t) => {
  const shim = await startShim({ env: { A2UI_ENABLED: "0" } });
  t.after(() => shim.stop());
  const conn = await openMobileWs(shim.url!, {
    token: shim.mobileToken,
    helloExtras: {
      a2ui_version: "0.9",
      supported_catalogs: ["basic"],
      supported_widgets: ["Text"],
    },
  });
  t.after(() => conn.close());
  const welcome = conn.frames.find((f) => f.type === "welcome") as unknown as
    | { a2ui_negotiated?: boolean; a2ui?: unknown }
    | undefined;
  assert.ok(welcome, "welcome frame must be present");
  assert.equal(welcome.a2ui_negotiated, false);
  assert.equal(welcome.a2ui, null);
  assert.equal(conn.frames.some((f) => f.type === "a2ui_capabilities"), false);
});

test("ws: A2UI version mismatch returns negotiated=false with reason", async (t) => {
  const shim = await startShim({ env: { A2UI_ENABLED: "1", A2UI_VERSION: "0.9", A2UI_CATALOG_ID: "basic" } });
  t.after(() => shim.stop());
  const conn = await openMobileWs(shim.url!, {
    token: shim.mobileToken,
    helloExtras: {
      a2ui_version: "0.10",
      supported_catalogs: ["basic"],
      supported_widgets: ["Text"],
    },
  });
  t.after(() => conn.close());
  const welcome = conn.frames.find((f) => f.type === "welcome") as unknown as
    | { a2ui_negotiated?: boolean; a2ui?: unknown; a2ui_rejection_reason?: string }
    | undefined;
  assert.ok(welcome, "welcome frame must be present");
  assert.equal(welcome.a2ui_negotiated, false);
  assert.equal(welcome.a2ui, null);
  assert.equal(welcome.a2ui_rejection_reason, "version_mismatch");
  assert.equal(conn.frames.some((f) => f.type === "a2ui_capabilities"), false);
});

test("ws: A2UI catalog mismatch returns negotiated=false with reason", async (t) => {
  const shim = await startShim({ env: { A2UI_ENABLED: "1", A2UI_VERSION: "0.9", A2UI_CATALOG_ID: "basic" } });
  t.after(() => shim.stop());
  const conn = await openMobileWs(shim.url!, {
    token: shim.mobileToken,
    helloExtras: {
      a2ui_version: "0.9",
      supported_catalogs: ["enterprise"],
      supported_widgets: ["Text"],
    },
  });
  t.after(() => conn.close());
  const welcome = conn.frames.find((f) => f.type === "welcome") as unknown as
    | { a2ui_negotiated?: boolean; a2ui?: unknown; a2ui_rejection_reason?: string }
    | undefined;
  assert.ok(welcome, "welcome frame must be present");
  assert.equal(welcome.a2ui_negotiated, false);
  assert.equal(welcome.a2ui, null);
  assert.equal(welcome.a2ui_rejection_reason, "catalog_mismatch");
  assert.equal(conn.frames.some((f) => f.type === "a2ui_capabilities"), false);
});

test("ws: A2UI-enabled server does not negotiate when client omits a2ui_version", async (t) => {
  const shim = await startShim({ env: { A2UI_ENABLED: "1", A2UI_VERSION: "0.9", A2UI_CATALOG_ID: "basic" } });
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir, { id: `agent-no-a2ui-${Date.now()}` });
  seedConversation(shim.stateDir, agentId);
  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());
  const welcome = conn.frames.find((f) => f.type === "welcome") as unknown as
    | { a2ui_negotiated?: boolean; a2ui?: unknown; a2ui_rejection_reason?: string }
    | undefined;
  assert.ok(welcome, "welcome frame must be present");
  assert.equal(welcome.a2ui_negotiated, false);
  assert.equal(welcome.a2ui, null);
  assert.equal(welcome.a2ui_rejection_reason, undefined);
  assert.equal(conn.frames.some((f) => f.type === "a2ui_capabilities"), false);

  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: externalConvId(agentId),
    text: "show approval card",
    otid: "cm-no-a2ui-schema",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  assert.equal(turn.some((f) => f.type === "a2ui_frame"), false);
});

test("ws: inbound A2UI frames are rejected when A2UI was not negotiated", async (t) => {
  const shim = await startShim({ env: { A2UI_ENABLED: "1", A2UI_VERSION: "0.9", A2UI_CATALOG_ID: "basic" } });
  t.after(() => shim.stop());
  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());

  conn.send({ type: "user_action", name: "tool_approval_choice", context: {} });
  const userActionErr = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { code?: string; message?: string };
  assert.equal(userActionErr.code, "protocol_violation");
  assert.match(userActionErr.message ?? "", /negotiated A2UI/);
  assert.equal(conn.closed, false, "socket remains open after soft protocol error");

  const conn2 = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn2.close());

  conn2.send({ type: "a2ui_frame", ok: true, a2ui: { version: "v0.9" } });
  const a2uiFrameErr = await conn2.waitFor("error", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { code?: string; message?: string };
  assert.equal(a2uiFrameErr.code, "protocol_violation");
  assert.match(a2uiFrameErr.message ?? "", /server-to-client/);
  assert.equal(conn2.closed, false, "socket remains open after soft protocol error");
});

// ─── 2. Auth failure ────────────────────────────────────────────────

test("ws: wrong token → error{invalid_token} and connection closes", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  let conn: MobileWsHandle;
  try {
    conn = await openMobileWs(shim.url!, { token: "totally-wrong", timeoutMs: WS_TIMEOUT_MS });
  } catch (err) {
    // openMobileWs internally awaits the welcome — if the server errors first,
    // the helper rejects with "socket closed (...) before welcome".
    assert.match((err as Error).message, /socket closed|welcome/, "expected close-on-auth-failure");
    return;
  }
  t.after(() => conn.close());
  // If we got here, find the error frame.
  const err = conn.frames.find((f) => f.type === "error") as unknown as { code: string } | undefined;
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
  const conn = await openMobileWs(shim.url!, {
    token: shim.mobileToken,
    skipHello: true,
    timeoutMs: WS_TIMEOUT_MS,
  });
  t.after(() => conn.close());
  // Send a send_message before the hello.
  conn.send({ type: "send_message", agent_id: "agent-x", conversation_id: "default", text: "hi" });
  const err = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS }) as unknown as
    { code: string; message?: string };
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

test("ws: cached legacy agent id aliases to active local backend agent", async (t) => {
  const canonicalAgentId = "agent-local-ffa3a92b-f5d6-45e1-8866-f3c965a92133";
  const staleAgentId = "agent-597b5756-2915-4560-ba6b-91005f085166";
  const { shim, conn } = await setupAuthed(t, { agentId: canonicalAgentId });

  conn.send({
    type: "send_message",
    agent_id: staleAgentId,
    conversation_id: "default",
    text: "reply with one word: pong",
    otid: "cm-stale-agent-alias",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const assistantText = turn
    .filter((f) => f.type === "assistant_message")
    .map((f) => typeof f["content"] === "string" ? f["content"] : "")
    .join("");
  assert.match(assistantText, /pong/i, "aliased stale id must still produce assistant output");
  assert.match(shim.readLog(), new RegExp(`spawned key=${canonicalAgentId}::default`));
  assert.doesNotMatch(shim.readLog(), /Agent agent-597b5756-2915-4560-ba6b-91005f085166 not found|pool spawn timeout/);
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
  const tc = tcs[0] as unknown as {
    tool_call?: { name?: string; tool_call_id?: string };
    run_id?: unknown;
    turn_id?: unknown;
  };
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
  const missing = after.filter((f) => !(f as { run_id?: unknown }).run_id);
  assert.equal(missing.length, 0, `frames after turn_started missing run_id: ${missing.map((f) => f.type).join(",")}`);
  // All run_ids in `after` must be the same.
  const ids = new Set(after.map((f) => (f as { run_id?: unknown }).run_id));
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
  assert.equal((turn[dIdx] as unknown as { status: string }).status, "completed");
});

// ─── 8. otid propagation ────────────────────────────────────────────

test("ws: otid in send_message propagates to disk sidecar via the otid bind", async (t) => {
  // WS accepts BOTH the internal conv id ("default", "conv-<uuid>") and the
  // external form mobile uses on the HTTP path ("conv-default-<agentId>").
  // The bridge resolves whichever it gets via resolveConversationId before
  // touching disk, so the sidecar always lands at the internal key
  // (`default:<agentId>`) regardless of which form the client sent.
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
  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());

  const myOtid = "cm-ws-otid-roundtrip";
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: "default", // internal form — what ws-smoke.mjs sends today
    text: "reply with pong",
    otid: myOtid,
  });
  await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS });

  const b64url = Buffer.from(`default:${agentId}`).toString("base64url");
  const sidecarPath = join(shim.stateDir, "conversations", b64url, "_otid-map.json");
  assert.ok(existsSync(sidecarPath), `expected _otid-map.json at ${sidecarPath}`);
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, string>;
  assert.equal(
    sidecar[seededId],
    myOtid,
    `WS-supplied otid must bind to the tail user message: ${JSON.stringify(sidecar)}`,
  );
});

test("ws: literal `default` conv id with multiple agents routes to the CLIENT-supplied agent, not the first-on-disk", async (t) => {
  // Hazard: resolveConversationId disk-scans when given the literal "default"
  // and returns whichever agent's default it finds first. The WS bridge must
  // NOT disk-resolve "default" — trust the client's agent_id. Otherwise a
  // multi-agent backend mis-routes the turn to the wrong agent's worker and
  // the otid sidecar lands at the wrong key.
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentA = seedAgent(shim.stateDir, { id: "agent-multi-a" });
  const agentB = seedAgent(shim.stateDir, { id: "agent-multi-b" });
  seedConversation(shim.stateDir, agentA);
  seedConversation(shim.stateDir, agentB);
  const seededA = seedMessage(shim.stateDir, agentA, "default", { role: "user", content: "A's prior message" });
  seedMessage(shim.stateDir, agentB, "default", { role: "user", content: "B's prior message" });

  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());
  const myOtid = "cm-multi-agent-default";
  conn.send({
    type: "send_message",
    agent_id: agentA,
    conversation_id: "default",
    text: "reply with pong",
    otid: myOtid,
  });
  await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS });

  // Sidecar must land at agent-A's default-key dir (the client's agent), not B's.
  const keyA = Buffer.from(`default:${agentA}`).toString("base64url");
  const keyB = Buffer.from(`default:${agentB}`).toString("base64url");
  const sidecarA = join(shim.stateDir, "conversations", keyA, "_otid-map.json");
  const sidecarB = join(shim.stateDir, "conversations", keyB, "_otid-map.json");
  assert.ok(existsSync(sidecarA), `sidecar must exist at agent-A's key`);
  assert.equal(existsSync(sidecarB), false, `sidecar must NOT leak to agent-B's key`);
  const parsed = JSON.parse(readFileSync(sidecarA, "utf8")) as Record<string, string>;
  assert.equal(parsed[seededA], myOtid, `otid must bind to A's seeded message: ${JSON.stringify(parsed)}`);
});

test("ws: external conv id (conv-default-<agentId>) resolves like SSE — otid sidecar lands at the internal key", async (t) => {
  // Regression: mobile clients that already use the external `conv-default-X`
  // form on /v1/conversations/{id}/messages can use the same id over WS.
  // The bridge calls resolveConversationId() so the worker pool and the
  // otid sidecar both see the canonical internal pair.
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir, { id: "agent-ws-extid" });
  seedConversation(shim.stateDir, agentId);
  const seededId = seedMessage(shim.stateDir, agentId, "default", {
    role: "user",
    content: "prior user message",
  });
  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());

  const myOtid = "cm-ws-extid-bind";
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: externalConvId(agentId), // EXTERNAL form: `conv-default-<agentId>`
    text: "reply with pong",
    otid: myOtid,
  });
  await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS });

  // Sidecar must land at the INTERNAL key, NOT at any external-keyed dir.
  const internalKey = Buffer.from(`default:${agentId}`).toString("base64url");
  const internalSidecar = join(shim.stateDir, "conversations", internalKey, "_otid-map.json");
  assert.ok(
    existsSync(internalSidecar),
    `sidecar must land at the internal-key dir; got list: ${readdirSync(join(shim.stateDir, "conversations")).join(",")}`,
  );
  const sidecar = JSON.parse(readFileSync(internalSidecar, "utf8")) as Record<string, string>;
  assert.equal(sidecar[seededId], myOtid, `otid must bind via the internal pair: ${JSON.stringify(sidecar)}`);

  // And there should NOT be a stray external-key dir, which would prove
  // the resolver ran (older code created `conversation:conv-default-X` instead).
  const externalKey = Buffer.from(`conversation:${externalConvId(agentId)}`).toString("base64url");
  const externalDir = join(shim.stateDir, "conversations", externalKey);
  assert.equal(
    existsSync(externalDir),
    false,
    `external-key dir should NOT exist; pool keyed by raw external id is the bug`,
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
  const err = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS }) as unknown as
    { code: string; message?: string };
  assert.equal(err.code, "protocol_violation");
  assert.match(err.message ?? "", /in flight/i, "should mention an in-flight turn");
  // The connection must NOT have closed — single-flight is a soft error.
  assert.equal(conn.closed, false, "single-flight error must NOT close the socket");
  // The original turn must still complete cleanly.
  const done = await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { status: string };
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
  let runId: string | null = null;
  const startWait = Date.now();
  while (Date.now() - startWait < WS_TIMEOUT_MS) {
    const f = conn.frames.find((x) => (x as { run_id?: unknown }).run_id);
    if (f) { runId = (f as unknown as { run_id: string }).run_id; break; }
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
  const run = await res.json() as { status: string };
  assert.ok(
    ["cancelled", "completed"].includes(run.status),
    `run status should settle to cancelled or completed, got ${run.status}`,
  );
});

// ─── 11. cancel without run_id → protocol_violation ────────────────

test("ws: cancel without run_id → error{protocol_violation} (no implicit fallback)", async (t) => {
  // run_id is required on every cancel — lcp-bll removed the previous
  // implicit fallback to `currentRunId`. The error fires whether or not
  // there's an active in-flight turn.
  const { conn } = await setupAuthed(t);
  conn.send({ type: "cancel" });
  const err = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS }) as unknown as
    { code: string; message?: string };
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
  const accounts = JSON.parse(readFileSync(accountsPath, "utf8")) as {
    accounts: Array<{ config: { pingIntervalMs: number } }>;
  };
  accounts.accounts[0]!.config.pingIntervalMs = 200;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));

  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
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
  assert.equal(errs.length, 0, `unknown frame type must not produce an error, got: ${errs.map((e) => (e as { code?: string }).code).join(",")}`);
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
  const done = await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { status: string };
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
  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());
  // Give the adapter-ready log line a moment to flush.
  await shim.waitForLogLine(/mobile-channel.*adapter ready|adapter ready \(accepts inbound WS/, { timeoutMs: 2_000 });
  // If we got here, the log line was found.
  const log = shim.readLog();
  assert.match(log, /adapter ready/, "mobile-channel adapter must be loaded for /shim/v1/mobile to work");
});

// ─── 18. assistant_message content arrives non-empty ────────────────

test("ws: assistant_message chunks concatenate to the full reply (lcp-cv3 streaming)", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-content",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  // lcp-cv3: assistant_message is now streamed as pure deltas; each
  // chunk of the same logical message shares the same envelope id
  // (cm-stream-<upstream_otid>) and content is only the delta. The
  // <upstream_otid> is letta-code's per-assistant-message otid, NOT
  // the mobile-supplied user-message otid — one turn may produce
  // multiple distinct assistant_messages (e.g. with interleaved tool
  // calls), each needing its own stable id across its chunks.
  const assistants = turn.filter((f) => f.type === "assistant_message") as unknown as Array<{
    id?: string; content?: string;
  }>;
  assert.ok(assistants.length > 0, "at least one assistant_message must arrive");
  const joined = assistants.map((a) => a.content ?? "").join("");
  assert.match(joined.toLowerCase(), /pong/, `concatenated content must include pong, got: ${joined}`);
  // Every chunk's id must start with cm-stream- and be non-empty.
  for (const a of assistants) {
    assert.ok(
      typeof a.id === "string" && a.id.startsWith("cm-stream-") && a.id.length > "cm-stream-".length,
      `assistant_message id must start with cm-stream-, got: ${a.id}`,
    );
  }
  // Group chunks by id and verify each group concatenates to non-empty
  // content (i.e. ids are stable across chunks of the same message).
  const byId = new Map<string, string>();
  for (const a of assistants) {
    byId.set(a.id ?? "", (byId.get(a.id ?? "") ?? "") + (a.content ?? ""));
  }
  for (const [id, content] of byId) {
    assert.ok(content.length > 0, `group ${id} concatenated to empty content`);
  }
});

// ─── 18a. assistant_message pure-delta contract (anti-snapshot) ────────

test("ws: assistant_message chunks are pure deltas — no chunk is a snapshot of accumulated content (lcp-cv3 contract)", async (t) => {
  // The lcp-cv3 contract: assistant_message frames over WS are PURE DELTAS.
  // Each chunk's `content` is the newly-emitted tokens since the previous
  // chunk with the same envelope id — NOT a cumulative snapshot of the
  // logical message.
  //
  // This invariant was implicit (a comment in mobile-channel-host.ts) and
  // unenforced until 2026-05-19 — when the REST-vs-WS race (lcp-r0m) made
  // it visible by causing snapshots to land on the same serverId as live
  // deltas. The client's `oldText + newText` merge produced incoherent text
  // (the "StandStanding by..." repro).
  //
  // This test pins the contract at the WS boundary: for every group of
  // chunks sharing an envelope id, no chunk's content may equal or be a
  // strict prefix of the accumulated content from earlier chunks in that
  // group. If a snapshot ever leaks through this gate, mobile's merge
  // would double-append it. Catching it here means it never reaches a
  // mobile build that lacks defensive merging (the gz2b backport).
  //
  // Companion tests:
  //   - "lcp-cv3 streaming" (above): verifies chunks concatenate.
  //   - "lcp-pro dedup bridge" (below): verifies monotonic seq_id.
  //   - "lcp-r0m REST /messages drops in-flight content": verifies the
  //     race source is gated.
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "bullet list three things about TCP/IP", // multi-step → multiple chunks
    otid: "cm-ws-pure-delta",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const assistants = turn.filter((f) => f.type === "assistant_message") as unknown as Array<{
    id?: string; content?: string;
  }>;
  assert.ok(assistants.length > 0, "at least one assistant_message must arrive");

  // Group chunks by envelope id, in arrival order.
  const groups = new Map<string, Array<string>>();
  for (const a of assistants) {
    const id = a.id ?? "";
    const list = groups.get(id) ?? [];
    list.push(a.content ?? "");
    groups.set(id, list);
  }

  // For each group, walk the chunks in order. After each chunk, the
  // accumulated content is `chunks[0] + chunks[1] + ...`. The next chunk
  // MUST NOT be:
  //   - equal to the accumulated content so far (a republished snapshot)
  //   - a strict prefix of the accumulated content (a stale earlier
  //     snapshot landing late)
  //   - a string for which the accumulated content is a strict prefix
  //     (i.e. the chunk is itself a snapshot starting with the old buffer
  //     plus new tail — this is the exact "StandStanding by..." shape if
  //     the client appends it as a delta).
  // The only allowed shape for a non-empty chunk is a TRUE DELTA: text
  // that, when appended, produces strictly new content.
  for (const [groupId, chunks] of groups) {
    let accumulated = "";
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] ?? "";
      // Empty chunks are allowed (e.g. tag-only chunks under A2UI splitter
      // emit empty conversational text on some flushes). Skip them.
      if (chunk.length === 0) {
        continue;
      }
      // After the first chunk, every subsequent non-empty chunk must be a
      // true delta against the accumulator.
      if (accumulated.length > 0) {
        assert.notEqual(
          chunk,
          accumulated,
          `group ${groupId} chunk ${i}: chunk content equals the accumulated buffer — that's a snapshot, not a delta`,
        );
        assert.ok(
          !accumulated.startsWith(chunk),
          `group ${groupId} chunk ${i}: chunk content is a strict prefix of accumulated buffer (stale snapshot landing late)`,
        );
        assert.ok(
          !chunk.startsWith(accumulated),
          `group ${groupId} chunk ${i}: chunk content starts with the accumulated buffer (cumulative snapshot, not a pure delta). ` +
          `If this fires, the WS path leaked a snapshot frame. Expected pure delta. ` +
          `accumulated=${JSON.stringify(accumulated.slice(0, 80))}... ` +
          `chunk=${JSON.stringify(chunk.slice(0, 80))}...`,
        );
      }
      accumulated += chunk;
    }
    assert.ok(accumulated.length > 0, `group ${groupId} accumulated to empty content`);
  }
});

// ─── 18b. assistant_message carries monotonic seq_id (lcp-pro) ─────────

test("ws: assistant_message chunks carry monotonic seq_id (lcp-pro dedup bridge)", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-seq",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  // lcp-pro: stamp the per-run `seq` value as `seq_id` on every
  // assistant_message and reasoning_message frame so the mobile client's
  // existing hasAlreadyIngestedStreamFrame dedup gate fires on the WS path.
  // Without this, duplicate deltas from reconnect-replay or WS-vs-REST race
  // append silently and produce incoherent text (the 2026-05-19 evening
  // "Hello worldHello world" repro).
  const assistants = turn.filter((f) => f.type === "assistant_message") as unknown as Array<{
    seq?: number | null;
    seq_id?: number | null;
  }>;
  assert.ok(assistants.length > 0, "at least one assistant_message must arrive");
  // Every chunk must carry a numeric seq_id (the per-run cursor stamped by
  // the host's emit()). Strictly increasing across the turn — earlier chunks
  // have smaller seq_id than later chunks. seq_id is also a strict alias of
  // `seq` (the per-run frame counter); if upstream supplies its own seq_id
  // the shim overwrites with the authoritative shim value so the gate's
  // monotonicity invariant holds across synthetic frames (splitter flush,
  // a2ui_frame siblings, etc).
  let prev = -Infinity;
  for (const a of assistants) {
    assert.ok(
      typeof a.seq_id === "number",
      `assistant_message must carry numeric seq_id, got: ${a.seq_id}`,
    );
    assert.equal(
      a.seq_id,
      a.seq,
      `seq_id must alias seq (got seq_id=${a.seq_id} seq=${a.seq})`,
    );
    assert.ok(
      (a.seq_id as number) > prev,
      `seq_id must be strictly increasing across the turn (got ${a.seq_id} after ${prev})`,
    );
    prev = a.seq_id as number;
  }
});

// ─── 18b'. seq_id alias also fires on a2ui-driven flushes ──────────────

test("ws: seq_id alias survives a2ui-enabled turn (splitter flush gets seq_id, not null)", async (t) => {
  // Force the a2ui-card fixture so the splitter runs end-to-end. The
  // end-of-turn flush in mobile-channel-host emits an assistant_message
  // for any text the splitter held back behind a partial tag; that synthetic
  // frame must also carry a non-null seq_id, otherwise mobile's dedup gate
  // goes back to dead-code on the very last delta of every a2ui turn.
  const { conn, agentId, convId } = await setupAuthed(t, {
    env: { LETTA_MOCK_FORCE_TRACE: "a2ui-card" },
  });
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "show an approval card",
    otid: "cm-ws-seq-a2ui",
    a2ui_capability: { version: "0.9", catalog: "basic" },
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const assistants = turn.filter((f) => f.type === "assistant_message") as unknown as Array<{
    seq?: number | null;
    seq_id?: number | null;
  }>;
  // Empty assistants is fine for some a2ui-only outputs, but the seq alias
  // must hold for every one present.
  for (const a of assistants) {
    assert.ok(
      typeof a.seq_id === "number",
      `a2ui-path assistant_message must carry numeric seq_id (got ${a.seq_id})`,
    );
    assert.equal(a.seq_id, a.seq, `seq_id must equal seq on a2ui path`);
  }
});

// ─── 18c. REST /messages drops in-flight content during a WS turn ─────

test("ws: REST /messages drops in-flight content during a WS turn (lcp-r0m)", async (t) => {
  // Slow the mock so the turn stays in-flight long enough to issue a REST
  // GET and observe filtering. Same trick as the cancel/single-flight tests.
  const { shim, conn, agentId, convId } = await setupAuthed(t, {
    env: { LETTA_MOCK_DELAY_MS: "200" },
  });
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-r0m",
  });
  // Wait for at least one assistant_message chunk so the run has registered
  // at least one persisted message in RunRecord.message_ids.
  let sawAssistantChunk = false;
  const startWait = Date.now();
  while (Date.now() - startWait < WS_TIMEOUT_MS) {
    if (conn.frames.some((f) => f.type === "assistant_message")) {
      sawAssistantChunk = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(sawAssistantChunk, "should observe at least one assistant_message before REST poll");
  // Issue REST GET /v1/conversations/{convId}/messages while the turn is
  // still in flight. The handler must filter out in-flight messages so the
  // client never sees a cumulative snapshot that races the WS deltas.
  const restUrl = new URL(`/v1/conversations/${convId}/messages?limit=250&order=desc`, shim.url!);
  const resp = await fetch(restUrl, {
    headers: { authorization: `Bearer ${shim.mobileToken}` },
  });
  assert.equal(resp.status, 200, "REST /messages must succeed during in-flight turn");
  const items = await resp.json() as Array<{ id?: string; message_type?: string; content?: unknown }>;
  // Any in-flight assistant_message MUST NOT appear. The in-flight set is
  // populated by recordRunMessage as letta-code persists each message
  // mid-turn; the REST handler consults inFlightMessageIds(agentId, convId)
  // and filters the response. If we see an assistant_message here with
  // content matching the active stream, the filter regressed.
  const restAssistants = items.filter((m) => m.message_type === "assistant_message");
  assert.equal(
    restAssistants.length,
    0,
    `REST /messages must drop in-flight assistant_messages (got ${restAssistants.length})`,
  );
  // Let the turn complete cleanly so the test's afterEach doesn't dangle.
  // (We don't assert post-turn_done REST shape here — the mock doesn't
  // append to messages.jsonl on its own, so a positive disk assertion
  // needs a different setup path. See "otid in send_message propagates"
  // for the pattern when a disk-state assertion is needed.)
  await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS });
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
  const ts = await conn.waitFor("turn_started", { timeoutMs: WS_TIMEOUT_MS }) as unknown as
    { agent_id: string; conversation_id: string; turn_id: string };
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
  const err = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { code: string };
  assert.equal(err.code, "protocol_violation");
  assert.equal(conn.closed, false, "validation error must NOT close the socket");
});

// ─── 21a. lcp-99a: turn_started always carries non-null run_id ─────

test("ws: lcp-99a — turn_started always carries non-null run_id", async (t) => {
  // The shim pre-creates the Run before emitting turn_started so mobile's
  // ChannelTransport.cancel() always has a valid target, even immediately
  // after send_message. Before lcp-99a, run_id was null until the first
  // run_id-bearing post-turn_started frame arrived.
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-ts-runid",
  });
  const ts = await conn.waitFor("turn_started", { timeoutMs: WS_TIMEOUT_MS }) as unknown as
    { turn_id: string; run_id?: string | null };
  assert.ok(ts.run_id, "turn_started.run_id must be a non-empty string (lcp-99a)");
  assert.match(ts.run_id, /^run-/, "run_id must use the run- prefix");
  // And every subsequent typed frame must carry the same run_id.
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  for (const f of turn) {
    if (["turn_started", "ping", "welcome"].includes(f.type)) continue;
    const runIdOnFrame = (f as { run_id?: unknown }).run_id;
    if (runIdOnFrame !== undefined && runIdOnFrame !== null) {
      assert.equal(runIdOnFrame, ts.run_id, `frame ${f.type} run_id must match turn_started.run_id`);
    }
  }
});

// ─── 21b. lcp-srk: turn_done carries lossy + drop_count fields ─────

test("ws: lcp-srk — turn_done carries lossy=false + drop_count=0 on a clean turn", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-lossy",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const done = turn.find((f) => f.type === "turn_done") as unknown as
    { status: string; lossy?: boolean; drop_count?: number; error_code?: unknown; error_message?: unknown } | undefined;
  assert.ok(done, "turn_done required");
  assert.equal(done.status, "completed", "clean turn must complete");
  assert.equal(done.lossy, false, "no drops on a clean turn → lossy:false");
  assert.equal(done.drop_count, 0, "drop_count must be 0 on a clean turn");
  // lcp-gs2: error fields are present but null on non-failed turns.
  assert.equal(done.error_code, null, "error_code null on completed turn");
  assert.equal(done.error_message, null, "error_message null on completed turn");
});

test("ws: stop_reason=error emits error frame and failed turn_done", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t, {
    env: { LETTA_MOCK_STOP_REASON: "error" },
  });
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-stop-error",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const err = turn.find((f) => f.type === "error") as unknown as
    { code?: string; message?: string; run_id?: string | null } | undefined;
  const stop = turn.find((f) => f.type === "stop_reason") as unknown as
    { stop_reason?: string; run_id?: string | null } | undefined;
  const done = turn.find((f) => f.type === "turn_done") as unknown as
    { status?: string; error_code?: string | null; error_message?: string | null; run_id?: string | null } | undefined;

  assert.ok(err, "upstream stop_reason=error must produce an explicit error frame");
  assert.equal(err.code, "internal_error");
  assert.match(err.message ?? "", /stop_reason=error/);
  assert.equal(stop?.stop_reason, "error", "original stop_reason must still pass through");
  assert.equal(done?.status, "failed", "turn_done must make the terminal failure authoritative");
  assert.equal(done?.error_code, "internal_error");
  assert.match(done?.error_message ?? "", /stop_reason=error/);
  assert.ok(done?.run_id, "failed turn_done must still carry the shim run_id");
  assert.equal(err.run_id, done?.run_id, "error frame and turn_done must refer to the same run");
});

// ─── 21c. lcp-sep: tool_call frames may stream progressive args ────

test("ws: lcp-sep — tool_call_message frames pass through without shim-side dedup (multiple per call ok)", async (t) => {
  // letta-code may emit multiple tool_call_message frames sharing the
  // same tool_call_id as the LLM's arg JSON accumulates. The shim must
  // forward each one verbatim (preserving the `toolcall-<id>` envelope
  // id) so mobile's `newScore >= oldScore` merge policy can pick the
  // most-complete version. Test verifies the shim adds NO dedup at the
  // mobile-WS layer: frame count >= 1, and any duplicate ids point at
  // the same tool_call_id.
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "run bash echo hello",
    otid: "cm-ws-sep",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const tcs = turn.filter((f) => f.type === "tool_call_message") as unknown as Array<{
    id?: string;
    tool_call?: { tool_call_id?: string; name?: string };
  }>;
  assert.ok(tcs.length >= 1, "at least one tool_call_message must arrive");
  // Each frame's envelope id is `toolcall-<tool_call_id>` and groups
  // representing the same logical call share that id and tool_call_id.
  for (const tc of tcs) {
    assert.ok(tc.id?.startsWith("toolcall-"), `envelope id must start with toolcall-, got: ${tc.id}`);
    const stripped = tc.id?.replace(/^toolcall-/, "");
    assert.equal(stripped, tc.tool_call?.tool_call_id, "envelope id suffix must equal tool_call_id");
  }
  // No dedup at shim layer: an unbounded number of frames per call is
  // acceptable. (Current fixtures emit 1, but the contract permits N.)
});

// ─── 21d. lcp-kfr: client disconnect mid-turn does not abort the run ──

test("ws: lcp-kfr — client WS disconnect does not prevent run from finalizing", async (t) => {
  // Phase-1 contract: disconnect mid-turn loses the wire frames but the
  // shim keeps running the turn locally. The Run record must transition
  // to a terminal status so mobile's reconcile-from-disk path on
  // reconnect finds an authoritative outcome.
  const { conn, agentId, convId, shim } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-kfr",
  });
  // Wait for turn_started so we have run_id.
  const ts = await conn.waitFor("turn_started", { timeoutMs: WS_TIMEOUT_MS }) as unknown as
    { run_id: string };
  assert.ok(ts.run_id, "expected run_id on turn_started");
  // Yank the connection immediately. The run is still in flight on the
  // shim side.
  conn.close();
  // Give the worker time to finish processing the turn locally and
  // finalize the run record. Worker turns in the test harness are fast
  // (synthetic fixtures) but generous timeout in case of slow IO.
  await new Promise((r) => setTimeout(r, 3_000));
  // The Run record on disk should now have a terminal status. Hit the
  // REST surface to confirm — same data the mobile reconcile path uses.
  const res = await fetch(`${shim.url}/v1/runs/${ts.run_id}`, {
    headers: { Authorization: "Bearer fake-token" },
  });
  assert.equal(res.status, 200, "run must be readable from disk after disconnect");
  const run = await res.json() as { status?: string };
  assert.ok(
    ["completed", "failed", "cancelled"].includes(run.status ?? ""),
    `run must reach a terminal status post-disconnect, got: ${run.status}`,
  );
});

// ─── 21e. lcp-dlj: content_parts size cap + shape validation ──────

test("ws: lcp-dlj — send_message with non-array content_parts → protocol_violation", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "hi",
    content_parts: "not an array",
  });
  const err = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { code: string; message: string };
  assert.equal(err.code, "protocol_violation");
  assert.match(err.message, /content_parts.*array/i);
  assert.equal(conn.closed, false, "validation error must not close the socket");
});

test("ws: lcp-dlj — send_message with oversized content_parts (>10MB) → protocol_violation", async (t) => {
  const { conn, agentId, convId } = await setupAuthed(t);
  // 11MB worth of fake base64 image data to trip the size guard.
  const oversized = "A".repeat(11 * 1024 * 1024);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "look at this",
    content_parts: [
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: oversized } },
    ],
  });
  const err = await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { code: string; message: string };
  assert.equal(err.code, "protocol_violation");
  assert.match(err.message, /content_parts.*exceeds/i);
  assert.equal(conn.closed, false);
});

test("ws: lcp-dlj — send_message with text-only content_parts passes through and completes", async (t) => {
  // Text-only content_parts proves the shim parses + threads the field
  // to the worker without exercising the fixture worker's (non-existent)
  // image-handling path. The fixture replies with the standard pong
  // trace, and the assistant message must contain "pong" — proving the
  // content_parts text reached letta-code's headless stdin verbatim
  // and the user prompt was honored.
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",  // present but should be ignored
    otid: "cm-ws-dlj",
    content_parts: [
      { "type": "text", "text": "reply with pong" },
    ],
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const types = turn.map((f) => f.type);
  assert.ok(types.includes("turn_started"), `expected turn_started, got ${types.join(",")}`);
  assert.ok(types.includes("turn_done"), `expected turn_done, got ${types.join(",")}`);
  const done = turn.find((f) => f.type === "turn_done") as unknown as { status: string };
  assert.equal(done.status, "completed", "text-only content_parts turn must complete cleanly");
  const assistants = turn.filter((f) => f.type === "assistant_message") as unknown as Array<{ content?: string }>;
  const joined = assistants.map((a) => a.content ?? "").join("");
  assert.match(joined.toLowerCase(), /pong/, `content_parts text must reach the worker; got: ${joined}`);
});

// ─── 22. stop_reason frame shape on WS ──────────────────────────────

test("ws: stop_reason frame carries stop_reason field (`end_turn` on clean turn)", async (t) => {
  // The WS envelope uses the same `stop_reason:` field name as the REST/SSE
  // surface and Kotlin's StopReason model. Kotlin clients can deserialize
  // this frame directly with the canonical StopReason.serializer().
  // (Was `reason:` until lcp-fgd; renamed before the mobile WS client shipped.)
  const { conn, agentId, convId } = await setupAuthed(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-ws-sr",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const stop = turn.find((f) => f.type === "stop_reason") as unknown as
    { stop_reason: string; turn_id?: unknown } | undefined;
  assert.ok(stop, "stop_reason must be present");
  assert.equal(stop.stop_reason, "end_turn");
  assert.ok(stop.turn_id, "stop_reason must carry turn_id");
});
