import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startShim } from "./helpers/shim.js";
import { rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("boot rehydrate recovers a running subagent from disk frames", async () => {
  const fixtureName = `recovery-fixture-${Math.random().toString(36).slice(2)}`;
  const fixtureDir = join(__dirname, "fixtures", "state", fixtureName);

  try {
    const runId = "run-recovery-test-1";
    const toolCallId = "tc-recovery-1";
    const subagentAgentId = "agent-local-11112222-3333-4444-5555-666677778888";
    const logFile = join(fixtureDir, "runs", runId, "task_1.log");

    mkdirSync(join(fixtureDir, "runs", runId), { recursive: true });
    writeFileSync(logFile, "[Task started]\nworking\n", "utf8");

    const framesPath = join(fixtureDir, "runs", runId, "frames.jsonl");
    const toolCallFrame = {
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: toolCallId,
        name: "Agent",
        arguments: JSON.stringify({
          subagent_type: "general-purpose",
          description: "Recovery test",
          run_in_background: true,
        }),
      },
    };
    const toolReturnFrameNoPid = {
      message_type: "tool_return_message",
      tool_call_id: toolCallId,
      name: "Agent",
      tool_return: `Task running in background with task ID: task_1\nAgent ID: ${subagentAgentId}\nOutput file: ${logFile}\n`
    };

    writeFileSync(framesPath, JSON.stringify(toolCallFrame) + "\n" + JSON.stringify(toolReturnFrameNoPid) + "\n", "utf8");

    writeFileSync(
      join(fixtureDir, "runs", runId, "run.json"),
      JSON.stringify({
        id: runId,
        agent_id: "agent-parent",
        conversation_id: "default",
        status: "completed",
        started_at: new Date().toISOString(),
      }),
      "utf8",
    );

    const shim = await startShim({ fixture: fixtureName });
    try {
      const res = await fetch(`${shim.url}/v1/work-activity`);
      assert.equal(res.status, 200);
      const entries = (await res.json()) as any[];

      const recovered = entries.find((e) => e.toolCallId === toolCallId);
      assert.ok(recovered, "Subagent should be recovered");
      assert.equal(recovered.status, "running", "Subagent should still be running");
      assert.equal(recovered.description, "Recovery test");

    } finally {
      await shim.stop();
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
