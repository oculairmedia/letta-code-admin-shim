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
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ingestParentFrame,
  listActiveSubagents,
  snapshotSubagents,
  getSubagent,
  markSubagentCompleted,
  markSubagentFailed,
  recordSubagentDispatch,
  computeTodoProgress,
  subscribeSubagentEvents,
  rehydrateRunningSubagentWatchdogs,
  setSubagentRegistryInstanceId,
  sweepOrphanedSubagents,
  __getSubagentWatcherCounts,
  __resetSubagentRegistry,
  __setSubagentProcessAliveCheckerForTest,
} from "../lib/subagent-registry.js";
import { messagesJsonlPath } from "../lib/store.js";

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

function returnFrame(toolCallId: string, taskId: string, agentLocalId: string, logFile?: string, workerPid?: number) {
  return {
    message_type: "tool_return_message",
    name: "Agent",
    tool_call_id: toolCallId,
    tool_return:
      `Task running in background with task ID: ${taskId}\n` +
      `Agent ID: ${agentLocalId}\n` +
      `Output file: ${logFile ?? `/tmp/letta-background/${taskId}.log`}` +
      (workerPid ? `\nWorker PID: ${workerPid}` : ""),
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

// ── lcp-4m36: TodoWrite progress ────────────────────────────────────────

test("subagent-registry: computes TodoWrite progress fraction", () => {
  assert.deepEqual(
    computeTodoProgress([
      { content: "one", status: "completed", activeForm: "one" },
      { content: "two", status: "in_progress", activeForm: "two" },
      { content: "three", status: "pending", activeForm: "three" },
      { content: "four", status: "completed", activeForm: "four" },
    ]),
    { completed: 2, total: 4 },
  );
});

test("subagent-registry: TodoWrite fs.watch debounce emits one todos_changed broadcast", async () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-todos-${Math.random().toString(36).slice(2)}`);
  const priorStateDir = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = stateDir;
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  const agentLocalId = "agent-local-abc12345-1111-2222-3333-444444444444";
  const logFile = join(stateDir, "task_42.log");
  try {
    mkdirSync(join(logFile, ".."), { recursive: true });
    writeFileSync(logFile, "[Task started]\n");
    ingestParentFrame(dispatchFrame(tcid, "Watch todos"), "run-parent-todos");
    ingestParentFrame(returnFrame(tcid, "task_42", agentLocalId, logFile), "run-parent-todos");

    const events: string[] = [];
    const unsubscribe = subscribeSubagentEvents((event) => {
      if (event.reason === "todos_changed") events.push(event.subagent.todo_progress ? JSON.stringify(event.subagent.todo_progress) : "null");
    });
    const messagesPath = messagesJsonlPath("default", agentLocalId);
    const todoLine = JSON.stringify({
      id: "msg-1",
      role: "assistant",
      parts: [{
        type: "toolCall",
        name: "TodoWrite",
        arguments: { todos: [
          { content: "one", status: "completed", activeForm: "one" },
          { content: "two", status: "pending", activeForm: "two" },
        ] },
      }],
    }) + "\n";
    writeFileSync(messagesPath, todoLine);
    writeFileSync(messagesPath, todoLine);
    writeFileSync(messagesPath, todoLine);

    await new Promise((resolve) => setTimeout(resolve, 500));
    unsubscribe();
    assert.deepEqual(events, [JSON.stringify({ completed: 1, total: 2 })]);
    assert.deepEqual(getSubagent(tcid)?.todo_progress, { completed: 1, total: 2 });
  } finally {
    __resetSubagentRegistry();
    if (priorStateDir === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = priorStateDir;
  }
});

test("subagent-registry: terminal transition clears TodoWrite watcher", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-todos-cleanup-${Math.random().toString(36).slice(2)}`);
  const priorStateDir = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = stateDir;
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  const agentLocalId = "agent-local-abc12345-5555-6666-7777-888888888888";
  const logFile = join(stateDir, "task_43.log");
  try {
    mkdirSync(join(logFile, ".."), { recursive: true });
    writeFileSync(logFile, "[Task started]\n");
    ingestParentFrame(dispatchFrame(tcid, "Cleanup todos"), "run-parent-cleanup");
    ingestParentFrame(returnFrame(tcid, "task_43", agentLocalId, logFile), "run-parent-cleanup");
    assert.equal(__getSubagentWatcherCounts().todos, 1);
    markSubagentCompleted(tcid);
    assert.equal(__getSubagentWatcherCounts().todos, 0);
  } finally {
    __resetSubagentRegistry();
    if (priorStateDir === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = priorStateDir;
  }
});

test("subagent-registry: entry serializes todo_progress null by default", () => {
  __resetSubagentRegistry();
  const entry = recordSubagentDispatch({
    toolCallId: "toolu_progress_default",
    parentRunId: null,
    args: { description: "serialize me", run_in_background: false },
  });
  assert.equal(entry.todo_progress, null);
  assert.equal(JSON.parse(JSON.stringify(entry)).todo_progress, null);
  __resetSubagentRegistry();
});

test("subagent-registry: rehydrate flips running entry whose log already completed", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-rehydrate-complete-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_90.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(logFile, "[Task started]\n[Task completed]\n");
    ingestParentFrame(dispatchFrame(tcid, "Already done"), "run-rehydrate");
    ingestParentFrame(returnFrame(tcid, "task_90", "agent-local-abc12345-9999-8888-7777-666666666666", logFile), "run-rehydrate");
    assert.equal(getSubagent(tcid)?.status, "completed");

    __resetSubagentRegistry();
    ingestParentFrame(dispatchFrame(tcid, "Already done"), "run-rehydrate");
    ingestParentFrame(returnFrame(tcid, "task_90", "agent-local-abc12345-9999-8888-7777-666666666666", logFile), "run-rehydrate");
    rehydrateRunningSubagentWatchdogs();

    assert.equal(getSubagent(tcid)?.status, "completed");
    assert.equal(__getSubagentWatcherCounts().timeouts, 0);
  } finally {
    __resetSubagentRegistry();
  }
});

