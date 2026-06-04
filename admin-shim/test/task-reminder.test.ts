/**
 * Unit tests for the background-task completion reminder core (lcp-gukg).
 *
 * The reminder exists because background subagent completion is delivered as a
 * SINGLE injected <task-notification>; if that push is lost the parent turn
 * hangs forever. These tests pin the decision logic that re-derives terminal
 * status from the authoritative task log and synthesizes exactly one terminal
 * notification per task (idempotently).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyTaskLog,
  scanForTerminalTasks,
  synthesizeSummary,
  type ActiveBackgroundAgent,
  type BackgroundTaskEntry,
} from "../lib/task-reminder.js";

function tasks(
  entries: Array<[string, BackgroundTaskEntry]>,
): Map<string, BackgroundTaskEntry> {
  return new Map(entries);
}

test("classifyTaskLog: detects terminal footers, ignores in-flight logs", () => {
  assert.equal(classifyTaskLog("[Task started: x]\n\nworking..."), null);
  assert.equal(classifyTaskLog("...\n\n[Task completed]\n"), "completed");
  assert.equal(classifyTaskLog("...\n\n[error] boom\n\n[Task failed]\n"), "failed");
  // Failure wins if (pathologically) both markers are present.
  assert.equal(classifyTaskLog("[Task completed]\n[Task failed]\n"), "failed");
});

test("scanForTerminalTasks: synthesizes exactly one terminal notification for a completed-but-still-running task", () => {
  const activeAgents: ActiveBackgroundAgent[] = [
    { id: "subagent-1", description: "build the widget", status: "running" },
  ];
  const backgroundTasks = tasks([
    [
      "task_3",
      {
        subagentId: "subagent-1",
        status: "running", // registry still thinks it's running (push lost)
        outputFile: "/tmp/letta-background/task_3.log",
        subagentType: "general-purpose",
        description: "build the widget",
      },
    ],
  ]);

  const logs: Record<string, string> = {
    "/tmp/letta-background/task_3.log":
      "[Task started: build the widget]\n\nresult\n\n[Task completed]\n",
  };
  const delivered = new Set<string>();

  const pending = scanForTerminalTasks({
    activeAgents,
    backgroundTasks,
    delivered,
    readLog: (f) => logs[f] ?? null,
  });

  assert.equal(pending.length, 1);
  const [p] = pending;
  assert.ok(p);
  assert.equal(p.taskId, "task_3");
  assert.equal(p.subagentId, "subagent-1");
  assert.equal(p.status, "completed");
  assert.equal(p.description, "build the widget");
  assert.match(synthesizeSummary(p), /build the widget.*completed.*recovered/);
});

test("scanForTerminalTasks: idempotent — never re-delivers an already-delivered task", () => {
  const activeAgents: ActiveBackgroundAgent[] = [
    { id: "subagent-1", description: "x", status: "running" },
  ];
  const backgroundTasks = tasks([
    [
      "task_3",
      {
        subagentId: "subagent-1",
        status: "completed",
        outputFile: "/tmp/letta-background/task_3.log",
      },
    ],
  ]);
  const readLog = () => "[Task completed]\n";

  // First scan with an empty delivered set finds it.
  const delivered = new Set<string>();
  const first = scanForTerminalTasks({ activeAgents, backgroundTasks, delivered, readLog });
  assert.equal(first.length, 1);

  // Caller records delivery; a second scan finds nothing.
  delivered.add(first[0]!.taskId);
  const second = scanForTerminalTasks({ activeAgents, backgroundTasks, delivered, readLog });
  assert.equal(second.length, 0);
});

test("scanForTerminalTasks: still-running task produces no notification", () => {
  const pending = scanForTerminalTasks({
    activeAgents: [{ id: "subagent-1", status: "running" }],
    backgroundTasks: tasks([
      ["task_1", { subagentId: "subagent-1", outputFile: "/tmp/x.log" }],
    ]),
    delivered: new Set(),
    readLog: () => "[Task started: x]\n\nworking, no footer yet",
  });
  assert.equal(pending.length, 0);
});

test("scanForTerminalTasks: zero active agents short-circuits to empty", () => {
  const pending = scanForTerminalTasks({
    activeAgents: [],
    backgroundTasks: tasks([
      ["task_1", { subagentId: "subagent-1", outputFile: "/tmp/x.log" }],
    ]),
    delivered: new Set(),
    readLog: () => {
      throw new Error("readLog must not be called when there are no active agents");
    },
  });
  assert.equal(pending.length, 0);
});

test("scanForTerminalTasks: unreadable / missing log is treated as still-running", () => {
  const pending = scanForTerminalTasks({
    activeAgents: [{ id: "subagent-1", status: "running" }],
    backgroundTasks: tasks([
      ["task_1", { subagentId: "subagent-1", outputFile: "/tmp/missing.log" }],
    ]),
    delivered: new Set(),
    readLog: () => null, // missing/unreadable
  });
  assert.equal(pending.length, 0);
});

test("scanForTerminalTasks: dedupes duplicate active entries pointing at one task", () => {
  // Two active agent records but only one is correlated to the task; a second
  // record for the same subagent id must not double-deliver.
  const activeAgents: ActiveBackgroundAgent[] = [
    { id: "subagent-1", status: "running" },
    { id: "subagent-1", status: "running" },
  ];
  const backgroundTasks = tasks([
    ["task_9", { subagentId: "subagent-1", outputFile: "/tmp/t9.log" }],
  ]);
  const pending = scanForTerminalTasks({
    activeAgents,
    backgroundTasks,
    delivered: new Set(),
    readLog: () => "[Task failed]\n",
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.status, "failed");
});
