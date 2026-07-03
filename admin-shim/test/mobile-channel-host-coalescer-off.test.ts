/**
 * lcp xwi3z (§2a) — test (c): SHIM_STREAM_COALESCE=0 kill switch restores
 * exact 1:1 passthrough through the SAME pipeline body.
 *
 * The gate is a module-level const in mobile-channel-host.ts, so this file
 * sets the env BEFORE importing the module (dynamic import; node --test
 * runs each test file in its own process, so this cannot leak into the
 * sibling coalescer-on test file).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const backendDir = mkdtempSync(join(tmpdir(), "coalescer-off-"));
process.env["LETTA_LOCAL_BACKEND_DIR"] = backendDir;
process.env["SHIM_STREAM_COALESCE"] = "0";
process.on("exit", () => rmSync(backendDir, { recursive: true, force: true }));

type RawFrame = Record<string, unknown>;

function assistant(otid: string, content: string): RawFrame {
  return { message_type: "assistant_message", otid, content };
}

test("(c) SHIM_STREAM_COALESCE=0 → exact 1:1 passthrough, order preserved", async () => {
  const { bridgeSendMessage } = await import("../lib/mobile-channel-host.js");
  const { getAgentPool } = await import("../lib/agent-pool.js");

  const script: RawFrame[] = [
    assistant("o1", "a"),
    assistant("o1", "b"),
    assistant("o1", "c"),
    { message_type: "tool_call_message", otid: "o1", tool_call: { tool_call_id: "tc-9", name: "Bash", arguments: "{}" }, status: "running" },
    { message_type: "tool_return_message", tool_call_id: "tc-9", status: "success", tool_return: "done", stdout: null, stderr: null },
    assistant("o1", "d"),
    assistant("o1", "e"),
    { message_type: "stop_reason", stop_reason: "end_turn" },
  ];

  const emitted: Array<Record<string, unknown>> = [];
  const counts: number[] = [];
  const pool = getAgentPool();
  const originalRunTurn = pool.runTurnWithHeal;
  pool.runTurnWithHeal = (async (
    _c: string,
    _a: string,
    _content: unknown,
    turnOpts: { onFrame?: (raw: unknown, meta: { runId: string }) => void; runHandle?: { id: string } },
  ) => {
    const runId = turnOpts.runHandle?.id ?? "run-test";
    for (const frame of script) {
      turnOpts.onFrame?.(frame, { runId });
      // 1:1: every submitted frame is on the wire synchronously (except
      // stop_reason/usage, which the pipeline defers to end-of-turn).
      counts.push(emitted.length);
    }
    return { frames: [], done: true, stderr: "" };
  }) as typeof pool.runTurnWithHeal;

  try {
    await bridgeSendMessage(
      { agent_id: "agent-off-1", conversation_id: "conv-off-1", text: "hi" },
      (frame) => emitted.push(frame as unknown as Record<string, unknown>),
    );
  } finally {
    pool.runTurnWithHeal = originalRunTurn;
  }

  // Every non-terminal frame emitted immediately: counts climb 1..7 then
  // stay at 7 for the deferred stop_reason.
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 7, 7]);

  // Deltas are NOT merged — five separate assistant frames, in order.
  const assistants = emitted.filter((f) => f["message_type"] === "assistant_message");
  assert.deepEqual(assistants.map((f) => f["content"]), ["a", "b", "c", "d", "e"]);
  // Stable per-otid ids still stamped by the shared pipeline body.
  assert.ok(assistants.every((f) => f["id"] === "cm-stream-o1"));

  // Tool frames in order; stop_reason last (deferred by the pipeline).
  const types = emitted.map((f) => f["message_type"]);
  assert.ok(types.indexOf("tool_call_message") < types.indexOf("tool_return_message"));
  assert.equal(types[types.length - 1], "stop_reason");
});
