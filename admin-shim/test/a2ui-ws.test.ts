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

async function setupAuthedA2ui(t: { after: (fn: () => unknown) => void }, opts: { negotiate?: boolean } = {}) {
  const negotiate = opts.negotiate !== false;
  const shim = await startShim({
    env: negotiate
      ? { A2UI_ENABLED: "1", A2UI_VERSION: "0.9", A2UI_CATALOG_ID: "basic" }
      : { A2UI_ENABLED: "0" },
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

  conn.send({
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
  conn.send({
    type: "user_action",
    run_id: null,
    surface_id: "x",
    context: {},
  });
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
