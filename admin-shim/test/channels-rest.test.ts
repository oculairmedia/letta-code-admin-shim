/**
 * REST surface tests for /v1/channels (bead letta-mobile-6ahjp).
 *
 * Drives real shim subprocesses (standard harness) with the file-driven
 * fake plugin (test/fixtures/channels/fake-plugin/). Coverage per the
 * channel-host design §5, test/channels-rest.test.ts:
 *
 *   1. list/detail: fake + mobile listed; 404 unknown; 405 with Allow
 *   2. accounts CRUD + write-only secrets (sentinel in responses, raw
 *      value only on disk; PATCH preserves; null deletes; channel stamp)
 *   3. CLI file-shape compat: full route field set; unknown account
 *      fields survive mutations
 *   4. routes CRUD live: POST → immediate routing; PATCH enabled:false
 *      drops the next inbound; key-field PATCH → 400; DELETE by derived id
 *   5. adapter control: stop/start/restart; mobile → 409
 *   6. status fields: lastInboundAt/lastOutboundAt after a turn; scrubbed
 *      lastError after an induced crash
 *   7. account mutation reload: config PATCH restarts the adapter; a new
 *      enabled account brings a second adapter up
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { externalConvId, seedAgent, seedConversation, startShim } from "./helpers/index.js";
import type { ShimHandle } from "./helpers/shim.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_PLUGIN_DIR = join(__dirname, "fixtures", "channels", "fake-plugin");

const ACCESS_TOKEN_CANARY = "canary-rest-access-supersecret-1234";
const FALLBACK_TOKEN_CANARY = "canary-rest-fallback-supersecret-5678";
const SECRET_SENTINEL = { __secret_set: true };

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

function readAccountsOnDisk(shim: ShimHandle): Array<Record<string, unknown>> {
  const parsed = JSON.parse(readFileSync(channelPath(shim, "accounts.json"), "utf8")) as {
    accounts: Array<Record<string, unknown>>;
  };
  return parsed.accounts;
}

async function waitUntil(
  cond: () => boolean | Promise<boolean>,
  what: string,
  { timeoutMs = 20_000, everyMs = 100 }: { timeoutMs?: number; everyMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`waitUntil(${what}) timed out after ${timeoutMs}ms`);
}

async function getJson(shim: ShimHandle, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${shim.url}${path}`);
  return { status: res.status, body: await res.json() };
}

async function sendJson(
  shim: ShimHandle,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${shim.url}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}

async function adapterStatus(
  shim: ShimHandle,
  accountId: string,
): Promise<Record<string, unknown> | null> {
  const { status, body } = await getJson(shim, "/v1/channels/fake/status");
  if (status !== 200) return null;
  const adapters = body.adapters as Array<Record<string, unknown>>;
  return adapters.find((a) => a["accountId"] === accountId) ?? null;
}

// ── 1. list / detail / 405 ───────────────────────────────────────────

test("GET /v1/channels lists fake and mobile; unknown 404s; PUT 405s with Allow", async () => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()] }],
  });
  try {
    await shim.waitForLogLine(/\[channel-registry] started \(1 adapters\)/);

    const { status, body } = await getJson(shim, "/v1/channels");
    assert.equal(status, 200);
    const channels = body.channels as Array<Record<string, unknown>>;
    const fake = channels.find((c) => c["id"] === "fake");
    const mobile = channels.find((c) => c["id"] === "mobile");
    assert.ok(fake, "fake channel must be listed");
    assert.ok(mobile, "mobile channel must be listed");
    assert.equal(fake!["managed"], true);
    assert.equal(fake!["pluginPresent"], true);
    assert.equal(fake!["accounts"], 1);
    assert.equal(mobile!["managed"], false, "mobile is WS-host managed");
    assert.ok(Array.isArray(fake!["adapters"]), "channel element carries adapter statuses");

    const detail = await getJson(shim, "/v1/channels/fake");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.id, "fake");

    const missing = await getJson(shim, "/v1/channels/nope");
    assert.equal(missing.status, 404);
    assert.ok(typeof missing.body.detail === "string");

    const put = await sendJson(shim, "PUT", "/v1/channels");
    assert.equal(put.status, 405);
    assert.match(put.headers.get("allow") ?? "", /GET/, "405 must set Allow");
  } finally {
    await shim.stop();
  }
});

// ── 2. accounts CRUD — secrets write-only ────────────────────────────

test("accounts CRUD keeps secrets write-only and preserves them across PATCH", async () => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()] }],
  });
  try {
    await shim.waitForLogLine(/fake:main starting -> running/);

    // POST: raw secret goes in, sentinel comes back.
    const created = await sendJson(shim, "POST", "/v1/channels/fake/accounts", {
      accountId: "rest",
      displayName: "Rest Account",
      enabled: false,
      dmPolicy: "closed",
      my_snake_extra: "keep-me",
      config: { accessToken: ACCESS_TOKEN_CANARY, homeserverUrl: "https://example.org" },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.config.accessToken, SECRET_SENTINEL);
    assert.equal(created.body.config.homeserverUrl, "https://example.org");
    assert.equal(created.body.channel, "fake", "store must stamp channel on create");
    assert.ok(
      !JSON.stringify(created.body).includes(ACCESS_TOKEN_CANARY),
      "raw secret must never be serialized in the create response",
    );

    // On disk: channel stamp present, raw value stored (write-only, not lost).
    let onDisk = readAccountsOnDisk(shim).find((a) => a["accountId"] === "rest");
    assert.ok(onDisk, "account must be persisted");
    assert.equal(onDisk!["channel"], "fake");
    assert.equal((onDisk!["config"] as Record<string, unknown>)["accessToken"], ACCESS_TOKEN_CANARY);

    // GET list + detail: same redaction.
    const list = await getJson(shim, "/v1/channels/fake/accounts");
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes(ACCESS_TOKEN_CANARY), "GET list must be redacted");
    assert.ok(!JSON.stringify(list.body).includes(FALLBACK_TOKEN_CANARY), "tokenFallback must be redacted too");
    const detail = await getJson(shim, "/v1/channels/fake/accounts/rest");
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.config.accessToken, SECRET_SENTINEL);

    // PATCH displayName only: stored secret must survive untouched.
    const patched = await sendJson(shim, "PATCH", "/v1/channels/fake/accounts/rest", {
      displayName: "Rest Account v2",
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.displayName, "Rest Account v2");
    assert.deepEqual(patched.body.config.accessToken, SECRET_SENTINEL);
    onDisk = readAccountsOnDisk(shim).find((a) => a["accountId"] === "rest");
    assert.equal(
      (onDisk!["config"] as Record<string, unknown>)["accessToken"],
      ACCESS_TOKEN_CANARY,
      "PATCH without config must preserve the stored secret",
    );
    assert.equal(onDisk!["my_snake_extra"], "keep-me", "unknown fields must survive PATCH");
    assert.equal(onDisk!["dmPolicy"], "closed");

    // PATCH round-tripping the sentinel also preserves the secret.
    const sentinelPatch = await sendJson(shim, "PATCH", "/v1/channels/fake/accounts/rest", {
      config: { accessToken: SECRET_SENTINEL, homeserverUrl: "https://new.example" },
    });
    assert.equal(sentinelPatch.status, 200);
    onDisk = readAccountsOnDisk(shim).find((a) => a["accountId"] === "rest");
    assert.equal((onDisk!["config"] as Record<string, unknown>)["accessToken"], ACCESS_TOKEN_CANARY);
    assert.equal((onDisk!["config"] as Record<string, unknown>)["homeserverUrl"], "https://new.example");

    // PATCH config.accessToken: null deletes the secret from disk.
    const nulled = await sendJson(shim, "PATCH", "/v1/channels/fake/accounts/rest", {
      config: { accessToken: null },
    });
    assert.equal(nulled.status, 200);
    onDisk = readAccountsOnDisk(shim).find((a) => a["accountId"] === "rest");
    assert.ok(
      !("accessToken" in (onDisk!["config"] as Record<string, unknown>)),
      "explicit null must remove the secret",
    );

    // Duplicate POST → 409.
    const dup = await sendJson(shim, "POST", "/v1/channels/fake/accounts", { accountId: "rest" });
    assert.equal(dup.status, 409);

    // Missing accountId → 400.
    const missingId = await sendJson(shim, "POST", "/v1/channels/fake/accounts", { displayName: "x" });
    assert.equal(missingId.status, 400);
    assert.equal(missingId.body.detail, "accountId is required");

    // DELETE → { deleted: true }; subsequent GET → 404.
    const del = await sendJson(shim, "DELETE", "/v1/channels/fake/accounts/rest");
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);
    assert.equal(del.body.accountId, "rest");
    const gone = await getJson(shim, "/v1/channels/fake/accounts/rest");
    assert.equal(gone.status, 404);

    // The shim log must never carry either canary.
    const log = shim.readLog();
    assert.ok(!log.includes(ACCESS_TOKEN_CANARY), "accessToken canary leaked into shim log");
    assert.ok(!log.includes(FALLBACK_TOKEN_CANARY), "tokenFallback canary leaked into shim log");
  } finally {
    await shim.stop();
  }
});

// ── 3+4. routes CRUD — CLI file shape + live routing ─────────────────

test("routes CRUD writes the CLI file shape and routes live without a restart", async () => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()], routes: [] }],
  });
  try {
    await shim.waitForLogLine(/fake:main starting -> running/);
    const agentId = seedAgent(shim.stateDir, { id: `agent-chanrest-${Date.now()}` });
    seedConversation(shim.stateDir, agentId);
    const convId = externalConvId(agentId);

    // Missing required field → 400 naming it.
    const bad = await sendJson(shim, "POST", "/v1/channels/fake/routes", {
      accountId: "main",
      chatId: "room1",
      agentId,
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.detail, "conversationId is required");

    const created = await sendJson(shim, "POST", "/v1/channels/fake/routes", {
      accountId: "main",
      chatId: "room1",
      agentId,
      conversationId: convId,
    });
    assert.equal(created.status, 201);
    const routeId = created.body.id as string;
    assert.ok(routeId.length > 0, "route id must be derived and returned");

    // CLI file-shape compat: routing.yaml parses as JSON with the full
    // CLI field set (and never the derived id — it is not persisted).
    const routingRaw = readFileSync(channelPath(shim, "routing.yaml"), "utf8");
    const routing = JSON.parse(routingRaw) as { routes: Array<Record<string, unknown>> };
    assert.equal(routing.routes.length, 1);
    assert.deepEqual(
      Object.keys(routing.routes[0]!).sort(),
      [
        "accountId", "agentId", "chatId", "chatType", "conversationId",
        "createdAt", "enabled", "outboundEnabled", "threadId", "updatedAt",
      ],
      "persisted route must carry exactly the CLI field set",
    );
    assert.equal(routing.routes[0]!["threadId"], null);

    // Duplicate key → 409.
    const dup = await sendJson(shim, "POST", "/v1/channels/fake/routes", {
      accountId: "main",
      chatId: "room1",
      agentId,
      conversationId: convId,
    });
    assert.equal(dup.status, 409);

    // Live immediately: no adapter restart between POST and inbound.
    appendInbox(shim, { chatId: "room1", text: "hello rest routes", messageId: "m-1" });
    await waitUntil(() => readOutbox(shim).length > 0, "outbox reply after route POST");
    assert.equal(readOutbox(shim)[0]!["chatId"], "room1");

    // GET list carries the derived id.
    const list = await getJson(shim, "/v1/channels/fake/routes");
    assert.equal(list.status, 200);
    assert.equal(list.body.routes[0].id, routeId);

    // PATCH enabled:false → the next inbound is dropped (resolveRoute
    // reads fresh per message).
    const disabled = await sendJson(shim, "PATCH", `/v1/channels/fake/routes/${routeId}`, {
      enabled: false,
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.enabled, false);
    appendInbox(shim, { chatId: "room1", text: "should be dropped", messageId: "m-2" });
    await shim.waitForLogLine(/\[channel-registry] unrouted inbound fake:room1/, { timeoutMs: 10_000 });
    assert.equal(readOutbox(shim).length, 1, "disabled route must not produce a reply");

    // PATCH attempting a key-field change → 400.
    const keyPatch = await sendJson(shim, "PATCH", `/v1/channels/fake/routes/${routeId}`, {
      chatId: "other-room",
    });
    assert.equal(keyPatch.status, 400);
    assert.equal(keyPatch.body.detail, "cannot change route key fields; delete and recreate");

    // DELETE by derived id; re-DELETE → 404.
    const del = await sendJson(shim, "DELETE", `/v1/channels/fake/routes/${routeId}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { deleted: true, id: routeId });
    const again = await sendJson(shim, "DELETE", `/v1/channels/fake/routes/${routeId}`);
    assert.equal(again.status, 404);
  } finally {
    await shim.stop();
  }
});

// ── 5+6. adapter control + status fields ─────────────────────────────

test("adapter control stops/starts/restarts; status carries turn timestamps; mobile 409s", async (t) => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()] }],
  });
  t.after(() => shim.stop());
  await shim.waitForLogLine(/fake:main starting -> running/);

  const agentId = seedAgent(shim.stateDir, { id: `agent-chanctl-${Date.now()}` });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);
  await sendJson(shim, "POST", "/v1/channels/fake/routes", {
    accountId: "main",
    chatId: "ctlroom",
    agentId,
    conversationId: convId,
  });

  // One full turn, then the status mirror must show it.
  appendInbox(shim, { chatId: "ctlroom", text: "control turn", messageId: "m-ctl" });
  await waitUntil(() => readOutbox(shim).length > 0, "control-turn outbox reply");
  await waitUntil(async () => {
    const st = await adapterStatus(shim, "main");
    return !!st && st["lastInboundAt"] !== null && st["lastOutboundAt"] !== null;
  }, "status lastInboundAt/lastOutboundAt");
  const running = await adapterStatus(shim, "main");
  assert.equal(running!["state"], "running");
  assert.ok(Array.isArray(running!["recentLog"]), "status exposes the recent adapter log ring");

  // Stop: state stopped, and a subsequent inbox append produces nothing.
  const stopped = await sendJson(shim, "POST", "/v1/channels/fake/adapters/main/stop");
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.state, "stopped");
  assert.ok(readEvents(shim).some((e) => e["event"] === "stopped" && e["accountId"] === "main"));
  const outboxBefore = readOutbox(shim).length;
  appendInbox(shim, { chatId: "ctlroom", text: "into the void", messageId: "m-void" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(readOutbox(shim).length, outboxBefore, "stopped adapter must not bridge turns");

  // Start: running again (start is a no-op if already running).
  const started = await sendJson(shim, "POST", "/v1/channels/fake/adapters/main/start");
  assert.equal(started.status, 200);
  assert.equal(started.body.state, "running");

  // Restart: the journal shows another stopped + created pair.
  const createdBefore = readEvents(shim).filter((e) => e["event"] === "created").length;
  const restarted = await sendJson(shim, "POST", "/v1/channels/fake/adapters/main/restart");
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.state, "running");
  const events = readEvents(shim);
  assert.ok(
    events.filter((e) => e["event"] === "created").length > createdBefore,
    "restart must construct a new adapter instance",
  );

  // Mobile carve-out: stop/restart are WS-host territory.
  const mobileStop = await sendJson(shim, "POST", "/v1/channels/mobile/adapters/default/stop");
  assert.equal(mobileStop.status, 409);
  assert.equal(mobileStop.body.detail, "mobile adapter is managed by the WS host");

  // Unknown adapter → 404.
  const unknown = await sendJson(shim, "POST", "/v1/channels/fake/adapters/nope/start");
  assert.equal(unknown.status, 404);
});

// ── agent-initiated outbound send ────────────────────────────────────

test("POST /v1/channels/{id}/accounts/{id}/messages sends outbound through the adapter", async (t) => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()] }],
  });
  t.after(() => shim.stop());
  await shim.waitForLogLine(/fake:main starting -> running/);

  // 400s: missing chatId, missing text, empty text.
  const noChat = await sendJson(shim, "POST", "/v1/channels/fake/accounts/main/messages", {
    text: "hi",
  });
  assert.equal(noChat.status, 400);
  assert.equal(noChat.body.detail, "chatId is required");
  const noText = await sendJson(shim, "POST", "/v1/channels/fake/accounts/main/messages", {
    chatId: "outroom",
  });
  assert.equal(noText.status, 400);
  assert.equal(noText.body.detail, "text is required (non-empty string)");
  const emptyText = await sendJson(shim, "POST", "/v1/channels/fake/accounts/main/messages", {
    chatId: "outroom",
    text: "",
  });
  assert.equal(emptyText.status, 400);
  assert.equal(readOutbox(shim).length, 0, "rejected sends must not reach the adapter");

  // Happy path: adapter captures chatId/text/threadId (+ markdown passthrough).
  const before = await adapterStatus(shim, "main");
  assert.equal(before!["lastOutboundAt"], null);
  const sent = await sendJson(shim, "POST", "/v1/channels/fake/accounts/main/messages", {
    chatId: "outroom",
    text: "agent says hello",
    threadId: "thread-7",
    markdown: true,
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.ok, true);
  assert.ok(typeof sent.body.sentAt === "string" && sent.body.sentAt.length > 0);
  const outbox = readOutbox(shim);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!["chatId"], "outroom");
  assert.equal(outbox[0]!["text"], "agent says hello");
  assert.equal(outbox[0]!["threadId"], "thread-7", "threadId must pass through to sendMessage");
  assert.equal(outbox[0]!["markdown"], true, "markdown flag must pass through to sendMessage");
  const after = await adapterStatus(shim, "main");
  assert.equal(after!["lastOutboundAt"], sent.body.sentAt, "send must update lastOutboundAt");

  // threadId omitted ⇒ adapter sees null (same shape as the inbound reply path).
  const rootSend = await sendJson(shim, "POST", "/v1/channels/fake/accounts/main/messages", {
    chatId: "outroom",
    text: "root-level message",
  });
  assert.equal(rootSend.status, 200);
  assert.equal(readOutbox(shim)[1]!["threadId"], null);

  // 404s: unknown account, unknown channel.
  const unknownAccount = await sendJson(shim, "POST", "/v1/channels/fake/accounts/nope/messages", {
    chatId: "outroom",
    text: "hi",
  });
  assert.equal(unknownAccount.status, 404);
  assert.ok(typeof unknownAccount.body.detail === "string");
  const unknownChannel = await sendJson(shim, "POST", "/v1/channels/nope/accounts/main/messages", {
    chatId: "outroom",
    text: "hi",
  });
  assert.equal(unknownChannel.status, 404);

  // 405 with Allow on wrong method.
  const wrongMethod = await sendJson(shim, "GET", "/v1/channels/fake/accounts/main/messages");
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.get("allow") ?? "", /POST/, "405 must set Allow");

  // 409 once the adapter is stopped; no outbox entry is produced.
  const stopped = await sendJson(shim, "POST", "/v1/channels/fake/adapters/main/stop");
  assert.equal(stopped.status, 200);
  const outboxBefore = readOutbox(shim).length;
  const whileStopped = await sendJson(shim, "POST", "/v1/channels/fake/accounts/main/messages", {
    chatId: "outroom",
    text: "into the void",
  });
  assert.equal(whileStopped.status, 409);
  assert.match(whileStopped.body.detail, /stopped/);
  assert.equal(readOutbox(shim).length, outboxBefore, "stopped adapter must not send");
});

// ── 7. account mutation reload + scrubbed crash error ────────────────

test("account mutations hot-reload adapters and crash errors are scrubbed", async (t) => {
  const shim = await startShim({
    channels: [{ id: "fake", pluginDir: FAKE_PLUGIN_DIR, accounts: [fakeAccount()] }],
  });
  t.after(() => shim.stop());
  await shim.waitForLogLine(/fake:main starting -> running/);

  // PATCH the running account's config → the registry restarts it.
  const createdBefore = readEvents(shim).filter(
    (e) => e["event"] === "created" && e["accountId"] === "main",
  ).length;
  const patched = await sendJson(shim, "PATCH", "/v1/channels/fake/accounts/main", {
    config: { someFlag: "on" },
  });
  assert.equal(patched.status, 200);
  await waitUntil(() => {
    const events = readEvents(shim);
    return (
      events.some((e) => e["event"] === "stopped" && e["accountId"] === "main") &&
      events.filter((e) => e["event"] === "created" && e["accountId"] === "main").length >
        createdBefore
    );
  }, "config PATCH must stop + re-create the adapter");
  await waitUntil(async () => {
    const st = await adapterStatus(shim, "main");
    return !!st && st["state"] === "running";
  }, "main adapter running again after reload");
  // Config merge preserved the stored secret and unknown fields.
  const mainOnDisk = readAccountsOnDisk(shim).find((a) => a["accountId"] === "main");
  assert.equal((mainOnDisk!["config"] as Record<string, unknown>)["accessToken"], ACCESS_TOKEN_CANARY);
  assert.equal((mainOnDisk!["config"] as Record<string, unknown>)["someFlag"], "on");
  assert.equal(mainOnDisk!["legacy_snake_field"], "must-survive");

  // POST a second enabled account → a second adapter appears in status.
  const second = await sendJson(shim, "POST", "/v1/channels/fake/accounts", {
    accountId: "second",
    enabled: true,
    config: {},
  });
  assert.equal(second.status, 201);
  await waitUntil(async () => {
    const st = await adapterStatus(shim, "second");
    return !!st && st["state"] === "running";
  }, "second adapter running after account POST");

  // A crashy account surfaces a scrubbed lastError in status.
  const crashy = await sendJson(shim, "POST", "/v1/channels/fake/accounts", {
    accountId: "crashy",
    enabled: true,
    config: { crashOnStart: 99, accessToken: ACCESS_TOKEN_CANARY },
  });
  assert.equal(crashy.status, 201);
  await waitUntil(async () => {
    const st = await adapterStatus(shim, "crashy");
    return !!st && typeof st["lastError"] === "string" && (st["lastError"] as string).length > 0;
  }, "crashy adapter lastError");
  const crashyStatus = await adapterStatus(shim, "crashy");
  assert.match(crashyStatus!["lastError"] as string, /start failed/);
  assert.ok(["crashed", "backoff", "starting"].includes(crashyStatus!["state"] as string));
  const statusJson = JSON.stringify(await getJson(shim, "/v1/channels/fake/status"));
  assert.ok(!statusJson.includes(ACCESS_TOKEN_CANARY), "status must never leak the secret canary");
});
