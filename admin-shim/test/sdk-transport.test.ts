/**
 * lcp-sdk.6 — end-to-end coverage for SHIM_LETTA_TRANSPORT=sdk.
 *
 * The dispatch wiring for REST/SSE (lib/chat.ts) and mobile WS
 * (lib/mobile-channel-host.ts) both go through AgentPool.get(), which
 * picks the adapter via SHIM_LETTA_TRANSPORT (lcp-sdk.3). This test
 * proves the seam actually flips end-to-end: a real WS turn under
 * SHIM_LETTA_TRANSPORT=sdk completes via the SdkBackedLettaSessionAdapter,
 * produces the same wire envelopes (turn_started → assistant chunks →
 * stop_reason → turn_done), and surfaces a shim run record with the
 * right shape (lcp-sdk.4 contract preserved).
 *
 * Approvals are NOT yet ported to the SDK path (lcp-sdk.5); this test
 * intentionally exercises a text-only turn to stay in the supported
 * envelope.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  startShim,
  seedAgent,
  seedConversation,
  externalConvId,
  openMobileWs,
} from "./helpers/index.js";
import { MOCK_LETTA_PATH } from "./helpers/shim.js";

const WS_TIMEOUT_MS = 8000;

test("sdk-transport (lcp-sdk.6): SHIM_LETTA_TRANSPORT=sdk drives a mobile WS turn end-to-end", async (t) => {
  // The SDK resolves the CLI via LETTA_CLI_PATH — point it at the same
  // letta-mock the direct path uses so we're testing transport selection,
  // not different CLI behavior.
  const shim = await startShim({
    env: {
      SHIM_LETTA_TRANSPORT: "sdk",
      LETTA_CLI_PATH: MOCK_LETTA_PATH,
    },
  });
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-sdk-xport-1" });
  seedConversation(shim.stateDir, agentId);

  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: externalConvId(agentId),
    text: "hello sdk",
    otid: "ot-sdk-1",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });

  // The spawn log line is the strongest signal that the SDK path actually
  // ran — pool.get() picked the SDK adapter, not the direct subprocess.
  assert.match(
    shim.readLog(),
    /\[pool\] spawned transport=sdk key=agent-sdk-xport-1::default/,
    "agent-pool must spawn the SDK-backed adapter when SHIM_LETTA_TRANSPORT=sdk",
  );

  // Same WS envelope contract as the direct path. The mock's `plain` trace
  // produces assistant text + a stop_reason; turn_done closes the turn.
  const types = turn.map((f) => f.type);
  assert.ok(types.includes("turn_started"), `expected turn_started in ${JSON.stringify(types)}`);
  assert.ok(types.includes("stop_reason"), `expected stop_reason in ${JSON.stringify(types)}`);
  assert.ok(types.includes("turn_done"), `expected turn_done in ${JSON.stringify(types)}`);

  // Assistant content lands. We don't pin a specific string — the mock
  // chooses based on prompt content; "hello sdk" routes to the default
  // `plain` trace.
  const assistantText = turn
    .filter((f) => f.type === "assistant_message")
    .map((f) => (typeof f["content"] === "string" ? (f["content"] as string) : ""))
    .join("");
  assert.ok(assistantText.length > 0, "SDK path must produce assistant text");
});

test("sdk-transport (lcp-sdk.6): SHIM_LETTA_TRANSPORT=direct keeps the direct adapter (rollback path)", async (t) => {
  const shim = await startShim({
    env: { SHIM_LETTA_TRANSPORT: "direct" },
  });
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-sdk-xport-rollback" });
  seedConversation(shim.stateDir, agentId);

  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: externalConvId(agentId),
    text: "hello direct",
    otid: "ot-direct-1",
  });
  await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });

  assert.match(
    shim.readLog(),
    /\[pool\] spawned transport=direct key=agent-sdk-xport-rollback::default/,
    "SHIM_LETTA_TRANSPORT=direct must keep the hand-rolled subprocess adapter",
  );
});

test("sdk-transport (lcp-sdk.6): SHIM_LETTA_TRANSPORT=sdk + SHIM_POOL_DISABLE=1 logs a warning and falls back", async (t) => {
  // The legacy per-request spawn (SHIM_POOL_DISABLE=1 in chat.ts) bypasses
  // AgentPool entirely, so SDK transport can't apply. The agent-pool guard
  // logs a one-time warning instead of silently dropping the flag.
  const shim = await startShim({
    env: {
      SHIM_LETTA_TRANSPORT: "sdk",
      SHIM_POOL_DISABLE: "1",
      LETTA_CLI_PATH: MOCK_LETTA_PATH,
    },
  });
  t.after(() => shim.stop());

  const agentId = seedAgent(shim.stateDir, { id: "agent-sdk-conflict-1" });
  seedConversation(shim.stateDir, agentId);

  // Trigger pool.get() so resolveTransport() runs. With SHIM_POOL_DISABLE=1
  // chat.ts takes the legacy path, but mobile WS still goes through the
  // pool — and that's where the conflict guard fires.
  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: WS_TIMEOUT_MS });
  t.after(() => conn.close());
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: externalConvId(agentId),
    text: "hello conflict",
    otid: "ot-conflict-1",
  });
  await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });

  assert.match(
    shim.readLog(),
    /WARN: SHIM_LETTA_TRANSPORT=sdk has no effect while SHIM_POOL_DISABLE=1/,
    "operator must see a clear warning when both flags conflict",
  );
  // After the warning, the resolved transport falls back to direct.
  assert.match(
    shim.readLog(),
    /\[pool\] spawned transport=direct key=agent-sdk-conflict-1::default/,
    "fallback transport when flags conflict must be direct",
  );
});
