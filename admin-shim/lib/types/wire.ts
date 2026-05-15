/**
 * Wire shapes emitted by the admin-shim over its `/v1/*` and `/shim/*` HTTP
 * surface — i.e. the vanilla-Letta-compatible payloads consumers (letta-mobile,
 * curl, anything that talks to a Letta server) actually see.
 *
 * This file is the OUTBOUND contract. The INBOUND letta-code raw stream
 * (`type:"system"|"message"|"stream_event"|"result"`) is a separate type set
 * that lives in Phase 2b — do NOT conflate. When letta-code's raw stream
 * disagrees with vanilla, `lib/chat.mjs reshapeFrame` reshapes it; the result
 * of that reshape is what these types describe.
 *
 * Canonical references:
 *   Consumer (Kotlin):   /opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/*.kt
 *   Producer (mjs):      ./chat.mjs, ./translate.mjs, ./runs.mjs, ./store.mjs, ../server.mjs
 *
 * ─── LOCKED BEHAVIORAL CONTRACTS the types must respect ──────────────
 *
 * Several quirks below are deliberate, pinned-in-place behavior (see
 * /opt/stacks/letta-code-parallel/HANDOFF.md §"Locked behavioral contracts"):
 *
 *   1. APPROVAL → TOOL_CALL REMAP. letta-code's raw stream emits
 *      `approval_request_message` for ALL tool calls. `chat.mjs reshapeFrame`
 *      rewrites them to `tool_call_message` with id `toolcall-${tool_call_id}`
 *      before they reach the wire — so `ApprovalRequestMessage` does NOT
 *      typically appear on the outbound SSE/REST surface, only inside the
 *      raw-stream and disk projection contexts. Mobile's `distinctBy { id }`
 *      depends on the toolcall- prefix; do not change it.
 *
 *   2. cm-stream- ID PREFIX. Streamed `assistant_message` frames get their
 *      id rewritten by `tagAsOptimistic` to `cm-stream-${id}` so mobile's
 *      `dedupeOptimisticContentTwins` (which keys on a `cm-` / `client-`
 *      prefix) can collapse them against the disk-fetched confirmed copy.
 *      tool_call_message / tool_return_message ids are NOT rewritten — their
 *      `toolcall-` / `toolreturn-` prefixes are already stable across
 *      stream and disk projection, and rewriting them would break strict-id
 *      dedup.
 *
 *   3. PER-TYPE DATE OFFSETS. Both the live stream (chat.mjs `TYPE_OFFSET`)
 *      and the disk projection (translate.mjs `TYPE_OFFSET_MS`) apply a
 *      shared per-message-type ms offset to `date`:
 *        user_message       +0,  reasoning_message +10,
 *        tool_call_message +20,  tool_return_message +30,
 *        assistant_message +40,  ping +0
 *      This keeps cross-side ordering deterministic regardless of dedup
 *      winner. `date` therefore does NOT carry a real timestamp on the wire —
 *      it's anchored to turnStartedAt + offset.
 *
 *   4. FIRST-FRAME `usage`. The run-level `usage` on the Run record is
 *      captured from the FIRST `usage_statistics` frame of the turn, NOT
 *      summed across frames. Per-step usage in steps.jsonl IS per-step.
 *      See `runs.test.mjs` for the assertion.
 *
 *   5. FIRST-STEP `stop_reason`. The run-level `stop_reason` is the FIRST
 *      step's stop, not the final one. So e.g. a bash-tool turn can show
 *      `status: "completed"` together with `stop_reason: "requires_approval"`.
 *
 * None of these are enforced in the type system — they're behavioral
 * contracts. The types describe what the wire actually looks like, including
 * surprising ids and dates.
 */

// ──────────────────────────────────────────────────────────────────────
// LettaMessage discriminated union
// ──────────────────────────────────────────────────────────────────────

