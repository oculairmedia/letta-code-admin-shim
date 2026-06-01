/**
 * lcp-12w — synthetic settlement on tool-call interrupt or cancel.
 *
 * Companion to the lcp-ezv healer tests: same on-disk shape, same temp
 * stateDir scaffolding. The healer runs after the orphan has already
 * leaked into messages.jsonl; this runs at end-of-turn to prevent the
 * leak in the first place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  settleDanglingToolCallsFromFrames,
} from "../lib/turn-settlement.js";
import { finalizeTurnLifecycle } from "../lib/agent-pool.js";
import { createRun } from "../lib/runs.js";
import type { LettaStreamFrame } from "../lib/types/letta-stream.js";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function makeTempStateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lcp-12w-"));
  process.env["LETTA_LOCAL_BACKEND_DIR"] = d;
  return d;
}

function seedConv(stateDir: string, conv: string, agent: string): string {
  const key = conv === "default" ? `default:${agent}` : `conversation:${conv}`;
  const dir = join(stateDir, "conversations", b64url(key));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "conversation.json"), JSON.stringify({ id: conv, agent_id: agent }));
  writeFileSync(join(dir, "messages.jsonl"), "");
  return dir;
}

function writeMessages(convDir: string, records: unknown[]): void {
  const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  writeFileSync(join(convDir, "messages.jsonl"), body);
}

function readMessages(convDir: string): Record<string, unknown>[] {
  const raw = readFileSync(join(convDir, "messages.jsonl"), "utf8");
  return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function toolCallFrame(toolName: string, toolCallId: string): LettaStreamFrame {
  return {
    type: "stream_event",
    session_id: "sess-test",
    uuid: `uuid-${toolCallId}`,
    timestamp: new Date().toISOString(),
    event: {
      message_type: "tool_call_message",
      tool_call: { name: toolName, arguments: "{}", tool_call_id: toolCallId },
    },
  } as unknown as LettaStreamFrame;
}

function approvalRequestFrame(toolName: string, toolCallId: string): LettaStreamFrame {
  return {
    type: "stream_event",
    session_id: "sess-test",
    uuid: `uuid-${toolCallId}`,
    timestamp: new Date().toISOString(),
    event: {
      message_type: "approval_request_message",
      tool_call: { name: toolName, arguments: "{}", tool_call_id: toolCallId },
    },
  } as unknown as LettaStreamFrame;
}

function stopReasonFrame(stopReason: string): LettaStreamFrame {
  return {
    type: "stream_event",
    session_id: "sess-test",
    uuid: `uuid-stop-${stopReason}`,
    timestamp: new Date().toISOString(),
    event: {
      message_type: "stop_reason",
      stop_reason: stopReason,
    },
  } as unknown as LettaStreamFrame;
}

// ── Detection: frames carry tool_call.tool_call_id from both shapes ────

test("settle: collects ids from tool_call_message AND approval_request_message frames", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agent = "agent-test-1";
    const conv = seedConv(stateDir, "default", agent);
    const before = new Set<string>(); // empty transcript

    const report = await settleDanglingToolCallsFromFrames({
      frames: [
        toolCallFrame("Bash", "toolu_aaa"),
        approvalRequestFrame("Edit", "toolu_bbb"),
      ],
      conversationId: "default",
      agentId: agent,
      runId: "run-test-1",
      reason: "cancelled",
      messageIdsBefore: before,
      stateDir,
    });

    assert.deepEqual(report.emitted.sort(), ["toolu_aaa", "toolu_bbb"]);
    assert.equal(report.settled.length, 2);
    assert.equal(report.messagesAppended, 2);

    const onDisk = readMessages(conv);
    const synths = onDisk.filter((m) => m["role"] === "toolResult");
    assert.equal(synths.length, 2);
    for (const s of synths) {
      assert.equal(s["isError"], true);
      assert.ok(typeof s["toolCallId"] === "string");
      assert.ok(String(s["id"]).startsWith("synth-settle:run-test-1:"));
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── No-op cases ────────────────────────────────────────────────────────

test("settle: no-op when no frames carry tool_call (clean text-only turn)", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agent = "agent-test-2";
    seedConv(stateDir, "default", agent);
    const report = await settleDanglingToolCallsFromFrames({
      frames: [],
      conversationId: "default",
      agentId: agent,
      runId: "run-test-2",
      reason: "stream_dropped",
      messageIdsBefore: new Set(),
      stateDir,
    });
    assert.deepEqual(report.emitted, []);
    assert.deepEqual(report.settled, []);
    assert.equal(report.messagesAppended, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("settle: no-op when every tool_call already has a new toolResult on disk", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agent = "agent-test-3";
    const convDir = seedConv(stateDir, "default", agent);
    // Pre-existing transcript: one old assistant + old toolResult (snapshot
    // before this turn started).
    writeMessages(convDir, [
      { id: "ui-msg-1", role: "assistant", content: [{ type: "text", text: "earlier" }] },
    ]);
    const before = new Set<string>(["ui-msg-1"]);
    // During the turn the CLI emits a tool_call_message frame AND lands a
    // matching new toolResult on disk before we settle.
    writeMessages(convDir, [
      { id: "ui-msg-1", role: "assistant", content: [{ type: "text", text: "earlier" }] },
      {
        id: "ui-msg-2",
        role: "toolResult",
        toolCallId: "toolu_xyz",
        content: [{ type: "text", text: "ok" }],
        parts: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ]);
    const report = await settleDanglingToolCallsFromFrames({
      frames: [toolCallFrame("Bash", "toolu_xyz")],
      conversationId: "default",
      agentId: agent,
      runId: "run-test-3",
      reason: "stream_dropped",
      messageIdsBefore: before,
      stateDir,
    });
    assert.deepEqual(report.emitted, ["toolu_xyz"]);
    assert.deepEqual(report.returned, ["toolu_xyz"]);
    assert.deepEqual(report.settled, []);
    assert.equal(report.messagesAppended, 0);
    // Transcript untouched
    const onDisk = readMessages(convDir);
    assert.equal(onDisk.length, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── Mixed: one returned, one dangling ──────────────────────────────────

test("settle: only writes a synth toolResult for the dangling id", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agent = "agent-test-4";
    const convDir = seedConv(stateDir, "default", agent);
    writeMessages(convDir, [
      { id: "ui-msg-1", role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    const before = new Set<string>(["ui-msg-1"]);
    // Two tool calls emitted; only one returned on disk.
    writeMessages(convDir, [
      { id: "ui-msg-1", role: "user", content: [{ type: "text", text: "hi" }] },
      {
        id: "ui-msg-2",
        role: "toolResult",
        toolCallId: "toolu_done",
        content: [{ type: "text", text: "ok" }],
        parts: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ]);
    const report = await settleDanglingToolCallsFromFrames({
      frames: [
        toolCallFrame("Bash", "toolu_done"),
        toolCallFrame("Edit", "toolu_dangling"),
      ],
      conversationId: "default",
      agentId: agent,
      runId: "run-test-4",
      reason: "turn_timeout",
      messageIdsBefore: before,
      stateDir,
    });
    assert.equal(report.settled.length, 1);
    assert.equal(report.settled[0]!.tool_call_id, "toolu_dangling");
    assert.equal(report.settled[0]!.tool_name, "Edit");
    assert.equal(report.messagesAppended, 1);

    const onDisk = readMessages(convDir);
    const synth = onDisk.find((m) => String(m["id"]).startsWith("synth-settle:"));
    assert.ok(synth, "synthetic toolResult missing");
    assert.equal(synth!["toolCallId"], "toolu_dangling");
    assert.equal(synth!["isError"], true);
    const text = (synth!["content"] as Array<{ text: string }>)[0]!.text;
    assert.match(text, /turn timeout/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── Reason text routing ────────────────────────────────────────────────

test("settle: reason text matches the SettlementReason variant", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agent = "agent-test-5";
    seedConv(stateDir, "default", agent);
    const before = new Set<string>();
    const cases: Array<[Parameters<typeof settleDanglingToolCallsFromFrames>[0]["reason"], RegExp]> = [
      ["cancelled", /cancellation/i],
      ["turn_timeout", /turn timeout/i],
      ["worker_exit", /worker exit/i],
      ["stream_dropped", /stream drop/i],
      ["requires_approval", /approval was required/i],
    ];
    for (const [reason, pattern] of cases) {
      const fresh = makeTempStateDir();
      const convDir = seedConv(fresh, "default", agent);
      const report = await settleDanglingToolCallsFromFrames({
        frames: [toolCallFrame("Bash", `toolu_${reason}`)],
        conversationId: "default",
        agentId: agent,
        runId: `run-${reason}`,
        reason,
        messageIdsBefore: before,
        stateDir: fresh,
      });
      assert.equal(report.messagesAppended, 1);
      const onDisk = readMessages(convDir);
      const text = (onDisk[0]!["content"] as Array<{ text: string }>)[0]!.text;
      assert.match(text, pattern, `expected ${pattern} for reason=${reason}, got ${text}`);
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("finalizeTurnLifecycle: requires_approval settles emitted tool calls before next turn", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agent = "agent-test-approval";
    const convDir = seedConv(stateDir, "default", agent);
    writeMessages(convDir, [
      { id: "ui-msg-1", role: "user", parts: [{ type: "text", text: "run a tool" }] },
    ]);
    const before = new Set<string>(["ui-msg-1"]);
    const runHandle = createRun({ agentId: agent, conversationId: "default" });

    await finalizeTurnLifecycle({
      runHandle,
      frames: [
        toolCallFrame("Bash", "toolu_needs_approval"),
        stopReasonFrame("requires_approval"),
      ],
      conversationId: "default",
      agentId: agent,
      messageIdsBefore: before,
      turnStartedAt: new Date("2026-06-01T00:00:00.000Z"),
      cancelled: false,
      finishedExit: false,
      finishedTimeout: false,
    });

    const onDisk = readMessages(convDir);
    const synth = onDisk.find((m) => String(m["id"]).startsWith(`synth-settle:${runHandle.id}:`));
    assert.ok(synth, "requires_approval turn must settle the dangling tool call");
    assert.equal(synth!["toolCallId"], "toolu_needs_approval");
    assert.equal(synth!["isError"], true);
    const text = (synth!["content"] as Array<{ text: string }>)[0]!.text;
    assert.match(text, /approval was required/i);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── Audit sidecar ──────────────────────────────────────────────────────

test("settle: writes settlements.jsonl audit entry alongside run state", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agent = "agent-test-6";
    seedConv(stateDir, "default", agent);
    const runId = "run-audit-test";
    await settleDanglingToolCallsFromFrames({
      frames: [toolCallFrame("Bash", "toolu_aud")],
      conversationId: "default",
      agentId: agent,
      runId,
      reason: "cancelled",
      messageIdsBefore: new Set(),
      stateDir,
    });
    // Audit lands at <stateDir>/../state/runs/<runId>/settlements.jsonl
    const auditPath = join(stateDir, "..", "state", "runs", runId, "settlements.jsonl");
    assert.ok(existsSync(auditPath), `audit file missing at ${auditPath}`);
    const raw = readFileSync(auditPath, "utf8").trim();
    const entry = JSON.parse(raw);
    assert.equal(entry.run_id, runId);
    assert.equal(entry.reason, "cancelled");
    assert.equal(entry.settled.length, 1);
    assert.equal(entry.settled[0].tool_call_id, "toolu_aud");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});
