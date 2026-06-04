/**
 * Scale regression for high-cursor subscribe replay (lcp-02ri.2).
 *
 * Background: PR #18 made LIVE streaming appends tail by byte offset.
 * Reconnect/replay still read + JSON.parsed frames.jsonl from byte 0 and
 * discarded every frame with seq <= cursor — O(total log) work on every
 * mobile reconnect, even when the client is caught up to the tail of a
 * long run.
 *
 * This test seeds a run with ~50k frames and subscribes at a cursor near
 * the tail. It asserts:
 *   1. Correctness — only frames with seq > cursor are emitted, in order,
 *      with the right last_seq (identical to a from-0 scan).
 *   2. Performance — the number of frame lines actually parsed is bounded
 *      by the tail (cursor..end) plus one checkpoint stride, NOT the whole
 *      50k-line log. Measured via the instrumented parse counter.
 *
 * Two paths are covered:
 *   - WARM: the run is still active, so the in-memory seq->byteOffset
 *     index drives the seek (zero index I/O).
 *   - COLD: the in-memory handle is dropped to force the on-disk
 *     frames.index.jsonl sidecar to drive the seek (process-restart path).
 *
 * Fallback caveat (documented): a run written BEFORE this index existed
 * (no in-memory index AND no frames.index.jsonl sidecar) falls back to a
 * full from-0 scan — correct, just not faster. The COLD-without-sidecar
 * case below pins that fallback so it stays correct.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendRunFrame, createRun, getFramesFilePath } from "../lib/runs.js";
import {
  subscribeToRun,
  __getFramesParsedCount,
  __resetFramesParsedCount,
} from "../lib/mobile-channel-host.js";

async function withBackendDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "subscribe-replay-index-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

const TOTAL = 50_000;
const CURSOR = 49_900;
// FRAME_INDEX_STRIDE default is 256. The seek lands on the greatest
// checkpoint <= cursor, so the worst-case forward parse is the distance from
// that checkpoint to the tail: (TOTAL - cursor) + one stride of slack.
const STRIDE = 256;
const PARSE_BUDGET = TOTAL - CURSOR + STRIDE + 8; // generous headroom

/**
 * Drive subscribeToRun synchronously: the initial replay (seek + read +
 * emit) happens before subscribeToRun returns. We collect the emitted
 * frames, then unsubscribe immediately so the fs.watch tail never fires.
 */
function replay(
  runId: string,
  cursor: number,
): { frames: Array<{ seq: number; frame: unknown }>; error: { code: string; message: string } | null } {
  const frames: Array<{ seq: number; frame: unknown }> = [];
  let error: { code: string; message: string } | null = null;
  const sub = subscribeToRun(runId, cursor, {
    onFrame: (frame, seq) => frames.push({ seq, frame }),
    onDone: () => {},
    onError: (info) => {
      error = info;
    },
  });
  sub.unsubscribe();
  return { frames, error };
}

test("high-cursor replay seeks via in-memory index (warm run) — bounded parse", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    for (let i = 1; i <= TOTAL; i++) {
      appendRunFrame(run.id, { message_type: "assistant_message", content: `c${i}` });
    }
    // Run stays "running" (active) — the in-memory frameIndex drives the seek.

    __resetFramesParsedCount();
    const { frames, error } = replay(run.id, CURSOR);
    const parsed = __getFramesParsedCount();

    assert.equal(error, null, "no error on warm high-cursor replay");
    // Correctness: only seq > cursor, in order, exact tail.
    assert.equal(frames.length, TOTAL - CURSOR, "emits exactly the tail frames");
    assert.deepEqual(
      frames.map((f) => f.seq),
      Array.from({ length: TOTAL - CURSOR }, (_, i) => CURSOR + 1 + i),
    );
    assert.equal(frames[0]?.seq, CURSOR + 1);
    assert.equal(frames[frames.length - 1]?.seq, TOTAL);

    // Performance: parse work is proportional to the tail, NOT the 50k log.
    assert.ok(
      parsed <= PARSE_BUDGET,
      `parsed ${parsed} lines; expected <= ${PARSE_BUDGET} (tail-bounded, not ${TOTAL})`,
    );
    // Sanity: a from-0 scan would have parsed ~TOTAL lines. Prove the seek
    // skipped the vast majority of the log.
    assert.ok(parsed < TOTAL / 10, `parsed ${parsed} must be far below ${TOTAL}`);
  });
});

/**
 * Seed a run on disk WITHOUT an in-memory handle — exactly the shape a
 * prior process left behind. Writes run.json, frames.jsonl, and the
 * frames.index.jsonl sidecar (sparse checkpoints) using the SAME byte
 * accounting appendRunFrame uses, so the seeked offsets are real.
 */
