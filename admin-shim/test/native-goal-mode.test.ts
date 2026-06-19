import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addNativeGoalUsage,
  applyNativeGoalCommandForAgent,
  getNativeGoalForAgent,
  getNativeGoalForConversation,
  listActiveNativeGoals,
  wasNativeGoalUserStopped,
} from "../lib/native-goal-mode.js";

let cwd: string;
let prevCwd: string;
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "native-goal-cwd-"));
  home = mkdtempSync(join(tmpdir(), "native-goal-home-"));
  mkdirSync(join(cwd, ".letta"), { recursive: true });
  mkdirSync(join(home, ".letta"), { recursive: true });
  prevCwd = process.cwd();
  prevHome = process.env["HOME"];
  process.chdir(cwd);
  process.env["HOME"] = home;
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeLocalSettings(value: unknown): void {
  writeFileSync(join(cwd, ".letta", "settings.local.json"), JSON.stringify(value, null, 2));
}

function writeGlobalSettings(value: unknown): void {
  writeFileSync(join(home, ".letta", "settings.json"), JSON.stringify(value, null, 2));
}

function readLocalSettings(): any {
  return JSON.parse(readFileSync(join(cwd, ".letta", "settings.local.json"), "utf8"));
}

test("native goal wrapper reads conversation goal from project-local settings", () => {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/backend": { agentId: "agent-a", conversationId: "conv-a" },
    },
    conversationGoalsByServer: {
      "local:/tmp/backend": {
        "conv-a": {
          objective: "finish the migration and open a PR",
          status: "active",
          activeTimeSeconds: 12,
          tokensUsed: 345,
          tokenBudget: 50000,
        },
      },
    },
    conversationGoalToolsByServer: {
      "local:/tmp/backend": { "conv-a": true },
    },
  });

  const byConv = getNativeGoalForConversation("conv-a");
  assert.equal(byConv?.source, "letta_code_goal_mode");
  assert.equal(byConv?.server_key, "local:/tmp/backend");
  assert.equal(byConv?.goal?.objective, "finish the migration and open a PR");
  assert.equal(byConv?.goal?.tokenBudget, 50000);
  assert.equal(byConv?.tools_enabled, true);

  const byAgent = getNativeGoalForAgent("agent-a");
  assert.equal(byAgent?.conversation_id, "conv-a");
  assert.equal(byAgent?.goal?.status, "active");
});

test("native goal wrapper returns null when no goal exists", () => {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/backend": { agentId: "agent-a", conversationId: "conv-a" },
    },
  });
  assert.equal(getNativeGoalForConversation("conv-a"), null);
  assert.deepEqual(getNativeGoalForAgent("agent-a"), {
    source: "letta_code_goal_mode",
    server_key: "local:/tmp/backend",
    agent_id: "agent-a",
    conversation_id: "conv-a",
    goal: null,
  });
});

test("native goal wrapper can map agent sessions from global settings while goals stay local", () => {
  writeGlobalSettings({
    sessionsByServer: {
      "127.0.0.1:0": { agentId: "agent-global", conversationId: "conv-global" },
    },
  });
  writeLocalSettings({
    conversationGoalsByServer: {
      "127.0.0.1:0": {
        "conv-global": { objective: "drive CI green", status: "paused" },
      },
    },
  });

  const result = getNativeGoalForAgent("agent-global");
  assert.equal(result?.conversation_id, "conv-global");
  assert.equal(result?.goal?.objective, "drive CI green");
  assert.equal(result?.goal?.status, "paused");
});

