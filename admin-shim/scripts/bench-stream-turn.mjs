#!/usr/bin/env node
/**
 * lcp-2oxb.1 — Streaming turn benchmark for the admin-shim agent pool.
 *
 * Measures end-to-end throughput and latency for concurrent turns driven
 * through getAgentPool().runTurnWithHeal(), with appendRunFrame called for
 * each frame (mirroring the mobile-channel-host hot path) and a
 * subscribeToRun subscriber attached to each run to measure replay latency.
 *
 * Usage:
 *
 *   node --import tsx/esm scripts/bench-stream-turn.mjs
 *
 * Environment knobs:
 *   BENCH_CONCURRENCY   number of concurrent turns (default 4)
 *   BENCH_TURNS         total turns to run (default 8)
 *   LETTA_MOCK_DELTA_FRAMES   extra delta frames per turn (default 50)
 *                             uses the LETTA_MOCK_FORCE_TRACE=text-only-long
 *                             fixture so 17 native + N synthetic = big frame volume
 *
 * Output (JSON to stdout):
 *   {
 *     wall_ms, total_turns, concurrency, delta_frames_per_turn,
 *     frames_total, frames_per_sec,
 *     subscriber_inter_frame_p50_ms, subscriber_inter_frame_p95_ms,
 *     event_loop_delay: { p50_ms, p95_ms, max_ms },
 *     frames_appended, bytes_appended, rss_bytes, errors
 *   }
 *
 * Exits 0 on success, non-zero on any turn failure.
 *
 * Module bootstrap mirrors the shim integration tests (test/helpers/shim.ts):
 *   - temp LETTA_LOCAL_BACKEND_DIR with a seeded agent + conversation per slot
 *   - LETTA_CLI_PATH pointing at test/helpers/letta-mock.mjs (mock CLI)
 *   - LETTA_LOCAL_BACKEND_EXPERIMENTAL=1 (env-only backend routing)
 *   - LETTA_BASE_URL=http://127.0.0.1:0 (required but unused by mock)
 *
 * Each concurrent slot gets its own (agentId, convId) pair so turns run
 * truly in parallel (the pool serializes only within the same slot key).
 *
 * @bead lcp-2oxb.1
 */

// @ts-check

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_SHIM_ROOT = join(__dirname, "..");
const MOCK_CLI = join(ADMIN_SHIM_ROOT, "test", "helpers", "letta-mock.mjs");

// ── Env-knob defaults ────────────────────────────────────────────────────────

const CONCURRENCY = Number(process.env["BENCH_CONCURRENCY"] ?? 4);
const TOTAL_TURNS = Number(process.env["BENCH_TURNS"] ?? 8);
// Extra synthetic delta frames per turn — 50 makes each turn ~67 frames
// (17 native from text-only-long + 50 synthetic) for a realistic high-volume load.
const DELTA_FRAMES = Number(process.env["LETTA_MOCK_DELTA_FRAMES"] ?? 50);

// ── Bootstrap: temp state dir + env ─────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "bench-shim-"));
const stateDir = join(tmp, "state");
mkdirSync(stateDir, { recursive: true });

/**
 * Seed an agent + conversation directory pair for one concurrent slot.
 * @param {string} aid
 */
function seedSlot(aid) {
  const agentsDir = join(stateDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, Buffer.from(aid).toString("base64url") + ".json"),
    JSON.stringify({ id: aid, name: `Bench Agent ${aid}`, created_at: new Date().toISOString() }),
  );
  // Key: "default:<agentId>" matches StorageService b64url convention.
  const convKey = Buffer.from(`default:${aid}`).toString("base64url");
  const convDir = join(stateDir, "conversations", convKey);
  mkdirSync(convDir, { recursive: true });
  writeFileSync(join(convDir, "conversation.json"), JSON.stringify({ id: "default", agent_id: aid }));
  writeFileSync(join(convDir, "messages.jsonl"), "");
}

// One slot per concurrency lane — each gets a unique agentId so pool keys
// don't collide and turns truly run in parallel.
/** @type {string[]} */
const slotAgents = [];
for (let i = 0; i < CONCURRENCY; i++) {
  const aid = `agent-bench-${String(i).padStart(3, "0")}`;
  seedSlot(aid);
  slotAgents.push(aid);
}

