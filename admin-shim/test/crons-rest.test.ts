/**
 * Behavioral tests for the cron REST mirror (lcp-9h3).
 *
 * Spins up a real shim subprocess via the standard test harness and
 * curls the /v1/crons* surface. The store is seeded by writing
 * crons.json directly into the shim's $HOME/.letta/ — the same path
 * the shim's getLettaDir() resolves to.
 *
 * Acceptance criteria covered:
 *   - GET /v1/crons returns the seeded task list (with agent_id /
 *     conversation_id filters honored).
 *   - GET /v1/crons/{id} returns the task; 404 for unknown ids.
 *   - GET /v1/crons/scheduler reflects lease_held=true while running.
 *   - POST/DELETE/PUT on /v1/crons* return 405 with a WS pointer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openMobileWs, startShim } from "./helpers/index.js";
import type { MobileWsFrame } from "./helpers/ws.js";
import type { ShimHandle } from "./helpers/shim.js";
import type { CronFile, CronTask } from "../lib/types/crons.js";

interface WsCronListResp extends MobileWsFrame { success: boolean; tasks: CronTask[] }

function makeTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: "deadbeef",
    agent_id: "agent-a",
    conversation_id: "default",
    name: "test-task",
    description: "rest mirror test",
    cron: "*/5 * * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "hello",
    status: "active",
    created_at: "2026-05-18T10:00:00.000Z",
    expires_at: null,
    last_fired_at: null,
    fire_count: 0,
    cancel_reason: null,
    jitter_offset_ms: 0,
    scheduled_for: null,
    fired_at: null,
    missed_at: null,
    ...overrides,
  };
}

function seedCrons(handle: ShimHandle, tasks: CronTask[]): void {
  const lettaDir = join(handle.homeDir, ".letta");
  mkdirSync(lettaDir, { recursive: true });
  const data: CronFile = { version: 1, scheduler_owner: null, last_tick_at: null, tasks };
  writeFileSync(join(lettaDir, "crons.json"), JSON.stringify(data, null, 2));
}

test("GET /v1/crons returns the full task list", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "task1" }), makeTask({ id: "task2", agent_id: "agent-b" })]);
    const res = await fetch(`${shim.url}/v1/crons`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tasks: CronTask[] };
    assert.ok(Array.isArray(body.tasks));
    assert.equal(body.tasks.length, 2);
    assert.deepEqual(
      body.tasks.map((t) => t.id).sort(),
      ["task1", "task2"],
    );
  } finally {
    await shim.stop();
  }
});

test("GET /v1/crons?agent_id=… filters", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [
      makeTask({ id: "a1-only", agent_id: "agent-a" }),
      makeTask({ id: "a2-only", agent_id: "agent-b" }),
    ]);
    const res = await fetch(`${shim.url}/v1/crons?agent_id=agent-a`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tasks: CronTask[] };
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0]?.id, "a1-only");
  } finally {
    await shim.stop();
  }
});

test("GET /v1/crons?conversation_id=… filters", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [
      makeTask({ id: "in-c1", conversation_id: "c1" }),
      makeTask({ id: "in-c2", conversation_id: "c2" }),
    ]);
    const res = await fetch(`${shim.url}/v1/crons?conversation_id=c2`);
    const body = (await res.json()) as { tasks: CronTask[] };
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0]?.id, "in-c2");
  } finally {
    await shim.stop();
  }
});

test("GET /v1/crons/{id} returns the task; bad id is 404", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "abc123" })]);
    const okRes = await fetch(`${shim.url}/v1/crons/abc123`);
    assert.equal(okRes.status, 200);
    const task = (await okRes.json()) as CronTask;
    assert.equal(task.id, "abc123");
    assert.equal(task.agent_id, "agent-a");

    const missing = await fetch(`${shim.url}/v1/crons/does-not-exist`);
    assert.equal(missing.status, 404);
  } finally {
    await shim.stop();
  }
});

test("GET /v1/crons/scheduler reports lease_held=true while running", async () => {
  const shim = await startShim();
  try {
    // Wait for the scheduler-started log line so the lease is definitively
    // claimed before we poke the endpoint.
    await shim.waitForLogLine(/cron-scheduler] started/, { timeoutMs: 10000 });
    const res = await fetch(`${shim.url}/v1/crons/scheduler`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      lease_held: boolean;
      owner_pid: number | null;
      tasks_active: number;
      started_at: string | null;
    };
    assert.equal(body.lease_held, true);
    assert.ok(typeof body.owner_pid === "number" && body.owner_pid > 0);
    assert.ok(body.started_at);
    assert.equal(typeof body.tasks_active, "number");
  } finally {
    await shim.stop();
  }
});