test("native goal command bridge creates, pauses, resumes, completes, and clears native goal state", async () => {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/backend": { agentId: "agent-a", conversationId: "conv-a" },
    },
  });

  const created = await applyNativeGoalCommandForAgent("agent-a", "/goal --token-budget 50000 finish the migration");
  assert.equal(created.action, "create");
  assert.equal(created.goal?.objective, "finish the migration");
  assert.equal(created.goal?.tokenBudget, 50000);
  assert.equal(created.goal?.status, "active");

  const paused = await applyNativeGoalCommandForAgent("agent-a", "/goal pause");
  assert.equal(paused.action, "pause");
  assert.equal(paused.goal?.status, "paused");
  assert.equal(paused.goal?.activeStartedAt, null);
  assert.equal(paused.goal?.userStopped, true);
  assert.equal(paused.goal?.stoppedReason, "paused");

  const resumed = await applyNativeGoalCommandForAgent("agent-a", "/goal resume");
  assert.equal(resumed.action, "resume");
  assert.equal(resumed.goal?.status, "active");
  assert.equal(resumed.goal?.userStopped, false);
  assert.ok(resumed.goal?.activeStartedAt);

  const complete = await applyNativeGoalCommandForAgent("agent-a", "/goal complete");
  assert.equal(complete.action, "complete");
  assert.equal(complete.goal?.status, "complete");

  const cleared = await applyNativeGoalCommandForAgent("agent-a", "/goal clear");
  assert.equal(cleared.action, "clear");
  assert.equal(cleared.goal, null);
  assert.equal(readLocalSettings().conversationGoalsByServer["local:/tmp/backend"]["conv-a"], undefined);
  assert.equal(getNativeGoalForConversation("conv-a"), null);
  assert.equal(getNativeGoalForAgent("agent-a")?.goal, null);

  const recreated = await applyNativeGoalCommandForAgent("agent-a", "/goal next objective");
  assert.equal(recreated.action, "create");
  assert.equal(recreated.goal?.objective, "next objective");
  assert.equal(recreated.goal?.status, "active");
});



test("native goal command suppresses lifecycle tools on create and replace, and disables them on disable", async () => {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/backend": { agentId: "agent-a", conversationId: "conv-a" },
    },
  });

  const created = await applyNativeGoalCommandForAgent("agent-a", "/goal finish the migration");
  assert.equal(created.action, "create");
  assert.equal(created.tools_enabled, undefined);
  assert.equal(readLocalSettings().conversationGoalToolsByServer, undefined);

  const settings = readLocalSettings();
  settings.conversationGoalToolsByServer = { "local:/tmp/backend": { "conv-a": true } };
  writeLocalSettings(settings);

  const replaced = await applyNativeGoalCommandForAgent("agent-a", "/goal --replace finish the release");
  assert.equal(replaced.action, "replace");
  assert.equal(replaced.tools_enabled, false);
  assert.equal(readLocalSettings().conversationGoalToolsByServer["local:/tmp/backend"]["conv-a"], false);

  const disabled = await applyNativeGoalCommandForAgent("agent-a", "/goal disable");
  assert.equal(disabled.action, "disable");
  assert.equal(disabled.tools_enabled, undefined);
  assert.equal(readLocalSettings().conversationGoalToolsByServer["local:/tmp/backend"]["conv-a"], undefined);
});

test("native goal command bridge requires --replace when an active or paused goal already exists", async () => {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/backend": { agentId: "agent-a", conversationId: "conv-a" },
    },
  });
  await applyNativeGoalCommandForAgent("agent-a", "/goal first objective");
  await assert.rejects(
    () => applyNativeGoalCommandForAgent("agent-a", "/goal second objective"),
    /goal already exists/,
  );
  const replaced = await applyNativeGoalCommandForAgent("agent-a", "/goal --replace second objective");
  assert.equal(replaced.action, "replace");
  assert.equal(replaced.goal?.objective, "second objective");

  const paused = await applyNativeGoalCommandForAgent("agent-a", "/goal pause");
  assert.equal(paused.goal?.status, "paused");
  assert.equal(wasNativeGoalUserStopped(paused.goal), true);
  await assert.rejects(
    () => applyNativeGoalCommandForAgent("agent-a", "/goal third objective"),
    /goal already exists/,
  );
});


test("native goal command prefers resolvable local backend session over stale remote session", async () => {
  const localBackend = join(tmpdir(), "goal-local-backend");
  const prevBackend = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = localBackend;
  try {
    writeLocalSettings({
      sessionsByServer: {
        "192.168.50.90:8289": { agentId: "agent-a", conversationId: "conv-stale" },
        [`local:${localBackend}`]: { agentId: "agent-a", conversationId: "default" },
      },
    });

    const result = await applyNativeGoalCommandForAgent(
      "agent-a",
      "/goal drive the real local turn",
      async (conversationId) =>
        conversationId === "conv-default-agent-a" ? { agentId: "agent-a", conversationId: "default" } : null,
    );

    assert.equal(result.server_key, `local:${localBackend}`);
    assert.equal(result.conversation_id, "conv-default-agent-a");
    assert.equal(result.goal?.objective, "drive the real local turn");
    assert.equal(getNativeGoalForConversation("conv-default-agent-a")?.goal?.objective, "drive the real local turn");
    assert.equal(getNativeGoalForAgent("agent-a")?.conversation_id, "conv-default-agent-a");
  } finally {
    if (prevBackend === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prevBackend;
  }
});


test("addNativeGoalUsage increments active goal tokens and persists", () => {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/backend": { agentId: "agent-a", conversationId: "conv-a" },
    },
    conversationGoalsByServer: {
      "local:/tmp/backend": {
        "conv-a": {
          objective: "finish the migration",
          status: "active",
          activeTimeSeconds: 10,
          tokensUsed: 25,
          tokenBudget: 100,
        },
      },
    },
  });

  const updated = addNativeGoalUsage({ conversationId: "conv-a", agentId: "agent-a", tokensUsed: 33, activeSeconds: 2 });

  assert.equal(updated?.goal?.tokensUsed, 58);
  assert.equal(updated?.goal?.activeTimeSeconds, 12);
  assert.equal(readLocalSettings().conversationGoalsByServer["local:/tmp/backend"]["conv-a"].tokensUsed, 58);
});

