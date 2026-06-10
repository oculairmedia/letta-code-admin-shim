/**
 * lcp-2oxb.4: suffix-parse cache + JSONL timestamp sidecar tests.
 *
 * Pinned contracts:
 *   - listMessages reflects appended lines without losing earlier ones
 *     (probe-verified suffix read).
 *   - A full rewrite of messages.jsonl — even one that GROWS the file —
 *     is detected via the tail probe and triggers a full re-parse.
 *   - A shrink triggers a full re-parse.
 *   - invalidateMessagesCache() drops the entry outright.
 *   - stampNewMessages appends to _real-times.jsonl (O(new) per turn),
 *     migrates a legacy _real-times.json on first write, is idempotent,
 *     and readMessageTimestamps tolerates partial trailing lines and
 *     compacts duplicate-heavy files.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _internals,
  invalidateMessagesCache,
  listMessages,
  readMessageTimestamps,
  stampNewMessages,
} from "../lib/store.js";

const AGENT = "agent-sfx";

function msgLine(id: string, text: string): string {
  return JSON.stringify({
    id,
    role: "user",
    parts: [{ type: "text", text }],
  }) + "\n";
}

async function withBackendDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "store-sfx-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolve the conversation dir the same way store.ts does. */
function convDir(dir: string, conversationId: string): string {
  const key = conversationId === "default"
    ? `default:${AGENT}`
    : `conversation:${conversationId}`;
  return join(dir, "conversations", _internals.b64url(key));
}

function seedConv(dir: string, conversationId: string, lines: string[]): string {
  const cdir = convDir(dir, conversationId);
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, "messages.jsonl"), lines.join(""));
  return cdir;
}

test("suffix append: new lines are folded in without losing the prefix", async () => {
  await withBackendDir(async (dir) => {
    const conv = "conv-sfx-append";
    const cdir = seedConv(dir, conv, [msgLine("m1", "a"), msgLine("m2", "b")]);
    const first = await listMessages(conv, AGENT);
    assert.deepEqual(first.map((m) => m.id), ["m1", "m2"]);

    appendFileSync(join(cdir, "messages.jsonl"), msgLine("m3", "c") + msgLine("m4", "d"));
    const second = await listMessages(conv, AGENT);
    assert.deepEqual(second.map((m) => m.id), ["m1", "m2", "m3", "m4"]);

    // And again — repeated incremental extensions stay consistent.
    appendFileSync(join(cdir, "messages.jsonl"), msgLine("m5", "e"));
    const third = await listMessages(conv, AGENT);
    assert.deepEqual(third.map((m) => m.id), ["m1", "m2", "m3", "m4", "m5"]);
  });
});

test("rewrite detection: larger rewritten file fails the probe and re-parses fully", async () => {
  await withBackendDir(async (dir) => {
    const conv = "conv-sfx-rewrite";
    const cdir = seedConv(dir, conv, [msgLine("old1", "x"), msgLine("old2", "y")]);
    const first = await listMessages(conv, AGENT);
    assert.deepEqual(first.map((m) => m.id), ["old1", "old2"]);

    // Rewrite with entirely different content that is LARGER than before —
    // the size check alone cannot catch this; the tail probe must.
    const rewritten = [
      msgLine("new1", "completely different and much longer content 1"),
      msgLine("new2", "completely different and much longer content 2"),
      msgLine("new3", "completely different and much longer content 3"),
    ];
    writeFileSync(join(cdir, "messages.jsonl"), rewritten.join(""));
    const second = await listMessages(conv, AGENT);
    assert.deepEqual(second.map((m) => m.id), ["new1", "new2", "new3"]);
  });
});

test("shrink triggers a clean full re-parse", async () => {
  await withBackendDir(async (dir) => {
    const conv = "conv-sfx-shrink";
    const cdir = seedConv(dir, conv, [msgLine("m1", "a"), msgLine("m2", "b"), msgLine("m3", "c")]);
    assert.equal((await listMessages(conv, AGENT)).length, 3);
    writeFileSync(join(cdir, "messages.jsonl"), msgLine("only", "z"));
    assert.deepEqual((await listMessages(conv, AGENT)).map((m) => m.id), ["only"]);
  });
});

test("unterminated trailing line is included once and never duplicated", async () => {
  await withBackendDir(async (dir) => {
    const conv = "conv-sfx-tail";
    const cdir = seedConv(dir, conv, [msgLine("m1", "a")]);
    // Append a complete JSON line WITHOUT the trailing newline.
    appendFileSync(join(cdir, "messages.jsonl"), msgLine("m2", "b").trimEnd());
    const first = await listMessages(conv, AGENT);
    assert.deepEqual(first.map((m) => m.id), ["m1", "m2"]);

    // Now terminate it and append another — m2 must not double up.
    appendFileSync(join(cdir, "messages.jsonl"), "\n" + msgLine("m3", "c"));
    const second = await listMessages(conv, AGENT);
    assert.deepEqual(second.map((m) => m.id), ["m1", "m2", "m3"]);
  });
});

