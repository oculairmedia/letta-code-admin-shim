/**
 * Translators between letta-code's LocalStore on-disk format and the Letta
 * server REST API shape that letta-mobile expects.
 *
 * Direction we care about right now:
 *   LocalAgentRecord (on disk) → Letta server AgentState (HTTP response)
 *   LocalMessage (UIMessage on disk) → Letta server Message (HTTP response)
 */

function parseModelHandle(handle) {
  if (!handle || typeof handle !== "string") return { provider: "unknown", model: handle ?? "unknown" };
  const idx = handle.indexOf("/");
  if (idx < 0) return { provider: "unknown", model: handle };
  return { provider: handle.slice(0, idx), model: handle.slice(idx + 1) };
}

export function agentToLettaState(record, { messages = [], blocks = [] } = {}) {
  const handle = record.model || "lmstudio/opus-4-7";
  const { provider, model } = parseModelHandle(handle);
  const settings = record.model_settings ?? {};
  const created = record._ctimeMs ? new Date(record._ctimeMs).toISOString() : new Date().toISOString();
  const updated = record._mtimeMs ? new Date(record._mtimeMs).toISOString() : created;

  return {
    id: record.id,
    name: record.name ?? "Untitled",
    description: record.description ?? null,
    system: record.system ?? "",
    agent_type: "memgpt_agent",
    tags: record.tags ?? [],
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
    llm_config: {
      model,
      display_name: model,
      model_endpoint_type: settings.provider_type === "lmstudio" ? "openai" : (settings.provider_type ?? "openai"),
      model_endpoint: process.env.LMSTUDIO_BASE_URL || "https://api.openai.com/v1",
      provider_name: provider,
      provider_category: "base",
      model_wrapper: null,
      context_window: settings.context_window_limit ?? 200000,
      put_inner_thoughts_in_kwargs: false,
      handle,
      temperature: settings.temperature ?? 1.0,
      max_tokens: settings.max_tokens ?? 16384,
      enable_reasoner: false,
      reasoning_effort: null,
    },
    embedding_config: {
      embedding_endpoint_type: "openai",
      embedding_endpoint: process.env.LMSTUDIO_BASE_URL || "https://api.openai.com/v1",
      embedding_model: "text-embedding-3-small",
      embedding_dim: 1536,
      embedding_chunk_size: 300,
      handle: "openai/text-embedding-3-small",
      batch_size: 32,
    },
    model: model,
    embedding: "openai/text-embedding-3-small",
    model_settings: settings,
    compaction_settings: record.compaction_settings ?? null,
    response_format: null,
    memory: {
      agent_type: "memgpt_agent",
      git_enabled: true,
      blocks: blocks,
      file_blocks: [],
      prompt_template: null,
    },
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

function partsToText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p?.type === "text")
    .map((p) => p.text || "")
    .join("");
}

// letta-code prepends one or more `<system-reminder>...</system-reminder>`
// envelopes onto user messages to ship session context to the agent (device
// info, agent identity, permission mode, etc.). These should NEVER reach
// the chat UI — mobile's optimistic user message is just the user's typed
// text, and if the disk-stored version is wrapped, content-equality dedup
// fails and the user sees their prompt rendered twice. Strip them at
// projection time, only for user-role messages.
function stripSystemReminders(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// LocalStore writes the per-agent default thread with id="default", which
// collides across agents. Mobile (and any Letta REST client) expects unique
// conv-* ids. We synthesize one externally so each agent's default thread
// has its own addressable id; the inverse mapping lives in store.mjs.
export function externalConversationId(conv) {
  if (!conv) return null;
  if (conv.id === "default") return `conv-default-${conv.agent_id}`;
  return conv.id;
}

export function conversationToLetta(conv) {
  if (!conv) return null;
  // Match vanilla Letta server's Conversation shape exactly. Do NOT add
  // archived/archived_at — vanilla doesn't expose them on this response.
  return {
    id: externalConversationId(conv),
    agent_id: conv.agent_id,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    last_message_at: conv.last_message_at,
    created_by_id: "user-00000000-0000-4000-8000-000000000000",
    last_updated_by_id: "user-00000000-0000-4000-8000-000000000000",
    summary: conv.summary ?? null,
    in_context_message_ids: conv.in_context_message_ids ?? [],
    isolated_block_ids: [],
    model: null,
    model_settings: null,
  };
}

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
};
function withTypeOffset(createdIso, messageType) {
  const off = TYPE_OFFSET_MS[messageType];
  if (!Number.isFinite(off) || off === 0) return createdIso;
  const t = Date.parse(createdIso);
  if (!Number.isFinite(t)) return createdIso;
  return new Date(t + off).toISOString();
}

