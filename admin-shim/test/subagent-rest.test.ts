import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { seedConversation, seedMessage, startShim } from "./helpers/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

function seedSubagentRun(
  fixtureDir: string,
  input: {
    runId: string;
    toolCallId: string;
    parentConversationId: string;
    subagentAgentId: string;
    description: string;
    terminal?: boolean;
  },
): void {
  const runDir = join(fixtureDir, "runs", input.runId);
  const logFile = join(runDir, `${input.runId}.log`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(logFile, input.terminal ? "[Task started]\n[Task completed]\n" : "[Task started]\nworking\n");
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    id: input.runId,
    agent_id: "agent-parent",
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
}

test("conversation-scoped subagent REST contract prevents cross-conversation reads", async (t) => {
  const fixtureName = `subagent-rest-${Math.random().toString(36).slice(2)}`;
  const fixtureDir = join(__dirname, "fixtures", "state", fixtureName);
  const activeAgentId = "agent-local-11112222-3333-4444-5555-666677778888";
  const completedAgentId = "agent-local-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const otherAgentId = "agent-local-99999999-8888-7777-6666-555555555555";

  mkdirSync(fixtureDir, { recursive: true });
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  seedSubagentRun(fixtureDir, {
    runId: "run-active-a",
    toolCallId: "tool/active-a",
    parentConversationId: "conv-a",
    subagentAgentId: activeAgentId,
    description: "Active A",
  });
  seedSubagentRun(fixtureDir, {
    runId: "run-completed-a",
    toolCallId: "tool-completed-a",
    parentConversationId: "conv-a",
    subagentAgentId: completedAgentId,
    description: "Completed A",
    terminal: true,
  });
  seedSubagentRun(fixtureDir, {
    runId: "run-active-b",
    toolCallId: "tool-active-b",
    parentConversationId: "conv-b",
    subagentAgentId: otherAgentId,
    description: "Active B",
  });

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

  const shim = await startShim({ fixture: fixtureName });
  t.after(() => shim.stop());

  const capabilities = await getJson(`${shim.url}/shim/v1/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.body.subagent_registry_v1, { available: true, transport: "rest" });

  const missingListScope = await getJson(`${shim.url}/shim/v1/subagents`);
  assert.equal(missingListScope.status, 400);
  assert.equal(missingListScope.body.detail, "conversation_id is required");

  const missingTodoScope = await getJson(`${shim.url}/shim/v1/subagents/tool%2Factive-a/todos`);
  assert.equal(missingTodoScope.status, 400);
  assert.equal(missingTodoScope.body.detail, "conversation_id is required");

  const activeOnly = await getJson(`${shim.url}/shim/v1/subagents?conversation_id=conv-a&all=false`);
  assert.equal(activeOnly.status, 200);
  assert.deepEqual(activeOnly.body.subagents.map((entry: any) => entry.toolCallId), ["tool/active-a"]);
  assert.equal(activeOnly.body.subagents[0].parentConversationId, "conv-a");

  const all = await getJson(`${shim.url}/shim/v1/subagents?conversation_id=conv-a&all=true`);
  assert.equal(all.status, 200);
  assert.deepEqual(
    new Set(all.body.subagents.map((entry: any) => entry.toolCallId)),
    new Set(["tool/active-a", "tool-completed-a"]),
  );
  assert.ok(all.body.subagents.every((entry: any) => entry.parentConversationId === "conv-a"));

  const wrongConversationList = await getJson(`${shim.url}/shim/v1/subagents?conversation_id=conv-missing&all=true`);
  assert.deepEqual(wrongConversationList.body, { subagents: [] });

  const todos = await getJson(`${shim.url}/shim/v1/subagents/tool%2Factive-a/todos?conversation_id=conv-a`);
  assert.equal(todos.status, 200);
  assert.equal(todos.body.found, true);
  assert.equal(todos.body.subagent.toolCallId, "tool/active-a");
  assert.equal(todos.body.subagent.parentConversationId, "conv-a");
  assert.equal(todos.body.todos_found, true);
  assert.deepEqual(todos.body.todos, [
    { content: "Ship fix", status: "in_progress", activeForm: "Shipping fix" },
  ]);

  const wrongConversationTodos = await getJson(
    `${shim.url}/shim/v1/subagents/tool%2Factive-a/todos?conversation_id=conv-b`,
  );
  assert.deepEqual(wrongConversationTodos.body, {
    found: false,
    subagent: null,
    todos: [],
    todos_found: false,
  });

  const unknownTodos = await getJson(
    `${shim.url}/shim/v1/subagents/unknown/todos?conversation_id=conv-a`,
  );
  assert.deepEqual(unknownTodos.body, {
    found: false,
    subagent: null,
    todos: [],
    todos_found: false,
  });

  const afterReads = await getJson(`${shim.url}/shim/v1/subagents?conversation_id=conv-a&all=true`);
  assert.deepEqual(afterReads.body, all.body, "read routes must not mutate registry state");
});
