import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveApprovalGate,
  rejectApprovalGate,
  waitForApprovalDecision,
} from "../lib/agent-pool.js";

describe("agent-pool approval gates", () => {
  test("resolveApprovalGate returns false for unknown runId", () => {
    const result = resolveApprovalGate("unknown-run", {
      decision: "approve",
      scope: "Once",
      reason: "ok",
      actionId: "a1",
    });
    assert.equal(result, false);
  });

  test("resolveApprovalGate resolves a pending gate", async () => {
    const p = waitForApprovalDecision("run-resolve-1", "myTool", "tc-123");

    const result = resolveApprovalGate("run-resolve-1", {
      decision: "approve",
      scope: "Once",
      reason: "user said yes",
      actionId: "a2",
    });

    assert.equal(result, true);

    const decision = await p;
    assert.equal(decision.decision, "approve");
    assert.equal(decision.reason, "user said yes");
  });

  test("rejectApprovalGate returns false for unknown runId", () => {
    const result = rejectApprovalGate("unknown-run", new Error("foo"));
    assert.equal(result, false);
  });

  test("rejectApprovalGate rejects a pending gate", async () => {
    const p = waitForApprovalDecision("run-reject-1", "myTool", "tc-456");

    const result = rejectApprovalGate("run-reject-1", new Error("cancel"));
    assert.equal(result, true);

    await assert.rejects(p, /cancel/);
  });

  test("waitForApprovalDecision times out", async () => {
    const p = waitForApprovalDecision("run-timeout-1", "myTool", "tc-789", 10);

    await assert.rejects(p, /approval_timeout: no decision for myTool within 10ms/);
  });
});
