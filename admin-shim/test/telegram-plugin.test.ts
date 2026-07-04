/**
 * Unit/behavioral tests for the Telegram channel plugin
 * (home/.letta/channels/telegram/), the second reference plugin for the
 * generic channel host (bead letta-mobile-aq0hp).
 *
 * These drive the plugin directly against a local HTTP stub for the Bot API
 * (no real Telegram, no shim subprocess) — the same "fake transport, real
 * plugin" shape the channel-registry tests get from the fake-plugin fixture,
 * but scoped to the plugin's own logic:
 *
 *   - getUpdates offset resume + persistence
 *   - update_id dedupe
 *   - allowedChats enforcement
 *   - self-echo filter (from.id == me.id)
 *   - bootstrap-backlog drop on a fresh install
 *   - MarkdownV2 escaping / conversion
 *   - sendMessage payload shape (parse_mode, message_thread_id, reply_parameters)
 *
 * All plugin state files are isolated under a per-run LETTA_HOME with a unique
 * accountId per test, so tests never collide on disk.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TELEGRAM_DIR = join(__dirname, "..", "..", "home", ".letta", "channels", "telegram");
const PLUGIN_URL = pathToFileURL(join(TELEGRAM_DIR, "plugin.mjs")).href;
const MARKDOWN_URL = pathToFileURL(join(TELEGRAM_DIR, "lib", "markdown.mjs")).href;

// Single shared LETTA_HOME for every test; per-test unique accountIds keep
// state files (`channels/telegram/state/<accountId>.json`) from colliding.
const LETTA_HOME = mkdtempSync(join(tmpdir(), "telegram-plugin-"));
process.env["LETTA_HOME"] = LETTA_HOME;
const STATE_DIR = join(LETTA_HOME, "channels", "telegram", "state");
mkdirSync(STATE_DIR, { recursive: true });

const BOT_TOKEN = "123456:canary-bot-token-supersecret";
const SELF_ID = 4242;

// ── Bot API stub ──────────────────────────────────────────────────────

interface SendMessageCall {
  chat_id: unknown;
  text: string;
  parse_mode?: string;
  message_thread_id?: number;
  reply_parameters?: { message_id: number };
}

class BotApiStub {
  server: Server | null = null;
  baseUrl = "";
  me = { id: SELF_ID, is_bot: true, username: "lettabot", first_name: "Letta" };
  // FIFO of update batches served by getUpdates; empty ⇒ respond [].
  private batches: unknown[][] = [];
  getUpdatesOffsets: Array<number | undefined> = [];
  sendMessageCalls: SendMessageCall[] = [];
  chatActionCalls: Array<Record<string, unknown>> = [];
  private nextMessageId = 1000;

  queue(...updates: unknown[]): void {
    this.batches.push(updates);
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server!.address();
    if (addr && typeof addr === "object") this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private json(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const method = url.split("/").pop() ?? "";
    const body = await this.readBody(req);
    if (method === "getMe") {
      this.json(res, { ok: true, result: this.me });
      return;
    }
    if (method === "getUpdates") {
      this.getUpdatesOffsets.push(body["offset"] as number | undefined);
      const batch = this.batches.shift();
      if (batch && batch.length) {
        this.json(res, { ok: true, result: batch });
      } else {
        // Slow the empty long-poll so the plugin's loop doesn't hot-spin.
        setTimeout(() => this.json(res, { ok: true, result: [] }), 20);
      }
      return;
    }
    if (method === "sendMessage") {
      this.sendMessageCalls.push(body as unknown as SendMessageCall);
      this.json(res, { ok: true, result: { message_id: this.nextMessageId++ } });
      return;
    }
    if (method === "sendChatAction") {
      this.chatActionCalls.push(body);
      this.json(res, { ok: true, result: true });
      return;
    }
    this.json(res, { ok: false, error_code: 404, description: `unknown method ${method}` });
  }

  async close(): Promise<void> {
    if (this.server) {
      // fetch keeps sockets alive; without this close() blocks ~5s on the
      // idle keep-alive timeout before the callback fires.
      this.server.closeAllConnections?.();
      await new Promise<void>((r) => this.server!.close(() => r()));
    }
    this.server = null;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function tgMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 555,
    from: { id: 900, is_bot: false, first_name: "Alice", username: "alice" },
    chat: { id: 111, type: "private" },
    date: nowSec(),
    text: "hello",
    ...over,
  };
}

function tgUpdate(updateId: number, message: Record<string, unknown>): Record<string, unknown> {
  return { update_id: updateId, message };
}

function seedOffset(accountId: string, offset: number): void {
  writeFileSync(
    join(STATE_DIR, `${accountId}.json`),
    JSON.stringify({ offset, updatedAt: new Date().toISOString() }),
  );
}

function readOffset(accountId: string): number | undefined {
  const p = join(STATE_DIR, `${accountId}.json`);
  if (!existsSync(p)) return undefined;
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  return typeof parsed.offset === "number" ? parsed.offset : undefined;
}

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`waitUntil(${what}) timed out after ${timeoutMs}ms`);
}

interface PluginModule {
  channelPlugin: {
    createAdapter: (account: unknown, host: unknown) => Promise<Adapter>;
  };
}
interface Adapter {
  id?: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  sendMessage: (msg: Record<string, unknown>) => Promise<{ messageId: string }>;
  onMessage?: (inbound: unknown) => void | Promise<void>;
}

async function makeAdapter(
  stub: BotApiStub,
  accountId: string,
  config: Record<string, unknown> = {},
): Promise<{ adapter: Adapter; inbound: Array<Record<string, unknown>> }> {
  const mod = (await import(PLUGIN_URL)) as unknown as PluginModule;
  const account = {
    channel: "telegram",
    accountId,
    displayName: `tg ${accountId}`,
    enabled: true,
    config: { botToken: BOT_TOKEN, apiBaseUrl: stub.baseUrl, pollTimeoutSec: 1, ...config },
  };
  const adapter = await mod.channelPlugin.createAdapter(account, { log: () => {} });
  const inbound: Array<Record<string, unknown>> = [];
  adapter.onMessage = (m) => {
    inbound.push(m as Record<string, unknown>);
  };
  return { adapter, inbound };
}

// ── 1. MarkdownV2 escaping (pure) ────────────────────────────────────────

test("escapeMarkdownV2 escapes every reserved character", async () => {
  const { escapeMarkdownV2, markdownToMarkdownV2 } = (await import(MARKDOWN_URL)) as unknown as {
    escapeMarkdownV2: (s: string) => string;
    markdownToMarkdownV2: (s: string) => string;
  };
  assert.equal(escapeMarkdownV2("a_b*c.d!"), "a\\_b\\*c\\.d\\!");
  assert.equal(escapeMarkdownV2("(x) [y] {z} | # + - = > ~ `"),
    "\\(x\\) \\[y\\] \\{z\\} \\| \\# \\+ \\- \\= \\> \\~ \\`");
  // Converter: bold/italic markers map to MarkdownV2, literals get escaped.
  assert.equal(markdownToMarkdownV2("Hi **bold** and *em*. Done."),
    "Hi *bold* and _em_\\. Done\\.");
  // A link keeps its target unescaped; the label + surrounding prose escape.
  assert.equal(markdownToMarkdownV2("see [docs](https://a.co/x) now!"),
    "see [docs](https://a.co/x) now\\!");
  // Inline code content is left verbatim inside backticks.
  assert.equal(markdownToMarkdownV2("run `a.b()` please"), "run `a.b()` please");
});

// ── 2. sendMessage payload shape ─────────────────────────────────────────

test("sendMessage maps chatId/text/threadId/markdown/reply to Bot API params", async (t) => {
  const stub = new BotApiStub();
  await stub.listen();
  t.after(() => stub.close());
  const { adapter } = await makeAdapter(stub, "send-shape");
  await adapter.start();
  t.after(() => adapter.stop());

  // markdown:true ⇒ MarkdownV2 + escaped text; threadId ⇒ integer
  // message_thread_id; replyToMessageId ⇒ reply_parameters.
  const res = await adapter.sendMessage({
    chatId: "111",
    text: "Ping. 1+1=2",
    markdown: true,
    threadId: "77",
    replyToMessageId: "42",
  });
  assert.ok(res.messageId, "sendMessage returns a message id");
  await waitUntil(() => stub.sendMessageCalls.length > 0, "sendMessage recorded");
  const call = stub.sendMessageCalls[0]!;
  assert.equal(call.chat_id, "111");
  assert.equal(call.parse_mode, "MarkdownV2");
  assert.equal(call.text, "Ping\\. 1\\+1\\=2");
  assert.equal(call.message_thread_id, 77);
  assert.equal(typeof call.message_thread_id, "number");
  assert.deepEqual(call.reply_parameters, { message_id: 42, allow_sending_without_reply: true });

  // Plain (no markdown) ⇒ no parse_mode, raw text.
  await adapter.sendMessage({ chatId: "111", text: "raw. text!" });
  await waitUntil(() => stub.sendMessageCalls.length > 1, "second send recorded");
  const plain = stub.sendMessageCalls[1]!;
  assert.equal(plain.parse_mode, undefined);
  assert.equal(plain.text, "raw. text!");
});

// ── 3. offset resume + persistence ───────────────────────────────────────

test("getUpdates resumes from the persisted offset and advances it", async (t) => {
  const stub = new BotApiStub();
  await stub.listen();
  t.after(() => stub.close());
  const acct = "offset-resume";
  seedOffset(acct, 500); // pre-existing offset file ⇒ not a fresh install
  const { adapter, inbound } = await makeAdapter(stub, acct);
  await adapter.start();
  t.after(() => adapter.stop());

  await waitUntil(() => stub.getUpdatesOffsets.length > 0, "first getUpdates");
  assert.equal(stub.getUpdatesOffsets[0], 500, "first poll must carry the resumed offset");

  stub.queue(tgUpdate(600, tgMessage({ text: "after resume" })));
  await waitUntil(() => inbound.length > 0, "message dispatched");
  assert.equal(inbound[0]!["text"], "after resume");
  assert.equal(inbound[0]!["chatId"], "111");

  // Offset advanced to update_id + 1 and persisted to the state file.
  await waitUntil(() => readOffset(acct) === 601, "offset persisted as 601");
});

// ── 4. dedupe by update_id ───────────────────────────────────────────────

test("a repeated update_id is dispatched only once", async (t) => {
  const stub = new BotApiStub();
  await stub.listen();
  t.after(() => stub.close());
  const acct = "dedupe";
  seedOffset(acct, 0);
  const { adapter, inbound } = await makeAdapter(stub, acct);
  await adapter.start();
  t.after(() => adapter.stop());

  stub.queue(tgUpdate(10, tgMessage({ message_id: 1, text: "once" })));
  await waitUntil(() => inbound.length === 1, "first dispatch");
  // Same update_id served again (e.g. a getUpdates retry): must be dropped.
  stub.queue(tgUpdate(10, tgMessage({ message_id: 1, text: "once" })));
  stub.queue(tgUpdate(11, tgMessage({ message_id: 2, text: "twice" })));
  await waitUntil(() => inbound.some((m) => m["text"] === "twice"), "second unique dispatch");
  assert.equal(inbound.filter((m) => m["text"] === "once").length, 1, "duplicate must not re-dispatch");
});

// ── 5. allowedChats enforcement ──────────────────────────────────────────

test("allowedChats drops messages from chats not on the list", async (t) => {
  const stub = new BotApiStub();
  await stub.listen();
  t.after(() => stub.close());
  const acct = "allowlist";
  seedOffset(acct, 0);
  const { adapter, inbound } = await makeAdapter(stub, acct, { allowedChats: [111, "@okgroup"] });
  await adapter.start();
  t.after(() => adapter.stop());

  // Disallowed chat 999 → dropped.
  stub.queue(tgUpdate(1, tgMessage({ chat: { id: 999, type: "private" }, text: "blocked" })));
  // Allowed by numeric id.
  stub.queue(tgUpdate(2, tgMessage({ chat: { id: 111, type: "private" }, text: "by-id" })));
  // Allowed by @username.
  stub.queue(tgUpdate(3, tgMessage({ chat: { id: 222, type: "supergroup", username: "okgroup" }, text: "by-name" })));

  await waitUntil(() => inbound.length === 2, "two allowed messages dispatched");
  const texts = inbound.map((m) => m["text"]).sort();
  assert.deepEqual(texts, ["by-id", "by-name"]);
  assert.ok(!inbound.some((m) => m["text"] === "blocked"), "disallowed chat must be dropped");
});

// ── 6. self-echo filter ──────────────────────────────────────────────────

test("messages from the bot itself are filtered", async (t) => {
  const stub = new BotApiStub();
  await stub.listen();
  t.after(() => stub.close());
  const acct = "echo";
  seedOffset(acct, 0);
  const { adapter, inbound } = await makeAdapter(stub, acct);
  await adapter.start();
  t.after(() => adapter.stop());

  // from.id === me.id (SELF_ID) → dropped as our own echo.
  stub.queue(tgUpdate(1, tgMessage({ from: { id: SELF_ID, is_bot: true, username: "lettabot" }, text: "my own echo" })));
  stub.queue(tgUpdate(2, tgMessage({ from: { id: 900, is_bot: false }, text: "real user" })));

  await waitUntil(() => inbound.length === 1, "one non-echo message dispatched");
  assert.equal(inbound[0]!["text"], "real user");
  assert.ok(!inbound.some((m) => m["text"] === "my own echo"), "self-echo must be dropped");
});

// ── 7. bootstrap-backlog drop ────────────────────────────────────────────

test("a fresh install drops backlog older than process start", async (t) => {
  const stub = new BotApiStub();
  await stub.listen();
  t.after(() => stub.close());
  // No seedOffset ⇒ fresh install ⇒ initialBootstrap true.
  const acct = "bootstrap";
  const { adapter, inbound } = await makeAdapter(stub, acct);
  await adapter.start();
  t.after(() => adapter.stop());

  const old = nowSec() - 3600; // an hour before start
  stub.queue(
    tgUpdate(1, tgMessage({ date: old, text: "stale backlog" })),
    tgUpdate(2, tgMessage({ date: nowSec() + 1, text: "fresh message" })),
  );

  await waitUntil(() => inbound.some((m) => m["text"] === "fresh message"), "fresh message dispatched");
  // Give the loop a beat to prove the stale one is NOT delivered.
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!inbound.some((m) => m["text"] === "stale backlog"), "pre-start backlog must be dropped");
  assert.equal(inbound.length, 1, "only the fresh message survives");
});
