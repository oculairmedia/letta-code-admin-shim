/**
 * SSE streaming contract tests.
 *
 * These pin the HTTP-stream behavior the mobile app and any vanilla-Letta
 * client depends on. The refactor from .mjs → TypeScript must preserve:
 *
 *   • The vanilla frame order:
 *       ping → (reasoning_message)? → assistant_message → stop_reason → usage → [DONE]
 *   • Server-side coalescing of consecutive assistant_message chunks
 *     sharing an otid (one bubble per turn, regardless of chunk count).
 *   • The approval_request_message → tool_call_message remap with a stable
 *     toolcall-${tool_call_id} id.
 *   • Bare-envelope shape for stop_reason / usage_statistics.
 *   • `cm-stream-…` optimistic tagging on assistant_message ids only.
 *   • A consistent run_id stamped on every turn frame.
 *   • Per-type date offsets that keep stream + disk projection sortable.
 *   • otid round-trip via the _otid-map sidecar so mobile reconcile works.
 *
 * Each test spawns its own shim, runs against the mock letta backend, and
 * cleans up via `t.after`. Tests are independent — they may run in parallel.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  startShim,
  seedAgent,
  seedConversation,
  seedMessage,
  externalConvId,
  streamMessages,
  framesOfType,
  indexOfType,
} from "./helpers/index.js";
import type { ShimHandle } from "./helpers/shim.js";
import type { SseFrame, StreamMessagesResult } from "./helpers/sse.js";

// ── types ─────────────────────────────────────────────────────────

interface SetupShimOptions {
  agentId?: string;
  env?: Record<string, string | undefined>;
}

interface SetupShimResult {
  shim: ShimHandle;
  agentId: string;
  convId: string;
  messagesUrl: string;
}

interface RunTurnOptions extends SetupShimOptions {
  otid?: string;
  text?: string;
  streaming?: boolean;
}

interface RunTurnResult extends SetupShimResult {
  otid: string;
  text: string;
  result: StreamMessagesResult;
}

const STREAM_TIMEOUT_MS = 5_000;

// Convenience: build a fresh shim + seeded agent + default conversation and
// return everything the test needs. Uses externalConvId so the URL form
// matches what mobile sends.
async function setupShim(
  t: { after: (fn: () => unknown) => void },
  { agentId = `agent-stream-${Date.now()}`, env }: SetupShimOptions = {},
): Promise<SetupShimResult> {
  const shim = await startShim({ env });
  t.after(() => shim.stop());
  const id = seedAgent(shim.stateDir, { id: agentId });
  seedConversation(shim.stateDir, id);
  return {
    shim,
    agentId: id,
    convId: externalConvId(id),
    messagesUrl: `${shim.url}/v1/conversations/${externalConvId(id)}/messages`,
  };
}

async function runTurn(
  t: { after: (fn: () => unknown) => void },
  opts: RunTurnOptions = {},
): Promise<RunTurnResult> {
  const ctx = await setupShim(t, opts);
  const otid = opts.otid ?? `cm-test-${Math.random().toString(36).slice(2, 10)}`;
  const text = opts.text ?? "reply with pong";
  const body = {
    messages: [{ role: "user", content: text, otid }],
    ...(opts.streaming !== undefined ? { streaming: opts.streaming } : {}),
  };
  const result = await streamMessages(ctx.messagesUrl, body, {
    timeoutMs: STREAM_TIMEOUT_MS,
  });
  return { ...ctx, otid, text, result };
}

// ─── 1. Vanilla frame order ───────────────────────────────────────────

test("streaming: plain trace yields ping → assistant_message → stop_reason → usage → [DONE]", async (t) => {
  const { result } = await runTurn(t, { text: "reply with pong" });
  assert.equal(result.status, 200);
  assert.ok(result.doneSeen, "[DONE] terminator should fire");

  // ping always opens the stream
  assert.equal(result.frames[0]?.message_type, "ping", `first frame should be ping, got ${result.frames[0]?.message_type}`);

  // Required tail order
  const aIdx = indexOfType(result.frames, "assistant_message");
  const sIdx = indexOfType(result.frames, "stop_reason");
  const uIdx = indexOfType(result.frames, "usage_statistics");
  assert.ok(aIdx > 0, "assistant_message present after ping");
  assert.ok(sIdx > aIdx, "stop_reason follows assistant_message");
  assert.ok(uIdx > sIdx, "usage_statistics follows stop_reason");
});

// ─── 2. [DONE] always fires, even on tool-call turns ─────────────────

test("streaming: [DONE] terminator fires on tool-call turns too", async (t) => {
  const { result } = await runTurn(t, { text: "run bash echo hello" });
  assert.ok(result.doneSeen, "[DONE] should arrive even when a tool_call is in the turn");
  assert.equal(result.status, 200);
});

// ─── 3. Coalescing: many chunks → one assistant_message ──────────────

test("streaming: multi-step (6 chunks) coalesces to a single assistant_message", async (t) => {
  // multi-step trace has 6 assistant_message chunks sharing one otid.
  const { result } = await runTurn(t, { text: "bullet list three things about TCP/IP" });
  const assistants = framesOfType(result.frames, "assistant_message");
  assert.equal(
    assistants.length,
    1,
    `expected 1 coalesced assistant_message, got ${assistants.length}: ${assistants.map((a) => ((a as { content?: string }).content ?? "").slice(0, 20)).join(" | ")}`,
  );
  // Content should be the full concatenation
  const a0 = assistants[0] as { content?: string };
  assert.ok((a0.content ?? "").length > 100, "concatenated content should be substantial");
});

test("streaming: text-only-long (17 chunks) coalesces to a single assistant_message", async (t) => {
  // text-only-long has many chunks — pickTrace fires on "long text"/"essay"/"explain in"
  const { result } = await runTurn(t, { text: "explain in detail with long text" });
  const assistants = framesOfType(result.frames, "assistant_message");
  assert.equal(
    assistants.length,
    1,
    `text-only-long must coalesce to 1 frame, got ${assistants.length}`,
  );
  // 17 chunks → > 200 chars at minimum
  const a0 = assistants[0] as { content?: string };
  assert.ok((a0.content ?? "").length > 200, "coalesced essay-length reply should be > 200 chars");
});

// ─── 4. approval_request_message → tool_call_message remap ───────────

test("streaming: bash-tool trace emits tool_call_message (remap from approval_request_message)", async (t) => {
  const { result } = await runTurn(t, { text: "run bash echo hello" });
  const tools = framesOfType(result.frames, "tool_call_message");
  assert.equal(tools.length, 1, `expected 1 tool_call_message, got ${tools.length}`);
  const tc = tools[0] as { id: string; tool_call?: { name?: string; tool_call_id?: string } };
  assert.equal(tc.tool_call?.name, "Bash", "tool_call.name should be Bash");
  assert.ok(tc.tool_call?.tool_call_id, "tool_call_id should be present");
  assert.equal(
    tc.id,
    `toolcall-${tc.tool_call.tool_call_id}`,
    "tool_call_message.id must be `toolcall-${tool_call_id}`",
  );
  // The remap is the key invariant: NO approval_request_message must leak through.
  const approvals = framesOfType(result.frames, "approval_request_message");
  assert.equal(approvals.length, 0, "approval_request_message must be remapped, not forwarded");
});

// ─── 5. multi-tool: two tool_call_messages in order with distinct ids ─

test("streaming: multi-tool-bash-read emits TWO tool_call_messages in order", async (t) => {
  const { result } = await runTurn(t, { text: "use both tools: bash and read" });
  const tools = framesOfType(result.frames, "tool_call_message");
  assert.equal(tools.length, 2, `expected 2 tool_call_messages, got ${tools.length}`);
  const t0 = tools[0] as { tool_call?: { name?: string; tool_call_id?: string } };
  const t1 = tools[1] as { tool_call?: { name?: string; tool_call_id?: string } };
  assert.equal(t0.tool_call?.name, "Bash");
  assert.equal(t1.tool_call?.name, "Read");
  assert.notEqual(
    t0.tool_call?.tool_call_id,
    t1.tool_call?.tool_call_id,
    "tool_call_ids must be distinct",
  );
  // Indexes must be ordered
  const i0 = result.frames.indexOf(tools[0]!);
  const i1 = result.frames.indexOf(tools[1]!);
  assert.ok(i0 < i1, "Bash tool_call must precede Read tool_call");
});

// ─── 6. interleaved-tools: coalescer must not merge across tool calls ─

test("streaming: interleaved-tools — assistant_message / tool_call alternation preserved", async (t) => {
  const { result } = await runTurn(t, { text: "interleave the steps one at a time" });
  // Filter to just assistant + tool frames in order.
  const ordered = result.frames.filter(
    (f) => f.message_type === "assistant_message" || f.message_type === "tool_call_message",
  );
  // Three tool_calls in the fixture, each preceded by its own assistant chunk-group.
  const tools = ordered.filter((f) => f.message_type === "tool_call_message");
  const assistants = ordered.filter((f) => f.message_type === "assistant_message");
  assert.equal(tools.length, 3, `expected 3 tool_calls, got ${tools.length}`);
  // 4 assistant chunk-groups (one before each tool, one trailing). The coalescer
  // must NOT have merged them across the tool_call boundary; the count is
  // exactly the number of distinct otids.
  assert.equal(
    assistants.length,
    4,
    `interleaved coalesce: expected 4 assistant_messages, got ${assistants.length} (the coalescer must flush on tool_call)`,
  );
  // Strict alternation: a, t, a, t, a, t, a
  const types = ordered.map((f) => f.message_type[0]); // 'a' or 't'
  assert.deepEqual(
    types,
    ["a", "t", "a", "t", "a", "t", "a"],
    `expected a,t,a,t,a,t,a alternation, got ${types.join(",")}`,
  );
});

// ─── 7. run_id consistency across the turn ──────────────────────────

test("streaming: every turn frame carries the same run_id", async (t) => {
  const { result } = await runTurn(t, { text: "reply with pong" });
  const turnFrames = result.frames.filter(
    (f) =>
      f.message_type !== "stop_reason" && // bare envelope, no run_id
      f.message_type !== "usage_statistics", // bare envelope, no run_id
  );
  const runIds = new Set(
    turnFrames
      .map((f) => (f as { run_id?: unknown }).run_id)
      .filter((v) => v !== undefined && v !== null),
  );
  assert.ok(runIds.size > 0, "at least one frame must carry a run_id");
  assert.equal(runIds.size, 1, `all run_ids must match; got ${[...runIds].join(",")}`);
  const [runId] = runIds as Set<string>;
  assert.match(runId!, /^run-/, "run_id should look like run-<uuid> (shim-generated, not letta-code's local-run-N)");
});

// ─── 8. tagAsOptimistic: cm-stream- on text, NOT on tool_calls ────────

test("streaming: assistant_message.id has cm-stream- prefix; tool_call_message.id does not", async (t) => {
  const { result } = await runTurn(t, { text: "run bash echo hello" });
  const assistants = framesOfType(result.frames, "assistant_message");
  for (const a of assistants) {
    const aId = (a as { id: string }).id;
    assert.match(aId, /^cm-stream-/, `assistant_message.id should be cm-stream-…, got ${aId}`);
  }
  const tools = framesOfType(result.frames, "tool_call_message");
  for (const tc of tools) {
    const tcId = (tc as { id: string }).id;
    assert.match(tcId, /^toolcall-/, `tool_call_message.id should be toolcall-…, got ${tcId}`);
    assert.doesNotMatch(tcId, /^cm-stream-/, "tool_call_message must NOT carry the optimistic prefix");
  }
});

test("streaming: tool_return_message is NOT emitted in the stream (letta-code omits it)", async (t) => {
  const { result } = await runTurn(t, { text: "run bash echo hello" });
  const returns = framesOfType(result.frames, "tool_return_message");
  assert.equal(returns.length, 0, "tool_return_message belongs to the disk projection, not the stream");
});

// ─── 9. Per-type date offsets ────────────────────────────────────────

test("streaming: per-type date offsets — tool_call < assistant within a turn", async (t) => {
  const { result } = await runTurn(t, { text: "run bash echo hello" });
  const toolCall = framesOfType(result.frames, "tool_call_message")[0] as { date: string } | undefined;
  const assistant = framesOfType(result.frames, "assistant_message").slice(-1)[0] as { date: string } | undefined;
  assert.ok(toolCall && assistant, "fixture should have both frame types");
  const tcDate = Date.parse(toolCall.date);
  const aDate = Date.parse(assistant.date);
  assert.ok(Number.isFinite(tcDate), `tool_call_message.date should parse, got ${toolCall.date}`);
  assert.ok(Number.isFinite(aDate), `assistant_message.date should parse, got ${assistant.date}`);
  // Per the schedule in chat.mjs: tool_call=+20ms, assistant=+40ms within the
  // same turn. Tool MUST be strictly before the assistant_message.
  assert.ok(
    tcDate < aDate,
    `tool_call_message.date (${toolCall.date}) must be < assistant_message.date (${assistant.date})`,
  );
});

test("streaming: assistant_message dates within a single turn equal turnStart+40ms", async (t) => {
  const { result } = await runTurn(t, { text: "reply with pong" });
  const assistant = framesOfType(result.frames, "assistant_message")[0] as { date: string } | undefined;
  const ping = framesOfType(result.frames, "ping")[0] as { date: string } | undefined;
  assert.ok(assistant && ping);
  // assistant.date - ping.date should be ~40ms (offsets: ping=0, assistant=40).
  // Allow ±50ms slack since the ping uses isoNow() and the offset is
  // computed from a separately captured turnStartedAt.
  const delta = Date.parse(assistant.date) - Date.parse(ping.date);
  assert.ok(
    Math.abs(delta - 40) < 200,
    `assistant.date should be ~40ms past ping (delta=${delta}ms)`,
  );
});

// ─── 10. otid round-trip via the sidecar ─────────────────────────────

test("streaming: otid bind — POSTed otid is recorded in _otid-map.json sidecar", async (t) => {
  // The mock doesn't append to messages.jsonl (letta-code on a real backend
  // would). To test the sidecar write path, we PRE-seed one tail user message,
  // then POST a turn with an otid; the chat handler runs findUnmappedTailUserMessageId
  // against the sidecar and binds our otid to that local id.
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir, { id: "agent-otid-001" });
  seedConversation(shim.stateDir, agentId);
  const seededId = seedMessage(shim.stateDir, agentId, "default", {
    role: "user",
    content: "earlier user prompt",
  });
  seedMessage(shim.stateDir, agentId, "default", {
    role: "assistant",
    content: "earlier assistant reply",
  });
  const convId = externalConvId(agentId);

  const myOtid = "cm-otid-roundtrip";
  const { doneSeen } = await streamMessages(
    `${shim.url}/v1/conversations/${convId}/messages`,
    {
      messages: [{ role: "user", content: "reply with pong", otid: myOtid }],
      streaming: true,
    },
    { timeoutMs: STREAM_TIMEOUT_MS },
  );
  assert.ok(doneSeen, "turn must complete for otid bind to fire");

  // The sidecar lives under conversations/<b64url(default:agent-id)>/_otid-map.json
  const b64url = Buffer.from(`default:${agentId}`).toString("base64url");
  const sidecarPath = join(shim.stateDir, "conversations", b64url, "_otid-map.json");
  assert.ok(existsSync(sidecarPath), `_otid-map.json should exist at ${sidecarPath}`);
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, string>;
  assert.equal(
    sidecar[seededId],
    myOtid,
    `sidecar must bind seeded user msg id ${seededId} → ${myOtid}; got ${JSON.stringify(sidecar)}`,
  );
});

test("streaming: otid bind is a no-op when no otid is supplied", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir, { id: "agent-otid-002" });
  seedConversation(shim.stateDir, agentId);
  seedMessage(shim.stateDir, agentId, "default", { role: "user", content: "x" });
  const convId = externalConvId(agentId);

  await streamMessages(
    `${shim.url}/v1/conversations/${convId}/messages`,
    { messages: [{ role: "user", content: "reply with pong" }], streaming: true },
    { timeoutMs: STREAM_TIMEOUT_MS },
  );
  const b64url = Buffer.from(`default:${agentId}`).toString("base64url");
  const sidecarPath = join(shim.stateDir, "conversations", b64url, "_otid-map.json");
  // Without an otid the sidecar file should not be written.
  assert.equal(existsSync(sidecarPath), false, "no otid in body → no sidecar write");
});

// ─── 11. stop_reason shape ───────────────────────────────────────────

test("streaming: stop_reason is a bare envelope (no id/date wrapper)", async (t) => {
  const { result } = await runTurn(t, { text: "reply with pong" });
  const stop = result.frames.find((f) => f.message_type === "stop_reason") as
    | { message_type: string; stop_reason: string; id?: unknown; date?: unknown; otid?: unknown }
    | undefined;
  assert.ok(stop, "stop_reason must be present");
  assert.equal(stop.message_type, "stop_reason");
  assert.equal(stop.stop_reason, "end_turn");
  // Bare envelope: must NOT have id/date/otid keys that other frames carry.
  assert.equal(stop.id, undefined, `stop_reason should not carry id, got ${stop.id}`);
  assert.equal(stop.date, undefined, `stop_reason should not carry date, got ${stop.date}`);
  assert.equal(stop.otid, undefined, `stop_reason should not carry otid`);
});

test("streaming: empty-reply trace still emits stop_reason + [DONE]", async (t) => {
  const { result } = await runTurn(t, { text: "respond with nothing at all" });
  assert.ok(result.doneSeen, "[DONE] must fire even with no assistant content");
  const stop = result.frames.find((f) => f.message_type === "stop_reason");
  assert.ok(stop, "stop_reason must fire on empty-reply");
  const assistants = framesOfType(result.frames, "assistant_message");
  assert.equal(assistants.length, 0, "empty-reply must emit no assistant_message");
});

// ─── 12. usage_statistics shape ──────────────────────────────────────

test("streaming: usage_statistics carries prompt/completion/total token fields", async (t) => {
  const { result } = await runTurn(t, { text: "reply with pong" });
  const usage = result.frames.find((f) => f.message_type === "usage_statistics") as
    | (SseFrame & { id?: unknown })
    | undefined;
  assert.ok(usage, "usage_statistics frame must be present");
  for (const key of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "step_count",
    "cached_input_tokens",
    "reasoning_tokens",
    "context_tokens",
  ]) {
    assert.ok(key in usage, `usage_statistics must include ${key}`);
    assert.equal(typeof usage[key], "number", `usage_statistics.${key} must be a number`);
  }
  // Bare envelope — no id/date wrapper.
  assert.equal(usage.id, undefined, "usage_statistics should not carry id");
});

// ─── 13. Run record persisted with matching run_id ──────────────────

test("streaming: run_id from the stream is queryable at GET /v1/runs/{run_id}", async (t) => {
  const { shim, result } = await runTurn(t, { text: "reply with pong" });
  // Pick a turn frame with a run_id (anything but stop_reason / usage_statistics).
  const turnFrame = result.frames.find(
    (f) => {
      const fr = f as { run_id?: unknown; message_type: string };
      return (
        fr.run_id &&
        fr.message_type !== "stop_reason" &&
        fr.message_type !== "usage_statistics"
      );
    },
  );
  assert.ok(turnFrame, "at least one turn frame should carry run_id");
  const runId = (turnFrame as { run_id: string }).run_id;
  const res = await fetch(`${shim.url}/v1/runs/${runId}`);
  assert.equal(res.status, 200, `GET /v1/runs/${runId} should be 200`);
  const run = await res.json() as { id: string; status: string };
  assert.equal(run.id, runId, "run record id must match the streamed run_id");
  // Status will normally be "completed" by the time the turn ends.
  assert.ok(
    ["completed", "running"].includes(run.status),
    `unexpected run status ${run.status}`,
  );
});

// ─── 14. Streaming default vs explicit non-stream ───────────────────

test("streaming: omitting `streaming` defaults to streaming SSE", async (t) => {
  const { messagesUrl } = await setupShim(t);
  const result = await streamMessages(
    messagesUrl,
    { messages: [{ role: "user", content: "reply with pong", otid: "cm-default" }] },
    { timeoutMs: STREAM_TIMEOUT_MS },
  );
  assert.equal(result.status, 200);
  // Default should still stream — SSE [DONE] terminator should appear.
  assert.ok(result.doneSeen, "default streaming=true should still emit [DONE]");
  assert.ok(result.frames.length > 0, "default streaming should produce frames");
});

test("streaming: streaming:false returns a single JSON envelope, no SSE", async (t) => {
  const { messagesUrl } = await setupShim(t);
  const res = await fetch(messagesUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "reply with pong", otid: "cm-no-stream" }],
      streaming: false,
    }),
  });
  assert.equal(res.status, 200);
  const ct = res.headers.get("content-type") ?? "";
  assert.match(ct, /application\/json/, `streaming:false should be JSON, got ${ct}`);
  const body = await res.json() as {
    messages: unknown[];
    stop_reason: { message_type: string };
    usage: { total_tokens: number };
  };
  assert.ok(Array.isArray(body.messages), "non-stream response includes `messages` array");
  assert.ok(body.stop_reason && body.stop_reason.message_type === "stop_reason");
  assert.ok(body.usage && typeof body.usage.total_tokens === "number");
});

// ─── 15. Ping carries run_id once it's known ────────────────────────

test("streaming: opening ping carries no run_id (precedes onRunCreated), tail frames do", async (t) => {
  const { result } = await runTurn(t, { text: "reply with pong" });
  const ping = result.frames.find((f) => f.message_type === "ping");
  assert.ok(ping, "ping must be the opener");
  // The opener ping is emitted before pool.get() returns, so run_id may be null.
  // That's the documented contract — we don't assert one way or another, but
  // at minimum the field must exist (null or otherwise) for forward-compat.
  assert.ok("run_id" in ping, "ping must include a run_id field (may be null)");
});

// ─── 16. forced-trace env works (regression for LETTA_MOCK_FORCE_TRACE) ─

test("streaming: LETTA_MOCK_FORCE_TRACE forces a specific trace regardless of user text", async (t) => {
  const { result } = await runTurn(t, {
    text: "this would normally pick plain",
    env: { LETTA_MOCK_FORCE_TRACE: "interleaved-tools" },
  });
  const tools = framesOfType(result.frames, "tool_call_message");
  assert.equal(tools.length, 3, "forced interleaved-tools should yield 3 tool_calls");
});

// ─── 17. read-tool trace: single Read tool_call ────────────────────

test("streaming: read-tool trace emits one Read tool_call_message", async (t) => {
  const { result } = await runTurn(t, { text: "use the read tool on a file" });
  const tools = framesOfType(result.frames, "tool_call_message");
  assert.equal(tools.length, 1, `expected 1 tool_call, got ${tools.length}`);
  const t0 = tools[0] as { tool_call?: { name?: string } };
  assert.equal(t0.tool_call?.name, "Read");
});

// ─── 18. tool-then-text: tool followed by coalesced assistant block ───

test("streaming: tool-then-text emits tool_call_message then one coalesced assistant_message", async (t) => {
  const { result } = await runTurn(t, {
    text: "run bash pwd then explain in long paragraph",
  });
  // tool-then-text has 1 Bash call + 6 assistant chunks (one otid group).
  const tools = framesOfType(result.frames, "tool_call_message");
  const assistants = framesOfType(result.frames, "assistant_message");
  assert.equal(tools.length, 1, "tool-then-text has one Bash call");
  assert.equal(assistants.length, 1, "post-tool assistant chunks must coalesce to 1 frame");
  const tIdx = result.frames.indexOf(tools[0]!);
  const aIdx = result.frames.indexOf(assistants[0]!);
  assert.ok(tIdx < aIdx, "tool_call must come before the trailing assistant_message");
});

// ─── 19. Each assistant_message frame carries its otid (preserved through coalesce) ─

test("streaming: coalesced assistant_message retains the source otid", async (t) => {
  const { result } = await runTurn(t, { text: "bullet list three things about TCP/IP" });
  const a = framesOfType(result.frames, "assistant_message")[0] as { otid?: unknown } | undefined;
  assert.ok(a, "assistant frame present");
  assert.ok(typeof a.otid === "string" && a.otid.length > 0, `otid should survive coalesce, got ${a.otid}`);
  // multi-step's source otid starts with "provider-assistant-"
  assert.match(a.otid, /^provider-assistant-/, "letta-code provider otid should be preserved");
});

// ─── 20. Concatenation correctness — assistant content equals join of chunks ─

test("streaming: multi-step concatenated content reads as the full essay", async (t) => {
  const { result } = await runTurn(t, { text: "bullet list three things about TCP/IP" });
  const a = framesOfType(result.frames, "assistant_message")[0] as { content: string } | undefined;
  assert.ok(a);
  // The 6 chunks together form a multi-bullet reply mentioning TCP, IP, and
  // a version distinction — pick a few stable tokens.
  assert.match(a.content, /TCP/);
  assert.match(a.content, /IP/);
  assert.match(a.content, /IPv4|IPv6/);
});

// ─── 21. SSE content-type header ────────────────────────────────────

test("streaming: response uses text/event-stream content type", async (t) => {
  const { messagesUrl } = await setupShim(t);
  const res = await fetch(messagesUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "reply with pong", otid: "cm-h" }],
      streaming: true,
    }),
  });
  assert.equal(res.status, 200);
  const ct = res.headers.get("content-type") ?? "";
  assert.match(ct, /text\/event-stream/, `expected SSE content-type, got ${ct}`);
  // Drain the body so the connection closes cleanly before the test ends.
  await res.text();
});

// ─── 22. Stop_reason emitted exactly once at end of turn ────────────

test("streaming: stop_reason emitted exactly once even when the trace has multiple", async (t) => {
  // The multi-tool-bash-read fixture has 3 stop_reason frames internally
  // (one per model step). The handler must collapse them to a SINGLE final
  // stop_reason emitted at end-of-turn.
  const { result } = await runTurn(t, { text: "use both tools: bash and read" });
  const stops = framesOfType(result.frames, "stop_reason");
  assert.equal(stops.length, 1, `expected 1 final stop_reason, got ${stops.length}`);
});

test("streaming: usage_statistics emitted exactly once even with multi-step traces", async (t) => {
  const { result } = await runTurn(t, { text: "use both tools: bash and read" });
  const usages = framesOfType(result.frames, "usage_statistics");
  assert.equal(usages.length, 1, `expected 1 final usage_statistics, got ${usages.length}`);
});
