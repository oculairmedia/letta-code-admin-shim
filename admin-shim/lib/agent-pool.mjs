/**
 * Per-conversation pool of long-running `letta` subprocesses.
 *
 * Each worker is a single `letta --conversation X [--agent Y] --input-format
 * stream-json --output-format stream-json` child process, pinned to one
 * conversation. We send user messages on stdin (`{"type":"user","message":{"content":"..."}}`)
 * and read reply frames off stdout, one per line. End-of-turn is the
 * `{"type":"result",...}` frame.
 *
 * Design constraints (plugin-style principles):
 *   - No external deps; just `child_process`.
 *   - Single-writer per worker: each worker's stdin is owned by a per-room
 *     Promise chain so two turns can never overlap. The same chain pattern
 *     we used in the Matrix typing manager.
 *   - State is in-process Map; no DB. Idle eviction + hard cap = bounded.
 *   - Cold-start fallback is automatic: pool miss → spawn → first frame.
 *   - Process death is graceful: worker is dropped, next request cold-starts.
 *
 * Tuneables (env):
 *   SHIM_POOL_MAX           default 10   hard cap on warm workers
 *   SHIM_POOL_IDLE_SEC      default 300  evict workers idle this long
 *   SHIM_POOL_SPAWN_TIMEOUT default 15000 ms to wait for the init frame
 */

import { spawn } from "node:child_process";

import { listMessages, stampNewMessages } from "./store.mjs";
import {
  createRun,
  finalizeRun,
  markRunFirstToken,
  recordRunMessage,
  recordRunStep,
  recordRunTool,
} from "./runs.js";

const LETTA_BIN = process.env.LETTA_BIN || "letta";
const MAX_WORKERS = Number(process.env.SHIM_POOL_MAX ?? 10);
const IDLE_EVICT_MS = Number(process.env.SHIM_POOL_IDLE_SEC ?? 300) * 1000;
const SPAWN_TIMEOUT_MS = Number(process.env.SHIM_POOL_SPAWN_TIMEOUT ?? 15000);
const HOUSEKEEP_INTERVAL_MS = 30_000;

function logLine(msg) {
  console.log(`[pool] ${msg}`);
}

