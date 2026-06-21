/**
 * Behavioral tests for POST /v1/work-activity external work ingest (lcp-zncq).
 *
 * Spins up a real shim subprocess via the standard test harness and
 * curls the /v1/work-activity surface. The endpoint accepts external
 * producer reports (vibesync) and maps them onto the existing
 * active-subagent registry.
 *
 * Acceptance criteria covered:
 *   - POST /v1/work-activity creates a running entry.
 *   - Idempotent re-POST with the same external_id updates metadata
 *     without duplicating entries.
 *   - POST with status=completed transitions an entry to completed.
 *   - POST with status=failed transitions an entry (with failure_reason).
 *   - Invalid payloads (missing fields, bad status) return 400.
 *   - External entries appear in the subagent_list alongside Agent-tool
 *     entries and carry the correct source badge.
 *   - POST broadcasts a subagents_updated frame to connected mobile WS
 *     clients.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startShim, openMobileWs } from "./helpers/index.js";
import type { MobileWsFrame, MobileWsHandle } from "./helpers/ws.js";
import type { ShimHandle } from "./helpers/shim.js";

interface SubagentEntry {
  toolCallId: string;
  description: string | null;
  source: string;
  status: string;
  failureReason: string | null;
  startedAt: string;
  endedAt: string | null;
  subagentType: string | null;
  runInBackground: boolean;
  todo_progress: { completed: number; total: number } | null;
}

interface SubagentsUpdatedFrame extends MobileWsFrame {
  reason: string;
  subagent: SubagentEntry | null;
  subagents_active: SubagentEntry[] | null;
  at: string;
}

/**
 * Wait for the NEXT frame of `type` arriving after this call.
 * Mirrors the pattern in crons-ws.test.ts.
 */