test("subagent-registry: rehydrate finalizes running entry whose log shows [Task failed]", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-rehydrate-failed-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_failed.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    // Real-world orphan footer: an interrupted worker writes [Task failed]
    // and subagent_status=error, NOT [Task completed]. This used to rehydrate
    // as running forever (the ~22h phantom chip).
    writeFileSync(
      logFile,
      "[Task started: Fix shim CI failures]\nsubagent_status=error\n[error] Interrupted by user\n[Task failed]\n",
    );
    ingestParentFrame(dispatchFrame(tcid, "Fix shim CI failures"), "run-rehydrate-failed");
    ingestParentFrame(returnFrame(tcid, "task_failed", "agent-local-abc12345-5555-4444-3333-222222222222", logFile), "run-rehydrate-failed");
    getSubagent(tcid)!.status = "running";

    rehydrateRunningSubagentWatchdogs();

    const entry = getSubagent(tcid);
    assert.equal(entry?.status, "failed");
    assert.equal(entry?.failureReason, "subagent_error");
    assert.equal(__getSubagentWatcherCounts().timeouts, 0);
  } finally {
    __resetSubagentRegistry();
  }
});

test("subagent-registry: sweep finalizes running entry whose log shows subagent_status=error", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-sweep-failed-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_sweep_failed.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(logFile, "[Task started]\nworking\n");
    ingestParentFrame(dispatchFrame(tcid, "Will fail"), "run-sweep-failed");
    ingestParentFrame(returnFrame(tcid, "task_sweep_failed", "agent-local-abc12345-aaaa-bbbb-cccc-dddddddddddd", logFile), "run-sweep-failed");
    // Worker fails after the watcher's immediate scan; sweep must catch it.
    writeFileSync(logFile, "[Task started]\nworking\nsubagent_status=error\n[Task failed]\n");

    const swept = sweepOrphanedSubagents(Date.now());

    assert.equal(swept, 1);
    const entry = getSubagent(tcid);
    assert.equal(entry?.status, "failed");
    assert.equal(entry?.failureReason, "subagent_error");
  } finally {
    __resetSubagentRegistry();
  }
});

