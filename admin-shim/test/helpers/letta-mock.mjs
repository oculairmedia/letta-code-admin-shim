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

/** @param {string} content */
function emitTurn(content) {
  const traceName = pickTrace(content);
  const frames = loadTrace(traceName);
  // Skip the init frame from the trace (we already emitted one). All other
  // frames replay in order. Add a tiny delay between frames so SSE streaming
  // tests can observe the time ordering.
  const delay = Number(process.env["LETTA_MOCK_DELAY_MS"] ?? 0);
  let i = 1;
  const tick = () => {
    if (i >= frames.length) return;
    emit(rewrite(frames[i]));
    i += 1;
    if (delay > 0) setTimeout(tick, delay);
    else tick();
  };
  tick();
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg?.type !== "user") return;
  const content = msg?.message?.content ?? "";
  emitTurn(content);
});
rl.on("close", () => {
  process.exit(0);
});
