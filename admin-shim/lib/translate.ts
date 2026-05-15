/**
 * Translators between letta-code's LocalStore on-disk format and the Letta
 * server REST API shape that letta-mobile expects.
 *
 * Direction we care about right now:
 *   LocalAgentRecord (on disk) → Letta server AgentState (HTTP response)
 *   LocalMessage (UIMessage on disk) → Letta server Message (HTTP response)
 *
 * Phase 3c (lcp-u3q): typed against Phase 2 wire/stream types. Behavioral
 * contracts (TYPE_OFFSET_MS schedule, system-reminder stripping, conv id
 * rewrite, agent metadata=null, hybrid-record output from
 * localMessageToLettaMessage) are preserved verbatim.
 */

import type {
  Agent,
  AgentMemory,
  Block,
  Conversation,
  EmbeddingConfig,
  LettaMessage,
  LlmConfig,
  ReasoningMessage,
  ToolCall,
  ToolCallMessage,
  ToolReturn,
  ToolReturnMessage,
} from "./types/wire.js";
import type {
  LocalMessage,
  LocalMessagePart,
  LocalMessageRole,
} from "./types/letta-stream.js";
import type { OnDiskAgentRecord, OnDiskConversation } from "./store.js";

// ──────────────────────────────────────────────────────────────────────
// Model handle parsing
// ──────────────────────────────────────────────────────────────────────

interface ParsedModelHandle {
  provider: string;
  model: string;
}

function parseModelHandle(handle: unknown): ParsedModelHandle {
  if (!handle || typeof handle !== "string") {
    return { provider: "unknown", model: typeof handle === "string" ? handle : "unknown" };
  }
  const idx = handle.indexOf("/");
  if (idx < 0) return { provider: "unknown", model: handle };
  return { provider: handle.slice(0, idx), model: handle.slice(idx + 1) };
}

// ──────────────────────────────────────────────────────────────────────
// Agent projection
// ──────────────────────────────────────────────────────────────────────

export interface AgentToLettaStateOptions {
  messages?: ReadonlyArray<{ id: string }>;
  blocks?: Block[];
}

