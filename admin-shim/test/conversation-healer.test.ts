/**
 * lcp-ezv — auto-heal corrupt conversation transcripts.
 *
 * Tests both detection and surgical repair against a seeded on-disk
 * transcript matching the real-world failure mode observed on Meridian's
 * `default` conversation during lcp-sdk.9 smoke (toolu_012g7d... +
 * toolu_01CenN... + toolu_01XMc... reported as dangling by Anthropic's
 * API even though matching toolResult records existed on disk — letta-
 * code's serializer dropped them from the API request).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  detectConsecutiveUserMessageIndices,
  detectDanglingToolUses,
  detectRoleAlternationViolation,
  detectUnexpectedToolResults,
  healConsecutiveUserMessages,
  healConversation,
  healUnexpectedToolResults,
  allIdsHaveToolResults,
} from "../lib/conversation-healer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// b64url("default:agent-X") — same encoder the shim uses. Inlined so the
// test doesn't depend on the store's internal b64url helper.
function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function makeTempStateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "healer-test-"));
  return d;
}

function seedAgent(stateDir: string, agentId: string): void {
  const path = join(stateDir, "agents", `${b64url(agentId)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ id: agentId, name: "test" }));
}

function seedConv(stateDir: string, conv: string, agent: string): string {
  const key = conv === "default" ? `default:${agent}` : `conversation:${conv}`;
  const dir = join(stateDir, "conversations", b64url(key));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "conversation.json"), JSON.stringify({ id: conv, agent_id: agent }));
  writeFileSync(join(dir, "messages.jsonl"), "");
  return dir;
}

function writeMessages(convDir: string, records: unknown[]): void {
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(convDir, "messages.jsonl"), body);
}

function readMessages(convDir: string): Record<string, unknown>[] {
  const raw = readFileSync(join(convDir, "messages.jsonl"), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── Detection ──────────────────────────────────────────────────────────

test("detectDanglingToolUses: pulls ids from the Anthropic error string", () => {
  const detail = `messages.1: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: toolu_012g7dKvXhGe8CvUzjNt91v5, toolu_01CenNjhrcaXnB18vkBbg7j6, toolu_01XMcxfHyapo1qJgYnd5CBCR. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`;
  const ids = detectDanglingToolUses(detail);
  assert.deepEqual(ids, [
    "toolu_012g7dKvXhGe8CvUzjNt91v5",
    "toolu_01CenNjhrcaXnB18vkBbg7j6",
    "toolu_01XMcxfHyapo1qJgYnd5CBCR",
  ]);
});

test("detectDanglingToolUses: handles the nested {api_error:{detail:...}} wire shape", () => {
  const wire = {
    type: "error",
    message: JSON.stringify({ error: { type: "invalid_request_error", message: "messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_abc, toolu_def" } }),
    api_error: {
      detail: JSON.stringify({ error: { message: "messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_abc, toolu_def" } }),
    },
  };
  assert.deepEqual(detectDanglingToolUses(wire), ["toolu_abc", "toolu_def"]);
});

test("detectDanglingToolUses: pulls OpenAI call ids from role tool adjacency errors", () => {
  const detail = "Invalid parameter: messages with role 'tool' must be a response to a preceding message with 'tool_calls'. Missing tool_call_id call_abc123 and call_def456.";
  assert.deepEqual(detectDanglingToolUses({ error: { message: detail } }), ["call_abc123", "call_def456"]);
});

test("detectDanglingToolUses: returns [] for unrelated errors", () => {
  assert.deepEqual(detectDanglingToolUses("rate limited; try again later"), []);
  assert.deepEqual(detectDanglingToolUses({ message: "context window exceeded" }), []);
  assert.deepEqual(detectDanglingToolUses(null), []);
  assert.deepEqual(detectDanglingToolUses(undefined), []);
});

test("detectDanglingToolUses: dedupes ids that appear twice in the error text", () => {
  const detail = "tool_use ids without tool_result after: toolu_X, toolu_Y. Each tool_use (toolu_X, toolu_Y) needs a result.";
  // The current implementation only scans after the first "after:" colon,
  // so the second sentence's IDs are picked up too (still post-colon) and
  // get deduped.
  assert.deepEqual(detectDanglingToolUses(detail), ["toolu_X", "toolu_Y"]);
});

test("detectRoleAlternationViolation: matches Anthropic role alternation errors", () => {
  assert.equal(
    detectRoleAlternationViolation({ message: "messages: roles must alternate between user and assistant" }),
    true,
  );
  assert.equal(detectRoleAlternationViolation("rate limited; try again later"), false);
});

test("detectUnexpectedToolResults: pulls ids from Anthropic unexpected tool_result errors", () => {
  const detail = "messages.1194.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_018HeuFFTYFRa5GiYWx8xfv1. Each `tool_result` block must have a corresponding `tool_use` block in the previous message.";
  assert.deepEqual(detectUnexpectedToolResults({ api_error: { detail } }), [
    "toolu_018HeuFFTYFRa5GiYWx8xfv1",
  ]);
});

test("detectUnexpectedToolResults: pulls OpenAI call ids from role tool errors", () => {
  const detail = "Invalid parameter: messages with role 'tool' must be a response to a preceding message with 'tool_calls'. Missing tool_call_id call_abc123 and call_def456.";
  assert.deepEqual(detectUnexpectedToolResults({ error: { message: detail } }), ["call_abc123", "call_def456"]);
});

test("detectConsecutiveUserMessageIndices: removes trailing user runs, keeps last as current input", () => {
  const records = [
    { id: "u0", role: "user" },
    { id: "a0", role: "assistant" },
    { id: "u1", role: "user" },
    { id: "u2", role: "user" },
    { id: "u3", role: "user" },
  ];
  assert.deepEqual(detectConsecutiveUserMessageIndices(records), [2, 3]);
});

test("detectConsecutiveUserMessageIndices: keeps latest user in an interior run", () => {
  const records = [
    { id: "u0", role: "user" },
    { id: "a0", role: "assistant" },
    { id: "u1", role: "user" },
    { id: "u2", role: "user" },
    { id: "a1", role: "assistant" },
  ];
  assert.deepEqual(detectConsecutiveUserMessageIndices(records), [2]);
});

test("detectConsecutiveUserMessageIndices: keeps sole trailing user as current input", () => {
  const records = [
    { id: "u0", role: "user" },
    { id: "a0", role: "assistant" },
    { id: "u1", role: "user" },
  ];
  assert.deepEqual(detectConsecutiveUserMessageIndices(records), []);
});

test("healConsecutiveUserMessages: removes trailing failed user messages and audits", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-consecutive-test";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "default", agentId);

    writeMessages(convDir, [
      { id: "u0", role: "user", content: [{ type: "text", text: "hello" }] },
      { id: "a0", role: "assistant", content: [{ type: "text", text: "hi" }] },
      { id: "u1", role: "user", content: [{ type: "text", text: "retry one" }] },
      { id: "u2", role: "user", content: [{ type: "text", text: "retry two" }] },
    ]);

    const report = await healConsecutiveUserMessages("default", agentId, {
      stateDir,
      runId: "run-consecutive-1",
      now: 1779500000000,
    });

    assert.deepEqual(report.removed, ["u1"]);
    assert.equal(report.messagesRemoved, 1);
    assert.deepEqual(
      readMessages(convDir).map((m) => m["id"]),
      ["u0", "a0", "u2"],
    );

    const auditPath = join(stateDir, "..", "state", "runs", "run-consecutive-1", "heal.jsonl");
    assert.ok(existsSync(auditPath), `expected audit sidecar at ${auditPath}`);
    const entry = JSON.parse(readFileSync(auditPath, "utf8").trim());
    assert.deepEqual(entry["removed"], ["u1"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});

// ── Heal: Meridian-shape case (toolResults exist on disk) ──────────────

test("healConversation: removes orphan tool_use when matching toolResult exists on disk", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-meridian-test";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "default", agentId);

    // Mirror the Meridian failure pattern: one assistant message with
    // 3 toolCall parts + 3 toolResult role records that follow.
    writeMessages(convDir, [
      { id: "u0", role: "user", content: [{ type: "text", text: "do three things" }] },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "Running three probes." },
          { type: "toolCall", id: "toolu_X", name: "Bash", arguments: { command: "echo 1" } },
          { type: "toolCall", id: "toolu_Y", name: "Bash", arguments: { command: "echo 2" } },
          { type: "toolCall", id: "toolu_Z", name: "Bash", arguments: { command: "echo 3" } },
          { type: "text", text: "Done with the probes." },
        ],
      },
      { id: "a1:tr:X", role: "toolResult", toolCallId: "toolu_X", toolName: "Bash", content: [{ type: "text", text: "1" }], isError: false },
      { id: "a1:tr:Y", role: "toolResult", toolCallId: "toolu_Y", toolName: "Bash", content: [{ type: "text", text: "2" }], isError: false },
      { id: "a1:tr:Z", role: "toolResult", toolCallId: "toolu_Z", toolName: "Bash", content: [{ type: "text", text: "3" }], isError: false },
      { id: "u1", role: "user", content: [{ type: "text", text: "next turn" }] },
    ]);

    const report = await healConversation("default", agentId, ["toolu_X", "toolu_Y", "toolu_Z"], {
      stateDir,
      runId: "run-test-1",
      now: 1779500000000,
    });

    assert.deepEqual(report.removed, ["toolu_X", "toolu_Y", "toolu_Z"], "all three IDs should be classified as removed (toolResults existed)");
    assert.deepEqual(report.settled, [], "no synthetic settlement when toolResults already on disk");
    assert.deepEqual(report.unresolved, []);
    assert.equal(report.messagesEdited, 1, "the single assistant message gets edited");
    assert.equal(report.messagesRemoved, 3, "all three toolResult records get dropped");
    assert.equal(report.messagesAppended, 0);

    // Verify the disk shape.
    const after = readMessages(convDir);
    assert.equal(after.length, 3, "u0 + edited a1 + u1");
    assert.equal((after[1] as { id: string }).id, "a1");
    const a1Content = (after[1] as { content: unknown[] }).content as Array<{ type: string; text?: string }>;
    // 5 original parts → 5 parts (toolCall replaced with text annotation).
    assert.equal(a1Content.length, 5);
    assert.equal(a1Content[0]?.type, "text");
    assert.equal(a1Content[1]?.type, "text");
    assert.match(a1Content[1]?.text ?? "", /healed: removed orphan tool call Bash \(id=toolu_X\)/);
    assert.equal(a1Content[2]?.type, "text");
    assert.match(a1Content[2]?.text ?? "", /healed:[^]+id=toolu_Y/);
    assert.equal(a1Content[3]?.type, "text");
    assert.match(a1Content[3]?.text ?? "", /healed:[^]+id=toolu_Z/);
    assert.equal(a1Content[4]?.text, "Done with the probes.");

    // Audit sidecar landed where lcp-ezv requires.
    const auditPath = join(stateDir, "..", "state", "runs", "run-test-1", "heal.jsonl");
    assert.ok(existsSync(auditPath), `expected audit sidecar at ${auditPath}`);
    const auditLines = readFileSync(auditPath, "utf8").split("\n").filter(Boolean);
    assert.equal(auditLines.length, 1);
    const entry = JSON.parse(auditLines[0]!);
    assert.equal(entry["conversation_id"], "default");
    assert.equal(entry["run_id"], "run-test-1");
    assert.deepEqual(entry["removed"], ["toolu_X", "toolu_Y", "toolu_Z"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});

// ── Heal: genuine interrupted-tool case (no toolResult on disk) ────────

test("healConversation: inserts synthetic toolResult immediately after its assistant tool call", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-interrupted-test";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "default", agentId);

    writeMessages(convDir, [
      { id: "u0", role: "user", content: [{ type: "text", text: "run a tool" }] },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "toolCall", id: "toolu_DROPPED", name: "Bash", arguments: { command: "sleep 999" } },
        ],
      },
      // NO matching toolResult — simulates SIGTERM mid-tool.
    ]);

    const report = await healConversation("default", agentId, ["toolu_DROPPED"], {
      stateDir,
      now: 1779500000000,
    });

    assert.deepEqual(report.settled, ["toolu_DROPPED"]);
    assert.deepEqual(report.removed, []);
    assert.equal(report.messagesAppended, 1);
    assert.equal(report.messagesEdited, 0);
    assert.equal(report.messagesRemoved, 0);

    const after = readMessages(convDir);
    assert.equal(after.length, 3, "u0 + a1 + synthetic toolResult");
    assert.equal(after[1]?.["id"], "a1");
    const synth = after[2] as Record<string, unknown>;
    assert.equal(synth["role"], "toolResult");
    assert.equal(synth["toolCallId"], "toolu_DROPPED");
    assert.equal(synth["toolName"], "Bash");
    assert.equal(synth["isError"], true);
    const content = synth["content"] as Array<{ text: string }>;
    assert.match(content[0]?.text ?? "", /healed: tool execution interrupted/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});

test("healConversation: repositions stale synthetic results after OpenAI tool_calls parents", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-openai-reposition-test";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "default", agentId);

    writeMessages(convDir, [
      { id: "u0", role: "user", content: [{ type: "text", text: "run tool" }] },
      {
        id: "a1",
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_OPENAI", type: "function", function: { name: "Bash", arguments: "{}" } }],
      },
      { id: "u1", role: "user", content: [{ type: "text", text: "stale interleaving" }] },
      { id: "a1:heal-tool-result:call_OPENAI", role: "tool", tool_call_id: "call_OPENAI", content: "old synthetic result" },
    ]);

    const report = await healConversation("default", agentId, ["call_OPENAI"], {
      stateDir,
      now: 1779500000000,
    });

    assert.deepEqual(report.settled, ["call_OPENAI"]);
    assert.equal(report.messagesAppended, 1);
    assert.equal(report.messagesRemoved, 1);

    const after = readMessages(convDir);
    assert.deepEqual(after.map((m) => m["id"]), ["u0", "a1", "a1:heal-tool-result:call_OPENAI", "u1"]);
    assert.equal(after[2]?.["role"], "toolResult");
    assert.equal(after[2]?.["toolCallId"], "call_OPENAI");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});

test("healConversation: second pass after OpenAI reposition is byte-identical no-op", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-openai-idempotent-test";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "default", agentId);

    writeMessages(convDir, [
      { id: "u0", role: "user", content: "run tool" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_IDEM", type: "function", function: { name: "Bash", arguments: "{}" } }],
      },
      { id: "u1", role: "user", content: "interleaved" },
      { id: "heal-call_IDEM", role: "tool", tool_call_id: "call_IDEM", content: "old synthetic result" },
    ]);

    await healConversation("default", agentId, ["call_IDEM"], { stateDir, now: 1779500000000 });
    const once = readFileSync(join(convDir, "messages.jsonl"), "utf8");
    const r2 = await healConversation("default", agentId, ["call_IDEM"], { stateDir, now: 1779500000000 });
    const twice = readFileSync(join(convDir, "messages.jsonl"), "utf8");

    assert.deepEqual(r2.settled, []);
    assert.deepEqual(r2.removed, []);
    assert.deepEqual(r2.unresolved, []);
    assert.equal(twice, once);
    const after = readMessages(convDir);
    assert.equal(after[1]?.["id"], "a1");
    assert.equal(after[2]?.["toolCallId"], "call_IDEM");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});

test("healConversation: healed OpenAI transcript has zero tool adjacency violations", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-openai-e2e-test";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "default", agentId);

    writeMessages(convDir, [
      { id: "u0", role: "user", content: "run tools" },
      { id: "a1", role: "assistant", content: "", tool_calls: [{ id: "call_A", type: "function", function: { name: "Bash", arguments: "{}" } }] },
      { id: "u1", role: "user", content: "next" },
      { id: "heal-call_A", role: "tool", tool_call_id: "call_A", content: "misplaced synth" },
      { id: "a2", role: "assistant", content: "", tool_calls: [{ id: "call_B", type: "function", function: { name: "Edit", arguments: "{}" } }] },
    ]);

    await healConversation("default", agentId, ["call_A", "call_B"], { stateDir, now: 1779500000000 });
    const after = readMessages(convDir);
    const violations = after.flatMap((message, index) => {
      if (message["role"] !== "toolResult" && message["role"] !== "tool") return [];
      const toolCallId = message["toolCallId"] ?? message["tool_call_id"];
      const previous = after[index - 1];
      const calls = Array.isArray(previous?.["tool_calls"]) ? previous["tool_calls"] as Array<Record<string, unknown>> : [];
      const content = Array.isArray(previous?.["content"]) ? previous["content"] as Array<Record<string, unknown>> : [];
      const previousIds = [...calls.map((call) => call["id"]), ...content.filter((part) => part["type"] === "toolCall").map((part) => part["id"])];
      return previous?.["role"] === "assistant" && previousIds.includes(toolCallId) ? [] : [toolCallId];
    });

    assert.deepEqual(violations, []);
    assert.deepEqual(after.map((m) => m["id"]), ["u0", "a1", "a1:heal-tool-result:call_A", "u1", "a2", "a2:heal-tool-result:call_B"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});

test("healUnexpectedToolResults: removes truly orphaned OpenAI role tool messages", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-openai-orphan-tool-test";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "default", agentId);

    writeMessages(convDir, [
      { id: "u0", role: "user", content: "hello" },
      { id: "orphan-tool", role: "tool", tool_call_id: "call_ORPHAN", content: "orphaned" },
      { id: "u1", role: "user", content: "next" },
    ]);

    const report = await healUnexpectedToolResults("default", agentId, ["call_ORPHAN"], { stateDir });

    assert.deepEqual(report.removed, ["call_ORPHAN"]);
    assert.equal(report.messagesEdited, 0);
    assert.equal(report.messagesRemoved, 1);
    assert.deepEqual(readMessages(convDir).map((m) => m["id"]), ["u0", "u1"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});

test("healUnexpectedToolResults: removes stale toolResult records by toolCallId", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-unexpected-tool-result-test";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "default", agentId);

    writeMessages(convDir, [
      { id: "u0", role: "user", content: [{ type: "text", text: "hello" }] },
      { id: "a0", role: "assistant", content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "toolu_stale", name: "Bash", arguments: {} }] },
      { id: "stale-tool-result", role: "toolResult", toolCallId: "toolu_stale", toolName: "Bash", content: [{ type: "text", text: "old result" }] },
      { id: "u1", role: "user", content: [{ type: "text", text: "next" }] },
    ]);

    const report = await healUnexpectedToolResults("default", agentId, ["toolu_stale"], {
      stateDir,
      runId: "run-unexpected-tool-result-1",
      now: 1779500000000,
    });

    assert.deepEqual(report.removed, ["toolu_stale"]);
    assert.equal(report.messagesEdited, 1);
    assert.equal(report.messagesRemoved, 1);
    assert.deepEqual(
      readMessages(convDir).map((m) => m["id"]),
      ["u0", "a0", "u1"],
    );
    const assistant = readMessages(convDir)[1] as { content: Array<{ type: string; text?: string }> };
    assert.match(assistant.content[1]?.text ?? "", /removed stale tool call Bash/);

    const auditPath = join(stateDir, "..", "state", "runs", "run-unexpected-tool-result-1", "heal.jsonl");
    assert.ok(existsSync(auditPath), `expected audit sidecar at ${auditPath}`);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});

test("healUnexpectedToolResults: handles letta-code envelope records", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-envelope-tool-result-test";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "conv-envelope", agentId);

    writeMessages(convDir, [
      { type: "message", id: "env-u0", message: { id: "u0", role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "message", id: "env-a0", message: { id: "a0", role: "assistant", content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "toolu_envelope", name: "Bash", arguments: {} }] } },
      { type: "message", id: "env-tr", message: { id: "tr", role: "toolResult", toolCallId: "toolu_envelope", toolName: "Bash", content: [{ type: "text", text: "old" }] } },
    ]);

    const report = await healUnexpectedToolResults("conv-envelope", agentId, ["toolu_envelope"], { stateDir });

    assert.deepEqual(report.removed, ["toolu_envelope"]);
    assert.deepEqual(
      readMessages(convDir).map((m) => m["id"]),
      ["env-u0", "env-a0"],
    );
    const assistant = readMessages(convDir)[1] as { message: { content: Array<{ type: string; text?: string }> } };
    assert.match(assistant.message.content[1]?.text ?? "", /removed stale tool call Bash/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});

// ── Heal: idempotency ──────────────────────────────────────────────────

test("healConversation: idempotent — second call with already-healed ids is a no-op", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-idem-test";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "default", agentId);
    writeMessages(convDir, [
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_X", name: "Bash", arguments: {} }],
      },
      { id: "a1:tr", role: "toolResult", toolCallId: "toolu_X", toolName: "Bash", content: [], isError: false },
    ]);

    const r1 = await healConversation("default", agentId, ["toolu_X"], { stateDir });
    assert.deepEqual(r1.removed, ["toolu_X"]);

    const r2 = await healConversation("default", agentId, ["toolu_X"], { stateDir });
    assert.deepEqual(r2.removed, []);
    assert.deepEqual(r2.unresolved, ["toolu_X"], "second call: id no longer on disk");
    assert.equal(r2.messagesEdited, 0);
    assert.equal(r2.messagesRemoved, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(stateDir, "..", "state"), { recursive: true, force: true });
  }
});

// ── allIdsHaveToolResults sanity check ─────────────────────────────────

test("allIdsHaveToolResults: true when every id has a matching result on disk", async () => {
  const stateDir = makeTempStateDir();
  try {
    const agentId = "agent-sanity";
    seedAgent(stateDir, agentId);
    const convDir = seedConv(stateDir, "default", agentId);
    writeMessages(convDir, [
      { id: "a1", role: "assistant", content: [{ type: "toolCall", id: "toolu_X", name: "Bash", arguments: {} }] },
      { id: "tr1", role: "toolResult", toolCallId: "toolu_X", toolName: "Bash", content: [] },
      { id: "tr2", role: "toolResult", toolCallId: "toolu_Y", toolName: "Bash", content: [] },
    ]);
    process.env["LETTA_LOCAL_BACKEND_DIR"] = stateDir;
    assert.equal(await allIdsHaveToolResults("default", agentId, ["toolu_X", "toolu_Y"]), true);
    assert.equal(await allIdsHaveToolResults("default", agentId, ["toolu_X", "toolu_MISSING"]), false);
  } finally {
    delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Reference to __dirname so the import isn't accidentally treeshaken; the
// file's location may be useful for future fixture-driven tests.
void __dirname;