/**
 * Common fields present on every wire message variant. The shim's reshape
 * and projection paths fill every field (sometimes with `null`) — they're
 * never omitted, only nulled. See `chat.mjs reshapeFrame` (lib/chat.mjs:136)
 * and `translate.mjs localMessageToConversationMessages` (lib/translate.mjs:194).
 *
 * @see /opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/Message.kt — `LettaMessage` sealed interface
 */
export interface LettaMessageBase {
  /** Stable id. NOTE: streamed assistant_message gets `cm-stream-` prefix
   *  applied AFTER reshape (see locked contract #2). */
  id: string;
  /** ISO timestamp. NOTE: anchored to turnStartedAt + per-type offset, not
   *  a real wall-clock time (locked contract #3). */
  date: string | null;
  name: string | null;
  otid: string | null;
  sender_id: string | null;
  step_id: string | null;
  is_err: boolean | null;
  seq_id: number | null;
  run_id: string | null;
}

/** @see Message.kt `UserMessage` — content is a plain string on the wire (Kotlin
 *  accepts JsonElement to tolerate legacy [{type:"text",text:"…"}] arrays,
 *  but the shim always emits a flat string). System reminders are stripped
 *  off user-role content at projection time (translate.mjs:121-127).
 *  @see lib/translate.mjs:215-235, lib/chat.mjs:217-219 */
export interface UserMessage extends LettaMessageBase {
  message_type: "user_message";
  content: string;
}

/** @see Message.kt `AssistantMessage`
 *  @see lib/chat.mjs:217-219, lib/translate.mjs:242-259 */
export interface AssistantMessage extends LettaMessageBase {
  message_type: "assistant_message";
  content: string;
}

/** @see Message.kt `SystemMessage`
 *  @see lib/translate.mjs:215-235 */
export interface SystemMessage extends LettaMessageBase {
  message_type: "system_message";
  content: string;
}

/** @see Message.kt `ReasoningMessage`
 *  @see lib/chat.mjs:209-216, lib/translate.mjs:272-289 */
export interface ReasoningMessage extends LettaMessageBase {
  message_type: "reasoning_message";
  /** Defaults to `"reasoner_model"` if absent on the input frame. */
  source: string | null;
  reasoning: string;
  signature: string | null;
}

/** Single tool call entry inside a `tool_call_message`.
 *
 * The Kotlin model allows BOTH `id` and `tool_call_id` to be optional with
 * an `effectiveId` accessor. The shim's emitted shape always populates
 * `tool_call_id` (via translate.mjs) but accepts either on the way in. We
 * encode the shim-emitted shape (`tool_call_id` required) and mark the
 * legacy `id` field optional.
 *
 * @see Message.kt `ToolCall`
 * @see lib/translate.mjs:294-315, lib/chat.mjs:234-241
 */
export interface ToolCall {
  id?: string;
  tool_call_id: string;
  name: string;
  /** JSON-encoded arguments string (per OpenAI / Letta convention). */
  arguments: string;
  type?: string;
}

/** @see Message.kt `ToolCallMessage`
 *
 * Both `tool_call` (legacy single) AND `tool_calls` (array) are emitted by
 * the shim — Kotlin's `ToolCallListSerializer` already tolerates a single
 * object in `tool_calls` for streaming deltas, but the shim normalizes to
 * the array form on the wire (`tool_calls: [tc]`) plus a duplicate single
 * `tool_call` for older clients.
 *
 * id is `toolcall-${tool_call_id}` (locked contract #1).
 *
 * @see lib/chat.mjs:220-242, lib/translate.mjs:294-315
 */
export interface ToolCallMessage extends LettaMessageBase {
  message_type: "tool_call_message";
  tool_call: ToolCall | null;
  tool_calls: ToolCall[] | null;
}

/** One entry inside `tool_returns[]` — vanilla Letta's per-call return record.
 *
 * Kotlin's `ToolReturn` requires `tool_call_id` and `status`; the shim
 * populates both unconditionally. `func_response` is the stringified result
 * payload; `type` is "tool" for ordinary returns.
 *
 * @see Message.kt `ToolReturn`
 * @see lib/translate.mjs:399-408
 */