export function agentToLettaState(
  record: OnDiskAgentRecord,
  { messages = [], blocks = [] }: AgentToLettaStateOptions = {},
): Agent {
  const handle = (typeof record.model === "string" && record.model) ? record.model : "lmstudio/opus-4-7";
  const { provider, model } = parseModelHandle(handle);
  const settings: Record<string, unknown> = record.model_settings ?? {};
  const created = record._ctimeMs ? new Date(record._ctimeMs).toISOString() : new Date().toISOString();
  const updated = record._mtimeMs ? new Date(record._mtimeMs).toISOString() : created;

  const providerType = typeof settings["provider_type"] === "string" ? settings["provider_type"] : null;
  const contextWindow =
    typeof settings["context_window_limit"] === "number" ? settings["context_window_limit"] : 200000;
  const temperature = typeof settings["temperature"] === "number" ? settings["temperature"] : 1.0;
  const maxTokens = typeof settings["max_tokens"] === "number" ? settings["max_tokens"] : 16384;

  const llmConfig: LlmConfig = {
    model,
    display_name: model,
    model_endpoint_type: providerType === "lmstudio" ? "openai" : (providerType ?? "openai"),
    model_endpoint: process.env["LMSTUDIO_BASE_URL"] || "https://api.openai.com/v1",
    provider_name: provider,
    provider_category: "base",
    model_wrapper: null,
    context_window: contextWindow,
    put_inner_thoughts_in_kwargs: false,
    handle,
    temperature,
    max_tokens: maxTokens,
    enable_reasoner: false,
    reasoning_effort: null,
  };

  const embeddingConfig: EmbeddingConfig = {
    embedding_endpoint_type: "openai",
    embedding_endpoint: process.env["LMSTUDIO_BASE_URL"] || "https://api.openai.com/v1",
    embedding_model: "text-embedding-3-small",
    embedding_dim: 1536,
    embedding_chunk_size: 300,
    handle: "openai/text-embedding-3-small",
    batch_size: 32,
  };

  const memory: AgentMemory = {
    agent_type: "memgpt_agent",
    git_enabled: true,
    blocks: blocks,
    file_blocks: [],
    prompt_template: null,
  };

  return {
    id: record.id,
    name: record.name ?? "Untitled",
    description: record.description ?? null,
    system: record.system ?? "",
    agent_type: "memgpt_agent",
    tags: record.tags ?? [],
    // Locked: shim emits `null` for empty metadata (Phase 2a audit). Don't
    // switch to `{}` — Kotlin defaults to emptyMap but the shim's `null`
    // shape wins on the wire.
    metadata: null,
    created_at: created,
    updated_at: updated,
    created_by_id: null,
    last_updated_by_id: null,
    project_id: null,
    template_id: null,
    base_template_id: null,
    deployment_id: null,
    entity_id: null,
    tool_rules: [],
    message_ids: messages.map((m) => m.id),
    llm_config: llmConfig,
    embedding_config: embeddingConfig,
    model: model,
    embedding: "openai/text-embedding-3-small",
    model_settings: settings,
    compaction_settings: record.compaction_settings ?? null,
    response_format: null,
    memory,
    blocks,
    tools: [],
    sources: [],
    tool_exec_environment_variables: [],
    secrets: [],
    identity_ids: [],
    identities: [],
    pending_approval: null,
    message_buffer_autoclear: false,
    enable_sleeptime: false,
    multi_agent_group: null,
    managed_group: null,
    last_run_completion: null,
    last_run_duration_ms: null,
    last_stop_reason: "user",
    timezone: "UTC",
    max_files_open: 10,
    per_file_view_window_char_limit: 40000,
    hidden: null,
    webhook_url: null,
    webhook_secret: null,
    webhook_events: [],
    webhook_enabled: false,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Parts → text helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Wrap a possibly-scalar tool stdout/stderr value into a `string[] | null`
 * to match the wire contract (Kotlin Message.kt declares List<String>?).
 * letta-code's on-disk LocalMessage part can carry either a scalar string
 * (one stdout line) or an array (multi-line capture). Pass arrays through
 * verbatim; lift scalars into a single-element array; null/undefined → null.
 * Filters non-string array entries defensively. See lcp-2zn.
 */
export function toStringArrayOrNull(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) {
      if (typeof v === "string") out.push(v);
    }
    return out;
  }
  if (typeof value === "string") return [value];
  return null;
}

function partsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p): p is { type: "text"; text?: string } =>
      typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text",
    )
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
}

