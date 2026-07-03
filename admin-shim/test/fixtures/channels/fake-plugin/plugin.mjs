/**
 * File-driven fake channel adapter for channel-registry tests. No network.
 *
 * Observable protocol (all files live in the channel dir this plugin is
 * copied into, i.e. <homeDir>/.letta/channels/fake/):
 *   fake-events.jsonl — append-only journal: created / start-attempt /
 *                       started / inbound / lifecycle / stopped entries
 *   inbox.jsonl       — tests append one JSON message per line; each line
 *                       is parsed and passed to the host-filled onMessage
 *   outbox.jsonl      — sendMessage() payloads land here
 *
 * Config knobs (per-account `config`):
 *   crashOnStart: N       — throw from start() on the first N attempts
 *   reportDead: true      — isRunning() returns false (health-poll crash)
 *   poisonUncaught: true  — floating setTimeout throw after start()
 *                           (exercises the process-level trap; no host-side
 *                           await-wrapping can catch it)
 *   accessToken / tokenFallback — secret canaries; start() logs them via
 *                           host.log so tests can pin the scrubber
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const channelDir = dirname(fileURLToPath(import.meta.url));
const eventsPath = join(channelDir, "fake-events.jsonl");
const inboxPath = join(channelDir, "inbox.jsonl");
const outboxPath = join(channelDir, "outbox.jsonl");

function record(entry) {
  appendFileSync(eventsPath, JSON.stringify(entry) + "\n");
}

function countStartAttempts(accountId) {
  if (!existsSync(eventsPath)) return 0;
  let n = 0;
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.event === "start-attempt" && e.accountId === accountId) n += 1;
    } catch {}
  }
  return n;
}

class FakeAdapter {
  constructor(account, host) {
    this.channelId = "fake";
    this.accountId = account.accountId;
    this.id = `fake:${account.accountId}`;
    this.config = account.config ?? {};
    this.host = host;
    this.watcher = null;
    this.inboxOffset = 0;
    this.running = false;
    // Host fills this in after createAdapter.
    this.onMessage = undefined;
  }

  async start() {
    record({ event: "start-attempt", accountId: this.accountId });
    const crashOnStart = Number(this.config.crashOnStart ?? 0);
    const attempts = countStartAttempts(this.accountId);
    if (crashOnStart >= attempts) {
      throw new Error(`fake crash ${attempts}`);
    }
    // Secret canary through the host log — the scrubber must replace the
    // raw values with *** everywhere they could surface.
    if (this.config.accessToken) {
      this.host.log(
        `fake adapter starting; token=${this.config.accessToken} fallback=${this.config.tokenFallback ?? "(none)"}`,
      );
    }
    if (!existsSync(inboxPath)) writeFileSync(inboxPath, "");
    this.inboxOffset = statSync(inboxPath).size;
    this.watcher = watch(inboxPath, () => this.drainInbox());
    this.running = true;
    if (this.config.poisonUncaught) {
      // Floating throw the host cannot await-wrap: only the registry's
      // process-level uncaughtException trap can keep the shim alive.
      setTimeout(() => {
        throw new Error("poison");
      }, 100);
    }
    record({ event: "started", accountId: this.accountId });
  }

  drainInbox() {
    try {
      const size = statSync(inboxPath).size;
      if (size <= this.inboxOffset) return;
      const fd = openSync(inboxPath, "r");
      const buf = Buffer.alloc(size - this.inboxOffset);
      readSync(fd, buf, 0, buf.length, this.inboxOffset);
      closeSync(fd);
      this.inboxOffset = size;
      for (const line of buf.toString("utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let msg;
        try {
          msg = JSON.parse(t);
        } catch {
          continue;
        }
        record({ event: "inbound", accountId: this.accountId, chatId: msg.chatId ?? null });
        try {
          Promise.resolve(this.onMessage?.({ accountId: this.accountId, ...msg })).catch(() => {});
        } catch {}
      }
    } catch {}
  }

  async sendMessage(msg) {
    appendFileSync(outboxPath, JSON.stringify(msg) + "\n");
    return { messageId: `fake-out-${Date.now().toString(36)}` };
  }

  handleTurnLifecycleEvent(event) {
    record({
      event: "lifecycle",
      accountId: this.accountId,
      type: event?.type ?? null,
      chatId: event?.sources?.[0]?.chatId ?? null,
    });
  }

  isRunning() {
    return this.running && this.config.reportDead !== true;
  }

  async stop() {
    this.running = false;
    try {
      this.watcher?.close();
    } catch {}
    this.watcher = null;
    record({ event: "stopped", accountId: this.accountId });
  }
}

export const channelPlugin = {
  metadata: { id: "fake", displayName: "Fake" },
  createAdapter(account, host) {
    record({ event: "created", accountId: account.accountId });
    return new FakeAdapter(account, host);
  },
};