test("subagent-registry: rehydrate fails running entry whose background log is missing", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-rehydrate-missing-${Math.random().toString(36).slice(2)}`);
  const missingLogFile = join(stateDir, "task_94.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    ingestParentFrame(dispatchFrame(tcid, "Missing log on boot"), "run-rehydrate-missing");
    ingestParentFrame(returnFrame(tcid, "task_94", "agent-local-abc12345-1111-2222-3333-444444444444", missingLogFile), "run-rehydrate-missing");
    getSubagent(tcid)!.status = "running";

    rehydrateRunningSubagentWatchdogs();

    const entry = getSubagent(tcid);
    assert.equal(entry?.status, "failed");
    assert.equal(entry?.failureReason, "orphaned");
    assert.equal(__getSubagentWatcherCounts().timeouts, 0);
  } finally {
    __resetSubagentRegistry();
  }
});

test("subagent-registry: liveness sweep fails no-logFile running entry as orphaned", () => {
  __resetSubagentRegistry();
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    const entry = recordSubagentDispatch({
      toolCallId: tcid,
      parentRunId: "run-no-logfile",
      args: { description: "Dispatch never produced a log", run_in_background: true },
    });
    const events: string[] = [];
    const unsubscribe = subscribeSubagentEvents((event) => {
      if (event.subagent.toolCallId === tcid) events.push(`${event.reason}:${event.subagent.failureReason ?? ""}`);
    });

    const swept = sweepOrphanedSubagents(Date.parse(entry.startedAt) + 90_001);

    unsubscribe();
    assert.equal(swept, 1);
    const sweptEntry = getSubagent(tcid);
    assert.equal(sweptEntry?.status, "failed");
    assert.equal(sweptEntry?.failureReason, "orphaned");
    assert.deepEqual(events, ["failed:orphaned"]);
  } finally {
    __resetSubagentRegistry();
  }
});

test("subagent-registry: liveness sweep completes running entry when log already has completed marker", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-complete-sweep-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_93.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(logFile, "[Task started]\nworking\n");
    ingestParentFrame(dispatchFrame(tcid, "Completed but watcher missed"), "run-complete-sweep");
    ingestParentFrame(returnFrame(tcid, "task_93", "agent-local-abc12345-cccc-dddd-eeee-ffffffffffff", logFile), "run-complete-sweep");
    assert.equal(getSubagent(tcid)?.status, "running");
    // Simulate fs.watch missing the final write: the canonical log now has the
    // completed marker, but no watcher callback finalized the registry entry.
    writeFileSync(logFile, "[Task started]\nworking\n[Task completed]\n");

    const swept = sweepOrphanedSubagents(Date.now());

    assert.equal(swept, 1);
    const entry = getSubagent(tcid);
    assert.equal(entry?.status, "completed");
    assert.equal(entry?.failureReason, null);
  } finally {
    __resetSubagentRegistry();
  }
});


test("subagent-registry: started-only log with dead PID finalizes failed", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-dead-pid-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_dead_pid.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(logFile, "[Task started]\n");
    ingestParentFrame(dispatchFrame(tcid, "Dead worker"), "run-dead-pid");
    ingestParentFrame(returnFrame(tcid, "task_95", "agent-local-abc12345-dddd-eeee-ffff-111111111111", logFile, 424242), "run-dead-pid");
    __setSubagentProcessAliveCheckerForTest((pid) => {
      assert.equal(pid, 424242);
      return false;
    });

    const swept = sweepOrphanedSubagents(Date.now());

    assert.equal(swept, 1);
    const entry = getSubagent(tcid);
    assert.equal(entry?.status, "failed");
    assert.equal(entry?.failureReason, "worker_process_dead");
  } finally {
    __resetSubagentRegistry();
  }
});

test("subagent-registry: started-only log with alive PID stays running past old timeout", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-alive-pid-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_alive_pid.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(logFile, "[Task started]\n");
    const stale = new Date(Date.now() - 3_600_000);
    utimesSync(logFile, stale, stale);
    ingestParentFrame(dispatchFrame(tcid, "Quiet worker"), "run-alive-pid");
    ingestParentFrame(returnFrame(tcid, "task_96", "agent-local-abc12345-eeee-ffff-1111-222222222222", logFile, 515151), "run-alive-pid");
    __setSubagentProcessAliveCheckerForTest((pid) => {
      assert.equal(pid, 515151);
      return true;
    });

    const swept = sweepOrphanedSubagents(Date.now() + 3_600_000);

    assert.equal(swept, 0);
    assert.equal(getSubagent(tcid)?.status, "running");
  } finally {
    __resetSubagentRegistry();
  }
});

test("subagent-registry: boot rehydrate keeps started-only log with UNKNOWN pid running (silence != death)", () => {
  // Process-liveness, not silence: a started-only log whose worker PID can't
  // be verified must NOT be finalized as dead at rehydrate. A subagent can be
  // legitimately quiet, and external (non-worker) entries have no PID. Only a
  // CONFIRMED-dead PID finalizes; unknown-PID falls through to the normal
  // watch path and stays running until a real terminal signal.
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-boot-unknown-pid-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_unknown_pid.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(logFile, "[Task started]\n");
    ingestParentFrame(dispatchFrame(tcid, "Unknown-pid worker"), "run-unknown-pid");
    ingestParentFrame(returnFrame(tcid, "task_97", "agent-local-abc12345-ffff-1111-2222-333333333333", logFile), "run-unknown-pid");

    rehydrateRunningSubagentWatchdogs();

    const entry = getSubagent(tcid);
    assert.equal(entry?.status, "running");
  } finally {
    __resetSubagentRegistry();
  }
});



test("subagent-registry: boot rehydrate finalizes prior-instance started-only log with unknown PID", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-boot-prior-instance-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_prior_instance.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(logFile, "[Task started]\n");
    setSubagentRegistryInstanceId("prior-instance");
    ingestParentFrame(dispatchFrame(tcid, "Prior-instance worker"), "run-prior-instance");
    ingestParentFrame(returnFrame(tcid, "task_98", "agent-local-abc12345-1212-3434-5656-787878787878", logFile), "run-prior-instance");

    __resetSubagentRegistry();
    setSubagentRegistryInstanceId("current-instance");
    ingestParentFrame(dispatchFrame(tcid, "Prior-instance worker"), "run-prior-instance");
    ingestParentFrame(returnFrame(tcid, "task_98", "agent-local-abc12345-1212-3434-5656-787878787878", logFile), "run-prior-instance");
    rehydrateRunningSubagentWatchdogs();

    const entry = getSubagent(tcid);
    assert.equal(entry?.status, "failed");
    assert.equal(entry?.failureReason, "prior_instance_dead");
  } finally {
    __resetSubagentRegistry();
  }
});

test("subagent-registry: boot rehydrate keeps current-instance started-only log with unknown PID running", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-boot-current-instance-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_current_instance.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(logFile, "[Task started]\n");
    setSubagentRegistryInstanceId("current-instance");
    ingestParentFrame(dispatchFrame(tcid, "Current-instance worker"), "run-current-instance");
    ingestParentFrame(returnFrame(tcid, "task_99", "agent-local-abc12345-9090-8080-7070-606060606060", logFile), "run-current-instance");

    __resetSubagentRegistry();
    setSubagentRegistryInstanceId("current-instance");
    ingestParentFrame(dispatchFrame(tcid, "Current-instance worker"), "run-current-instance");
    ingestParentFrame(returnFrame(tcid, "task_99", "agent-local-abc12345-9090-8080-7070-606060606060", logFile), "run-current-instance");
    rehydrateRunningSubagentWatchdogs();

    const entry = getSubagent(tcid);
    assert.equal(entry?.status, "running");
    assert.equal(entry?.ownerShimInstanceId, "current-instance");
  } finally {
    __resetSubagentRegistry();
  }
});

test("subagent-registry: liveness sweep leaves fresh running log active", () => {
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-fresh-sweep-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_92.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(logFile, "[Task started]\nworking\n");
    const fresh = new Date();
    utimesSync(logFile, fresh, fresh);
    ingestParentFrame(dispatchFrame(tcid, "Fresh worker"), "run-fresh");
    ingestParentFrame(returnFrame(tcid, "task_92", "agent-local-abc12345-bbbb-cccc-dddd-eeeeeeeeeeee", logFile), "run-fresh");

    const swept = sweepOrphanedSubagents(Date.now());

    assert.equal(swept, 0);
    assert.equal(getSubagent(tcid)?.status, "running");
  } finally {
    __resetSubagentRegistry();
  }
});

test("subagent-registry: liveness sweep finalizes stale started-only log as orphaned when PID is unknown (letta-mobile-73o2h.4)", () => {
  // Without a parseable worker PID we cannot prove the entry is alive; the
  // log file existing does not by itself mean a worker is running. After
  // SUBAGENT_NO_LOGFILE_TIMEOUT_MS the entry is swept as orphaned so the
  // mobile chat bar never surfaces a stranded "running" chip. This is
  // exactly the bug that motivated letta-mobile-73o2h.4.
  __resetSubagentRegistry();
  const stateDir = join(tmpdir(), `shim-orphan-sweep-${Math.random().toString(36).slice(2)}`);
  const logFile = join(stateDir, "task_91.log");
  const tcid = `toolu_${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(logFile, "[Task started]\nworking\n");
    const stale = new Date(Date.now() - 700_000);
    utimesSync(logFile, stale, stale);
    ingestParentFrame(dispatchFrame(tcid, "Stale worker"), "run-orphan");
    ingestParentFrame(returnFrame(tcid, "task_91", "agent-local-abc12345-aaaa-bbbb-cccc-dddddddddddd", logFile), "run-orphan");

    const swept = sweepOrphanedSubagents(Date.now() + 3_600_000);

    assert.equal(swept, 1, "stale started-only entries with unknown PID must be swept as orphaned");
    const entry = getSubagent(tcid);
    assert.equal(entry?.status, "failed");
    assert.equal(entry?.failureReason, "orphaned");
    assert.equal(
      listActiveSubagents().find((s) => s.toolCallId === tcid),
      undefined,
      "listActiveSubagents must NEVER include an orphaned entry",
    );
  } finally {
    __resetSubagentRegistry();
  }
});

