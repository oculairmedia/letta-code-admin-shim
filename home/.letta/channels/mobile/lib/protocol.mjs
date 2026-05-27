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
  "ack", // { target_id } or { conversation_id, ack_seq }
  "bye", // (no extras)
  "pong", // (no extras, reply to server ping)
  "user_action", // { run_id?, turn_id?, surface_id?, name, context, action_id? }
                  // A2UI: emitted when the renderer fires an `Action.event`
                  // (e.g. ToolApprovalCard scope choice). Routed back into
                  // the host's user-action sidecar; ack arrives as a
                  // `user_action_ack` frame.
  "subscribe", // { run_id, cursor? }
                  // lcp-p74.2: replay+live-tail subscription for an in-flight
                  // or completed run. Cursor is the last `seq` the client has
                  // received (0 or omitted = from start). Server replays each
                  // frame with seq > cursor wrapped in a `subscribe_frame`
                  // envelope, then continues live-tailing new appends. When
                  // the run reaches a terminal state and the tail catches up,
                  // server emits `subscribe_done`.
  "resume_conversation", // { conversation_id, after_seq }
                  // lcp-2hf.1: replay mobile WS frames with conv_seq > after_seq.
                  // May also be supplied as hello.resume for reconnect bootstraps.
  "cron_list", // { request_id?, agent_id?, conversation_id? } — read crons.json
  "cron_add", // { request_id?, agent_id, conversation_id?, name, description,
              //   prompt, recurring, cron? | every? | at?, timezone? }
              // Exactly one of cron/every/at must be supplied. `every` accepts
              // "5m"/"2h"/"1d"; `at` accepts "3pm"/"in 30m". Server resolves
              // to a 5-field cron + optional scheduled_for.
  "cron_get", // { request_id?, task_id }
  "cron_delete", // { request_id?, task_id }
  "cron_delete_all", // { request_id?, agent_id }
]);

export const SERVER_FRAMES = Object.freeze([
  "welcome", // { server_id, session_id, device_id, capabilities, canonical_live_transport, transport_contract, a2ui_negotiated?, a2ui? }
  "a2ui_capabilities", // { version, catalog_id, supported_catalogs, supported_widgets }
  "a2ui_frame", // { turn_id, run_id, otid?, ok, a2ui, raw?, parse_error?, validation_error? }
                  // One A2UI v0.9 message object extracted from the
                  // assistant text stream. Multiple messages arrive as
                  // multiple a2ui_frame envelopes, not as a top-level array.
                  // `ok=false` carries diagnostic fields the client may
                  // surface in a debug panel.
  "user_action_ack", // { action_id, status, reason?, routed_as? }
                  // Ack for a `user_action` frame.
  "user_action_outcome", // { frame_id, action_id?, outcome, detail? }
                  // UI-facing outcome for a `user_action` frame.
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
  "subscribe_frame", // { run_id, seq, frame }
                  // lcp-p74.2: a replayed frame from a run's frames.jsonl
                  // (or a live-tailed new append). `frame` is the BridgeFrame
                  // shape the host emitted at write time; the client renders
                  // it the same way it would a live frame of the same
                  // `message_type`. `seq` is the cursor the client should
                  // remember for resume.
  "subscribe_done", // { run_id, last_seq, status }
                  // lcp-p74.2: subscription complete because the run has
                  // reached a terminal state (completed/failed/cancelled/
                  // expired) AND the tail has caught up. `last_seq` is the
                  // largest seq the server has emitted for this subscription.
  "conversation_resume_done", // { conversation_id, after_seq, last_seq, replayed }
  "cron_list_response", // { request_id?, success, tasks?, error? }
  "cron_add_response", // { request_id?, success, task?, error?, warning? }
  "cron_get_response", // { request_id?, success, task?, error? }
  "cron_delete_response", // { request_id?, success, error? }
  "cron_delete_all_response", // { request_id?, success, count?, error? }
  "crons_updated", // { reason, tasks_active, at }
                  // Server push when crons.json changes. Reasons: client_mutation,
                  // scheduler_write (a tick fired a task), external_write (the
                  // bundled letta CLI or self-schedule skill wrote the file).
]);

export const ERROR_CODES = Object.freeze({
  INVALID_TOKEN: "invalid_token",
  PROTOCOL_VIOLATION: "protocol_violation",
  AGENT_NOT_FOUND: "agent_not_found",
  CONVERSATION_NOT_FOUND: "conversation_not_found",
  RUN_NOT_FOUND: "run_not_found",
  CURSOR_EXPIRED: "cursor_expired",
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