export interface ToolReturn {
  tool_call_id: string;
  status: string;
  func_response: string | null;
  /** Kotlin Message.kt declares `List<String>?`; the shim's disk-projection
   * path (translate.mjs `tool-return` branch) passes through whatever the
   * upstream LocalMessage carried, which historically can be a bare scalar
   * `string` for some tool integrations. Widening to `string | string[] | null`
   * preserves runtime behavior; lcp-2zn tracks normalizing this to
   * `string[] | null`. */
  stdout: string | string[] | null;
  stderr: string | string[] | null;
  type?: string;
}

/** @see Message.kt `ToolReturnMessage`
 *
 * id is `toolreturn-${tool_call_id}`. `tool_return` is the same payload as
 * `tool_returns[0].func_response` flattened to a string (stream-emit path,
 * chat.mjs:248-254) or to a stringified JSON object (disk-projection path,
 * translate.mjs:430).
 *
 * @see lib/chat.mjs:243-256, lib/translate.mjs:382-446
 */
export interface ToolReturnMessage extends LettaMessageBase {
  message_type: "tool_return_message";
  tool_return: string | null;
  status: string;
  tool_call_id: string | null;
  /** See {@link ToolReturn.stdout} — same scalar-passthrough caveat. */
  stdout: string | string[] | null;
  /** See {@link ToolReturn.stderr} — same scalar-passthrough caveat. */
  stderr: string | string[] | null;
  tool_returns: ToolReturn[] | null;
}

/**
 * Approval request frame.
 *
 * IMPORTANT — this variant does NOT typically appear on the shim's outbound
 * wire. `chat.mjs reshapeFrame` (lib/chat.mjs:220-242) REMAPS every
 * `approval_request_message` from letta-code's raw stream into a
 * `ToolCallMessage` with id `toolcall-${tool_call_id}` (locked contract #1
 * — mobile's id-dedup depends on it). The shape persists here because:
 *   - the disk record in messages.jsonl can carry the original variant for
 *     non-auto-approved tool flows;
 *   - mobile still has a Kotlin model for it, so a strictly compliant
 *     vanilla-Letta server could emit it and we'd type-check.
 *
 * Treat as "rare on this shim's surface, present for completeness."
 *
 * @see Message.kt `ApprovalRequestMessage`
 * @see lib/chat.mjs:220-242 (the remap site)
 */
export interface ApprovalRequestMessage extends LettaMessageBase {
  message_type: "approval_request_message";
  tool_call: ToolCall | null;
  tool_calls: ToolCall[] | null;
}

/** Per-tool approval result inside an `ApprovalResponseMessage.approvals`.
 *
 * Note Kotlin's `ApprovalResult` makes every field nullable; the shim does
 * not currently emit this shape on the wire (the mobile client supplies it
 * inbound on POST /v1/agents/{id}/messages bodies), so we mirror Kotlin's
 * permissive shape verbatim.
 *
 * @see Message.kt `ApprovalResult`
 */
export interface ApprovalResult {
  tool_call_id: string | null;
  tool_return: string | null;
  status: string | null;
  type: string | null;
  approve: boolean | null;
  reason: string | null;
  stdout: string[] | null;
  stderr: string[] | null;
}

/** @see Message.kt `ApprovalResponseMessage`
 *
 * Like ApprovalRequestMessage — rarely seen outbound; primarily an inbound
 * shape on POST bodies. Included for completeness so the union covers what
 * the Kotlin client deserializes.
 */
export interface ApprovalResponseMessage extends LettaMessageBase {
  message_type: "approval_response_message";
  approvals: ApprovalResult[] | null;
  approve: boolean | null;
  approval_request_id: string | null;
  reason: string | null;
}

