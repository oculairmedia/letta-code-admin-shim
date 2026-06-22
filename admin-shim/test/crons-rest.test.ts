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
 *   - POST /v1/crons creates a task (lcp-5o9o).
 *   - PUT /v1/crons/{id} full-replaces; PATCH partial-updates.
 *   - DELETE /v1/crons/{id} removes one; DELETE /v1/crons bulk-deletes
 *     with agent_id / conversation_id filters.
 *   - An invalid cron schedule returns 400 on write.
 *   - Concurrent WS-write + REST-write does not lose either task.
 *   - PUT on the scheduler sub-resource still returns 405 (read-only).
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

test("POST /v1/crons creates a task and returns it (lcp-5o9o)", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/crons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent-create",
        name: "created-task",
        prompt: "do the thing",
        cron: "*/5 * * * *",
      }),
    });
    assert.equal(res.status, 201);
    const task = (await res.json()) as CronTask;
    assert.ok(task.id, "created task has an id");
    assert.equal(task.agent_id, "agent-create");
    assert.equal(task.name, "created-task");
    assert.equal(task.prompt, "do the thing");
    assert.equal(task.cron, "*/5 * * * *");
    assert.equal(task.status, "active");
    assert.equal(task.fire_count, 0);
    assert.equal(task.last_fired_at, null);
    // Readable back via GET with identical shape.
    const get = await fetch(`${shim.url}/v1/crons/${task.id}`);
    assert.equal(get.status, 200);
    const fetched = (await get.json()) as CronTask;
    assert.deepEqual(fetched, task);
  } finally {
    await shim.stop();
  }
});

test("POST /v1/crons with invalid schedule returns 400", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/crons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent-bad",
        name: "bad",
        prompt: "p",
        cron: "not a cron",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.match(body.detail, /invalid cron/);
  } finally {
    await shim.stop();
  }
});

test("POST /v1/crons without agent_id or prompt returns 400", async () => {
  const shim = await startShim();
  try {
    const noAgent = await fetch(`${shim.url}/v1/crons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", prompt: "p", cron: "*/5 * * * *" }),
    });
    assert.equal(noAgent.status, 400);
    const noPrompt = await fetch(`${shim.url}/v1/crons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "a", name: "x", cron: "*/5 * * * *" }),
    });
    assert.equal(noPrompt.status, 400);
  } finally {
    await shim.stop();
  }
});

test("PUT /v1/crons/{id} full-replaces all fields", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "rep1", name: "old", prompt: "old-prompt", cron: "*/5 * * * *" })]);
    const res = await fetch(`${shim.url}/v1/crons/rep1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent-a",
        name: "new-name",
        prompt: "new-prompt",
        cron: "0 9 * * *",
      }),
    });
    assert.equal(res.status, 200);
    const task = (await res.json()) as CronTask;
    assert.equal(task.id, "rep1");
    assert.equal(task.name, "new-name");
    assert.equal(task.prompt, "new-prompt");
    assert.equal(task.cron, "0 9 * * *");
  } finally {
    await shim.stop();
  }
});

test("PUT /v1/crons/{id} with invalid schedule returns 400", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "rep2" })]);
    const res = await fetch(`${shim.url}/v1/crons/rep2`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n", prompt: "p", cron: "99 99 99 99 99 99" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await shim.stop();
  }
});

test("PUT /v1/crons/{id} on unknown id returns 404", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/crons/nope`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n", prompt: "p", cron: "*/5 * * * *" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await shim.stop();
  }
});

