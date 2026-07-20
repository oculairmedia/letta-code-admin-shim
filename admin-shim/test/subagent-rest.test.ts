import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { seedConversation, seedMessage, startShim } from "./helpers/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type JsonRecord = Record<string, unknown>;

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() as unknown };
}

function record(value: unknown): JsonRecord {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonRecord;
}

function records(value: unknown): JsonRecord[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

function field(value: unknown, key: string): unknown {
  return record(value)[key];
}

function seedSubagentRun(
  fixtureDir: string,
  input: {
    runId: string;
    toolCallId: string;
    parentAgentId: string;
    parentConversationId: string;
    subagentAgentId: string;
    description: string;
    terminal?: boolean;
  },
): string {
  const runDir = join(fixtureDir, "runs", input.runId);
  const logFile = join(runDir, `${input.runId}.log`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(logFile, input.terminal ? "[Task started]\n[Task completed]\n" : "[Task started]\nworking\n");
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    id: input.runId,
    agent_id: input.parentAgentId,
    conversation_id: input.parentConversationId,
    status: "completed",
    started_at: new Date().toISOString(),
  }));
  writeFileSync(join(runDir, "frames.jsonl"), [
    {
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: input.toolCallId,
        name: "Agent",
        arguments: JSON.stringify({
          subagent_type: "general-purpose",
          description: input.description,
          run_in_background: true,
        }),
      },
    },
    {
      message_type: "tool_return_message",
      tool_call_id: input.toolCallId,
      name: "Agent",
      tool_return: `Task running in background with task ID: task_1\nAgent ID: ${input.subagentAgentId}\nOutput file: ${logFile}\n`,
    },
  ].map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  return logFile;
}

function subagents(body: unknown): JsonRecord[] {
  return records(field(body, "subagents"));
}

function toolCallIds(body: unknown): string[] {
  return subagents(body).map((entry) => {
    assert.equal(typeof entry["toolCallId"], "string");
    return entry["toolCallId"] as string;
  });
}

const notFoundTodos = { found: false, subagent: null, todos: [], todos_found: false };

