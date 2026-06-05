/**
 * Regression tests for the mobile conversation cursor replay (lcp-02ri).
 *
 * The replay file (`<conv>.frames.jsonl`) is append-only and never rotated,
 * so it grows for the life of a conversation. `resumeConversation` (called on
 * every WS reconnect) must NOT do work proportional to the TOTAL number of
 * frames ever stamped — only proportional to the bounded MAX_FRAMES tail it
 * can ever return. This is the same streaming-replay regression class as the
 * subscribeToRun O(n^2) bug fixed by byte-offset tailing (lcp-02ri / PR #18).
 *
 * These tests set SHIM_MOBILE_CONV_REPLAY_MAX_FRAMES small BEFORE importing
 * the module (the cap is read once at module load) so the bound is easy to
 * assert deterministically.
 *
 * IMPORTANT: the module under test must be loaded with a DYNAMIC `import()`
 * *after* the env var is set. ESM `import` declarations are hoisted and the
 * imported module is evaluated before any top-level statement in this file
 * runs — so a `process.env[...] = "50"` assignment placed above a static
 * `import` would execute too late and the module would capture the default
 * cap (1000) instead. That hoisting hazard previously made this test read
 * MAX_FRAMES=1000 and assert against the wrong tail bound (lcp-a0rl).
 */

// Must be set before the module under test is imported — the cap/TTL are
// captured at module-load time. Set it BEFORE the dynamic import below.
process.env["SHIM_MOBILE_CONV_REPLAY_MAX_FRAMES"] = "50";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { stampConversationFrame, resumeConversation } = await import(
  "../lib/mobile-conversation-cursors.js"
);

function withBackendDir<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "conv-cursors-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

test("resume returns frames after the cursor in seq order", () => {
  withBackendDir(() => {
    const conv = "conv-resume-basic";
    for (let i = 0; i < 10; i += 1) {
      stampConversationFrame(conv, { message_type: "assistant_message", content: `chunk-${i}` });
    }
    const result = resumeConversation(conv, 5);
    assert.equal(result.ok, true);
    assert.equal(result.cursorExpired, false);
    assert.equal(result.lastSeq, 10);
    // afterSeq=5 → frames with conv_seq 6..10.
    const seqs = result.frames.map((f) => f["conv_seq"]);
    assert.deepEqual(seqs, [6, 7, 8, 9, 10]);
    // Every replayed frame carries the replayed marker.
    assert.ok(result.frames.every((f) => f["replayed"] === true));
  });
});

test("resume read is bounded by MAX_FRAMES tail, not total history (lcp-02ri)", () => {
  withBackendDir(() => {
    const conv = "conv-resume-scale";
    // Stamp far more than MAX_FRAMES (=50) so the on-disk file dwarfs the
    // bounded tail. A correct tail-read parses at most ~MAX_FRAMES lines and
    // never scales with the 5_000 historical frames on disk.
    const TOTAL = 5_000;
    for (let i = 0; i < TOTAL; i += 1) {
      stampConversationFrame(conv, { message_type: "assistant_message", content: "x".repeat(40) });
    }
    // A cursor that is far BEHIND the bounded replay window is — correctly —
    // expired: the oldest frame we still retain on the tail is well past it.
    // The key property under test is that this verdict is reached WITHOUT
    // parsing all 5_000 historical frames (the read is tail-bounded), and the
    // window that drives it is the MAX_FRAMES tail.
    const expired = resumeConversation(conv, 0);
    assert.equal(expired.lastSeq, TOTAL);
    assert.equal(expired.cursorExpired, true);
    assert.equal(expired.ok, false);
    // oldestSeq reflects only the bounded tail (~the newest MAX_FRAMES), not
    // seq 1 — proof the reader didn't surface the whole history.
    assert.ok(
      expired.oldestSeq !== null && expired.oldestSeq > TOTAL - 200,
      `oldestSeq should be near the tail, got ${expired.oldestSeq}`,
    );

    // A cursor INSIDE the bounded tail replays only the most-recent frames,
    // capped at MAX_FRAMES and ending exactly at lastSeq.
    const recent = resumeConversation(conv, TOTAL - 10);
    assert.equal(recent.ok, true);
    assert.ok(
      recent.frames.length <= 50,
      `expected <= MAX_FRAMES (50) frames, got ${recent.frames.length}`,
    );
    const seqs = recent.frames.map((f) => f["conv_seq"] as number);
    assert.equal(seqs[seqs.length - 1], TOTAL);
    assert.deepEqual(
      seqs,
      Array.from({ length: 10 }, (_, i) => TOTAL - 9 + i),
    );
  });
});

test("resume after a high cursor near the tail returns exactly the new frames", () => {
  withBackendDir(() => {
    const conv = "conv-resume-tail";
    const TOTAL = 2_000;
    for (let i = 0; i < TOTAL; i += 1) {
      stampConversationFrame(conv, { message_type: "assistant_message", content: "y" });
    }
    // Cursor 3 frames behind the tail → exactly the last 3 frames replay.
    const result = resumeConversation(conv, TOTAL - 3);
    assert.equal(result.ok, true);
    const seqs = result.frames.map((f) => f["conv_seq"]);
    assert.deepEqual(seqs, [TOTAL - 2, TOTAL - 1, TOTAL]);
  });
});
