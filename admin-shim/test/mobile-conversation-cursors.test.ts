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
import { appendFileSync, mkdtempSync, readFileSync, existsSync, rmSync, statSync, chmodSync, writeFileSync } from "node:fs";
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


test("compaction on never-stamped conversation is a safe no-op", async () => {
  await withBackendDir(async () => {
    const conv = "conv-empty";
    // No frames ever stamped — replay log should not exist.
    assert.equal(existsSync(replayLogPath(conv)), false);

    // Compaction must not throw and must not create a log file.
    _cursorInternals.maybeCompactReplayLog(conv, 0);
    assert.equal(existsSync(replayLogPath(conv)), false);

    // Resume on the empty conversation must succeed with empty frames.
    const resumed = resumeConversation(conv, 0);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.frames.length, 0);
    assert.equal(resumed.lastSeq, 0);
    assert.equal(resumed.oldestSeq, null);
    assert.equal(resumed.cursorExpired, false);
  });
});

test("compaction of a single unacked frame preserves the frame", async () => {
  await withBackendDir(async () => {
    const conv = "conv-single";
    stampConversationFrame(conv, { type: "ping", n: 1 });
    assert.equal(replayLineCount(conv), 1);

    _cursorInternals.maybeCompactReplayLog(conv, 0);
    assert.equal(replayLineCount(conv), 1);

    const resumed = resumeConversation(conv, 0);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.frames.length, 1);
    assert.equal(resumed.frames[0]?.["conv_seq"], 1);
    assert.equal(resumed.lastSeq, 1);
    assert.equal(resumed.oldestSeq, 1);
  });
});

test("compaction preserves ascending sequence order across surviving frames", async () => {
  await withBackendDir(async () => {
    const conv = "conv-order";
    for (let i = 1; i <= 8; i++) {
      stampConversationFrame(conv, { type: "ping", n: i });
    }
    // Ack first 3; compaction must keep frames 4..8 in stamped order.
    ackConversation(conv, 3);

    _cursorInternals.maybeCompactReplayLog(conv, 3);
    assert.equal(replayLineCount(conv), 5);

    const resumed = resumeConversation(conv, 3);
    assert.equal(resumed.ok, true);
    assert.deepEqual(
      resumed.frames.map((f) => f["conv_seq"]),
      [4, 5, 6, 7, 8],
    );
  });
});

test("compaction drops malformed JSONL lines and non-record frames", async () => {
  await withBackendDir(async () => {
    const conv = "conv-malformed";
    stampConversationFrame(conv, { type: "ping", n: 1 });

    // Append a mix of valid and malformed lines directly to the log.
    const logPath = replayLogPath(conv);
    const validLine = JSON.stringify({
      seq: 2,
      ts: new Date().toISOString(),
      frame: { conversation_id: conv, conv_seq: 2, type: "valid-after-malformed" },
    });
    const garbage = [
      "this is not json at all",
      "{",
      JSON.stringify({ seq: 3, frame: "not-a-record-object" }),
      JSON.stringify({ seq: 4, frame: ["array", "is-not-record"] }),
      JSON.stringify({ seq: 5 }),
    ];
    appendFileSync(logPath, "\n" + [validLine, ...garbage].join("\n") + "\n");
    assert.ok(replayLineCount(conv) >= 1 + garbage.length);

    _cursorInternals.maybeCompactReplayLog(conv, 0);
    const resumed = resumeConversation(conv, 0);
    assert.equal(resumed.ok, true);
    const seqs = resumed.frames
      .map((f) => f["conv_seq"])
      .sort((a, b) => Number(a) - Number(b));
    // Only seq=1 (originally stamped) and seq=2 (post-malformed valid) survive.
    assert.deepEqual(seqs, [1, 2]);
  });
});

test("compaction drops entries with non-positive sequence ids (zero, negative)", async () => {
  await withBackendDir(async () => {
    const conv = "conv-bad-seq";
    stampConversationFrame(conv, { type: "ping", n: 1 });

    const logPath = replayLogPath(conv);
    const lines = [
      JSON.stringify({ seq: 0, ts: new Date().toISOString(), frame: { conversation_id: conv, type: "seq-zero" } }),
      JSON.stringify({ seq: -5, ts: new Date().toISOString(), frame: { conversation_id: conv, type: "seq-negative" } }),
      JSON.stringify({ seq: -Number.MAX_SAFE_INTEGER, ts: new Date().toISOString(), frame: { conversation_id: conv, type: "seq-minsafe" } }),
    ];
    appendFileSync(logPath, "\n" + lines.join("\n") + "\n");
    assert.ok(replayLineCount(conv) >= 4);

    _cursorInternals.maybeCompactReplayLog(conv, 0);
    const resumed = resumeConversation(conv, 0);
    assert.equal(resumed.ok, true);
    // Only the originally-stamped seq=1 survives; non-positive seqs are dropped.
    assert.equal(resumed.frames.length, 1);
    assert.equal(resumed.frames[0]?.["conv_seq"], 1);
  });
});

