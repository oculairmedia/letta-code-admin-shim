/**
 * Types for letta-code's raw stream-json frames.
 *
 * letta-code (`letta` CLI, `--output-format stream-json`) prints one JSON
 * object per line to stdout while a turn is running. The admin shim consumes
 * those frames in `lib/chat.mjs` (`reshapeFrame`) and rewrites them into the
 * vanilla Letta server SSE wire format that mobile clients expect.
 *
 * These types describe the UPSTREAM shape — what letta-code emits. The
 * vanilla wire shape the shim emits downstream is covered by `wire.ts`
 * (Phase 2a). Keep the two in lockstep when adding new variants.
 *
 * Lifecycle of a single turn (top-level `type`):
 *   1. `system`               — init frame (model, tools, cwd, etc.)
 *   2. `queue_item_enqueued`  — user message placed on the agent queue
 *   3. `queue_batch_dequeued` — agent picked up the message
 *   4. `queue_cleared`        — queue drained
 *   5. `stream_event` * N     — inner LettaInnerEvent per `message_type`
 *      - `auto_approval`      — interleaved when `permission_mode=unrestricted`
 *   6. `result`               — terminal frame (success/error, final text)
 *
 * Ground-truth fixtures live in
 *   admin-shim/test/fixtures/stream-traces/*.jsonl
 * Variants only appearing in a single fixture are noted on the field.
 */

// ── Top-level top-of-stream frames ────────────────────────────────

/**
 * First frame of any turn. Carries session/agent identity, the model
 * handle, the tool registry letta-code loaded, and runtime flags.
 *
 * @example fixtures/stream-traces/plain.jsonl line 1
 */
export interface SystemInitFrame {
  type: "system";
  subtype: "init";
  session_id: string;
  agent_id: string;
  conversation_id: string;
  model: string;
  tools: string[];
  cwd: string;
  /** MCP server names exposed to the agent. Always present, often `[]`. */
  mcp_servers: string[];
  /** Empty string when default (interactive), "unrestricted" for auto-approve. */
  permission_mode: string;
  slash_commands: string[];
  memfs_enabled: boolean;
  /** "bundled" | "global" | "agent" | "project" (combinations allowed). */
  skill_sources: string[];
  system_info_reminder_enabled: boolean;
  /** Either "step-count" or "token-count" in observed fixtures. */
  reflection_trigger: string;
  reflection_step_count: number;
  /** Frame uuid — distinct from `session_id`. */
  uuid: string;
  /** Wall-clock ISO timestamp when this frame was emitted. */
  timestamp: string;
  /** Sometimes-present extras seen on init frames. */
  version?: string;
}

// ── Queue lifecycle frames ────────────────────────────────────────

/**
 * Emitted when a user message (or other queue item) is appended to
 * the per-session queue.
 *
 * @example fixtures/stream-traces/plain.jsonl line 2
 */
export interface QueueItemEnqueuedFrame {
  type: "queue_item_enqueued";
  item_id: string;
  client_message_id: string;
  /** "user" in every observed fixture. */
  source: string;
  /** "message" in every observed fixture. */
  kind: string;
  queue_len: number;
  session_id: string;
  uuid: string;
  timestamp: string;
}

/**
 * Emitted when the agent runner picks one or more queued items
 * (`item_ids`) up as a single batch.
 *
 * @example fixtures/stream-traces/plain.jsonl line 3
 */
export interface QueueBatchDequeuedFrame {
  type: "queue_batch_dequeued";
  batch_id: string;
  item_ids: string[];
  merged_count: number;
  queue_len_after: number;
  session_id: string;
  uuid: string;
  timestamp: string;
}

/**
 * Emitted when the queue drains or the runner shuts down. `reason` is
 * "shutdown" in every observed fixture, `cleared_count` is 0.
 *
 * @example fixtures/stream-traces/plain.jsonl line 4
 */
export interface QueueClearedFrame {
  type: "queue_cleared";
  reason: string;
  cleared_count: number;
  session_id: string;
  uuid: string;
  timestamp: string;
}

// ── Auto-approval frame (interleaved between stream_event runs) ───