/** Bare end-of-turn stop frame — vanilla emits this WITHOUT the full
 *  `LettaMessageBase` envelope. The shim matches that bare shape exactly
 *  (chat.mjs:153-155): `{ message_type, stop_reason }` and nothing else on
 *  the SSE path; the non-streaming JSON response wraps it the same way
 *  (chat.mjs:499-500).
 *
 *  Diverges from Kotlin's `StopReason` (Message.kt:495-506), which gives it
 *  the LettaMessageBase ids/dates with defaulted UUIDs. The shim wins —
 *  we encode the bare shape so mobile's bare-shape parser hits the right
 *  branch.
 *
 *  @see Message.kt `StopReason`
 *  @see lib/chat.mjs:153-155
 */
export interface StopReasonMessage {
  message_type: "stop_reason";
  stop_reason: string;
}

/** Bare usage envelope — same shape note as StopReasonMessage.
 *
 *  The shim emits a fixed-shape object with every numeric defaulted to 0,
 *  `step_count: 1` and `run_ids: null` (chat.mjs:156-169). Kotlin's
 *  `UsageStatistics` (Message.kt:509-532) is the full-envelope form with all
 *  the bookkeeping fields — the shim does NOT emit those on the SSE stream
 *  bare envelope. The shim's shape wins for the SSE path.
 *
 *  @see Message.kt `UsageStatistics`
 *  @see lib/chat.mjs:156-169
 */
export interface UsageStatisticsMessage {
  message_type: "usage_statistics";
  completion_tokens: number;
  prompt_tokens: number;
  total_tokens: number;
  step_count: number;
  /** Always `null` from chat.mjs:163; included so consumers reading the
   *  field don't trip a missing-property warning. */
  run_ids: string[] | null;
  cached_input_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  context_tokens: number;
}

/** @see Message.kt `PingMessage`
 *  @see lib/chat.mjs:170-183, 261-274 */
export interface PingMessage extends LettaMessageBase {
  message_type: "ping";
}

/**
 * Discriminated union over `message_type`. Use narrowing on `message_type`
 * to access variant-specific fields.
 *
 * Note that two variants (StopReasonMessage, UsageStatisticsMessage) have a
 * bare shape — they lack the `id` / `date` / `otid` envelope — so the union
 * is genuinely heterogeneous, not just heterogeneous by extension. Type
 * guards on `message_type` cover both shapes cleanly.
 */
export type LettaMessage =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ReasoningMessage
  | ToolCallMessage
  | ToolReturnMessage
  | ApprovalRequestMessage
  | ApprovalResponseMessage
  | StopReasonMessage
  | UsageStatisticsMessage
  | PingMessage;

// ──────────────────────────────────────────────────────────────────────
// SSE envelope union — what the shim actually writes to streams
// ──────────────────────────────────────────────────────────────────────

/**
 * One SSE `data:` frame on the `/v1/agents/{id}/messages` (streaming),
 * `/v1/conversations/{id}/stream`, and related stream endpoints.
 *
 * Mobile's `SseParser` ignores `event:` lines and reads JSON out of `data:`
 * payloads, so every frame is just a JSON object whose top-level
 * `message_type` discriminates. After the final stop_reason/usage frames,
 * the shim writes a literal `data: [DONE]\n\n` sentinel (chat.mjs:74-76),
 * which is NOT JSON — `SseDoneSentinel` represents that separately.
 *
 * @see lib/chat.mjs:67-76 (frame writer), 401-472 (stream emit ordering)
 */
export type SseFrame = LettaMessage;

/** Literal terminator emitted at end-of-stream. Not a JSON object. */
export type SseDoneSentinel = "[DONE]";

// ──────────────────────────────────────────────────────────────────────
// Run
// ──────────────────────────────────────────────────────────────────────

/** Subset of UsageStatistics persisted on the Run record.
 *
 *  IMPORTANT: per locked contract #4, `usage` on the Run is captured from
 *  the FIRST `usage_statistics` frame of the turn, NOT summed across
 *  frames. If the model produces multiple usage frames in a multi-step turn,
 *  only the first lands here. Per-step granular usage lives in steps.jsonl.
 *
 *  @see lib/runs.mjs:196-206 (finalizeRun usage capture)
 */
