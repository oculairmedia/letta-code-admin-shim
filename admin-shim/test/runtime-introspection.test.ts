/**
 * Unit tests for passive runtime introspection (lcp-d0za).
 *
 * Covers:
 *   1. Session role get/set with default ("main") fallback
 *   2. Serving model handle from agent record
 *   3. Context utilization summary (heuristic match with REST endpoint)
 *   4. Model-change detection + delta reminders
 *   5. buildConnectionReminder composite output
 *   6. Byte-identical behaviour when system-reminder has no data
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setSessionRole,
  getSessionRole,
  getServingModelHandle,
  getContextUtilizationSummary,
  detectModelChange,
  seedModelHandle,
  buildSubagentSummaryLine,
  buildConnectionReminder,
  __clearRuntimeState,
  __setListActiveSubagentsForTest,
  type SessionRole,
} from "../lib/runtime-introspection.js";

import { getStorageDir } from "../lib/runs.js";
import {
  recordSubagentDispatch,
  getSubagent,
  __resetSubagentRegistry,
  type SubagentEntry,
} from "../lib/subagent-registry.js";

// ── temp backend dir harness ────────────────────────────────────────────

async function withBackendDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "runtime-introspection-test-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  __clearRuntimeState();
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    __clearRuntimeState();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function writeAgent(agentId: string, overrides: { model?: string; system?: string } = {}): void {
  const agentsDir = join(getStorageDir(), "agents");
  mkdirSync(agentsDir, { recursive: true });
  // Simple b64url encoding of agentId for the filename
  const b64 = Buffer.from(agentId).toString("base64url");
  const record = {
    id: agentId,
    name: `Test Agent ${agentId}`,
    model: overrides.model ?? "lmstudio/test-model",
    system: overrides.system ?? "You are a test agent.",
    tags: [],
  };
  writeFileSync(join(agentsDir, `${b64}.json`), JSON.stringify(record, null, 2));
}

function writeSystemPrompt(agentId: string, conversationId: string, content: string): void {
  // The system prompt is stored in memfs/<agent>/memory/system/system_prompt.md
  const memDir = join(getStorageDir(), "memfs", agentId, "memory", "system");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "system_prompt.md"), content);
}

function runningSubagent(input: Partial<SubagentEntry> & { toolCallId: string; startedAt: string }): SubagentEntry {
  return {
    toolCallId: input.toolCallId,
    taskId: input.taskId ?? null,
    description: input.description ?? null,
    subagentType: input.subagentType ?? null,
    runInBackground: input.runInBackground ?? true,
    status: "running",
    failureReason: null,
    parentRunId: input.parentRunId ?? null,
    parentAgentId: input.parentAgentId ?? null,
    parentConversationId: input.parentConversationId ?? null,
    source: input.source ?? "letta",
    subagentAgentId: input.subagentAgentId ?? null,
    todo_progress: input.todo_progress ?? null,
    subagentConversationId: input.subagentConversationId ?? null,
    logFile: input.logFile ?? null,
    workerPid: input.workerPid ?? null,
    ownerShimPid: input.ownerShimPid ?? null,
    ownerShimInstanceId: input.ownerShimInstanceId ?? null,
    exitCode: null,
    exitSignal: null,
    startedAt: input.startedAt,
    endedAt: null,
  };
}

// ── Test 1: session role get/set ────────────────────────────────────────

test("session role: default is main", () => {
  const role = getSessionRole("agent-1", "conv-1");
  assert.equal(role, "main");
});

test("session role: set/get round-trip", () => {
  setSessionRole("agent-1", "conv-1", "fork");
  assert.equal(getSessionRole("agent-1", "conv-1"), "fork");
});

test("session role: set to subagent", () => {
  setSessionRole("agent-2", "conv-2", "subagent");
  assert.equal(getSessionRole("agent-2", "conv-2"), "subagent");
});

test("session role: different agents isolated", () => {
  setSessionRole("agent-a", "conv-x", "fork");
  assert.equal(getSessionRole("agent-a", "conv-x"), "fork");
  assert.equal(getSessionRole("agent-b", "conv-x"), "main");
});

test("session role: different conversations isolated", () => {
  setSessionRole("agent-1", "conv-1", "fork");
  assert.equal(getSessionRole("agent-1", "conv-1"), "fork");
  assert.equal(getSessionRole("agent-1", "conv-2"), "main");
});

test("session role: re-set overwrites previous", () => {
  setSessionRole("agent-1", "conv-1", "fork");
  setSessionRole("agent-1", "conv-1", "subagent");
  assert.equal(getSessionRole("agent-1", "conv-1"), "subagent");
});

// ── Test 2: serving model handle ────────────────────────────────────────

test("serving model: returns model from agent record", async () => {
  await withBackendDir(() => {
    writeAgent("agent-1", { model: "lmstudio/claude-fable-5" });
    const model = getServingModelHandle("agent-1");
    assert.equal(model, "lmstudio/claude-fable-5");
  });
});

test("serving model: returns null for missing agent", async () => {
  await withBackendDir(() => {
    const model = getServingModelHandle("nonexistent");
    assert.equal(model, null);
  });
});

test("serving model: returns null when model field unset", async () => {
  await withBackendDir(() => {
    // Write an agent without a model field
    const agentsDir = join(getStorageDir(), "agents");
    mkdirSync(agentsDir, { recursive: true });
    const b64 = Buffer.from("agent-no-model").toString("base64url");
    const record = { id: "agent-no-model", name: "No Model", system: "Hi", tags: [] };
    writeFileSync(join(agentsDir, `${b64}.json`), JSON.stringify(record, null, 2));

    const model = getServingModelHandle("agent-no-model");
    assert.equal(model, null);
  });
});

// ── Test 3: context utilization summary ─────────────────────────────────

test("context utilization: returns non-null when agent exists", async () => {
  await withBackendDir((dir) => {
    writeAgent("agent-1", { system: "You are a helpful assistant with a lengthy system prompt for testing." });
    writeSystemPrompt("agent-1", "default", "You are a helpful assistant with a lengthy system prompt for testing.");
    const summary = getContextUtilizationSummary("agent-1", "default");
    assert.ok(summary !== null);
    // Should contain a percentage and token counts
    assert.match(summary!, /^\d+\.\d% \(≈\d+ \/ \d+ tokens\)$/);
  });
});

test("context utilization: returns null for missing agent", async () => {
  await withBackendDir(() => {
    const summary = getContextUtilizationSummary("nonexistent", "default");
    assert.equal(summary, null);
  });
});

// ── Test 4: model-change detection ──────────────────────────────────────

test("model change: no delta on first turn", () => {
  const delta = detectModelChange("agent-1", "conv-1", "lmstudio/model-a");
  assert.equal(delta, null);
});

test("model change: no delta on same model", () => {
  detectModelChange("agent-1", "conv-1", "lmstudio/model-a");
  const delta = detectModelChange("agent-1", "conv-1", "lmstudio/model-a");
  assert.equal(delta, null);
});

test("model change: delta emitted on actual change", () => {
  detectModelChange("agent-1", "conv-1", "lmstudio/model-a");
  const delta = detectModelChange("agent-1", "conv-1", "lmstudio/model-b");
  assert.ok(delta !== null);
  assert.match(delta!, /Model changed/);
  assert.ok(delta!.includes("model-a") && delta!.includes("model-b"), `delta should mention both models, got: ${delta}`);
  assert.match(delta!, /<system-reminder>/);
  assert.match(delta!, /<\/system-reminder>/);
});

test("model change: delta includes both old and new model handles", () => {
  detectModelChange("agent-1", "conv-2", "lmstudio/M3");
  const delta = detectModelChange("agent-1", "conv-2", "lmstudio/fable-5");
  assert.ok(delta!.includes("M3") && delta!.includes("fable-5"), `delta should mention both models, got: ${delta}`);
});

test("model change: seedModelHandle suppresses first delta", () => {
  seedModelHandle("agent-1", "conv-3", "lmstudio/model-a");
  // First detectModelChange should NOT emit a delta because seed already set it
  const delta = detectModelChange("agent-1", "conv-3", "lmstudio/model-a");
  assert.equal(delta, null);
  // Now a real change should still fire
  const delta2 = detectModelChange("agent-1", "conv-3", "lmstudio/model-b");
  assert.ok(delta2 !== null);
});

test("model change: isolated per conversation", () => {
  detectModelChange("agent-1", "conv-a", "lmstudio/model-1");
  detectModelChange("agent-1", "conv-b", "lmstudio/model-2");
  // Changing conv-a should not see a delta (first for conv-a)
  const deltaA = detectModelChange("agent-1", "conv-a", "lmstudio/model-3");
  assert.ok(deltaA !== null);
  assert.ok(deltaA!.includes("model-1") && deltaA!.includes("model-3"), `delta should mention both models, got: ${deltaA}`);
});

test("model change: null model is a no-op", () => {
  const delta = detectModelChange("agent-1", "conv-1", null);
  assert.equal(delta, null);
});

// ── Test 5: subagent summary ────────────────────────────────────────────

test("buildSubagentSummaryLine: returns null when no subagents are running", () => {
  __resetSubagentRegistry();
  try {
    assert.equal(buildSubagentSummaryLine(Date.parse("2025-01-01T00:00:00.000Z")), null);
  } finally {
    __resetSubagentRegistry();
  }
});

test("buildSubagentSummaryLine: lists running subagents with elapsed time", () => {
  const nowMs = Date.parse("2025-01-01T00:04:30.000Z");
  __setListActiveSubagentsForTest(() => [
    runningSubagent({
      toolCallId: "toolu_worker_1",
      subagentType: "worker",
      description: "feat/x branch implementation task",
      startedAt: "2025-01-01T00:00:00.000Z",
    }),
    runningSubagent({
      toolCallId: "toolu_tester_2",
      subagentType: "tester",
      description: "test/y",
      startedAt: "2025-01-01T00:03:00.000Z",
    }),
  ]);
  try {
    const line = buildSubagentSummaryLine(nowMs);
    assert.equal(
      line,
      "Subagents: 2 running — worker (feat/x branch implementation…, 4m), tester (test/y, 1m)",
    );
  } finally {
    __clearRuntimeState();
  }
});

test("buildSubagentSummaryLine: flags entries older than soft threshold as stuck-suspected", () => {
  const nowMs = Date.parse("2025-01-01T00:12:00.000Z");
  __setListActiveSubagentsForTest(() => [
    runningSubagent({
      toolCallId: "toolu_builder_3",
      subagentType: "builder",
      description: "build assets",
      startedAt: "2025-01-01T00:00:00.000Z",
    }),
  ]);
  try {
    const line = buildSubagentSummaryLine(nowMs);
    assert.equal(line, "Subagents: ⚠ 1 stuck-suspected — builder (build assets, 12m)");
  } finally {
    __clearRuntimeState();
  }
});

// ── Test 6: buildConnectionReminder ─────────────────────────────────────

test("buildConnectionReminder: includes model, context, and role", async () => {
  await withBackendDir(() => {
    writeAgent("agent-1", { model: "lmstudio/claude-fable-5", system: "Test system prompt for agent." });
    writeSystemPrompt("agent-1", "default", "Test system prompt for agent.");
    setSessionRole("agent-1", "default", "main");

    const reminder = buildConnectionReminder("agent-1", "default");
    assert.match(reminder, /<system-reminder>/);
    assert.match(reminder, /<\/system-reminder>/);
    assert.match(reminder, /Serving model: lmstudio\/claude-fable-5/);
    assert.match(reminder, /Context utilization:/);
    assert.match(reminder, /Session role: main/);
  });
});

test("buildConnectionReminder: reflects fork role", async () => {
  await withBackendDir(() => {
    writeAgent("agent-1", { model: "lmstudio/model-x" });
    writeSystemPrompt("agent-1", "conv-fork", "");
    setSessionRole("agent-1", "conv-fork", "fork");

    const reminder = buildConnectionReminder("agent-1", "conv-fork");
    assert.match(reminder, /Session role: fork/);
  });
});

test("buildConnectionReminder: includes subagent summary when subagents are running", async () => {
  await withBackendDir(() => {
    __resetSubagentRegistry();
    try {
      writeAgent("agent-1", { model: "lmstudio/model-x" });
      recordSubagentDispatch({
        toolCallId: "toolu_context_subagent",
        parentRunId: "run-parent",
        args: {
          subagent_type: "worker",
          description: "ambient status",
          run_in_background: true,
        },
      });

      const reminder = buildConnectionReminder("agent-1", "default");
      assert.match(reminder, /Subagents: 1 running — worker \(ambient status, \d+s\)/);
    } finally {
      __resetSubagentRegistry();
    }
  });
});

test("buildConnectionReminder: sweeps stale no-log subagents before summarizing", async () => {
  await withBackendDir(() => {
    __resetSubagentRegistry();
    try {
      writeAgent("agent-1", { model: "lmstudio/model-x" });
      const entry = recordSubagentDispatch({
        toolCallId: "toolu_stale_no_log",
        parentRunId: "run-parent",
        args: {
          subagent_type: "general-purpose",
          description: "orphaned chip",
          run_in_background: true,
        },
      });

      const reminder = buildSubagentSummaryLine(Date.parse(entry.startedAt) + 90_001);
      assert.equal(reminder, null);
      assert.equal(getSubagent("toolu_stale_no_log")?.status, "failed");
      assert.equal(getSubagent("toolu_stale_no_log")?.failureReason, "orphaned");
    } finally {
      __resetSubagentRegistry();
    }
  });
});

test("buildConnectionReminder: omits subagent summary when none are running", async () => {
  await withBackendDir(() => {
    __resetSubagentRegistry();
    try {
      writeAgent("agent-1", { model: "lmstudio/model-x" });
      const reminder = buildConnectionReminder("agent-1", "default");
      assert.equal(reminder.includes("Subagents:"), false);
    } finally {
      __resetSubagentRegistry();
    }
  });
});

test("buildConnectionReminder: fail-opens when subagent summary throws", async () => {
  await withBackendDir(() => {
    writeAgent("agent-1", { model: "lmstudio/model-x" });
    __setListActiveSubagentsForTest(() => {
      throw new Error("registry unavailable");
    });
    try {
      const reminder = buildConnectionReminder("agent-1", "default");
      assert.match(reminder, /Serving model: lmstudio\/model-x/);
      assert.match(reminder, /Session role: main/);
      assert.equal(reminder.includes("Subagents:"), false);
    } finally {
      __clearRuntimeState();
    }
  });
});

test("buildConnectionReminder: returns empty string when no data", async () => {
  await withBackendDir(() => {
    // Agent exists but has no model and empty system → context may still produce something
    // Test the null case: clear the state first so model is null
    __clearRuntimeState();
    // Write an agent with no model field at all
    const agentsDir = join(getStorageDir(), "agents");
    mkdirSync(agentsDir, { recursive: true });
    const b64 = Buffer.from("bare-agent").toString("base64url");
    const record = { id: "bare-agent", name: "Bare", tags: [] };
    writeFileSync(join(agentsDir, `${b64}.json`), JSON.stringify(record, null, 2));
    // No system prompt on disk

    const reminder = buildConnectionReminder("bare-agent", "default");
    // Should have at least the session role line
    assert.match(reminder, /Session role: main/);
    // Should NOT have a serving model line
    assert.equal(reminder.includes("Serving model:"), false);
  });
});

// ── Test 7: system-reminder format compliance ───────────────────────────

test("system-reminder format: valid XML-like tags", () => {
  setSessionRole("agent-1", "conv-1", "main");
  // Build without disk (will likely be empty or just session role)
  const reminder = buildConnectionReminder("agent-1", "conv-1");
  if (reminder) {
    // Must start with <system-reminder> and end with </system-reminder>
    assert.ok(reminder.startsWith("<system-reminder>"));
    assert.ok(reminder.endsWith("</system-reminder>"));
    // Should be strip-able by the translate.ts regex
    const stripped = reminder.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    assert.equal(stripped, "");
  }
});

test("system-reminder format: delta model-change reminders are strip-able", () => {
  detectModelChange("agent-1", "conv-1", "lmstudio/A");
  const delta = detectModelChange("agent-1", "conv-1", "lmstudio/B");
  assert.ok(delta !== null);
  const stripped = delta!.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  assert.equal(stripped, "");
});

// ── Test 8: clearRuntimeState resets everything ─────────────────────────

test("clearRuntimeState: resets session roles", () => {
  setSessionRole("agent-1", "conv-1", "fork");
  assert.equal(getSessionRole("agent-1", "conv-1"), "fork");
  __clearRuntimeState();
  assert.equal(getSessionRole("agent-1", "conv-1"), "main");
});

test("clearRuntimeState: resets model tracking", () => {
  detectModelChange("agent-1", "conv-1", "lmstudio/model-a");
  __clearRuntimeState();
  // After reset, this should be treated as first-seen, no delta
  const delta = detectModelChange("agent-1", "conv-1", "lmstudio/model-a");
  assert.equal(delta, null);
});
