/**
 * Drift + invariant tests for the `buildMessageRunMap` attribution helper.
 *
 * Previously this file also pinned the legacy hybrid wire shape
 * (`LegacyLocalMessageWire`, lcp-zfa); that hybrid was retired by lcp-cox
 * once `/v1/agents/{id}/messages` and `/v1/agents/{id}/context` switched
 * to the vanilla fan-out projection. Tool-card / wire-shape regressions
 * are now covered by `test/onfdisk-translate.test.ts` (translator-level)
 * and `test/http-contract.test.ts` (endpoint-level).
 *
 * Pinned contracts remaining:
 *   - `buildMessageRunMap` oldest-run-wins (lcp-2mg) — when two runs
 *     claim the same messageId, the older run's id is the one returned.
 *   - `buildMessageRunMap` cap-hit warning (lcp-cen) — at 10_000 rows the
 *     function logs a structured warning so the silent-attribution-loss
 *     class of bug surfaces in logs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMessageRunMap } from "../lib/runs.js";

async function withBackendDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "translate-test-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) {
      delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    } else {
      process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function seedRun(
  storageDir: string,
  runId: string,
  opts: {
    agentId: string;
    conversationId: string;
    createdAt: string;
    messageIds?: string[];
    status?: "running" | "completed" | "failed" | "cancelled";
  },
): void {
  const dir = join(storageDir, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      id: runId,
      agent_id: opts.agentId,
      background: false,
      conversation_id: opts.conversationId,
      created_at: opts.createdAt,
      completed_at: opts.status === "running" ? null : opts.createdAt,
      status: opts.status ?? "completed",
      stop_reason: null,
      total_duration_ns: null,
      ttft_ns: null,
      message_ids: opts.messageIds ?? [],
      tools_used: [],
      num_steps: 0,
      metadata: {},
      request_config: null,
      base_template_id: null,
      callback_error: null,
      callback_sent_at: null,
      callback_status_code: null,
      callback_url: null,
    }),
  );
}

// ── lcp-2mg: buildMessageRunMap oldest-run-wins gate ──────────────

test("buildMessageRunMap: when two runs claim the same messageId, oldest wins", async () => {
  await withBackendDir((dir) => {
    // A created 09:00, B created 10:00. Both claim "msg-shared".
    seedRun(dir, "run-A", {
      agentId: "agent-x",
      conversationId: "conv-x",
      createdAt: "2026-05-19T09:00:00.000Z",
      messageIds: ["msg-shared", "msg-a-only"],
    });
    seedRun(dir, "run-B", {
      agentId: "agent-x",
      conversationId: "conv-x",
      createdAt: "2026-05-19T10:00:00.000Z",
      messageIds: ["msg-shared", "msg-b-only"],
    });

    const map = buildMessageRunMap({ agentId: "agent-x", conversationId: "conv-x" });
    assert.equal(map["msg-shared"], "run-A", "older run keeps the attribution");
    assert.equal(map["msg-a-only"], "run-A");
    assert.equal(map["msg-b-only"], "run-B");
  });
});

test("buildMessageRunMap: reversed seed order still resolves to older run", async () => {
  await withBackendDir((dir) => {
    // Seed in reverse on disk — newer first, then older. Filesystem-walk
    // order shouldn't matter because listRuns sorts by created_at asc.
    seedRun(dir, "run-newer", {
      agentId: "agent-y",
      conversationId: "conv-y",
      createdAt: "2026-05-19T11:00:00.000Z",
      messageIds: ["msg-contested"],
    });
    seedRun(dir, "run-older", {
      agentId: "agent-y",
      conversationId: "conv-y",
      createdAt: "2026-05-19T09:00:00.000Z",
      messageIds: ["msg-contested"],
    });

    const map = buildMessageRunMap({ agentId: "agent-y", conversationId: "conv-y" });
    assert.equal(map["msg-contested"], "run-older", "asc-by-created-at order is authoritative");
  });
});

test("buildMessageRunMap: scope filters honored (different agent → no attribution)", async () => {
  await withBackendDir((dir) => {
    seedRun(dir, "run-alpha", {
      agentId: "agent-alpha",
      conversationId: "conv-z",
      createdAt: "2026-05-19T09:00:00.000Z",
      messageIds: ["msg-only-alpha"],
    });
    seedRun(dir, "run-beta", {
      agentId: "agent-beta",
      conversationId: "conv-z",
      createdAt: "2026-05-19T10:00:00.000Z",
      messageIds: ["msg-only-beta"],
    });

    const alphaOnly = buildMessageRunMap({ agentId: "agent-alpha", conversationId: "conv-z" });
    assert.equal(alphaOnly["msg-only-alpha"], "run-alpha");
    assert.equal(alphaOnly["msg-only-beta"], undefined, "beta's message shouldn't appear in alpha's scope");
  });
});

// ── lcp-cen: cap-hit warning observability ────────────────────────

test("buildMessageRunMap: hitting the 10k cap emits a structured warning", async () => {
  await withBackendDir((dir) => {
    // Stub console.warn to capture the structured-log line, then put it
    // back. We seed exactly 10_000 runs to land at the cap boundary.
    const originalWarn = console.warn;
    const captured: string[] = [];
    console.warn = (msg: string) => {
      captured.push(msg);
    };
    try {
      for (let i = 0; i < 10_000; i++) {
        seedRun(dir, `run-cap-${i}`, {
          agentId: "agent-cap",
          conversationId: "conv-cap",
          // Deterministic asc-ordered timestamps so listRuns sorts stably.
          createdAt: new Date(2026, 0, 1, 0, 0, 0, i).toISOString(),
          messageIds: [`msg-${i}`],
        });
      }

      buildMessageRunMap({ agentId: "agent-cap", conversationId: "conv-cap" });

      const capHit = captured.find((m) => m.includes("buildMessageRunMap.cap_hit"));
      assert.ok(capHit, `expected cap_hit warning, got: ${captured.join(" | ")}`);
      const parsed = JSON.parse(capHit!) as {
        level: string;
        module: string;
        event: string;
        agent_id: string | null;
        conversation_id: string | null;
        cap: number;
        message: string;
      };
      assert.equal(parsed.level, "warn");
      assert.equal(parsed.module, "runs");
      assert.equal(parsed.event, "buildMessageRunMap.cap_hit");
      assert.equal(parsed.agent_id, "agent-cap");
      assert.equal(parsed.conversation_id, "conv-cap");
      assert.equal(parsed.cap, 10_000);
      assert.match(parsed.message, /attribution-incomplete/);
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("buildMessageRunMap: below the cap, no warning is emitted", async () => {
  await withBackendDir((dir) => {
    const originalWarn = console.warn;
    const captured: string[] = [];
    console.warn = (msg: string) => {
      captured.push(msg);
    };
    try {
      seedRun(dir, "run-small", {
        agentId: "agent-small",
        conversationId: "conv-small",
        createdAt: "2026-05-19T09:00:00.000Z",
        messageIds: ["msg-x"],
      });
      buildMessageRunMap({ agentId: "agent-small", conversationId: "conv-small" });
      const capHits = captured.filter((m) => m.includes("buildMessageRunMap.cap_hit"));
      assert.equal(capHits.length, 0, "should not warn below the cap");
    } finally {
      console.warn = originalWarn;
    }
  });
});
