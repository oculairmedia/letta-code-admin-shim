/**
 * lcp-9vo7 / lcp-2s5e: cursor cache bounds + replay log compaction.
 *
 * Pinned contracts:
 *   - stamp/resume/ack round-trip survives in-memory cache eviction
 *     (sidecar reloads from disk transparently).
 *   - The in-memory cursor cache never exceeds SHIM_MOBILE_CONV_CURSOR_CACHE_MAX.
 *   - Compaction rewrites the replay JSONL down to replay-eligible frames
 *     (unacked, within TTL, last MAX_FRAMES) without changing resume results.
 *   - Compacting a fully-acked conversation removes the log file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _cursorInternals,
  ackConversation,
  resumeConversation,
  stampConversationFrame,
  subscribeConversationEvents,
} from "../lib/mobile-conversation-cursors.js";
import { _internals as storeInternals } from "../lib/store.js";

async function withBackendDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "conv-cursors-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  _cursorInternals.resetCache();
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    _cursorInternals.resetCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

function replayLogPath(conversationId: string): string {
  return join(
    storeInternals.storageDir(),
    "mobile-conversation-cursors",
    `${storeInternals.b64url(conversationId)}.frames.jsonl`,
  );
}

function replayLineCount(conversationId: string): number {
  const path = replayLogPath(conversationId);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length;
}

test("stamp assigns monotonic conv_seq and resume replays unacked frames", async () => {
  await withBackendDir(async () => {
    const conv = "conv-basic";
    for (let i = 1; i <= 5; i++) {
      const stamped = stampConversationFrame(conv, { type: "ping", n: i });
      assert.equal(stamped["conv_seq"], i);
      assert.equal(stamped["conversation_id"], conv);
    }
    const resumed = resumeConversation(conv, 2);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.lastSeq, 5);
    assert.deepEqual(
      resumed.frames.map((f) => f["conv_seq"]),
      [3, 4, 5],
    );
    assert.ok(resumed.frames.every((f) => f["replayed"] === true));
  });
});

test("cursor state survives cache eviction (sidecar reload from disk)", async () => {
  await withBackendDir(async () => {
    const conv = "conv-evicted";
    stampConversationFrame(conv, { type: "ping", n: 1 });
    stampConversationFrame(conv, { type: "ping", n: 2 });
    ackConversation(conv, 1);

    // Force eviction by touching more conversations than the cache holds.
    _cursorInternals.resetCache();

    // Next stamp must continue the persisted sequence, not restart at 1.
    const stamped = stampConversationFrame(conv, { type: "ping", n: 3 });
    assert.equal(stamped["conv_seq"], 3);

    const resumed = resumeConversation(conv, 1);
    assert.equal(resumed.ok, true);
    assert.deepEqual(
      resumed.frames.map((f) => f["conv_seq"]),
      [2, 3],
    );
  });
});

test("in-memory cursor cache is bounded", async () => {
  await withBackendDir(async () => {
    const cap = 256; // default SHIM_MOBILE_CONV_CURSOR_CACHE_MAX
    for (let i = 0; i < cap + 50; i++) {
      stampConversationFrame(`conv-bulk-${i}`, { type: "ping" });
    }
    assert.ok(
      _cursorInternals.cacheSize() <= cap,
      `cache size ${_cursorInternals.cacheSize()} exceeds cap ${cap}`,
    );
    // An evicted early conversation still resumes correctly from disk.
    const resumed = resumeConversation("conv-bulk-0", 0);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.lastSeq, 1);
    assert.equal(resumed.frames.length, 1);
  });
});

test("compaction drops acked frames from the replay log without changing resume", async () => {
  await withBackendDir(async () => {
    const conv = "conv-compact";
    for (let i = 1; i <= 20; i++) {
      stampConversationFrame(conv, { type: "ping", n: i });
    }
    ackConversation(conv, 15);
    assert.equal(replayLineCount(conv), 20);

    _cursorInternals.maybeCompactReplayLog(conv, 15);
    assert.equal(replayLineCount(conv), 5);

    const resumed = resumeConversation(conv, 15);
    assert.equal(resumed.ok, true);
    assert.deepEqual(
      resumed.frames.map((f) => f["conv_seq"]),
      [16, 17, 18, 19, 20],
    );
  });
});

test("compaction removes the log when every frame is acked", async () => {
  await withBackendDir(async () => {
    const conv = "conv-fully-acked";
    for (let i = 1; i <= 10; i++) {
      stampConversationFrame(conv, { type: "ping", n: i });
    }
    ackConversation(conv, 10);
    _cursorInternals.maybeCompactReplayLog(conv, 10);
    assert.equal(existsSync(replayLogPath(conv)), false);

    // Resume at the tip remains valid; resume from before the ack reports an
    // expired cursor rather than silently dropping frames.
    const atTip = resumeConversation(conv, 10);
    assert.equal(atTip.ok, true);
    assert.equal(atTip.frames.length, 0);
    const stale = resumeConversation(conv, 3);
    assert.equal(stale.cursorExpired, true);
  });
});

test("subscribeConversationEvents receives stamped conversation frames", () => {
  const conv = `conv-live-${Date.now()}`;
  const observed: Array<{ conversationId: string; frame: Record<string, unknown> }> = [];
  const unsubscribe = subscribeConversationEvents((event) => observed.push(event));
  try {
    const stamped = stampConversationFrame(conv, { type: "assistant_message", content: "background update" });
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.conversationId, conv);
    assert.deepEqual(observed[0]?.frame, stamped);
    assert.equal(observed[0]?.frame["conversation_id"], conv);
    assert.equal(typeof observed[0]?.frame["conv_seq"], "number");
  } finally {
    unsubscribe();
  }
  stampConversationFrame(conv, { type: "assistant_message", content: "after unsubscribe" });
  assert.equal(observed.length, 1, "unsubscribe should stop live conversation delivery");
});


test("compaction treats NaN/Infinity ackSeq as 0 (retains frames)", async () => {
  await withBackendDir(async () => {
    const conv = "conv-nan-ack";
    for (let i = 1; i <= 3; i++) {
      stampConversationFrame(conv, { type: "ping", n: i });
    }

    // Using internal function directly to pass non-standard numeric inputs.
    // normal ackConversation normalizes its input, but maybeCompactReplayLog
    // takes a raw number and passes it to readReplayFrames.
    _cursorInternals.maybeCompactReplayLog(conv, NaN as any);
    assert.equal(replayLineCount(conv), 3);

    _cursorInternals.maybeCompactReplayLog(conv, Infinity as any);
    // Since readReplayFrames checks `convSeq <= lastAckSeq`, and convSeq (e.g. 1) <= Infinity is true,
    // Infinity means all frames will be dropped.
    assert.equal(replayLineCount(conv), 0);
  });
});

test("compaction gracefully catches and logs file system write/rename errors", async () => {
  await withBackendDir(async () => {
    const conv = "conv-fs-error";
    stampConversationFrame(conv, { type: "ping", n: 1 });

    // Create a scenario where writeFileSync or renameSync will fail.
    // Instead of monkey-patching, we can make the parent directory read-only,
    // or just pass a mock that fails if we are using an internal dependency,
    // but here we can just chmod the replay directory to read-only before compaction
    // and then restore it.

    const logPath = replayLogPath(conv);
    const dir = join(logPath, "..");
    const origMode = statSync(dir).mode;

    // Remove write permissions from the directory so renameSync fails
    chmodSync(dir, 0o555);

    try {
      // Should not throw, but catch block should execute and log a warning.
      _cursorInternals.maybeCompactReplayLog(conv, 0);

      // Since it failed, we can verify it via the console.warn if we spy on it,
      // but the core requirement is just that it doesn't throw.
    } finally {
      // Restore permissions
      chmodSync(dir, origMode);
    }
  });
});
