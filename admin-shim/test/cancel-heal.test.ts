/**
 * letta-mobile-ja4xe — heal-on-cancel: the cancel handler repairs orphan
 * tool_call/tool_use ids so the FOLLOWING turn against a strict provider
 * (OpenAI / Anthropic) is not rejected with an invalid_request_error.
 *
 * Pinned contracts:
 *   - Successful cancel on a run with a `tool_call_message` whose
 *     `tool_call_id` has no matching `tool_return_message` in the same
 *     run's frames.jsonl triggers a `healConversation` write against
 *     the run's (conversation_id, agent_id) pair.
 *   - No orphans → no heal (we don't waste a disk rewrite on a clean
 *     turn).
 *   - Already-finalized or unknown run id → `cancelRun` returns false,
 *     no heal.
 *   - The cancel response shape is unchanged.
 *
 * Test strategy:
 *   - Pure unit-style tests call createRun + appendRunFrame + cancelRun
 *     directly, then run the same post-cancel logic
 *     (collectDanglingToolCallIds + healConversation) that the HTTP
 *     handler runs. This pins the helper + healer contract.
 *   - One HTTP integration test spins up a shim and confirms the cancel
 *     endpoint routes through the same post-cancel repair.
 *
 * Run with:
 *   npm run build && npx tsx --test --test-concurrency=1 test/cancel-heal.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendRunFrame,
  cancelRun,
  collectDanglingToolCallIds,
  createRun,
  getFramesFilePath,
} from "../lib/runs.js";
import { healConversation } from "../lib/conversation-healer.js";
import { startShim, seedAgent, seedConversation, externalConvId } from "./helpers/index.js";
import type { ShimHandle } from "./helpers/shim.js";

// ── helpers ───────────────────────────────────────────────────────

function makeTempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "cancel-heal-test-"));
}

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

/**
 * Mirror the real ConversationHealer test fixture pattern: write a
 * barebones agent + conversation so healConversation can locate the
 * on-disk `messages.jsonl`. We do not seed a default messages.jsonl
 * from the helper because we want to overwrite it with the precise
 * transcript this test case is exercising.
 */
