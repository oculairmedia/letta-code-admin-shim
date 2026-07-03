/**
 * Behavioral tests for the generic channel host (bead letta-mobile-9o50g).
 *
 * Spins up real shim subprocesses via the standard harness and drives the
 * file-driven fake plugin (test/fixtures/channels/fake-plugin/): inbox
 * appends become inbound messages, sendMessage lands in outbox.jsonl, and
 * every adapter lifecycle step is journaled to fake-events.jsonl.
 *
 * The /v1/channels REST surface (bead letta-mobile-6ahjp) ships in the
 * next phase, so state assertions here go through the registry's log
 * lines and the fake plugin's journal files instead of GET …/status;
 * channels-rest.test.ts will cover the HTTP mirror.
 *
 * Coverage (design §5, test/channel-registry.test.ts):
 *   1. discovery + start
 *   2. disabled account skipped
 *   3. inbound → bridge → outbound (+ lifecycle events + run recorded)
 *   4. unrouted inbound dropped (with typing-release `finished` event)
 *   5. crash backoff (crashOnStart) with a responsive HTTP surface
 *   6. adapter crash isolation via the health poll (reportDead)
 *   7. mobile regression: WS handshake + bridged turn next to fake channel
 *   8. secret hygiene: canaries never appear in logs; redaction helpers
 *   9. uncaught-throw survival (poisonUncaught → process-level trap)
 *  10. legacy route shape resolves; routing.yaml is never rewritten
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openMobileWs, seedAgent, seedConversation, externalConvId, startShim } from "./helpers/index.js";
import type { ShimHandle } from "./helpers/shim.js";
import {
  mergeConfigPreservingSecrets,
  redactConfig,
} from "../lib/channel-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_PLUGIN_DIR = join(__dirname, "fixtures", "channels", "fake-plugin");

const ACCESS_TOKEN_CANARY = "canary-access-supersecret-1234";
const FALLBACK_TOKEN_CANARY = "canary-fallback-supersecret-5678";

function fakeAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "fake",
    accountId: "main",
    displayName: "Fake Main",
    enabled: true,
    dmPolicy: "open",
    legacy_snake_field: "must-survive",
    config: {
      accessToken: ACCESS_TOKEN_CANARY,
      tokenFallback: FALLBACK_TOKEN_CANARY,
      ...(overrides["config"] as Record<string, unknown> | undefined),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "config")),
  };
}

function channelPath(shim: ShimHandle, ...parts: string[]): string {
  return join(shim.homeDir, ".letta", "channels", "fake", ...parts);
}

function readEvents(shim: ShimHandle): Array<Record<string, unknown>> {
  const path = channelPath(shim, "fake-events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function readOutbox(shim: ShimHandle): Array<Record<string, unknown>> {
  const path = channelPath(shim, "outbox.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function appendInbox(shim: ShimHandle, msg: Record<string, unknown>): void {
  appendFileSync(channelPath(shim, "inbox.jsonl"), JSON.stringify(msg) + "\n");
}

async function waitUntil(
  cond: () => boolean,
  what: string,
  { timeoutMs = 20_000, everyMs = 100 }: { timeoutMs?: number; everyMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`waitUntil(${what}) timed out after ${timeoutMs}ms`);
}

// ── 1. discovery + start ────────────────────────────────────────────

test("registry discovers the fake channel and starts its enabled account", async () => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()] }],
  });
  try {
    await shim.waitForLogLine(/\[channel-registry] started \(1 adapters\)/);
    await shim.waitForLogLine(/\[channel-registry] fake:main starting -> running \(restarts=0\)/);
    const events = readEvents(shim);
    assert.ok(
      events.some((e) => e["event"] === "created" && e["accountId"] === "main"),
      `fake-events.jsonl must show created; got ${JSON.stringify(events)}`,
    );
    assert.ok(events.some((e) => e["event"] === "started" && e["accountId"] === "main"));
  } finally {
    await shim.stop();
  }
});

// ── 2. disabled account skipped ─────────────────────────────────────

test("disabled account is skipped by supervision", async () => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount({ enabled: false })] }],
  });
  try {
    await shim.waitForLogLine(/\[channel-registry] started \(0 adapters\)/);
    // No construction attempt at all — the journal stays empty.
    assert.equal(readEvents(shim).length, 0);
  } finally {
    await shim.stop();
  }
});

// ── 3. inbound → bridge → outbound ──────────────────────────────────

test("routed inbound bridges a turn and replies to the channel", async () => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()] }],
  });
  try {
    const agentId = seedAgent(shim.stateDir, { id: `agent-chanreg-${Date.now()}` });
    seedConversation(shim.stateDir, agentId);
    const convId = externalConvId(agentId);
    // Route seeded AFTER boot on purpose: resolveRoute reads fresh per
    // inbound, so no restart is needed for new routes.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      channelPath(shim, "routing.yaml"),
      JSON.stringify(
        {
          routes: [{
            accountId: "main",
            chatId: "room1",
            chatType: "group",
            threadId: null,
            agentId,
            conversationId: convId,
            enabled: true,
            outboundEnabled: true,
            createdAt: "2026-05-13T00:00:00.000Z",
            updatedAt: "2026-05-13T00:00:00.000Z",
          }],
        },
        null,
        2,
      ) + "\n",
    );
    await shim.waitForLogLine(/fake:main starting -> running/);
    appendInbox(shim, { chatId: "room1", text: "hello registry", messageId: "m-1" });

    await waitUntil(() => readOutbox(shim).length > 0, "outbox reply");
    const reply = readOutbox(shim)[0]!;
    assert.equal(reply["chatId"], "room1");
    assert.equal(reply["replyToMessageId"], "m-1");
    assert.ok(typeof reply["text"] === "string" && (reply["text"] as string).length > 0,
      `reply must carry the mock's assistant text; got ${JSON.stringify(reply)}`);

    // Lifecycle contract: queued → processing → finished for room1.
    await waitUntil(
      () => readEvents(shim).some((e) => e["event"] === "lifecycle" && e["type"] === "finished" && e["chatId"] === "room1"),
      "finished lifecycle event",
    );
    const lifecycleTypes = readEvents(shim)
      .filter((e) => e["event"] === "lifecycle" && e["chatId"] === "room1")
      .map((e) => e["type"]);
    for (const expected of ["queued", "processing", "finished"]) {
      assert.ok(lifecycleTypes.includes(expected), `missing lifecycle "${expected}" (got ${lifecycleTypes.join(",")})`);
    }

    // The turn went through the ONE shared bridge: it shows up in the
    // shim's normal runs storage exactly like a mobile turn.
    const runsRes = await fetch(`${shim.url}/v1/runs?agent_id=${agentId}`);
    assert.equal(runsRes.status, 200);
    const runsBody = await runsRes.text();
    assert.ok(runsBody.includes(agentId), `run for ${agentId} must exist: ${runsBody.slice(0, 300)}`);
  } finally {
    await shim.stop();
  }
});

// ── 4. unrouted inbound dropped (typing release still fired) ─────────

test("unrouted inbound is dropped with a finished lifecycle event and the shim stays alive", async () => {
  const shim = await startShim({
    channels: [{
      id: "fake",
      pluginDir: FAKE_PLUGIN_DIR,
      accounts: [fakeAccount()],
      routes: [],
    }],
  });
  try {
    await shim.waitForLogLine(/fake:main starting -> running/);
    appendInbox(shim, { chatId: "room2", text: "nobody routed me", messageId: "m-2" });
    await shim.waitForLogLine(/\[channel-registry] unrouted inbound fake:room2/);
    // Typing-indicator release contract: the drop path MUST fire finished.
    await waitUntil(
      () => readEvents(shim).some((e) => e["event"] === "lifecycle" && e["type"] === "finished" && e["chatId"] === "room2"),
      "finished lifecycle for unrouted drop",
    );
    assert.equal(readOutbox(shim).length, 0, "no outbound reply for an unrouted message");
    const health = await fetch(`${shim.url}/v1/health/`);
    assert.equal(health.status, 200);
  } finally {
    await shim.stop();
  }
});

// ── 5. crash backoff ─────────────────────────────────────────────────

test("crashOnStart drives crashed -> backoff -> running with restarts counted", async () => {
  const shim = await startShim({
    channels: [{
      id: "fake",
      pluginDir: FAKE_PLUGIN_DIR,
      accounts: [fakeAccount({ accountId: "crashy", config: { crashOnStart: 2 } })],
    }],
  });
  try {
    await shim.waitForLogLine(/fake:crashy starting -> crashed: start failed: fake crash 1/);
    await shim.waitForLogLine(/fake:crashy crashed -> backoff \(retry in 1000ms\)/);
    // The HTTP surface stays responsive while the adapter churns.
    const health = await fetch(`${shim.url}/v1/health/`);
    assert.equal(health.status, 200);
    await shim.waitForLogLine(/fake:crashy crashed -> backoff \(retry in 2000ms\)/, { timeoutMs: 10_000 });
    await shim.waitForLogLine(/fake:crashy starting -> running \(restarts=2\)/, { timeoutMs: 15_000 });
    const crons = await fetch(`${shim.url}/v1/crons`);
    assert.equal(crons.status, 200);
  } finally {
    await shim.stop();
  }
});

// ── 6. health-poll crash isolation ───────────────────────────────────

test("isRunning()=false flips a running adapter to crashed without hurting the shim", async () => {
  const shim = await startShim({
    env: { SHIM_CHANNEL_HEALTH_POLL_MS: "150" },
    channels: [{
      id: "fake",
      pluginDir: FAKE_PLUGIN_DIR,
      accounts: [fakeAccount({ accountId: "dead", config: { reportDead: true } })],
    }],
  });
  try {
    await shim.waitForLogLine(/fake:dead starting -> running/);
    await shim.waitForLogLine(/fake:dead running -> crashed: supervision: health check: isRunning\(\) returned false/, { timeoutMs: 10_000 });
    await shim.waitForLogLine(/fake:dead crashed -> backoff/);
    const crons = await fetch(`${shim.url}/v1/crons`);
    assert.equal(crons.status, 200);
  } finally {
    await shim.stop();
  }
});

// ── 7. mobile regression next to a registry-managed channel ──────────

test("mobile WS handshake and bridged turn still work with the fake channel running", async (t) => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()] }],
  });
  t.after(() => shim.stop());
  await shim.waitForLogLine(/fake:main starting -> running/);

  const agentId = seedAgent(shim.stateDir, { id: `agent-mobilereg-${Date.now()}` });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);

  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
  t.after(() => conn.close());
  assert.ok(conn.sessionId, "mobile welcome handshake must carry a session id");

  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "hello from mobile",
  });
  const turn = await conn.collectTurn({ timeoutMs: 20_000 });
  assert.ok(turn.some((f) => f.type === "turn_done"), "mobile turn must settle");
  // Mobile stays WS-host managed — the registry only ever counts adapters
  // it starts itself (the fake one).
  assert.match(shim.readLog(), /\[channel-registry] started \(1 adapters\)/);
});

// ── 8. secret hygiene ────────────────────────────────────────────────

test("secret canaries never reach logs; redaction helpers behave", async () => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()] }],
  });
  try {
    await shim.waitForLogLine(/fake:main starting -> running/);
    // The fake plugin logs its own token via host.log — the scrubbed form
    // must appear, the raw canaries must not, anywhere.
    await shim.waitForLogLine(/\[fake:main] fake adapter starting; token=\*\*\*/);
    const log = shim.readLog();
    assert.ok(!log.includes(ACCESS_TOKEN_CANARY), "accessToken canary leaked into shim log");
    assert.ok(!log.includes(FALLBACK_TOKEN_CANARY), "tokenFallback canary leaked into shim log");
    const diskLogPath = channelPath(shim, "logs", "main.log");
    assert.ok(existsSync(diskLogPath), "per-adapter disk log must exist");
    const diskLog = readFileSync(diskLogPath, "utf8");
    assert.ok(diskLog.includes("token=***"), "disk log must carry the scrubbed line");
    assert.ok(!diskLog.includes(ACCESS_TOKEN_CANARY));
    assert.ok(!diskLog.includes(FALLBACK_TOKEN_CANARY));
  } finally {
    await shim.stop();
  }

  // Redaction contract the REST layer will serialize (unit-level; the
  // /v1/channels accounts surface lands next phase).
  const redacted = redactConfig({
    accessToken: ACCESS_TOKEN_CANARY,
    tokenFallback: FALLBACK_TOKEN_CANARY,
    homeserverUrl: "https://example.org",
  });
  assert.deepEqual(redacted["accessToken"], { __secret_set: true });
  assert.deepEqual(redacted["tokenFallback"], { __secret_set: true });
  assert.equal(redacted["homeserverUrl"], "https://example.org");

  const merged = mergeConfigPreservingSecrets(
    { accessToken: "keep-me", homeserverUrl: "https://old.example" },
    { accessToken: { __secret_set: true }, homeserverUrl: "https://new.example", extra: null },
  );
  assert.equal(merged["accessToken"], "keep-me", "sentinel must preserve the stored secret");
  assert.equal(merged["homeserverUrl"], "https://new.example");
  assert.ok(!("extra" in merged));
  const withDelete = mergeConfigPreservingSecrets({ accessToken: "gone" }, { accessToken: null });
  assert.ok(!("accessToken" in withDelete), "explicit null must delete the secret");
});