test("PATCH /v1/crons/{id} partially updates fields", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "pat1", status: "active", cron: "*/5 * * * *" })]);
    const res = await fetch(`${shim.url}/v1/crons/pat1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, cron: "0 0 * * *" }),
    });
    assert.equal(res.status, 200);
    const task = (await res.json()) as CronTask;
    assert.equal(task.cron, "0 0 * * *");
    assert.equal(task.status, "cancelled");
    // Unspecified fields are preserved.
    assert.equal(task.prompt, "hello");
  } finally {
    await shim.stop();
  }
});

test("PATCH /v1/crons/{id} with invalid schedule returns 400", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "pat2" })]);
    const res = await fetch(`${shim.url}/v1/crons/pat2`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "garbage" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await shim.stop();
  }
});

test("DELETE /v1/crons/{id} removes a single task", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "del1" }), makeTask({ id: "del2" })]);
    const res = await fetch(`${shim.url}/v1/crons/del1`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deleted: boolean; id: string };
    assert.deepEqual(body, { deleted: true, id: "del1" });
    const list = await (await fetch(`${shim.url}/v1/crons`)).json() as { tasks: CronTask[] };
    assert.deepEqual(list.tasks.map((t) => t.id), ["del2"]);
  } finally {
    await shim.stop();
  }
});

test("DELETE /v1/crons/{id} on unknown id returns 404", async () => {
  const shim = await startShim();
  try {
    const res = await fetch(`${shim.url}/v1/crons/ghost`, { method: "DELETE" });
    assert.equal(res.status, 404);
  } finally {
    await shim.stop();
  }
});

test("DELETE /v1/crons?agent_id=… bulk-deletes by agent", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [
      makeTask({ id: "b1", agent_id: "agent-x" }),
      makeTask({ id: "b2", agent_id: "agent-x" }),
      makeTask({ id: "b3", agent_id: "agent-y" }),
    ]);
    const res = await fetch(`${shim.url}/v1/crons?agent_id=agent-x`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deleted: number };
    assert.equal(body.deleted, 2);
    const list = await (await fetch(`${shim.url}/v1/crons`)).json() as { tasks: CronTask[] };
    assert.deepEqual(list.tasks.map((t) => t.id), ["b3"]);
  } finally {
    await shim.stop();
  }
});

test("DELETE /v1/crons?conversation_id=… bulk-deletes by conversation", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [
      makeTask({ id: "c-a", agent_id: "agent-x", conversation_id: "conv-1" }),
      makeTask({ id: "c-b", agent_id: "agent-y", conversation_id: "conv-1" }),
      makeTask({ id: "c-c", agent_id: "agent-x", conversation_id: "conv-2" }),
    ]);
    // agent_id + conversation_id filter together.
    const res = await fetch(`${shim.url}/v1/crons?agent_id=agent-x&conversation_id=conv-1`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deleted: number };
    assert.equal(body.deleted, 1);
    const list = await (await fetch(`${shim.url}/v1/crons`)).json() as { tasks: CronTask[] };
    assert.deepEqual(list.tasks.map((t) => t.id).sort(), ["c-b", "c-c"]);
  } finally {
    await shim.stop();
  }
});

test("DELETE /v1/crons without filters returns 400 (refuse to wipe all)", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "keep" })]);
    const res = await fetch(`${shim.url}/v1/crons`, { method: "DELETE" });
    assert.equal(res.status, 400);
    const list = await (await fetch(`${shim.url}/v1/crons`)).json() as { tasks: CronTask[] };
    assert.equal(list.tasks.length, 1);
  } finally {
    await shim.stop();
  }
});

test("concurrent WS-write + REST-write: neither update is lost (lcp-5o9o)", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      // Fire a WS cron_add and a REST POST at the same instant. Both go
      // through lib/crons.ts addTask() under withLock(), so the second
      // writer must observe the first writer's row when it read-modify-writes
      // crons.json. If the lock were missing, one create would clobber the
      // other and only one task would survive.
      const wsAdd = (async () => {
        conn.send({
          type: "cron_add",
          agent_id: "agent-ws",
          name: "ws-task",
          prompt: "from ws",
          cron: "*/5 * * * *",
        });
        return conn.waitFor("cron_add_response", { timeoutMs: 5000 });
      })();
      const restAdd = fetch(`${shim.url}/v1/crons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "agent-rest",
          name: "rest-task",
          prompt: "from rest",
          cron: "*/5 * * * *",
        }),
      });
      const [, restRes] = await Promise.all([wsAdd, restAdd]);
      assert.equal(restRes.status, 201);

      // Both tasks must be present in the canonical store.
      const list = await (await fetch(`${shim.url}/v1/crons`)).json() as { tasks: CronTask[] };
      const names = list.tasks.map((t) => t.name).sort();
      assert.deepEqual(names, ["rest-task", "ws-task"], "both concurrent writers survived");
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("two concurrent REST POSTs both survive", async () => {
  const shim = await startShim();
  try {
    const mk = (n: string) => fetch(`${shim.url}/v1/crons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-z", name: n, prompt: "p", cron: "*/5 * * * *" }),
    });
    const results = await Promise.all([mk("one"), mk("two"), mk("three")]);
    for (const r of results) assert.equal(r.status, 201);
    const list = await (await fetch(`${shim.url}/v1/crons`)).json() as { tasks: CronTask[] };
    assert.deepEqual(list.tasks.map((t) => t.name).sort(), ["one", "three", "two"]);
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


test("GET /v1/agents/{agent}/schedule returns Letta-compatible scheduled messages", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [
      makeTask({ id: "sched-a", agent_id: "agent-a", prompt: "daily summary", cron: "0 8 * * *" }),
      makeTask({ id: "sched-b", agent_id: "agent-b", prompt: "other agent" }),
    ]);
    const res = await fetch(`${shim.url}/v1/agents/agent-a/schedule`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      has_next_page: boolean;
      scheduled_messages: Array<{
        id: string;
        agent_id: string;
        message: { messages: Array<{ role: string; content: string }> };
        schedule: { type: string; cron_expression?: string };
      }>;
    };
    assert.equal(body.has_next_page, false);
    assert.deepEqual(body.scheduled_messages.map((s) => s.id), ["sched-a"]);
    assert.equal(body.scheduled_messages[0]!.agent_id, "agent-a");
    assert.equal(body.scheduled_messages[0]!.message.messages[0]!.content, "daily summary");
    assert.equal(body.scheduled_messages[0]!.schedule.type, "recurring");
    assert.equal(body.scheduled_messages[0]!.schedule.cron_expression, "0 8 * * *");
  } finally {
    await shim.stop();
  }
});

test("GET /v1/agents/{agent}/schedule/{id} scopes schedules by agent", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, [makeTask({ id: "sched-a", agent_id: "agent-a" })]);
    const ok = await fetch(`${shim.url}/v1/agents/agent-a/schedule/sched-a`);
    assert.equal(ok.status, 200);
    const missingForOtherAgent = await fetch(`${shim.url}/v1/agents/agent-b/schedule/sched-a`);
    assert.equal(missingForOtherAgent.status, 404);
  } finally {
    await shim.stop();
  }
});

test("POST and DELETE /v1/agents/{agent}/schedule bridge to cron store", async () => {
  const shim = await startShim();
  try {
    seedCrons(shim, []);
    const create = await fetch(`${shim.url}/v1/agents/agent-a/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "write the weekly summary" }],
        schedule: { type: "recurring", cron_expression: "0 9 * * 1" },
      }),
    });
    assert.equal(create.status, 201);
    const created = await create.json() as { id: string; agent_id: string; schedule: { cron_expression?: string } };
    assert.equal(created.agent_id, "agent-a");
    assert.equal(created.schedule.cron_expression, "0 9 * * 1");

    const crons = await (await fetch(`${shim.url}/v1/crons?agent_id=agent-a`)).json() as { tasks: CronTask[] };
    assert.equal(crons.tasks.length, 1);
    assert.equal(crons.tasks[0]!.prompt, "write the weekly summary");

    const del = await fetch(`${shim.url}/v1/agents/agent-a/schedule/${created.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const after = await (await fetch(`${shim.url}/v1/agents/agent-a/schedule`)).json() as { scheduled_messages: unknown[] };
    assert.equal(after.scheduled_messages.length, 0);
  } finally {
    await shim.stop();
  }
});