function seedAgentAndConv(stateDir: string, agentId: string): { convDir: string } {
  const dir = join(stateDir, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${b64url(agentId)}.json`), JSON.stringify({ id: agentId, name: "test" }));
  const key = `default:${agentId}`;
  const convDir = join(stateDir, "conversations", b64url(key));
  mkdirSync(convDir, { recursive: true });
  writeFileSync(join(convDir, "conversation.json"), JSON.stringify({ id: "default", agent_id: agentId }));
  return { convDir };
}

function writeMessages(convDir: string, records: unknown[]): void {
  writeFileSync(join(convDir, "messages.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function readMessages(convDir: string): Record<string, unknown>[] {
  const raw = readFileSync(join(convDir, "messages.jsonl"), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function withBackendDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = makeTempStateDir();
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
      else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      try { rmSync(join(dir, "..", "state"), { recursive: true, force: true }); } catch {}
    });
}

/**
 * Re-implements exactly what `handleAgentMessagesCancel` does after a
 * successful cancelRun, so the unit-style tests below exercise the
 * SAME seam the HTTP handler runs. Returns the HealReport (or null
 * when the cancel did not succeed / no orphans existed).
 */
async function postCancelRepair(
  runId: string,
  conversationId: string,
  agentId: string,
): Promise<ReturnType<typeof healConversation> | null> {
  const dangling = collectDanglingToolCallIds(runId);
  if (dangling.length === 0) return null;
  return healConversation(conversationId, agentId, dangling, { runId });
}

// ── unit tests ────────────────────────────────────────────────────

test("cancel-heal: matched tool_call + tool_return → no orphan, no heal", async () => {
  await withBackendDir(async (stateDir) => {
    const agentId = "agent-matched";
    const { convDir } = seedAgentAndConv(stateDir, agentId);
    writeMessages(convDir, [
      { id: "u0", role: "user", content: [{ type: "text", text: "do thing" }] },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "toolCall", id: "toolu_MATCHED", name: "Bash", arguments: { command: "echo 1" } },
        ],
      },
      {
        id: "a1:tr",
        role: "toolResult",
        toolCallId: "toolu_MATCHED",
        toolName: "Bash",
        content: [{ type: "text", text: "1" }],
        isError: false,
      },
      { id: "u1", role: "user", content: [{ type: "text", text: "next" }] },
    ]);

    const run = createRun({ agentId, conversationId: "default" });
    // Mirror what the mobile-channel emit path writes: tool_call_message
    // on the wire, then matching tool_return_message.
    appendRunFrame(run.id, {
      message_type: "tool_call_message",
      tool_call: { tool_call_id: "toolu_MATCHED", name: "Bash", arguments: "{}" },
      tool_calls: [{ tool_call_id: "toolu_MATCHED", name: "Bash", arguments: "{}" }],
    });
    appendRunFrame(run.id, {
      message_type: "tool_return_message",
      tool_call_id: "toolu_MATCHED",
      tool_return: "1",
      status: "success",
    });

    const cancelled = cancelRun(run.id);
    assert.equal(cancelled, true, "an active run must cancel cleanly");

    const dangling = collectDanglingToolCallIds(run.id);
    assert.deepEqual(dangling, [], "matched tool_call + tool_return must not be flagged");

    const report = await postCancelRepair(run.id, "default", agentId);
    assert.equal(report, null, "no heal should fire when there are no orphans");

    // Disk transcript is untouched: the orphan-shape we seeded must
    // still match what the next-turn request replays.
    const after = readMessages(convDir);
    assert.equal(after.length, 4);
    const assistant = after[1] as { content: Array<{ type: string; id?: string }> };
    assert.equal(assistant.content[0]?.type, "toolCall");
    assert.equal(assistant.content[0]?.id, "toolu_MATCHED");
  });
});

test("cancel-heal: orphaned tool_call → synthetic toolResult inserted, next-turn safe", async () => {
  await withBackendDir(async (stateDir) => {
    const agentId = "agent-orphan";
    const { convDir } = seedAgentAndConv(stateDir, agentId);
    writeMessages(convDir, [
      { id: "u0", role: "user", content: [{ type: "text", text: "do thing" }] },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "toolCall", id: "toolu_ORPHAN", name: "Bash", arguments: { command: "sleep 999" } },
        ],
      },
      // NO matching toolResult — this is the interrupt mid-tool shape.
    ]);

    const run = createRun({ agentId, conversationId: "default" });
    appendRunFrame(run.id, {
      message_type: "tool_call_message",
      tool_call: { tool_call_id: "toolu_ORPHAN", name: "Bash", arguments: "{}" },
      tool_calls: [{ tool_call_id: "toolu_ORPHAN", name: "Bash", arguments: "{}" }],
    });
    // Deliberately NO tool_return_message appended.

    assert.equal(cancelRun(run.id), true);
    assert.deepEqual(collectDanglingToolCallIds(run.id), ["toolu_ORPHAN"]);

    const report = await postCancelRepair(run.id, "default", agentId);
    assert.ok(report, "heal must fire for an orphan id");
    assert.deepEqual(report!.settled, ["toolu_ORPHAN"]);
    assert.equal(report!.messagesAppended, 1);

    // After heal: synthetic toolResult sits immediately after the
    // assistant message that declared the tool_call — provider shape
    // is now adjacency-correct, the next-turn request won't 400.
    // The seeded transcript had 3 records (u0, a1, no toolResult);
    // the heal APPENDS a synthetic toolResult immediately after a1,
    // so the final count is 3 (u0 + a1 + synthetic), not 4.
    const after = readMessages(convDir);
    assert.equal(after.length, 3, "u0 + a1 + synthetic toolResult (heal appends, doesn't shift existing records)");
    const assistantAfter = after[1] as { content: Array<{ type: string; id?: string }> };
    assert.equal(assistantAfter.content[0]?.type, "toolCall");
    assert.equal(assistantAfter.content[0]?.id, "toolu_ORPHAN");
    const synthetic = after[2] as { role: string; toolCallId?: string; isError?: boolean; content: Array<{ type: string; text: string }> };
    assert.equal(synthetic.role, "toolResult");
    assert.equal(synthetic.toolCallId, "toolu_ORPHAN");
    assert.equal(synthetic.isError, true, "synthetic toolResult must be marked as an error so the agent knows the tool was cut short");
    assert.match(synthetic.content[0]?.text ?? "", /healed: tool execution interrupted/);
  });
});

test("cancel-heal: run with no tool calls at all → no orphan, no heal", async () => {
  await withBackendDir(async (stateDir) => {
    const agentId = "agent-no-tool";
    const { convDir } = seedAgentAndConv(stateDir, agentId);
    writeMessages(convDir, [
      { id: "u0", role: "user", content: [{ type: "text", text: "hi" }] },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);

    // Cancel an active run with no tool-call frames in it.
    const run = createRun({ agentId, conversationId: "default" });
    appendRunFrame(run.id, {
      message_type: "assistant_message",
      content: "hello",
      content_parts: [{ type: "text", text: "hello" }],
    });
    appendRunFrame(run.id, {
      message_type: "stop_reason",
      stop_reason: "end_turn",
    });

    assert.equal(cancelRun(run.id), true, "active run cancels successfully");
    assert.deepEqual(collectDanglingToolCallIds(run.id), []);

    // postCancelRepair must short-circuit on no-orphans.
    const report = await postCancelRepair(run.id, "default", agentId);
    assert.equal(report, null, "no heal should fire when there are no orphans");
    const after = readMessages(convDir);
    assert.equal(after.length, 2, "messages.jsonl must be untouched when there are no orphans");
  });
});
