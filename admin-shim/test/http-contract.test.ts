/**
 * HTTP contract regression tests for the admin-shim.
 *
 * These tests freeze the wire shapes that mobile / vanilla-Letta clients
 * depend on. They cover ONLY read paths (and an idempotent conversation
 * create) so no real model or stream is required. Designed as the safety
 * net before refactoring this codebase from .mjs to TypeScript.
 *
 * Each test starts its own shim, seeds whatever disk state it needs, and
 * tears the process down via t.after(). No shared mutable state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import {
  startShim,
  seedAgent,
  seedConversation,
  seedMessage,
  externalConvId,
} from "./helpers/index.js";
import type { LocalMessagePart } from "../lib/types/letta-stream.js";

// ── helpers ─────────────────────────────────────────────────────────

async function getJson(url: string): Promise<{ res: Response; body: unknown }> {
  const res = await fetch(url);
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { res, body };
}

// ── health ──────────────────────────────────────────────────────────

test("GET /v1/health/ returns ok with server identity", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/health/`);
  const b = body as {
    status: string;
    backend: string;
    server_id: string;
    server_started_at: string;
    version: string;
  };
  assert.equal(res.status, 200);
  assert.equal(b.status, "ok");
  assert.equal(b.backend, "letta-code-local");
  assert.ok(b.server_id, "server_id present");
  assert.ok(b.server_started_at, "server_started_at present");
  assert.ok(b.version, "version present");
});

test("GET /v1/health (no trailing slash) is also served", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/health`);
  const b = body as { status: string };
  assert.equal(res.status, 200);
  assert.equal(b.status, "ok");
});

// ── agents list / count / detail ────────────────────────────────────

test("GET /v1/agents returns [] when no agents seeded", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/agents`);
  assert.equal(res.status, 200);
  assert.deepEqual(body, []);
});

test("GET /v1/agents/count returns 0 when empty, N after seeding", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const empty = await getJson(`${shim.url}/v1/agents/count`);
  assert.equal(empty.res.status, 200);
  assert.equal(empty.body, 0);

  seedAgent(shim.stateDir, { id: "agent-count-1", name: "One" });
  seedAgent(shim.stateDir, { id: "agent-count-2", name: "Two" });

  const after = await getJson(`${shim.url}/v1/agents/count`);
  assert.equal(after.res.status, 200);
  assert.equal(after.body, 2);
});

test("GET /v1/agents lists seeded agents with vanilla AgentState shape", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, {
    id: "agent-list-001",
    name: "Listy",
    systemPrompt: "Be brief.",
    blocks: { persona: "I am Listy.", human: "User is human." },
    tools: ["Bash", "Read"],
  });
  seedConversation(shim.stateDir, id);

  const { res, body } = await getJson(`${shim.url}/v1/agents`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body));
  const arr = body as Array<{
    id: string;
    name: string;
    system: string;
    tools: unknown[];
    memory: { blocks: Array<{ label: string }> };
    llm_config: { model: string; model_endpoint_type: string };
  }>;
  assert.equal(arr.length, 1);
  const a = arr[0]!;
  assert.equal(a.id, id);
  assert.equal(a.name, "Listy");
  assert.equal(a.system, "Be brief.");
  // translate.mjs hard-codes tools: []
  assert.deepEqual(a.tools, []);
  // memory.blocks reflects readBlocksForAgent (file-based)
  assert.ok(a.memory, "memory field present");
  assert.ok(Array.isArray(a.memory.blocks));
  const labels = a.memory.blocks.map((b) => b.label).sort();
  assert.deepEqual(labels, ["human", "persona"]);
  // llm_config shape
  assert.ok(a.llm_config);
  assert.equal(typeof a.llm_config.model, "string");
  assert.equal(a.llm_config.model_endpoint_type, "openai");
});

test("GET /v1/agents orders by mtime descending", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  // Seed sequentially; the second write has a strictly newer mtime.
  seedAgent(shim.stateDir, { id: "agent-mtime-old", name: "Old" });
  // small delay to ensure mtime resolution distinguishes them
  await new Promise((r) => setTimeout(r, 20));
  seedAgent(shim.stateDir, { id: "agent-mtime-new", name: "New" });

  const { body } = await getJson(`${shim.url}/v1/agents`);
  const arr = body as Array<{ id: string }>;
  const ids = arr.map((a) => a.id);
  assert.equal(ids[0], "agent-mtime-new", `expected newest first, got ${ids.join(",")}`);
  assert.equal(ids[1], "agent-mtime-old");
});

test("GET /v1/agents honors limit and offset", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  for (let i = 0; i < 4; i++) {
    seedAgent(shim.stateDir, { id: `agent-page-${i}`, name: `P${i}` });
    // ensure mtime ordering is deterministic
    await new Promise((r) => setTimeout(r, 10));
  }

  const all = await getJson(`${shim.url}/v1/agents`);
  const allArr = all.body as Array<{ id: string }>;
  assert.equal(allArr.length, 4);

  const limited = await getJson(`${shim.url}/v1/agents?limit=2`);
  const limitedArr = limited.body as Array<{ id: string }>;
  assert.equal(limitedArr.length, 2);

  const offset = await getJson(`${shim.url}/v1/agents?limit=2&offset=2`);
  const offsetArr = offset.body as Array<{ id: string }>;
  assert.equal(offsetArr.length, 2);
  // Ensure they're different slices
  const limitIds = limitedArr.map((a) => a.id);
  const offsetIds = offsetArr.map((a) => a.id);
  for (const id of limitIds) assert.ok(!offsetIds.includes(id), `slices should not overlap`);
});

test("GET /v1/agents/{id} returns the agent record", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, { id: "agent-detail-001", name: "Detailed" });
  const { res, body } = await getJson(`${shim.url}/v1/agents/${id}`);
  const b = body as { id: string; name: string; agent_type: string };
  assert.equal(res.status, 200);
  assert.equal(b.id, id);
  assert.equal(b.name, "Detailed");
  assert.equal(b.agent_type, "memgpt_agent");
});

test("GET /v1/agents/{unknown} returns 404 with { detail }", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/agents/agent-does-not-exist`);
  const b = body as { detail: string };
  assert.equal(res.status, 404);
  assert.equal(typeof b.detail, "string");
  assert.match(b.detail, /agent-does-not-exist/);
});

// ── agent messages ──────────────────────────────────────────────────

test("GET /v1/agents/{id}/messages returns [] when no messages in default conv", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, { id: "agent-msgs-empty" });
  seedConversation(shim.stateDir, id);

  const { res, body } = await getJson(`${shim.url}/v1/agents/${id}/messages`);
  assert.equal(res.status, 200);
  assert.deepEqual(body, []);
});

test("GET /v1/agents/{id}/messages returns vanilla-shaped messages", async (t) => {
  // lcp-cox: this endpoint now fans out one LocalMessage → one or more
  // vanilla LettaMessage variants, matching /v1/conversations/{id}/messages
  // and what real Letta servers return. The old legacy-hybrid record (with
  // top-level role / agent_id / conversation_id and content: Array<{type,
  // text}>) is gone — mobile already handles both shapes via its loose
  // LettaMessageSerializer.
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, { id: "agent-msgs-001" });
  seedConversation(shim.stateDir, id);
  seedMessage(shim.stateDir, id, "default", {
    id: "ui-msg-u1",
    role: "user",
    content: "hello world",
    sourceMessageIndex: 0,
  });
  seedMessage(shim.stateDir, id, "default", {
    id: "ui-msg-a1",
    role: "assistant",
    content: "hi back",
    sourceMessageIndex: 1,
  });

  const { res, body } = await getJson(`${shim.url}/v1/agents/${id}/messages`);
  const arr = body as Array<{
    id: string;
    message_type: string;
    content: string;
    otid: string;
    name: string | null;
    is_err: unknown;
  }>;
  assert.equal(res.status, 200);
  assert.equal(arr.length, 2);
  const u = arr[0]!;
  assert.equal(u.id, "ui-msg-u1");
  assert.equal(u.message_type, "user_message");
  assert.equal(u.content, "hello world");
  // otid defaults to localMsg.id when no mobile-supplied otid is recorded.
  assert.equal(u.otid, "ui-msg-u1");
  assert.equal(u.name, null);
  assert.equal(u.is_err, null);

  const a = arr[1]!;
  assert.equal(a.id, "ui-msg-a1");
  assert.equal(a.message_type, "assistant_message");
  assert.equal(a.content, "hi back");
});

test("GET /v1/agents/{id}/messages fans out tool turns to tool_call_message + tool_return_message (lcp-cox)", async (t) => {
  // Regression gate: the legacy hybrid that this endpoint used to serve
  // hard-coded tool_calls=null, so mobile saw tool turns as bare assistant
  // bubbles on context-window inspection. After lcp-cox the endpoint uses
  // the same fan-out projection as /v1/conversations/{id}/messages.
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, { id: "agent-tool-001" });
  seedConversation(shim.stateDir, id);
  // user typed a request
  seedMessage(shim.stateDir, id, "default", {
    id: "ui-msg-u1",
    role: "user",
    content: "list files",
    sourceMessageIndex: 0,
  });
  // assistant emitted a new-shape toolCall part (letta-code 0.25.x)
  seedMessage(shim.stateDir, id, "default", {
    id: "ui-msg-a1",
    role: "assistant",
    parts: [
      { type: "text", text: "" },
      {
        // Cast — `toolCall` is the new-shape part type letta-code 0.25.x
        // writes; the union here still accepts it via the new
        // LocalMessageToolCallContentPart variant.
        type: "toolCall",
        id: "toolu_LCPCOX_01",
        name: "Bash",
        arguments: { command: "ls" },
      } as unknown as LocalMessagePart,
    ],
    sourceMessageIndex: 1,
  });
  // top-level toolResult row (new shape)
  seedMessage(shim.stateDir, id, "default", {
    id: "ui-msg-a1:tool-result:toolu_LCPCOX_01",
    role: "toolResult",
    parts: [{ type: "text", text: "README.md\nserver.ts\n" }],
    sourceMessageIndex: 2,
    extra: {
      toolCallId: "toolu_LCPCOX_01",
      toolName: "Bash",
      isError: false,
    },
  });

  const { res, body } = await getJson(`${shim.url}/v1/agents/${id}/messages`);
  const arr = body as Array<{
    id: string;
    message_type: string;
    name?: string | null;
    content?: string;
    tool_call?: { tool_call_id: string; name: string; arguments: string };
    tool_call_id?: string;
    tool_return?: string;
    status?: string;
  }>;
  assert.equal(res.status, 200);
  const types = arr.map((m) => m.message_type);
  assert.deepEqual(
    types,
    ["user_message", "tool_call_message", "tool_return_message"],
    `fan-out drift: got [${types.join(", ")}]`,
  );

  const tc = arr[1]!;
  assert.equal(tc.tool_call?.tool_call_id, "toolu_LCPCOX_01");
  assert.equal(tc.tool_call?.name, "Bash");
  assert.equal(tc.tool_call?.arguments, JSON.stringify({ command: "ls" }));
  // Mobile dedups streamed and history-list copies of the same tool call
  // by id — this shared id format is the dedup contract.
  assert.equal(tc.id, "toolcall-toolu_LCPCOX_01");

  const tr = arr[2]!;
  assert.equal(tr.tool_call_id, "toolu_LCPCOX_01");
  assert.equal(tr.name, "Bash");
  assert.equal(tr.status, "success");
  assert.equal(tr.tool_return, "README.md\nserver.ts\n");
  assert.equal(tr.id, "toolreturn-toolu_LCPCOX_01");
});

test("GET /v1/agents/{id}/context.messages also fans out tool turns (lcp-cox)", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, { id: "agent-ctx-tool", systemPrompt: "sys" });
  seedConversation(shim.stateDir, id);
  seedMessage(shim.stateDir, id, "default", {
    id: "ctx-u1",
    role: "user",
    content: "do it",
    sourceMessageIndex: 0,
  });
  seedMessage(shim.stateDir, id, "default", {
    id: "ctx-a1",
    role: "assistant",
    parts: [
      {
        type: "toolCall",
        id: "toolu_CTX_01",
        name: "Read",
        arguments: { file_path: "/tmp/x" },
      } as unknown as LocalMessagePart,
    ],
    sourceMessageIndex: 1,
  });
  seedMessage(shim.stateDir, id, "default", {
    id: "ctx-a1:tool-result:toolu_CTX_01",
    role: "toolResult",
    parts: [{ type: "text", text: "Error: ENOENT" }],
    sourceMessageIndex: 2,
    extra: { toolCallId: "toolu_CTX_01", toolName: "Read", isError: true },
  });

  const { res, body } = await getJson(`${shim.url}/v1/agents/${id}/context`);
  const b = body as { messages: Array<{ message_type: string; is_err?: unknown; status?: string }> };
  assert.equal(res.status, 200);
  const types = b.messages.map((m) => m.message_type);
  assert.deepEqual(
    types,
    ["user_message", "tool_call_message", "tool_return_message"],
    `context messages drift: got [${types.join(", ")}]`,
  );
  const tr = b.messages[2]!;
  assert.equal(tr.is_err, true);
  assert.equal(tr.status, "error");
});

test("GET /v1/agents/{id}/messages honors limit and before", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, { id: "agent-msgs-pag" });
  seedConversation(shim.stateDir, id);
  for (let i = 0; i < 5; i++) {
    seedMessage(shim.stateDir, id, "default", {
      id: `ui-msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
      sourceMessageIndex: i,
    });
  }

  const limited = await getJson(`${shim.url}/v1/agents/${id}/messages?limit=2`);
  const limitedArr = limited.body as Array<{ id: string }>;
  assert.equal(limitedArr.length, 2);
  // store.listMessages slices from the END when limit is given
  assert.deepEqual(limitedArr.map((m) => m.id), ["ui-msg-3", "ui-msg-4"]);

  const before = await getJson(`${shim.url}/v1/agents/${id}/messages?before=ui-msg-3`);
  const beforeArr = before.body as Array<{ id: string }>;
  assert.deepEqual(beforeArr.map((m) => m.id), ["ui-msg-0", "ui-msg-1", "ui-msg-2"]);
});

test("GET /v1/agents/{unknown}/messages returns 404", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/agents/agent-nope/messages`);
  const b = body as { detail: string };
  assert.equal(res.status, 404);
  assert.equal(typeof b.detail, "string");
});

// ── agent context ──────────────────────────────────────────────────

test("GET /v1/agents/{id}/context returns context-window overview", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, { id: "agent-ctx-001", systemPrompt: "You are X." });
  seedConversation(shim.stateDir, id);
  seedMessage(shim.stateDir, id, "default", { id: "ctx-m1", role: "user", content: "hey" });

  const { res, body } = await getJson(`${shim.url}/v1/agents/${id}/context`);
  const b = body as {
    num_messages: number;
    num_archival_memory: number;
    num_recall_memory: number;
    messages: unknown[];
    system_prompt: string;
    context_window_size_max: number;
  };
  assert.equal(res.status, 200);
  assert.equal(b.num_messages, 1);
  assert.equal(b.num_archival_memory, 0);
  assert.equal(b.num_recall_memory, 1);
  assert.ok(Array.isArray(b.messages));
  assert.equal(b.messages.length, 1);
  // system_prompt is taken from the conv's system-prompt.json (seeded helper)
  assert.equal(typeof b.system_prompt, "string");
  assert.ok(b.context_window_size_max > 0);
});

test("GET /v1/agents/{unknown}/context returns 404", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/agents/agent-ghost/context`);
  const b = body as { detail: string };
  assert.equal(res.status, 404);
  assert.equal(typeof b.detail, "string");
});

// ── core-memory blocks ─────────────────────────────────────────────

test("GET /v1/agents/{id}/core-memory/blocks returns memfs-derived blocks", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, {
    id: "agent-blocks-001",
    blocks: { persona: "I am persona-text", human: "user-text" },
  });

  const { res, body } = await getJson(`${shim.url}/v1/agents/${id}/core-memory/blocks`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body));
  const arr = body as Array<{
    id: string;
    label: string;
    value: string;
    limit: number;
    tags: unknown[];
    read_only: boolean;
  }>;
  assert.equal(arr.length, 2);
  const byLabel = Object.fromEntries(arr.map((b) => [b.label, b]));
  assert.equal(byLabel["persona"]!.value, "I am persona-text");
  assert.equal(byLabel["human"]!.value, "user-text");
  // Required vanilla Block fields
  for (const b of arr) {
    assert.ok(b.id, "block.id present");
    assert.equal(typeof b.label, "string");
    assert.equal(typeof b.value, "string");
    assert.equal(b.limit, 5000);
    assert.deepEqual(b.tags, []);
    assert.equal(b.read_only, false);
  }
});

test("GET /v1/agents/{unknown}/core-memory/blocks returns 404", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/agents/agent-no/core-memory/blocks`);
  const b = body as { detail: string };
  assert.equal(res.status, 404);
  assert.equal(typeof b.detail, "string");
});

// ── /v1/blocks (cross-agent) ───────────────────────────────────────

test("GET /v1/blocks unions blocks across all agents", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  seedAgent(shim.stateDir, {
    id: "agent-blkA",
    blocks: { persona: "A-persona" },
  });
  seedAgent(shim.stateDir, {
    id: "agent-blkB",
    blocks: { persona: "B-persona", human: "B-human" },
  });

  const { res, body } = await getJson(`${shim.url}/v1/blocks`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body));
  const arr = body as unknown[];
  // 1 from A + 2 from B = 3
  assert.equal(arr.length, 3);
});

test("GET /v1/blocks/{id} returns a single block", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, {
    id: "agent-blkSingle",
    blocks: { persona: "find me" },
  });
  // First fetch the list to learn the synthesized id
  const list = await getJson(`${shim.url}/v1/agents/${id}/core-memory/blocks`);
  const listArr = list.body as Array<{ id: string }>;
  const blockId = listArr[0]!.id;

  const { res, body } = await getJson(`${shim.url}/v1/blocks/${blockId}`);
  const b = body as { id: string; value: string };
  assert.equal(res.status, 200);
  assert.equal(b.id, blockId);
  assert.equal(b.value, "find me");
});

test("GET /v1/blocks/{unknown} returns 404", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/blocks/block-nonexistent`);
  const b = body as { detail: string };
  assert.equal(res.status, 404);
  assert.equal(typeof b.detail, "string");
});

// ── conversations ──────────────────────────────────────────────────

test("GET /v1/conversations lists across agents and emits external ids", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const a = seedAgent(shim.stateDir, { id: "agent-convA" });
  const b = seedAgent(shim.stateDir, { id: "agent-convB" });
  seedConversation(shim.stateDir, a);
  seedConversation(shim.stateDir, b);

  const { res, body } = await getJson(`${shim.url}/v1/conversations`);
  const arr = body as Array<{ id: string; agent_id: string; in_context_message_ids: unknown[] }>;
  assert.equal(res.status, 200);
  assert.equal(arr.length, 2);
  // Both should have synthesized external ids
  const ids = arr.map((c) => c.id).sort();
  assert.deepEqual(ids, [`conv-default-${a}`, `conv-default-${b}`].sort());
  for (const c of arr) {
    assert.ok(c.agent_id);
    assert.ok(Array.isArray(c.in_context_message_ids));
  }
});

test("GET /v1/conversations reflects last_message_at bumps after a turn (lcp-5ky)", async (t) => {
  // Regression: the listAllConversations cache is keyed on the conversations
  // root mtime, which doesn't change when a child conversation.json is
  // rewritten in place. Without an explicit invalidate the mobile list
  // shows stale recent-activity ordering forever — defended here.
  //
  // The mock letta binary doesn't write to messages.jsonl, so we pre-seed
  // an unstamped user message before triggering the turn. That gives
  // stampNewMessages something to write a sidecar entry for, which is the
  // path that fires bumpConversationLastMessageAt. With the cache
  // invalidate in place, the second GET sees the bumped timestamp; without
  // it, the GET returns the original (pre-bump) value.
  const { openMobileWs } = await import("./helpers/index.js");
  const shim = await startShim();
  t.after(() => shim.stop());
  const agentId = seedAgent(shim.stateDir, { id: "agent-bump-1" });
  seedConversation(shim.stateDir, agentId);

  const before = await getJson(`${shim.url}/v1/conversations`);
  const beforeRow = (before.body as Array<{ id: string; last_message_at: string | null }>)
    .find((c) => c.id === externalConvId(agentId));
  assert.ok(beforeRow, "seeded conv must appear in the list");
  const beforeIso = beforeRow.last_message_at ?? "";

  // Pre-seed a user message so stampNewMessages has work to do.
  seedMessage(shim.stateDir, agentId, "default", {
    role: "user",
    content: "pre-seed for bump test",
  });

  const conn = await openMobileWs(shim.url!, { token: shim.mobileToken, timeoutMs: 8000 });
  t.after(() => conn.close());
  conn.send({
    type: "send_message",
    agent_id: agentId,
    conversation_id: externalConvId(agentId),
    text: "reply with pong",
    otid: "cm-bump-1",
  });
  await conn.collectTurn({ timeoutMs: 8000 });

  const after = await getJson(`${shim.url}/v1/conversations`);
  const afterRow = (after.body as Array<{ id: string; last_message_at: string | null }>)
    .find((c) => c.id === externalConvId(agentId));
  assert.ok(afterRow, "conv must still appear post-turn");
  const afterIso = afterRow.last_message_at ?? "";
  assert.ok(afterIso, "last_message_at must be populated after a turn");
  assert.ok(
    afterIso > beforeIso,
    `last_message_at must advance after a turn: before=${beforeIso} after=${afterIso}`,
  );
});

test("GET /v1/conversations/{external-default-id} resolves to the agent's default conv", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const id = seedAgent(shim.stateDir, { id: "agent-conv-ext" });
  seedConversation(shim.stateDir, id);

  const extId = externalConvId(id);
  const { res, body } = await getJson(`${shim.url}/v1/conversations/${extId}`);
  const b = body as { id: string; agent_id: string };
  assert.equal(res.status, 200);
  assert.equal(b.id, extId);
  assert.equal(b.agent_id, id);
});

test("GET /v1/conversations/{explicit-id} resolves to explicit conv", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, { id: "agent-conv-explicit" });
  seedConversation(shim.stateDir, aid, { id: "conv-explicit-1" });

  const { res, body } = await getJson(`${shim.url}/v1/conversations/conv-explicit-1`);
  const b = body as { id: string; agent_id: string };
  assert.equal(res.status, 200);
  assert.equal(b.id, "conv-explicit-1");
  assert.equal(b.agent_id, aid);
});

test("GET /v1/conversations/{unknown}/messages returns [] (mobile-friendly)", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  // server.mjs returns 200 [] for unresolvable conv-ids on the messages
  // listing endpoint, to keep mobile's retry loop from thrashing.
  const { res, body } = await getJson(`${shim.url}/v1/conversations/conv-mystery/messages`);
  assert.equal(res.status, 200);
  assert.deepEqual(body, []);
});

test("GET /v1/conversations/{unknown} returns 404 on detail", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/conversations/conv-unknown`);
  const b = body as { detail: string };
  assert.equal(res.status, 404);
  assert.equal(typeof b.detail, "string");
});

// ── conversation messages — projection contract ─────────────────────

test("GET /v1/conversations/{ext}/messages projects user message with otid=localMsg.id by default", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, { id: "agent-proj-user" });
  seedConversation(shim.stateDir, aid);
  seedMessage(shim.stateDir, aid, "default", {
    id: "ui-msg-projU",
    role: "user",
    content: "typed by user",
    sourceMessageIndex: 0,
  });

  const ext = externalConvId(aid);
  const { res, body } = await getJson(`${shim.url}/v1/conversations/${ext}/messages`);
  const arr = body as Array<{
    id: string;
    message_type: string;
    otid: string;
    content: string;
    name: string | null;
    is_err: unknown;
  }>;
  assert.equal(res.status, 200);
  assert.equal(arr.length, 1);
  const m = arr[0]!;
  assert.equal(m.id, "ui-msg-projU");
  assert.equal(m.message_type, "user_message");
  // The crucial contract: no otid map, so otid echoes localMsg.id.
  assert.equal(m.otid, "ui-msg-projU");
  assert.equal(m.content, "typed by user");
  // Other vanilla fields
  assert.equal(m.name, null);
  assert.equal(m.is_err, null);
});

test("GET /v1/conversations/{ext}/messages strips <system-reminder> envelopes from user content", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, { id: "agent-proj-sysrem" });
  seedConversation(shim.stateDir, aid);
  seedMessage(shim.stateDir, aid, "default", {
    id: "ui-msg-sysrem",
    role: "user",
    content: "<system-reminder>private context</system-reminder>\n\nhello there",
    sourceMessageIndex: 0,
  });

  const ext = externalConvId(aid);
  const { body } = await getJson(`${shim.url}/v1/conversations/${ext}/messages`);
  const arr = body as Array<{ content: string }>;
  assert.equal(arr.length, 1);
  assert.equal(arr[0]!.content, "hello there");
});

test("GET /v1/conversations/{ext}/messages honors order=asc / order=desc", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, { id: "agent-proj-order" });
  seedConversation(shim.stateDir, aid);
  seedMessage(shim.stateDir, aid, "default", { id: "po-1", role: "user", content: "a", sourceMessageIndex: 0 });
  seedMessage(shim.stateDir, aid, "default", { id: "po-2", role: "user", content: "b", sourceMessageIndex: 1 });
  seedMessage(shim.stateDir, aid, "default", { id: "po-3", role: "user", content: "c", sourceMessageIndex: 2 });

  const ext = externalConvId(aid);
  const asc = await getJson(`${shim.url}/v1/conversations/${ext}/messages?order=asc`);
  const ascArr = asc.body as Array<{ id: string }>;
  assert.deepEqual(ascArr.map((m) => m.id), ["po-1", "po-2", "po-3"]);

  const desc = await getJson(`${shim.url}/v1/conversations/${ext}/messages?order=desc`);
  const descArr = desc.body as Array<{ id: string }>;
  assert.deepEqual(descArr.map((m) => m.id), ["po-3", "po-2", "po-1"]);
});

test("GET /v1/conversations/{ext}/messages honors limit and before", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, { id: "agent-proj-pag" });
  seedConversation(shim.stateDir, aid);
  for (let i = 0; i < 5; i++) {
    seedMessage(shim.stateDir, aid, "default", {
      id: `pp-${i}`,
      role: "user",
      content: `t${i}`,
      sourceMessageIndex: i,
    });
  }
  const ext = externalConvId(aid);

  const lim = await getJson(`${shim.url}/v1/conversations/${ext}/messages?limit=2`);
  const limArr = lim.body as Array<{ id: string }>;
  // listMessages tails the array; ascending order is default
  assert.deepEqual(limArr.map((m) => m.id), ["pp-3", "pp-4"]);

  const before = await getJson(`${shim.url}/v1/conversations/${ext}/messages?before=pp-3`);
  const beforeArr = before.body as Array<{ id: string }>;
  assert.deepEqual(beforeArr.map((m) => m.id), ["pp-0", "pp-1", "pp-2"]);
});

test("GET /v1/conversations/{ext}/messages projects assistant text into assistant_message", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, { id: "agent-proj-asst" });
  seedConversation(shim.stateDir, aid);
  seedMessage(shim.stateDir, aid, "default", {
    id: "ui-msg-asst",
    role: "assistant",
    parts: [{ type: "text", text: "result is 42" }],
    sourceMessageIndex: 0,
  });

  const ext = externalConvId(aid);
  const { body } = await getJson(`${shim.url}/v1/conversations/${ext}/messages`);
  const arr = body as Array<{ message_type: string; content: string; otid: string }>;
  assert.equal(arr.length, 1);
  const m = arr[0]!;
  assert.equal(m.message_type, "assistant_message");
  assert.equal(m.content, "result is 42");
  assert.equal(m.otid, "ui-msg-asst");
});

test("conversation external-id translation: conv-default-{A} resolves; bare literal `default` does NOT", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, { id: "agent-resolve-001" });
  seedConversation(shim.stateDir, aid);
  seedMessage(shim.stateDir, aid, "default", { id: "rid-1", role: "user", content: "x" });

  // External-id form: conv-default-{agentId} — matches the regex branch of resolveConversationId.
  const viaExt = await getJson(`${shim.url}/v1/conversations/conv-default-${aid}/messages`);
  const viaExtArr = viaExt.body as unknown[];
  assert.equal(viaExt.res.status, 200);
  assert.equal(viaExtArr.length, 1);

  // Bare literal "default" is ambiguous on /v1/conversations/* (every agent
  // has one) — the resolver refuses to disk-scan it to avoid mis-routing
  // on a multi-agent backend. handleConversationMessagesList returns a
  // mobile-friendly 200-empty rather than 404 for unresolved ids.
  const viaDefault = await getJson(`${shim.url}/v1/conversations/default/messages`);
  const viaDefaultArr = viaDefault.body as unknown[];
  assert.equal(viaDefault.res.status, 200);
  assert.equal(viaDefaultArr.length, 0, "literal `default` must NOT resolve via disk-scan");
});

test("multi-agent default disambiguation: bare literal `default` doesn't disk-scan to the wrong agent", async (t) => {
  // The disk-scan hazard: with two agents seeded, the old resolver returned
  // whichever default it encountered first — silently routing reads to the
  // wrong agent. Now it returns null, and the messages endpoint returns
  // 200-empty rather than leaking another agent's messages.
  const shim = await startShim();
  t.after(() => shim.stop());

  const aA = seedAgent(shim.stateDir, { id: "agent-multi-resolve-a" });
  const aB = seedAgent(shim.stateDir, { id: "agent-multi-resolve-b" });
  seedConversation(shim.stateDir, aA);
  seedConversation(shim.stateDir, aB);
  seedMessage(shim.stateDir, aA, "default", { id: "a-msg-1", role: "user", content: "A's prior" });
  seedMessage(shim.stateDir, aB, "default", { id: "b-msg-1", role: "user", content: "B's prior" });

  // Each external id resolves to its agent's messages exactly.
  const viaA = await getJson(`${shim.url}/v1/conversations/conv-default-${aA}/messages`);
  const viaB = await getJson(`${shim.url}/v1/conversations/conv-default-${aB}/messages`);
  const viaAArr = viaA.body as Array<{ content: string }>;
  const viaBArr = viaB.body as Array<{ content: string }>;
  assert.equal(viaAArr.length, 1);
  assert.equal(viaBArr.length, 1);
  assert.equal(viaAArr[0]!.content, "A's prior");
  assert.equal(viaBArr[0]!.content, "B's prior");

  // Bare literal "default" → 200 empty, never leaks either agent's messages.
  const viaDefault = await getJson(`${shim.url}/v1/conversations/default/messages`);
  const viaDefaultArr = viaDefault.body as unknown[];
  assert.equal(viaDefault.res.status, 200);
  assert.equal(viaDefaultArr.length, 0, "literal `default` must not leak any agent's messages");
});

// ── conversation create (POST) ─────────────────────────────────────

test("POST /v1/conversations creates and returns the conversation", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, { id: "agent-conv-create" });

  const res = await fetch(`${shim.url}/v1/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: aid }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as {
    id: string;
    agent_id: string;
    in_context_message_ids: unknown[];
  };
  assert.ok(body.id);
  assert.equal(body.agent_id, aid);
  assert.ok(Array.isArray(body.in_context_message_ids));

  // It should now show up in the list.
  const list = await getJson(`${shim.url}/v1/conversations`);
  const listArr = list.body as Array<{ id: string }>;
  const ids = listArr.map((c) => c.id);
  assert.ok(ids.includes(body.id), `created conv ${body.id} should be listed (got ${ids})`);
});

test("POST /v1/conversations without agent_id returns 400", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const res = await fetch(`${shim.url}/v1/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { detail: string };
  assert.equal(typeof body.detail, "string");
});

// ── models / providers / tools ─────────────────────────────────────

test("GET /v1/models returns non-empty list with handle/model_endpoint_type", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/models`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body));
  const arr = body as Array<{ handle: string; model_endpoint_type: string; model_type: string }>;
  assert.ok(arr.length > 0, "should expose at least one model");
  for (const m of arr) {
    assert.equal(typeof m.handle, "string");
    assert.equal(m.model_endpoint_type, "openai");
    assert.equal(m.model_type, "llm");
  }
});

test("GET /v1/providers returns at least one provider with required fields", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/providers`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body));
  const arr = body as Array<{ id: string; name: string; provider_type: string }>;
  assert.ok(arr.length >= 1);
  assert.equal(typeof arr[0]!.id, "string");
  assert.equal(typeof arr[0]!.name, "string");
  assert.equal(typeof arr[0]!.provider_type, "string");
});

test("GET /v1/tools returns the builtin tool definitions", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/tools`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body));
  const arr = body as Array<{
    id: string;
    name: string;
    json_schema: object;
    tool_type: string;
  }>;
  assert.ok(arr.length > 0);
  const names = arr.map((t) => t.name);
  for (const expected of ["Bash", "Read", "Write", "Edit"]) {
    assert.ok(names.includes(expected), `tool list should include ${expected}`);
  }
  // Each tool has the vanilla shape
  for (const t of arr) {
    assert.match(t.id, /^tool-/);
    assert.equal(typeof t.json_schema, "object");
    assert.equal(t.tool_type, "custom");
  }
});

test("GET /v1/tools/{tool_id} returns the matching builtin", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const list = await getJson(`${shim.url}/v1/tools`);
  const listArr = list.body as Array<{ id: string; name: string }>;
  const bash = listArr.find((it) => it.name === "Bash");
  assert.ok(bash, "Bash must be in the list");

  const { res, body } = await getJson(`${shim.url}/v1/tools/${bash.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(body, bash);
});

test("GET /v1/tools/{tool_id} returns 404 for an unknown id", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/tools/tool-doesnotexist`);
  const b = body as { detail: string };
  assert.equal(res.status, 404);
  assert.match(b.detail, /tool tool-doesnotexist/);
});

// ── messages search ────────────────────────────────────────────────

test("POST /v1/messages/search returns { messages: [] }", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const res = await fetch(`${shim.url}/v1/messages/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "anything" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { messages: [] });
});

// ── stub list/count endpoints ─────────────────────────────────────

test("stub endpoints return [] and /count returns 0", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const stubLists = [
    "/v1/folders",
    "/v1/groups",
    "/v1/identities",
    "/v1/mcp-servers",
    "/v1/jobs",
    "/v1/steps",
    "/v1/archives",
  ];
  for (const pn of stubLists) {
    const { res, body } = await getJson(`${shim.url}${pn}`);
    assert.equal(res.status, 200, `${pn} should be 200`);
    assert.deepEqual(body, [], `${pn} should be []`);
  }

  const stubCounts = [
    "/v1/folders/count",
    "/v1/groups/count",
    "/v1/identities/count",
    "/v1/mcp-servers/count",
    "/v1/jobs/count",
    "/v1/steps/count",
    "/v1/archives/count",
    "/v1/blocks/count",
  ];
  for (const pn of stubCounts) {
    const { res, body } = await getJson(`${shim.url}${pn}`);
    assert.equal(res.status, 200, `${pn} should be 200`);
    assert.equal(body, 0, `${pn} should be 0`);
  }
});

test("stub list endpoints also accept trailing-slash form", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const { res, body } = await getJson(`${shim.url}/v1/folders/`);
  assert.equal(res.status, 200);
  assert.deepEqual(body, []);
});

// ── system-prompt + blocks projection (issue 17) ───────────────────

test("agent record exposes system from agent record and blocks from memfs", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, {
    id: "agent-sysprompt-001",
    systemPrompt: "You are a strict reviewer.",
    blocks: {
      persona: "I am a strict reviewer.",
      human: "User is a developer.",
      project: "Project: admin-shim.",
    },
  });
  seedConversation(shim.stateDir, aid);

  const { res, body } = await getJson(`${shim.url}/v1/agents/${aid}`);
  const b = body as {
    system: string;
    memory: { blocks: Array<{ label: string; value: string }> };
  };
  assert.equal(res.status, 200);
  // system from the agent record
  assert.equal(b.system, "You are a strict reviewer.");
  // memory.blocks contains all three labels with correct values
  const byLabel = Object.fromEntries(b.memory.blocks.map((bl) => [bl.label, bl]));
  assert.equal(byLabel["persona"]!.value, "I am a strict reviewer.");
  assert.equal(byLabel["human"]!.value, "User is a developer.");
  assert.equal(byLabel["project"]!.value, "Project: admin-shim.");
});

// ── method-not-allowed / unknown paths ──────────────────────────────

test("unknown path returns 404 with { detail } describing the request", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const res = await fetch(`${shim.url}/v1/totally-bogus-endpoint`);
  assert.equal(res.status, 404);
  const body = await res.json() as { detail: string };
  assert.equal(typeof body.detail, "string");
  assert.match(body.detail, /totally-bogus-endpoint/);
});

test("DELETE on /v1/agents falls through to 404 (no DELETE route defined)", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const res = await fetch(`${shim.url}/v1/agents`, { method: "DELETE" });
  assert.equal(res.status, 404);
  const body = await res.json() as { detail: string };
  assert.equal(typeof body.detail, "string");
  assert.match(body.detail, /DELETE/);
});

// ── runs (real implementation; without any runs created) ────────────

test("GET /v1/runs returns [] and /v1/runs/count returns 0 when no runs", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const list = await getJson(`${shim.url}/v1/runs`);
  assert.equal(list.res.status, 200);
  assert.deepEqual(list.body, []);

  const count = await getJson(`${shim.url}/v1/runs/count`);
  assert.equal(count.res.status, 200);
  assert.equal(count.body, 0);
});

// ─── lcp-0xm: messages.jsonl schema migration (parts ↔ content) ─────

// Write a raw record into messages.jsonl using a caller-supplied shape.
// Bypasses seedMessage's "parts"-only path so we can simulate
// post-migration records (content-only) AND mixed legacy + new files.
function appendRawMessageRecord(
  stateDir: string,
  agentId: string,
  conversationId: string,
  record: Record<string, unknown>,
): void {
  const key = conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
  // Match the b64url helper in lib/store.ts (Buffer.from(...).toString("base64url")).
  const b64 = Buffer.from(key).toString("base64url");
  const path = join(stateDir, "conversations", b64, "messages.jsonl");
  appendFileSync(path, JSON.stringify(record) + "\n");
}

test("lcp-0xm: post-migration records with `content` (no `parts`) are read and projected", async (t) => {
  // letta local-backend migrate-transcripts renamed the per-record text
  // payload from `parts` -> `content`. The shim's listMessages used to
  // require `parts` and silently dropped every migrated record, hiding
  // entire conversation histories. Regression: ensure a content-only
  // record is read, normalized, and projected with the same text body
  // a legacy parts-only record would produce.
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, { id: "agent-schema-0xm" });
  seedConversation(shim.stateDir, aid);
  // Legacy shape via seedMessage (parts).
  seedMessage(shim.stateDir, aid, "default", {
    id: "ui-msg-legacy-1",
    role: "user",
    content: "typed via parts",
    sourceMessageIndex: 0,
  });
  // New shape: content array, no parts. Same element schema.
  appendRawMessageRecord(shim.stateDir, aid, "default", {
    id: "ui-msg-migrated-1",
    role: "user",
    content: [{ type: "text", text: "typed via content" }],
    metadata: {
      created_at: "2026-01-01T00:00:02.000Z",
      updated_at: "2026-01-01T00:00:02.000Z",
      agent_id: aid,
      conversation_id: "default",
    },
    timestamp: 1735689602000,
  });

  const ext = externalConvId(aid);
  const { res, body } = await getJson(`${shim.url}/v1/conversations/${ext}/messages`);
  assert.equal(res.status, 200);
  const arr = body as Array<{ id: string; content: string; message_type: string }>;
  // Both records must come through.
  assert.equal(arr.length, 2, `both legacy + migrated records must list; got: ${arr.map((m) => m.id).join(",")}`);
  const byId = new Map(arr.map((m) => [m.id, m]));
  assert.equal(byId.get("ui-msg-legacy-1")?.content, "typed via parts");
  assert.equal(byId.get("ui-msg-migrated-1")?.content, "typed via content",
    "post-migration record must project its text body");
  // message_type derived from role works identically for both shapes.
  assert.equal(byId.get("ui-msg-migrated-1")?.message_type, "user_message");
});

test("lcp-0xm: malformed record (neither parts nor content) is filtered out", async (t) => {
  // The isLocalMessage filter still rejects records that have neither
  // `parts` nor `content`. That guards against truly garbage lines —
  // we don't want a partial file to wedge the messages endpoint.
  const shim = await startShim();
  t.after(() => shim.stop());

  const aid = seedAgent(shim.stateDir, { id: "agent-schema-bad" });
  seedConversation(shim.stateDir, aid);
  seedMessage(shim.stateDir, aid, "default", {
    id: "ui-msg-ok",
    role: "user",
    content: "valid",
    sourceMessageIndex: 0,
  });
  // No parts, no content — should be dropped.
  appendRawMessageRecord(shim.stateDir, aid, "default", {
    id: "ui-msg-bad",
    role: "user",
    metadata: { created_at: "2026-01-01T00:00:02.000Z" },
  });

  const ext = externalConvId(aid);
  const { res, body } = await getJson(`${shim.url}/v1/conversations/${ext}/messages`);
  assert.equal(res.status, 200);
  const arr = body as Array<{ id: string }>;
  assert.equal(arr.length, 1);
  assert.equal(arr[0]!.id, "ui-msg-ok");
});
