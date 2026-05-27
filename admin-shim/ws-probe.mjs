#!/usr/bin/env node
// Synthetic mobile WS client — drives the shim's /shim/v1/mobile endpoint
// to ground-truth what frames the shim emits on the WS for a turn that
// involves tool calls.
//
// HISTORY (Meridian → future-me, 2026-05-24):
//   Built during the lcp-4vz investigation when I needed to reproduce
//   "tool returns disappear on mobile WS" WITHOUT the Android app in the
//   loop. This script saved the diagnosis — once I could see what the
//   shim was actually emitting on the wire (vs. what mobile claimed to
//   render), the bug located itself in two probes.
//
//   It is now a permanent regression artifact. If you suspect tool-call
//   flow has regressed (cards stuck, missing returns, wrong correlation),
//   run this BEFORE touching mobile.
//
// USAGE:
//   1. Create a fresh probe conversation so you don't pollute live agent state:
//        curl -s -X POST http://127.0.0.1:8291/v1/conversations \
//          -H 'Content-Type: application/json' \
//          -d '{"agent_id":"<your-agent-id>","name":"probe"}'
//   2. Set CONV_ID env to the returned conv-... id
//   3. Run from inside admin-shim/ (so `ws` resolves):
//        cd /opt/stacks/letta-code-parallel/admin-shim
//        CONV_ID=conv-xxx node ./ws-probe.mjs "Run two bash calls: date and uptime"
//
// WHAT TO LOOK FOR IN THE SUMMARY:
//   - "Calls WITHOUT matching return" should be 0
//   - "Returns WITHOUT matching call" should be 0
//   - "lossy=false drop_count=0" in the turn_done line
//
// PER-TOOL TIMING:
//   Each `tool_return_message` should arrive within seconds of its
//   matching `tool_call_message` (per lcp-pgw — incremental disk-watch).
//   If they all arrive in a batch at the end of the turn, the watcher
//   regressed and you're back to lcp-pgw's "v1" behavior.
//
// CORRELATED INFRA:
//   - DEBUG_SDK=1 in lettashim.service.d/sdk-smoke.conf → /tmp/admin-shim.log
//     gets SDK_MSG lines (from letta-sdk-adapter.ts probe) and wire-body
//     dumps (from the node_modules SDK patch). Both are critical when
//     this probe shows surprising results.
//
// ENV:
//   SHIM_PORT (default 8291) — shim listener
//   CONV_ID (default this Meridian's live conv — OVERRIDE for probes!)
//   PROBE_AUTO_APPROVE (default on; set to "0" to leave approvals pending)

import { WebSocket } from "ws";

const PORT = process.env["SHIM_PORT"] ?? "8291";
const URL = `ws://127.0.0.1:${PORT}/shim/v1/mobile`;
const AGENT_ID = "agent-597b5756-2915-4560-ba6b-91005f085166";
const CONV_ID = process.env["CONV_ID"] ?? "conv-66a8fcec-1fb5-4c1d-b4ce-c845cba0509c";
const TEXT = process.argv[2] ?? "Run three quick bash commands: 'date', 'whoami', and 'uptime'. One sentence reply.";

const startedAt = Date.now();
const t = () => `${((Date.now() - startedAt) / 1000).toFixed(2)}s`;
/** @param {...unknown} args */
const log = (...args) => console.log(`[${t()}]`, ...args);

/** @type {Map<string, number>} */
const seenTypes = new Map(); // type -> count
/** @type {Set<string>} */
const seenToolCallIds = new Set();
/** @type {Set<string>} */
const seenToolReturnIds = new Set();
/** @type {string | null} */
let runId = null;
let turnDone = false;
/** @type {{ code: number; reason: string } | null} */
let wsCloseInfo = null;

const ws = new WebSocket(URL);

/** @param {unknown} value */
function isRecord(value) {
  return Boolean(value) && typeof value === "object";
}

/** @param {Record<string, unknown>} frame @param {string} key */
function stringField(frame, key) {
  const value = frame[key];
  return typeof value === "string" ? value : undefined;
}

ws.on("open", () => {
  log("WS open →", URL);
  ws.send(JSON.stringify({
    v: 1,
    type: "hello",
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    token: "probe-no-auth-dev",
    device_id: "probe-device-" + process.pid,
    client_version: "ws-probe/1.0",
    // lcp ws-handler.mjs:341 — negotiate A2UI so the approval flow engages
    a2ui_version: "0.9",
    supported_catalogs: ["basic"],
    supported_widgets: ["Text", "Card", "Column", "Row", "Button"],
  }));
});

