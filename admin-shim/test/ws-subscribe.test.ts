/**
 * Behavioral tests for the WS subscribe(run_id, cursor) protocol (lcp-p74.2).
 *
 * Pinned contracts:
 *   - subscribe(run, 0) replays the whole frame log.
 *   - subscribe(run, seq) replays only frames with seq > cursor.
 *   - Live-tail: appending to frames.jsonl while subscribed produces
 *     subscribe_frame envelopes for the new entries.
 *   - Subscribe on an unknown run yields an error frame (run_not_found)
 *     and the socket stays open.
 *   - When the run reaches a terminal state, subscribe_done is emitted
 *     and carries the last seq + status.
 *
 * Seeds runs by writing run.json + frames.jsonl directly into the
 * shim's `LETTA_LOCAL_BACKEND_DIR/runs/<id>/` so the test doesn't need
 * to drive a real letta-code worker turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openMobileWs, startShim } from "./helpers/index.js";
import type { MobileWsFrame, MobileWsHandle } from "./helpers/ws.js";
import type { ShimHandle } from "./helpers/shim.js";

interface SubscribeFrame extends MobileWsFrame {
  run_id: string;
  seq: number;
  frame: unknown;
}
interface SubscribeDoneFrame extends MobileWsFrame {
  run_id: string;
  last_seq: number;
  status: string;
}
interface ErrorFrame extends MobileWsFrame {
  code: string;
  message: string;
}

interface SeededFrame {
  seq: number;
  frame: { message_type: string; content?: string; [k: string]: unknown };
}

function seedRun(
  shim: ShimHandle,
  runId: string,
  frames: SeededFrame[],
  status: "running" | "completed" | "failed" | "cancelled" = "completed",
  extra: Record<string, unknown> = {},
): void {
  const dir = join(shim.stateDir, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      id: runId,
      agent_id: "agent-a",
      conversation_id: "default",
      status,
      created_at: "2026-05-18T10:00:00.000Z",
      completed_at: status === "completed" ? "2026-05-18T10:01:00.000Z" : null,
      message_ids: [],
      tools_used: [],
      num_steps: 0,
      ...extra,
    }),
  );
  for (const f of frames) {
    appendFileSync(
      join(dir, "frames.jsonl"),
      JSON.stringify({ seq: f.seq, ts: "2026-05-18T10:00:00.000Z", frame: f.frame }) + "\n",
    );
  }
}

/**
 * Fresh-cursor waitFor (cron-ws.test.ts pattern). The shared
 * MobileWsHandle.waitFor returns cached frames, which trips request/
 * response flows that emit the same type repeatedly.
 */