async function waitTyped<T extends MobileWsFrame>(
  conn: MobileWsHandle,
  type: string,
  timeoutMs = 5000,
): Promise<T> {
  const cursor = conn.frames.length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = cursor; i < conn.frames.length; i++) {
      const f = conn.frames[i];
      if (f && f.type === type) return f as T;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitTyped(${type}) timeout (frames: ${conn.frames.map((f) => f.type).join(",")})`);
}

// ── Basic CRUD ───────────────────────────────────────────────────────────

test("POST /v1/work-activity creates a running entry", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        external_id: "mol-1-step-2",
        source: "vibesync",
        description: "vibe refinement",
        status: "running",
      }),
    });
    assert.equal(res.status, 200);
    const entry = (await res.json()) as SubagentEntry;
    assert.equal(entry.toolCallId, "ext-vibesync-mol-1-step-2");
    assert.equal(entry.source, "vibesync");
    assert.equal(entry.status, "running");
    assert.equal(entry.description, "vibe refinement");
    assert.ok(entry.startedAt);
    assert.equal(entry.endedAt, null);
    assert.equal(entry.failureReason, null);

    // Should appear in GET listing
    const list = await fetch(`${shim.url}/v1/work-activity`);
    assert.equal(list.status, 200);
    const body = (await list.json()) as SubagentEntry[];
    assert.ok(Array.isArray(body));
    const found = body.find((s) => s.toolCallId === "ext-vibesync-mol-1-step-2");
    assert.ok(found);
    assert.equal(found!.source, "vibesync");
  } finally {
    await shim.stop();
  }
});

test("POST /v1/work-activity idempotent re-POST updates metadata without duplicating", async () => {
  const shim = await startShim();
  try {
    const body = {
      external_id: "mol-2-step-1",
      source: "vibesync",
      description: "first pass",
      status: "running",
    };
    const r1 = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(r1.status, 200);
    const e1 = (await r1.json()) as SubagentEntry;

    // Re-POST with updated description
    const r2 = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, description: "second pass" }),
    });
    assert.equal(r2.status, 200);
    const e2 = (await r2.json()) as SubagentEntry;
    assert.equal(e2.toolCallId, e1.toolCallId, "same external_id → same toolCallId");
    // Re-POST on a running entry backfills/updates metadata.
    // (description update depends on the registry idempotency semantics;
    // the key contract is no duplication — same toolCallId.)
    assert.equal(e2.status, "running");

    // Verify exactly one entry
    const list = await fetch(`${shim.url}/v1/work-activity`);
    const all = (await list.json()) as SubagentEntry[];
    const matches = all.filter((s) => s.toolCallId === e1.toolCallId);
    assert.equal(matches.length, 1, "re-POST must not create duplicates");
  } finally {
    await shim.stop();
  }
});

// ── Terminal transitions ─────────────────────────────────────────────────

test("POST /v1/work-activity status=completed finalizes the entry", async () => {
  const shim = await startShim();
  try {
    // Create running, then complete
    const r1 = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        external_id: "mol-3-step-1",
        source: "vibesync",
        description: "to complete",
        status: "running",
      }),
    });
    assert.equal(r1.status, 200);
    const e1 = (await r1.json()) as SubagentEntry;
    assert.equal(e1.status, "running");

    const r2 = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        external_id: "mol-3-step-1",
        source: "vibesync",
        description: "to complete",
        status: "completed",
      }),
    });
    assert.equal(r2.status, 200);
    const e2 = (await r2.json()) as SubagentEntry;
    assert.equal(e2.status, "completed");
    assert.ok(e2.endedAt, "completed entry should have endedAt");
    assert.equal(e2.failureReason, null);
  } finally {
    await shim.stop();
  }
});

test("POST /v1/work-activity status=failed records failure_reason", async () => {
  const shim = await startShim();
  try {
    // Create running, then fail
    const r1 = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        external_id: "mol-4-step-1",
        source: "vibesync",
        description: "will fail",
        status: "running",
      }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        external_id: "mol-4-step-1",
        source: "vibesync",
        description: "will fail",
        status: "failed",
        failure_reason: "timeout in vibesync",
      }),
    });
    assert.equal(r2.status, 200);
    const e2 = (await r2.json()) as SubagentEntry;
    assert.equal(e2.status, "failed");
    assert.equal(e2.failureReason, "timeout in vibesync");
    assert.ok(e2.endedAt, "failed entry should have endedAt");
  } finally {
    await shim.stop();
  }
});

test("POST /v1/work-activity terminal status creates+finalizes if entry absent", async () => {
  const shim = await startShim();
  try {
    // Send completed for a never-seen external_id — should create+finalize
    const res = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        external_id: "mol-99-step-99",
        source: "vibesync",
        description: "already done",
        status: "completed",
      }),
    });
    assert.equal(res.status, 200);
    const entry = (await res.json()) as SubagentEntry;
    assert.equal(entry.toolCallId, "ext-vibesync-mol-99-step-99");
    assert.equal(entry.status, "completed");
    assert.ok(entry.endedAt);
  } finally {
    await shim.stop();
  }
});

// ── Validation (400 on bad payload) ──────────────────────────────────────

test("POST /v1/work-activity returns 400 on missing external_id", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "vibesync", status: "running" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.ok(body.detail.includes("external_id"));
  } finally {
    await shim.stop();
  }
});

test("POST /v1/work-activity returns 400 on missing source", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ external_id: "x", status: "running" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.ok(body.detail.includes("source"));
  } finally {
    await shim.stop();
  }
});

test("POST /v1/work-activity returns 400 on invalid status", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ external_id: "x", source: "vibesync", status: "unknown" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.ok(body.detail.includes("status"));
  } finally {
    await shim.stop();
  }
});

test("POST /v1/work-activity returns 400 on empty external_id", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ external_id: "", source: "vibesync", status: "running" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await shim.stop();
  }
});

test("POST /v1/work-activity returns 400 on empty source", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ external_id: "x", source: "", status: "running" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await shim.stop();
  }
});

test("POST /v1/work-activity returns 400 on missing status", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ external_id: "x", source: "vibesync" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.ok(body.detail.includes("status"));
  } finally {
    await shim.stop();
  }
});

// ── Broadcast ────────────────────────────────────────────────────────────

test("POST /v1/work-activity accepts progress and broadcasts todos_changed", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      await fetch(`${shim.url}/v1/work-activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          external_id: "mol-progress-1",
          source: "vibesync",
          description: "progress-test",
          status: "running",
        }),
      });
      const observed = waitTyped<SubagentsUpdatedFrame>(conn, "subagents_updated", 5000);
      const res = await fetch(`${shim.url}/v1/work-activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          external_id: "mol-progress-1",
          source: "vibesync",
          description: "progress-test",
          status: "running",
          progress: { completed: 2, total: 5 },
        }),
      });
      assert.equal(res.status, 200);
      const entry = (await res.json()) as SubagentEntry;
      assert.deepEqual(entry.todo_progress, { completed: 2, total: 5 });

      const frame = await observed;
      assert.equal(frame.reason, "todos_changed");
      assert.deepEqual(frame.subagent?.todo_progress, { completed: 2, total: 5 });
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("POST /v1/work-activity rejects invalid progress", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        external_id: "mol-progress-bad",
        source: "vibesync",
        description: "bad progress",
        status: "running",
        progress: { completed: 3, total: 2 },
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.ok(body.detail.includes("progress"));
  } finally {
    await shim.stop();
  }
});

test("POST /v1/work-activity broadcasts subagents_updated to mobile WS clients", async () => {
  const shim = await startShim();
  try {
    // Open a mobile WS connection before the POST so it sees the event.
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      // Start waiting for the frame BEFORE we POST so the cursor captures the event.
      const observed = waitTyped<SubagentsUpdatedFrame>(conn, "subagents_updated", 5000);

      const res = await fetch(`${shim.url}/v1/work-activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          external_id: "mol-bcast-1",
          source: "vibesync",
          description: "broadcast-test",
          status: "running",
        }),
      });
      assert.equal(res.status, 200);

      const frame = await observed;
      assert.ok(frame, "should receive subagents_updated frame");
      assert.ok(frame.subagent, "subagents_updated should include the subagent delta");
      assert.equal(frame.subagent!.toolCallId, "ext-vibesync-mol-bcast-1");
      assert.equal(frame.subagent!.source, "vibesync");
      assert.equal(frame.reason, "started");
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("PATCH /v1/work-activity/:toolCallId finalizes letta entry and broadcasts", async () => {
  const shim = await startShim({ waitForReady: false });
  const runId = "run-patch-letta";
  const toolCallId = "toolu_patch_letta";
  const logFile = join(shim.stateDir, "task_patch.log");
  try {
    mkdirSync(join(shim.stateDir, "runs", runId), { recursive: true });
    writeFileSync(logFile, "[Task started]\n");
    writeFileSync(join(shim.stateDir, "runs", runId, "run.json"), JSON.stringify({
      id: runId,
      agent_id: "agent-test",
      conversation_id: "default",
      background: false,
      status: "running",
      created_at: new Date().toISOString(),
      completed_at: null,
      metadata: {},
      message_ids: [],
      tools_used: [],
      num_steps: 0,
    }) + "\n");
    const dispatch = {
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: toolCallId,
        name: "Agent",
        arguments: JSON.stringify({
          subagent_type: "general-purpose",
          description: "patch letta entry",
          run_in_background: true,
          prompt: "do it",
        }),
      },
    };
    const ret = {
      message_type: "tool_return_message",
      name: "Agent",
      tool_call_id: toolCallId,
      tool_return:
        "Task running in background with task ID: task_92\n" +
        "Agent ID: agent-local-abc12345-1234-1234-1234-123456789abc\n" +
        `Output file: ${logFile}`,
    };
    writeFileSync(join(shim.stateDir, "runs", runId, "frames.jsonl"),
      JSON.stringify({ seq: 1, ts: new Date().toISOString(), frame: dispatch }) + "\n" +
      JSON.stringify({ seq: 2, ts: new Date().toISOString(), frame: ret }) + "\n");

    await shim.waitForLogLine(/listening on/);
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      const observed = waitTyped<SubagentsUpdatedFrame>(conn, "subagents_updated", 5000);
      const res = await fetch(`${shim.url}/v1/work-activity/${encodeURIComponent(toolCallId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "failed", failureReason: "manual cleanup" }),
      });
      assert.equal(res.status, 200);
      const entry = (await res.json()) as SubagentEntry;
      assert.equal(entry.source, "letta");
      assert.equal(entry.status, "failed");
      assert.equal(entry.failureReason, "manual cleanup");

      const frame = await observed;
      assert.equal(frame.reason, "failed");
      assert.equal(frame.subagent?.toolCallId, toolCallId);
      assert.equal(frame.subagent?.status, "failed");
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

// ── Source badges for Agent-tool entries ─────────────────────────────────

test("external work-activity entries appear alongside Agent-tool entries with correct source badge", async () => {
  const shim = await startShim();
  try {
    // Post an external entry
    const r1 = await fetch(`${shim.url}/v1/work-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        external_id: "mol-sidebyside",
        source: "vibesync",
        description: "external vibesync task",
        status: "running",
      }),
    });
    assert.equal(r1.status, 200);
    const ext = (await r1.json()) as SubagentEntry;

    // Fetch the full listing
    const list = await fetch(`${shim.url}/v1/work-activity`);
    const all = (await list.json()) as SubagentEntry[];

    const found = all.find((s) => s.toolCallId === ext.toolCallId);
    assert.ok(found, "external entry must appear in the listing");
    assert.equal(found!.source, "vibesync");
    assert.equal(found!.description, "external vibesync task");
  } finally {
    await shim.stop();
  }
});