function nextTurnId() {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class Worker {
  constructor({ conversationId, agentId }) {
    this.conversationId = conversationId;
    this.agentId = agentId;
    this.child = null;
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.ready = false;
    this.dead = false;
    this.lastUsedAt = Date.now();
    this.spawnedAt = Date.now();
    this.chain = Promise.resolve(); // serializes turns per worker
    this.frameHandler = null; // (frame) => void during a turn
  }

  async spawn() {
    // letta-code's CLI: --conversation "default" REQUIRES --agent. Other
    // conversation ids REJECT --agent.
    const scope =
      this.conversationId === "default" && this.agentId
        ? ["--agent", this.agentId, "--conversation", "default"]
        : this.conversationId
          ? ["--conversation", this.conversationId]
          : this.agentId
            ? ["--agent", this.agentId]
            : [];

    const args = [
      "--backend",
      "local",
      ...scope,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
    ];

    this.child = spawn(LETTA_BIN, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => this._ingestStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuf += chunk.toString("utf8");
      if (this.stderrBuf.length > 8192) {
        this.stderrBuf = this.stderrBuf.slice(-8192);
      }
    });
    this.child.on("exit", (code) => {
      this.dead = true;
      this.ready = false;
      if (this.frameHandler) {
        const handler = this.frameHandler;
        this.frameHandler = null;
        handler({ type: "__exit__", exit_code: code, stderr: this.stderrBuf });
      }
      logLine(`worker conv=${this.conversationId} exited code=${code}`);
    });
    this.child.on("error", (err) => {
      this.dead = true;
      this.ready = false;
      logLine(`worker conv=${this.conversationId} error: ${err.message}`);
    });

    // Wait for the init frame
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`pool spawn timeout for conv=${this.conversationId}`));
      }, SPAWN_TIMEOUT_MS);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this._onReady = onReady;
    });
  }

  _ingestStdout(chunk) {
    this.stdoutBuf += chunk.toString("utf8");
    for (;;) {
      const idx = this.stdoutBuf.indexOf("\n");
      if (idx < 0) break;
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }

      // Init frame readies the worker.
      if (
        frame.type === "system" &&
        frame.subtype === "init" &&
        !this.ready
      ) {
        this.ready = true;
        if (this._onReady) {
          const fn = this._onReady;
          this._onReady = null;
          fn();
        }
        continue; // do NOT forward the init frame to per-turn handlers
      }

      // Skip system init frames for subsequent turns (none expected) and
      // route everything else to the active turn handler.
      if (this.frameHandler) this.frameHandler(frame);
    }
  }

  /**
   * Run a single turn: write the user message to stdin, collect frames
   * until the `result` frame fires, return { frames, exitDuringTurn }.
   *
   * Turns are queued on the per-worker chain so two simultaneous callers
   * can't interleave.
   */
  runTurn(userText, { onFrame, turnStartedAt: passedStart, onRunCreated } = {}) {
    const previous = this.chain;
    let resolveTurn;
    const turnPromise = new Promise((r) => (resolveTurn = r));
    this.chain = previous.then(async () => {
      if (this.dead) {
        resolveTurn({ frames: [], dead: true, stderr: this.stderrBuf });
        return;
      }
      this.lastUsedAt = Date.now();
      // Caller (chat.mjs) can supply a turn-start anchor it captured before
      // calling pool.get(). Unifying anchors keeps stream frame timestamps
      // and disk-stamped timestamps consistent — without that, stream frames
      // can carry an EARLIER turnStart than the disk's (when the worker was
      // already warm) or LATER (when spawning was slow), and a sort-by-date
      // merge produces nonsensical order. Fall back to `now` if not supplied.
      const turnStartedAt = passedStart instanceof Date
        ? passedStart
        : (typeof passedStart === "number" ? new Date(passedStart) : new Date());

      // Create a Run record for this turn. Vanilla Letta exposes Runs at
      // /v1/runs/*; mobile polls/cancels by run_id. The Run is the
      // turn-scoped state record; finalize at end-of-turn (or on cancel).
      // We register an onCancel hook that signals the child so an in-flight
      // turn can be aborted from the cancel API.
      let cancelled = false;
      const runHandle = createRun({
        agentId: this.agentId,
        conversationId: this.conversationId,
        onCancel: () => {
          cancelled = true;
          try { this.child?.kill?.("SIGTERM"); } catch {}
        },
      });
      if (typeof onRunCreated === "function") {
        try { onRunCreated(runHandle.id); } catch {}
      }

      const frames = [];
      let finished = null;
      // Buffer the most-recent usage_statistics frame seen in the current
      // step. letta-code emits one usage_statistics + one stop_reason per
      // model step; when stop_reason fires we attribute the buffered usage
      // to the step record. This is what makes per-step token tracking
      // possible (without it we'd only have the run-level aggregate).
      let pendingStepUsage = null;
      const collector = (frame) => {
        if (frame.type === "__exit__") {
          finished = { exit: true, code: frame.exit_code, stderr: frame.stderr };
          return;
        }
        frames.push(frame);
        // Run-tracking side effects. Best-effort — failures shouldn't
        // hose the turn.
        try {
          const ev = frame?.event ?? frame;
          const mt = ev?.message_type ?? frame.message_type;
          if (mt === "assistant_message" || mt === "tool_call_message" || mt === "approval_request_message") {
            markRunFirstToken(runHandle);
          }
          const toolName = ev?.tool_call?.name ?? frame?.tool_call?.name;
          if (toolName) recordRunTool(runHandle, toolName);
          if (mt === "usage_statistics") {
            pendingStepUsage = {
              prompt_tokens: ev.prompt_tokens ?? 0,
              completion_tokens: ev.completion_tokens ?? 0,
              total_tokens: ev.total_tokens ?? 0,
              cached_input_tokens: ev.cached_input_tokens ?? 0,
              cache_write_tokens: ev.cache_write_tokens ?? 0,
              reasoning_tokens: ev.reasoning_tokens ?? 0,
            };
          }
          if (mt === "stop_reason") {
            // letta-code sends one stop_reason per model step. Use it as a
            // step boundary marker so num_steps reflects actual model turns.
            recordRunStep(runHandle, {
              stop_reason: ev.stop_reason,
              usage: pendingStepUsage,
              model: ev.model ?? frame?.model ?? null,
            });
            pendingStepUsage = null;
          }
        } catch {}
        if (onFrame) {
          try { onFrame(frame, { runId: runHandle.id }); } catch (err) { logLine(`onFrame error: ${err.message}`); }
        }
        if (frame.type === "result") {
          finished = { done: true };
        }
      };
      this.frameHandler = collector;
      // Snapshot existing message ids so we can attribute newly-persisted
      // messages to this run after the turn settles. listMessages reads
      // messages.jsonl which letta-code appends to during the turn.
      const messageIdsBefore = new Set(
        listMessages(this.conversationId, this.agentId).map((m) => m?.id).filter(Boolean),
      );
      try {
        this.child.stdin.write(
          JSON.stringify({ type: "user", message: { content: userText } }) + "\n",
        );
      } catch (err) {
        this.frameHandler = null;
        this.dead = true;
        finalizeRun(runHandle, { status: "failed", stopReason: `stdin_write_error: ${err.message}` });
        resolveTurn({ frames: [], dead: true, error: err.message, run_id: runHandle.id });
        return;
      }
      // Wait for the result frame OR child exit. Add a generous safety
      // timeout so a stuck worker doesn't block the chain forever.
      const TURN_TIMEOUT_MS = Number(process.env.SHIM_POOL_TURN_TIMEOUT ?? 180_000);
      await new Promise((r) => {
        const start = Date.now();
        const poll = setInterval(() => {
          if (finished) {
            clearInterval(poll);
            r();
          } else if (Date.now() - start > TURN_TIMEOUT_MS) {
            clearInterval(poll);
            finished = { timeout: true };
            r();
          }
        }, 50);
      });
      this.frameHandler = null;
      this.lastUsedAt = Date.now();
      // Stamp any new messages with their real timestamp. Sentinel dates
      // on disk encode order, not time; the sidecar substitutes the real
      // wall-clock at projection time. Anchor at turnStartedAt so the
      // user's prompt timestamps land before letta-code's stream frame
      // times (which fire later in the turn). Failure is non-fatal.
      try {
        stampNewMessages(this.conversationId, this.agentId, turnStartedAt);
      } catch (err) {
        logLine(`stampNewMessages failed conv=${this.conversationId}: ${err.message}`);
      }
      // Attribute newly-persisted messages to this run, then finalize.
      // `cancelled` short-circuits because cancelRun already wrote the
      // record; calling finalizeRun would no-op (handle removed from
      // active map) but we still attribute messages first.
      try {
        const after = listMessages(this.conversationId, this.agentId);
        for (const m of after) {
          if (m?.id && !messageIdsBefore.has(m.id)) {
            recordRunMessage(runHandle, m.id);
          }
        }
      } catch (err) {
        logLine(`run message attribution failed for ${runHandle.id}: ${err.message}`);
      }
      const stopFrame = frames.find((f) => (f?.event?.message_type ?? f?.message_type) === "stop_reason");
      const usageFrame = frames.find((f) => (f?.event?.message_type ?? f?.message_type) === "usage_statistics");
      const stopReason = (stopFrame?.event ?? stopFrame)?.stop_reason ?? null;
      const usage = usageFrame?.event ?? usageFrame ?? null;
      if (!cancelled) {
        finalizeRun(runHandle, {
          status: finished?.exit ? "failed" : (finished?.timeout ? "failed" : "completed"),
          stopReason: finished?.timeout ? "timeout" : (finished?.exit ? "child_exit" : stopReason),
          usage,
        });
      }
      resolveTurn({
        frames,
        ...(finished ?? {}),
        stderr: this.stderrBuf,
        run_id: runHandle.id,
        cancelled,
      });
    });
    return turnPromise;
  }

  async stop() {
    this.dead = true;
    this.ready = false;
    try {
      if (this.child && !this.child.killed) {
        this.child.stdin.end();
        this.child.kill("SIGTERM");
        // SIGKILL after 5s if still running
        setTimeout(() => {
          if (this.child && !this.child.killed) {
            try { this.child.kill("SIGKILL"); } catch {}
          }
        }, 5000).unref?.();
      }
    } catch {}
  }
}

