/**
 * lcp-r0m — `inFlightMessageIds` snapshot-based filter.
 *
 * Pure-unit tests for the runs.ts helpers that the REST /messages
 * handler uses to drop disk records still being streamed by an active
 * WS turn. The previous helper relied on `record.message_ids`, which
 * is populated AT turn end — meaning the filter was empty during the
 * actual mid-turn race. The new shape takes a caller-supplied current
 * disk id set and returns the post-turn-start delta.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRun,
  finalizeRun,
  inFlightMessageIds,
  inFlightOtids,
  recordRunOtid,
  setMessageIdsAtTurnStart,
} from "../lib/runs.js";

function withTempState<T>(fn: () => T): T {
  // runs.ts writes state under LETTA_LOCAL_BACKEND_DIR/runs/<id>/run.json.
  // Point at a fresh temp dir so concurrent runs don't pollute each
  // other (tests run serially in this suite, but cleanup is cheap).
  const dir = mkdtempSync(join(tmpdir(), "lcp-r0m-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return fn();
  } finally {
    if (prev !== undefined) process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    else delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    rmSync(dir, { recursive: true, force: true });
  }
}

test("inFlightMessageIds: empty when no active runs", () => {
  withTempState(() => {
    const out = inFlightMessageIds("agent-x", "conv-y", ["ui-msg-1", "ui-msg-2"]);
    assert.equal(out.size, 0);
  });
});

test("inFlightMessageIds: returns disk ids NOT in the active run's pre-turn snapshot", () => {
  withTempState(() => {
    const handle = createRun({ agentId: "agent-x", conversationId: "conv-y" });
    setMessageIdsAtTurnStart(handle, ["ui-msg-1", "ui-msg-2"]);
    // Current disk has the originals plus three new ones that landed during
    // the turn: the in-flight assistant snapshot, plus its tool fan-out.
    const inFlight = inFlightMessageIds("agent-x", "conv-y", [
      "ui-msg-1",
      "ui-msg-2",
      "ui-msg-3",
      "ui-msg-4",
      "ui-msg-5",
    ]);
    assert.deepEqual([...inFlight].sort(), ["ui-msg-3", "ui-msg-4", "ui-msg-5"]);
    finalizeRun(handle, { status: "completed", stopReason: "end_turn", usage: null });
  });
});

test("inFlightMessageIds: empty when current disk matches snapshot exactly", () => {
  withTempState(() => {
    const handle = createRun({ agentId: "agent-x", conversationId: "conv-y" });
    setMessageIdsAtTurnStart(handle, ["ui-msg-1", "ui-msg-2"]);
    // Turn started but nothing has been persisted yet — same disk ids.
    const inFlight = inFlightMessageIds("agent-x", "conv-y", ["ui-msg-1", "ui-msg-2"]);
    assert.equal(inFlight.size, 0);
    finalizeRun(handle, { status: "completed", stopReason: "end_turn", usage: null });
  });
});

test("inFlightMessageIds: only returns ids scoped to the (agent, conv) pair", () => {
  withTempState(() => {
    const meridian = createRun({ agentId: "agent-meridian", conversationId: "default" });
    const other = createRun({ agentId: "agent-other", conversationId: "default" });
    setMessageIdsAtTurnStart(meridian, ["ui-msg-1"]);
    setMessageIdsAtTurnStart(other, ["ui-msg-1", "ui-msg-2"]);

    // Looking up Meridian's conv must NOT pull `other`'s snapshot —
    // they're different agents.
    const inFlight = inFlightMessageIds("agent-meridian", "default", ["ui-msg-1", "ui-msg-2"]);
    assert.deepEqual([...inFlight], ["ui-msg-2"]);
    finalizeRun(meridian, { status: "completed", stopReason: "end_turn", usage: null });
    finalizeRun(other, { status: "completed", stopReason: "end_turn", usage: null });
  });
});

test("inFlightMessageIds: finalized runs drop out — filter goes back to empty", () => {
  withTempState(() => {
    const handle = createRun({ agentId: "agent-x", conversationId: "conv-y" });
    setMessageIdsAtTurnStart(handle, ["ui-msg-1"]);
    let inFlight = inFlightMessageIds("agent-x", "conv-y", ["ui-msg-1", "ui-msg-2"]);
    assert.deepEqual([...inFlight], ["ui-msg-2"]);

    finalizeRun(handle, { status: "completed", stopReason: "end_turn", usage: null });
    inFlight = inFlightMessageIds("agent-x", "conv-y", ["ui-msg-1", "ui-msg-2"]);
    assert.equal(inFlight.size, 0);
    finalizeRun(handle, { status: "completed", stopReason: "end_turn", usage: null });
  });
});

test("inFlightMessageIds: legacy no-arg shape falls back to record.message_ids", () => {
  withTempState(() => {
    // No call to setMessageIdsAtTurnStart — exercises the fallback branch
    // for callers that haven't migrated to the snapshot model.
    const handle = createRun({ agentId: "agent-x", conversationId: "conv-y" });
    // Force an entry into record.message_ids the same way finalize would.
    handle.record.message_ids.push("ui-msg-legacy");
    const inFlight = inFlightMessageIds("agent-x", "conv-y");
    assert.deepEqual([...inFlight], ["ui-msg-legacy"]);
    finalizeRun(handle, { status: "completed", stopReason: "end_turn", usage: null });
  });
});

// ── Otid tracking (parallel-track helper for forward-compat) ───────────

test("inFlightOtids: tracks otids stamped during the stream", () => {
  withTempState(() => {
    const handle = createRun({ agentId: "agent-x", conversationId: "conv-y" });
    recordRunOtid(handle, "provider-assistant-0-abc");
    recordRunOtid(handle, "provider-assistant-0-def");
    // Idempotent — same otid stamped twice doesn't duplicate.
    recordRunOtid(handle, "provider-assistant-0-abc");

    const otids = inFlightOtids("agent-x", "conv-y");
    assert.deepEqual([...otids].sort(), ["provider-assistant-0-abc", "provider-assistant-0-def"]);
    finalizeRun(handle, { status: "completed", stopReason: "end_turn", usage: null });
  });
});

test("inFlightOtids: empty after finalize", () => {
  withTempState(() => {
    const handle = createRun({ agentId: "agent-x", conversationId: "conv-y" });
    recordRunOtid(handle, "provider-assistant-0-abc");
    finalizeRun(handle, { status: "completed", stopReason: "end_turn", usage: null });
    const otids = inFlightOtids("agent-x", "conv-y");
    assert.equal(otids.size, 0);
    finalizeRun(handle, { status: "completed", stopReason: "end_turn", usage: null });
  });
});