test("addNativeGoalUsage is no-op when no active goal exists", () => {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/backend": { agentId: "agent-a", conversationId: "conv-a" },
    },
    conversationGoalsByServer: {
      "local:/tmp/backend": {
        "conv-a": { objective: "paused work", status: "paused", tokensUsed: 25 },
      },
    },
  });

  assert.equal(addNativeGoalUsage({ conversationId: "conv-a", tokensUsed: 33 }), null);
  assert.equal(readLocalSettings().conversationGoalsByServer["local:/tmp/backend"]["conv-a"].tokensUsed, 25);
  assert.equal(addNativeGoalUsage({ conversationId: "conv-missing", tokensUsed: 33 }), null);
});


test("listActiveNativeGoals returns only active resolvable goals with drivable ids", async () => {
  writeLocalSettings({
    sessionsByServer: {
      "local:/tmp/backend": { agentId: "agent-active", conversationId: "default" },
      "local:/tmp/backend-paused": { agentId: "agent-paused", conversationId: "conv-paused" },
      "local:/tmp/backend-complete": { agentId: "agent-complete", conversationId: "conv-complete" },
      "local:/tmp/backend-blocked": { agentId: "agent-blocked", conversationId: "conv-blocked" },
      "local:/tmp/backend-budget": { agentId: "agent-budget", conversationId: "conv-budget" },
      "local:/tmp/backend-unresolved": { agentId: "agent-unresolved", conversationId: "conv-unresolved" },
      "local:/tmp/backend-user-stopped": { agentId: "agent-user-stopped", conversationId: "conv-user-stopped" },
    },
    conversationGoalsByServer: {
      "local:/tmp/backend": {
        default: { objective: "drive active default", status: "active", tokensUsed: 5, tokenBudget: 100 },
      },
      "local:/tmp/backend-paused": {
        "conv-paused": { objective: "paused work", status: "paused", userStopped: true, stoppedReason: "paused" },
      },
      "local:/tmp/backend-complete": {
        "conv-complete": { objective: "complete work", status: "complete" },
      },
      "local:/tmp/backend-blocked": {
        "conv-blocked": { objective: "blocked work", status: "blocked" },
      },
      "local:/tmp/backend-budget": {
        "conv-budget": { objective: "spent work", status: "active", tokensUsed: 10, tokenBudget: 10 },
      },
      "local:/tmp/backend-unresolved": {
        "conv-unresolved": { objective: "lost work", status: "active" },
      },
      "local:/tmp/backend-user-stopped": {
        "conv-user-stopped": { objective: "do not revive", status: "active", userStopped: true },
      },
    },
  });
  const warnings: unknown[][] = [];

  const active = await listActiveNativeGoals(
    async (conversationId) =>
      conversationId === "conv-default-agent-active"
        ? { agentId: "agent-active", conversationId: "default" }
        : null,
    { warn: (...args: unknown[]) => warnings.push(args) },
  );

  assert.deepEqual(active.map((entry) => ({
    agentId: entry.agentId,
    conversationId: entry.conversationId,
    serverKey: entry.serverKey,
    storageConversationId: entry.storageConversationId,
    objective: entry.goal.objective,
  })), [{
    agentId: "agent-active",
    conversationId: "conv-default-agent-active",
    serverKey: "local:/tmp/backend",
    storageConversationId: "default",
    objective: "drive active default",
  }]);
  assert.equal(warnings.length, 1);
});
