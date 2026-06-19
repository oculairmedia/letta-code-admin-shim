import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __clearContinuationState, maybeContinue as realMaybeContinue } from "../lib/goal-continuation.js";
import { rekickActiveGoalContinuationsOnBoot } from "../lib/mobile-channel-host.js";

let cwd: string;
let prevCwd: string;
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "goal-boot-cwd-"));
  home = mkdtempSync(join(tmpdir(), "goal-boot-home-"));
  mkdirSync(join(cwd, ".letta"), { recursive: true });
  mkdirSync(join(home, ".letta"), { recursive: true });
  prevCwd = process.cwd();
  prevHome = process.env["HOME"];
  process.chdir(cwd);
  process.env["HOME"] = home;
  __clearContinuationState();
});

afterEach(() => {
  __clearContinuationState();
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeLocalSettings(value: unknown): void {
  writeFileSync(join(cwd, ".letta", "settings.local.json"), JSON.stringify(value, null, 2));
}

test("boot re-kick calls maybeContinue once for each active resolved goal only", async () => {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/one": { agentId: "agent-one", conversationId: "default" },
      "local:/tmp/two": { agentId: "agent-two", conversationId: "conv-two" },
      "local:/tmp/paused": { agentId: "agent-paused", conversationId: "conv-paused" },
      "local:/tmp/complete": { agentId: "agent-complete", conversationId: "conv-complete" },
      "local:/tmp/cleared": { agentId: "agent-cleared", conversationId: "conv-cleared" },
    },
    conversationGoalsByServer: {
      "local:/tmp/one": { default: { objective: "one", status: "active" } },
      "local:/tmp/two": { "conv-two": { objective: "two", status: "active" } },
      "local:/tmp/paused": { "conv-paused": { objective: "paused", status: "paused" } },
      "local:/tmp/complete": { "conv-complete": { objective: "complete", status: "complete" } },
      "local:/tmp/cleared": {},
    },
  });
  const calls: Array<{ conversationId: string; agentId: string }> = [];

  const count = await rekickActiveGoalContinuationsOnBoot({
    resolveConversation: async (conversationId) => {
      if (conversationId === "conv-default-agent-one") return { agentId: "agent-one", conversationId: "default" };
      if (conversationId === "conv-two") return { agentId: "agent-two", conversationId: "conv-two" };
      return null;
    },
    maybeContinue: async (conversationId, agentId) => {
      calls.push({ conversationId, agentId });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(count, 2);
  assert.deepEqual(calls, [
    { conversationId: "conv-default-agent-one", agentId: "agent-one" },
    { conversationId: "conv-two", agentId: "agent-two" },
  ]);
});

test("goal continuation single-flight prevents duplicate boot starts", async () => {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/one": { agentId: "agent-one", conversationId: "conv-one" },
    },
    conversationGoalsByServer: {
      "local:/tmp/one": { "conv-one": { objective: "one", status: "active" } },
    },
  });
  let sends = 0;
  let status = "active";
  const sendFn = async () => {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = "complete";
    return { assistantText: "", usage: {} };
  };
  const getter = () => ({
    source: "letta_code_goal_mode" as const,
    server_key: "local:/tmp/one",
    agent_id: "agent-one",
    conversation_id: "conv-one",
    goal: { objective: "one", status },
  });
  const accrue = () => null;

  await Promise.all([
    realMaybeContinue("conv-one", "agent-one", sendFn, getter, accrue),
    realMaybeContinue("conv-one", "agent-one", sendFn, getter, accrue),
  ]);

  assert.equal(sends, 1);
});
