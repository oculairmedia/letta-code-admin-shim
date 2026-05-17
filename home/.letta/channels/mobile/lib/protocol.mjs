/**
 * Phase 1 wire protocol for the mobile channel.
 *
 * WebSocket. JSON frames, one per WS message. Base envelope on every frame:
 *
 *   {
 *     "v": 1,
 *     "type": "<frame-type>",
 *     "id": "<uuid>",
 *     "ts": "2026-05-14T16:00:00.000Z",
 *     ...type-specific fields
 *   }
 *
 * Forward-compat rule: receivers MUST ignore unknown frame types and
 * unknown fields.
 */

import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;

export const CLIENT_FRAMES = Object.freeze([
  "hello", // { token, device_id, client_version, a2ui_version?, supported_catalogs?, supported_widgets?, theme_hints? }
  "send_message", // { agent_id, conversation_id, text, otid? }
  "cancel", // { run_id }   — cancel an in-flight turn
  "ack", // { target_id }
  "bye", // (no extras)
  "pong", // (no extras, reply to server ping)
  "user_action", // { run_id?, turn_id?, surface_id?, name, context, action_id? }
                  // A2UI: emitted when the renderer fires an `Action.event`
                  // (e.g. ToolApprovalCard scope choice). Routed back into
                  // the host's user-action sidecar; ack arrives as a
                  // `user_action_ack` frame.
]);

export const SERVER_FRAMES = Object.freeze([
  "welcome", // { server_id, session_id, device_id, a2ui_negotiated?, a2ui? }
  "a2ui_capabilities", // { version, catalog_id, supported_catalogs, supported_widgets }
  "a2ui_frame", // { turn_id, run_id, otid?, ok, a2ui, raw?, parse_error?, validation_error? }
                  // One A2UI v0.9 message extracted from the assistant
                  // text stream. Body is the parsed message (a single
                  // object or an array of messages) ready for the
                  // renderer. `ok=false` carries diagnostic fields the
                  // client may surface in a debug panel.
  "user_action_ack", // { action_id, status, reason? }
                  // Ack for a `user_action` frame.
  "error", // { code, message, turn_id? }
  "ping", // (no extras)
  "turn_started", // { agent_id, conversation_id, turn_id, run_id }
  "reasoning_message", // { agent_id, conversation_id, turn_id, run_id, reasoning, signature? }
  "tool_call_message", // { agent_id, conversation_id, turn_id, run_id, tool_call:{name,arguments,tool_call_id} }
  "tool_return_message", // { agent_id, conversation_id, turn_id, run_id, tool_call_id, status, tool_return }
  "assistant_message", // { agent_id, conversation_id, turn_id, run_id, content }
  "stop_reason", // { turn_id, run_id, reason }
  "usage_statistics", // { turn_id, run_id, prompt_tokens, completion_tokens, ... }
  "turn_done", // { turn_id, run_id, status }
                  // Sentinel emitted AFTER stamping/sidecar writes so mobile
                  // can safely GET /messages without racing the disk.
]);

export const ERROR_CODES = Object.freeze({
  INVALID_TOKEN: "invalid_token",
  PROTOCOL_VIOLATION: "protocol_violation",
  AGENT_NOT_FOUND: "agent_not_found",
  CONVERSATION_NOT_FOUND: "conversation_not_found",
  RUN_NOT_FOUND: "run_not_found",
  INTERNAL: "internal_error",
});

/** Build a base frame envelope. Callers add type-specific fields. */
export function makeFrame(type, fields = {}) {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...fields,
  };
}

/** Returns null if invalid; otherwise the parsed frame. */
export function parseFrame(raw) {
  if (typeof raw !== "string") return null;
  let f;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!f || typeof f !== "object" || typeof f.type !== "string") return null;
  return f;
}

/** Tagged error for protocol violations the server should surface to the client. */
export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