// Patch process.env BEFORE any shim module is imported.
/** @type {Record<string, string | undefined>} */
const prevEnv = {
  LETTA_LOCAL_BACKEND_DIR: process.env["LETTA_LOCAL_BACKEND_DIR"],
  LETTA_LOCAL_BACKEND_EXPERIMENTAL: process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"],
  LETTA_BASE_URL: process.env["LETTA_BASE_URL"],
  LETTA_CLI_PATH: process.env["LETTA_CLI_PATH"],
  LETTA_BIN: process.env["LETTA_BIN"],
  LETTA_MOCK_FORCE_TRACE: process.env["LETTA_MOCK_FORCE_TRACE"],
  LETTA_MOCK_DELTA_FRAMES: process.env["LETTA_MOCK_DELTA_FRAMES"],
  HOME: process.env["HOME"],
};

process.env["LETTA_LOCAL_BACKEND_DIR"] = stateDir;
process.env["LETTA_LOCAL_BACKEND_EXPERIMENTAL"] = "1";
process.env["LETTA_BASE_URL"] = "http://127.0.0.1:0";
process.env["LETTA_CLI_PATH"] = MOCK_CLI;
process.env["LETTA_BIN"] = MOCK_CLI;
// Force the longest realistic fixture (17 native assistant_message frames)
// so DELTA_FRAMES synthetic frames layer on top for high-volume load.
process.env["LETTA_MOCK_FORCE_TRACE"] = "text-only-long";
process.env["LETTA_MOCK_DELTA_FRAMES"] = String(DELTA_FRAMES);
// Keep home writes inside temp dir.
process.env["HOME"] = tmp;

// Clean up on exit (all paths).
function cleanup() {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

// ── Import shim modules (must be AFTER env patch) ───────────────────────────

const { getAgentPool } = await import("../lib/agent-pool.js");
const { createRun, appendRunFrame } = await import("../lib/runs.js");
const { subscribeToRun } = await import("../lib/mobile-channel-host.js");
const { getEventLoopDelayStats, getFrameAppendStats, getRssBytes } = await import("../lib/perf-metrics.js");

// ── Percentile helper ────────────────────────────────────────────────────────

/**
 * @param {number[]} arr - must be sorted ascending
 * @param {number} p - percentile 0-100
 * @returns {number}
 */
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const idx = Math.min(Math.floor((p / 100) * arr.length), arr.length - 1);
  return /** @type {number} */ (arr[idx]);
}

// ── Benchmark driver ─────────────────────────────────────────────────────────

/**
 * Run one turn, writing frames to disk via appendRunFrame (mirroring the
 * mobile-channel-host hot path), and attach a subscribeToRun subscriber.
 *
 * The subscriber measures inter-frame latency as frames are replayed.
 *
 * @param {number} turnIndex
 * @param {string} agentId - slot-local agent id (unique per concurrency lane)
 * @returns {Promise<{ onFrameFrames: number; interFrameGaps: number[] }>}
 */