export function localMessageToConversationMessages(localMsg, scope = {}) {
  const realTimes = scope.realTimes ?? null;
  const otidMap = scope.otidMap ?? null;
  const sentinel = localMsg.metadata?.created_at;
  const real = realTimes && localMsg?.id ? realTimes[localMsg.id] : null;
  const created = real ?? sentinel ?? new Date().toISOString();
  const role = localMsg.role ?? "system";
  const parts = Array.isArray(localMsg.parts) ? localMsg.parts : [];
  // Mobile's reconcileAfterSend matches `it.otid == sent_otid` on the GET
  // response to swap Local→Confirmed. Default otid is localMsg.id; for any
  // message we've bound to a mobile-supplied otid (via the shim's sidecar)
  // echo back the original optimistic id so the swap fires. Without this
  // the Local user bubble stays alongside the Confirmed disk twin → user
  // sees their prompt twice.
  const mobileOtid = otidMap && localMsg?.id ? otidMap[localMsg.id] : null;
  const projectedOtid = mobileOtid ?? localMsg.id;

  // User / system messages: collapse all text parts into one wire message.
  // Strip system-reminder envelopes from user-role messages so mobile's
  // optimistic-vs-confirmed dedup can collapse against the user's actual
  // typed text.
  if (role === "user" || role === "system") {
    let text = partsToText(parts);
    if (role === "user") text = stripSystemReminders(text);
    if (!text) return [];
    const wireType = role === "user" ? "user_message" : "system_message";
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
        run_id: null,
        content: text,
      },
    ];
  }

  // Assistant / tool: walk parts and emit per-part wire messages, grouping
  // consecutive text parts.
  const out = [];
  let pendingText = "";
  let pendingTextStartIndex = -1;
  const flushText = () => {
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
      run_id: null,
      content: pendingText,
    });
    pendingText = "";
    pendingTextStartIndex = -1;
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part?.type) continue;

    if (part.type === "text" && typeof part.text === "string") {
      if (pendingTextStartIndex === -1) pendingTextStartIndex = i;
      pendingText += part.text;
      continue;
    }

    if (part.type === "reasoning" && typeof part.text === "string") {
      flushText();
      out.push({
        id: `${localMsg.id}:reasoning:${i}`,
        date: withTypeOffset(created, "reasoning_message"),
        name: null,
        message_type: "reasoning_message",
        otid: localMsg.id,
        sender_id: null,
        step_id: null,
        is_err: null,
        seq_id: null,
        run_id: null,
        source: "reasoner_model",
        reasoning: part.text,
        signature: part.providerMetadata?.signature ?? null,
      });
      continue;
    }

    if (part.type === "tool-call") {
      flushText();
      const tc = {
        name: part.name || "tool",
        arguments: typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments ?? {}),
        tool_call_id: part.toolCallId || "",
      };
      out.push({
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
        run_id: null,
        tool_call: tc,
        tool_calls: [tc],
      });
      continue;
    }

    // Native letta-code LocalBackend tool part: `tool-${toolName}` with
    // toolCallId, input, output/errorText, state. Per LocalMessageProjection.
    // Emit BOTH a tool_call_message (the request) AND a tool_return_message
    // (the response) when the tool finished running.
    if (
      typeof part.type === "string" &&
      part.type.startsWith("tool-") &&
      part.type !== "tool-call" &&
      part.type !== "tool-return" &&
      typeof part.toolCallId === "string"
    ) {
      flushText();
      const toolName = part.type.slice("tool-".length);
      const argsStr =
        typeof part.input === "string"
          ? part.input
          : JSON.stringify(part.input ?? {});
      const tc = {
        name: toolName,
        arguments: argsStr,
        tool_call_id: part.toolCallId,
      };
      out.push({
        id: `toolcall-${part.toolCallId}`,
        date: withTypeOffset(created, "tool_call_message"),
        name: toolName,
        message_type: "tool_call_message",
        otid: localMsg.id,
        sender_id: null,
        step_id: null,
        is_err: null,
        seq_id: null,
        run_id: null,
        tool_call: tc,
        tool_calls: [tc],
      });

      const hasOutput =
        part.state === "output-available" ||
        part.state === "output-error" ||
        part.state === "output-denied";
      if (hasOutput) {
        // `output` is typically an array of content parts; flatten to text.
        const flattenOutput = (val) => {
          if (typeof val === "string") return val;
          if (Array.isArray(val)) {
            return val
              .map((p) => {
                if (typeof p === "string") return p;
                if (p?.type === "text" && typeof p.text === "string") return p.text;
                return JSON.stringify(p);
              })
              .join("");
          }
          if (val == null) return "";
          return JSON.stringify(val);
        };
        const isError = part.state !== "output-available";
        const returnText = isError
          ? typeof part.errorText === "string"
            ? part.errorText
            : flattenOutput(part.output)
          : flattenOutput(part.output);
        const status = isError ? "error" : "success";
        out.push({
          id: `toolreturn-${part.toolCallId}`,
          date: withTypeOffset(created, "tool_return_message"),
          name: toolName,
          message_type: "tool_return_message",
          otid: localMsg.id,
          sender_id: null,
          step_id: null,
          is_err: isError ? true : null,
          seq_id: null,
          run_id: null,
          tool_call_id: part.toolCallId,
          status,
          tool_return: returnText,
          stdout: null,
          stderr: null,
          tool_returns: [
            {
              tool_call_id: part.toolCallId,
              status,
              stdout: null,
              stderr: null,
              func_response: returnText,
              type: "tool",
            },
          ],
        });
      }
      continue;
    }

    if (part.type === "tool-return") {
      flushText();
      const callId = part.toolCallId || "";
      out.push({
        id: callId ? `toolreturn-${callId}` : `${localMsg.id}:tool:${i}:return`,
        date: withTypeOffset(created, "tool_return_message"),
        name: part.name || null,
        message_type: "tool_return_message",
        otid: localMsg.id,
        sender_id: null,
        step_id: null,
        is_err: part.status === "error" ? true : null,
        seq_id: null,
        run_id: null,
        tool_call_id: callId,
        status: part.status === "error" ? "error" : "success",
        tool_return: typeof part.tool_return === "string" ? part.tool_return : JSON.stringify(part.tool_return ?? ""),
        stdout: part.stdout ?? null,
        stderr: part.stderr ?? null,
        tool_returns: [
          {
            tool_call_id: callId,
            status: part.status === "error" ? "error" : "success",
            stdout: part.stdout ?? null,
            stderr: part.stderr ?? null,
            func_response:
              typeof part.tool_return === "string" ? part.tool_return : JSON.stringify(part.tool_return ?? ""),
            type: "tool",
          },
        ],
      });
      continue;
    }
  }
  flushText();
  return out;
}

/** Backwards-compat alias for the old single-message return. Pulls the first
 * projected message; callers should switch to ...Messages. */
export function localMessageToConversationMessage(localMsg, scope) {
  return localMessageToConversationMessages(localMsg, scope)[0] ?? null;
}

function partsToContent(parts) {
  if (!Array.isArray(parts)) return [{ type: "text", text: "" }];
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => ({ type: "text", text: p.text, signature: null }));
}

export function localMessageToLettaMessage(localMsg, { agentId, conversationId }) {
  const created = localMsg.metadata?.created_at ?? new Date().toISOString();
  const role = localMsg.role ?? "system";
  const textBody = partsToText(localMsg.parts);

  // Best-effort message_type classification for mobile UI.
  let messageType = "system_message";
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
  };
}
