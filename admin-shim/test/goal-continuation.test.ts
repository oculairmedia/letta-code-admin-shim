/**
 * Tests for the shim-side goal continuation driver.
 *
 * Uses dependency injection (fake sendFn + fake status getter) so no real
 * turns are spawned and no native settings file is touched.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  maybeContinue,
  stopContinuation,
  isContinuationActive,
  buildContinuationPrompt,
  configureGoalContinuationCancellation,
  __clearContinuationState,
  type GoalContinuationSendArgs,
} from "../lib/goal-continuation.js";
import { __clearGoalEventSubscribers, subscribeGoalEvents } from "../lib/goal-events.js";
import type { NativeGoalStatusResponse } from "../lib/native-goal-mode.js";

afterEach(() => {
  __clearGoalEventSubscribers();
});

function statusResponse(
  conversationId: string,
  goal: {
    objective?: string;
    status: string;
    tokensUsed?: number;
    tokenBudget?: number | null;
    activeTimeSeconds?: number;
  } | null,
): NativeGoalStatusResponse {
  return {
    source: "letta_code_goal_mode",
    server_key: "test",
    agent_id: "agent-test",
    conversation_id: conversationId,
    goal: goal
      ? {
          objective: goal.objective ?? "do the thing",
          status: goal.status,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          activeStartedAt: "2026-01-01T00:00:00.000Z",
          activeTimeSeconds: goal.activeTimeSeconds ?? 0,
          tokensUsed: goal.tokensUsed ?? 0,
          tokenBudget: goal.tokenBudget ?? null,
        }
      : null,
  } as NativeGoalStatusResponse;
}

test("continuation prompt matches native completion audit guidance", () => {
  const prompt = buildContinuationPrompt({
    objective: "Say OK <now>",
    status: "active",
    tokensUsed: 10,
    tokenBudget: 100,
    activeTimeSeconds: 3,
  });
  assert.match(prompt, /Build a prompt-to-artifact checklist/);
  assert.match(prompt, /Do not rely on intent, partial progress/);
  assert.match(prompt, /call goal_control\(\{\"action\":\"complete\"\}\) so usage accounting is preserved/);
  assert.match(prompt, /Do not call goal_control unless the goal is complete or blocked/);
  assert.match(prompt, /Say OK &lt;now&gt;/);
});

test("continues while active, stops when status flips to complete", async () => {
  __clearContinuationState();
  const conv = "conv-a";
  let calls = 0;
  const status = { value: statusResponse(conv, { status: "active" }) };
  const sendFn = async (_args: GoalContinuationSendArgs) => {
    calls += 1;
    if (calls >= 3) status.value = statusResponse(conv, { status: "complete" });
    return "working...";
  };
  await maybeContinue(conv, "agent-test", sendFn, () => status.value);
  assert.equal(calls, 3, "should run until status flipped to complete");
  assert.equal(isContinuationActive(conv), false);
});

test("stops when status flips to paused", async () => {
  __clearContinuationState();
  const conv = "conv-p";
  let calls = 0;
  const status = { value: statusResponse(conv, { status: "active" }) };
  const sendFn = async () => {
    calls += 1;
    if (calls >= 2) status.value = statusResponse(conv, { status: "paused" });
    return "ok";
  };
  await maybeContinue(conv, "agent-test", sendFn, () => status.value);
  assert.equal(calls, 2);
});

test("stops when status flips to blocked", async () => {
  __clearContinuationState();
  const conv = "conv-b";
  let calls = 0;
  const status = { value: statusResponse(conv, { status: "active" }) };
  const sendFn = async () => {
    calls += 1;
    if (calls >= 1) status.value = statusResponse(conv, { status: "blocked" });
    return "ok";
  };
  await maybeContinue(conv, "agent-test", sendFn, () => status.value);
  assert.equal(calls, 1);
});

test("stops on <goal_status>complete</goal_status> sentinel", async () => {
  __clearContinuationState();
  const conv = "conv-s";
  let calls = 0;
  const status = { value: statusResponse(conv, { status: "active" }) };
  const sendFn = async () => {
    calls += 1;
    return calls >= 2 ? "done <goal_status>complete</goal_status>" : "working";
  };
  await maybeContinue(conv, "agent-test", sendFn, () => status.value);
  assert.equal(calls, 2, "sentinel should stop the loop");
});

test("stops when token budget reached through accrued continuation usage", async () => {
  __clearContinuationState();
  const conv = "conv-budget";
  let calls = 0;
  const used = { n: 0 };
  const sendFn = async () => {
    calls += 1;
    return { assistantText: "ok", usage: { tokensUsed: 40 } };
  };
  const getter = () =>
    statusResponse(conv, { status: "active", tokensUsed: used.n, tokenBudget: 100 });
  const accrue = (delta: { tokensUsed?: number }) => {
    used.n += delta.tokensUsed ?? 0;
    return statusResponse(conv, { status: "active", tokensUsed: used.n, tokenBudget: 100 });
  };
  await maybeContinue(conv, "agent-test", sendFn, getter, accrue);
  // 0 -> accrue(40) -> 40 -> accrue(80) -> 80 -> accrue(120) -> 120 >= 100 stop.
  assert.equal(calls, 3);
  assert.equal(used.n, 120);
});

test("stops at max-iteration cap", async () => {
  __clearContinuationState();
  process.env["SHIM_GOAL_MAX_ITERATIONS"] = "4";
  // Re-import a fresh module instance to pick up the env cap.
  const mod = await import(`../lib/goal-continuation.js?cap=${Date.now()}`);
  mod.__clearContinuationState();
  const conv = "conv-cap";
  let calls = 0;
  const sendFn = async () => {
    calls += 1;
    return "ok";
  };
  const getter = () => statusResponse(conv, { status: "active" });
  await mod.maybeContinue(conv, "agent-test", sendFn, getter);
  assert.equal(calls, 4, "should stop at the iteration cap");
  delete process.env["SHIM_GOAL_MAX_ITERATIONS"];
});

test("does not start if no active goal", async () => {
  __clearContinuationState();
  const conv = "conv-none";
  let calls = 0;
  const sendFn = async () => {
    calls += 1;
    return "ok";
  };
  await maybeContinue(conv, "agent-test", sendFn, () => statusResponse(conv, null));
  assert.equal(calls, 0);
});

test("does not start if goal status is not active", async () => {
  __clearContinuationState();
  const conv = "conv-paused-start";
  let calls = 0;
  const sendFn = async () => {
    calls += 1;
    return "ok";
  };
  await maybeContinue(conv, "agent-test", sendFn, () => statusResponse(conv, { status: "paused" }));
  assert.equal(calls, 0);
});

test("single-flight: concurrent calls don't double-run", async () => {
  __clearContinuationState();
  const conv = "conv-sf";
  let calls = 0;
  let resolveFirst: (() => void) | null = null;
  const status = { value: statusResponse(conv, { status: "active" }) };
  const sendFn = async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise<void>((r) => (resolveFirst = r));
      status.value = statusResponse(conv, { status: "complete" });
    }
    return "ok";
  };
  const p1 = maybeContinue(conv, "agent-test", sendFn, () => status.value);
  // Second call while first is in-flight must be a no-op.
  await maybeContinue(conv, "agent-test", sendFn, () => status.value);
  assert.equal(calls, 1, "second call should not start a parallel loop");
  resolveFirst!();
  await p1;
  assert.equal(calls, 1);
});

test("stops on sendFn error and logs loudly", async () => {
  __clearContinuationState();
  const conv = "conv-err";
  let calls = 0;
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    logs.push(String(message));
  };
  const sendFn = async () => {
    calls += 1;
    throw new Error("conversation not found");
  };
  const getter = () => statusResponse(conv, { status: "active" });
  try {
    await maybeContinue(conv, "agent-test", sendFn, getter);
  } finally {
    console.error = originalError;
  }
  assert.equal(calls, 1, "should stop after first error, not spin");
  assert.equal(isContinuationActive(conv), false);
  assert.match(logs.join("\n"), /\[goal-continuation\] turn failed conv=conv-err agent=agent-test otid=goalcont-conv-err-1: conversation not found/);
});

test("stopContinuation cancels a running loop", async () => {
  __clearContinuationState();
  const conv = "conv-cancel";
  let calls = 0;
  const status = { value: statusResponse(conv, { status: "active" }) };
  const sendFn = async () => {
    calls += 1;
    stopContinuation(conv);
    return "ok";
  };
  await maybeContinue(conv, "agent-test", sendFn, () => status.value);
  assert.equal(calls, 1, "stopContinuation should halt after current iteration");
});

test("stopContinuation cancels current in-flight run", async () => {
  __clearContinuationState();
  const conv = "conv-cancel-run";
  const cancelledRuns: string[] = [];
  configureGoalContinuationCancellation((runId) => {
    cancelledRuns.push(runId);
    return true;
  });
  let release: (() => void) | null = null;
  const sendFn = async (args: GoalContinuationSendArgs) => {
    args.onRunCreated?.("run-current");
    stopContinuation(conv);
    await new Promise<void>((resolve) => { release = resolve; });
    return "ok";
  };
  const promise = maybeContinue(conv, "agent-test", sendFn, () => statusResponse(conv, { status: "active" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancelledRuns, ["run-current"]);
  release!();
  await promise;
});


test("accrues continuation turn usage and broadcasts goals_updated", async () => {
  __clearContinuationState();
  const conv = "conv-usage";
  let tokensUsed = 0;
  const events: NativeGoalStatusResponse[] = [];
  subscribeGoalEvents((event) => {
    events.push(event.status);
  });
  const sendFn = async () => {
    return { assistantText: "<goal_status>complete</goal_status>", usage: { tokensUsed: 37, activeSeconds: 1 } };
  };
  const getter = () => statusResponse(conv, { status: "active", tokensUsed, tokenBudget: 100 });
  const accrue = (delta: { tokensUsed?: number }) => {
    tokensUsed += delta.tokensUsed ?? 0;
    return statusResponse(conv, { status: "active", tokensUsed, tokenBudget: 100 });
  };

  await maybeContinue(conv, "agent-test", sendFn, getter, accrue);

  assert.equal(tokensUsed, 37);
  assert.ok(events.some((status) => status.goal?.tokensUsed === 37), "usage accrual should broadcast updated goal status");
});