async function runOneTurn(turnIndex, agentId) {
  return new Promise((resolve, reject) => {
    const convId = "default";
    /** @type {number} */ let onFrameFrames = 0;
    /** @type {number[]} */ const subscriberGaps = [];
    /** @type {number | null} */ let lastFrameTs = null;
    /** @type {{ unsubscribe: () => void } | null} */ let subscribeHandle = null;
    let turnResolved = false;

    // Pre-create a run handle so runId is known before streaming starts
    // (matches the mobile WS pre-created handle pattern from lcp-99a).
    const runHandle = createRun({ agentId, conversationId: convId });
    const runId = runHandle.id;

    /**
     * Attach the subscriber once frames.jsonl exists (after first frame append).
     */
    const maybeAttachSubscriber = () => {
      if (subscribeHandle) return;
      subscribeHandle = subscribeToRun(runId, 0, {
        onFrame: (_frame, _seq) => {
          const now = Date.now();
          if (lastFrameTs !== null) subscriberGaps.push(now - lastFrameTs);
          lastFrameTs = now;
        },
        onDone: (_info) => {
          if (!turnResolved) {
            turnResolved = true;
            resolve({ onFrameFrames, interFrameGaps: subscriberGaps });
          }
        },
        onError: (info) => {
          // run_not_found on early attach (race); retry on next frame.
          if (info.code === "run_not_found") {
            subscribeHandle = null;
            return;
          }
          if (!turnResolved) {
            turnResolved = true;
            // Internal error: resolve with what we have rather than failing.
            resolve({ onFrameFrames, interFrameGaps: subscriberGaps });
          }
        },
      });
    };

    getAgentPool()
      .runTurnWithHeal(convId, agentId, `bench turn ${turnIndex}`, {
        runHandle,
        onFrame: (frame, _meta) => {
          onFrameFrames += 1;
          // Mirror the mobile-channel-host emit() path: write each frame to
          // frames.jsonl so subscribeToRun can replay and measure latency.
          appendRunFrame(runId, frame);
          // Attach subscriber after first frame (frames.jsonl now exists).
          maybeAttachSubscriber();
        },
      })
      .then((_result) => {
        // finalizeTurnLifecycle in the adapter already called finalizeRun.
        // The subscriber's fsWatch should detect the terminal status via
        // checkTerminalAndMaybeFinish on the next change event. If no more
        // frames come, we need to trigger a final check.
        //
        // Emit one sentinel frame to wake the watcher; this frame carries the
        // terminal boundary signal and matches the mobile-channel approach of
        // appending a turn_done-like marker after the adapter returns.
        appendRunFrame(runId, { type: "bench_turn_done", turn: turnIndex });
        // If subscriber not yet attached (zero frames — edge case), resolve now.
        if (!subscribeHandle && !turnResolved) {
          turnResolved = true;
          resolve({ onFrameFrames, interFrameGaps: subscriberGaps });
        }
      })
      .catch((err) => {
        if (!turnResolved) {
          turnResolved = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const pool = getAgentPool();

  console.error(`[bench] concurrency=${CONCURRENCY} total_turns=${TOTAL_TURNS} delta_frames=${DELTA_FRAMES}`);
  console.error(`[bench] stateDir=${stateDir}`);
  console.error(`[bench] mock CLI=${MOCK_CLI}`);
  console.error(`[bench] slots: ${slotAgents.join(", ")}`);

  // Warm-start: reset ELD histogram so measurement window starts here.
  getEventLoopDelayStats();

  const wallStart = Date.now();
  /** @type {number} */ let totalFrames = 0;
  /** @type {number[]} */ const allGaps = [];
  let errors = 0;

  // Drive TOTAL_TURNS turns with at most CONCURRENCY in flight at once.
  // Each concurrency lane uses a fixed slot agent so per-lane turns serialize
  // through the adapter chain (matching real usage) while cross-lane turns
  // truly run in parallel.
  let inFlight = 0;
  let launched = 0;
  let completed = 0;

  await new Promise((resolve) => {
    function maybeSpawn() {
      while (inFlight < CONCURRENCY && launched < TOTAL_TURNS) {
        const turnIdx = launched++;
        const slotIdx = turnIdx % CONCURRENCY;
        const agentId = /** @type {string} */ (slotAgents[slotIdx]);
        inFlight++;
        runOneTurn(turnIdx, agentId)
          .then(({ onFrameFrames, interFrameGaps }) => {
            totalFrames += onFrameFrames;
            allGaps.push(...interFrameGaps);
            completed++;
            inFlight--;
            console.error(
              `[bench] turn ${turnIdx} (agent=${agentId}) done: ` +
              `${onFrameFrames} frames, ${interFrameGaps.length} subscriber gaps`,
            );
            if (completed >= TOTAL_TURNS) resolve(undefined);
            else maybeSpawn();
          })
          .catch((/** @type {unknown} */ err) => {
            errors++;
            completed++;
            inFlight--;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[bench] turn ${turnIdx} FAILED: ${msg}`);
            if (completed >= TOTAL_TURNS) resolve(undefined);
            else maybeSpawn();
          });
      }
    }
    maybeSpawn();
  });

  const wallMs = Date.now() - wallStart;
  const framesPerSec = totalFrames / (wallMs / 1000);

  const sortedGaps = [...allGaps].sort((a, b) => a - b);
  const p50Gap = percentile(sortedGaps, 50);
  const p95Gap = percentile(sortedGaps, 95);

  const eldStats = getEventLoopDelayStats();
  const frameStats = getFrameAppendStats();
  const rssBytes = getRssBytes();

  const report = {
    wall_ms: wallMs,
    total_turns: TOTAL_TURNS,
    concurrency: CONCURRENCY,
    delta_frames_per_turn: DELTA_FRAMES,
    frames_total: totalFrames,
    frames_per_sec: Math.round(framesPerSec * 100) / 100,
    subscriber_inter_frame_p50_ms: p50Gap,
    subscriber_inter_frame_p95_ms: p95Gap,
    event_loop_delay: eldStats,
    frames_appended: frameStats.frames_appended,
    bytes_appended: frameStats.bytes_appended,
    rss_bytes: rssBytes,
    errors,
  };

  // Stop all workers cleanly.
  try {
    await pool.stopAll();
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bench] stopAll error: ${msg}`);
  }

  // Output JSON to stdout.
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  if (errors > 0) {
    console.error(`[bench] ${errors} turn(s) failed`);
    process.exit(1);
  }
}

main().catch((/** @type {unknown} */ err) => {
  const msg = err instanceof Error ? (/** @type {Error} */ (err)).stack ?? String(err) : String(err);
  console.error(`[bench] fatal: ${msg}`);
  process.exit(1);
});
