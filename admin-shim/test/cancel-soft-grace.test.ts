/**
 * lcp hr5rw (§3c) — cancel soft-grace: observe the CLI's post-interrupt
 * ack instead of unconditionally force-evicting the warm worker.
 *
 * Pinned contracts:
 *   - Interrupt ack within the grace window → NO forceEvict, worker stays
 *     warm and is reusable for a second turn.
 *   - Cancel + immediate re-send: the second turn's stream starts only
 *     after the drain consumed the interrupt ack (drain is SERIALIZED on
 *     this.chain — never detached), and it receives ALL of its own frames
 *     (none stolen by the drain).
 *   - No ack within the grace window → the existing backstop fires
 *     (onCancelGraceExpired + close).
 *   - Synthesized-settlement consistency guard: an ack does NOT keep the
 *     worker when finalizeTurnLifecycle synthesized tool_result
 *     settlements (CLI snapshot disagrees with disk — lcp-0vi hazard).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const backendDir = mkdtempSync(join(tmpdir(), "cancel-soft-grace-"));
process.env["LETTA_LOCAL_BACKEND_DIR"] = backendDir;
process.on("exit", () => rmSync(backendDir, { recursive: true, force: true }));

import { SdkBackedLettaSessionAdapter } from "../lib/letta-sdk-adapter.js";
import { cancelRun } from "../lib/runs.js";
import type { SDKMessage } from "@letta-ai/letta-code-sdk";
import type { LettaStreamFrame } from "../lib/types/letta-stream.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ControlledSession {
  session: unknown;
  push: (m: SDKMessage) => void;
  trace: { sent: unknown[]; aborted: number; closed: number; onAbort: (() => void) | null };
}

/**
 * Push-driven stub session. Mirrors the SDK's shared-buffer semantics:
 * every stream() generator consumes from ONE queue — each buffered message
 * goes to exactly one consumer, which is precisely why a detached drain
 * would steal a new turn's frames.
 */
function makeControlledSession(): ControlledSession {
  const queue: SDKMessage[] = [];
  const waiters: Array<() => void> = [];
  const trace: ControlledSession["trace"] = { sent: [], aborted: 0, closed: 0, onAbort: null };
  const push = (m: SDKMessage): void => {
    queue.push(m);
    for (const w of waiters.splice(0)) w();
  };
  const session = {
    async send(m: unknown): Promise<void> {
      trace.sent.push(m);
    },
    async *stream(): AsyncGenerator<SDKMessage> {
      while (true) {
        while (queue.length === 0) {
          await new Promise<void>((res) => waiters.push(res));
        }
        yield queue.shift()!;
      }
    },
    async abort(): Promise<void> {
      trace.aborted += 1;
      trace.onAbort?.();
    },
    close(): void {
      trace.closed += 1;
    },
    initialize(): never {
      throw new Error("stub: not used");
    },
  };
  return { session, push, trace };
}

function assistantEvent(otid: string, text: string, uuid: string): SDKMessage {
  return {
    type: "stream_event",
    event: {
      message_type: "assistant_message",
      id: uuid,
      date: "2026-01-01T00:00:01.000Z",
      agent_id: "agent-x",
      conversation_id: "default",
      run_id: "r",
      seq_id: 1,
      otid,
      content: [{ type: "text", text }],
    },
    uuid,
  } as unknown as SDKMessage;
}

function resultMsg(success: boolean): SDKMessage {
  return {
    type: "result",
    success,
    result: "",
    durationMs: 1,
    conversationId: "default",
    runIds: [],
  } as unknown as SDKMessage;
}

function makeAdapter(agentId: string, session: unknown): SdkBackedLettaSessionAdapter {
  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId });
  (adapter as unknown as { session: unknown }).session = session;
  (adapter as unknown as { ready: boolean }).ready = true;
  return adapter;
}