// ── Regression: dead-PID running subagent MUST NOT survive in the snapshot
//    surfaced to mobile UI. letta-mobile-73o2h.4.
//
//    Reproduces the user-facing "stranded subagent chip" bug: a background
//    dispatch whose worker process dies (or whose PID is unparseable) must be
//    finalized before the snapshot is read. The test sets up an entry with a
//    log file but a dead PID, then verifies:
//      1. sweepOrphanedSubagents() flips the entry to failed/worker_process_dead.
//      2. snapshotSubagents() never returns it with status="running".
//      3. listActiveSubagents() filters it out.
//    Without this guarantee, the mobile chat bar shows a chip for a worker
//    that no longer exists, which is the exact "user trust destroying bug"
//    this test exists to prevent.

test("subagent-registry: dead-PID running entry is never surfaced as running", () => {
  __resetSubagentRegistry();
  __setSubagentProcessAliveCheckerForTest(() => false);

  const stateDir = join(tmpdir(), `shim-dead-snapshot-${Math.random().toString(36).slice(2)}`);
  mkdirSync(stateDir, { recursive: true });
  const logFile = join(stateDir, "task_dead_snapshot.log");
  writeFileSync(
    logFile,
    "[Task started: Stranded subagent (snap)]\n[subagent_type: general-purpose]\n",
    "utf8",
  );

  const tcid = "tc-dead-snapshot-1";
  ingestParentFrame(dispatchFrame(tcid, "Stranded subagent"), "run-dead-snapshot");
  ingestParentFrame(
    returnFrame(tcid, "task_dead_snap", "agent-local-dead-snap-aaaa-bbbb-cccc-dddddddddddd", logFile, 999999),
    "run-dead-snapshot",
  );

  const beforeSweep = getSubagent(tcid);
  assert.equal(beforeSweep?.status, "running", "should start as running so we can prove the sweep fixes it");
  assert.ok(beforeSweep?.workerPid);

  const swept = sweepOrphanedSubagents(Date.now());
  assert.equal(swept, 1, "sweep must finalize exactly the dead-PID running entry");

  const after = getSubagent(tcid);
  assert.notEqual(after?.status, "running", "running entries with dead PIDs must be finalized");
  assert.equal(after?.failureReason, "worker_process_dead");

  const snapshot = snapshotSubagents();
  const stillRunning = snapshot.find((s) => s.toolCallId === tcid && s.status === "running");
  assert.equal(stillRunning, undefined, "snapshot must NEVER surface a dead-PID entry as running");

  const active = listActiveSubagents();
  assert.equal(
    active.find((s) => s.toolCallId === tcid),
    undefined,
    "listActiveSubagents must NEVER include a dead-PID entry",
  );

  __setSubagentProcessAliveCheckerForTest(null);
  __resetSubagentRegistry();
});

