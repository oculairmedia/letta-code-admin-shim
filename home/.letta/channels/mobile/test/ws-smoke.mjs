/**
 * WS smoke test for the mobile channel — Phase 1.
 *
 * Drives the channel end-to-end:
 *   1. Connect to ws://<host>:<port>/shim/v1/mobile
 *   2. hello → expect welcome
 *   3. send_message to a chosen (agent_id, conversation_id) → collect frames
 *      until stop_reason
 *   4. Assert frame ordering: turn_started → assistant_message+ → stop_reason
 *      → usage_statistics (the last two are reorderable; usage may be missing
 *      on some models)
 *   5. Assert at least one assistant_message arrived with non-empty content
 *   6. Time the round-trip
 *   7. Exit 0 on success, non-zero on any failed assertion
 *
 * Usage:
 *   node ws-smoke.mjs [--url ws://host:port/shim/v1/mobile] \
 *                     [--token <token>] \
 *                     [--agent <agent-id>] \
 *                     [--conv <conv-id>] \
 *                     [--text <message>]
 *
 * Defaults:
 *   url   ws://localhost:8291/shim/v1/mobile
 *   token MOBILE_CHANNEL_TOKEN env var, else "dev-mobile-token-change-me"
 *   agent agent-597b5756-2915-4560-ba6b-91005f085166 (migrated Meridian)
 *   conv  default
 *   text  "reply with one word: pong"
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  protocol violation (frame ordering, missing required frames)
 *   2  transport failure (WS error, auth rejection)
 *   3  timeout
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// Resolve `ws` from the admin-shim's node_modules so the test runs
// without a duplicate install in the channel dir. Override with
// --ws-from to point at a different module dir.
const args = process.argv;
function argv(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const wsFrom = argv(
  "ws-from",
  "/opt/stacks/letta-code-parallel/admin-shim",
);
const shimRequire = createRequire(`${wsFrom}/package.json`);
const WebSocket = shimRequire("ws");

const url = argv("url", "ws://localhost:8291/shim/v1/mobile");
const token =
  argv("token", process.env.MOBILE_CHANNEL_TOKEN ?? "dev-mobile-token-change-me");
const agentId = argv("agent", "agent-597b5756-2915-4560-ba6b-91005f085166");
const conversationId = argv("conv", "default");
const text = argv("text", "reply with one word: pong");
const timeoutMs = Number(argv("timeoutMs", "30000"));
const expectTool = argv("expect-tool", null); // tool name (e.g. "Bash") or null
const sentOtid = argv("otid", `cm-smoke-${randomUUID()}`);

console.log(`url=${url}`);
console.log(`agent=${agentId}`);
console.log(`conv=${conversationId}`);
console.log(`text=${text}`);
console.log("");

const startedAt = Date.now();
const frames = [];
let exitCode = 3; // assume timeout until otherwise
const timeoutHandle = setTimeout(() => {
  console.error(`[smoke] timeout after ${timeoutMs}ms`);
  process.exit(3);
}, timeoutMs);

const ws = new WebSocket(url);

function assertSeen(types) {
  for (const t of types) {
    if (!frames.some((f) => f.type === t)) {
      console.error(`[smoke] missing required frame type: ${t}`);
      return false;
    }
  }
  return true;
}

ws.on("open", () => {
  console.log(`[smoke] open ${Date.now() - startedAt}ms`);
  ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: randomUUID(),
      ts: new Date().toISOString(),
      token,
      device_id: `smoke-${randomUUID().slice(0, 8)}`,
      client_version: "ws-smoke/0.1",
    }),
  );
});

ws.on("message", (data) => {
  let frame;
  try {
    frame = JSON.parse(data.toString("utf8"));
  } catch (err) {
    console.error(`[smoke] unparseable frame: ${err.message}`);
    return;
  }
  frames.push(frame);
  const t = frame.type;
  const tag = `[${frames.length}] +${Date.now() - startedAt}ms ${t}`;
  if (t === "assistant_message")
    console.log(`${tag}  content=${JSON.stringify(frame.content).slice(0, 200)}`);
  else if (t === "stop_reason")
    console.log(`${tag}  reason=${frame.reason}`);
  else if (t === "error") console.error(`${tag}  ${frame.code}: ${frame.message}`);
  else console.log(tag);

  if (t === "error") {
    exitCode = 2;
    ws.close(4000, "auth failed");
    return;
  }
  if (t === "welcome") {
    ws.send(
      JSON.stringify({
        v: 1,
        type: "send_message",
        id: randomUUID(),
        ts: new Date().toISOString(),
        agent_id: agentId,
        conversation_id: conversationId,
        text,
        otid: sentOtid,
      }),
    );
  } else if (t === "turn_done") {
    // turn_done is the post-stamp sentinel. Close cleanly after we see it.
    setTimeout(() => {
      try { ws.close(1000, "done"); } catch {}
    }, 50);
  }
});

ws.on("close", (code) => {
  clearTimeout(timeoutHandle);
  const total = Date.now() - startedAt;
  console.log(`\n[smoke] close code=${code} total=${total}ms frames=${frames.length}`);

  // Assertions
  if (exitCode === 2) process.exit(2);
  const required = ["welcome", "turn_started", "assistant_message", "stop_reason", "turn_done"];
  if (!assertSeen(required)) process.exit(1);
  const turnStartedIdx = frames.findIndex((f) => f.type === "turn_started");
  const stopIdx = frames.findIndex((f) => f.type === "stop_reason");
  const doneIdx = frames.findIndex((f) => f.type === "turn_done");
  if (turnStartedIdx >= stopIdx) {
    console.error("[smoke] turn_started must precede stop_reason");
    process.exit(1);
  }
  if (stopIdx >= doneIdx) {
    console.error("[smoke] turn_done must come after stop_reason");
    process.exit(1);
  }
  const assistantWithContent = frames.find(
    (f) => f.type === "assistant_message" && typeof f.content === "string" && f.content.length > 0,
  );
  if (!assistantWithContent) {
    console.error("[smoke] no assistant_message with non-empty content");
    process.exit(1);
  }
  // run_id must appear on every turn frame after turn_started (turn_started
  // itself fires before the run is created so it's allowed to be missing).
  const turnFrames = frames.filter((f) =>
    ["assistant_message", "tool_call_message", "tool_return_message", "stop_reason", "usage_statistics", "turn_done"].includes(f.type),
  );
  const missingRun = turnFrames.filter((f) => !f.run_id);
  if (missingRun.length > 0) {
    console.error(`[smoke] ${missingRun.length} turn frames missing run_id: ${missingRun.map((f) => f.type).join(",")}`);
    process.exit(1);
  }
  // Tool-call assertion (opt-in): if --expect-tool=Bash is set, require a
  // tool_call_message with matching name and a tool_return_message paired
  // by tool_call_id.
  if (expectTool) {
    const toolCall = frames.find(
      (f) => f.type === "tool_call_message" && f.tool_call?.name === expectTool,
    );
    if (!toolCall) {
      console.error(`[smoke] expected tool_call_message with name=${expectTool}, not seen`);
      process.exit(1);
    }
    const tcid = toolCall.tool_call?.tool_call_id;
    // Note: letta-code's stream omits tool_return_message; the disk projection
    // emits it. The WS path only sees stream frames, so tool_return is NOT
    // expected over the wire — mobile picks it up via the post-turn GET.
    console.log(`[smoke] tool_call ok tool=${expectTool} tcid=${tcid}`);
  }
  console.log("[smoke] PASS");
  process.exit(0);
});

ws.on("error", (err) => {
  clearTimeout(timeoutHandle);
  console.error(`[smoke] socket error: ${err.message}`);
  process.exit(2);
});