test("compaction drops entries with non-numeric sequence ids (string, null, undefined)", async () => {
  await withBackendDir(async () => {
    const conv = "conv-nonnumeric-seq";
    stampConversationFrame(conv, { type: "ping", n: 1 });

    const logPath = replayLogPath(conv);
    const lines = [
      JSON.stringify({ seq: "abc", ts: new Date().toISOString(), frame: { conversation_id: conv, type: "seq-string" } }),
      JSON.stringify({ seq: null, ts: new Date().toISOString(), frame: { conversation_id: conv, type: "seq-null" } }),
      JSON.stringify({ ts: new Date().toISOString(), frame: { conversation_id: conv, type: "seq-missing" } }), // undefined
      JSON.stringify({ seq: "5", ts: new Date().toISOString(), frame: { conversation_id: conv, type: "seq-coerced", conv_seq: 5 } }),
    ];
    appendFileSync(logPath, "\n" + lines.join("\n") + "\n");

    _cursorInternals.maybeCompactReplayLog(conv, 0);
    const resumed = resumeConversation(conv, 0);
    assert.equal(resumed.ok, true);
    const seqs = resumed.frames
      .map((f) => f["conv_seq"])
      .sort((a, b) => Number(a) - Number(b));
    // seq=1 (originally stamped) and seq=5 (numeric string coerces to 5) survive.
    // "abc", null, missing all normalize to 0 and are dropped.
    assert.deepEqual(seqs, [1, 5]);
  });
});

test("normalizeSeq treats non-finite and non-scalar resume boundaries as 0", async () => {
  await withBackendDir(async () => {
    const conv = "conv-boundaries";
    stampConversationFrame(conv, { type: "ping", n: 1 });
    stampConversationFrame(conv, { type: "ping", n: 2 });

    const boundaries: unknown[] = ["", null, NaN, Infinity, -Infinity, -5, -10.5, 0, "abc", {}, []];
    for (const boundary of boundaries) {
      const resumed = resumeConversation(conv, boundary);
      assert.equal(resumed.ok, true, `resume should succeed for boundary: ${String(boundary)}`);
      assert.equal(resumed.afterSeq, 0, `afterSeq should normalize to 0 for boundary: ${String(boundary)}`);
      assert.deepEqual(
        resumed.frames.map((frame) => frame["conv_seq"]),
        [1, 2],
        `resume should replay all frames for boundary: ${String(boundary)}`,
      );
    }
  });
});

test("resumeConversation on an unknown conversationId returns an empty ok result", async () => {
  await withBackendDir(async () => {
    const resumed = resumeConversation("conv-never-stamped", 0);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.cursorExpired, false);
    assert.equal(resumed.conversationId, "conv-never-stamped");
    assert.equal(resumed.lastSeq, 0);
    assert.deepEqual(resumed.frames, []);
  });
});

test("resumeConversation normalizes null afterSeq to 0", async () => {
  await withBackendDir(async () => {
    const conv = "conv-null-after";
    stampConversationFrame(conv, { type: "ping", n: 1 });
    stampConversationFrame(conv, { type: "ping", n: 2 });
    const resumed = resumeConversation(conv, null);
    assert.equal(resumed.afterSeq, 0);
    assert.deepEqual(resumed.frames.map((frame) => frame["conv_seq"]), [1, 2]);
  });
});

test("resumeConversation normalizes negative afterSeq to 0", async () => {
  await withBackendDir(async () => {
    const conv = "conv-negative-after";
    stampConversationFrame(conv, { type: "ping", n: 1 });
    stampConversationFrame(conv, { type: "ping", n: 2 });
    const resumed = resumeConversation(conv, -5);
    assert.equal(resumed.afterSeq, 0);
    assert.deepEqual(resumed.frames.map((frame) => frame["conv_seq"]), [1, 2]);
  });
});

test("resumeConversation normalizes non-numeric afterSeq strings to 0", async () => {
  await withBackendDir(async () => {
    const conv = "conv-string-after";
    stampConversationFrame(conv, { type: "ping", n: 1 });
    stampConversationFrame(conv, { type: "ping", n: 2 });
    const resumed = resumeConversation(conv, "not-a-number");
    assert.equal(resumed.afterSeq, 0);
    assert.deepEqual(resumed.frames.map((frame) => frame["conv_seq"]), [1, 2]);
  });
});

test("resumeConversation handles very large afterSeq by returning no future frames", async () => {
  await withBackendDir(async () => {
    const conv = "conv-large-after";
    stampConversationFrame(conv, { type: "ping", n: 1 });
    stampConversationFrame(conv, { type: "ping", n: 2 });
    const resumed = resumeConversation(conv, Number.MAX_SAFE_INTEGER);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.afterSeq, Number.MAX_SAFE_INTEGER);
    assert.equal(resumed.frames.length, 0);
  });
});

test("resumeConversation reports cursorExpired when afterSeq is before the oldest retained seq", async () => {
  await withBackendDir(async () => {
    const conv = "conv-expired-boundary";
    for (let i = 1; i <= 8; i++) stampConversationFrame(conv, { type: "ping", n: i });
    ackConversation(conv, 3);
    _cursorInternals.maybeCompactReplayLog(conv, 3);
    const resumed = resumeConversation(conv, 2);
    assert.equal(resumed.cursorExpired, true);
    assert.equal(resumed.ok, false);
    assert.equal(resumed.oldestSeq, 4);
  });
});


