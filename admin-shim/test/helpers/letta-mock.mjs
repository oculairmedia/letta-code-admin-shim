#!/usr/bin/env node
// Kept as .mjs (not converted to .ts in Phase 6a): spawned as a standalone
// `node <path>` subprocess by agent-pool via LETTA_BIN, so it must be
// directly runnable by node without a tsx loader.
/**
 * Mock `letta` binary — replays captured stream-json traces so the shim
 * can be tested without a real model.
 *
 * Captured traces live in admin-shim/test/fixtures/stream-traces/*.jsonl
 * (one JSON frame per line). The mock chooses which trace to replay by
 * matching the incoming user message against env-configured rules.
 *
 * Invocation surface mirrors the real letta CLI as the agent pool uses it:
 *   letta-mock --backend local
 *              [--agent <id> | --conversation <id> [--agent <id>]]
 *              --input-format stream-json
 *              --output-format stream-json
 *              --include-partial-messages
 *
 * The mock honors:
 *   - --agent <id>            → stamped onto every output frame
 *   - --conversation <id>     → ditto (defaults to "default")
 *   - stdin                   → newline-delimited stream-json
 *                               `{type:"user", message:{content:"..."}}`
 *                               One per turn. The mock blocks on stdin
 *                               between turns just like real letta.
 *
 * Trace selection (first match wins):
 *   - LETTA_MOCK_FORCE_TRACE  → use exactly this fixture for every turn
 *   - LETTA_MOCK_STOP_REASON  → rewrite stop_reason frames to this value
 *   - input.content contains "bash" / "shell" / "echo" → bash-tool
 *   - input.content contains "read" / "file" → read-tool
 *   - input.content contains "list" / "bullet" / "step" → multi-step
 *   - input.content contains "nothing" / "empty" → empty-reply
 *   - default → plain
 *
 * Frames are rewritten so {agent_id, conversation_id, session_id} reflect
 * the spawn args. Sentinel dates and run_ids are kept as-is so tests can
 * assert on them.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures", "stream-traces");

const args = process.argv.slice(2);
/** @param {string} name */
function argOf(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}
const agentId = argOf("agent") ?? "agent-mock";
const conversationId = argOf("conversation") ?? "default";
const sessionId = agentId;

/**
 * @param {string} name
 * @returns {any[]}
 */
