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
  detectDanglingToolUses,
  healConversation,
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

test("healConversation: appends synthetic toolResult when none exists for the dangling id", async () => {
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