// letta-code prepends one or more `<system-reminder>...</system-reminder>`
// envelopes onto user messages to ship session context to the agent (device
// info, agent identity, permission mode, etc.). These should NEVER reach
// the chat UI — mobile's optimistic user message is just the user's typed
// text, and if the disk-stored version is wrapped, content-equality dedup
// fails and the user sees their prompt rendered twice. Strip them at
// projection time, only for user-role messages.
function stripSystemReminders(text: string): string {
  if (typeof text !== "string") return text;
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ──────────────────────────────────────────────────────────────────────
// Conversation projection
// ──────────────────────────────────────────────────────────────────────

// LocalStore writes the per-agent default thread with id="default", which
// collides across agents. Mobile (and any Letta REST client) expects unique
// conv-* ids. We synthesize one externally so each agent's default thread
// has its own addressable id; the inverse mapping lives in store.ts.
export function externalConversationId(conv: OnDiskConversation | null | undefined): string | null {
  if (!conv) return null;
  if (conv.id === "default") return `conv-default-${conv.agent_id}`;
  return conv.id;
}

export function conversationToLetta(conv: OnDiskConversation | null | undefined): Conversation | null {
  if (!conv) return null;
  // Match vanilla Letta server's Conversation shape exactly. Do NOT add
  // archived/archived_at — vanilla doesn't expose them on this response.
  const externalId = externalConversationId(conv);
  if (externalId === null) return null;
  return {
    id: externalId,
    agent_id: conv.agent_id,
    created_at: conv.created_at ?? null,
    updated_at: conv.updated_at ?? null,
    last_message_at: conv.last_message_at ?? null,
    created_by_id: "user-00000000-0000-4000-8000-000000000000",
    last_updated_by_id: "user-00000000-0000-4000-8000-000000000000",
    summary: conv.summary ?? null,
    in_context_message_ids: conv.in_context_message_ids ?? [],
    isolated_block_ids: [],
    model: null,
    model_settings: null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Per-type date offset (locked behavioral contract — see HANDOFF.md §3)
// ──────────────────────────────────────────────────────────────────────

/**
 * Project ONE LocalMessage into ONE OR MORE Letta-wire messages —
 * mirrors letta-code's own LocalMessageProjection.ts. Text accumulates into
 * one assistant_message; each `tool-call` part becomes a `tool_call_message`,
 * each `tool-return` part becomes a `tool_return_message`.
 */
// letta-code's LocalStore writes messages with sentinel
// `metadata.created_at` dates (Jan 1 2026 + N seconds, where N is the
// sourceMessageIndex). If a `realTimes` map is supplied (read from the
// per-conv sidecar maintained by the agent pool), use the real timestamp
// for any message id present in the map. Otherwise fall back to the
// sentinel — older / unstamped messages keep their original (sort-stable)
// date.
// One source LocalMessage can fan out into MULTIPLE wire messages (e.g. an
// agent source carrying a tool-call + tool-return + assistant text). They
// share one `created` timestamp from the sidecar, so sorting clients can't
// order them. We add fixed per-type offsets that match the stream side
// (chat.mjs `TYPE_OFFSET`) so user → tool_call → tool_return → assistant
// renders correctly regardless of which side wins dedup.
const TYPE_OFFSET_MS = {
  user_message: 0,
  system_message: 0,
  reasoning_message: 10,
  tool_call_message: 20,
  tool_return_message: 30,
  assistant_message: 40,
} as const satisfies Record<string, number>;

type OffsetMessageType = keyof typeof TYPE_OFFSET_MS;

function withTypeOffset(createdIso: string, messageType: OffsetMessageType): string {
  const off = TYPE_OFFSET_MS[messageType];
  if (!Number.isFinite(off) || off === 0) return createdIso;
  const t = Date.parse(createdIso);
  if (!Number.isFinite(t)) return createdIso;
  return new Date(t + off).toISOString();
}

// ──────────────────────────────────────────────────────────────────────
// LocalMessage → wire LettaMessage[] fan-out
// ──────────────────────────────────────────────────────────────────────

export interface LocalMessageScope {
  realTimes?: Record<string, string> | null;
  otidMap?: Record<string, string> | null;
  /**
   * lcp-nwd: messageId -> runId lookup. When provided, projections
   * substitute the run_id field with this value instead of the
   * previous hardcoded null. Built by runs.buildMessageRunMap()
   * over runs whose message_ids[] claimed each persisted message.
   */
  runIdsByMessageId?: Record<string, string> | null;
}

/**
 * Narrow runtime check for the native LocalBackend tool part variant
 * (`tool-${string}` for any tool, excluding the two bare `tool-call` /
 * `tool-return` cases handled elsewhere).
 */
interface NativeToolPart {
  type: string; // `tool-${string}`, runtime-validated below
  toolCallId: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function isNativeToolPart(part: LocalMessagePart): part is LocalMessagePart & NativeToolPart {
  if (typeof part?.type !== "string") return false;
  if (!part.type.startsWith("tool-")) return false;
  if (part.type === "tool-call" || part.type === "tool-return") return false;
  const cand = part as { toolCallId?: unknown };
  return typeof cand.toolCallId === "string";
}

function flattenToolOutput(val: unknown): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    return val
      .map((p) => {
        if (typeof p === "string") return p;
        if (
          typeof p === "object" &&
          p !== null &&
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string"
        ) {
          return (p as { text: string }).text;
        }
        return JSON.stringify(p);
      })
      .join("");
  }
  if (val == null) return "";
  return JSON.stringify(val);
}

export function localMessageToConversationMessages(
  localMsg: LocalMessage,
  scope: LocalMessageScope = {},
): LettaMessage[] {
  const realTimes = scope.realTimes ?? null;
  const otidMap = scope.otidMap ?? null;
  const sentinel = localMsg.metadata?.created_at;
  const real = realTimes && localMsg?.id ? realTimes[localMsg.id] : null;
  const created = real ?? sentinel ?? new Date().toISOString();
  const role: LocalMessageRole = localMsg.role ?? ("system" as LocalMessageRole);
  const parts: LocalMessagePart[] = Array.isArray(localMsg.parts) ? localMsg.parts : [];
  // Mobile's reconcileAfterSend matches `it.otid == sent_otid` on the GET
  // response to swap Local→Confirmed. Default otid is localMsg.id; for any
  // message we've bound to a mobile-supplied otid (via the shim's sidecar)
  // echo back the original optimistic id so the swap fires. Without this
  // the Local user bubble stays alongside the Confirmed disk twin → user
  // sees their prompt twice.
  const mobileOtid = otidMap && localMsg?.id ? otidMap[localMsg.id] : null;
  const projectedOtid = mobileOtid ?? localMsg.id;
  // lcp-nwd: attribute each emitted message to the run that claimed it
  // via run.message_ids during turn finalize. Lookup is by the *source*
  // LocalMessage id (we project 1:N — the fan-out children share the
  // parent id's run attribution).
  const projectedRunId: string | null =
    scope.runIdsByMessageId && localMsg?.id
      ? (scope.runIdsByMessageId[localMsg.id] ?? null)
      : null;

  // User / system messages: collapse all text parts into one wire message.
  // Strip system-reminder envelopes from user-role messages so mobile's
  // optimistic-vs-confirmed dedup can collapse against the user's actual
  // typed text.
  if (role === "user" || role === "system") {
    let text = partsToText(parts);
    if (role === "user") text = stripSystemReminders(text);
    if (!text) return [];
    const wireType: "user_message" | "system_message" = role === "user" ? "user_message" : "system_message";
    return [
      {
        id: localMsg.id,
        date: withTypeOffset(created, wireType),
        name: null,
        message_type: wireType,
        otid: projectedOtid,
        sender_id: null,
        step_id: null,
        is_err: null,
        seq_id: null,
        run_id: projectedRunId,
        content: text,
      },
    ];
  }

  // Assistant / tool: walk parts and emit per-part wire messages, grouping
  // consecutive text parts.
  const out: LettaMessage[] = [];
  let pendingText = "";
  let pendingTextStartIndex = -1;
  const flushText = (): void => {
    if (!pendingText) return;
    const isFirst = out.length === 0;
    out.push({
      id: isFirst ? localMsg.id : `${localMsg.id}:assistant:${pendingTextStartIndex}`,
      date: withTypeOffset(created, "assistant_message"),
      name: null,
      message_type: "assistant_message",
      otid: localMsg.id,
      sender_id: null,
      step_id: null,
      is_err: null,
      seq_id: null,
      run_id: projectedRunId,
      content: pendingText,
    });
    pendingText = "";
    pendingTextStartIndex = -1;
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || typeof part.type !== "string") continue;

    if (part.type === "text" && "text" in part && typeof part.text === "string") {
      if (pendingTextStartIndex === -1) pendingTextStartIndex = i;
      pendingText += part.text;
      continue;
    }

    if (part.type === "reasoning" && "text" in part && typeof part.text === "string") {
      flushText();
      const signature =
        typeof part.providerMetadata?.signature === "string"
          ? part.providerMetadata.signature
          : null;
      const reasoningMsg: ReasoningMessage = {
        id: `${localMsg.id}:reasoning:${i}`,
        date: withTypeOffset(created, "reasoning_message"),
        name: null,
        message_type: "reasoning_message",
        otid: localMsg.id,
        sender_id: null,
        step_id: null,
        is_err: null,
        seq_id: null,
        run_id: projectedRunId,
        source: "reasoner_model",
        reasoning: part.text,
        signature,
      };
      out.push(reasoningMsg);
      continue;
    }

    if (part.type === "tool-call") {
      flushText();
      // The native tool-${string} variant overlaps "tool-call" structurally in
      // TS's template-literal union. Narrow via runtime field probe.
      const tcPart = part as { arguments?: unknown; name?: unknown; toolCallId?: unknown };
      const argsRaw = tcPart.arguments;
      const argsStr =
        typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw ?? {});
      const tc: ToolCall = {
        name: typeof tcPart.name === "string" && tcPart.name ? tcPart.name : "tool",
        arguments: argsStr,
        tool_call_id: typeof tcPart.toolCallId === "string" ? tcPart.toolCallId : "",
      };
      const tcMsg: ToolCallMessage = {
        // Use the same `toolcall-${id}` id format the stream reshape
        // emits so mobile's strict `distinctBy id` dedup collapses
        // stream and conv-list twins.
        id: tc.tool_call_id ? `toolcall-${tc.tool_call_id}` : `${localMsg.id}:tool:${i}:call`,
        date: withTypeOffset(created, "tool_call_message"),
        name: tc.name,
        message_type: "tool_call_message",
        otid: localMsg.id,
        sender_id: null,
        step_id: null,
        is_err: null,
        seq_id: null,
        run_id: projectedRunId,
        tool_call: tc,
        tool_calls: [tc],
      };
      out.push(tcMsg);
      continue;
    }

    // Native letta-code LocalBackend tool part: `tool-${toolName}` with
    // toolCallId, input, output/errorText, state. Per LocalMessageProjection.
    // Emit BOTH a tool_call_message (the request) AND a tool_return_message
    // (the response) when the tool finished running.
    if (isNativeToolPart(part)) {
      flushText();
      const toolName = part.type.slice("tool-".length);
      const argsStr =
        typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
      const tc: ToolCall = {
        name: toolName,
        arguments: argsStr,
        tool_call_id: part.toolCallId,
      };
      const tcMsg: ToolCallMessage = {
        id: `toolcall-${part.toolCallId}`,
        date: withTypeOffset(created, "tool_call_message"),
        name: toolName,
        message_type: "tool_call_message",
        otid: localMsg.id,
        sender_id: null,
        step_id: null,
        is_err: null,
        seq_id: null,
        run_id: projectedRunId,
        tool_call: tc,
        tool_calls: [tc],
      };
      out.push(tcMsg);

      const hasOutput =
        part.state === "output-available" ||
        part.state === "output-error" ||
        part.state === "output-denied";
      if (hasOutput) {
        const isError = part.state !== "output-available";
        const returnText = isError
          ? typeof part.errorText === "string"
            ? part.errorText
            : flattenToolOutput(part.output)
          : flattenToolOutput(part.output);
        const status = isError ? "error" : "success";
        const tr: ToolReturn = {
          tool_call_id: part.toolCallId,
          status,
          stdout: null,
          stderr: null,
          func_response: returnText,
          type: "tool",
        };
        const trMsg: ToolReturnMessage = {
          id: `toolreturn-${part.toolCallId}`,
          date: withTypeOffset(created, "tool_return_message"),
          name: toolName,
          message_type: "tool_return_message",
          otid: localMsg.id,
          sender_id: null,
          step_id: null,
          is_err: isError ? true : null,
          seq_id: null,
          run_id: projectedRunId,
          tool_call_id: part.toolCallId,
          status,
          tool_return: returnText,
          stdout: null,
          stderr: null,
          tool_returns: [tr],
        };
        out.push(trMsg);
      }
      continue;
    }

    if (part.type === "tool-return") {
      flushText();
      const callId = part.toolCallId || "";
      const status = part.status === "error" ? "error" : "success";
      const returnText =
        typeof part.tool_return === "string"
          ? part.tool_return
          : JSON.stringify(part.tool_return ?? "");
      // Mobile's Kotlin Message.kt declares stdout/stderr as List<String>?
      // (Message.kt:237-238). letta-code's LocalMessage part can carry either
      // a scalar string OR an array — wrap scalars into a single-element
      // array so the wire shape always satisfies the Kotlin contract.
      // lcp-2zn closes the previously-flagged mismatch.
      const stdout = toStringArrayOrNull(part.stdout);
      const stderr = toStringArrayOrNull(part.stderr);
      const tr: ToolReturn = {
        tool_call_id: callId,
        status,
        stdout,
        stderr,
        func_response: returnText,
        type: "tool",
      };
      const trMsg: ToolReturnMessage = {
        id: callId ? `toolreturn-${callId}` : `${localMsg.id}:tool:${i}:return`,
        date: withTypeOffset(created, "tool_return_message"),
        name: part.name || null,
        message_type: "tool_return_message",
        otid: localMsg.id,
        sender_id: null,
        step_id: null,
        is_err: part.status === "error" ? true : null,
        seq_id: null,
        run_id: projectedRunId,
        tool_call_id: callId,
        status,
        tool_return: returnText,
        stdout,
        stderr,
        tool_returns: [tr],
      };
      out.push(trMsg);
      continue;
    }
  }
  flushText();
  return out;
}