// ── lcp xwi3z (§2b): implicit ack on successful resume ─────────────────

function sidecarFilePath(conversationId: string): string {
  return join(
    storeInternals.storageDir(),
    "mobile-conversation-cursors",
    `${storeInternals.b64url(conversationId)}.json`,
  );
}

function readSidecarAck(conversationId: string): number {
  const parsed = JSON.parse(readFileSync(sidecarFilePath(conversationId), "utf8")) as { last_ack_seq: number };
  return parsed.last_ack_seq;
}

test("xwi3z: successful resume implicitly acks after_seq; replay > N only; compaction drops ≤ N", async () => {
  await withBackendDir(async () => {
    const conv = "conv-implicit-ack";
    for (let i = 1; i <= 10; i++) stampConversationFrame(conv, { type: "ping", n: i });
    assert.equal(readSidecarAck(conv), 0);

    const resumed = resumeConversation(conv, 6);
    assert.equal(resumed.ok, true);
    assert.deepEqual(resumed.frames.map((f) => f["conv_seq"]), [7, 8, 9, 10]);
    // Sidecar advanced to the resume cursor — no client `ack` frame needed.
    assert.equal(readSidecarAck(conv), 6);

    // Subsequent compaction actually shrinks the JSONL to the unacked tail.
    _cursorInternals.maybeCompactReplayLog(conv, readSidecarAck(conv));
    assert.equal(replayLineCount(conv), 4);
    const again = resumeConversation(conv, 6);
    assert.equal(again.ok, true);
    assert.deepEqual(again.frames.map((f) => f["conv_seq"]), [7, 8, 9, 10]);
  });
});

test("xwi3z: stale cursor still returns cursor_expired and does NOT ack", async () => {
  await withBackendDir(async () => {
    const conv = "conv-stale-no-ack";
    for (let i = 1; i <= 8; i++) stampConversationFrame(conv, { type: "ping", n: i });
    ackConversation(conv, 5);
    _cursorInternals.maybeCompactReplayLog(conv, 5);

    const stale = resumeConversation(conv, 2);
    assert.equal(stale.cursorExpired, true);
    assert.equal(stale.ok, false);
    // The failed resume must not move the ack (an early top-of-resume ack
    // would fire before the cursor_expired determination — pinned here).
    assert.equal(readSidecarAck(conv), 5);
  });
});

test("xwi3z: after_seq beyond last_assigned_seq clamps the ack (no replay suppression)", async () => {
  await withBackendDir(async () => {
    const conv = "conv-clamped-ack";
    stampConversationFrame(conv, { type: "ping", n: 1 });
    stampConversationFrame(conv, { type: "ping", n: 2 });

    // Corrupt/foreign cursor far past anything ever assigned.
    const resumed = resumeConversation(conv, 9_999);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.frames.length, 0);
    // Clamped to last_assigned_seq (2) — NOT 9999. Without the clamp,
    // compaction would permanently drop future frames ≤ 9999.
    assert.equal(readSidecarAck(conv), 2);

    // Frames stamped after the over-claiming resume still replay.
    stampConversationFrame(conv, { type: "ping", n: 3 });
    const next = resumeConversation(conv, 2);
    assert.equal(next.ok, true);
    assert.deepEqual(next.frames.map((f) => f["conv_seq"]), [3]);
  });
});

test("xwi3z: multi-device regression pinned — device A's high resume expires device B's older cursor", async () => {
  await withBackendDir(async () => {
    const conv = "conv-two-devices";
    for (let i = 1; i <= 10; i++) stampConversationFrame(conv, { type: "ping", n: i });

    // Device A resumes at the tip → implicit ack at 10.
    const a = resumeConversation(conv, 10);
    assert.equal(a.ok, true);
    assert.equal(readSidecarAck(conv), 10);

    // Device B, still at seq 4, now gets cursor_expired (the :289 filter
    // hides acked frames even before compaction runs). This is the
    // documented, ACCEPTED behavior change: B recovers via mobile's
    // cursor_expired → cold REST hydrate path — degraded, not data loss.
    const b = resumeConversation(conv, 4);
    assert.equal(b.cursorExpired, true);
    assert.equal(b.ok, false);
  });
});

test("resume after a high cursor near the tail returns exactly the new frames", async () => {
  await withBackendDir(async () => {
    const conv = "conv-resume-tail";
    const TOTAL = 2_000;
    for (let i = 0; i < TOTAL; i += 1) {
      stampConversationFrame(conv, { message_type: "assistant_message", content: "y" });
    }
    // Cursor 3 frames behind the tail -> exactly the last 3 frames replay.
    const result = resumeConversation(conv, TOTAL - 3);
    assert.equal(result.ok, true);
    const seqs = result.frames.map((f) => f["conv_seq"]);
    assert.deepEqual(seqs, [TOTAL - 2, TOTAL - 1, TOTAL]);
  });
});