/**
 * Emitted right after an `approval_request_message` when
 * `permission_mode=unrestricted` — the runner auto-accepts the call.
 * Appears at top-level, NOT inside `stream_event.event`.
 *
 * Note: this variant is NOT inside `stream_event` — it's a peer of it.
 *
 * @example fixtures/stream-traces/bash-tool.jsonl line 8
 */
export interface AutoApprovalFrame {
  type: "auto_approval";
  tool_call: LettaToolCall;
  reason: string;
  matched_rule: string;
  session_id: string;
  uuid: string;
  timestamp: string;
}

// ── Result (terminal) frame ───────────────────────────────────────

/**
 * Final frame of any turn — carries the coalesced assistant text and
 * total counters. Appears once at end of stream. `usage` is null in
 * every observed fixture; per-run usage lives in inline
 * `usage_statistics` events.
 *
 * @example fixtures/stream-traces/plain.jsonl line 9
 */
export interface ResultFrame {
  type: "result";
  /** "success" in every observed fixture. */
  subtype: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  /** Coalesced final assistant text (empty string for empty replies). */
  result: string;
  agent_id: string;
  conversation_id: string;
  run_ids: string[];
  /** Always null in observed fixtures; reserved for aggregated counters. */
  usage: unknown;
  uuid: string;
  timestamp: string;
}

// ── Stream-event wrapper ──────────────────────────────────────────

/**
 * Wrapper carrying one of the per-message-type inner events. The outer
 * frame holds the wall-clock `timestamp`; the inner event holds a
 * sentinel `date` (2026-01-01T00:00:0N.000Z, where N encodes order).
 * The shim's `reshapeFrame` forwards the outer timestamp onto the
 * inner so downstream clients sort correctly.
 *
 * @example fixtures/stream-traces/plain.jsonl line 5
 */
export interface StreamEventFrame {
  type: "stream_event";
  event: LettaInnerEvent;
  session_id: string;
  uuid: string;
  timestamp: string;
}

// ── Top-level discriminated union ─────────────────────────────────

/**
 * Discriminated union of every top-level frame letta-code can emit on
 * its stream-json stdout pipe. Discriminate by `type`.
 */
export type LettaStreamFrame =
  | SystemInitFrame
  | QueueItemEnqueuedFrame
  | QueueBatchDequeuedFrame
  | QueueClearedFrame
  | StreamEventFrame
  | AutoApprovalFrame
  | ResultFrame;

// ── Inner event types (inside stream_event.event) ─────────────────

/**
 * Common envelope on every `stream_event.event` payload that survives
 * to mobile. Stop-reason and usage-statistics are bare (no id/date).
 */
interface InnerEventBase {
  id: string;
  /** Sentinel date (2026-01-01T00:00:0N.000Z) — encodes seq order. */
  date: string;
  agent_id: string;
  conversation_id: string;
  run_id: string;
  seq_id: number;
}

/**
 * Streamed assistant text chunk. `content` is always a single-element
 * array `[{type:"text", text:"..."}]`; multiple chunks share the same
 * `otid` so mobile groups them. The shim flattens to a string before
 * forwarding to clients.
 *
 * @example fixtures/stream-traces/plain.jsonl line 5
 */