export interface RunUsage {
  completion_tokens: number;
  prompt_tokens: number;
  total_tokens: number;
  step_count: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
}

/**
 * Per-turn Run record. `/v1/runs/*` returns this shape.
 *
 * Field semantics drift from vanilla in a few places, ALL documented:
 *   - `usage`: first frame, not sum (locked contract #4)
 *   - `stop_reason`: first step's stop, not final (locked contract #5)
 *
 * Shim-specific extensions over Kotlin's `Run` (mobile ignores unknown
 * fields per kotlinx.serialization defaults):
 *   - `message_ids`, `tools_used`, `num_steps`, `usage`
 *
 * @see /opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/Run.kt
 * @see lib/runs.mjs:107-145 (createRun shape), 188-210 (finalizeRun)
 */
export interface Run {
  id: string;
  agent_id: string | null;
  background: boolean | null;
  base_template_id: string | null;
  callback_error: string | null;
  callback_sent_at: string | null;
  callback_status_code: number | null;
  callback_url: string | null;
  completed_at: string | null;
  conversation_id: string | null;
  created_at: string | null;
  metadata: Record<string, unknown>;
  request_config: RunRequestConfig | null;
  /** `"running" | "completed" | "failed" | "cancelled"` — see runs.mjs:188-210. */
  status: string | null;
  /** FIRST step's stop_reason; can differ from the final step's. */
  stop_reason: string | null;
  total_duration_ns: number | null;
  ttft_ns: number | null;

  // Shim extensions (additive — vanilla clients ignore):
  message_ids: string[];
  tools_used: string[];
  num_steps: number;
  /** Optional: only present after finalizeRun fires with usage data. */
  usage?: RunUsage;
}

/** @see Run.kt `RunRequestConfig` */
export interface RunRequestConfig {
  assistant_message_tool_kwarg?: string | null;
  assistant_message_tool_name?: string | null;
  include_return_message_types?: string[] | null;
  use_assistant_message?: boolean | null;
}

/** @see Run.kt `RunMetrics`
 *  @see lib/runs.mjs (not directly emitted in current shim — endpoint
 *  returns a derived form). */
export interface RunMetrics {
  id: string;
  organization_id: string | null;
  agent_id: string | null;
  project_id: string | null;
  run_start_ns: number | null;
  run_ns: number | null;
  num_steps: number | null;
  tools_used: string[];
  template_id: string | null;
  base_template_id: string | null;
}

/**
 * Per-step record appended to `runs/<run-id>/steps.jsonl`.
 *
 * The shim writes a minimal record with the fields it cares about plus
 * whatever the caller of `recordRunStep` passes. We type the known core
 * and leave room for caller-supplied extras via `[k: string]: unknown`.
 *
 * @see /opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/Step.kt
 * @see lib/runs.mjs:167-184 (recordRunStep)
 */
export interface Step {
  id: string;
  run_id: string | null;
  agent_id: string | null;
  created_at: string;
  model?: string | null;
  stop_reason?: string | null;
  usage?: Partial<RunUsage>;
  [k: string]: unknown;
}

// ──────────────────────────────────────────────────────────────────────
// Agent, Conversation, Block, UsageStatistics standalone
// ──────────────────────────────────────────────────────────────────────

/** Free-form usage payload as returned standalone (e.g. inside non-streaming
 *  `LettaResponse` from POST /messages). Mirrors Kotlin's full
 *  `UsageStatistics` envelope but as a record-shape, not a LettaMessage.
 *
 *  @see Message.kt `UsageStatistics`
 *  @see lib/chat.mjs:502-508 (non-streaming usage emit)
 */
export interface UsageStatistics {
  completion_tokens: number;
  prompt_tokens: number;
  total_tokens: number;
  step_count: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  context_tokens?: number;
  run_ids?: string[] | null;
}

