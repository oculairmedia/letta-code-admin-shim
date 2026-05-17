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
  let a2uiCapability = null;
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
      const serverA2ui = typeof host.getA2uiServerCapabilities === "function"
        ? host.getA2uiServerCapabilities()
        : { enabled: false };
      if (frame.a2ui_version) {
        const supportedCatalogs = Array.isArray(frame.supported_catalogs) ? frame.supported_catalogs.filter((v) => typeof v === "string") : [];
        const supportedWidgets = Array.isArray(frame.supported_widgets) ? frame.supported_widgets.filter((v) => typeof v === "string") : [];
        const versionMatches = typeof frame.a2ui_version === "string" && frame.a2ui_version === serverA2ui.version;
        const catalogId = typeof serverA2ui.catalogId === "string" ? serverA2ui.catalogId : "basic";
        const catalogMatches = supportedCatalogs.length === 0 || supportedCatalogs.includes(catalogId);
        if (serverA2ui.enabled && versionMatches && catalogMatches) {
          a2uiCapability = {
            version: frame.a2ui_version,
            catalogId,
            supportedCatalogs: supportedCatalogs.length > 0 ? supportedCatalogs : [catalogId],
            supportedWidgets,
            ...(frame.theme_hints && typeof frame.theme_hints === "object" && !Array.isArray(frame.theme_hints) ? { themeHints: frame.theme_hints } : {}),
          };
        }
      }
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
          a2ui_negotiated: Boolean(a2uiCapability),
          a2ui: a2uiCapability ? {
            version: a2uiCapability.version,
            catalog_id: a2uiCapability.catalogId,
          } : null,
        }),
        log,
      );
      if (a2uiCapability) {
        safeSend(
          ws,
          makeFrame("a2ui_capabilities", {
            version: a2uiCapability.version,
            catalog_id: a2uiCapability.catalogId,
            supported_catalogs: serverA2ui.supportedCatalogs ?? [a2uiCapability.catalogId],
            supported_widgets: serverA2ui.supportedWidgets ?? [],
          }),
          log,
        );
      }
      startPings();
      return;
    }

    switch (frame.type) {
      case "send_message": {
        const { agent_id, conversation_id, text, otid, content_parts } = frame;
        if (!agent_id || !conversation_id || typeof text !== "string") {
          sendError(
            ERROR_CODES.PROTOCOL_VIOLATION,
            "send_message requires agent_id, conversation_id, text",
            { close: false },
          );
          return;
        }
        // lcp-dlj: validate optional content_parts. If supplied, it must
        // be an array; size-cap the JSON-encoded frame at 10MB to bound
        // memory pressure from oversized base64 images. Mobile is
        // expected to downsample first (≤1568px longest side, ≤2MB raw
        // per image, ≤4 images per send). The shim enforces the
        // size ceiling defensively.
        const SEND_MESSAGE_MAX_BYTES = 10 * 1024 * 1024;
        if (content_parts !== undefined && content_parts !== null) {
          if (!Array.isArray(content_parts)) {
            sendError(
              ERROR_CODES.PROTOCOL_VIOLATION,
              "content_parts must be an array when present",
              { close: false },
            );
            return;
          }
          // The raw inbound buffer is the cheapest size oracle: parseFrame
          // already produced `frame` from a string we captured at the top
          // of the message handler. Re-serialize content_parts to estimate
          // its on-wire size (worst-case parity with what mobile sent).
          let cpSize = 0;
          try { cpSize = Buffer.byteLength(JSON.stringify(content_parts), "utf8"); } catch {
            sendError(
              ERROR_CODES.PROTOCOL_VIOLATION,
              "content_parts is not JSON-serializable",
              { close: false },
            );
            return;
          }
          if (cpSize > SEND_MESSAGE_MAX_BYTES) {
            sendError(
              ERROR_CODES.PROTOCOL_VIOLATION,
              `content_parts exceeds ${SEND_MESSAGE_MAX_BYTES} bytes (${cpSize}); downsample images before send`,
              { close: false },
            );
            return;
          }
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
        // lcp-99a: turn_started now waits until host.sendMessage has fired
        // onRunCreated (which mobile-channel-host does synchronously before
        // any await). That guarantees run_id is non-null on turn_started,
        // closing the cancel-during-startup gap. The cost is a few-ms
        // delay before the "agent typing" indicator can flip — createRun
        // is a single atomic write.
        let activeRunId = null;
        let turnStartedEmitted = false;
        // lcp-srk: count backpressure drops within this turn so turn_done
        // can carry an authoritative lossy flag. Mobile reconciles iff
        // lossy === true; clean turns can skip the round-trip.
        let droppedFrameCount = 0;
        const emitTurnStarted = () => {
          if (turnStartedEmitted || closed) return;
          turnStartedEmitted = true;
          safeSend(
            ws,
            makeFrame("turn_started", {
              agent_id,
              conversation_id,
              turn_id: turnId,
              run_id: activeRunId ?? null,
            }),
            log,
          );
        };
        let turnResult = null;
        try {
          turnResult = await host.sendMessage(
            { agent_id, conversation_id, text, content_parts, otid, turn_id: turnId, session_id: sessionId, a2ui_capability: a2uiCapability },
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
                droppedFrameCount += 1;
                log(`backpressure: bufferedAmount=${ws.bufferedAmount} > ${HIGH_WATER}, dropping ${mt} (turn=${turnId} dropped=${droppedFrameCount})`);
                return;
              }
              // lcp-cv3: pass the upstream id through to the envelope so
              // mobile's findByServerId can merge streamed chunks. For
              // assistant/reasoning the host now stamps `cm-stream-<otid>` /
              // `cm-reason-<otid>` so every chunk of the same logical
              // message shares an id. tool_call_message / tool_return_message
              // ids carry `toolcall-` / `toolreturn-` prefixes from the
              // upstream reshape — preserve them for mobile's distinctBy{id}
              // dedup. makeFrame's auto-generated random id was masking all
              // of these and made the stream look like one final chunk.
              const upstreamId = typeof outFrame.id === "string" && outFrame.id.length > 0
                ? outFrame.id
                : undefined;
              if (mt === "assistant_message") {
                safeSend(ws, makeFrame("assistant_message", {
                  ...base,
                  ...(upstreamId ? { id: upstreamId } : {}),
                  content: outFrame.content ?? "",
                  otid: outFrame.otid ?? null,
                }), log);
              } else if (mt === "reasoning_message") {
                safeSend(ws, makeFrame("reasoning_message", {
                  ...base,
                  ...(upstreamId ? { id: upstreamId } : {}),
                  reasoning: outFrame.reasoning ?? "",
                  signature: outFrame.signature ?? null,
                }), log);
              } else if (mt === "tool_call_message") {
                safeSend(ws, makeFrame("tool_call_message", {
                  ...base,
                  ...(upstreamId ? { id: upstreamId } : {}),
                  tool_call: outFrame.tool_call ?? null,
                  tool_calls: outFrame.tool_calls ?? null,
                }), log);
              } else if (mt === "tool_return_message") {
                safeSend(ws, makeFrame("tool_return_message", {
                  ...base,
                  ...(upstreamId ? { id: upstreamId } : {}),
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
              } else if (mt === "a2ui_frame") {
                // Phase 4: A2UI frame extracted from the assistant text
                // stream. Body carries the parsed A2UI v0.9 message (or
                // null + diagnostics when parse/validation failed). The
                // renderer applies the message to its surface state; the
                // shim doesn't track surface state itself.
                safeSend(ws, makeFrame("a2ui_frame", {
                  turn_id: turnId,
                  run_id: runId ?? null,
                  otid: outFrame.otid ?? null,
                  ok: outFrame.ok !== false,
                  a2ui: outFrame.a2ui ?? null,
                  ...(outFrame.parse_error ? { parse_error: outFrame.parse_error } : {}),
                  ...(outFrame.validation_error ? { validation_error: outFrame.validation_error } : {}),
                }), log);
              }
              // ping / unknown types: drop silently. Forward-compat rule.
            },
            {
              onRunCreated: (id) => {
                activeRunId = id;
                // lcp-99a: emit turn_started NOW (with the just-created
                // run_id). Subsequent frames in the onFrame closure rely
                // on turn_started having been sent first, so we sequence
                // it here on the synchronous tick where the run id lands.
                emitTurnStarted();
              },
            },
          );
          // Defensive: if onRunCreated never fired (e.g. host bug), still
          // emit turn_started so mobile doesn't stall. run_id will be null
          // in that pathological case, but the turn lifecycle stays intact.
          emitTurnStarted();
          // turn_done sentinel — emitted AFTER bridgeSendMessage settles,
          // which means stampNewMessages + writeOtidForLocalId have run.
          // Mobile can now safely GET /messages without racing the disk.
          //
          // Status derivation (lcp-axv + lcp-kfr): the turnResult carries
          // lifecycle flags from agent-pool. `cancelled` wins (cancel
          // intent is authoritative even if upstream produced a clean
          // result frame in the race). `exit` / `timeout` / `dead` mean
          // the worker died mid-turn → "failed". Otherwise "completed".
          //
          // lossy (lcp-srk): true iff any onFrame call dropped a frame
          // due to backpressure. Mobile reconciles iff lossy === true.
          if (!closed) {
            const status = turnResult?.cancelled
              ? "cancelled"
              : (turnResult?.exit || turnResult?.timeout || turnResult?.dead)
                ? "failed"
                : "completed";
            // lcp-gs2: when the worker died mid-turn (status=failed) we
            // don't have an error message to surface from this path —
            // the failure surfaced via a turnResult flag, not a thrown
            // Error. Emit null error fields so the wire shape stays
            // consistent across success / cancel / failed paths.
            safeSend(ws, makeFrame("turn_done", {
              turn_id: turnId,
              run_id: activeRunId ?? null,
              status,
              lossy: droppedFrameCount > 0,
              drop_count: droppedFrameCount,
              error_code: null,
              error_message: null,
            }), log);
          }
        } catch (err) {
          if (err instanceof ProtocolError) {
            sendError(err.code, err.message, { close: false });
            // Protocol-level error does NOT abort the in-flight turn (we
            // haven't started one yet on this branch in practice — the
            // validation above runs before host.sendMessage), so no
            // turn_done to emit.
          } else {
            log(`send_message failed: ${err.stack ?? err.message}`);
            // lcp-axv + lcp-gs2: emit error frame first (forward-compat
            // for consumers that still ingest standalone error frames),
            // then turn_done(status:failed) carrying the same code +
            // message inline so the failure is atomic-by-frame for
            // mobile dispatchers. Mobile MAY read either; turn_done's
            // own fields are now authoritative for terminal failures.
            const errCode = ERROR_CODES.INTERNAL;
            const errMessage = err.message ?? "send failed";
            if (!closed) {
              safeSend(ws, makeFrame("error", {
                code: errCode,
                message: errMessage,
                turn_id: turnId,
                run_id: activeRunId ?? null,
              }), log);
              safeSend(ws, makeFrame("turn_done", {
                turn_id: turnId,
                run_id: activeRunId ?? null,
                status: "failed",
                lossy: droppedFrameCount > 0,
                drop_count: droppedFrameCount,
                error_code: errCode,
                error_message: errMessage,
              }), log);
            }
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
      case "user_action": {
        // Phase 5: A2UI user_action ingestion. Forward to the host's
        // sidecar recorder and reply with `user_action_ack`. The shim
        // does NOT yet wire this into letta-code's tool dispatcher —
        // recording the action is sufficient for the contract that
        // mobile builds against.
        if (typeof frame.name !== "string" || frame.name.length === 0) {
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "user_action requires a non-empty name", { close: false });
          return;
        }
        if (frame.context !== undefined && (frame.context === null || typeof frame.context !== "object" || Array.isArray(frame.context))) {
          sendError(ERROR_CODES.PROTOCOL_VIOLATION, "user_action.context must be an object when present", { close: false });
          return;
        }
        const handler = typeof host.handleUserAction === "function" ? host.handleUserAction : null;
        if (!handler) {
          sendError(ERROR_CODES.INTERNAL, "user_action handler not wired", { close: false });
          return;
        }
        try {
          const ack = await handler({
            session_id: sessionId,
            run_id: typeof frame.run_id === "string" ? frame.run_id : null,
            turn_id: typeof frame.turn_id === "string" ? frame.turn_id : null,
            surface_id: typeof frame.surface_id === "string" ? frame.surface_id : null,
            name: frame.name,
            context: frame.context ?? {},
            action_id: typeof frame.action_id === "string" ? frame.action_id : null,
          });
          safeSend(ws, makeFrame("user_action_ack", {
            action_id: ack.action_id,
            status: ack.status,
            ...(ack.reason ? { reason: ack.reason } : {}),
          }), log);
        } catch (err) {
          log(`user_action handler failed: ${err.stack ?? err.message}`);
          sendError(ERROR_CODES.INTERNAL, err.message ?? "user_action failed", { close: false });
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