test("interrupt ack within grace → no forceEvict; worker reusable; re-send waits for the ack and keeps its frames", async () => {
  process.env["SHIM_CANCEL_GRACE_MS"] = "2000";
  const { session, push, trace } = makeControlledSession();
  const adapter = makeAdapter("agent-warm", session);

  const graceExpired: string[] = [];
  let runId: string | null = null;
  const framesA: LettaStreamFrame[] = [];

  // Emit the interrupt ack 150ms after abort() — the CLI unwinding.
  trace.onAbort = () => {
    setTimeout(() => push(resultMsg(false)), 150);
  };

  const turnA = adapter.runTurn("first", {
    onFrame: (f) => framesA.push(f),
    onRunCreated: (id) => { runId = id; },
    onCancelGraceExpired: (id) => graceExpired.push(id),
  });

  // Let the turn start streaming, then cancel mid-delta.
  await sleep(30);
  push(assistantEvent("oA", "partial", "uA1"));
  await sleep(30);
  assert.ok(runId, "run id captured");
  assert.equal(cancelRun(runId!), true);

  const resA = await turnA;
  assert.equal(resA.cancelled, true);

  // Immediate re-send on the same worker — chained behind the drain.
  const framesB: LettaStreamFrame[] = [];
  const turnB = adapter.runTurn("second", { onFrame: (f) => framesB.push(f) });

  // B's stream must not start until the drain consumed the ack: its send()
  // lands only after the chain (drain included) unwinds.
  assert.equal(trace.sent.length, 1, "second send must wait for the interrupt-ack drain");

  // Wait for B's send (drain done), then feed B its own frames.
  const deadline = Date.now() + 3000;
  while (trace.sent.length < 2 && Date.now() < deadline) await sleep(10);
  assert.equal(trace.sent.length, 2, "second turn started after the drain");

  push(assistantEvent("oB", "fresh", "uB1"));
  push(resultMsg(true));
  const resB = await turnB;

  assert.equal(resB.done, true, "second turn completes on the warm worker");
  assert.equal(graceExpired.length, 0, "grace backstop never fired");
  assert.equal(trace.closed, 0, "worker was not closed");
  assert.equal(adapter.dead, false);
  // B received all of ITS frames — none consumed by the drain.
  const bTexts = framesB
    .filter((f) => f.type === "stream_event")
    .map((f) => JSON.stringify((f as { event: unknown }).event));
  assert.equal(bTexts.length, 1, `B keeps its own delta, got ${bTexts.length}`);
  assert.ok(bTexts[0]!.includes("fresh"));
  assert.equal(adapter.pendingTurns(), 0, "chain fully drained");
});

test("pending cancel-drain counts in pendingTurns() so the worker is not cap-evictable before the ack", async () => {
  process.env["SHIM_CANCEL_GRACE_MS"] = "2000";
  const { session, push, trace } = makeControlledSession();
  const adapter = makeAdapter("agent-drain-count", session);

  let runId: string | null = null;
  trace.onAbort = () => {
    setTimeout(() => push(resultMsg(false)), 250); // ack well after turn A settles
  };

  const turnA = adapter.runTurn("first", {
    onFrame: () => {},
    onRunCreated: (id) => { runId = id; },
    onCancelGraceExpired: () => {},
  });

  await sleep(30);
  push(assistantEvent("oA", "partial", "uA1"));
  await sleep(30);
  assert.equal(cancelRun(runId!), true);

  const resA = await turnA;
  assert.equal(resA.cancelled, true);

  // Turn A settled: busy is false, but the chained interrupt-ack drain is
  // still pending. Without counting the drain in pendingTurns(), the pool's
  // settle-driven capacity drain would see this worker as evictable, close
  // it, and let a same-key replacement spawn that turn A's still-armed
  // grace timer would then forceEvict mid-turn.
  await sleep(20); // let turn A's settle bookkeeping (finally) run
  assert.equal(adapter.busy, false, "turn A fully settled (not busy)");
  assert.ok(adapter.pendingTurns() > 0, "pending cancel-drain must count in pendingTurns()");

  // Ack consumed → drain resolves → worker warm AND evictable again.
  const deadline = Date.now() + 2000;
  while (adapter.pendingTurns() > 0 && Date.now() < deadline) await sleep(10);
  assert.equal(adapter.pendingTurns(), 0, "drain settled after the ack");
  assert.equal(trace.closed, 0, "worker stayed warm throughout");
  assert.equal(adapter.dead, false);
});