/** One entry in `agent.memory.blocks[]` AND `/v1/blocks/*`.
 *
 *  @see /opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/Block.kt
 *  @see lib/store.mjs:289-323 (readBlocksForAgent — emits this shape)
 */
export interface Block {
  id: string;
  label: string;
  value: string;
  limit: number | null;
  description: string | null;
  is_template: boolean | null;
  read_only: boolean | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
  hidden: boolean | null;
  project_id: string | null;
  template_id: string | null;
  base_template_id: string | null;
  deployment_id: string | null;
  entity_id: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_id?: string | null;
  last_updated_by_id?: string | null;
  /** Reserved by store.mjs; the shim does not generate this dynamically. */
  template_name?: string | null;
  preserve_on_migration?: boolean;
}

/**
 * llm_config sub-record on Agent. The shim synthesizes this from the local
 * agent record's `model_settings` plus env-derived endpoint. Kotlin uses a
 * dedicated `LlmConfig` class — we keep the shape permissive to match what
 * translate.mjs actually emits (lib/translate.mjs:43-58).
 *
 * @see /opt/stacks/letta-mobile/.../LlmConfig.kt
 */
export interface LlmConfig {
  model: string;
  display_name?: string;
  model_endpoint_type?: string;
  model_endpoint?: string;
  provider_name?: string;
  provider_category?: string;
  model_wrapper?: string | null;
  context_window?: number;
  put_inner_thoughts_in_kwargs?: boolean;
  handle?: string;
  temperature?: number;
  max_tokens?: number;
  enable_reasoner?: boolean;
  reasoning_effort?: string | null;
  [k: string]: unknown;
}

/** embedding_config sub-record. Permissive for the same reason as LlmConfig.
 *  @see /opt/stacks/letta-mobile/.../EmbeddingConfig.kt
 *  @see lib/translate.mjs:59-67 */
export interface EmbeddingConfig {
  embedding_endpoint_type?: string;
  embedding_endpoint?: string;
  embedding_model?: string;
  embedding_dim?: number;
  embedding_chunk_size?: number;
  handle?: string;
  batch_size?: number;
  [k: string]: unknown;
}

/** Memory wrapper inside Agent. Mobile flattens to `blocks: List<Block>`
 *  at the top level; vanilla nests under `memory.blocks`. The shim emits
 *  BOTH (lib/translate.mjs:73-80, 81).
 */
export interface AgentMemory {
  agent_type: string;
  git_enabled: boolean;
  blocks: Block[];
  file_blocks: unknown[];
  prompt_template: unknown | null;
}

/**
 * Agent record returned by `/v1/agents` and `/v1/agents/{id}`.
 *
 * Note the divergence from Kotlin's `Agent` (Agent.kt):
 *   - Kotlin types `blocks: List<Block>` at the top level. The shim emits
 *     `blocks` AND `memory.blocks` (vanilla compat). Kotlin ignores `memory`.
 *   - Kotlin types `metadata` as `Map<String, JsonElement>` non-null with
 *     emptyMap default. The shim emits `null` for empty metadata
 *     (lib/translate.mjs:33). The shim's shape wins for the wire.
 *   - `agent_type` is non-null in shim output ("memgpt_agent") but nullable
 *     in Kotlin — we follow shim.
 *
 * @see /opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/Agent.kt
 * @see lib/translate.mjs:17-104 (agentToLettaState)
 */