/** Backwards-compat alias for the old single-message return. Pulls the first
 * projected message; callers should switch to ...Messages. */
export function localMessageToConversationMessage(
  localMsg: LocalMessage,
  scope?: LocalMessageScope,
): LettaMessage | null {
  return localMessageToConversationMessages(localMsg, scope)[0] ?? null;
}

// ──────────────────────────────────────────────────────────────────────
// LocalMessage → legacy hybrid wire record
// ──────────────────────────────────────────────────────────────────────

interface LegacyContentPart {
  type: "text";
  text: string;
  signature: string | null;
}

function partsToContent(parts: unknown): LegacyContentPart[] {
  if (!Array.isArray(parts)) return [{ type: "text", text: "", signature: null }];
  const out: LegacyContentPart[] = [];
  for (const p of parts) {
    if (
      typeof p === "object" &&
      p !== null &&
      (p as { type?: unknown }).type === "text" &&
      typeof (p as { text?: unknown }).text === "string"
    ) {
      out.push({ type: "text", text: (p as { text: string }).text, signature: null });
    }
  }
  return out;
}

/**
 * Hybrid output shape emitted by `localMessageToLettaMessage`.
 *
 * Per Phase 2a audit (bead `lcp-b3j`), this function produces a record that
 * does NOT conform to any single `LettaMessage` variant — it includes
 * `role`, `content` (array), `tool_calls`, plus the approval/approval-array
 * fields all on one object. That bead tracks the legacy shape; behavior
 * must stay identical, so we model it explicitly here rather than try to
 * coerce it into the union.
 *
 * @see lcp-b3j (Phase 2a audit tracking the hybrid shape)
 */
