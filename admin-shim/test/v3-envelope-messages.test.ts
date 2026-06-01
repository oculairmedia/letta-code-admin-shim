/**
 * lcp-nlud: regression gate for letta-code's session-log v3 envelope format.
 *
 * letta-code 0.26.x writes each message to messages.jsonl wrapped in an
 * envelope row — `{ type: "message", id, parentId, timestamp, message: {
 * role, content, ... } }` — preceded by a `{ type: "session", version: 3 }`
 * header. The shim's `listMessages` previously only understood the legacy
 * flat shape (top-level `role`/`content`), so it dropped every v3 record.
 *
 * The user-visible failure: a conversation whose runs were interrupted
 * accumulated synthetic "settle" tool-returns (written FLAT by
 * turn-settlement). With every real v3 record filtered out, the endpoint
 * surfaced ONLY those settle frames — hiding the entire real history and
 * leaving mobile on a blank/spinning chat screen.
 *
 * These tests write a temp backend exactly like letta-code would and assert
 * `listMessages` surfaces the real history (and still drops the non-message
 * session header).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listMessages, _internals } from "../lib/store.js";

const CONV = "conv-16c2f589-a3f9-438c-bb63-75023a4785ea";
const AGENT = "agent-597b5756-2915-4560-ba6b-91005f085166";

function sessionHeader() {
  return { type: "session", version: 3, id: CONV, timestamp: "2026-05-25T03:43:12.060Z", cwd: "/tmp" };
}

function envelope(innerId: string, role: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: `env-${innerId}`,
    parentId: null,
    timestamp: "2026-05-25T03:43:15.472Z",
    message: {
      id: innerId,
      role,
      content: [{ type: "text", text }],
      metadata: { agent_id: AGENT, conversation_id: CONV },
      ...extra,
    },
  };
}

/** Flat synthetic settle record, exactly as turn-settlement.ts writes it. */
function synthSettle(runId: string, toolCallId: string) {
  return {
    id: `synth-settle:${runId}:${toolCallId}`,
    role: "toolResult",
    parts: [{ type: "text", text: "Tool execution interrupted by cancellation" }],
    content: [{ type: "text", text: "Tool execution interrupted by cancellation" }],
    toolCallId,
    toolName: "Bash",
    isError: true,
  };
}

function writeBackend(lines: unknown[]): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lcp-nlud-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  const key = `conversation:${CONV}`;
  const convDir = join(dir, "conversations", _internals.b64url(key));
  mkdirSync(convDir, { recursive: true });
  writeFileSync(join(convDir, "messages.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return {
    dir,
    restore: () => {
      if (prev !== undefined) process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
      else delete process.env["LETTA_LOCAL_BACKEND_DIR"];
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("listMessages surfaces v3-envelope history, not just flat settle frames", async () => {
  const { restore } = writeBackend([
    sessionHeader(),
    envelope("ui-msg-1", "user", "hello"),
    envelope("ui-msg-2", "assistant", "hi there"),
    envelope("ui-msg-3", "toolResult", "ok", { toolCallId: "call-1", toolName: "Bash", isError: false }),
    // interrupted run left a dangling tool call that turn-settlement healed:
    synthSettle("run-abc", "call-2"),
  ]);
  try {
    const items = await listMessages(CONV, AGENT, {});
    const roles: Record<string, number> = {};
    for (const m of items) roles[m.role] = (roles[m.role] ?? 0) + 1;

    // The session header row is not a message and must be dropped.
    assert.equal(items.length, 4, `expected 4 messages, got ${items.length}`);
    assert.equal(roles["user"], 1);
    assert.equal(roles["assistant"], 1);
    assert.equal(roles["toolResult"], 2); // real toolResult + synth-settle
    // Inner ids (ui-msg-*), not envelope ids (env-*), so sidecars/run maps join.
    assert.deepEqual(
      items.map((m) => m.id),
      ["ui-msg-1", "ui-msg-2", "ui-msg-3", "synth-settle:run-abc:call-2"],
    );
    // content -> parts mapping applied to unwrapped records.
    assert.ok(Array.isArray(items[0]!.parts) && items[0]!.parts.length === 1);
  } finally {
    restore();
  }
});

test("limit/before windowing operates on unwrapped v3 records", async () => {
  const { restore } = writeBackend([
    sessionHeader(),
    envelope("ui-msg-1", "user", "a"),
    envelope("ui-msg-2", "assistant", "b"),
    envelope("ui-msg-3", "user", "c"),
    envelope("ui-msg-4", "assistant", "d"),
  ]);
  try {
    const last2 = await listMessages(CONV, AGENT, { limit: 2 });
    assert.deepEqual(last2.map((m) => m.id), ["ui-msg-3", "ui-msg-4"]);

    const beforeMsg3 = await listMessages(CONV, AGENT, { before: "ui-msg-3" });
    assert.deepEqual(beforeMsg3.map((m) => m.id), ["ui-msg-1", "ui-msg-2"]);
  } finally {
    restore();
  }
});
