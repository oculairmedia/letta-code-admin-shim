import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSubagentTodos } from "../lib/subagent-todos.js";

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function convKey(conversationId: string, agentId: string): string {
  return conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
}

async function withBackendDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "subagent-todos-test-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeMessages(dir: string, agentId: string, conversationId: string, lines: any[]) {
  const key = convKey(conversationId, agentId);
  const cdir = join(dir, "conversations", b64url(key));
  mkdirSync(cdir, { recursive: true });
  const messagesJsonl = join(cdir, "messages.jsonl");
  writeFileSync(messagesJsonl, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

test("Happy Path: correctly parses valid TodoWrite tool call", async () => {
  await withBackendDir(async (dir) => {
    const agentId = "agent-todo-1";
    writeMessages(dir, agentId, "default", [
      {
        id: "msg1",
        role: "assistant",
        parts: [
          {
            type: "toolCall",
            name: "TodoWrite",
            arguments: JSON.stringify({
              todos: [
                { content: "Fix bugs", status: "in_progress", activeForm: "fixing" },
                { content: "Write tests", status: "pending", activeForm: "writing" }
              ]
            })
          }
        ]
      }
    ]);

    const result = readSubagentTodos(agentId);
    assert.equal(result.found, true);
    assert.equal(result.todos.length, 2);
    assert.equal(result.todos[0]?.content, "Fix bugs");
    assert.equal(result.todos[0]?.status, "in_progress");
  });
});

test("Missing File: returns empty result if no messages file exists", async () => {
  await withBackendDir(async () => {
    // We intentionally don't write anything
    const result = readSubagentTodos("agent-todo-2");
    assert.equal(result.found, false);
    assert.equal(result.todos.length, 0);
  });
});

test("Malformed JSON: returns gracefully if JSON parsing fails", async () => {
  await withBackendDir(async (dir) => {
    const agentId = "agent-todo-3";
    writeMessages(dir, agentId, "default", [
      {
        id: "msg1",
        role: "assistant",
        parts: [
          {
            type: "toolCall",
            name: "TodoWrite",
            arguments: "{ malformed json..."
          }
        ]
      }
    ]);

    const result = readSubagentTodos(agentId);
    assert.equal(result.found, true);
    assert.equal(result.todos.length, 0);
  });
});