test("GET /v1/crons/scheduler reflects tasks_active after external write", async () => {
  const shim = await startShim();
  try {
    await shim.waitForLogLine(/cron-scheduler] started/, { timeoutMs: 10000 });
    // Initially empty.
    let res = await fetch(`${shim.url}/v1/crons/scheduler`);
    let body = (await res.json()) as { tasks_active: number };
    assert.equal(body.tasks_active, 0);

    seedCrons(shim, [makeTask({ id: "fresh-1" }), makeTask({ id: "fresh-2" })]);

    // Re-fetch — the status handler does a fresh read so the count is
    // correct without waiting for a tick.
    res = await fetch(`${shim.url}/v1/crons/scheduler`);
    body = (await res.json()) as { tasks_active: number };
    assert.equal(body.tasks_active, 2);
  } finally {
    await shim.stop();
  }
});

test("POST /v1/crons returns 405 with WS pointer", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/crons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    assert.equal(res.status, 405);
    const allow = res.headers.get("allow");
    assert.match(allow ?? "", /GET/);
    const body = (await res.json()) as {
      detail: string;
      ws_endpoint: string;
      ws_frames: string[];
    };
    assert.match(body.detail, /WS-only/);
    assert.equal(body.ws_endpoint, "/shim/v1/mobile");
    assert.ok(body.ws_frames.includes("cron_add"));
  } finally {
    await shim.stop();
  }
});

test("DELETE /v1/crons/{id} returns 405", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "abc123" })]);
    const res = await fetch(`${shim.url}/v1/crons/abc123`, { method: "DELETE" });
    assert.equal(res.status, 405);
    const body = (await res.json()) as { detail: string; ws_frames: string[] };
    assert.match(body.detail, /WS-only/);
    assert.ok(body.ws_frames.includes("cron_delete"));
  } finally {
    await shim.stop();
  }
});

test("PUT /v1/crons/scheduler returns 405", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/crons/scheduler`, { method: "PUT" });
    assert.equal(res.status, 405);
  } finally {
    await shim.stop();
  }
});

test("OPTIONS /v1/crons returns 204 (CORS preflight)", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/crons`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
  } finally {
    await shim.stop();
  }
});

test("REST /v1/crons and WS cron_list return the same list at the same instant", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      // Mutate via WS — the canonical write path.
      conn.send({
        type: "cron_add",
        agent_id: "agent-parity",
        name: "parity",
        prompt: "p",
        cron: "*/5 * * * *",
      });
      await conn.waitFor("cron_add_response", { timeoutMs: 3000 });

      // Read both surfaces concurrently. They should agree row-for-row
      // because both go through the same `listTasks()` in lib/crons.ts
      // (no caching layer between the WS handler and the REST handler).
      conn.send({ type: "cron_list", request_id: "parity" });
      const [wsResp, restResp] = await Promise.all([
        conn.waitFor("cron_list_response", { timeoutMs: 3000 }) as Promise<WsCronListResp>,
        fetch(`${shim.url}/v1/crons`).then((r) => r.json() as Promise<{ tasks: CronTask[] }>),
      ]);
      const wsTasks = wsResp.tasks.map((t) => t.id).sort();
      const restTasks = restResp.tasks.map((t) => t.id).sort();
      assert.deepEqual(wsTasks, restTasks, "WS and REST list views must agree");
      assert.equal(wsTasks.length, 1);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("SIGTERM releases the cron scheduler lease in crons.json", async () => {
  // Bypass shim.stop() (which deletes the tempdir) so we can still read
  // the crons.json file AFTER the child exits to verify lease release.
  const shim = await startShim();
  try {
    await shim.waitForLogLine(/cron-scheduler] started/, { timeoutMs: 10000 });
    const cronsPath = join(shim.homeDir, ".letta", "crons.json");
    assert.ok(existsSync(cronsPath), `expected ${cronsPath} after scheduler start`);
    const before = JSON.parse(readFileSync(cronsPath, "utf-8")) as CronFile;
    assert.ok(before.scheduler_owner, "lease populated while scheduler runs");
    assert.equal(before.scheduler_owner!.pid, shim.pid);

    shim.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (shim.child.exitCode !== null) return resolve();
      shim.child.once("exit", () => resolve());
      setTimeout(() => resolve(), 5000).unref();
    });

    const after = JSON.parse(readFileSync(cronsPath, "utf-8")) as CronFile;
    assert.equal(after.scheduler_owner, null, "lease must be released on SIGTERM");
  } finally {
    if (!shim.child.killed) shim.child.kill("SIGKILL");
  }
});

test("trailing slash forms route the same as canonical form", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "trail-1" })]);
    const a = await fetch(`${shim.url}/v1/crons/`);
    const b = await fetch(`${shim.url}/v1/crons`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const sched = await fetch(`${shim.url}/v1/crons/scheduler/`);
    assert.equal(sched.status, 200);
  } finally {
    await shim.stop();
  }
});
