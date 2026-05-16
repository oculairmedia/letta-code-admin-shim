/**
 * Unit tests for StreamCoalescer.
 *
 * Covers:
 *   - Basic text concatenation within the window (assistant + reasoning)
 *   - Otid-namespaced bucketing
 *   - Tool_call snapshot replace-by-id
 *   - Terminal-status immediate-flush
 *   - Order preservation across frame types
 *   - flushAll / dispose lifecycle
 *   - No-otid edge cases (fallthrough to passthrough)
 *   - No-tool_call_id edge cases
 *   - Re-entrancy safety (onFlush calls back into handle)
 *   - Empty bucket cleanup (no map leak)
 *   - Disposed coalescer falls back to passthrough
 *   - id / otid preservation across coalesced chunks (mobile dedup key)
 *   - date / seq_id reflect latest chunk, not first
 *   - tool_return_message flushes pending tool_call first
 *
 * The tests use a hand-rolled fake-timer driver injected via the
 * `timers` option. node:test has no built-in fake-clock, so we build a
 * minimal one tied to a manual "now" cursor — advanceBy() runs every
 * callback whose deadline has passed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  StreamCoalescer,
  DEFAULT_COALESCE_WINDOW_MS,
  type CoalescerTimers,
} from "../lib/stream-coalescer.js";
import type { LettaMessage } from "../lib/types/wire.js";

interface PendingTimer {
  id: number;
  fireAt: number;
  cb: () => void;
  cleared: boolean;
}

interface FakeTimers extends CoalescerTimers {
  advanceBy(ms: number): void;
  now(): number;
  pendingCount(): number;
}

function makeFakeTimers(): FakeTimers {
  let now = 0;
  let nextId = 1;
  const pending: PendingTimer[] = [];

  const setT: CoalescerTimers["setTimeout"] = (cb, ms) => {
    const t: PendingTimer = { id: nextId++, fireAt: now + ms, cb, cleared: false };
    pending.push(t);
    // node's setTimeout returns a Timeout object; we return our internal
    // record cast as that shape. Only the identity is used by clearTimeout.
    return t as unknown as ReturnType<typeof setTimeout>;
  };

  const clearT: CoalescerTimers["clearTimeout"] = (h) => {
    const target = h as unknown as PendingTimer;
    target.cleared = true;
  };

  return {
    setTimeout: setT,
    clearTimeout: clearT,
    advanceBy(ms: number): void {
      now += ms;
      // Fire all timers whose deadline has now passed, in insertion order.
      // Snapshot the array so callbacks adding new timers don't get fired
      // during the same advance step.
      const due = pending.filter((t) => !t.cleared && t.fireAt <= now);
      for (const t of due) {
        t.cleared = true;
        t.cb();
      }
    },
    now(): number {
      return now;
    },
    pendingCount(): number {
      return pending.filter((t) => !t.cleared).length;
    },
  };
}

function asstFrame(otid: string, content: string, extras: Record<string, unknown> = {}): LettaMessage {
  return {
    message_type: "assistant_message",
    otid,
    content,
    id: `cm-stream-${otid}`,
    date: "2026-05-15T00:00:00.000Z",
    ...extras,
  } as unknown as LettaMessage;
}

function reasonFrame(otid: string, reasoning: string, extras: Record<string, unknown> = {}): LettaMessage {
  return {
    message_type: "reasoning_message",
    otid,
    reasoning,
    id: `cm-reason-${otid}`,
    source: "reasoner_model",
    signature: "",
    date: "2026-05-15T00:00:00.000Z",
    ...extras,
  } as unknown as LettaMessage;
}

function toolCallFrame(tcid: string, args: Record<string, unknown>, status?: string): LettaMessage {
  return {
    message_type: "tool_call_message",
    tool_call: {
      tool_call_id: tcid,
      tool_name: "Bash",
      tool_arguments: JSON.stringify(args),
    },
    tool_call_id: tcid,
    ...(status ? { status } : {}),
  } as unknown as LettaMessage;
}

function toolReturnFrame(tcid: string, result: string): LettaMessage {
  return {
    message_type: "tool_return_message",
    tool_call_id: tcid,
    tool_return: result,
    status: "success",
  } as unknown as LettaMessage;
}

function stopFrame(reason: string = "end_turn"): LettaMessage {
  return { message_type: "stop_reason", stop_reason: reason } as unknown as LettaMessage;
}

function usageFrame(promptTokens = 100, completionTokens = 50): LettaMessage {
  return {
    message_type: "usage_statistics",
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  } as unknown as LettaMessage;
}

// ─── 1. Text concatenation within the window ──────────────────────────

test("text: concatenates N assistant chunks sharing otid into one frame", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  for (let i = 0; i < 10; i++) c.handle(asstFrame("u1", `chunk${i}`));
  assert.equal(flushed.length, 0, "no flush before window elapses");
  timers.advanceBy(200);
  assert.equal(flushed.length, 1, "exactly one flushed frame after window");
  const out = flushed[0] as unknown as { content: string; otid: string; id: string };
  assert.equal(out.content, "chunk0chunk1chunk2chunk3chunk4chunk5chunk6chunk7chunk8chunk9");
  assert.equal(out.otid, "u1", "otid preserved across coalesce");
  assert.equal(out.id, "cm-stream-u1", "mobile dedup id preserved");
});

test("text: reasoning chunks coalesce alongside assistant without crossover", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  // Interleave: 3 reasoning, 3 assistant, both share otid "u1"
  // (legal — they namespace by message_type:otid).
  c.handle(reasonFrame("u1", "Let me "));
  c.handle(asstFrame("u1", "Hi "));
  c.handle(reasonFrame("u1", "think. "));
  c.handle(asstFrame("u1", "there!"));
  c.handle(reasonFrame("u1", "Done."));

  timers.advanceBy(200);
  assert.equal(flushed.length, 2, "one merged reasoning + one merged assistant");
  // Insertion order: reasoning was first, so it should be index 0.
  const r = flushed[0] as unknown as { message_type: string; reasoning: string };
  const a = flushed[1] as unknown as { message_type: string; content: string };
  assert.equal(r.message_type, "reasoning_message");
  assert.equal(r.reasoning, "Let me think. Done.");
  assert.equal(a.message_type, "assistant_message");
  assert.equal(a.content, "Hi there!");
});

test("text: chunks with different otids coalesce into separate frames", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(asstFrame("u1", "Hello "));
  c.handle(asstFrame("u2", "World "));
  c.handle(asstFrame("u1", "from u1"));
  c.handle(asstFrame("u2", "from u2"));

  timers.advanceBy(200);
  assert.equal(flushed.length, 2);
  const byOtid = new Map(flushed.map((f) => {
    const r = f as unknown as { otid: string; content: string };
    return [r.otid, r.content];
  }));
  assert.equal(byOtid.get("u1"), "Hello from u1");
  assert.equal(byOtid.get("u2"), "World from u2");
});

test("text: latest chunk's date and seq_id overwrite, but otid + id stable", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(asstFrame("u1", "a", { date: "2026-05-15T00:00:01.000Z", seq_id: 1 }));
  c.handle(asstFrame("u1", "b", { date: "2026-05-15T00:00:02.000Z", seq_id: 2 }));
  c.handle(asstFrame("u1", "c", { date: "2026-05-15T00:00:03.000Z", seq_id: 3 }));
  timers.advanceBy(200);
  const out = flushed[0] as unknown as { content: string; date: string; seq_id: number; otid: string; id: string };
  assert.equal(out.content, "abc");
  assert.equal(out.date, "2026-05-15T00:00:03.000Z", "date is latest");
  assert.equal(out.seq_id, 3, "seq_id is latest");
  assert.equal(out.otid, "u1", "otid stable");
  assert.equal(out.id, "cm-stream-u1", "id stable for mobile dedup");
});

test("text: signature appends across reasoning chunks", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(reasonFrame("u1", "First. ", { signature: "sig1" }));
  c.handle(reasonFrame("u1", "Second.", { signature: "sig2" }));
  timers.advanceBy(200);

  const out = flushed[0] as unknown as { reasoning: string; signature: string };
  assert.equal(out.reasoning, "First. Second.");
  assert.equal(out.signature, "sig1sig2", "signature concatenates, not replaced");
});

// ─── 2. Tool_call snapshot replace-by-id ──────────────────────────────

test("tool: snapshots with same tool_call_id replace, latest wins on flush", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(toolCallFrame("tc-1", { path: "/" }));
  c.handle(toolCallFrame("tc-1", { path: "/op" }));
  c.handle(toolCallFrame("tc-1", { path: "/opt/stacks" }));
  timers.advanceBy(200);

  assert.equal(flushed.length, 1, "snapshots dedup into one frame");
  const out = flushed[0] as unknown as { tool_call: { tool_arguments: string }; tool_call_id: string };
  assert.equal(out.tool_call_id, "tc-1");
  assert.match(out.tool_call.tool_arguments, /\/opt\/stacks/);
});

test("tool: terminal status flushes immediately without waiting for window", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(toolCallFrame("tc-1", { path: "/op" }));
  assert.equal(flushed.length, 0, "non-terminal does not flush");
  c.handle(toolCallFrame("tc-1", { path: "/opt/stacks" }, "success"));
  assert.equal(flushed.length, 1, "terminal status flushes immediately");
  const out = flushed[0] as unknown as { tool_call_id: string; status: string };
  assert.equal(out.tool_call_id, "tc-1");
  assert.equal(out.status, "success");
});

test("tool: multiple tool_call_ids coalesce independently", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(toolCallFrame("tc-1", { v: 1 }));
  c.handle(toolCallFrame("tc-2", { v: 1 }));
  c.handle(toolCallFrame("tc-1", { v: 2 }));
  c.handle(toolCallFrame("tc-2", { v: 2 }));
  timers.advanceBy(200);

  assert.equal(flushed.length, 2, "two distinct tool_call_ids → two frames");
  const ids = flushed.map((f) => (f as unknown as { tool_call_id: string }).tool_call_id).sort();
  assert.deepEqual(ids, ["tc-1", "tc-2"]);
});

test("tool: tool_return_message flushes pending tool_call snapshot first (order preserved)", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(toolCallFrame("tc-1", { path: "/op" }));
  c.handle(toolReturnFrame("tc-1", "result"));

  assert.equal(flushed.length, 2);
  assert.equal((flushed[0] as unknown as { message_type: string }).message_type, "tool_call_message");
  assert.equal((flushed[1] as unknown as { message_type: string }).message_type, "tool_return_message");
});

// ─── 3. Order preservation across frame types ────────────────────────

test("order: passthrough frame flushes pending text first to preserve order", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(asstFrame("u1", "Hello "));
  c.handle(asstFrame("u1", "world"));
  // stop_reason is a passthrough — must trigger flush of pending text first.
  c.handle(stopFrame());
  assert.equal(flushed.length, 2);
  const a = flushed[0] as unknown as { message_type: string; content: string };
  const s = flushed[1] as unknown as { message_type: string };
  assert.equal(a.message_type, "assistant_message");
  assert.equal(a.content, "Hello world");
  assert.equal(s.message_type, "stop_reason");
});

test("order: usage_statistics + stop_reason both pass through after text flush", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(asstFrame("u1", "Reply"));
  c.handle(stopFrame());
  c.handle(usageFrame(120, 60));
  assert.equal(flushed.length, 3);
  const types = flushed.map((f) => (f as unknown as { message_type: string }).message_type);
  assert.deepEqual(types, ["assistant_message", "stop_reason", "usage_statistics"]);
});

test("order: text + tool + text in same window preserves interleaving", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(asstFrame("u1", "Let me "));
  c.handle(toolCallFrame("tc-1", { p: "/" }, "success")); // terminal → flush
  c.handle(asstFrame("u2", "Done."));
  timers.advanceBy(200);

  assert.equal(flushed.length, 3);
  const types = flushed.map((f) => (f as unknown as { message_type: string }).message_type);
  assert.deepEqual(types, ["assistant_message", "tool_call_message", "assistant_message"]);
  assert.equal((flushed[0] as unknown as { content: string }).content, "Let me ");
  assert.equal((flushed[2] as unknown as { content: string }).content, "Done.");
});

// ─── 4. flushAll / dispose lifecycle ─────────────────────────────────

test("lifecycle: flushAll emits all pending entries on demand", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 10_000, onFlush: (f) => flushed.push(f), timers });

  c.handle(asstFrame("u1", "Partial"));
  c.handle(toolCallFrame("tc-1", { v: 1 }));
  assert.equal(flushed.length, 0);
  c.flushAll();
  assert.equal(flushed.length, 2, "flushAll drains pending without waiting for window");
  assert.equal(c.pendingBucketCount(), 0, "bucket map cleared after flushAll");
});

test("lifecycle: dispose flushes then refuses scheduling but passes through late frames", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(asstFrame("u1", "Buffered"));
  c.dispose();
  assert.equal(flushed.length, 1, "dispose flushes pending");
  // Late frame after dispose: passthrough, no buffering.
  c.handle(asstFrame("u2", "Late"));
  assert.equal(flushed.length, 2, "post-dispose frames pass through immediately");
  // No timers scheduled post-dispose.
  assert.equal(timers.pendingCount(), 0);
});

test("lifecycle: flushAll on empty coalescer is a no-op", () => {
  const flushed: LettaMessage[] = [];
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers: makeFakeTimers() });
  c.flushAll();
  assert.equal(flushed.length, 0);
  assert.equal(c.pendingBucketCount(), 0);
});

test("lifecycle: dispose is idempotent", () => {
  const flushed: LettaMessage[] = [];
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers: makeFakeTimers() });
  c.handle(asstFrame("u1", "x"));
  c.dispose();
  c.dispose();
  assert.equal(flushed.length, 1, "second dispose does not double-flush");
});

// ─── 5. Edge cases: missing identifiers ──────────────────────────────

test("edge: assistant_message without otid passes through (after flushing pending)", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(asstFrame("u1", "Has otid "));
  // Construct a frame with no otid.
  c.handle({ message_type: "assistant_message", content: "No otid" } as unknown as LettaMessage);
  assert.equal(flushed.length, 2);
  assert.equal((flushed[0] as unknown as { content: string }).content, "Has otid ");
  assert.equal((flushed[1] as unknown as { content: string }).content, "No otid");
});

test("edge: tool_call_message without tool_call_id passes through", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle({
    message_type: "tool_call_message",
    tool_call: { tool_name: "Read" },
  } as unknown as LettaMessage);
  assert.equal(flushed.length, 1, "no id → passthrough, no dedup attempt");
});

test("edge: unknown message_type passes through after flushing pending", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  c.handle(asstFrame("u1", "Text"));
  c.handle({ message_type: "ping" } as unknown as LettaMessage);
  c.handle({ message_type: "totally_new_event" } as unknown as LettaMessage);
  assert.equal(flushed.length, 3);
  const types = flushed.map((f) => (f as unknown as { message_type: string }).message_type);
  assert.deepEqual(types, ["assistant_message", "ping", "totally_new_event"]);
});

test("edge: frame missing message_type entirely is passed through", () => {
  const flushed: LettaMessage[] = [];
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers: makeFakeTimers() });
  c.handle({} as unknown as LettaMessage);
  assert.equal(flushed.length, 1);
});

test("edge: null / non-object frame is silently dropped", () => {
  const flushed: LettaMessage[] = [];
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers: makeFakeTimers() });
  c.handle(null as unknown as LettaMessage);
  c.handle(undefined as unknown as LettaMessage);
  c.handle("not an object" as unknown as LettaMessage);
  assert.equal(flushed.length, 0, "non-object inputs are no-ops");
});

// ─── 6. Re-entrancy: onFlush calls back into handle ──────────────────

test("re-entrancy: onFlush calling handle() does not corrupt state", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  let recursionGuard = false;
  const c: StreamCoalescer = new StreamCoalescer({
    windowMs: 200,
    onFlush: (f) => {
      flushed.push(f);
      // After the FIRST flushed text, push a new tool frame back through.
      // This shouldn't crash, double-flush, or skew the bucket map.
      if (!recursionGuard && (f as unknown as { message_type: string }).message_type === "assistant_message") {
        recursionGuard = true;
        c.handle(toolCallFrame("tc-recursive", { v: 1 }, "success"));
      }
    },
    timers,
  });

  c.handle(asstFrame("u1", "A"));
  c.handle(asstFrame("u1", "B"));
  timers.advanceBy(200);

  // The flushed array now contains: [assistant("AB"), tool_call(tc-recursive)]
  // because the recursive handle() saw a terminal-status tool and flushed
  // immediately while we were already draining.
  assert.equal(flushed.length, 2);
  assert.equal((flushed[0] as unknown as { content: string }).content, "AB");
  assert.equal((flushed[1] as unknown as { message_type: string }).message_type, "tool_call_message");
  assert.equal(c.pendingBucketCount(), 0, "no orphaned buckets after re-entrancy");
});

// ─── 7. Frame-count reduction (the headline metric) ─────────────────

test("golden: 50 chunks within a single window collapse to 1 frame", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  let expected = "";
  for (let i = 0; i < 50; i++) {
    const piece = `t${i} `;
    expected += piece;
    c.handle(asstFrame("u1", piece));
  }
  timers.advanceBy(200);

  assert.equal(flushed.length, 1, "50 chunks → 1 frame");
  assert.equal((flushed[0] as unknown as { content: string }).content, expected);
});

test("golden: spread across 5 windows → 5 frames (one per window)", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  // 5 chunks per window, 5 windows total = 25 chunks → 5 frames
  for (let w = 0; w < 5; w++) {
    for (let i = 0; i < 5; i++) c.handle(asstFrame("u1", `w${w}c${i} `));
    timers.advanceBy(200);
  }
  assert.equal(flushed.length, 5, "one flush per window");
  // Each window's content concatenates within itself.
  const contents = flushed.map((f) => (f as unknown as { content: string }).content);
  contents.forEach((s, w) => {
    for (let i = 0; i < 5; i++) {
      assert.ok(s.includes(`w${w}c${i}`), `window ${w} should contain c${i}: got "${s}"`);
    }
  });
});

test("golden: frame reduction ≥10× for a chatty turn (200 chunks)", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  // Simulate 200 chunks of ~3 tokens each arriving at 5ms cadence — typical
  // for a model that emits 200 tokens/sec in small batches. Time spans
  // 200 * 5ms = 1000ms total → 5 windows.
  for (let i = 0; i < 200; i++) {
    c.handle(asstFrame("u1", `tok${i} `));
    timers.advanceBy(5);
  }
  // Final flush so trailing content is captured.
  c.flushAll();

  // We don't pin exact frame count (timer race semantics vary), but we
  // demand at least 10× reduction. 200 chunks → ≤20 frames.
  assert.ok(flushed.length <= 20, `expected ≤20 frames, got ${flushed.length}`);
  assert.ok(flushed.length >= 1);
  // No content lost: total concatenated length matches.
  const allContent = flushed.map((f) => (f as unknown as { content: string }).content).join("");
  let expected = "";
  for (let i = 0; i < 200; i++) expected += `tok${i} `;
  assert.equal(allContent, expected, "byte-perfect content preservation");
});

// ─── 8. Bucket / memory cleanup ─────────────────────────────────────

test("memory: flushed buckets are deleted (no leak across many turns)", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers });

  for (let turn = 0; turn < 100; turn++) {
    c.handle(asstFrame(`turn-${turn}`, "x"));
    c.handle(stopFrame()); // passthrough → flushes the bucket
    assert.equal(c.pendingBucketCount(), 0, `bucket leaked at turn ${turn}`);
  }
  assert.equal(flushed.length, 200, "every frame emitted exactly once");
});

test("memory: empty bucket created by an unknown frame doesn't linger", () => {
  const flushed: LettaMessage[] = [];
  const c = new StreamCoalescer({ windowMs: 200, onFlush: (f) => flushed.push(f), timers: makeFakeTimers() });
  c.handle({ message_type: "ping" } as unknown as LettaMessage);
  assert.equal(c.pendingBucketCount(), 0);
});

// ─── 9. Default-construction sanity ──────────────────────────────────

test("default: constructed with no windowMs uses DEFAULT_COALESCE_WINDOW_MS", () => {
  const flushed: LettaMessage[] = [];
  const timers = makeFakeTimers();
  const c = new StreamCoalescer({ onFlush: (f) => flushed.push(f), timers });

  c.handle(asstFrame("u1", "x"));
  timers.advanceBy(DEFAULT_COALESCE_WINDOW_MS - 1);
  assert.equal(flushed.length, 0, "no flush 1ms before default window");
  timers.advanceBy(1);
  assert.equal(flushed.length, 1, "flush exactly at default window");
});

test("default: constructed with no timers uses real timers (smoke)", async () => {
  // We don't drive real time; just confirm the constructor + handle + dispose
  // path doesn't throw or hang when real timers are used. Dispose flushes
  // synchronously so we get the frame back without sleeping.
  const flushed: LettaMessage[] = [];
  const c = new StreamCoalescer({ windowMs: 50, onFlush: (f) => flushed.push(f) });
  c.handle(asstFrame("u1", "real"));
  c.dispose();
  assert.equal(flushed.length, 1);
});
