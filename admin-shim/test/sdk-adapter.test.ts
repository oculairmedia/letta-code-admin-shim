/**
 * lcp-sdk.3 — focused unit tests for the SDK-backed session adapter.
 *
 * Validates the two pieces of logic the adapter actually owns:
 *   1. `sdkMessageToLettaFrame` — the SDKMessage → LettaStreamFrame mapping
 *      that downstream collector logic depends on.
 *   2. `runTurn` driver loop — that the adapter pumps a Session's stream,
 *      pushes frames through `onFrame`, stops on `result`, and reports the
 *      correct AdapterRunTurnResult shape (done/timeout/dead).
 *
 * No subprocess spawning here. The end-to-end pass against the real CLI
 * lives in lcp-sdk.9's live smoke; this file proves the seam math is
 * correct so we know what the smoke is actually exercising.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SdkBackedLettaSessionAdapter,
  _internals,
} from "../lib/letta-sdk-adapter.js";
import type {
  SDKAssistantMessage,
  SDKInitMessage,
  SDKMessage,
  SDKResultMessage,
  SDKStreamEventMessage,
} from "@letta-ai/letta-code-sdk";
import type { LettaStreamFrame } from "../lib/types/letta-stream.js";

const { sdkMessageToLettaFrame } = _internals;

// ── Conversion: stream_event passes through with raw event preserved ────

test("sdk-adapter: stream_event conversion does not log SDK_MSG by default", () => {
  const prevDebug = process.env["DEBUG_SDK"];
  delete process.env["DEBUG_SDK"];
  const logs: string[] = [];
  const prevLog = console.log;
  console.log = (msg?: unknown) => { logs.push(String(msg)); };
  try {
    const msg: SDKStreamEventMessage = {
      type: "stream_event",
      event: { message_type: "assistant_message" },
      uuid: "u-log-default",
    } as SDKStreamEventMessage;
    const frame = sdkMessageToLettaFrame(msg, "sess-1", "agent-x", "conv-x");
    assert.equal(frame?.type, "stream_event");
    assert.deepEqual(logs.filter((line) => line.includes("SDK_MSG")), []);
  } finally {
    console.log = prevLog;
    if (prevDebug === undefined) {
      delete process.env["DEBUG_SDK"];
    } else {
      process.env["DEBUG_SDK"] = prevDebug;
    }
  }
});

test("sdk-adapter: DEBUG_SDK preserves SDK_MSG logging", () => {
  const prevDebug = process.env["DEBUG_SDK"];
  process.env["DEBUG_SDK"] = "1";
  const logs: string[] = [];
  const prevLog = console.log;
  console.log = (msg?: unknown) => { logs.push(String(msg)); };
  try {
    const msg: SDKStreamEventMessage = {
      type: "stream_event",
      event: { message_type: "assistant_message" },
      uuid: "u-log-debug",
    } as SDKStreamEventMessage;
    const frame = sdkMessageToLettaFrame(msg, "sess-1", "agent-x", "conv-x");
    assert.equal(frame?.type, "stream_event");
    assert.ok(
      logs.some((line) => line.includes("SDK_MSG type=stream_event inner=assistant_message")),
      `expected SDK_MSG log, got ${JSON.stringify(logs)}`,
    );
  } finally {
    console.log = prevLog;
    if (prevDebug === undefined) {
      delete process.env["DEBUG_SDK"];
    } else {
      process.env["DEBUG_SDK"] = prevDebug;
    }
  }
});

test("sdk-adapter: stream_event → wire stream_event with raw inner event", () => {
  const msg: SDKStreamEventMessage = {
    type: "stream_event",
    event: {
      message_type: "assistant_message",
      id: "msg-1",
      date: "2026-01-01T00:00:01.000Z",
      agent_id: "agent-x",
      conversation_id: "conv-x",
      run_id: "run-letta-1",
      seq_id: 1,
      otid: "ot-1",
      content: [{ type: "text", text: "hi" }],
    },
    uuid: "u-1",
  };
  const frame = sdkMessageToLettaFrame(msg, "sess-1", "agent-x", "conv-x");
  assert.ok(frame, "expected a frame");
  assert.equal(frame!.type, "stream_event");
  if (frame!.type !== "stream_event") return; // narrow
  assert.equal(frame!.session_id, "sess-1");
  assert.equal(frame!.uuid, "u-1");
  // Critical: the inner event MUST be passed through unmodified — the
  // collector cases on event.message_type, otid, content, etc.
  const inner = frame!.event as unknown as Record<string, unknown>;
  assert.equal(inner["message_type"], "assistant_message");
  assert.deepEqual(inner["content"], [{ type: "text", text: "hi" }]);
  assert.equal(inner["run_id"], "run-letta-1");
});

test("sdk-adapter: result → wire result frame with run_ids preserved", () => {
  const msg: SDKResultMessage = {
    type: "result",
    success: true,
    result: "final text",
    durationMs: 1234,
    conversationId: "conv-x",
    runIds: ["run-a", "run-b"],
    stopReason: "end_turn",
  };
  const frame = sdkMessageToLettaFrame(msg, "sess-1", "agent-x", "conv-x");
  assert.ok(frame, "expected a frame");
  assert.equal(frame!.type, "result");
  if (frame!.type !== "result") return;
  assert.equal(frame!.subtype, "success");
  assert.equal(frame!.duration_ms, 1234);
  assert.equal(frame!.result, "final text");
  assert.equal(frame!.agent_id, "agent-x");
  assert.equal(frame!.conversation_id, "conv-x");
  assert.deepEqual(frame!.run_ids, ["run-a", "run-b"]);
  assert.equal(frame!.usage, null);
});

test("sdk-adapter: result with success=false → subtype=error", () => {
  const msg: SDKResultMessage = {
    type: "result",
    success: false,
    error: "boom",
    durationMs: 5,
    conversationId: null,
  };
  const frame = sdkMessageToLettaFrame(msg, "s", "a", "c");
  assert.equal(frame!.type, "result");
  if (frame!.type !== "result") return;
  assert.equal(frame!.subtype, "error");
  assert.equal(frame!.conversation_id, "c"); // falls back to constructor conv id
});

test("sdk-adapter: init / transformed messages / error / retry → null (no wire frame)", () => {
  // init fires once during start(); not surfaced into the turn collector.
  const init: SDKInitMessage = {
    type: "init", agentId: "a", sessionId: "s", conversationId: "c",
    model: "claude-sonnet", tools: [],
  };
  assert.equal(sdkMessageToLettaFrame(init, "s", "a", "c"), null);

  // Transformed messages duplicate stream_event content on local backend.
  const ass: SDKAssistantMessage = { type: "assistant", content: "hi", uuid: "u" };
  assert.equal(sdkMessageToLettaFrame(ass, "s", "a", "c"), null);

  assert.equal(
    sdkMessageToLettaFrame(
      { type: "error", message: "x", stopReason: "error" } as SDKMessage,
      "s", "a", "c",
    ),
    null,
  );
  assert.equal(
    sdkMessageToLettaFrame(
      { type: "retry", reason: "timeout", attempt: 1, maxAttempts: 3, delayMs: 100 } as SDKMessage,
      "s", "a", "c",
    ),
    null,
  );
});

// ── Driver: runTurn against a stub Session ──────────────────────────────

interface StubSessionFrame { sent: unknown[]; aborted: boolean; closed: boolean }

function makeStubSession(messages: SDKMessage[]): { session: unknown; trace: StubSessionFrame } {
  const trace: StubSessionFrame = { sent: [], aborted: false, closed: false };
  const session = {
    async send(m: unknown) { trace.sent.push(m); },
    async *stream(): AsyncGenerator<SDKMessage> {
      for (const m of messages) yield m;
    },
    async abort() { trace.aborted = true; },
    close() { trace.closed = true; },
    initialize() {
      // not used by these tests; runTurn-inner asserts session is set up.
      throw new Error("stub: not used");
    },
  };
  return { session, trace };
}

test("sdk-adapter: runTurn pumps frames through onFrame and terminates on result", async () => {
  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-x" });
  // Hand-set internals so we don't have to import the SDK transport.
  // start() would do this via resumeSession().initialize() — we skip it.
  const { session, trace } = makeStubSession([
    {
      type: "stream_event",
      event: { message_type: "assistant_message", id: "m1", date: "x", agent_id: "agent-x", conversation_id: "default", run_id: "r", seq_id: 0, otid: "o", content: [{ type: "text", text: "hello" }] },
      uuid: "u1",
    } as SDKStreamEventMessage,
    {
      type: "stream_event",
      event: { message_type: "stop_reason", stop_reason: "end_turn" },
      uuid: "u2",
    } as SDKStreamEventMessage,
    { type: "result", success: true, result: "hello", durationMs: 1, conversationId: "default", runIds: ["r-letta"] } as SDKResultMessage,
  ]);
  // Test surface: poke private fields the stub needs.
  (adapter as unknown as { session: unknown }).session = session;
  (adapter as unknown as { ready: boolean }).ready = true;

  const seen: LettaStreamFrame[] = [];
  const out = await adapter.runTurn("hello", {
    onFrame: (f) => seen.push(f),
  });

  assert.equal(trace.sent.length, 1, "send() should be called exactly once with the user input");
  assert.equal(trace.sent[0], "hello");
  assert.equal(out.done, true);
  assert.equal(out.timeout, undefined);
  assert.equal(out.dead, undefined);
  assert.equal(out.frames.length, 3, "expected stream_event + stream_event + result");
  assert.equal(out.frames[0]!.type, "stream_event");
  assert.equal(out.frames[1]!.type, "stream_event");
  assert.equal(out.frames[2]!.type, "result");
  // onFrame must receive the same frames in the same order.
  assert.equal(seen.length, 3);
  assert.deepEqual(
    seen.map((f) => f.type),
    out.frames.map((f) => f.type),
  );
});

test("sdk-adapter: runTurn surfaces dead state when stream ends without result", async () => {
  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-x" });
  const { session } = makeStubSession([
    {
      type: "stream_event",
      event: { message_type: "assistant_message", id: "m1", date: "x", agent_id: "agent-x", conversation_id: "default", run_id: "r", seq_id: 0, otid: "o", content: [{ type: "text", text: "partial" }] },
      uuid: "u1",
    } as SDKStreamEventMessage,
    // No result frame — simulate session closed mid-turn.
  ]);
  (adapter as unknown as { session: unknown }).session = session;
  (adapter as unknown as { ready: boolean }).ready = true;

  const out = await adapter.runTurn("partial");
  assert.equal(out.dead, true);
  assert.match(out.error ?? "", /stream ended/);
});

test("sdk-adapter: close marks adapter dead and drops the session", async () => {
  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-x" });
  const { session, trace } = makeStubSession([]);
  (adapter as unknown as { session: unknown }).session = session;
  await adapter.close();
  assert.equal(adapter.dead, true);
  assert.equal(adapter.ready, false);
  assert.equal(trace.closed, true);
});

test("sdk-adapter: runTurn fails fast when called before start()", async () => {
  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-x" });
  await assert.rejects(() => adapter.runTurn("hi"), /before start/);
});

test("sdk-adapter: runTurn refuses to run on a dead adapter", async () => {
  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-x" });
  const { session } = makeStubSession([]);
  (adapter as unknown as { session: unknown }).session = session;
  (adapter as unknown as { dead: boolean }).dead = true;
  await assert.rejects(() => adapter.runTurn("hi"), /dead adapter/);
});

// ── lcp-sdk.4: run lifecycle parity ─────────────────────────────────────

test("sdk-adapter (lcp-sdk.4): runTurn creates a shim run with correct stop_reason + usage", async (t) => {
  // Run records persist under LETTA_LOCAL_BACKEND_DIR/runs/<id>/. Point
  // at a temp dir so this test doesn't pollute project state and so the
  // record is observable via getRun(). messages.jsonl + conversation.json
  // would also live under this dir; not exercising them here.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = mkdtempSync(join(tmpdir(), "sdk-adapter-lifecycle-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = stateDir;
  t.after(() => {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    rmSync(stateDir, { recursive: true, force: true });
  });

  const { getRun, listRunSteps } = await import("../lib/runs.js");

  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-life-1" });
  const { session } = makeStubSession([
    // One assistant text chunk so markRunFirstToken fires.
    {
      type: "stream_event",
      event: {
        message_type: "assistant_message",
        id: "m1", date: "x", agent_id: "agent-life-1", conversation_id: "default",
        run_id: "r", seq_id: 0, otid: "o", content: [{ type: "text", text: "hi" }],
      },
      uuid: "u1",
    } as SDKStreamEventMessage,
    // Usage stats — pendingStepUsage stash.
    {
      type: "stream_event",
      event: {
        message_type: "usage_statistics",
        prompt_tokens: 11, completion_tokens: 22, total_tokens: 33,
        cached_input_tokens: 1, cache_write_tokens: 2, reasoning_tokens: 3,
      },
      uuid: "u2",
    } as SDKStreamEventMessage,
    // Stop reason — drains usage into a step record, sets terminal stop.
    {
      type: "stream_event",
      event: { message_type: "stop_reason", stop_reason: "end_turn", model: "claude-sonnet-x" },
      uuid: "u3",
    } as SDKStreamEventMessage,
    // Terminal SDK result — drives turn termination + finalizeRun.
    {
      type: "result",
      success: true, result: "hi", durationMs: 10,
      conversationId: "default", stopReason: "end_turn", runIds: ["r-letta"],
    } as SDKResultMessage,
  ]);
  (adapter as unknown as { session: unknown }).session = session;
  (adapter as unknown as { ready: boolean }).ready = true;

  const out = await adapter.runTurn("hi");
  assert.ok(out.run_id, "adapter must surface the shim run id");
  assert.equal(out.done, true);
  assert.equal(out.cancelled, false);

  const run = getRun(out.run_id!);
  assert.ok(run, "shim run record must exist on disk");
  // lcp-sdk.4 acceptance #1: SDK path creates exactly ONE shim run per turn,
  // and the run's terminal state mirrors what the direct adapter writes.
  assert.equal(run!.status, "completed");
  assert.equal(run!.stop_reason, "end_turn");
  assert.equal(run!.num_steps, 1, "stop_reason frame drains pendingStepUsage into one step record");
  // Usage stats from the usage_statistics frame propagate into Run.usage.
  assert.ok(run!.usage, "usage must be populated after finalizeRun");
  assert.equal(run!.usage?.total_tokens, 33, "Run.usage.total_tokens mirrors the usage_statistics frame");
  assert.equal(run!.usage?.prompt_tokens, 11);
  assert.equal(run!.usage?.completion_tokens, 22);

  // listRunSteps takes a string runId, not an object.
  const steps = listRunSteps(out.run_id!);
  assert.equal(steps.length, 1, `expected one step from one stop_reason frame, got ${steps.length}`);
  assert.equal(steps[0]?.stop_reason, "end_turn");
  assert.equal(steps[0]?.model, "claude-sonnet-x");
});

test("sdk-adapter (lcp-sdk-decide-runid): adapter never leaks SDK result.runIds as the wire run_id", async (t) => {
  // Run-id boundary: mobile-facing run_id MUST be the shim's runHandle.id,
  // not anything the SDK surfaces. Pins the decision documented in
  // admin-shim/README "Run-ID ownership". See lcp-sdk-decide-runid.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = mkdtempSync(join(tmpdir(), "sdk-adapter-runid-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = stateDir;
  t.after(() => {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    rmSync(stateDir, { recursive: true, force: true });
  });

  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-runid-1" });
  // Stub a turn where the SDK's result.runIds contains values that are
  // VISIBLY DIFFERENT from any shim run id — if the adapter ever swapped
  // its return field to result.runIds[0], this assertion catches it.
  const SDK_UPSTREAM_RUN_IDS = ["sdk-upstream-run-A", "sdk-upstream-run-B"];
  const { session } = makeStubSession([
    { type: "result", success: true, result: "", durationMs: 1, conversationId: "default", runIds: SDK_UPSTREAM_RUN_IDS } as SDKResultMessage,
  ]);
  (adapter as unknown as { session: unknown }).session = session;
  (adapter as unknown as { ready: boolean }).ready = true;

  const out = await adapter.runTurn("ping");
  assert.ok(out.run_id, "wire result must carry a run_id");
  assert.match(out.run_id!, /^run-/, `wire run_id must be a shim-allocated 'run-<uuid>', got ${out.run_id}`);
  for (const upstream of SDK_UPSTREAM_RUN_IDS) {
    assert.notStrictEqual(out.run_id, upstream, `wire run_id must NEVER equal an SDK upstream runId; leaked ${upstream}`);
  }
});

// ── lcp-sdk.5: approval flow via canUseTool ─────────────────────────────

test("sdk-adapter (lcp-sdk.5): canUseTool emits approval_request_message + resolves via approval gate", async (t) => {
  // The SDK invokes canUseTool from its background pump when the CLI hits
  // an approval-required tool. We assert the adapter's callback:
  //   (a) synthesizes a wire approval_request_message and calls onFrame,
  //   (b) blocks on the existing approval gate (same machinery mobile uses),
  //   (c) returns CanUseToolResponse{ behavior } honoring the decision,
  //   (d) records the decision in the run sidecar.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = mkdtempSync(join(tmpdir(), "sdk-adapter-approval-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  const prevPermission = process.env["SHIM_PERMISSION_MODE"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = stateDir;
  process.env["SHIM_PERMISSION_MODE"] = "default";
  t.after(() => {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    if (prevPermission === undefined) delete process.env["SHIM_PERMISSION_MODE"];
    else process.env["SHIM_PERMISSION_MODE"] = prevPermission;
    rmSync(stateDir, { recursive: true, force: true });
  });

  const { createRun, loadApprovalScopeCache } = await import("../lib/runs.js");
  const { resolveApprovalGate } = await import("../lib/agent-pool.js");

  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-approve-1" });
  // Stand the adapter up without a real Session — we don't need the SDK
  // to fire canUseTool, we'll invoke the private method directly to test
  // the approval glue. Set adapter state to match what _runTurnInner
  // would set at the start of a turn.
  (adapter as unknown as { ready: boolean }).ready = true;
  const runHandle = createRun({ agentId: "agent-approve-1", conversationId: "default" });
  const emittedFrames: LettaStreamFrame[] = [];
  const a2ui = { version: "0.9", catalogId: "basic" } as unknown;
  (adapter as unknown as {
    currentRunHandle: typeof runHandle;
    currentOnFrame: (f: LettaStreamFrame, m: { runId: string }) => void;
    currentApprovalScopeCache: Map<string, unknown>;
    currentA2uiCapability: unknown;
  }).currentRunHandle = runHandle;
  (adapter as unknown as { currentOnFrame: (f: LettaStreamFrame, m: { runId: string }) => void }).currentOnFrame = (f) => emittedFrames.push(f);
  (adapter as unknown as { currentApprovalScopeCache: Map<string, unknown> }).currentApprovalScopeCache = loadApprovalScopeCache(runHandle.id, "default");
  (adapter as unknown as { currentA2uiCapability: unknown }).currentA2uiCapability = a2ui;

  // Fire the can_use_tool callback in the background; resolve the gate
  // mid-flight to simulate mobile sending user_action.
  const canUseToolPromise = (adapter as unknown as {
    _handleCanUseTool: (n: string, i: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>;
  })._handleCanUseTool("Bash", { command: "echo hi", description: "test" });

  // Microtask break so the synthetic frame has been emitted + the gate
  // registered before we try to resolve it.
  await new Promise((r) => setTimeout(r, 10));

  // (a) Synthetic approval_request_message frame was emitted via onFrame.
  assert.equal(emittedFrames.length, 1, "must emit exactly one approval frame");
  const af = emittedFrames[0]!;
  assert.equal(af.type, "stream_event");
  if (af.type !== "stream_event") return;
  const ev = af.event as unknown as Record<string, unknown>;
  assert.equal(ev["message_type"], "approval_request_message");
  assert.equal(ev["agent_id"], "agent-approve-1");
  assert.equal(ev["conversation_id"], "default");
  assert.equal(ev["run_id"], runHandle.id);
  const tc = ev["tool_call"] as Record<string, unknown>;
  assert.equal(tc["name"], "Bash");
  assert.match(tc["tool_call_id"] as string, /^synthetic-/);
  assert.equal(tc["arguments"], JSON.stringify({ command: "echo hi", description: "test" }));

  // (b) The approval gate is now registered keyed on runHandle.id —
  // resolveApprovalGate routes the decision into the waiter.
  const resolved = resolveApprovalGate(runHandle.id, {
    decision: "approve",
    scope: "Once",
    reason: "user clicked approve",
    actionId: "act-test-1",
  });
  assert.equal(resolved, true, "approval gate must be open with runHandle.id");

  // (c) Resolution propagates to CanUseToolResponse{ behavior: "allow" }.
  const result = await canUseToolPromise;
  assert.equal(result.behavior, "allow");
  assert.equal(result.message, "user clicked approve");
});

test("sdk-adapter (lcp-sdk.5): Session-scope decision caches and short-circuits the next call", async (t) => {
  // After a Session-scope approval, the SAME tool on the same conv should
  // auto-approve without another mobile round-trip — no frame to mobile,
  // no gate to wait on.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = mkdtempSync(join(tmpdir(), "sdk-adapter-approval-cache-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  const prevPermission = process.env["SHIM_PERMISSION_MODE"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = stateDir;
  process.env["SHIM_PERMISSION_MODE"] = "default";
  t.after(() => {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    if (prevPermission === undefined) delete process.env["SHIM_PERMISSION_MODE"];
    else process.env["SHIM_PERMISSION_MODE"] = prevPermission;
    rmSync(stateDir, { recursive: true, force: true });
  });

  const { createRun, loadApprovalScopeCache } = await import("../lib/runs.js");
  const { resolveApprovalGate } = await import("../lib/agent-pool.js");

  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-cache-1" });
  (adapter as unknown as { ready: boolean }).ready = true;
  const runHandle = createRun({ agentId: "agent-cache-1", conversationId: "default" });
  const emitted: LettaStreamFrame[] = [];
  (adapter as unknown as { currentRunHandle: typeof runHandle }).currentRunHandle = runHandle;
  (adapter as unknown as { currentOnFrame: (f: LettaStreamFrame) => void }).currentOnFrame = (f) => emitted.push(f);
  (adapter as unknown as { currentApprovalScopeCache: Map<string, unknown> }).currentApprovalScopeCache = loadApprovalScopeCache(runHandle.id, "default");
  (adapter as unknown as { currentA2uiCapability: unknown }).currentA2uiCapability = { version: "0.9" };

  const cb = (adapter as unknown as {
    _handleCanUseTool: (n: string, i: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>;
  })._handleCanUseTool.bind(adapter);

  // First call: Session-scope approval. Gate resolves manually.
  const first = cb("Bash", { command: "ls" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(emitted.length, 1, "first call emits approval frame");
  resolveApprovalGate(runHandle.id, {
    decision: "approve",
    scope: "Session",
    reason: "ok for this conv",
    actionId: "act-cache-1",
  });
  assert.equal((await first).behavior, "allow");

  // Second call: SAME tool. Cached Session policy → no frame, no gate.
  const second = await cb("Bash", { command: "pwd" });
  assert.equal(emitted.length, 1, "second (cached) call must NOT emit a frame");
  assert.equal(second.behavior, "allow");
  assert.equal(second.message, "cached_approval");
});

test("sdk-adapter (lcp-sdk.5): no A2UI client → default-allow without emitting a frame", async () => {
  // The direct adapter only synthesizes approval cards when a2uiCapability
  // is negotiated. Without A2UI, the upstream approval flow has no UI to
  // drive it, so default-allow keeps the turn moving (matches direct's
  // `a2uiCapability ? ... : null` short-circuit). On SDK path we mirror.
  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-noa2ui-1" });
  (adapter as unknown as { ready: boolean }).ready = true;
  const emitted: LettaStreamFrame[] = [];
  // Set run handle + onFrame but leave a2ui null.
  (adapter as unknown as { currentRunHandle: { id: string } }).currentRunHandle = { id: "run-noop" };
  (adapter as unknown as { currentOnFrame: (f: LettaStreamFrame) => void }).currentOnFrame = (f) => emitted.push(f);
  (adapter as unknown as { currentApprovalScopeCache: Map<string, unknown> }).currentApprovalScopeCache = new Map();
  (adapter as unknown as { currentA2uiCapability: null }).currentA2uiCapability = null;

  const result = await (adapter as unknown as {
    _handleCanUseTool: (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }>;
  })._handleCanUseTool("Bash", { command: "echo" });
  assert.equal(result.behavior, "allow");
  assert.equal(emitted.length, 0, "no A2UI must mean no approval card emitted");
});

test("sdk-adapter (lcp-sdk.4): runTurn reuses a pre-supplied runHandle (lcp-99a pattern)", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = mkdtempSync(join(tmpdir(), "sdk-adapter-runhandle-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = stateDir;
  t.after(() => {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    rmSync(stateDir, { recursive: true, force: true });
  });

  const { createRun } = await import("../lib/runs.js");
  // Mobile WS pre-creates the runHandle so turn_started can carry run_id
  // before any content frame fires. The SDK adapter MUST honor that
  // handle (not create a fresh one) so frames carry the right id.
  const preCreated = createRun({ agentId: "agent-h", conversationId: "default" });

  const adapter = new SdkBackedLettaSessionAdapter({ conversationId: "default", agentId: "agent-h" });
  const { session } = makeStubSession([
    { type: "result", success: true, result: "", durationMs: 1, conversationId: "default" } as SDKResultMessage,
  ]);
  (adapter as unknown as { session: unknown }).session = session;
  (adapter as unknown as { ready: boolean }).ready = true;

  let onRunCreatedCalled = false;
  const out = await adapter.runTurn("hi", {
    runHandle: preCreated,
    onRunCreated: () => { onRunCreatedCalled = true; },
  });
  assert.equal(out.run_id, preCreated.id, "adapter must use the pre-created run id");
  assert.equal(onRunCreatedCalled, false, "onRunCreated must NOT fire when handle is pre-supplied");
});