test("invalidateMessagesCache forces the next read to hit disk", async () => {
  await withBackendDir(async (dir) => {
    const conv = "conv-sfx-inval";
    const cdir = seedConv(dir, conv, [msgLine("m1", "a")]);
    assert.equal((await listMessages(conv, AGENT)).length, 1);
    // Same-size rewrite with identical mtime granularity could in theory be
    // missed by stat-gating; explicit invalidation must always recover.
    writeFileSync(join(cdir, "messages.jsonl"), msgLine("zz", "a"));
    invalidateMessagesCache(conv, AGENT);
    assert.deepEqual((await listMessages(conv, AGENT)).map((m) => m.id), ["zz"]);
  });
});

test("stampNewMessages appends to _real-times.jsonl and is idempotent", async () => {
  await withBackendDir(async (dir) => {
    const conv = "conv-ts-append";
    const cdir = seedConv(dir, conv, [msgLine("m1", "a"), msgLine("m2", "b")]);
    await stampNewMessages(conv, AGENT, new Date("2026-06-10T12:00:00.000Z"));

    const jsonlPath = join(cdir, "_real-times.jsonl");
    assert.ok(existsSync(jsonlPath), "jsonl sidecar created");
    const lines1 = readFileSync(jsonlPath, "utf8").trim().split("\n");
    assert.equal(lines1.length, 2);

    // Second stamp with no new messages: no new lines (idempotent).
    await stampNewMessages(conv, AGENT, new Date("2026-06-10T12:01:00.000Z"));
    const lines2 = readFileSync(jsonlPath, "utf8").trim().split("\n");
    assert.equal(lines2.length, 2);

    // New message → exactly one appended line; earlier stamps unchanged.
    appendFileSync(join(cdir, "messages.jsonl"), msgLine("m3", "c"));
    await stampNewMessages(conv, AGENT, new Date("2026-06-10T12:02:00.000Z"));
    const map = await readMessageTimestamps(conv, AGENT);
    assert.equal(map["m1"], "2026-06-10T12:00:00.000Z");
    assert.equal(map["m3"], "2026-06-10T12:02:00.000Z");
    const lines3 = readFileSync(jsonlPath, "utf8").trim().split("\n");
    assert.equal(lines3.length, 3);
  });
});

test("legacy _real-times.json is folded into the jsonl and removed on first stamp", async () => {
  await withBackendDir(async (dir) => {
    const conv = "conv-ts-migrate";
    const cdir = seedConv(dir, conv, [msgLine("m1", "a"), msgLine("m2", "b")]);
    const legacyPath = join(cdir, "_real-times.json");
    writeFileSync(legacyPath, JSON.stringify({ m1: "2026-01-02T00:00:00.000Z" }) + "\n");

    await stampNewMessages(conv, AGENT, new Date("2026-06-10T13:00:00.000Z"));

    assert.ok(!existsSync(legacyPath), "legacy json removed after migration");
    const map = await readMessageTimestamps(conv, AGENT);
    // Legacy stamp preserved; only the unstamped message got a new time.
    assert.equal(map["m1"], "2026-01-02T00:00:00.000Z");
    assert.equal(map["m2"], "2026-06-10T13:00:00.000Z");
    const body = readFileSync(join(cdir, "_real-times.jsonl"), "utf8");
    assert.match(body, /"m1"/);
    assert.match(body, /"m2"/);
  });
});

test("readMessageTimestamps tolerates partial trailing lines and compacts duplicates", async () => {
  await withBackendDir(async (dir) => {
    const conv = "conv-ts-compact";
    const cdir = seedConv(dir, conv, [msgLine("m1", "a")]);
    const jsonlPath = join(cdir, "_real-times.jsonl");
    // 5 lines for 1 distinct id (> 2x) plus a torn trailing line.
    const dup = (iso: string): string => JSON.stringify({ id: "m1", iso }) + "\n";
    writeFileSync(
      jsonlPath,
      dup("2026-06-01T00:00:01.000Z") +
      dup("2026-06-01T00:00:02.000Z") +
      dup("2026-06-01T00:00:03.000Z") +
      dup("2026-06-01T00:00:04.000Z") +
      dup("2026-06-01T00:00:05.000Z") +
      '{"id":"m1","iso":"2026-06-01T00:0', // torn mid-append
    );
    const map = await readMessageTimestamps(conv, AGENT);
    // Last complete line wins; torn line skipped.
    assert.equal(map["m1"], "2026-06-01T00:00:05.000Z");
    // Compaction rewrote one line per id.
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
  });
});