test("no ack within grace → backstop fires (onCancelGraceExpired + close)", async () => {
  process.env["SHIM_CANCEL_GRACE_MS"] = "150";
  const { session, push, trace } = makeControlledSession();
  const adapter = makeAdapter("agent-evict", session);

  const graceExpired: string[] = [];
  let runId: string | null = null;

  const turnA = adapter.runTurn("first", {
    onFrame: () => {},
    onRunCreated: (id) => { runId = id; },
    onCancelGraceExpired: (id) => graceExpired.push(id),
  });

  await sleep(30);
  push(assistantEvent("oA", "partial", "uA1"));
  await sleep(30);
  assert.equal(cancelRun(runId!), true);

  const resA = await turnA;
  assert.equal(resA.cancelled, true);

  await sleep(400); // grace (150ms) expires with no ack
  assert.deepEqual(graceExpired, [runId], "backstop fired exactly once");
  assert.ok(trace.closed >= 1, "worker closed by the backstop");
  assert.equal(adapter.dead, true);
});

test("synthesized settlements → evict despite a clean interrupt ack (lcp-0vi guard)", async () => {
  process.env["SHIM_CANCEL_GRACE_MS"] = "500";
  const agentId = "agent-synth";
  // Seed agent + default conversation so turn settlement can write the
  // synthetic toolResult to messages.jsonl.
  const b64 = (s: string): string => Buffer.from(s).toString("base64url");
  mkdirSync(join(backendDir, "agents"), { recursive: true });
  writeFileSync(join(backendDir, "agents", `${b64(agentId)}.json`), JSON.stringify({ id: agentId, name: "synth" }));
  const convDir = join(backendDir, "conversations", b64(`default:${agentId}`));
  mkdirSync(convDir, { recursive: true });
  writeFileSync(join(convDir, "conversation.json"), JSON.stringify({ id: "default", agent_id: agentId }));
  // The on-disk assistant record that declared the tool_call — settlement
  // splices the synthetic toolResult directly after it (letta-mobile-5spje).
  writeFileSync(join(convDir, "messages.jsonl"), JSON.stringify({
    id: "m-assist-1",
    role: "assistant",
    parts: [{ type: "toolCall", id: "tc-dangling", name: "Bash", arguments: {} }],
    metadata: { created_at: "2026-01-01T00:00:00.000Z" },
  }) + "\n");

  const { session, push, trace } = makeControlledSession();
  const adapter = makeAdapter(agentId, session);

  const graceExpired: string[] = [];
  let runId: string | null = null;

  trace.onAbort = () => {
    setTimeout(() => push(resultMsg(false)), 100); // clean-looking ack
  };

  const turnA = adapter.runTurn("run a tool", {
    onFrame: () => {},
    onRunCreated: (id) => { runId = id; },
    onCancelGraceExpired: (id) => graceExpired.push(id),
  });

  await sleep(30);
  // A tool_call that never returns → finalize synthesizes a settlement.
  push({
    type: "stream_event",
    event: {
      message_type: "tool_call_message",
      id: "m-tc",
      date: "2026-01-01T00:00:01.000Z",
      agent_id: agentId,
      conversation_id: "default",
      run_id: "r",
      seq_id: 2,
      otid: "oT",
      tool_call: { tool_call_id: "tc-dangling", name: "Bash", arguments: "{}" },
    },
    uuid: "u-tc",
  } as unknown as SDKMessage);
  await sleep(30);
  assert.equal(cancelRun(runId!), true);

  const resA = await turnA;
  assert.equal(resA.cancelled, true);

  await sleep(800); // ack at ~100ms, grace expires at 500ms → backstop evicts
  assert.deepEqual(graceExpired, [runId], "worker evicted despite the ack (synthesized settlements)");
  assert.ok(trace.closed >= 1, "worker closed");

  // The settlement really landed on disk.
  const lines = readFileSync(join(convDir, "messages.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const settled = lines.find((m) => m["role"] === "toolResult" && m["toolCallId"] === "tc-dangling");
  assert.ok(settled, "synthetic toolResult appended for the dangling call");
});