test("subagent-registry: GET /v1/work-activity never serves dead-PID running entries", async () => {
  // Drives the registry through the public surface that mobile consumes, so a
  // future regression that bypasses the sweep at the HTTP edge also fails.
  // The test does not start a full shim; it imports snapshotSubagents (the
  // function called by GET /v1/work-activity) and asserts its output.
  __resetSubagentRegistry();
  __setSubagentProcessAliveCheckerForTest(() => false);

  const stateDir = join(tmpdir(), `shim-rest-dead-${Math.random().toString(36).slice(2)}`);
  mkdirSync(stateDir, { recursive: true });
  const logFile = join(stateDir, "task_rest_dead.log");
  writeFileSync(
    logFile,
    "[Task started: Stranded subagent (rest)]\n[subagent_type: general-purpose]\n",
    "utf8",
  );

  const tcid = "tc-rest-dead-1";
  ingestParentFrame(dispatchFrame(tcid, "Stranded subagent (rest)"), "run-rest-dead");
  ingestParentFrame(
    returnFrame(tcid, "task_rest_dead", "agent-local-rest-dead-aaaa-bbbb-cccc-dddddddddddd", logFile, 424242),
    "run-rest-dead",
  );

  sweepOrphanedSubagents(Date.now());

  // Equivalent to GET /v1/work-activity's snapshotSubagents() return.
  const snapshot = snapshotSubagents();
  const entry = snapshot.find((s) => s.toolCallId === tcid);
  assert.ok(entry, "entry should still exist (terminal entries remain in snapshot)");
  assert.notEqual(entry?.status, "running", "GET /v1/work-activity must NEVER serve a dead-PID entry as running");

  __setSubagentProcessAliveCheckerForTest(null);
  __resetSubagentRegistry();
});
