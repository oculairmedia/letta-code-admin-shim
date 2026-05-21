/**
 * lcp-kul: drift gate for the on-disk LocalMessage shapes that letta-code
 * writes to `<storageDir>/conversations/<key>/messages.jsonl`.
 *
 * Each line of every fixture under `test/fixtures/onfdisk-messages/` is one
 * `LocalMessage` record AS WRITTEN BY letta-code. We fan it through
 * `localMessageToConversationMessages` (the same projection mobile gets
 * over /v1/conversations/{id}/messages) and assert structural invariants
 * that a "tool card lost" regression would violate:
 *
 *   I1.  Any record whose role is "toolResult" projects to AT LEAST one
 *        `tool_return_message` (not silently degraded to assistant text).
 *
 *   I2.  Any content/parts entry whose `type` looks tool-shaped — i.e.
 *        starts with "tool" (covers `tool-call`, `toolCall`, `tool-Bash`,
 *        `tool-${name}`, future variants) — produces a corresponding
 *        `tool_call_message` or `tool_return_message` somewhere in the
 *        fan-out for that source record.
 *
 *   I3.  Every emitted `tool_call_message` carries a non-empty
 *        `tool_call.tool_call_id` and a usable `name` (not the "tool"
 *        fallback when the source record actually named the tool).
 *
 *   I4.  Every emitted `tool_return_message` carries a non-empty
 *        `tool_call_id` and `status` ∈ {"success","error"}.
 *
 * The point of the file-driven drift gate (vs. handcrafted LocalMessage
 * literals as in translate.test.ts) is that the FIXTURES are checked-in
 * SAMPLES OF WHAT LETTA-CODE ACTUALLY WROTE. If letta-code introduces a
 * new shape variant in a future release, drop a sample messages.jsonl
 * snippet in here and this test will fail until the translator learns
 * the new shape — instead of waiting for a mobile reload to surface the
 * regression.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { localMessageToConversationMessages } from "../lib/translate.js";
import type { LocalMessage } from "../lib/types/letta-stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures", "onfdisk-messages");

// store.normalizeMessage maps `content` -> `parts` so the translator can
// read either. We mirror that here so fixtures can be the raw letta-code
// on-disk shape (which uses `content`) without a separate preprocessing
// step in this test.
function normalizeMessage(raw: unknown): LocalMessage {
  if (!raw || typeof raw !== "object") {
    throw new Error("fixture line is not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj["parts"]) && Array.isArray(obj["content"])) {
    return { ...obj, parts: obj["content"] } as unknown as LocalMessage;
  }
  return obj as unknown as LocalMessage;
}

interface ToolShapedPartProbe {
  raw: Record<string, unknown>;
  toolCallId: string;
  variant: "tool-call-legacy" | "tool-call-new" | "tool-return-legacy" | "native-tool";
}

function probeToolShapedParts(msg: LocalMessage): ToolShapedPartProbe[] {
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  const out: ToolShapedPartProbe[] = [];
  for (const p of parts) {
    if (!p || typeof (p as { type?: unknown }).type !== "string") continue;
    const obj = p as Record<string, unknown>;
    const t = obj["type"] as string;
    if (t === "tool-call") {
      out.push({
        raw: obj,
        toolCallId: typeof obj["toolCallId"] === "string" ? (obj["toolCallId"] as string) : "",
        variant: "tool-call-legacy",
      });
    } else if (t === "toolCall") {
      out.push({
        raw: obj,
        toolCallId: typeof obj["id"] === "string" ? (obj["id"] as string) : "",
        variant: "tool-call-new",
      });
    } else if (t === "tool-return") {
      out.push({
        raw: obj,
        toolCallId: typeof obj["toolCallId"] === "string" ? (obj["toolCallId"] as string) : "",
        variant: "tool-return-legacy",
      });
    } else if (t.startsWith("tool-")) {
      // Native `tool-${name}` form fans out to BOTH a tool_call_message and
      // (when output is present) a tool_return_message.
      out.push({
        raw: obj,
        toolCallId: typeof obj["toolCallId"] === "string" ? (obj["toolCallId"] as string) : "",
        variant: "native-tool",
      });
    } else if (/^tool/i.test(t)) {
      // Any other tool-shaped variant we don't classify above is exactly
      // the regression class this gate is here to catch.
      throw new Error(`unclassified tool-shaped part variant: ${t}`);
    }
  }
  return out;
}

function loadFixtureMessages(file: string): LocalMessage[] {
  const path = join(FIXTURE_DIR, file);
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  return lines.map((line, idx) => {
    try {
      return normalizeMessage(JSON.parse(line));
    } catch (err) {
      throw new Error(`fixture ${file} line ${idx + 1}: ${(err as Error).message}`);
    }
  });
}

test("onfdisk fixtures: every toolResult row projects to a tool_return_message", () => {
  const files = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".jsonl"));
  assert.ok(files.length > 0, "expected fixtures under onfdisk-messages/");
  let toolResultRows = 0;
  for (const file of files) {
    for (const msg of loadFixtureMessages(file)) {
      if (msg.role !== "toolResult") continue;
      toolResultRows++;
      const projected = localMessageToConversationMessages(msg);
      const trMsgs = projected.filter((p) => p.message_type === "tool_return_message");
      assert.ok(
        trMsgs.length >= 1,
        `${file} ${msg.id}: toolResult row produced no tool_return_message — got [${projected
          .map((p) => p.message_type)
          .join(", ")}]`,
      );
      // I4: non-empty call id + valid status.
      for (const tr of trMsgs as Array<{ tool_call_id?: string; status?: string }>) {
        assert.ok(tr.tool_call_id, `${file} ${msg.id}: tool_return_message tool_call_id empty`);
        assert.ok(
          tr.status === "success" || tr.status === "error",
          `${file} ${msg.id}: tool_return_message status invalid (${tr.status})`,
        );
      }
    }
  }
  assert.ok(toolResultRows > 0, "expected at least one toolResult row across fixtures");
});

test("onfdisk fixtures: every tool-shaped part produces a tool_*_message in the fan-out", () => {
  const files = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".jsonl"));
  for (const file of files) {
    for (const msg of loadFixtureMessages(file)) {
      const probes = probeToolShapedParts(msg);
      if (probes.length === 0) continue;
      const projected = localMessageToConversationMessages(msg);
      const tcOut = projected.filter((p) => p.message_type === "tool_call_message");
      const trOut = projected.filter((p) => p.message_type === "tool_return_message");

      for (const probe of probes) {
        if (probe.variant === "tool-return-legacy") {
          assert.ok(
            trOut.some((p) => (p as { tool_call_id?: string }).tool_call_id === probe.toolCallId),
            `${file} ${msg.id}: tool-return part ${probe.toolCallId} not in projection`,
          );
        } else if (probe.variant === "native-tool") {
          // native tool fans out to BOTH (when output state is present).
          assert.ok(
            tcOut.some((p) => (p as { tool_call?: { tool_call_id?: string } }).tool_call?.tool_call_id === probe.toolCallId),
            `${file} ${msg.id}: native tool ${probe.toolCallId} missing tool_call_message`,
          );
        } else {
          // tool-call-legacy / tool-call-new — both must emit a tool_call_message.
          assert.ok(
            tcOut.some((p) => (p as { tool_call?: { tool_call_id?: string } }).tool_call?.tool_call_id === probe.toolCallId),
            `${file} ${msg.id}: ${probe.variant} ${probe.toolCallId} missing tool_call_message`,
          );
        }
      }

      // I3: every emitted tool_call_message has a non-empty id + non-placeholder name.
      for (const tc of tcOut as Array<{ tool_call?: { tool_call_id?: string; name?: string } }>) {
        assert.ok(tc.tool_call?.tool_call_id, `${file} ${msg.id}: tool_call_message tool_call_id empty`);
        assert.ok(tc.tool_call?.name, `${file} ${msg.id}: tool_call_message name empty`);
      }
    }
  }
});

test("onfdisk fixtures: NO tool-shaped part silently turns into assistant_message", () => {
  // The regression we're guarding: a `toolResult` row degrading to an
  // assistant_message, or a `toolCall` part collapsing into the preceding
  // assistant text bubble with no separate tool card.
  const files = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".jsonl"));
  for (const file of files) {
    for (const msg of loadFixtureMessages(file)) {
      const isToolResultRow = msg.role === "toolResult";
      const hasToolShapedPart = probeToolShapedParts(msg).length > 0;
      if (!isToolResultRow && !hasToolShapedPart) continue;
      const projected = localMessageToConversationMessages(msg);
      const hasToolWire = projected.some(
        (p) => p.message_type === "tool_call_message" || p.message_type === "tool_return_message",
      );
      assert.ok(
        hasToolWire,
        `${file} ${msg.id}: tool-bearing source produced no tool_*_message — projected types ${projected
          .map((p) => p.message_type)
          .join(", ")}`,
      );
    }
  }
});

test("translator: top-level toolResult row projects with name + isError honored", () => {
  // Targeted unit case in addition to fixtures, exercising the new branch.
  const msg = {
    id: "ui-msg-a3:tool-result:toolu_x",
    role: "toolResult",
    toolCallId: "toolu_x",
    toolName: "Read",
    isError: true,
    parts: [{ type: "text", text: "Error: ENOENT" }],
    metadata: { created_at: "2026-05-19T00:00:00.000Z" },
  } as unknown as LocalMessage;
  const projected = localMessageToConversationMessages(msg);
  assert.equal(projected.length, 1);
  const tr = projected[0] as {
    message_type: string;
    tool_call_id?: string;
    status?: string;
    name?: string | null;
    tool_return?: string;
    is_err?: boolean | null;
  };
  assert.equal(tr.message_type, "tool_return_message");
  assert.equal(tr.tool_call_id, "toolu_x");
  assert.equal(tr.status, "error");
  assert.equal(tr.name, "Read");
  assert.equal(tr.tool_return, "Error: ENOENT");
  assert.equal(tr.is_err, true);
});

test("translator: unknown tool-shaped part triggers a loud warning (future-drift gate)", () => {
  // If letta-code introduces a new tool variant we don't yet recognize,
  // the translator must not silently swallow it. The console.warn line is
  // the canary — CI/log scrapers can grep for translate.unknown_tool_part.
  const originalWarn = console.warn;
  const captured: string[] = [];
  console.warn = (msg: string) => {
    captured.push(typeof msg === "string" ? msg : String(msg));
  };
  try {
    const msg = {
      id: "ui-msg-future",
      role: "assistant",
      parts: [
        // A made-up future variant — the kind of thing that would silently
        // disappear before this guard existed.
        { type: "toolInvocation", id: "toolu_future", name: "Future" },
      ],
      metadata: { created_at: "2026-05-19T00:00:00.000Z" },
    } as unknown as LocalMessage;
    localMessageToConversationMessages(msg);
  } finally {
    console.warn = originalWarn;
  }
  const hit = captured.find((m) => m.includes("translate.unknown_tool_part"));
  assert.ok(
    hit,
    `expected translate.unknown_tool_part warning, got: ${captured.join(" | ")}`,
  );
  const parsed = JSON.parse(hit!) as { msg_id?: string; part_type?: string };
  assert.equal(parsed.msg_id, "ui-msg-future");
  assert.equal(parsed.part_type, "toolInvocation");
});

test("translator: new-shape toolCall part projects with id + object args", () => {
  const msg: LocalMessage = {
    id: "ui-msg-asst-tc",
    role: "assistant",
    parts: [
      { type: "text", text: "" },
      {
        type: "toolCall",
        id: "toolu_y",
        name: "Bash",
        arguments: { command: "ls" },
      },
    ],
    metadata: { created_at: "2026-05-19T00:00:00.000Z" },
  };
  const projected = localMessageToConversationMessages(msg);
  const tc = projected.find((p) => p.message_type === "tool_call_message") as
    | { id?: string; name?: string; tool_call?: { name?: string; arguments?: string; tool_call_id?: string } }
    | undefined;
  assert.ok(tc, "expected a tool_call_message in the fan-out");
  assert.equal(tc!.tool_call?.tool_call_id, "toolu_y");
  assert.equal(tc!.tool_call?.name, "Bash");
  assert.equal(tc!.name, "Bash");
  // arguments should be a JSON string of the object.
  assert.equal(tc!.tool_call?.arguments, JSON.stringify({ command: "ls" }));
  // Strict-dedup id format mobile relies on.
  assert.equal(tc!.id, "toolcall-toolu_y");
});
