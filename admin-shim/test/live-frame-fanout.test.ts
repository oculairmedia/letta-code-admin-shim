/**
 * lcp-2oxb.3: in-memory live frame fanout tests.
 *
 * Pinned contracts:
 *   - subscribeToRun on an ACTIVE run (in-memory handle) delivers frames
 *     appended after attach via the in-process fanout — no fs.watch.
 *   - Strict seq monotonicity, no loss, no duplication, including the
 *     catch-up → ring-bridge → live transition.
 *   - finalizeRun delivers the terminal sentinel; subscribers receive
 *     onDone with the run's status, and a late tail frame appended
 *     within the drain window still arrives before onDone.
 *   - cancelRun behaves like finalize for subscribers (status=cancelled).
 *   - subscribeLiveFrames exposes the ring gap so callers can detect a
 *     cursor that has fallen behind the buffer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendRunFrame,
  cancelRun,
  createRun,
  finalizeRun,
  subscribeLiveFrames,
} from "../lib/runs.js";
import { subscribeToRun } from "../lib/mobile-channel-host.js";

async function withBackendDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "live-fanout-"));
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

function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("active run: frames appended after attach arrive via fanout, strictly monotonic", async () => {
  await withBackendDir(async () => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    appendRunFrame(run.id, { message_type: "assistant_message", n: 1 });
    appendRunFrame(run.id, { message_type: "assistant_message", n: 2 });

    const seqs: number[] = [];
    let done: { last_seq: number; status: string } | null = null;
    const sub = subscribeToRun(run.id, 0, {
      onFrame: (_frame, seq) => seqs.push(seq),
      onDone: (info) => { done = info; },
      onError: (e) => { throw new Error(`unexpected error: ${e.code}`); },
    });

    // Catch-up replay delivered 1..2 synchronously.
    assert.deepEqual(seqs, [1, 2]);

    // 300 rapid live appends — all must arrive exactly once, in order.
    for (let i = 3; i <= 302; i++) {
      appendRunFrame(run.id, { message_type: "assistant_message", n: i });
    }
    assert.equal(seqs.length, 302);
    assert.deepEqual(seqs, Array.from({ length: 302 }, (_, i) => i + 1));
    assert.equal(done, null, "no onDone before finalize");
    sub.unsubscribe();
  });
});

test("finalizeRun → onDone with status; late tail frame within drain window included", async () => {
  await withBackendDir(async () => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    appendRunFrame(run.id, { message_type: "assistant_message", n: 1 });

    const seqs: number[] = [];
    let done: { last_seq: number; status: string } | null = null;
    subscribeToRun(run.id, 0, {
      onFrame: (_frame, seq) => seqs.push(seq),
      onDone: (info) => { done = info; },
      onError: (e) => { throw new Error(`unexpected error: ${e.code}`); },
    });

    finalizeRun(run, { status: "completed", stopReason: "end_turn" });
    // lcp-xu4l: terminal tail appended just after finalize (grace window).
    appendRunFrame(run.id, { message_type: "stop_reason", stop_reason: "end_turn" });

    await waitFor(() => done !== null);
    const settled = done as unknown as { last_seq: number; status: string };
    assert.equal(settled.status, "completed");
    assert.deepEqual(seqs, [1, 2], "late tail frame delivered before onDone");
    assert.equal(settled.last_seq, 2);
  });
});

test("cancelRun → subscriber gets onDone with status=cancelled", async () => {
  await withBackendDir(async () => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    appendRunFrame(run.id, { message_type: "assistant_message", n: 1 });

    let done: { last_seq: number; status: string } | null = null;
    subscribeToRun(run.id, 0, {
      onFrame: () => {},
      onDone: (info) => { done = info; },
      onError: (e) => { throw new Error(`unexpected error: ${e.code}`); },
    });

    assert.equal(cancelRun(run.id), true);
    await waitFor(() => done !== null);
    assert.equal((done as unknown as { status: string }).status, "cancelled");
  });
});

test("mid-stream attach with cursor replays only the remainder, exactly once", async () => {
  await withBackendDir(async () => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    for (let i = 1; i <= 10; i++) {
      appendRunFrame(run.id, { message_type: "assistant_message", n: i });
    }
    const seqs: number[] = [];
    subscribeToRun(run.id, 4, {
      onFrame: (_frame, seq) => seqs.push(seq),
      onDone: () => {},
      onError: (e) => { throw new Error(`unexpected error: ${e.code}`); },
    });
    assert.deepEqual(seqs, [5, 6, 7, 8, 9, 10]);
    for (let i = 11; i <= 15; i++) {
      appendRunFrame(run.id, { message_type: "assistant_message", n: i });
    }
    assert.deepEqual(seqs, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

test("subscribeLiveFrames surfaces the ring and reports gaps past the buffer", async () => {
  await withBackendDir(async () => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    // Push past RING_MAX (256) so the oldest entries have been shifted out.
    for (let i = 1; i <= 300; i++) {
      appendRunFrame(run.id, { message_type: "assistant_message", n: i });
    }
    const live = subscribeLiveFrames(run.id, 0, () => {});
    assert.equal(live.ok, true);
    assert.equal(live.ring.length, 256);
    const first = live.ring[0];
    assert.ok(first && first.seq === 45, `ring starts at 45, got ${first?.seq}`);
    // Gap detector contract used by subscribeToRun: oldest > fromSeq + 1.
    assert.ok(first.seq > 0 + 1, "gap visible to caller");
    live.unsubscribe();

    // Unknown run → ok:false.
    const missing = subscribeLiveFrames("run-does-not-exist", 0, () => {});
    assert.equal(missing.ok, false);
  });
});