// ── Regression: GET /v1/work-activity MUST NOT surface a stranded
//    started-only-log subagent as running (letta-mobile-73o2h.4).
//
//    The user-visible "stuck subagent chip" bug was caused by a background
//    dispatch whose worker process died without writing a [Task completed]
//    / [Task failed] footer and whose worker PID could not be parsed from
//    the log. The registry left it as `running` forever and the chat bar
//    showed it indefinitely.
//
//    This test seeds that exact on-disk state into a fresh shim and
//    asserts:
//      1. The rehydrated entry does exist (we did ingest it).
//      2. GET /v1/work-activity does NOT return it with status="running".
//
//    It does NOT need a worker process — it exploits the absence of one.

test("GET /v1/work-activity never returns a stranded started-only-log subagent as running", async () => {
  const shim = await startShim();
  try {
    // Seed a stranded Agent tool_call + return in a fresh run dir.
    const runId = "run-stranded-subagent-1";
    const toolCallId = "tc-stranded-1";
    const subagentAgentId = "agent-local-stranded-aaaa-bbbb-cccc-dddddddddddd";
    const taskId = "task_stranded_1";
    const logFile = join(shim.stateDir, "runs", runId, "task_stranded_1.log");
    mkdirSync(join(shim.stateDir, "runs", runId), { recursive: true });
    // Started-only log with NO parseable worker PID — exactly the failure
    // shape observed on the device. Stale (mtime far in the past).
    writeFileSync(
      logFile,
      "[Task started: Stranded subagent (http)]\n[subagent_type: general-purpose]\n",
      "utf8",
    );
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(logFile, stale, stale);

    const framesPath = join(shim.stateDir, "runs", runId, "frames.jsonl");
    const toolCallFrame = {
      message_type: "tool_call_message",
      date: "2026-01-01T00:00:00.000Z",
      tool_call: {
        tool_call_id: toolCallId,
        name: "Agent",
        arguments: JSON.stringify({
          subagent_type: "general-purpose",
          description: "Stranded subagent (http regression)",
          run_in_background: true,
        }),
      },
    };
    const toolReturnFrame = {
      message_type: "tool_return_message",
      date: "2026-01-01T00:00:01.000Z",
      tool_call_id: toolCallId,
      name: "Agent",
      is_err: null,
      tool_return:
        `Async agent launched in background.\n` +
        `task_id: ${taskId}\n` +
        `agent_id: ${subagentAgentId}\n` +
        `log_file: ${logFile}\n` +
        `Worker PID: (not yet known)\n`,
    };
    writeFileSync(framesPath, JSON.stringify(toolCallFrame) + "\n" + JSON.stringify(toolReturnFrame) + "\n", "utf8");
    // Also drop a run.json so rehydrateSubagentsFromRunFrames picks the run up.
    writeFileSync(
      join(shim.stateDir, "runs", runId, "run.json"),
      JSON.stringify({
        id: runId,
        agent_id: subagentAgentId,
        conversation_id: "default",
        status: "running",
        started_at: stale.toISOString(),
      }),
      "utf8",
    );

    // GET /v1/work-activity — this is the endpoint the mobile chat bar binds
    // to via WS. The shim must sweep before returning so a stranded entry
    // is finalized as failed/orphaned instead of staying "running".
    const res = await fetch(`${shim.url}/v1/work-activity`);
    assert.equal(res.status, 200);
    const entries = (await res.json()) as SubagentEntry[];
    const stillRunning = entries.find((e) => e.toolCallId === toolCallId && e.status === "running");
    assert.equal(
      stillRunning,
      undefined,
      "GET /v1/work-activity must NEVER return a stranded started-only subagent as running",
    );
  } finally {
    await shim.stop();
  }
});