export interface Agent {
  id: string;
  name: string;
  description: string | null;
  system: string;
  agent_type: string;
  tags: string[];
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  created_by_id: string | null;
  last_updated_by_id: string | null;
  project_id: string | null;
  template_id: string | null;
  base_template_id: string | null;
  deployment_id: string | null;
  entity_id: string | null;
  tool_rules: unknown[];
  message_ids: string[];
  llm_config: LlmConfig;
  embedding_config: EmbeddingConfig;
  model: string;
  embedding: string;
  model_settings: Record<string, unknown>;
  compaction_settings: Record<string, unknown> | null;
  response_format: unknown | null;
  memory: AgentMemory;
  blocks: Block[];
  tools: unknown[];
  sources: unknown[];
  tool_exec_environment_variables: unknown[];
  secrets: unknown[];
  identity_ids: string[];
  identities: unknown[];
  pending_approval: unknown | null;
  message_buffer_autoclear: boolean;
  enable_sleeptime: boolean;
  multi_agent_group: unknown | null;
  managed_group: unknown | null;
  last_run_completion: string | null;
  last_run_duration_ms: number | null;
  last_stop_reason: string;
  timezone: string;
  max_files_open: number;
  per_file_view_window_char_limit: number;
  hidden: boolean | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_events: unknown[];
  webhook_enabled: boolean;
}

/**
 * Conversation record returned by `/v1/conversations` and friends.
 *
 * NOTE on id: bare `"default"` is intentionally NOT a valid wire id. The
 * shim rewrites each agent's default thread to `conv-default-${agentId}`
 * (translate.mjs:131-137) because `default` collides across agents.
 *
 * Diverges from Kotlin's `Conversation`:
 *   - The shim does NOT emit `archived` / `archived_at` (translate.mjs:141-142
 *     comment — vanilla doesn't expose them here). Kotlin has them as
 *     optional, so we follow the shim and omit.
 *   - `in_context_message_ids` defaults to [] in Kotlin, shim emits [] too.
 *   - `isolated_block_ids` is always [] from the shim.
 *
 * @see /opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/Conversation.kt
 * @see lib/translate.mjs:139-157 (conversationToLetta)
 */
export interface Conversation {
  id: string;
  agent_id: string;
  created_at: string | null;
  updated_at: string | null;
  last_message_at: string | null;
  created_by_id: string;
  last_updated_by_id: string;
  summary: string | null;
  in_context_message_ids: string[];
  isolated_block_ids: string[];
  model: string | null;
  model_settings: Record<string, unknown> | null;
}

// ──────────────────────────────────────────────────────────────────────
// Query-param bags (server.mjs route handlers)
// ──────────────────────────────────────────────────────────────────────

/** Shared pagination params parsed in server.mjs:79-83.
 *  Vanilla's `offset` is shim-specific — vanilla Letta uses before/after id
 *  cursors. The shim accepts both. */
export interface PaginationParams {
  limit?: number;
  offset?: number;
}

/** Query params accepted by `GET /v1/agents` (server.mjs:131-153). */
export interface AgentsListParams extends PaginationParams {
  /** Repeatable: `?tags=a&tags=b`. */
  tags?: string[];
  name?: string;
}

/** Query params accepted by `GET /v1/agents/{id}/messages` (server.mjs:190-203)
 *  and `GET /v1/conversations/{id}/messages` (server.mjs:488-501). */
export interface MessagesListParams extends PaginationParams {
  before?: string;
  /** Vanilla allows "asc" | "desc"; server.mjs lowercases the input. */
  order?: "asc" | "desc";
  conversation_id?: string;
}

/** Query params for `GET /v1/runs` (server.mjs:573-588).
 *  Mirrors Kotlin's `RunListParams` (Run.kt:56-70) with the order /
 *  ascending pair both honored.
 *  @see /opt/stacks/letta-mobile/android-compose/core/src/main/java/com/letta/mobile/data/model/Run.kt */
export interface RunsListParams extends PaginationParams {
  active?: boolean;
  after?: string;
  agent_id?: string;
  agent_ids?: string[];
  ascending?: boolean;
  background?: boolean;
  before?: string;
  conversation_id?: string;
  order?: "asc" | "desc";
  order_by?: string;
  statuses?: string[];
  stop_reason?: string;
}

// Backwards-compat alias for the name used in the migration plan.
export type RunListParams = RunsListParams;
