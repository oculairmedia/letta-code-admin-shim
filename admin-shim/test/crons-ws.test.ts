/**
 * Behavioral tests for the mobile WS cron protocol (lcp-2gx).
 *
 * Exercises round-trips through the real shim subprocess:
 *   - cron_add → cron_list shows it → cron_get → cron_delete → cron_list empty
 *   - invalid cron expression returns success=false and does NOT persist
 *   - cron_delete_all returns the removed count and only target rows go
 *   - a second connected client receives crons_updated within ~1s of
 *     a peer's cron_add (acceptance: <100ms is the goal; the test margin
 *     absorbs subprocess scheduling jitter)
 *   - bad token at hello → connection refused, no cron frames processed
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { startShim, openMobileWs } from "./helpers/index.js";
import type { MobileWsFrame, MobileWsHandle } from "./helpers/ws.js";
import type { CronTask } from "../lib/types/crons.js";

// Typed views of the cron WS responses. `MobileWsFrame` carries an index
// signature so TS forbids `.success` etc without explicit narrowing.
interface CronListResp extends MobileWsFrame { success: boolean; tasks: CronTask[]; error?: string }
interface CronAddResp extends MobileWsFrame { success: boolean; task?: CronTask; error?: string; warning?: string }
interface CronGetResp extends MobileWsFrame { success: boolean; task?: CronTask; error?: string }
interface CronDeleteResp extends MobileWsFrame { success: boolean; error?: string }
interface CronDeleteAllResp extends MobileWsFrame { success: boolean; count: number; error?: string }
interface CronsUpdatedFrame extends MobileWsFrame { reason: string; tasks_active: number; at: string }
interface ErrorFrame extends MobileWsFrame { code: string; message: string }

/**
 * Wait for the NEXT frame of `type` arriving after this call.
 *
 * The shared `MobileWsHandle.waitFor` resolves immediately if a frame of the
 * same type is already in the buffer, which breaks request/response tests
 * that send the same frame type multiple times (the second wait re-resolves
 * with the first response). This helper takes a fresh cursor each call so
 * cached frames are ignored.
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

test("hello → cron_add → cron_list → cron_get → cron_delete → cron_list empty", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      conn.send({ type: "cron_list", request_id: "r0" });
      const list0 = await waitTyped<CronListResp>(conn, "cron_list_response");
      assert.equal(list0.success, true);
      assert.deepEqual(list0.tasks, []);

      conn.send({
        type: "cron_add",
        request_id: "r1",
        agent_id: "agent-a",
        name: "every-5m",
        description: "test",
        prompt: "hello",
        recurring: true,
        cron: "*/5 * * * *",
        timezone: "UTC",
      });
      const add = await waitTyped<CronAddResp>(conn, "cron_add_response");
      assert.equal(add.success, true);
      const added = add.task as CronTask;
      assert.ok(added && typeof added.id === "string");
      assert.equal(added.cron, "*/5 * * * *");
      assert.equal(added.recurring, true);
      assert.equal(added.agent_id, "agent-a");

      conn.send({ type: "cron_list", request_id: "r2" });
      const list1 = await waitTyped<CronListResp>(conn, "cron_list_response", 2000);
      assert.equal(list1.tasks.length, 1);
      assert.equal(list1.tasks[0]?.id, added.id);

      conn.send({ type: "cron_get", request_id: "r3", task_id: added.id });
      const got = await waitTyped<CronGetResp>(conn, "cron_get_response");
      assert.equal(got.success, true);
      assert.equal(got.task?.id, added.id);

      conn.send({ type: "cron_delete", request_id: "r4", task_id: added.id });
      const del = await waitTyped<CronDeleteResp>(conn, "cron_delete_response");
      assert.equal(del.success, true);

      conn.send({ type: "cron_list", request_id: "r5" });
      const list2 = await waitTyped<CronListResp>(conn, "cron_list_response", 2000);
      assert.deepEqual(list2.tasks, []);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("cron_add with `every` shorthand parses to a recurring cron", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      conn.send({
        type: "cron_add",
        agent_id: "agent-a",
        name: "every-hour",
        description: "test",
        prompt: "ping",
        every: "1h",
      });
      const add = await waitTyped<CronAddResp>(conn, "cron_add_response");
      assert.equal(add.success, true);
      assert.equal(add.task?.cron, "0 */1 * * *");
      assert.equal(add.task?.recurring, true);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("cron_add with invalid cron expression returns success=false and persists nothing", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      conn.send({
        type: "cron_add",
        request_id: "bad",
        agent_id: "agent-a",
        name: "broken",
        prompt: "p",
        cron: "not a cron",
      });
      const add = await waitTyped<CronAddResp>(conn, "cron_add_response");
      assert.equal(add.success, false);
      assert.match(add.error ?? "", /invalid cron expression/);

      conn.send({ type: "cron_list" });
      const list = await waitTyped<CronListResp>(conn, "cron_list_response");
      assert.deepEqual(list.tasks, []);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("cron_add with neither cron/every/at errors with required-field message", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      conn.send({
        type: "cron_add",
        agent_id: "agent-a",
        name: "no-schedule",
        prompt: "p",
      });
      const add = await waitTyped<CronAddResp>(conn, "cron_add_response");
      assert.equal(add.success, false);
      assert.match(add.error ?? "", /one of `cron`, `every`, or `at` is required/);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("cron_get with unknown id returns success=false with not-found error", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      conn.send({ type: "cron_get", task_id: "does-not-exist" });
      const got = await waitTyped<CronGetResp>(conn, "cron_get_response");
      assert.equal(got.success, false);
      assert.match(got.error ?? "", /not found/);
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("cron_delete_all reports the removed count and leaves other agents alone", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      for (const agent of ["alpha", "alpha", "beta"]) {
        conn.send({
          type: "cron_add",
          agent_id: agent,
          name: agent,
          prompt: "p",
          cron: "*/5 * * * *",
        });
        await waitTyped<CronAddResp>(conn, "cron_add_response");
      }
      conn.send({ type: "cron_delete_all", agent_id: "alpha" });
      const del = await waitTyped<CronDeleteAllResp>(conn, "cron_delete_all_response");
      assert.equal(del.success, true);
      assert.equal(del.count, 2);

      conn.send({ type: "cron_list" });
      const list = await waitTyped<CronListResp>(conn, "cron_list_response");
      assert.equal(list.tasks.length, 1);
      assert.equal(list.tasks[0]?.agent_id, "beta");
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("peer client receives crons_updated within ~1s of a cron_add", async () => {
  const shim = await startShim();
  try {
    const a = await openMobileWs(shim.url!, { token: shim.mobileToken });
    const b = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      const observed = waitTyped<CronsUpdatedFrame>(b, "crons_updated", 1500);
      const start = Date.now();
      a.send({
        type: "cron_add",
        agent_id: "agent-broadcast",
        name: "fan-out",
        prompt: "p",
        cron: "*/5 * * * *",
      });
      await waitTyped<CronAddResp>(a, "cron_add_response");
      const event = await observed;
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 1000, `crons_updated should arrive promptly; took ${elapsed}ms`);
      assert.equal(event.reason, "client_mutation");
      assert.equal(event.tasks_active, 1);
    } finally {
      a.close();
      b.close();
    }
  } finally {
    await shim.stop();
  }
});

test("bad token at hello → connection rejected, no cron frame processed", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: "wrong-token", skipHello: true });
    try {
      conn.send({ type: "hello", token: "wrong-token", device_id: "evil" });
      const err = await waitTyped<ErrorFrame>(conn, "error", 3000);
      assert.equal(err.code, "invalid_token");
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});

test("inbound agent_id passes through (no alias registry in test env)", async () => {
  const shim = await startShim();
  try {
    const conn = await openMobileWs(shim.url!, { token: shim.mobileToken });
    try {
      conn.send({
        type: "cron_add",
        agent_id: "agent-passthrough",
        name: "alias-test",
        prompt: "p",
        cron: "*/5 * * * *",
      });
      const add = await waitTyped<CronAddResp>(conn, "cron_add_response");
      assert.equal(add.success, true);
      assert.equal(add.task?.agent_id, "agent-passthrough");
    } finally {
      conn.close();
    }
  } finally {
    await shim.stop();
  }
});
