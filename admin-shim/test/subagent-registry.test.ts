/**
 * Regression tests for the active-subagent registry (letta-mobile-73o2h.1).
 *
 * Focus: the correlation seam — a parent `Agent` tool_call_message registers
 * a running subagent, and the matching `tool_return_message` correlates the
 * subagent's task_id + agent-local id from the background-dispatch text body.
 * Enumeration must surface active-only vs all, keyed by tool_call_id.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ingestParentFrame,
  listActiveSubagents,
  snapshotSubagents,
  getSubagent,
  markSubagentCompleted,
  markSubagentFailed,
  recordSubagentDispatch,
  __resetSubagentRegistry,
} from "../lib/subagent-registry.js";

function dispatchFrame(toolCallId: string, description: string, background = true) {
  return {
    message_type: "tool_call_message",
    tool_call: {
      tool_call_id: toolCallId,
      name: "Agent",
      arguments: JSON.stringify({
        subagent_type: "general-purpose",
        description,
        run_in_background: background,
        prompt: "do the thing",
      }),
    },
  };
}

function returnFrame(toolCallId: string, taskId: string, agentLocalId: string) {
  return {
    message_type: "tool_return_message",
    name: "Agent",
    tool_call_id: toolCallId,
    tool_return:
      `Task running in background with task ID: ${taskId}\n` +
      `Agent ID: ${agentLocalId}\n` +
      `Output file: /tmp/letta-background/${taskId}.log`,
  };
}

test("subagent-registry: Agent dispatch registers a running subagent", () => {
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  const entry = ingestParentFrame(dispatchFrame(tcid, "Implement X"), "run-parent-1");
  assert.ok(entry, "dispatch should produce a registry entry");
  assert.equal(entry!.toolCallId, tcid);
  assert.equal(entry!.status, "running");
  assert.equal(entry!.description, "Implement X");
  assert.equal(entry!.subagentType, "general-purpose");
  assert.equal(entry!.parentRunId, "run-parent-1");

  const active = listActiveSubagents();
  assert.ok(active.some((s) => s.toolCallId === tcid), "should appear in active list");
});

test("subagent-registry: Agent tool_return correlates task_id + subagent agent id", () => {
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  ingestParentFrame(dispatchFrame(tcid, "Correlate me"), "run-parent-2");
  ingestParentFrame(
    returnFrame(tcid, "task_7", "agent-local-abc12345-0000-0000-0000-000000000000"),
    "run-parent-2",
  );
  const entry = getSubagent(tcid);
  assert.ok(entry, "entry should still exist after return");
  assert.equal(entry!.taskId, "task_7");
  assert.equal(entry!.subagentAgentId, "agent-local-abc12345-0000-0000-0000-000000000000");
  // Still running until a terminal signal arrives.
  assert.equal(entry!.status, "running");
});

test("subagent-registry: non-Agent frames are ignored", () => {
  const before = snapshotSubagents().length;
  assert.equal(ingestParentFrame({ message_type: "assistant_message", content: "hi" }, "run-x"), null);
  assert.equal(
    ingestParentFrame(
      { message_type: "tool_call_message", tool_call: { tool_call_id: "t", name: "Bash", arguments: "{}" } },
      "run-x",
    ),
    null,
  );
  assert.equal(snapshotSubagents().length, before, "ignored frames must not grow the registry");
});

test("subagent-registry: terminal transitions leave active-only list", () => {
  const done = `toolu_${Math.random().toString(36).slice(2)}`;
  const failed = `toolu_${Math.random().toString(36).slice(2)}`;
  ingestParentFrame(dispatchFrame(done, "Will complete"), "run-p");
  ingestParentFrame(dispatchFrame(failed, "Will fail"), "run-p");

  markSubagentCompleted(done);
  markSubagentFailed(failed, "stream_timeout");

  const activeIds = listActiveSubagents().map((s) => s.toolCallId);
  assert.ok(!activeIds.includes(done), "completed subagent must leave active list");
  assert.ok(!activeIds.includes(failed), "failed subagent must leave active list");

  const all = snapshotSubagents();
  assert.equal(all.find((s) => s.toolCallId === done)?.status, "completed");
  const failedEntry = all.find((s) => s.toolCallId === failed);
  assert.equal(failedEntry?.status, "failed");
  assert.equal(failedEntry?.failureReason, "stream_timeout");
});

// ── lcp-zncq: source field ──────────────────────────────────────────────

test("subagent-registry: source defaults to 'letta' for Agent-tool dispatch via ingestParentFrame", () => {
  __resetSubagentRegistry();
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  const entry = ingestParentFrame(dispatchFrame(tcid, "source check"), "run-src");
  assert.ok(entry);
  assert.equal(entry!.source, "letta", "Agent-tool dispatch should default source to 'letta'");
  __resetSubagentRegistry();
});

test("subagent-registry: recordSubagentDispatch accepts explicit source", () => {
  __resetSubagentRegistry();
  const entry = recordSubagentDispatch({
    toolCallId: "ext-vibesync-mol-1-step-2",
    parentRunId: null,
    args: { description: "vibe check", run_in_background: false },
    source: "vibesync",
  });
  assert.equal(entry.source, "vibesync");
  assert.equal(entry.toolCallId, "ext-vibesync-mol-1-step-2");
  __resetSubagentRegistry();
});

test("subagent-registry: recordSubagentDispatch defaults source to 'letta' when omitted", () => {
  __resetSubagentRegistry();
  const entry = recordSubagentDispatch({
    toolCallId: "toolu_no_source",
    parentRunId: null,
    args: { description: "no source given", run_in_background: false },
  });
  assert.equal(entry.source, "letta", "omitted source should default to 'letta'");
  __resetSubagentRegistry();
});