async function waitNew<T extends MobileWsFrame>(
  conn: MobileWsHandle,
  type: string,
  timeoutMs = 5000,
): Promise<T> {
  const cursor = conn.frames.length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = cursor; i < conn.frames.length; i++) {
      const f = conn.frames[i];
      if (f && f.type === type) return f as T;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitNew(${type}) timeout`);
}

async function collectSubscribeReplay(
  conn: MobileWsHandle,
  runId: string,
  cursor: number,
): Promise<{ frames: SubscribeFrame[]; done: SubscribeDoneFrame }> {
  const start = conn.frames.length;
  conn.send({ type: "subscribe", run_id: runId, cursor });
  const done = await waitNew<SubscribeDoneFrame>(conn, "subscribe_done", 5000);
  const frames: SubscribeFrame[] = [];
  for (let i = start; i < conn.frames.length; i++) {
    const f = conn.frames[i];
    if (f && f.type === "subscribe_frame") frames.push(f as SubscribeFrame);
  }
  return { frames, done };
}

test("subscribe(run, 0) replays the whole frame log + emits subscribe_done", async () => {
  const shim = await startShim();
  try {
    const runId = "run-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    seedRun(shim, runId, [
      { seq: 1, frame: { message_type: "assistant_message", content: "hi" } },
      { seq: 2, frame: { message_type: "reasoning_message", content: "thinking" } },
      { seq: 3, frame: { message_type: "stop_reason", stop_reason: "end_turn" } },
    ]);

    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      const { frames, done } = await collectSubscribeReplay(conn, runId, 0);
      assert.equal(frames.length, 3, "all 3 seeded frames replay");
      assert.deepEqual(frames.map((f) => f.seq), [1, 2, 3]);
      assert.equal(done.last_seq, 3);
      assert.equal(done.status, "completed");
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("subscribe replay includes terminal stop_reason and usage tail frames", async () => {
  const shim = await startShim();
  try {
    const runId = "run-terminal-1111-2222-3333-444444444444";
    seedRun(shim, runId, [
      { seq: 1, frame: { message_type: "assistant_message", content: "hi" } },
      { seq: 2, frame: { message_type: "stop_reason", stop_reason: "end_turn" } },
      {
        seq: 3,
        frame: {
          message_type: "usage_statistics",
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
        },
      },
    ]);

    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      const { frames, done } = await collectSubscribeReplay(conn, runId, 0);
      assert.deepEqual(frames.map((f) => f.seq), [1, 2, 3]);
      assert.deepEqual(
        frames.map((f) => (f.frame as { message_type: string }).message_type),
        ["assistant_message", "stop_reason", "usage_statistics"],
      );
      assert.equal(done.last_seq, 3);
      assert.equal(done.status, "completed");
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("subscribe(run, seq) replays only frames with seq > cursor", async () => {
  const shim = await startShim();
  try {
    const runId = "run-cursor11-2222-3333-4444-555555555555";
    seedRun(shim, runId, [
      { seq: 1, frame: { message_type: "assistant_message", content: "a" } },
      { seq: 2, frame: { message_type: "assistant_message", content: "b" } },
      { seq: 3, frame: { message_type: "assistant_message", content: "c" } },
      { seq: 4, frame: { message_type: "assistant_message", content: "d" } },
    ]);

    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      const { frames, done } = await collectSubscribeReplay(conn, runId, 2);
      assert.equal(frames.length, 2, "only seqs 3 and 4 replay");
      assert.deepEqual(frames.map((f) => f.seq), [3, 4]);
      assert.equal(done.last_seq, 4);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("subscribe live-tails new frames appended after subscription", async () => {
  const shim = await startShim();
  try {
    // Status: 'running' so subscribe stays open instead of going terminal.
    const runId = "run-live1234-5678-9abc-def0-fedcba987654";
    seedRun(shim, runId, [
      { seq: 1, frame: { message_type: "assistant_message", content: "first" } },
    ], "running");

    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      // Open subscription — receive seq 1 right away.
      conn.send({ type: "subscribe", run_id: runId, cursor: 0 });
      const initial = await waitNew<SubscribeFrame>(conn, "subscribe_frame", 3000);
      assert.equal(initial.seq, 1);

      // Now append a new line to the frame log; fs.watch fires.
      const framesPath = join(shim.stateDir, "runs", runId, "frames.jsonl");
      appendFileSync(
        framesPath,
        JSON.stringify({
          seq: 2,
          ts: "2026-05-18T10:01:00.000Z",
          frame: { message_type: "assistant_message", content: "second" },
        }) + "\n",
      );

      const next = await waitNew<SubscribeFrame>(conn, "subscribe_frame", 3000);
      assert.equal(next.seq, 2);
      assert.equal(
        (next.frame as { content: string }).content,
        "second",
      );
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("subscribe on an unknown run yields error{run_not_found}; socket stays open", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      conn.send({ type: "subscribe", run_id: "run-does-not-exist", cursor: 0 });
      const err = await waitNew<ErrorFrame>(conn, "error", 3000);
      assert.equal(err.code, "run_not_found");
      assert.match(err.message, /no frames recorded/);

      // Socket should still be alive — verify with a cron_list.
      conn.send({ type: "cron_list" });
      await waitNew<MobileWsFrame>(conn, "cron_list_response", 3000);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("subscribe without run_id yields error{protocol_violation}; socket stays open", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      conn.send({ type: "subscribe", cursor: 0 });
      const err = await waitNew<ErrorFrame>(conn, "error", 3000);
      assert.equal(err.code, "protocol_violation");
      assert.match(err.message, /run_id/);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("subscribe to a user-cancelled terminal run emits subscribe_done without replay", async () => {
  const shim = await startShim();
  try {
    const runId = "run-userstop-1111-2222-3333-444444444444";
    seedRun(shim, runId, [
      { seq: 1, frame: { message_type: "assistant_message", content: "stale" } },
    ], "cancelled", {
      completed_at: "2026-05-18T10:01:00.000Z",
      stop_reason: "user_cancelled",
      metadata: { user_stopped: true },
    });

    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      const { frames, done } = await collectSubscribeReplay(conn, runId, 0);
      assert.equal(frames.length, 0, "user-stopped terminal runs are not replayed/live-tailed");
      assert.equal(done.status, "cancelled");
      assert.equal(done.last_seq, 0);
      assert.equal((done as SubscribeDoneFrame & { user_stopped?: boolean }).user_stopped, true);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("subscribe to a completed run emits subscribe_done with the run's status", async () => {
  const shim = await startShim();
  try {
    const runId = "run-failedrr-1111-2222-3333-444444444444";
    seedRun(shim, runId, [
      { seq: 1, frame: { message_type: "assistant_message", content: "x" } },
    ], "failed");

    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      const { done } = await collectSubscribeReplay(conn, runId, 0);
      assert.equal(done.status, "failed");
      assert.equal(done.last_seq, 1);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("re-subscribing to the same run replaces the prior subscription (idempotent)", async () => {
  const shim = await startShim();
  try {
    const runId = "run-resub111-2222-3333-4444-555555555555";
    seedRun(shim, runId, [
      { seq: 1, frame: { message_type: "assistant_message", content: "a" } },
    ], "running");

    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      // First subscribe — replays seq 1.
      conn.send({ type: "subscribe", run_id: runId, cursor: 0 });
      const first = await waitNew<SubscribeFrame>(conn, "subscribe_frame", 3000);
      assert.equal(first.seq, 1);

      // Second subscribe at cursor 0 — should also receive seq 1 again
      // (a fresh replay, since this is a re-subscribe with cursor reset).
      conn.send({ type: "subscribe", run_id: runId, cursor: 0 });
      const second = await waitNew<SubscribeFrame>(conn, "subscribe_frame", 3000);
      assert.equal(second.seq, 1);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});
