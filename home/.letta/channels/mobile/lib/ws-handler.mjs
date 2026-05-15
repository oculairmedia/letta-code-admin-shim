/**
 * WS frame handler for one connected mobile device.
 *
 * Lifecycle:
 *   1. Server accepts WS upgrade, hands the socket to handleConnection().
 *   2. We read the first frame, expect `hello`, validate the token.
 *   3. Reply `welcome` (or `error` then close).
 *   4. Process frames in a loop:
 *        - send_message → dispatch (via the host-provided sendMessage handler)
 *        - ack          → log/observability
 *        - pong         → mark alive
 *        - bye          → close
 *   5. Server-side: periodic `ping` frame to keep the connection healthy.
 *   6. On socket close: stop the ping timer, release resources.
 *
 * `host` is provided by the channel-plugin loader and exposes:
 *   - getToken(): string                 — the currently accepted token
 *   - getServerId(): string              — for the welcome frame
 *   - sendMessage(req, onFrame): Promise — process a send_message and
 *       stream frames via onFrame (turn_started, assistant_message,
 *       stop_reason, usage_statistics).
 *   - log(...args): void
 */

import { randomUUID } from "node:crypto";
import {
  ERROR_CODES,
  makeFrame,
  parseFrame,
  PROTOCOL_VERSION,
  ProtocolError,
} from "./protocol.mjs";
import { recordDeviceConnect } from "./state.mjs";

function safeSend(ws, frame, log) {
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    log?.(`send failed: ${err.message}`);
  }
}

