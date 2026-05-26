#!/usr/bin/env node
/**
 * lcp-sdk.9 — automated smoke for SHIM_LETTA_TRANSPORT=sdk.
 *
 * Exercises scenarios 1–3 from docs/SDK_TRANSPORT_SMOKE.md:
 *   1. Text-only REST/SSE turn
 *   2. Text-only mobile WS turn
 *   3. Multi-step / tool turn
 *
 * Scenarios 4–9 (approval, A2UI, cancel, disconnect/replay, conv stability)
 * require either a real model + tool execution, or hand-rolled mobile
 * interactions that don't lend themselves to a one-shot CLI. They stay in
 * the manual checklist in the runbook.
 *
 * Usage:
 *
 *   SHIM_URL=http://localhost:8291 \
 *   AGENT_ID=agent-597b5756-... \
 *   MOBILE_TOKEN=... \
 *     node admin-shim/scripts/smoke-sdk-transport.mjs
 *
 * Exits 0 if all scenarios pass. Exits non-zero on the first failure with
 * a triage hint. Designed to be safe to re-run — every turn uses a
 * unique otid so re-runs don't collide with each other.
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const SHIM_URL = process.env["SHIM_URL"] ?? "http://localhost:8291";
const AGENT_ID = process.env["AGENT_ID"];
const MOBILE_TOKEN = process.env["MOBILE_TOKEN"];
const PROMPT_TEXT = process.env["SMOKE_TEXT"] ?? "reply with pong";
const PROMPT_TOOL = process.env["SMOKE_TOOL"] ?? "use bash to run echo hello";
const TURN_TIMEOUT_MS = Number(process.env["SMOKE_TIMEOUT_MS"] ?? 30_000);

if (!AGENT_ID) {
  console.error("AGENT_ID env var is required (e.g. AGENT_ID=agent-597b5756-...)");
  process.exit(2);
}

/** @param {string} label */
function pass(label) {
  console.log(`PASS  ${label}`);
}

/** @param {string} label @param {string} hint */
function fail(label, hint) {
  console.error(`FAIL  ${label}`);
  console.error(`      ${hint}`);
  process.exit(1);
}

// ── Scenario 1: REST/SSE ───────────────────────────────────────────────

async function smokeRestSse() {
  const label = "scenario 1 — REST/SSE text-only turn";
  const res = await fetch(`${SHIM_URL}/v1/agents/${AGENT_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: `${PROMPT_TEXT} [otid:${randomUUID()}]` }],
      stream_tokens: true,
    }),
  });
  if (!res.ok || !res.body) {
    fail(label, `HTTP ${res.status} ${res.statusText} — is the shim running at ${SHIM_URL}?`);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen = new Set();
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let assistantText = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        seen.add("DONE");
        continue;
      }
      try {
        const ev = JSON.parse(payload);
        if (typeof ev.message_type === "string") seen.add(ev.message_type);
        if (ev.message_type === "assistant_message" && typeof ev.content === "string") {
          assistantText += ev.content;
        }
      } catch {
        // forward-compat: ignore unparseable lines
      }
    }
    if (seen.has("DONE")) break;
  }
  if (!seen.has("DONE")) {
    fail(label, `stream did not terminate within ${TURN_TIMEOUT_MS}ms; saw frame types: ${[...seen].join(",")}. Set DEBUG_SDK=1 on the shim to diagnose.`);
    return;
  }
  if (!seen.has("assistant_message")) {
    fail(label, "no assistant_message frames — CLI subprocess started but emitted nothing. Check LETTA_CLI_PATH and that the binary supports --include-partial-messages.");
    return;
  }
  if (!seen.has("stop_reason")) {
    fail(label, "no stop_reason frame — turn truncated. Set DEBUG_SDK=1 and look for `stream ended WITHOUT a result message`.");
    return;
  }
  pass(`${label} (${assistantText.length} chars assistant text, types: ${[...seen].sort().join(",")})`);
}

// ── Scenario 2: mobile WS ──────────────────────────────────────────────

/** @param {WebSocket} ws @param {(f: any) => boolean} pred @param {number} timeoutMs */
function waitForFrame(ws, pred, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`waitForFrame timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    /** @param {Buffer} data */
    const onMsg = (data) => {
      let f;
      try { f = JSON.parse(data.toString("utf8")); } catch { return; }
      if (pred(f)) {
        clearTimeout(t);
        ws.off("message", onMsg);
        resolve(f);
      }
    };
    ws.on("message", onMsg);
  });
}

/** @param {string} prompt @param {string} label */
async function smokeMobileWs(prompt, label) {
  const wsUrl = SHIM_URL.replace(/^http/, "ws") + "/shim/v1/mobile";
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

  const helloFrame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: "hello",
    device_id: `smoke-${randomUUID().slice(0, 8)}`,
    client_version: "smoke-sdk-1",
    ...(MOBILE_TOKEN ? { token: MOBILE_TOKEN } : {}),
  };
  ws.send(JSON.stringify(helloFrame));
  await waitForFrame(ws, (f) => f.type === "welcome", TURN_TIMEOUT_MS);

  ws.send(JSON.stringify({
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: "send_message",
    agent_id: AGENT_ID,
    conversation_id: `conv-default-${AGENT_ID}`,
    text: `${prompt} [otid:${randomUUID()}]`,
    otid: `ot-smoke-${randomUUID().slice(0, 8)}`,
  }));

  const turnDone = await waitForFrame(
    ws,
    (f) => f.type === "turn_done",
    TURN_TIMEOUT_MS,
  );
  ws.close();

  if (turnDone.status !== "completed") {
    fail(label, `turn_done status=${turnDone.status} error_code=${turnDone.error_code} error_message=${turnDone.error_message}`);
    return;
  }
  if (!turnDone.run_id) {
    fail(label, "turn_done carried no run_id — the shim run record is missing; check /v1/runs/ surface");
    return;
  }
  pass(`${label} (run_id=${turnDone.run_id})`);
  return turnDone.run_id;
}

// ── Scenario 3: tool turn → /v1/runs/<id> sanity check ─────────────────

/** @param {string} runId */
async function smokeRunRecord(runId) {
  const label = "scenario 3 — tool turn run record";
  const res = await fetch(`${SHIM_URL}/v1/runs/${runId}`);
  if (!res.ok) {
    fail(label, `GET /v1/runs/${runId} returned ${res.status}`);
    return;
  }
  /** @type {any} */
  const run = await res.json();
  if (run.status !== "completed") {
    fail(label, `run status=${run.status} (expected completed)`);
    return;
  }
  pass(`${label} (status=${run.status}, agent=${run.agent_id})`);
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`SDK transport smoke against ${SHIM_URL} (agent=${AGENT_ID})`);
  await smokeRestSse();
  await smokeMobileWs(PROMPT_TEXT, "scenario 2 — mobile WS text-only turn");
  const toolRunId = await smokeMobileWs(PROMPT_TOOL, "scenario 3 — mobile WS tool turn");
  if (toolRunId) await smokeRunRecord(toolRunId);
  console.log("All automated scenarios passed. Continue with manual scenarios 4–9 (see docs/SDK_TRANSPORT_SMOKE.md).");
}

main().catch((err) => {
  console.error(`SMOKE FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