class AgentPool {
  constructor() {
    this.workers = new Map(); // key: conversationId → Worker
    this.spawning = new Map(); // key: conversationId → Promise<Worker>
    this.housekeepTimer = setInterval(() => this.housekeep(), HOUSEKEEP_INTERVAL_MS);
    this.housekeepTimer.unref?.();
  }

  size() {
    return this.workers.size;
  }

  /**
   * Compose the cache key. Conv id "default" collides across agents (every
   * agent has its own "default" thread), so we MUST include the agent id
   * in the key — otherwise two different agents share one worker and
   * messages cross-talk. For non-default conv ids the agent is derivable
   * from the conv id alone, but we still include it for symmetry.
   */
  _key(conversationId, agentId) {
    return `${agentId ?? "?"}::${conversationId ?? "?"}`;
  }

  /**
   * Get a ready worker for (conversationId, agentId). Reuses warm one;
   * spawns + waits for init if cold. Concurrent callers for the same
   * (agent, conv) coalesce on a single spawn.
   */
  async get(conversationId, agentId) {
    const key = this._key(conversationId, agentId);
    let worker = this.workers.get(key);
    if (worker && !worker.dead) return worker;
    if (worker && worker.dead) this.workers.delete(key);

    const inFlight = this.spawning.get(key);
    if (inFlight) return inFlight;

    const p = (async () => {
      // Evict if over cap (LRU).
      while (this.workers.size >= MAX_WORKERS) {
        const [oldestKey] = [...this.workers.entries()].sort(
          (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
        )[0];
        if (!oldestKey) break;
        const victim = this.workers.get(oldestKey);
        logLine(`evicting (cap) conv=${oldestKey}`);
        this.workers.delete(oldestKey);
        victim?.stop();
      }

      const w = new Worker({ conversationId, agentId });
      try {
        await w.spawn();
      } catch (err) {
        logLine(`spawn failed key=${key}: ${err.message}`);
        w.dead = true;
        throw err;
      }
      this.workers.set(key, w);
      logLine(`spawned key=${key} size=${this.workers.size}`);
      return w;
    })();

    this.spawning.set(key, p);
    try {
      const w = await p;
      return w;
    } finally {
      this.spawning.delete(key);
    }
  }

  housekeep() {
    const now = Date.now();
    for (const [key, w] of this.workers) {
      if (w.dead) {
        this.workers.delete(key);
        continue;
      }
      if (now - w.lastUsedAt > IDLE_EVICT_MS) {
        logLine(`evicting (idle) conv=${key} idle=${(now - w.lastUsedAt) / 1000}s`);
        this.workers.delete(key);
        w.stop();
      }
    }
  }

  async stopAll() {
    if (this.housekeepTimer) clearInterval(this.housekeepTimer);
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled(all.map((w) => w.stop()));
  }

  stats() {
    return {
      size: this.workers.size,
      max: MAX_WORKERS,
      idle_evict_sec: IDLE_EVICT_MS / 1000,
      workers: [...this.workers.entries()].map(([k, w]) => ({
        key: k,
        conversation_id: w.conversationId,
        agent_id: w.agentId,
        ready: w.ready,
        dead: w.dead,
        idle_sec: Math.round((Date.now() - w.lastUsedAt) / 1000),
        spawned_sec: Math.round((Date.now() - w.spawnedAt) / 1000),
      })),
    };
  }
}

let _pool = null;
export function getAgentPool() {
  if (!_pool) _pool = new AgentPool();
  return _pool;
}

// Re-export cancelRun so cancel handlers don't have to import runs.mjs
// directly. `cancelRun(runId)` triggers the onCancel hook registered in
// runTurn, which SIGTERMs the worker and flips the Run's status to
// "cancelled".
export { cancelRun } from "./runs.js";
