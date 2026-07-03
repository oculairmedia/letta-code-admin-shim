/**
 * lcp xwi3z (§2a): StreamCoalescer wiring in bridgeSendMessage.
 *
 * Covers (per the shim-perf design test plan):
 *   (a) N small deltas → fewer emitted frames with concatenated delta text
 *   (b) flushAll emits pending content strictly before stop_reason
 *   (d) per-run seq strictly monotonic on emitted frames
 *   (e) first delta of a turn is emitted without waiting a window (TTFT)
 *   (f) A2UI-split frames interleaved with deltas preserve per-otid
 *       splitter state and ordering across the coalescer seam
 *   (g) tool_call / tool_return frames pass through the pipeline body in
 *       order with coalescing ON (the OFF twin lives in
 *       mobile-channel-host-coalescer-off.test.ts — same scripts, 1:1)
 *
 * (c) SHIM_STREAM_COALESCE=0 passthrough is in the -off test file: the
 * gate is a module-level const, so it needs its own process.
 *
 * The pool is monkeypatched (same pattern as mobile-channel-bridge.test.ts)
 * so no real SDK session spawns; fake timers are injected through
 * _streamCoalesceTestHooks so windows advance deterministically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate all disk side effects (run records, frames.jsonl, cursors).
const backendDir = mkdtempSync(join(tmpdir(), "coalescer-host-"));
process.env["LETTA_LOCAL_BACKEND_DIR"] = backendDir;
process.on("exit", () => rmSync(backendDir, { recursive: true, force: true }));

import { bridgeSendMessage, _streamCoalesceTestHooks } from "../lib/mobile-channel-host.js";
import { getAgentPool } from "../lib/agent-pool.js";
import type { CoalescerTimers } from "../lib/stream-coalescer.js";
import type { A2uiCapability } from "../lib/a2ui-adapter.js";

// ── fake timers (same pattern as test/stream-coalescer.test.ts) ────────

interface PendingTimer {
  id: number;
  fireAt: number;
  cb: () => void;
  cleared: boolean;
}

interface FakeTimers extends CoalescerTimers {
  advanceBy(ms: number): void;
}

function makeFakeTimers(): FakeTimers {
  let now = 0;
  let nextId = 1;
  const pending: PendingTimer[] = [];
  return {
    setTimeout: (cb, ms) => {
      const t: PendingTimer = { id: nextId++, fireAt: now + ms, cb, cleared: false };
      pending.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (h) => {
      (h as unknown as PendingTimer).cleared = true;
    },
    advanceBy(ms: number): void {
      now += ms;
      const due = pending.filter((t) => !t.cleared && t.fireAt <= now);
      for (const t of due) {
        t.cleared = true;
        t.cb();
      }
    },
  };
}

// ── harness ─────────────────────────────────────────────────────────────

type RawFrame = Record<string, unknown>;
type Step = { frame: RawFrame } | { advance: number } | { probe: () => void };

interface TurnResult {
  emitted: Array<Record<string, unknown>>;
}

let turnCounter = 0;

/**
 * Drive one bridgeSendMessage turn with a scripted raw-frame sequence.
 * `{advance}` steps move the fake clock; `{probe}` steps run assertions
 * mid-stream (e.g. TTFT).
 */
