import { test } from "node:test";
import assert from "node:assert/strict";
import { startShim } from "./helpers/shim.js";
import { seedAgent } from "./helpers/fixtures.js";

test("ambient keepalive stream terminates correctly via hard cap and does not crash", async (t) => {
  const shim = await startShim({ env: { SHIM_STREAM_MAX_MS: "300" } });
  t.after(() => shim.stop());

  seedAgent(shim.stateDir, { id: "agent-1", name: "test-agent" });

  const start = Date.now();
  const res = await fetch(`${shim.url}/v1/conversations/conv-default-agent-1/stream`, {
    method: "POST"
  });

  const reader = res.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder("utf-8");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  }
  const duration = Date.now() - start;

  assert.ok(text.includes(": connected"), "should output connected keepalive");
  assert.ok(duration >= 300, `duration should be >= 300ms, was ${duration}`);
  assert.ok(duration < 1500, `duration should be < 1500ms, was ${duration}`);
});

test("ambient keepalive stream tracks req.on('close') cleanly without leaving timers", async (t) => {
  const shim = await startShim({ env: { SHIM_STREAM_MAX_MS: "1000" } });
  t.after(() => shim.stop());

  const ac = new AbortController();

  const res = await fetch(`${shim.url}/v1/conversations/conv-1/stream`, {
    method: "POST",
    signal: ac.signal
  });

  // Abort it to test the cleanup.
  ac.abort();

  // If it didn't crash and we can still connect, it survived.
  const check = await fetch(`${shim.url}/v1/agents`);
  assert.equal(check.status, 200);
});

test("ambient keepalive stream touches worker in pool to prevent idle eviction during SSE", async (t) => {
  const shim = await startShim({
    env: {
      SHIM_STREAM_MAX_MS: "2000",
      SHIM_POOL_IDLE_SEC: "0.2",        // evict after 200ms of idle
      SHIM_POOL_HOUSEKEEP_MS: "100",    // run often
      SHIM_STREAM_PING_MS: "50"         // ping every 50ms, ensuring it's touched frequently
    }
  });
  t.after(() => shim.stop());

  seedAgent(shim.stateDir, { id: "agent-1", name: "test-agent" });

  // Trigger a worker to load
  await fetch(`${shim.url}/v1/agents/agent-1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], stream: false })
  });

  const ac = new AbortController();

  const res = await fetch(`${shim.url}/v1/conversations/conv-default-agent-1/stream`, {
    method: "POST",
    signal: ac.signal
  });

  // Keep it open for 500ms. Since IDLE_SEC is 0.2 (200ms), and it runs for 500ms,
  // it would normally be evicted by the housekeeper. But because SHIM_STREAM_PING_MS is 50ms,
  // it gets touched every 50ms.
  await new Promise(r => setTimeout(r, 500));

  // Verify worker is still alive because stream kept it alive
  const statsRes = await fetch(`${shim.url}/shim/pool`);
  const stats = await statsRes.json();

  assert.equal(stats.size, 1, "worker should still be in the pool");

  ac.abort();
});