// ── 9. uncaught-throw survival ───────────────────────────────────────

test("a plugin's floating uncaught throw does not kill the shim or mobile", async (t) => {
  const shim = await startShim({
    channels: [{
      id: "fake",
      pluginDir: FAKE_PLUGIN_DIR,
      accounts: [fakeAccount({ accountId: "poison", config: { poisonUncaught: true } })],
    }],
  });
  t.after(() => shim.stop());
  await shim.waitForLogLine(/fake:poison starting -> running/);
  await shim.waitForLogLine(/\[channel-registry] (unattributed uncaughtException|uncaughtException attributed to fake:poison)/, { timeoutMs: 10_000 });

  // Process is still alive: HTTP answers and a mobile WS still connects.
  const crons = await fetch(`${shim.url}/v1/crons`);
  assert.equal(crons.status, 200);
  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
  t.after(() => conn.close());
  assert.ok(conn.sessionId, "mobile WS must still handshake after the poison throw");
});

// ── 10. legacy route shape ───────────────────────────────────────────

test("a CLI-vintage minimal route resolves and the file is never rewritten", async () => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()] }],
  });
  try {
    const agentId = seedAgent(shim.stateDir, { id: `agent-legacy-${Date.now()}` });
    seedConversation(shim.stateDir, agentId);
    const convId = externalConvId(agentId);
    // Deliberately NO chatType / outboundEnabled / updatedAt — the real
    // CLI-vintage file lacks them (§1.4 optional-field handling).
    const body = JSON.stringify(
      {
        routes: [{
          accountId: "main",
          chatId: "legacyroom",
          threadId: null,
          agentId,
          conversationId: convId,
          enabled: true,
          createdAt: "2026-05-13T00:00:00.000Z",
        }],
      },
      null,
      2,
    ) + "\n";
    const { writeFileSync } = await import("node:fs");
    const routingPath = channelPath(shim, "routing.yaml");
    writeFileSync(routingPath, body);
    const before = readFileSync(routingPath, "utf8");

    await shim.waitForLogLine(/fake:main starting -> running/);
    appendInbox(shim, { chatId: "legacyroom", text: "legacy hello", messageId: "m-legacy" });
    await waitUntil(() => readOutbox(shim).length > 0, "legacy route outbox reply");
    const reply = readOutbox(shim)[0]!;
    assert.equal(reply["chatId"], "legacyroom", "outboundEnabled-absent must default to enabled");

    const after = readFileSync(routingPath, "utf8");
    assert.equal(after, before, "reads must never rewrite or normalize routing.yaml");
  } finally {
    await shim.stop();
  }
});