async function runScriptedTurn(
  steps: Step[],
  opts: { a2ui?: A2uiCapability | null; sink?: Array<Record<string, unknown>> } = {},
): Promise<TurnResult> {
  const timers = makeFakeTimers();
  _streamCoalesceTestHooks.timers = timers;
  const pool = getAgentPool();
  const originalRunTurn = pool.runTurnWithHeal;
  const emitted: Array<Record<string, unknown>> = opts.sink ?? [];
  turnCounter += 1;
  const agentId = `agent-coal-${turnCounter}`;
  const convId = `conv-coal-${turnCounter}`;

  pool.runTurnWithHeal = (async (
    _convId: string,
    _agentId: string,
    _content: unknown,
    turnOpts: { onFrame?: (raw: unknown, meta: { runId: string }) => void; runHandle?: { id: string } },
  ) => {
    const runId = turnOpts.runHandle?.id ?? "run-test";
    for (const step of steps) {
      if ("frame" in step) turnOpts.onFrame?.(step.frame, { runId });
      else if ("advance" in step) timers.advanceBy(step.advance);
      else step.probe();
    }
    return { frames: [], done: true, stderr: "" };
  }) as typeof pool.runTurnWithHeal;

  try {
    await bridgeSendMessage(
      {
        agent_id: agentId,
        conversation_id: convId,
        text: "hello",
        a2ui_capability: opts.a2ui ?? null,
      },
      (frame) => emitted.push(frame as unknown as Record<string, unknown>),
    );
  } finally {
    pool.runTurnWithHeal = originalRunTurn;
    _streamCoalesceTestHooks.timers = null;
    _streamCoalesceTestHooks.windowMs = null;
  }
  return { emitted };
}

function assistant(otid: string, content: string): RawFrame {
  return { message_type: "assistant_message", otid, content };
}

function ofType(frames: Array<Record<string, unknown>>, mt: string): Array<Record<string, unknown>> {
  return frames.filter((f) => f["message_type"] === mt);
}

// ── tests ───────────────────────────────────────────────────────────────

test("(a)+(e) first delta passes through immediately; subsequent deltas coalesce into one frame", async () => {
  const counts: number[] = [];
  const emitted: Array<Record<string, unknown>> = [];
  const { emitted: harnessEmitted } = await runScriptedTurn([
    { frame: assistant("o1", "a") },
    // (e) TTFT: the first coalescible delta must be on the wire
    // synchronously — no window wait.
    { probe: () => counts.push(emitted.length) },
    { frame: assistant("o1", "b") },
    { frame: assistant("o1", "c") },
    { frame: assistant("o1", "d") },
    { frame: assistant("o1", "e") },
    // (a) subsequent deltas buffer until the window fires…
    { probe: () => counts.push(emitted.length) },
    { advance: 200 },
    // …then flush as ONE concatenated frame.
    { probe: () => counts.push(emitted.length) },
  ], { sink: emitted });
  assert.equal(harnessEmitted, emitted);

  assert.deepEqual(counts, [1, 1, 2], "passthrough first delta, buffer the rest, one flush");
  const assistants = ofType(emitted, "assistant_message");
  assert.equal(assistants.length, 2, `5 deltas in → 2 frames out, got ${assistants.length}`);
  assert.equal(assistants[0]!["content"], "a");
  assert.equal(assistants[1]!["content"], "bcde", "coalesced deltas concatenate");
  // Stable per-otid dedup id preserved on both frames.
  assert.equal(assistants[0]!["id"], "cm-stream-o1");
  assert.equal(assistants[1]!["id"], "cm-stream-o1");
});

test("(b) end-of-turn flush emits pending content strictly before stop_reason", async () => {
  const { emitted } = await runScriptedTurn([
    { frame: assistant("o1", "hello ") },
    { frame: assistant("o1", "world") }, // buffered — never flushed by timer
    { frame: { message_type: "stop_reason", stop_reason: "end_turn" } },
    // no advance: the coalescer window never fires; flushAll must cover it
  ]);
  const types = emitted.map((f) => f["message_type"]);
  const stopIdx = types.indexOf("stop_reason");
  assert.ok(stopIdx >= 0, "stop_reason emitted");
  assert.equal(stopIdx, types.length - 1, "stop_reason is last");
  const assistants = ofType(emitted, "assistant_message");
  const text = assistants.map((f) => f["content"]).join("");
  assert.equal(text, "hello world", "all buffered content flushed before stop");
});