export interface AssistantMessageEvent extends InnerEventBase {
  message_type: "assistant_message";
  /** Provider-side assistant id, shared across chunks of one reply. */
  otid: string;
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Reasoning trace from a reasoner model. Not observed in current
 * fixtures (no reasoning-enabled traces captured yet) — shape follows
 * vanilla Letta and the shim's `translate.mjs`/`chat.mjs` handling.
 *
 * @example (see translate.mjs lines 272-289 — no fixture variant yet)
 */
export interface ReasoningMessageEvent extends InnerEventBase {
  message_type: "reasoning_message";
  otid?: string;
  /** Always "reasoner_model" in shim output; upstream may omit. */
  source?: string;
  reasoning: string;
  signature?: string | null;
}

/**
 * Tool call as letta-code emits it on the stream. ALL tool calls
 * (auto-approved or not) appear with `message_type: "approval_request_message"`
 * upstream. The shim's `reshapeFrame` (chat.mjs) remaps this to
 * `tool_call_message` with id `toolcall-${tool_call_id}` for parity
 * with vanilla and the on-disk projection.
 *
 * @example fixtures/stream-traces/bash-tool.jsonl line 5
 */
export interface ApprovalRequestMessageEvent extends InnerEventBase {
  message_type: "approval_request_message";
  tool_call: LettaToolCall;
}

/**
 * Already-shaped tool call event. Not observed in current upstream
 * fixtures (the upstream emits `approval_request_message` instead),
 * but `chat.mjs:reshapeFrame` accepts this variant too if a future
 * letta-code starts emitting it natively. Kept for forward-compat.
 *
 * @example (see chat.mjs line 220 — no fixture variant yet)
 */
export interface ToolCallMessageEvent extends InnerEventBase {
  message_type: "tool_call_message";
  otid?: string;
  tool_call: LettaToolCall;
  tool_calls?: LettaToolCall[];
}

/**
 * Tool execution result. Not observed in current upstream fixtures —
 * letta-code surfaces tool returns via the LocalStore on-disk
 * projection (translate.mjs), not the stream. Kept for forward-compat
 * with chat.mjs:reshapeFrame's tool_return_message branch.
 *
 * @example (see chat.mjs line 243 — no fixture variant yet)
 */
export interface ToolReturnMessageEvent extends InnerEventBase {
  message_type: "tool_return_message";
  otid?: string;
  tool_call_id: string;
  /** "success" or "error". */
  status: string;
  tool_return: string;
  stdout?: string | null;
  stderr?: string | null;
  tool_returns?: LettaToolReturn[];
  is_err?: boolean | null;
}

/**
 * Per-turn token usage. `prompt_tokens + completion_tokens =
 * total_tokens`; `context_tokens` is set equal to `total_tokens` in
 * every observed fixture. Bare envelope — no id/date when re-emitted
 * by the shim. NOTE: the upstream event still carries the standard
 * id/date/run_id/seq_id; the shim's `reshapeFrame` strips them.
 *
 * @example fixtures/stream-traces/plain.jsonl line 7
 */
export interface UsageStatisticsEvent extends InnerEventBase {
  message_type: "usage_statistics";
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
  context_tokens: number;
  /** Sometimes-present when prompt-caching writes occur. */
  cache_write_tokens?: number;
}

/**
 * Turn terminator. Observed values: "end_turn", "requires_approval".
 * Vanilla also emits "max_steps" / "cancelled" — types stay loose
 * (string) to avoid breaking on future variants.
 *
 * @example fixtures/stream-traces/plain.jsonl line 8
 */
export interface StopReasonEvent {
  message_type: "stop_reason";
  stop_reason: string;
  run_id: string;
  seq_id: number;
}

/**
 * Heartbeat ping. Not observed in current fixtures (turns complete
 * faster than the ping interval), but the shim's `reshapeFrame`
 * accepts it explicitly. Outer envelope present but minimal.
 *
 * @example (see chat.mjs line 170 — no fixture variant yet)
 */
export interface PingEvent {
  message_type: "ping";
  id?: string;
  date?: string;
  run_id?: string;
  timestamp?: string;
}

/**
 * Discriminated union of every event that can appear inside
 * `stream_event.event`. Discriminate by `message_type`.
 */
export type LettaInnerEvent =
  | AssistantMessageEvent
  | ReasoningMessageEvent
  | ApprovalRequestMessageEvent
  | ToolCallMessageEvent
  | ToolReturnMessageEvent
  | UsageStatisticsEvent
  | StopReasonEvent
  | PingEvent;

// ── Shared sub-shapes ─────────────────────────────────────────────

/** Tool call payload as emitted on the stream (and inside auto_approval). */
export interface LettaToolCall {
  name: string;
  /** JSON-encoded argument object (string, NOT parsed). */
  arguments: string;
  tool_call_id: string;
}

/** Tool return payload (one entry per call). */
export interface LettaToolReturn {
  tool_call_id: string;
  /** "success" or "error". */
  status: string;
  stdout: string | null;
  stderr: string | null;
  func_response: string;
  /** "tool" in observed paths. */
  type: string;
}

// ── LocalStore on-disk message record ─────────────────────────────

/**
 * One LocalMessage as letta-code writes it to
 * `<storageDir>/conversations/<key>/messages.jsonl`. Each line is one
 * JSON object of this shape. The shim's projection
 * (`translate.mjs:localMessageToConversationMessages`) fans one of
 * these out into ONE OR MORE vanilla wire messages.
 *
 * Post-pi-backup letta-code (0.25.x) writes a NEW shape for tool turns:
 * each tool result is a TOP-LEVEL row with `role: "toolResult"` plus
 * the top-level `toolCallId` / `toolName` / `isError` fields below
 * (not a part inside an assistant message). The assistant message
 * carrying the matching tool call uses `{type:"toolCall", id, name,
 * arguments}` parts (camelCase, `id` instead of `toolCallId`, object
 * args). The translator handles both old and new shapes.
 *
 * @example fixtures see migrator/out/conversations/<key>/messages.jsonl
 */
export interface LocalMessage {
  id: string;
  role: LocalMessageRole;
  parts: LocalMessagePart[];
  metadata?: LocalMessageMetadata;
  /** Top-level toolCallId — present iff role === "toolResult" (new shape). */
  toolCallId?: string;
  /** Top-level toolName — present iff role === "toolResult" (new shape). */
  toolName?: string;
  /** Top-level isError — present iff role === "toolResult" (new shape). */
  isError?: boolean;
}

export type LocalMessageRole = "user" | "assistant" | "system" | "tool" | "toolResult";

export interface LocalMessageMetadata {
  /** Sentinel ISO when the agent wrote the row; real time lives in sidecar. */
  created_at?: string;
  updated_at?: string;
  agent_id?: string;
  conversation_id?: string;
}

/**
 * Parts inside a LocalMessage. letta-code mixes native parts
 * (`text`, `reasoning`, `step-start`) with one-tool-per-part records
 * keyed by `tool-${ToolName}` (e.g. `tool-Bash`, `tool-Read`). The
 * generic `tool-${string}` variant covers any tool the backend loads.
 */
export type LocalMessagePart =
  | { type: "text"; text: string; state?: "done" | "streaming" }
  | { type: "reasoning"; text: string; providerMetadata?: { signature?: string } }
  | { type: "step-start" }
  | LocalMessageToolCallPart
  | LocalMessageToolReturnPart
  | LocalMessageNativeToolPart
  | LocalMessageToolCallContentPart;

/**
 * New-shape assistant tool-call part written by letta-code 0.25.x
 * (post-pi-backup migrate-transcripts). Replaces the old hyphenated
 * `tool-call` variant for assistant rows: `{type:"toolCall", id, name,
 * arguments}` where `id` carries the toolCallId and `arguments` is an
 * object (not a JSON string).
 *
 * @example {"type":"toolCall","id":"toolu_abc","name":"Bash",
 *           "arguments":{"command":"ls"}}
 */
export interface LocalMessageToolCallContentPart {
  type: "toolCall";
  id: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
}

/** Bare tool-call part (rare — most go via `tool-${name}` native form). */
export interface LocalMessageToolCallPart {
  type: "tool-call";
  toolCallId: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
}

/** Bare tool-return part (rare — most go via `tool-${name}` native form). */
export interface LocalMessageToolReturnPart {
  type: "tool-return";
  toolCallId: string;
  name?: string;
  status?: "success" | "error";
  tool_return?: string;
  stdout?: string | null;
  stderr?: string | null;
}

/**
 * Native LocalBackend tool part: one part carries both the request
 * (`input`) and, once the tool finishes, the response (`output` or
 * `errorText`) plus a state. The projection emits BOTH a
 * `tool_call_message` and `tool_return_message` wire frame from one
 * of these.
 *
 * @example migrator/out/conversations/<key>/messages.jsonl entries
 *   like `{"type":"tool-Bash","toolCallId":"toolu_...",...}`
 */
export interface LocalMessageNativeToolPart {
  /** `tool-${ToolName}` — Bash, Read, Edit, Glob, Grep, Write, Skill, etc. */
  type: `tool-${string}`;
  toolCallId: string;
  /** "input-streaming" | "input-available" | "output-available" |
   *  "output-error" | "output-denied" per LocalMessageProjection. */
  state: string;
  input?: string | Record<string, unknown>;
  /** Array of content parts when state="output-available". */
  output?: unknown;
  /** Set when state is "output-error" or "output-denied". */
  errorText?: string;
}