export interface LegacyLocalMessageWire {
  id: string;
  role: LocalMessageRole;
  message_type:
    | "user_message"
    | "assistant_message"
    | "system_message"
    | "tool_call_message"
    | "tool_return_message";
  content: LegacyContentPart[];
  name: string | null;
  sender_id: string | null;
  batch_item_id: string | null;
  model: string | null;
  agent_id: string;
  conversation_id: string;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
  tool_returns: ToolReturn[];
  created_at: string;
  updated_at: string;
  date: string;
  approve: boolean | null;
  approval_request_id: string | null;
  denial_reason: string | null;
  approvals: unknown[];
  otid: string;
  group_id: string | null;
  seq_id: number | null;
  /** lcp-nwd: run that attributed this message; null when unowned. */
  run_id: string | null;
}

export interface LocalMessageToLettaMessageScope {
  agentId: string;
  conversationId: string;
  /** lcp-nwd: messageId -> runId lookup, same shape as
   *  LocalMessageScope.runIdsByMessageId. Built by
   *  runs.buildMessageRunMap(). */
  runIdsByMessageId?: Record<string, string> | null;
}

export function localMessageToLettaMessage(
  localMsg: LocalMessage,
  { agentId, conversationId, runIdsByMessageId }: LocalMessageToLettaMessageScope,
): LegacyLocalMessageWire {
  const created = localMsg.metadata?.created_at ?? new Date().toISOString();
  const role: LocalMessageRole = localMsg.role ?? ("system" as LocalMessageRole);
  const textBody = partsToText(localMsg.parts);

  // Best-effort message_type classification for mobile UI.
  let messageType: LegacyLocalMessageWire["message_type"] = "system_message";
  if (role === "user") messageType = "user_message";
  else if (role === "assistant") {
    messageType = textBody.startsWith("[tool-call]")
      ? "tool_call_message"
      : textBody.startsWith("[tool-result")
        ? "tool_return_message"
        : "assistant_message";
  } else if (role === "system") messageType = "system_message";

  return {
    id: localMsg.id,
    role,
    message_type: messageType,
    content: partsToContent(localMsg.parts),
    name: null,
    sender_id: null,
    batch_item_id: null,
    model: null,
    agent_id: agentId,
    conversation_id: conversationId,
    tool_calls: null,
    tool_call_id: null,
    tool_returns: [],
    created_at: created,
    updated_at: localMsg.metadata?.updated_at ?? created,
    date: created,
    approve: null,
    approval_request_id: null,
    denial_reason: null,
    approvals: [],
    otid: localMsg.id,
    group_id: null,
    seq_id: null,
    run_id: (runIdsByMessageId && localMsg?.id ? (runIdsByMessageId[localMsg.id] ?? null) : null),
  };
}