function seedColdRunWithIndex(
  stateDir: string,
  runId: string,
  total: number,
): void {
  const dir = join(stateDir, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      id: runId,
      agent_id: "agent-a",
      conversation_id: "default",
      status: "completed",
      created_at: "2026-05-18T10:00:00.000Z",
      completed_at: "2026-05-18T10:01:00.000Z",
      message_ids: [],
      tools_used: [],
      num_steps: 0,
    }),
  );
  let offset = 0;
  let framesBuf = "";
  let indexBuf = "";
  for (let seq = 1; seq <= total; seq++) {
    const line =
      JSON.stringify({
        seq,
        ts: "2026-05-18T10:00:00.000Z",
        frame: { message_type: "assistant_message", content: `c${seq}` },
      }) + "\n";
    if (seq === 1 || seq % STRIDE === 0) {
      indexBuf += JSON.stringify({ seq, offset }) + "\n";
    }
    framesBuf += line;
    offset += Buffer.byteLength(line, "utf8");
  }
  writeFileSync(join(dir, "frames.jsonl"), framesBuf);
  writeFileSync(join(dir, "frames.index.jsonl"), indexBuf);
}

test("high-cursor replay seeks via on-disk index sidecar (cold run) — bounded parse", async () => {
  await withBackendDir((dir) => {
    const runId = "run-cold0000-1111-2222-3333-444444444444";
    seedColdRunWithIndex(dir, runId, TOTAL);

    // No createRun call → no in-memory handle. findFrameOffsetForCursor must
    // fall through to the disk sidecar.
    const idxPath = join(getFramesFilePath(runId), "..", "frames.index.jsonl");
    assert.ok(existsSync(idxPath), "frames.index.jsonl sidecar present on disk");

    __resetFramesParsedCount();
    const { frames, error } = replay(runId, CURSOR);
    const parsed = __getFramesParsedCount();

    assert.equal(error, null, "no error on cold high-cursor replay");
    assert.equal(frames.length, TOTAL - CURSOR, "emits exactly the tail frames");
    assert.deepEqual(
      frames.map((f) => f.seq),
      Array.from({ length: TOTAL - CURSOR }, (_, i) => CURSOR + 1 + i),
    );

    assert.ok(
      parsed <= PARSE_BUDGET,
      `parsed ${parsed} lines; expected <= ${PARSE_BUDGET} (tail-bounded)`,
    );
    assert.ok(parsed < TOTAL / 10, `parsed ${parsed} must be far below ${TOTAL}`);
  });
});

test("cold run WITHOUT an index sidecar falls back to a full from-0 scan (correct, slower)", async () => {
  await withBackendDir((dir) => {
    const runId = "run-noindex0-1111-2222-3333-444444444444";
    const N = 2000;
    const runDir = join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run.json"),
      JSON.stringify({
        id: runId,
        agent_id: "agent-a",
        conversation_id: "default",
        status: "completed",
        created_at: "2026-05-18T10:00:00.000Z",
        completed_at: "2026-05-18T10:01:00.000Z",
        message_ids: [],
        tools_used: [],
        num_steps: 0,
      }),
    );
    for (let seq = 1; seq <= N; seq++) {
      appendFileSync(
        join(runDir, "frames.jsonl"),
        JSON.stringify({
          seq,
          ts: "2026-05-18T10:00:00.000Z",
          frame: { message_type: "assistant_message", content: `c${seq}` },
        }) + "\n",
      );
    }
    // Deliberately NO frames.index.jsonl — pre-index run shape.

    const cursor = 1900;
    __resetFramesParsedCount();
    const { frames, error } = replay(runId, cursor);
    const parsed = __getFramesParsedCount();

    // Correctness must hold even on the fallback path.
    assert.equal(error, null);
    assert.equal(frames.length, N - cursor, "emits exactly the tail frames");
    assert.deepEqual(
      frames.map((f) => f.seq),
      Array.from({ length: N - cursor }, (_, i) => cursor + 1 + i),
    );
    // Fallback parses from byte 0 — every line is read.
    assert.equal(parsed, N, "no index → full from-0 scan (documented fallback)");
  });
});

test("cursor=0 still replays the whole log (no seek) — semantics unchanged", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    const N = 1000;
    for (let i = 1; i <= N; i++) {
      appendRunFrame(run.id, { message_type: "assistant_message", content: `c${i}` });
    }

    __resetFramesParsedCount();
    const { frames, error } = replay(run.id, 0);
    const parsed = __getFramesParsedCount();

    assert.equal(error, null);
    assert.equal(frames.length, N, "cursor 0 replays everything");
    assert.equal(frames[0]?.seq, 1);
    assert.equal(frames[frames.length - 1]?.seq, N);
    // No seek at cursor 0 — every line is parsed.
    assert.equal(parsed, N, "cursor 0 parses every line (no seek)");
  });
});

test("high-cursor replay matches a from-0 scan exactly (correctness parity)", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    const N = 5000;
    for (let i = 1; i <= N; i++) {
      appendRunFrame(run.id, { message_type: "assistant_message", content: `c${i}` });
    }

    const cursor = 4321;
    // Indexed seek path.
    const seeked = replay(run.id, cursor);
    // Force a from-0 reference by replaying at cursor 0 then filtering — this
    // is the exact set the old (scan-from-0) code would have emitted.
    const full = replay(run.id, 0);
    const reference = full.frames.filter((f) => f.seq > cursor);

    assert.deepEqual(
      seeked.frames.map((f) => f.seq),
      reference.map((f) => f.seq),
      "seeked replay emits identical seqs to a filtered full scan",
    );
    assert.deepEqual(
      seeked.frames.map((f) => (f.frame as { content: string }).content),
      reference.map((f) => (f.frame as { content: string }).content),
      "frame payloads are identical",
    );
  });
});