test("(d) emitted frames carry strictly monotonic per-run seq", async () => {
  const { emitted } = await runScriptedTurn([
    { frame: assistant("o1", "a") },
    { frame: assistant("o1", "b") },
    { advance: 200 },
    { frame: { message_type: "tool_call_message", otid: "o1", tool_call: { tool_call_id: "tc-1", name: "Bash", arguments: "{}" } } },
    { frame: assistant("o1", "c") },
    { advance: 200 },
    { frame: { message_type: "stop_reason", stop_reason: "end_turn" } },
  ]);
  const seqs = emitted
    .map((f) => f["seq"])
    .filter((s): s is number => typeof s === "number");
  assert.ok(seqs.length >= 4, `expected stamped seqs, got ${JSON.stringify(seqs)}`);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i]! > seqs[i - 1]!, `seq must be strictly monotonic: ${JSON.stringify(seqs)}`);
  }
});

test("(f) A2UI splitter state survives coalescing — tag split across passthrough and coalesced deltas", async () => {
  const a2ui: A2uiCapability = {
    version: "0.9",
    catalogId: "test-catalog",
    supportedCatalogs: ["test-catalog"],
    supportedWidgets: ["Text"],
  };
  const { emitted } = await runScriptedTurn(
    [
      // First delta (passthrough) ends INSIDE the opening tag — the
      // per-otid splitter must hold the partial tag across the seam.
      { frame: assistant("o1", "before <a2ui-js") },
      { frame: assistant("o1", 'on>{"catalogId":"test-catalog","widget":{"type":"Text"}}</a2ui-json> after') },
      { advance: 200 },
      { frame: { message_type: "stop_reason", stop_reason: "end_turn" } },
    ],
    { a2ui },
  );
  const a2uiFrames = ofType(emitted, "a2ui_frame");
  assert.equal(a2uiFrames.length, 1, `exactly one a2ui frame, got ${a2uiFrames.length}`);
  const assistants = ofType(emitted, "assistant_message");
  const text = assistants.map((f) => f["content"]).join("");
  assert.equal(text, "before  after", "tag bytes never leak into visible text");
  // Ordering: the a2ui frame comes after the text delta that produced it.
  const firstA2uiIdx = emitted.findIndex((f) => f["message_type"] === "a2ui_frame");
  const firstTextIdx = emitted.findIndex((f) => f["message_type"] === "assistant_message");
  assert.ok(firstTextIdx < firstA2uiIdx, "leading text precedes the a2ui frame");
  const stopIdx = emitted.findIndex((f) => f["message_type"] === "stop_reason");
  assert.ok(firstA2uiIdx < stopIdx, "a2ui frame precedes stop_reason");
});

test("(g) tool_call / tool_return pass through the pipeline in order with coalescing on", async () => {
  const { emitted } = await runScriptedTurn([
    { frame: assistant("o1", "let me check") },
    { frame: { message_type: "tool_call_message", otid: "o1", tool_call: { tool_call_id: "tc-9", name: "Bash", arguments: "{}" }, status: "running" } },
    { frame: { message_type: "tool_return_message", tool_call_id: "tc-9", status: "success", tool_return: "done", stdout: null, stderr: null } },
    { frame: assistant("o1", " — done") },
    { advance: 200 },
    { frame: { message_type: "stop_reason", stop_reason: "end_turn" } },
  ]);
  const types = emitted.map((f) => f["message_type"]);
  const callIdx = types.indexOf("tool_call_message");
  const returnIdx = types.indexOf("tool_return_message");
  assert.ok(callIdx >= 0 && returnIdx >= 0, `tool frames present: ${JSON.stringify(types)}`);
  assert.ok(callIdx < returnIdx, "tool_return follows its tool_call");
  const ret = emitted[returnIdx]!;
  assert.equal(ret["tool_call_id"], "tc-9");
  assert.equal(ret["status"], "success");
  // Text before the call and after the return both arrive, in order.
  const text = ofType(emitted, "assistant_message").map((f) => f["content"]).join("");
  assert.equal(text, "let me check — done");
  assert.equal(types[types.length - 1], "stop_reason");
});
