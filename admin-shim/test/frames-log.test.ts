/**
 * Unit tests for the per-run frame log (lcp-p74.1).
 *
 * Pinned contracts:
 *   - Monotonic seq starting at 1, incremented per append.
 *   - Each line is a complete JSONL record `{seq, ts, frame}\n`.
 *   - appendRunFrame on an unknown run returns `{seq: -1}` without
 *     writing — runs must be `createRun`-registered first.
 *   - Concurrent appends within a single Node process serialize through
 *     `appendFileSync` (one syscall per line) so no two lines interleave.
 *   - Mid-write partial-line resilience: even with large frames the
 *     consumer side (subscribeToRun's read loop) skips malformed
 *     trailing lines without breaking the stream.
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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendRunFrame, createRun, finalizeRun, getFramesFilePath } from "../lib/runs.js";

interface FrameLine {
  seq: number;
  ts: string;
  frame: unknown;
}

async function withBackendDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "frames-log-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) {
      delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    } else {
      process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function readFrames(runId: string): FrameLine[] {
  const path = getFramesFilePath(runId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as FrameLine);
}

test("appendRunFrame assigns monotonic seq starting at 1", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { seq } = appendRunFrame(run.id, { kind: "test", n: i });
      seqs.push(seq);
    }
    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);

    const lines = readFrames(run.id);
    assert.equal(lines.length, 5);
    assert.deepEqual(
      lines.map((l) => l.seq),
      [1, 2, 3, 4, 5],
    );
    // Every line carries the frame payload verbatim.
    assert.deepEqual(
      lines.map((l) => (l.frame as { n: number }).n),
      [0, 1, 2, 3, 4],
    );
    // Every line has a parseable ISO timestamp.
    for (const l of lines) {
      assert.ok(!Number.isNaN(Date.parse(l.ts)), `ts must be parseable: ${l.ts}`);
    }
  });
});

test("appendRunFrame on unknown run returns {seq: -1} and writes nothing", async () => {
  await withBackendDir(() => {
    const { seq } = appendRunFrame("run-does-not-exist", { kind: "ghost" });
    assert.equal(seq, -1);
    assert.equal(existsSync(getFramesFilePath("run-does-not-exist")), false);
  });
});

test("appendRunFrame still persists terminal tail frames just after finalizeRun", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    assert.equal(appendRunFrame(run.id, { message_type: "assistant_message", content: "done" }).seq, 1);

    finalizeRun(run, { status: "completed", stopReason: "end_turn" });

    const stop = appendRunFrame(run.id, { message_type: "stop_reason", stop_reason: "end_turn" });
    const usage = appendRunFrame(run.id, {
      message_type: "usage_statistics",
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
    });

    assert.equal(stop.seq, 2);
    assert.equal(usage.seq, 3);

    const lines = readFrames(run.id);
    assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3]);
    assert.deepEqual(
      lines.map((l) => (l.frame as { message_type: string }).message_type),
      ["assistant_message", "stop_reason", "usage_statistics"],
    );
  });
});

test("write-then-read roundtrip preserves frame shape (nested objects + arrays)", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    const payload = {
      kind: "assistant_message",
      run_id: run.id,
      content: "hello",
      tool_calls: [
        { id: "tc1", name: "shell", args: { cmd: "ls" } },
        { id: "tc2", name: "noop", args: {} },
      ],
      meta: { nested: { deep: true, count: 42 } },
    };
    appendRunFrame(run.id, payload);
    const lines = readFrames(run.id);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0]?.frame, payload);
  });
});

test("concurrent appends within one process serialize (no interleaved lines)", async () => {
  await withBackendDir(async () => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    // Fire 50 appends in parallel — appendFileSync is sync, so they
    // serialize at the call site, but the seq increment + file write
    // must still produce 50 well-formed lines with distinct seqs.
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() => appendRunFrame(run.id, { i })),
      ),
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));

    const lines = readFrames(run.id);
    assert.equal(lines.length, 50);
    // Lines must be in seq order on disk (appendFileSync is ordered).
    const onDiskSeqs = lines.map((l) => l.seq);
    assert.deepEqual(onDiskSeqs, Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

test("large frame payload (>4 KiB) still round-trips as a single complete line", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    // Construct a ~10 KiB frame so we exceed PIPE_BUF and any guess
    // about kernel-buffered append atomicity. Single-writer-per-run is
    // the invariant — agent-pool serializes turns per conv — but the
    // consumer must still parse it cleanly.
    const big = "x".repeat(10_000);
    appendRunFrame(run.id, { kind: "big", payload: big });
    const lines = readFrames(run.id);
    assert.equal(lines.length, 1);
    assert.equal((lines[0]?.frame as { payload: string }).payload.length, 10_000);
  });
});

test("frameCount on the handle stays in sync with appended seqs", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    assert.equal(run.frameCount, 0);
    appendRunFrame(run.id, { i: 0 });
    appendRunFrame(run.id, { i: 1 });
    appendRunFrame(run.id, { i: 2 });
    assert.equal(run.frameCount, 3, "handle.frameCount must mirror the last seq");
  });
});

test("malformed trailing line is silently skipped by JSONL readers (resilience)", async () => {
  // Simulates the consumer-side contract: a partial trailing line
  // (e.g. process crashed mid-write — POSIX rarely allows this for
  // sub-PIPE_BUF writes, but the read loop is defensive anyway).
  await withBackendDir(() => {
    const run = createRun({ agentId: "a", conversationId: "c" });
    appendRunFrame(run.id, { kind: "first" });
    appendRunFrame(run.id, { kind: "second" });
    // Hand-corrupt the tail.
    const path = getFramesFilePath(run.id);
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, '{"seq":3,"ts":"2026-05-19T00:00:00Z","frame":{"kind":"third"'); // no closing brace + newline

    // Mirror the subscribeToRun read loop: split on '\n', skip blank
    // lines, try-parse each; the partial trailing line falls out via
    // catch and the consumer keeps the two valid frames.
    const body = readFileSync(path, "utf8");
    const parsed: FrameLine[] = [];
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { parsed.push(JSON.parse(t) as FrameLine); } catch { /* skip */ }
    }
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed.map((p) => (p.frame as { kind: string }).kind), ["first", "second"]);
  });
});
