/**
 * End-to-end mobile-WS tests for A2UI server emission and the user_action
 * round trip (lcp-uo5 phases 2-5).
 *
 * Coverage:
 *   - A2UI capability negotiated → assistant_message chunks containing
 *     `<a2ui-json>` blocks get split into text deltas + structured
 *     `a2ui_frame` envelopes, and the JSON parses cleanly.
 *   - A2UI NOT negotiated → the splitter stays dormant and the same
 *     fixture flows through as plain text.
 *   - `user_action` ack lands and the action is recorded to the run
 *     sidecar (verified by reading the on-disk JSONL).
 *   - `user_action` with missing `name` → `protocol_violation`, no close.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { startShim, seedAgent, seedConversation, externalConvId, openMobileWs } from "./helpers/index.js";
import type { MobileWsHandle } from "./helpers/ws.js";

const WS_TIMEOUT_MS = 8_000;

interface A2uiFrame {
  type: "a2ui_frame";
  turn_id: string;
  run_id: string | null;
  ok: boolean;
  a2ui: unknown;
  otid?: string | null;
  parse_error?: string;
  validation_error?: string;
}

interface AssistantFrame {
  type: "assistant_message";
  content: string;
}

function findA2uiFrames(frames: { type: string }[]): A2uiFrame[] {
  return frames.filter((f) => f.type === "a2ui_frame") as A2uiFrame[];
}

function findAssistantFrames(frames: { type: string }[]): AssistantFrame[] {
  return frames.filter((f) => f.type === "assistant_message") as AssistantFrame[];
}

async function waitForFrameAfter(
  conn: MobileWsHandle,
  before: number,
  type: string,
  timeoutMs = WS_TIMEOUT_MS,
): Promise<{ type: string; [k: string]: unknown }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = conn.frames.slice(before).find((frame) => frame.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitForFrameAfter(${type}) timed out after ${timeoutMs}ms`);
}

async function setupAuthedA2ui(
  t: { after: (fn: () => unknown) => void },
  opts: { negotiate?: boolean; env?: Record<string, string | undefined> } = {},
) {
  const negotiate = opts.negotiate !== false;
  const shim = await startShim({
    env: negotiate
      ? { A2UI_ENABLED: "1", A2UI_VERSION: "0.9", A2UI_CATALOG_ID: "basic", ...opts.env }
      : { A2UI_ENABLED: "0", ...opts.env },
  });
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir, { id: `agent-a2ui-${Date.now()}` });
  seedConversation(shim.stateDir, agentId);
  const convId = externalConvId(agentId);
  const conn: MobileWsHandle = await openMobileWs(shim.url!, {
    token: shim.mobileToken,
    timeoutMs: WS_TIMEOUT_MS,
    helloExtras: negotiate
      ? {
          a2ui_version: "0.9",
          supported_catalogs: ["basic"],
          supported_widgets: ["Text", "Button", "ToolApprovalCard"],
        }
      : {},
  });
  t.after(() => conn.close());
  return { shim, conn, agentId, convId };
}

test("a2ui-ws: assistant_message with <a2ui-json> blocks splits into text + a2ui_frame envelopes", async (t) => {
  const { shim, conn, agentId, convId } = await setupAuthedA2ui(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "show approval card",
    otid: "cm-a2ui-1",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });

  const a2uiFrames = findA2uiFrames(turn);
  assert.equal(a2uiFrames.length, 1, `expected one a2ui_frame, got types=[${turn.map((f) => f.type).join(",")}]`);
  const frame = a2uiFrames[0]!;
  assert.equal(frame.ok, true, `a2ui_frame must be ok; parse=${frame.parse_error ?? ""} validation=${frame.validation_error ?? ""}`);
  assert.ok(frame.run_id, "a2ui_frame must carry run_id");
  assert.ok(frame.turn_id, "a2ui_frame must carry turn_id");
  const body = frame.a2ui as { version?: string; createSurface?: { surfaceId?: string; catalogId?: string } };
  assert.equal(body.version, "v0.9");
  assert.equal(body.createSurface?.surfaceId, "approval-1");
  assert.equal(body.createSurface?.catalogId, "basic");

  // Text bubbles should NOT contain raw <a2ui-json> tags — the splitter
  // strips them. The surrounding conversational text still flows through.
  const assistantText = findAssistantFrames(turn).map((f) => f.content).join("");
  assert.doesNotMatch(assistantText, /<a2ui-json>/, "raw open tag must not leak to text");
  assert.doesNotMatch(assistantText, /<\/a2ui-json>/, "raw close tag must not leak to text");
  assert.match(assistantText, /Here is the approval card/);
  assert.match(assistantText, /Tap a choice to continue/);

  await shim.waitForLogLine(/"module":"a2ui".*"event":"turn_metrics"/, { timeoutMs: WS_TIMEOUT_MS });
  const metricsLine = shim.readLog().split("\n").find((line) => line.includes('"module":"a2ui"') && line.includes('"event":"turn_metrics"'));
  assert.ok(metricsLine, "expected structured a2ui metrics log line");
  const metrics = JSON.parse(metricsLine) as Record<string, unknown>;
  assert.equal(metrics["level"], "info");
  assert.equal(metrics["module"], "a2ui");
  assert.equal(metrics["event"], "turn_metrics");
  assert.equal(typeof metrics["run_id"], "string");
  assert.equal(typeof metrics["agent_id"], "string");
  assert.equal(typeof metrics["total_frames"], "number");
  assert.equal(typeof metrics["parse_ok"], "number");
  assert.equal(typeof metrics["parse_err"], "number");
  assert.equal(typeof metrics["validate_ok"], "number");
  assert.equal(typeof metrics["validate_err"], "number");
  assert.ok(Array.isArray(metrics["widget_types_seen"]));
  assert.equal(typeof metrics["splitter_overhead_ms"], "number");
});

test("a2ui-ws: a2ui_frame is suppressed when capability is not negotiated", async (t) => {
  const { conn, agentId, convId } = await setupAuthedA2ui(t, { negotiate: false });
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "show approval card",
    otid: "cm-a2ui-2",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  assert.equal(findA2uiFrames(turn).length, 0, "splitter must stay dormant when A2UI is not negotiated");
  // Raw tags pass through to mobile as plain text (mobile dedup handles it).
  const assistantText = findAssistantFrames(turn).map((f) => f.content).join("");
  assert.match(assistantText, /<a2ui-json>/);
});

test("a2ui-ws: approval user_action resolves gated tool and records approval decision", async (t) => {
  const { shim, conn, agentId, convId } = await setupAuthedA2ui(t, {
    env: { LETTA_MOCK_APPROVAL_GATE: "1", LETTA_MOCK_FORCE_TRACE: "bash-tool" },
  });
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "run bash echo capturetest",
    otid: "cm-a2ui-approval-once",
  });
  const toolCall = await conn.waitFor("tool_call_message", { timeoutMs: WS_TIMEOUT_MS }) as unknown as {
    run_id?: string;
    tool_call?: { tool_call_id?: string };
  };
  assert.ok(toolCall.run_id, "tool_call_message must carry active run_id");
  assert.equal(toolCall.tool_call?.tool_call_id, "toolu_01QyUwQvFzwz1AvaCQhodr2A");

  const actionFrame = conn.send({
    type: "user_action",
    run_id: toolCall.run_id,
    surface_id: "approval-1",
    name: "tool_approval_choice",
    context: { tool_call_id: toolCall.tool_call?.tool_call_id, scope: "Once" },
    action_id: "act-approval-once",
  });
  const ack = await conn.waitFor("user_action_ack", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { status?: string };
  assert.equal(ack.status, "accepted");
  const outcome = await conn.waitFor("user_action_outcome", { timeoutMs: WS_TIMEOUT_MS }) as unknown as {
    frame_id?: string;
    action_id?: string;
    outcome?: string;
    detail?: { action_id?: string; routed_as?: string };
  };
  assert.equal(outcome.frame_id, actionFrame["id"]);
  assert.equal(outcome.action_id, "act-approval-once");
  assert.equal(outcome.outcome, "matched_approval");
  assert.equal(outcome.detail?.action_id, "act-approval-once");
  assert.equal(outcome.detail?.routed_as, "approval");
  const turnDone = await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { status?: string };
  assert.equal(turnDone.status, "completed");

  const path = join(shim.stateDir, "runs", toolCall.run_id, "approval-decisions.jsonl");
  assert.ok(existsSync(path), "approval decision sidecar must be written");
  const decisions = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(decisions.map((d) => d["decision"]), ["approve"]);
  assert.equal(decisions[0]?.["scope"], "Once");
  assert.equal(decisions[0]?.["action_id"], "act-approval-once");
});

test("a2ui-ws: approval timeout auto-denies and records timeout decision", async (t) => {
  const { shim, conn, agentId, convId } = await setupAuthedA2ui(t, {
    env: {
      LETTA_MOCK_APPROVAL_GATE: "1",
      LETTA_MOCK_FORCE_TRACE: "bash-tool",
      A2UI_APPROVAL_TIMEOUT_MS: "100",
    },
  });
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "run bash echo capturetest",
    otid: "cm-a2ui-approval-timeout",
  });
  const toolCall = await conn.waitFor("tool_call_message", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { run_id?: string };
  assert.ok(toolCall.run_id, "tool_call_message must carry active run_id");
  const turnDone = await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { status?: string };
  assert.equal(turnDone.status, "completed");

  const path = join(shim.stateDir, "runs", toolCall.run_id, "approval-decisions.jsonl");
  assert.ok(existsSync(path), "timeout decision sidecar must be written");
  const decisions = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(decisions.map((d) => d["decision"]), ["timeout"]);
  assert.equal(decisions[0]?.["scope"], "Deny");
});

test("a2ui-ws: approval scope=Session auto-approves the next matching tool call", async (t) => {
  const { shim, conn, agentId, convId } = await setupAuthedA2ui(t, {
    env: { LETTA_MOCK_APPROVAL_GATE: "1", LETTA_MOCK_FORCE_TRACE: "bash-tool" },
  });

  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "run bash echo capturetest",
    otid: "cm-a2ui-session-1",
  });
  const firstToolCall = await conn.waitFor("tool_call_message", { timeoutMs: WS_TIMEOUT_MS }) as unknown as {
    run_id?: string;
    tool_call?: { tool_call_id?: string };
  };
  assert.ok(firstToolCall.run_id, "first tool call must carry run_id");
  conn.send({
    type: "user_action",
    run_id: firstToolCall.run_id,
    surface_id: "approval-1",
    name: "tool_approval_choice",
    context: { tool_call_id: firstToolCall.tool_call?.tool_call_id, scope: "Session" },
    action_id: "act-approval-session",
  });
  await conn.waitFor("user_action_ack", { timeoutMs: WS_TIMEOUT_MS });
  await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS });

  const beforeSecond = conn.frames.length;
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "run bash echo capturetest again",
    otid: "cm-a2ui-session-2",
  });
  await waitForFrameAfter(conn, beforeSecond, "turn_done");
  const secondTurn = conn.frames.slice(beforeSecond);
  const secondToolCall = secondTurn.find((frame) => frame.type === "tool_call_message") as unknown as { run_id?: string } | undefined;
  assert.ok(secondToolCall, "second turn must emit a tool call");
  assert.ok(secondToolCall.run_id, "second tool call must carry run_id");
  const turnDone = secondTurn.find((frame) => frame.type === "turn_done") as unknown as { status?: string } | undefined;
  assert.ok(turnDone, "second turn must finish");
  assert.equal(turnDone.status, "completed");

  const approvalsJson = JSON.parse(readFileSync(join(shim.stateDir, "approvals.json"), "utf8")) as Array<Record<string, unknown>>;
  assert.equal(approvalsJson[0]?.["scope"], "Session");
  const secondDecisionPath = join(shim.stateDir, "runs", secondToolCall.run_id, "approval-decisions.jsonl");
  const secondDecisions = readFileSync(secondDecisionPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(secondDecisions[0]?.["reason"], "cached_approval");
  assert.equal(secondDecisions[0]?.["scope"], "Session");
});

test("a2ui-ws: approval scope=Deny refuses the gated tool and records denial", async (t) => {
  const { shim, conn, agentId, convId } = await setupAuthedA2ui(t, {
    env: { LETTA_MOCK_APPROVAL_GATE: "1", LETTA_MOCK_FORCE_TRACE: "bash-tool" },
  });
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "run bash echo capturetest",
    otid: "cm-a2ui-deny",
  });
  const toolCall = await conn.waitFor("tool_call_message", { timeoutMs: WS_TIMEOUT_MS }) as unknown as {
    run_id?: string;
    tool_call?: { tool_call_id?: string };
  };
  assert.ok(toolCall.run_id, "tool call must carry run_id");
  conn.send({
    type: "user_action",
    run_id: toolCall.run_id,
    surface_id: "approval-1",
    name: "tool_approval_choice",
    context: { tool_call_id: toolCall.tool_call?.tool_call_id, scope: "Deny", reason: "user cancelled" },
    action_id: "act-approval-deny",
  });
  await conn.waitFor("user_action_ack", { timeoutMs: WS_TIMEOUT_MS });
  const assistant = await conn.waitFor("assistant_message", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { content?: string };
  assert.match(assistant.content ?? "", /Tool call denied: user cancelled/);
  const turnDone = await conn.waitFor("turn_done", { timeoutMs: WS_TIMEOUT_MS }) as unknown as { status?: string };
  assert.equal(turnDone.status, "completed");

  const path = join(shim.stateDir, "runs", toolCall.run_id, "approval-decisions.jsonl");
  const decisions = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(decisions[0]?.["decision"], "deny");
  assert.equal(decisions[0]?.["scope"], "Deny");
  assert.equal(decisions[0]?.["reason"], "user cancelled");
});

test("a2ui-ws: non-approval user_action injects a synthetic agent turn", async (t) => {
  const { shim, conn, agentId, convId } = await setupAuthedA2ui(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "show approval card",
    otid: "cm-a2ui-action-seed",
  });
  const seedTurn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const turnStarted = seedTurn.find((frame) => frame.type === "turn_started") as unknown as { run_id?: string } | undefined;
  assert.ok(turnStarted?.run_id, "seed turn must expose a run_id for action correlation");

  const beforeAction = conn.frames.length;
  const actionFrame = conn.send({
    type: "user_action",
    run_id: turnStarted.run_id,
    surface_id: "final-roundtrip-test-btn",
    component_id: "primary-submit",
    name: "a2ui.final.submit",
    context: { componentId: "primary-submit", value: "confirmed" },
    action_id: "act-non-approval-1",
  });
  const ack = await waitForFrameAfter(conn, beforeAction, "user_action_ack") as unknown as { status?: string; routed_as?: string };
  assert.equal(ack.status, "accepted");
  assert.equal(ack.routed_as, "synthetic_input");
  const outcome = await waitForFrameAfter(conn, beforeAction, "user_action_outcome") as unknown as {
    frame_id?: string;
    action_id?: string;
    outcome?: string;
    detail?: { action_id?: string; routed_as?: string; synthetic_turn_id?: string };
  };
  assert.equal(outcome.frame_id, actionFrame["id"]);
  assert.equal(outcome.action_id, "act-non-approval-1");
  assert.equal(outcome.outcome, "injected_as_input");
  assert.equal(outcome.detail?.action_id, "act-non-approval-1");
  assert.equal(outcome.detail?.routed_as, "synthetic_input");
  assert.match(outcome.detail?.synthetic_turn_id ?? "", /^turn-/);
  await waitForFrameAfter(conn, beforeAction, "turn_done");
  const actionTurn = conn.frames.slice(beforeAction);
  assert.ok(actionTurn.some((frame) => frame.type === "turn_started"), "synthetic action must create a new turn");
  assert.ok(actionTurn.some((frame) => frame.type === "assistant_message"), "agent must respond to synthetic action input");

  const sidecar = join(shim.stateDir, "runs", turnStarted.run_id, "user-actions.jsonl");
  const entries = readFileSync(sidecar, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const actionEntry = entries.find((entry) => entry["action_id"] === "act-non-approval-1");
  assert.ok(actionEntry, "non-approval action must still be recorded to sidecar");
  assert.equal(actionEntry["routed_as"], "synthetic_input");
  assert.equal(actionEntry["component_id"], "primary-submit");
});

test("a2ui-ws: non-approval user_action without run_id uses session run fallback", async (t) => {
  const { shim, conn, agentId, convId } = await setupAuthedA2ui(t);
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "show approval card",
    otid: "cm-a2ui-action-fallback-seed",
  });
  const seedTurn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const turnStarted = seedTurn.find((frame) => frame.type === "turn_started") as unknown as { run_id?: string } | undefined;
  assert.ok(turnStarted?.run_id, "seed turn must expose a run_id for session fallback");

  const beforeAction = conn.frames.length;
  const actionFrame = conn.send({
    type: "user_action",
    run_id: null,
    surface_id: "form-demo-1",
    name: "submit",
    context: { value: "confirmed" },
    action_id: "act-no-run-id-fallback",
  });
  const ack = await waitForFrameAfter(conn, beforeAction, "user_action_ack") as unknown as { status?: string; routed_as?: string };
  assert.equal(ack.status, "accepted");
  assert.equal(ack.routed_as, "synthetic_input");
  const outcome = await waitForFrameAfter(conn, beforeAction, "user_action_outcome") as unknown as {
    frame_id?: string;
    action_id?: string;
    outcome?: string;
    detail?: { action_id?: string; routed_as?: string; synthetic_turn_id?: string; run_id?: string | null };
  };
  assert.equal(outcome.frame_id, actionFrame["id"]);
  assert.equal(outcome.action_id, "act-no-run-id-fallback");
  assert.equal(outcome.outcome, "injected_as_input");
  assert.equal(outcome.detail?.routed_as, "synthetic_input");
  assert.match(outcome.detail?.synthetic_turn_id ?? "", /^turn-/);
  const syntheticTurnStarted = await waitForFrameAfter(conn, beforeAction, "turn_started") as unknown as {
    agent_id?: string;
    conversation_id?: string;
    source?: string;
    turn_id?: string;
    run_id?: string | null;
  };
  assert.equal(syntheticTurnStarted.agent_id, agentId);
  assert.equal(syntheticTurnStarted.conversation_id, convId);
  assert.equal(syntheticTurnStarted.source, "a2ui_user_action");
  assert.equal(syntheticTurnStarted.turn_id, outcome.detail?.synthetic_turn_id);
  assert.ok(syntheticTurnStarted.run_id, "fallback-routed synthetic turn must expose its new run_id");
  await waitForFrameAfter(conn, beforeAction, "turn_done");

  const sidecar = join(shim.stateDir, "runs", turnStarted.run_id, "user-actions.jsonl");
  const entries = readFileSync(sidecar, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const actionEntry = entries.find((entry) => entry["action_id"] === "act-no-run-id-fallback");
  assert.ok(actionEntry, "fallback action must still be recorded against the session's last run");
  assert.equal(actionEntry["routed_as"], "synthetic_input");
  assert.equal(actionEntry["name"], "submit");
});

test("a2ui-ws: user_action frame returns user_action_ack and is recorded to the run sidecar", async (t) => {
  const { shim, conn, agentId, convId } = await setupAuthedA2ui(t);
  // Drive one turn so a run exists, then fire the user_action against its id.
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "show approval card",
    otid: "cm-a2ui-3",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  const turnStarted = turn.find((f) => f.type === "turn_started") as unknown as { run_id?: string } | undefined;
  const a2uiFrame = findA2uiFrames(turn)[0];
  const runId = (a2uiFrame?.run_id ?? turnStarted?.run_id) as string | undefined;
  assert.ok(runId, "run_id must surface during the turn");

  const actionFrame = conn.send({
    type: "user_action",
    run_id: runId!,
    turn_id: turnStarted?.run_id ?? null,
    surface_id: "approval-1",
    name: "tool_approval_choice",
    context: { tool_call_id: "tcid-test", scope: "once" },
    action_id: "act-test-1",
  });
  const ack = (await conn.waitFor("user_action_ack", { timeoutMs: WS_TIMEOUT_MS })) as unknown as {
    action_id: string; status: string;
  };
  assert.equal(ack.action_id, "act-test-1");
  assert.equal(ack.status, "accepted");
  const outcome = await conn.waitFor("user_action_outcome", { timeoutMs: WS_TIMEOUT_MS }) as unknown as {
    frame_id?: string;
    outcome?: string;
    detail?: { action_id?: string; routed_as?: string };
  };
  assert.equal(outcome.frame_id, actionFrame["id"]);
  assert.equal(outcome.outcome, "recorded_only");
  assert.equal(outcome.detail?.action_id, "act-test-1");
  assert.equal(outcome.detail?.routed_as, "recorded_only");

  // Sidecar verification — locate the run dir under the shim's backend
  // and confirm user-actions.jsonl carries the recorded action.
  const runsRoot = join(shim.stateDir, "runs");
  assert.ok(existsSync(runsRoot), "runs dir must exist after a turn");
  const runDirs = readdirSync(runsRoot).filter((n) => n.startsWith("run-"));
  let found: unknown = null;
  for (const dir of runDirs) {
    const path = join(runsRoot, dir, "user-actions.jsonl");
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["action_id"] === "act-test-1") {
        found = parsed;
        break;
      }
    }
    if (found) break;
  }
  assert.ok(found, `expected user_action sidecar entry to be written; runDirs=${runDirs.join(",")}`);
  const entry = found as {
    name: string;
    context: { tool_call_id?: string; scope?: string };
    session_id: string;
  };
  assert.equal(entry.name, "tool_approval_choice");
  assert.equal(entry.context.tool_call_id, "tcid-test");
  assert.equal(entry.context.scope, "once");
  assert.match(entry.session_id, /^sess-/);
});

test("a2ui-ws: user_action with missing name → protocol_violation, no close", async (t) => {
  const { conn, agentId, convId } = await setupAuthedA2ui(t);
  const actionFrame = conn.send({
    type: "user_action",
    run_id: null,
    surface_id: "x",
    context: {},
  });
  const outcome = await conn.waitFor("user_action_outcome", { timeoutMs: WS_TIMEOUT_MS }) as unknown as {
    frame_id?: string;
    outcome?: string;
    detail?: { reason?: string };
  };
  assert.equal(outcome.frame_id, actionFrame["id"]);
  assert.equal(outcome.outcome, "rejected");
  assert.match(outcome.detail?.reason ?? "", /non-empty name/);
  const err = (await conn.waitFor("error", { timeoutMs: WS_TIMEOUT_MS })) as unknown as { code: string };
  assert.equal(err.code, "protocol_violation");
  assert.equal(conn.closed, false, "socket must remain open after a soft protocol error");
  // Confirm we can still drive a turn.
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: convId,
    text: "reply with pong",
    otid: "cm-a2ui-after-err",
  });
  const turn = await conn.collectTurn({ timeoutMs: WS_TIMEOUT_MS });
  assert.ok(turn.some((f) => f.type === "turn_done"), "next turn must still complete");
});