test("conversation-scoped subagent REST contract resolves ownership and sweeps stale entries", async (t) => {
  const fixtureName = `subagent-rest-${Math.random().toString(36).slice(2)}`;
  const fixtureDir = join(__dirname, "fixtures", "state", fixtureName);
  const parentA = "agent-parent-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const parentB = "agent-parent-11111111-2222-3333-4444-555555555555";
  const activeAgentId = "agent-local-11112222-3333-4444-5555-666677778888";
  const completedAgentId = "agent-local-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const otherAgentId = "agent-local-99999999-8888-7777-6666-555555555555";
  const defaultAgentA = "agent-local-dddddddd-aaaa-bbbb-cccc-111111111111";
  const defaultAgentB = "agent-local-dddddddd-aaaa-bbbb-cccc-222222222222";

  mkdirSync(fixtureDir, { recursive: true });
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  seedSubagentRun(fixtureDir, {
    runId: "run-active-a",
    toolCallId: "tool/active-a",
    parentAgentId: parentA,
    parentConversationId: "conv-a",
    subagentAgentId: activeAgentId,
    description: "Active A",
  });
  seedSubagentRun(fixtureDir, {
    runId: "run-completed-a",
    toolCallId: "tool-completed-a",
    parentAgentId: parentA,
    parentConversationId: "conv-a",
    subagentAgentId: completedAgentId,
    description: "Completed A",
    terminal: true,
  });
  seedSubagentRun(fixtureDir, {
    runId: "run-fresh-a",
    toolCallId: "tool/fresh-a",
    parentAgentId: parentA,
    parentConversationId: "conv-fresh-a",
    subagentAgentId: "agent-local-fresh",
    description: "Fresh A",
  });
  seedSubagentRun(fixtureDir, {
    runId: "run-active-b",
    toolCallId: "tool-active-b",
    parentAgentId: parentB,
    parentConversationId: "conv-b",
    subagentAgentId: otherAgentId,
    description: "Active B",
  });
  const staleDetailLog = seedSubagentRun(fixtureDir, {
    runId: "run-stale-detail-a",
    toolCallId: "tool/stale-detail-a",
    parentAgentId: parentA,
    parentConversationId: "conv-a",
    subagentAgentId: "agent-local-stale-detail",
    description: "Stale detail A",
  });
  const staleLog = seedSubagentRun(fixtureDir, {
    runId: "run-stale-a",
    toolCallId: "tool/stale-a",
    parentAgentId: parentA,
    parentConversationId: "conv-a",
    subagentAgentId: "agent-local-stale",
    description: "Stale A",
  });
  seedSubagentRun(fixtureDir, {
    runId: "run-default-a",
    toolCallId: "tool/default-a",
    parentAgentId: parentA,
    parentConversationId: "default",
    subagentAgentId: defaultAgentA,
    description: "Default A",
  });
  seedSubagentRun(fixtureDir, {
    runId: "run-default-b",
    toolCallId: "tool/default-b",
    parentAgentId: parentB,
    parentConversationId: "default",
    subagentAgentId: defaultAgentB,
    description: "Default B",
  });

  seedConversation(fixtureDir, parentA, { id: "conv-a" });
  seedConversation(fixtureDir, parentB, { id: "conv-b" });
  seedConversation(fixtureDir, parentA);
  seedConversation(fixtureDir, parentB);
  seedConversation(fixtureDir, activeAgentId);
  seedMessage(fixtureDir, activeAgentId, "default", {
    role: "assistant",
    parts: [{
      type: "toolCall",
      name: "TodoWrite",
      id: "todo-call-1",
      arguments: {
        todos: [{ content: "Ship fix", status: "in_progress", activeForm: "Shipping fix" }],
      },
    }],
  });
  seedConversation(fixtureDir, defaultAgentA);
  seedMessage(fixtureDir, defaultAgentA, "default", {
    role: "assistant",
    parts: [{
      type: "toolCall",
      name: "TodoWrite",
      id: "todo-call-default-a",
      arguments: {
        todos: [{ content: "Alias task", status: "pending", activeForm: "Preparing alias task" }],
      },
    }],
  });

  const shim = await startShim({ fixture: fixtureName });
  t.after(() => shim.stop());

  const capabilities = await getJson(`${shim.url}/shim/v1/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.deepEqual(field(capabilities.body, "subagent_registry_v1"), { available: true, transport: "rest" });

  const missingListScope = await getJson(`${shim.url}/shim/v1/subagents`);
  assert.equal(missingListScope.status, 400);
  assert.equal(field(missingListScope.body, "detail"), "conversation_id is required");

  const missingTodoScope = await getJson(`${shim.url}/shim/v1/subagents/tool%2Factive-a/todos`);
  assert.equal(missingTodoScope.status, 400);
  assert.equal(field(missingTodoScope.body, "detail"), "conversation_id is required");

  appendFileSync(staleLog, "[Task completed]\n");
  const activeOnly = await getJson(`${shim.url}/shim/v1/subagents?conversation_id=conv-a&all=false`);
  assert.equal(activeOnly.status, 200);
  assert.deepEqual(toolCallIds(activeOnly.body), ["tool/stale-detail-a", "tool/active-a"]);
  assert.equal(subagents(activeOnly.body)[0]?.["parentConversationId"], "conv-a");

  const all = await getJson(`${shim.url}/shim/v1/subagents?conversation_id=conv-a&all=true`);
  assert.equal(all.status, 200);
  assert.deepEqual(
    new Set(toolCallIds(all.body)),
    new Set(["tool/active-a", "tool-completed-a", "tool/stale-a", "tool/stale-detail-a"]),
  );
  assert.ok(subagents(all.body).every((entry) =>
    entry["parentConversationId"] === "conv-a" && entry["parentAgentId"] === parentA
  ));
  const stale = subagents(all.body).find((entry) => entry["toolCallId"] === "tool/stale-a");
  assert.equal(stale?.["status"], "completed", "list reads must sweep stale running entries first");

  const externalDefault = await getJson(
    `${shim.url}/shim/v1/subagents?conversation_id=conv-default-${parentA}&all=false`,
  );
  assert.deepEqual(toolCallIds(externalDefault.body), ["tool/default-a"]);

  const internalDefault = await getJson(
    `${shim.url}/shim/v1/subagents?conversation_id=default&agent_id=${parentA}&all=false`,
  );
  assert.deepEqual(toolCallIds(internalDefault.body), ["tool/default-a"]);

  const ambiguousDefault = await getJson(`${shim.url}/shim/v1/subagents?conversation_id=default`);
  assert.equal(ambiguousDefault.status, 400);
  assert.equal(field(ambiguousDefault.body, "detail"), "agent_id is required for conversation_id=default");

  const wrongAgent = await getJson(
    `${shim.url}/shim/v1/subagents?conversation_id=conv-default-${parentA}&agent_id=${parentB}&all=true`,
  );
  assert.deepEqual(wrongAgent.body, { subagents: [] });

  const wrongConversationList = await getJson(`${shim.url}/shim/v1/subagents?conversation_id=conv-missing&all=true`);
  assert.deepEqual(wrongConversationList.body, { subagents: [] });

  const freshWithOwner = await getJson(
    `${shim.url}/shim/v1/subagents?conversation_id=conv-fresh-a&agent_id=${parentA}&all=false`,
  );
  assert.deepEqual(toolCallIds(freshWithOwner.body), ["tool/fresh-a"]);
  const freshWithoutOwner = await getJson(
    `${shim.url}/shim/v1/subagents?conversation_id=conv-fresh-a&all=false`,
  );
  assert.deepEqual(freshWithoutOwner.body, { subagents: [] });

  const todos = await getJson(`${shim.url}/shim/v1/subagents/tool%2Factive-a/todos?conversation_id=conv-a`);
  assert.equal(todos.status, 200);
  assert.equal(field(todos.body, "found"), true);
  assert.equal(field(field(todos.body, "subagent"), "toolCallId"), "tool/active-a");
  assert.equal(field(field(todos.body, "subagent"), "parentConversationId"), "conv-a");
  assert.equal(field(todos.body, "todos_found"), true);
  assert.deepEqual(field(todos.body, "todos"), [
    { content: "Ship fix", status: "in_progress", activeForm: "Shipping fix" },
  ]);

  appendFileSync(staleDetailLog, "[Task completed]\n");
  const staleTodos = await getJson(
    `${shim.url}/shim/v1/subagents/tool%2Fstale-detail-a/todos?conversation_id=conv-a`,
  );
  assert.equal(field(field(staleTodos.body, "subagent"), "status"), "completed");

  const aliasTodos = await getJson(
    `${shim.url}/shim/v1/subagents/tool%2Fdefault-a/todos?conversation_id=conv-default-${parentA}`,
  );
  assert.equal(field(aliasTodos.body, "found"), true);
  assert.deepEqual(field(aliasTodos.body, "todos"), [
    { content: "Alias task", status: "pending", activeForm: "Preparing alias task" },
  ]);

  const wrongConversationTodos = await getJson(
    `${shim.url}/shim/v1/subagents/tool%2Factive-a/todos?conversation_id=conv-b`,
  );
  assert.deepEqual(wrongConversationTodos.body, notFoundTodos);

  const wrongAgentTodos = await getJson(
    `${shim.url}/shim/v1/subagents/tool%2Fdefault-a/todos?conversation_id=conv-default-${parentA}&agent_id=${parentB}`,
  );
  assert.deepEqual(wrongAgentTodos.body, notFoundTodos);

  const unknownTodos = await getJson(
    `${shim.url}/shim/v1/subagents/unknown/todos?conversation_id=conv-a`,
  );
  assert.deepEqual(unknownTodos.body, notFoundTodos);
});