function timingSafeEqualHexish(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function handleConnection(ws, request, host) {
  const log = (msg) => host.log(`[mobile:ws] ${msg}`);
  const sessionId = `sess-${randomUUID()}`;
  let device = null; // { device_id, ... } once authed
  let helloSeen = false;
  let closed = false;
  let pingTimer = null;
  let idleTimer = null;
  // Single-flight per session: a second send_message arriving while the
  // first is still streaming is rejected with PROTOCOL_VIOLATION. Cancel
  // is the only way to abort an in-flight turn over the same socket.
  let inFlight = false;
  // NOTE: an implicit "currentRunId" was previously tracked here so cancel
  // could fall back to the in-flight run without an explicit id (lcp-bll).
  // The contract now requires clients to send run_id explicitly, so the
  // tracking is gone. activeRunId (below, scoped per-turn) carries the
  // run-tracking state that other code still needs.

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(`idle timeout — closing ${sessionId}`);
      try { ws.close(1000, "idle timeout"); } catch {}
    }, host.config?.idleTimeoutMs ?? 120_000);
    if (idleTimer.unref) idleTimer.unref();
  };

  const startPings = () => {
    const interval = host.config?.pingIntervalMs ?? 25_000;
    pingTimer = setInterval(() => {
      if (closed) return;
      safeSend(ws, makeFrame("ping"), log);
    }, interval);
    if (pingTimer.unref) pingTimer.unref();
  };

  const stopAll = () => {
    closed = true;
    if (pingTimer) clearInterval(pingTimer);
    if (idleTimer) clearTimeout(idleTimer);
  };

  const sendError = (code, message, { close = true } = {}) => {
    safeSend(ws, makeFrame("error", { code, message }), log);
    if (close) {
      try { ws.close(4000, code); } catch {}
    }
  };

  ws.on("message", async (raw) => {
    resetIdle();
    const frame = parseFrame(raw.toString("utf8"));
    if (!frame) {
      sendError(ERROR_CODES.PROTOCOL_VIOLATION, "unparseable frame");
      return;
    }
    if (typeof frame.v !== "number" || frame.v > PROTOCOL_VERSION + 0) {
      // We accept v=1 frames. Future versions are forward-compat noise.
      // Drop with no error.
    }

    if (!helloSeen) {
      if (frame.type !== "hello") {
        sendError(ERROR_CODES.PROTOCOL_VIOLATION, "hello must be first frame");
        return;
      }
      const expected = host.getToken();
      // Mirror REST permissiveness on this dev box: when no token is
      // configured (env unset and tokenFallback is empty), any token in
      // the hello frame is accepted. Set MOBILE_CHANNEL_TOKEN or restore
      // tokenFallback in accounts.json to re-enable strict matching.
      if (typeof expected === "string" && expected.length > 0) {
        if (!timingSafeEqualHexish(frame.token ?? "", expected)) {
          log(`auth failed for device=${frame.device_id ?? "?"}`);
          sendError(ERROR_CODES.INVALID_TOKEN, "invalid token");
          return;
        }
      } else {
        log(`auth skipped (no token configured) for device=${frame.device_id ?? "?"}`);
      }
      const deviceId = frame.device_id || `anon-${randomUUID()}`;
      device = recordDeviceConnect({
        deviceId,
        token: frame.token,
        clientVersion: frame.client_version,
      });
      helloSeen = true;
      log(`hello accepted device=${deviceId} session=${sessionId}`);
      safeSend(
        ws,
        makeFrame("welcome", {
          server_id: host.getServerId(),
          session_id: sessionId,
          device_id: deviceId,
        }),
        log,
      );
      startPings();
      return;
    }

    switch (frame.type) {
      case "send_message": {
        const { agent_id, conversation_id, text, otid } = frame;
        if (!agent_id || !conversation_id || typeof text !== "string") {
          sendError(
            ERROR_CODES.PROTOCOL_VIOLATION,
            "send_message requires agent_id, conversation_id, text",
            { close: false },
          );
          return;
        }
        // Serialize sends per session — running two turns concurrently on
        // the same socket races state (pendingAssistant, run binding) and
        // tangles outbound frame order on the wire.
        if (inFlight) {
          sendError(
            ERROR_CODES.PROTOCOL_VIOLATION,
            "another send_message is in flight on this session",
            { close: false },
          );
          return;
        }
        inFlight = true;
        const turnId = `turn-${randomUUID()}`;
        // turn_started is emitted BEFORE the run is created. run_id gets
        // patched onto subsequent frames once the bridge surfaces it via
        // onRunCreated. Mobile correlates via turn_id until run_id appears.
        let activeRunId = null;
        safeSend(
          ws,
          makeFrame("turn_started", {
            agent_id,
            conversation_id,
            turn_id: turnId,
          }),
          log,
        );
        try {
          await host.sendMessage(
            { agent_id, conversation_id, text, otid, turn_id: turnId, session_id: sessionId },
            (outFrame) => {
              if (closed) return;
              const mt = outFrame.message_type;
              const runId = outFrame.run_id ?? activeRunId;
              if (runId && !activeRunId) {
                activeRunId = runId;
              }
              const base = {
                agent_id,
                conversation_id,
                turn_id: turnId,
                run_id: runId ?? null,
              };
              // Backpressure: if the socket can't drain frames fast enough,
              // pause emission. ws's bufferedAmount is the unsent byte count;
              // a slow consumer that lets this grow unbounded eats RAM.
              const HIGH_WATER = host.config?.bufferHighWaterBytes ?? 1_000_000;
              if (ws.bufferedAmount > HIGH_WATER) {
                log(`backpressure: bufferedAmount=${ws.bufferedAmount} > ${HIGH_WATER}, dropping ${mt}`);
                return;
              }
              if (mt === "assistant_message") {
                safeSend(ws, makeFrame("assistant_message", {
                  ...base,
                  content: outFrame.content ?? "",
                  otid: outFrame.otid ?? null,
                }), log);
              } else if (mt === "reasoning_message") {
                safeSend(ws, makeFrame("reasoning_message", {
                  ...base,
                  reasoning: outFrame.reasoning ?? "",
                  signature: outFrame.signature ?? null,
                }), log);
              } else if (mt === "tool_call_message") {
                safeSend(ws, makeFrame("tool_call_message", {
                  ...base,
                  tool_call: outFrame.tool_call ?? null,
                  tool_calls: outFrame.tool_calls ?? null,
                }), log);
              } else if (mt === "tool_return_message") {
                safeSend(ws, makeFrame("tool_return_message", {
                  ...base,
                  tool_call_id: outFrame.tool_call_id ?? null,
                  status: outFrame.status ?? "success",
                  tool_return: outFrame.tool_return ?? null,
                  stdout: outFrame.stdout ?? null,
                  stderr: outFrame.stderr ?? null,
                }), log);
              } else if (mt === "stop_reason") {
                safeSend(ws, makeFrame("stop_reason", {
                  turn_id: turnId,
                  run_id: runId ?? null,
                  stop_reason: outFrame.stop_reason ?? "end_turn",
                }), log);
              } else if (mt === "usage_statistics") {
                safeSend(ws, makeFrame("usage_statistics", {
                  turn_id: turnId,
                  run_id: runId ?? null,
                  prompt_tokens: outFrame.prompt_tokens,
                  completion_tokens: outFrame.completion_tokens,
                  total_tokens: outFrame.total_tokens,
                  cached_input_tokens: outFrame.cached_input_tokens,
                  reasoning_tokens: outFrame.reasoning_tokens,
                }), log);
              }
              // ping / unknown types: drop silently. Forward-compat rule.
            },
            {
              onRunCreated: (id) => {
                activeRunId = id;
              },
            },
          );
          // turn_done sentinel — emitted AFTER bridgeSendMessage settles,
          // which means stampNewMessages + writeOtidForLocalId have run.
          // Mobile can now safely GET /messages without racing the disk.
          if (!closed) {
            safeSend(ws, makeFrame("turn_done", {
              turn_id: turnId,
              run_id: activeRunId ?? null,
              status: "completed",
            }), log);
          }
        } catch (err) {
          if (err instanceof ProtocolError) {
            sendError(err.code, err.message, { close: false });
          } else {
            log(`send_message failed: ${err.stack ?? err.message}`);
            // Surface the turn_id so mobile can attribute the failure.
            safeSend(ws, makeFrame("error", {
              code: ERROR_CODES.INTERNAL,
              message: err.message ?? "send failed",
              turn_id: turnId,
              run_id: activeRunId ?? null,
            }), log);
          }
        } finally {
          inFlight = false;
        }
        break;
      }
      case "cancel": {
        // run_id is REQUIRED on cancel — the implicit fallback to the
        // current in-flight run is gone (lcp-bll). Clients should track
        // the active run_id from turn_started + post-turn_started frames
        // and pass it explicitly. Doc: admin-shim/docs/MOBILE_WS_PROTOCOL.md
        // §2.1 + §4.5.
        const targetRunId = frame.run_id;
        if (!targetRunId) {
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "cancel needs run_id", { close: false });
          return;
        }
        const ok = host.cancelRun(targetRunId);
        if (!ok) {
          sendError(ERROR_CODES.RUN_NOT_FOUND, `run ${targetRunId} not active`, { close: false });
        } else {
          log(`cancel accepted run=${targetRunId}`);
        }
        break;
      }
      case "ack":
        // Phase 1: log and move on. Phase 2 wires this into the sync cursor.
        break;
      case "pong":
        // Liveness signal — resetIdle above already noted it.
        break;
      case "bye":
        log(`client said bye session=${sessionId}`);
        try { ws.close(1000, "bye"); } catch {}
        break;
      default:
        // Unknown frame types: ignore per forward-compat rule.
        break;
    }
  });

  ws.on("close", () => {
    log(`closed session=${sessionId} device=${device?.device_id ?? "(unauthed)"}`);
    stopAll();
  });

  ws.on("error", (err) => {
    log(`socket error session=${sessionId}: ${err.message}`);
    stopAll();
  });

  resetIdle();
}