ws.on("message", (raw) => {
  /** @type {unknown} */
  let parsed;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { log("BAD JSON:", raw.toString("utf8").slice(0, 200)); return; }
  if (!isRecord(parsed)) {
    log("BAD FRAME:", raw.toString("utf8").slice(0, 200));
    return;
  }
  const f = /** @type {Record<string, unknown>} */ (parsed);
  const type = stringField(f, "type") ?? "<no-type>";
  seenTypes.set(type, (seenTypes.get(type) ?? 0) + 1);

  // Compact per-type logging — show full payload for the interesting ones.
  if (type === "welcome") {
    log("welcome", JSON.stringify({ server_id: f["server_id"], session_id: f["session_id"] }));
    // Send the send_message
    setTimeout(() => {
      const otid = "probe-otid-" + Date.now();
      log("→ send_message otid=", otid);
      ws.send(JSON.stringify({
        v: 1, type: "send_message", id: crypto.randomUUID(), ts: new Date().toISOString(),
        agent_id: AGENT_ID, conversation_id: CONV_ID, text: TEXT, otid,
      }));
    }, 50);
  } else if (type === "turn_started") {
    runId = stringField(f, "run_id") ?? null;
    log("turn_started run_id=", runId);
  } else if (type === "tool_call_message") {
    const toolCalls = f["tool_calls"];
    const tc = isRecord(f["tool_call"])
      ? /** @type {Record<string, unknown>} */ (f["tool_call"])
      : Array.isArray(toolCalls) && isRecord(toolCalls[0])
        ? /** @type {Record<string, unknown>} */ (toolCalls[0])
        : null;
    const tcid = tc ? stringField(tc, "tool_call_id") : undefined;
    if (tcid) seenToolCallIds.add(tcid);
    log(`tool_call_message id=${f["id"]} tool_call_id=${tcid} name=${tc ? tc["name"] : undefined}`);
    // AUTO-APPROVE: send a user_action with tool_approval_response. The shim's
    // approval gate is keyed by run_id (waitForApprovalDecision); the scope
    // field on this action drives Once/Session/Forever caching.
    if (tcid && process.env["PROBE_AUTO_APPROVE"] !== "0") {
      const actionId = "probe-approve-" + tcid;
      log(`→ user_action APPROVE for ${tcid}`);
      ws.send(JSON.stringify({
        v: 1, type: "user_action", id: crypto.randomUUID(), ts: new Date().toISOString(),
        run_id: runId, turn_id: null, surface_id: null,
        name: "tool_approval_response",
        action_id: actionId,
        context: { scope: "Session", decision: "approve", tool_call_id: tcid },
      }));
    }
  } else if (type === "tool_return_message") {
    const tcid = stringField(f, "tool_call_id");
    if (tcid) seenToolReturnIds.add(tcid);
    const toolReturn = stringField(f, "tool_return") ?? "";
    log(`tool_return_message id=${f["id"]} tool_call_id=${tcid} status=${f["status"]} body_len=${toolReturn.length}`);
  } else if (type === "assistant_message") {
    const content = stringField(f, "content") ?? "";
    log(`assistant_message id=${f["id"]} seq_id=${f["seq_id"]} content_len=${content.length}`);
  } else if (type === "stop_reason") {
    log(`stop_reason=${f["stop_reason"]}`);
  } else if (type === "turn_done") {
    turnDone = true;
    log(`turn_done status=${f["status"]} lossy=${f["lossy"]} drop_count=${f["drop_count"]}`);
    setTimeout(() => ws.close(1000, "probe complete"), 100);
  } else if (type === "ping") {
    // Send pong so we don't trip the idle timer
    ws.send(JSON.stringify({ v: 1, type: "pong", id: crypto.randomUUID(), ts: new Date().toISOString() }));
    log("← pong (replying to ping)");
  } else if (type === "error") {
    log(`ERROR code=${f["code"]} message=${f["message"]}`);
  } else if (type === "usage_statistics" || type === "reasoning_message") {
    // Quiet — not relevant to this probe
  } else {
    log(`${type} ${JSON.stringify(f).slice(0, 200)}`);
  }
});

ws.on("close", (code, reason) => {
  wsCloseInfo = { code, reason: reason?.toString() };
  log(`WS close code=${code} reason=${reason?.toString()}`);
  summary();
  process.exit(0);
});

ws.on("error", (err) => { log("WS error:", err.message); });

// Hard 90s cap
setTimeout(() => {
  log("TIMEOUT 90s — closing");
  try { ws.close(1000, "probe timeout"); } catch {}
  setTimeout(() => { summary(); process.exit(2); }, 200);
}, 90_000);

function summary() {
  console.log("\n========== SUMMARY ==========");
  console.log(`run_id: ${runId}`);
  console.log(`turn_done received: ${turnDone}`);
  console.log(`WS close: code=${wsCloseInfo?.code} reason=${wsCloseInfo?.reason}`);
  console.log("Frame counts by type:");
  for (const [type, count] of [...seenTypes.entries()].sort()) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`Distinct tool_call_id values seen in tool_call_message: ${seenToolCallIds.size}`);
  console.log(`Distinct tool_call_id values seen in tool_return_message: ${seenToolReturnIds.size}`);
  const calls = [...seenToolCallIds];
  const returns = [...seenToolReturnIds];
  const callsWithoutReturn = calls.filter(id => !seenToolReturnIds.has(id));
  const returnsWithoutCall = returns.filter(id => !seenToolCallIds.has(id));
  console.log(`Calls WITHOUT matching return: ${callsWithoutReturn.length}`);
  if (callsWithoutReturn.length) console.log("  →", callsWithoutReturn.slice(0, 5).join(", "));
  console.log(`Returns WITHOUT matching call: ${returnsWithoutCall.length}`);
  if (returnsWithoutCall.length) console.log("  →", returnsWithoutCall.slice(0, 5).join(", "));
  console.log("=============================");
}
