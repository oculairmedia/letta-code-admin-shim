import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentPool, type LettaSessionAdapter, type LettaSessionAdapterOptions, type RunTurnOptions } from "../lib/agent-pool.js";
import { GOAL_CONTROL_TOOL_NAME, handleGoalControl, makeGoalControlTool, shouldInjectGoalControlTool } from "../lib/goal-control-tool.js";
import { subscribeGoalEvents, __clearGoalEventSubscribers } from "../lib/goal-events.js";
import { getNativeGoalForConversation } from "../lib/native-goal-mode.js";

let cwd: string;
let prevCwd: string;
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "goal-control-cwd-"));
  home = mkdtempSync(join(tmpdir(), "goal-control-home-"));
  mkdirSync(join(cwd, ".letta"), { recursive: true });
  mkdirSync(join(home, ".letta"), { recursive: true });
  prevCwd = process.cwd();
  prevHome = process.env["HOME"];
  process.chdir(cwd);
  process.env["HOME"] = home;
  __clearGoalEventSubscribers();
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  __clearGoalEventSubscribers();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeLocalSettings(value: unknown): void {
  writeFileSync(join(cwd, ".letta", "settings.local.json"), JSON.stringify(value, null, 2));
}

function readLocalSettings(): any {
  return JSON.parse(readFileSync(join(cwd, ".letta", "settings.local.json"), "utf8"));
}

function seedActiveGoal(): void {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/backend": { agentId: "agent-a", conversationId: "conv-a" },
    },
    conversationGoalsByServer: {
      "local:/tmp/backend": {
        "conv-a": {
          objective: "finish the migration",
          status: "active",
          activeStartedAt: new Date(Date.now() - 2500).toISOString(),
          activeTimeSeconds: 7,
          tokensUsed: 0,
          tokenBudget: 1000,
        },
      },
    },
  });
}

class FakeAdapter implements LettaSessionAdapter {
  conversationId: string;
  agentId: string;
  ready = false;
  dead = false;
  lastUsedAt = Date.now();
  spawnedAt = Date.now();
  tools: string[];
  closed = false;
  activeRunId: string | null = null;

  constructor(opts: LettaSessionAdapterOptions) {
    this.conversationId = opts.conversationId;
    this.agentId = opts.agentId;
    this.tools = opts.tools?.map((tool) => tool.name) ?? [];
  }

  async start() {
    this.ready = true;
    return { agentId: this.agentId, conversationId: this.conversationId };
  }

  async runTurn(_input: string | unknown[], _opts?: RunTurnOptions) {
    return { frames: [], run_id: null, done: true } as any;
  }

  close() {
    this.closed = true;
    this.dead = true;
  }

  abort() {}
}

test("goal_control injection predicate is goal-continuation and active-goal only", () => {
  assert.equal(shouldInjectGoalControlTool({ metadata: null, otid: null, hasActiveGoal: true }), false);
  assert.equal(shouldInjectGoalControlTool({ metadata: { goal_continuation: true }, hasActiveGoal: false }), false);
  assert.equal(shouldInjectGoalControlTool({ metadata: { goal_continuation: true }, hasActiveGoal: true }), true);
  assert.equal(shouldInjectGoalControlTool({ otid: "goalcont-conv-a-1", hasActiveGoal: true }), true);
  assert.equal(shouldInjectGoalControlTool({ otid: "user-1", hasActiveGoal: true }), false);
});

test("one-shot pool turns include goal_control only when explicitly supplied", async () => {
  const pool = new AgentPool();
  const created: FakeAdapter[] = [];
  pool._adapterFactory = async (opts) => {
    const adapter = new FakeAdapter(opts);
    created.push(adapter);
    return adapter;
  };

  await pool.runTurnWithHeal("conv-a", "agent-a", "normal turn");
  assert.deepEqual(created.at(-1)?.tools, []);

  await pool.runTurnWithHeal("conv-a", "agent-a", "goal continuation", {
    tools: [makeGoalControlTool({ agentId: "agent-a", conversationId: "conv-a" })],
    closeAfterTurn: true,
  });
  assert.deepEqual(created.at(-1)?.tools, [GOAL_CONTROL_TOOL_NAME]);
  assert.equal(created.at(-1)?.closed, true);
  clearInterval(pool.housekeepTimer);
});

test("goal_control status, complete, and blocked mutate native goal state and broadcast", async () => {
  seedActiveGoal();
  const events: unknown[] = [];
  subscribeGoalEvents((event) => events.push(event));

  const status = await handleGoalControl({ agentId: "agent-a", conversationId: "conv-a" }, { action: "status" });
  assert.equal(status.details?.status?.goal?.status, "active");

  const complete = await handleGoalControl({ agentId: "agent-a", conversationId: "conv-a" }, { action: "complete" });
  assert.equal(complete.details?.status?.goal?.status, "complete");
  assert.equal(complete.details?.status?.conversation_id, "conv-a");
  assert.equal(getNativeGoalForConversation("conv-a")?.goal?.status, "complete");
  assert.equal(readLocalSettings().conversationGoalsByServer["local:/tmp/backend"]["conv-a"].status, "complete");
  assert.equal(readLocalSettings().conversationGoalsByServer["local:/tmp/backend"]["conv-a"].activeStartedAt, null);
  assert.equal(events.length, 1);

  seedActiveGoal();
  const blocked = await handleGoalControl(
    { agentId: "agent-a", conversationId: "conv-a" },
    { action: "blocked", reason: "waiting on external approval" },
  );
  assert.equal(blocked.details?.status?.goal?.status, "blocked");
  assert.equal(blocked.details?.reason, "waiting on external approval");
  assert.equal(events.length, 2);
});

test("goal_control clear clears native goal state and broadcasts", async () => {
  seedActiveGoal();
  const events: unknown[] = [];
  subscribeGoalEvents((event) => events.push(event));

  const cleared = await handleGoalControl({ agentId: "agent-a", conversationId: "conv-a" }, { action: "clear" });
  assert.equal(cleared.details?.status?.goal, null);
  assert.equal(cleared.details?.message, "Goal cleared.");
  assert.equal(getNativeGoalForConversation("conv-a"), null);
  assert.equal(readLocalSettings().conversationGoalsByServer["local:/tmp/backend"]["conv-a"], undefined);
  assert.equal(events.length, 1);
});