function loadTrace(name) {
  const path = join(FIXTURES_DIR, `${name}.jsonl`);
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** @param {string} content */
function pickTrace(content) {
  const forced = process.env["LETTA_MOCK_FORCE_TRACE"];
  if (forced) return forced;
  const t = (content ?? "").toLowerCase();
  // Order matters — most specific first.
  if (/(approval card|a2ui|show .*card|render.*approval|approve.*scope)/.test(t)) return "a2ui-card";
  if (/(interleav|step-a|one at a time|three.*step)/.test(t)) return "interleaved-tools";
  if (/(both.*tool|two.*tool|bash.*and.*read|multi.*tool)/.test(t)) return "multi-tool-bash-read";
  if (/(tool.*then|then explain|long explanation|paragraph)/.test(t) && /(bash|shell|echo)/.test(t)) {
    return "tool-then-text";
  }
  if (/(3 paragraph|long text|essay|explain in)/.test(t)) return "text-only-long";
  if (/(empty|nothing at all|no response)/.test(t)) return "empty-reply";
  if (/(bash|shell|echo|pwd|whoami)/.test(t)) return "bash-tool";
  if (/(read tool|read the file|use the read)/.test(t)) return "read-tool";
  if (/(bullet|list \d|three|3 short)/.test(t)) return "multi-step";
  return "plain";
}

// Monotonic per-turn run id. Captured traces all carry the same
// `local-run-1`, but real letta-code generates a fresh run id per turn —
// and the SDK Session filters out frames whose run_id appears in the
// previous turn's `lastCompletedRunIds`, so reusing the same id silently
// drops every frame on turn 2+ of an SDK-transport session. Bumping per
// turn matches the real CLI and keeps multi-turn SDK tests viable.
let currentTurnRunId = "local-run-1";

/** @param {any} frame */
function rewrite(frame) {
  // Stamp the active agent/conv/session onto every frame so consumers
  // see consistent ids. The captured fixtures use the real Meridian id;
  // we substitute the spawn-arg id here.
  const f = JSON.parse(JSON.stringify(frame));
  if (f.session_id) f.session_id = sessionId;
  if (f.agent_id) f.agent_id = agentId;
  if (f.conversation_id) f.conversation_id = conversationId;
  if (f.event && typeof f.event === "object") {
    if (f.event.agent_id) f.event.agent_id = agentId;
    if (f.event.conversation_id) f.event.conversation_id = conversationId;
    if (typeof f.event.run_id === "string" && f.event.run_id.startsWith("local-run-")) {
      f.event.run_id = currentTurnRunId;
    }
    const forcedStopReason = process.env["LETTA_MOCK_STOP_REASON"];
    if (
      typeof forcedStopReason === "string" &&
      forcedStopReason.length > 0 &&
      f.event.message_type === "stop_reason"
    ) {
      f.event.stop_reason = forcedStopReason;
    }
  }
  return f;
}

/** @param {any} frame */
function emit(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

// Emit the captured init frame from `plain` first (it carries the same
// tools list etc. across all traces). Honor LETTA_MOCK_TOOLS to override.
const initTrace = loadTrace("plain");
const initFrame = rewrite(initTrace[0]);
if (process.env["LETTA_MOCK_TOOLS"]) {
  initFrame.tools = process.env["LETTA_MOCK_TOOLS"].split(",").map((/** @type {string} */ s) => s.trim());
}
if (process.env["LETTA_MOCK_MODEL"]) {
  initFrame.model = process.env["LETTA_MOCK_MODEL"];
}
emit(initFrame);

/** @type {any[] | null} */
let pendingApprovalFrames = null;

let turnCounter = 0;

/**
 * lcp-2oxb.1: synthesize extra assistant_message partial-delta frames so the
 * bench-stream-turn benchmark can exercise the full frame-append / subscribeToRun
 * hot path with a realistic frame volume.
 *
 * Controlled by LETTA_MOCK_DELTA_FRAMES (integer, default 0). When > 0, the mock
 * injects that many additional stream_event/assistant_message delta frames
 * immediately before the stop_reason frame. Each synthetic frame carries a
 * short `delta` text token so the frame shape is valid but compact.
 *
 * @param {any[]} frames - Mutable frame list for this turn (index 0 = init, already skipped).
 * @param {number} deltaCount - How many extra delta frames to inject.
 */
function injectDeltaFrames(frames, deltaCount) {
  if (deltaCount <= 0) return frames;
  // Find the stop_reason frame index so we can splice before it.
  const stopIdx = frames.findIndex(
    (f) => f?.type === "stream_event" && f?.event?.message_type === "stop_reason",
  );
  const insertAt = stopIdx >= 0 ? stopIdx : frames.length - 1;
  const now = new Date().toISOString();
  const synthFrames = [];
  for (let k = 0; k < deltaCount; k++) {
    synthFrames.push({
      type: "stream_event",
      event: {
        message_type: "assistant_message",
        id: `synth-delta-${currentTurnRunId}-${k}`,
        date: now,
        agent_id: agentId,
        conversation_id: conversationId,
        run_id: currentTurnRunId,
        seq_id: 9000 + k,
        otid: null,
        content: [{ type: "text", text: ` d${k}` }],
      },
      session_id: sessionId,
      uuid: `synth-uuid-${currentTurnRunId}-${k}`,
      timestamp: now,
    });
  }
  return [
    ...frames.slice(0, insertAt),
    ...synthFrames,
    ...frames.slice(insertAt),
  ];
}

/** @param {string} content */
function emitTurn(content) {
  turnCounter += 1;
  currentTurnRunId = `local-run-${turnCounter}`;
  const traceName = pickTrace(content);
  let frames = loadTrace(traceName);
  // lcp-2oxb.1: inject extra delta frames when LETTA_MOCK_DELTA_FRAMES is set.
  const deltaFrames = Number(process.env["LETTA_MOCK_DELTA_FRAMES"] ?? 0);
  if (deltaFrames > 0) {
    frames = injectDeltaFrames(frames, deltaFrames);
  }
  // Skip the init frame from the trace (we already emitted one). All other
  // frames replay in order. Add a tiny delay between frames so SSE streaming
  // tests can observe the time ordering.
  const delay = Number(process.env["LETTA_MOCK_DELAY_MS"] ?? 0);
  let i = 1;
  const approvalGate = process.env["LETTA_MOCK_APPROVAL_GATE"] === "1";
  const tick = () => {
    if (i >= frames.length) return;
    const frame = rewrite(frames[i]);
    emit(frame);
    i += 1;
    if (
      approvalGate &&
      frame?.type === "stream_event" &&
      frame?.event?.message_type === "stop_reason" &&
      frame?.event?.stop_reason === "requires_approval"
    ) {
      pendingApprovalFrames = frames.slice(i).map(rewrite);
      return;
    }
    if (delay > 0) setTimeout(tick, delay);
    else tick();
  };
  tick();
}

/** @param {unknown} reason */
function emitApprovalDenial(reason) {
  const now = new Date().toISOString();
  emit({
    type: "stream_event",
    event: {
      id: `approval-denied-${Date.now()}`,
      date: now,
      agent_id: agentId,
      conversation_id: conversationId,
      message_type: "assistant_message",
      content: [{ type: "text", text: `Tool call denied: ${reason}` }],
      run_id: "local-run-denied",
      seq_id: 1,
    },
    session_id: sessionId,
    uuid: `approval-denied-${Date.now()}`,
    timestamp: now,
  });
  emit({
    type: "stream_event",
    event: { message_type: "stop_reason", stop_reason: "end_turn", run_id: "local-run-denied", seq_id: 2 },
    session_id: sessionId,
    uuid: `approval-denied-stop-${Date.now()}`,
    timestamp: now,
  });
  emit({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    duration_ms: 1,
    duration_api_ms: 0,
    num_turns: 1,
    result: `Tool call denied: ${reason}`,
    agent_id: agentId,
    conversation_id: conversationId,
    run_ids: [],
    usage: null,
    uuid: `result-denied-${Date.now()}`,
    timestamp: now,
  });
}

/**
 * lcp-dlj: letta-code's headless mode accepts content as either a string
 * (legacy) or an Anthropic-style content-parts array (multimodal). The
 * mock matches traces against text content via regex, so flatten arrays
 * to the concatenation of their `text` parts. Image parts are ignored
 * for trace selection — the mock isn't a real model.
 *
 * @param {unknown} content
 * @returns {string}
 */
function flattenContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    return parts.join(" ");
  }
  return "";
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg?.type === "approval" || msg?.type === "approval_response") {
    const approved = msg?.message?.approve === true || msg?.message?.approvals?.[0]?.approve === true;
    const directApproval = msg?.approvals?.[0];
    const approvedViaDirect = directApproval?.type === "tool" || directApproval?.approve === true;
    const deniedViaDirect = directApproval?.approve === false;
    const finalApproved = approved || approvedViaDirect;
    const reason = directApproval?.reason ?? msg?.message?.reason ?? msg?.message?.approvals?.[0]?.reason ?? "approval_response";
    const frames = pendingApprovalFrames;
    pendingApprovalFrames = null;
    if (!frames) return;
    if (finalApproved && !deniedViaDirect) {
      for (const frame of frames) emit(frame);
    } else {
      emitApprovalDenial(String(reason));
    }
    return;
  }
  if (msg?.type !== "user") return;
  emitTurn(flattenContentToText(msg?.message?.content));
});
rl.on("close", () => {
  process.exit(0);
});
