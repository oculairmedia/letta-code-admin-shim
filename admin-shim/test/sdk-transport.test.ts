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

test("sdk-transport (lcp-sdk.6): SDK adapter drives a mobile WS turn end-to-end", async (t) => {
  // The SDK resolves the CLI via LETTA_CLI_PATH — point it at the letta-mock
  // so we're exercising the adapter integration without spinning up a real
  // model.
  const shim = await startShim({
    env: {
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
    /\[pool\] spawned key=agent-sdk-xport-1::default/,
    "agent-pool must spawn the SDK-backed adapter",
  );
  assert.match(
    shim.readLog(),
    /\[sdk-adapter\] started agent=agent-sdk-xport-1/,
    "SDK adapter must report init",
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

// lcp-sdk.10: the direct subprocess transport was removed; SHIM_LETTA_TRANSPORT
// and SHIM_POOL_DISABLE are no longer honored. The corresponding tests
// (rollback path + flag-conflict warning) were retired with the direct
// adapter. The SDK adapter is the only implementation; the spawn log no
// longer carries a transport tag.
