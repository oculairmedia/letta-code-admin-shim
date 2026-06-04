// Node.js ESM loader hook that applies runtime patches to letta-code's bundled CLI.
// Fixes settle-on-turn agent-id bug, thinking settings schema violations, and model_settings inheritance edge cases.
/**
 * lcp-ith — runtime patch for letta-code's `executeConversationTurn`
 * settle-on-turn bug.
 *
 * Upstream bug (letta-code 0.26.1, letta.js around line 196391):
 *
 *   if (!isApprovalTurn) {
 *     this.store.settleInterruptedToolCalls(conversationId, {
 *       reason: TURN_DID_NOT_COMPLETE
 *     });
 *   }
 *
 * The call omits `agentId`. Inside the store, `toolSettlementTargets`
 * with no agent id calls `findConversation(conversationId)` with no
 * agent id either; that lookup builds the cache key as
 *   "default":"<defaultAgentId>"  i.e.  "default:agent-local-default"
 * and misses for any migrated agent whose id is `agent-<uuid>`. Settle
 * silently returns 0; any orphaned tool_use on disk (worker SIGTERM
 * mid-turn, context-exceeded mid-tool-result, etc.) is never closed
 * out. Every subsequent turn against the affected conversation fails
 * Anthropic validation with
 *   "tool_use ids were found without tool_result blocks immediately
 *    after: toolu_XXX..."
 *
 * The patched call passes `body.agent_id` (the authoritative agent id
 * the SDK puts in the request body — same value `appendTurnInput`
 * derives) with a graceful fallback to the store's
 * `resolveAgentIdForConversation` helper for any older call shape that
 * doesn't carry it. With the right agent id, `toolSettlementTargets`
 * hits the conversation cache, `settleInterruptedToolCallsForConversation`
 * synthesizes an error tool_result for every orphan tool_use, and the
 * next API request goes out with a matched tool_use/tool_result pair.
 *
 * Fail-safe: if a future letta-code release changes the literal source
 * text we're matching, this loader logs a warning and returns the
 * original module unchanged. Better unpatched than refusing to start.
 */
import { fileURLToPath } from "node:url";

const TARGET_PATH = process.env["LETTA_CLI_PATH_REAL"] ?? "";

const SETTLE_BUG_LITERAL =
  `this.store.settleInterruptedToolCalls(conversationId, {\n` +
  `        reason: TURN_DID_NOT_COMPLETE\n` +
  `      });`;

const SETTLE_FIX_LITERAL =
  `this.store.settleInterruptedToolCalls(conversationId, {\n` +
  `        agentId: body?.agent_id ?? this.store?.resolveAgentIdForConversation?.(conversationId),\n` +
  `        reason: TURN_DID_NOT_COMPLETE\n` +
  `      });`;

// lcp-9pn: letta-code 0.26.2 can construct Anthropic/Bedrock thinking
// settings as `{ type: "disabled", budget_tokens: N }` when callers pass both
// `--no-reasoner`/`enable_reasoner=false` and `max_reasoning_tokens`. Anthropic
// rejects that strict schema with:
//   thinking.disabled.budget_tokens: Extra inputs are not permitted
// Only enabled thinking accepts budget_tokens; adaptive/disabled must omit it.
const THINKING_SETTINGS_BUG_LITERAL =
  `thinking = {\n` +
  `        type: updateArgs?.enable_reasoner === false ? "disabled" : "enabled",\n` +
  `        ...typeof updateArgs?.max_reasoning_tokens === "number" && {\n` +
  `          budget_tokens: updateArgs.max_reasoning_tokens\n` +
  `        }\n` +
  `      };`;

const THINKING_SETTINGS_FIX_LITERAL =
  `thinking = {\n` +
  `        type: updateArgs?.enable_reasoner === false ? "disabled" : "enabled",\n` +
  `        ...updateArgs?.enable_reasoner !== false && {\n` +
  `          budget_tokens: typeof updateArgs?.max_reasoning_tokens === "number"\n` +
  `            ? updateArgs.max_reasoning_tokens\n` +
  `            : Math.floor(Number(process.env.LETTA_CODE_THINKING_BUDGET_TOKENS || 10000))\n` +
  `        }\n` +
  `      };`;

const THINKING_HELPERS =
  `globalThis.__lcpFixThinking = globalThis.__lcpFixThinking || ((payload) => {\n` +
  `  if (!payload || typeof payload !== "object" || !payload.thinking || typeof payload.thinking !== "object") return payload;\n` +
  `  const next = { ...payload, thinking: { ...payload.thinking } };\n` +
  `  if (next.thinking.type === "enabled" && typeof next.thinking.budget_tokens !== "number") {\n` +
  `    next.thinking.budget_tokens = Number(process.env.LETTA_CODE_THINKING_BUDGET_TOKENS || 10000);\n` +
  `  }\n` +
  `  if (next.thinking.type !== "enabled" && "budget_tokens" in next.thinking) {\n` +
  `    delete next.thinking.budget_tokens;\n` +
  `  }\n` +
  `  return next;\n` +
  `});\n` +
  `globalThis.__lcpFixModelSettings = globalThis.__lcpFixModelSettings || ((payload) => {\n` +
  `  if (!payload || typeof payload !== "object" || !payload.thinking || typeof payload.thinking !== "object") return payload;\n` +
  `  const next = { ...payload, thinking: { ...payload.thinking } };\n` +
  `  if (next.thinking.type === "enabled" && typeof next.thinking.budget_tokens !== "number") {\n` +
  `    next.thinking.budget_tokens = Number(process.env.LETTA_CODE_THINKING_BUDGET_TOKENS || 10000);\n` +
  `  }\n` +
  `  if (next.thinking.type !== "enabled" && "budget_tokens" in next.thinking) {\n` +
  `    delete next.thinking.budget_tokens;\n` +
  `  }\n` +
  `  return next;\n` +
  `});\n`;

const ANTHROPIC_CREATE_LITERAL =
  `client.messages.create({ ...params, stream: true }, requestOptions)`;

const ANTHROPIC_CREATE_FIX_LITERAL =
  `client.messages.create({ ...globalThis.__lcpFixThinking(params), stream: true }, requestOptions)`;

const ANTHROPIC_STREAM_LITERAL =
  `this.client.beta.messages.stream({ ...params }, options)`;

const ANTHROPIC_STREAM_FIX_LITERAL =
  `this.client.beta.messages.stream({ ...globalThis.__lcpFixThinking(params) }, options)`;

const MODEL_SETTINGS_RETURN_LITERAL = `return modelSettings;`;
const MODEL_SETTINGS_RETURN_FIX_LITERAL = `return globalThis.__lcpFixModelSettings(modelSettings);`;

const EFFECTIVE_AGENT_MODEL_SETTINGS_LITERAL =
  `model_settings: {\n` +
  `      ...agent2.model_settings,\n` +
  `      ...conversationModelSettings2 ?? {},\n` +
  `      ...typeof conversationRecord.context_window_limit === "number" ? { context_window_limit: conversationRecord.context_window_limit } : {}\n` +
  `    }`;

const EFFECTIVE_AGENT_MODEL_SETTINGS_FIX_LITERAL =
  `model_settings: globalThis.__lcpFixModelSettings({\n` +
  `      ...agent2.model_settings,\n` +
  `      ...conversationModelSettings2 ?? {},\n` +
  `      ...typeof conversationRecord.context_window_limit === "number" ? { context_window_limit: conversationRecord.context_window_limit } : {}\n` +
  `    })`;

const THINKING_REQUEST_GUARD_ANCHOR =
  `  if (options3?.metadata) {\n` +
  `    const userId = options3.metadata.user_id;`;

const THINKING_REQUEST_GUARD_INSERT =
  `  if (params.thinking && params.thinking.type !== "enabled" && "budget_tokens" in params.thinking) {\n` +
  `    delete params.thinking.budget_tokens;\n` +
  `  }\n` +
  `  if (options3?.metadata) {\n` +
  `    const userId = options3.metadata.user_id;`;

// lcp-7kk: universal chokepoint guard.
//
// The per-builder guard above (lcp-9pn) only covers ONE of the several bundled
// `buildAnthropicParams` copies — the anchor it keys on (`const userId =
// options3.metadata.user_id` at a specific indent) matches a single copy. The
// live `local_backend_error` turns send `thinking: { type:"disabled",
// budget_tokens: N }` from a path that copy never sees, so Anthropic rejects
// every continuation with:
//   thinking.disabled.budget_tokens: Extra inputs are not permitted
//
// Rather than chase which of N minified builder copies produced the param, we
// normalize at the real Anthropic send chokepoints: request paths use
// `(client.)(beta.)messages.create({ ...params, ... }, ...)`, while tool-runner
// streaming paths use `(client.)beta.messages.stream({ ...params }, ...)`. The
// bundle's send-path variable is `params` (not `requestParams`). We route
// `params` through a normalizer that strips every non-`type` key from a
// non-enabled `thinking` block and adds a conservative budget to enabled
// thinking when upstream forgot one. The `messages.create/stream({ ` prefixes
// scope the rewrite to Anthropic SDK sends only — the positional
// `conversations.messages.create(id, body, ...)` Letta calls don't match.
const THINKING_CHOKEPOINT_TOKEN = `messages.create({ ...params,`;
const THINKING_CHOKEPOINT_REPLACEMENT = `messages.create({ ...globalThis.__lcpFixThinking(params),`;
const THINKING_STREAM_CHOKEPOINT_TOKEN = `messages.stream({ ...params`;
const THINKING_STREAM_CHOKEPOINT_REPLACEMENT = `messages.stream({ ...globalThis.__lcpFixThinking(params)`;

// Injected once at the top of letta.js. Idempotent and surgical, matching
// Anthropic's strict thinking schema:
//   - "disabled" permits ZERO sibling keys → reduce to { type:"disabled" }.
//     (This is the exact shape that triggers the live error:
//      thinking.disabled.budget_tokens: Extra inputs are not permitted)
//   - "adaptive" permits `display` but NOT `budget_tokens` → drop only
//     budget_tokens, keep display.
//   - "enabled" requires budget_tokens. Some subagent-spawn paths construct
//     `{ type:"enabled" }` with no budget, which Anthropic rejects with
//     `thinking.enabled.budget_tokens: Field required`; add a conservative
//     default at the same chokepoint.
// Returns the original object when nothing needs changing (no allocation, no
// behavior change for healthy requests).
const THINKING_HELPER_DEFINITION =
  `globalThis.__lcpFixThinking = globalThis.__lcpFixThinking || function (p) {\n` +
  `  try {\n` +
  `    const t = p && p.thinking;\n` +
  `    if (t && typeof t === "object" && typeof t.type === "string") {\n` +
  `      if (t.type === "enabled" && typeof t.budget_tokens !== "number") {\n` +
  `        const configured = Number(process.env.LETTA_CODE_THINKING_BUDGET_TOKENS || 10000);\n` +
  `        const budget = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 10000;\n` +
  `        return { ...p, thinking: { ...t, budget_tokens: budget } };\n` +
  `      }\n` +
  `      if (t.type === "disabled" && Object.keys(t).length > 1) {\n` +
  `        return { ...p, thinking: { type: "disabled" } };\n` +
  `      }\n` +
  `      if (t.type !== "enabled" && "budget_tokens" in t) {\n` +
  `        const { budget_tokens, ...rest } = t;\n` +
  `        return { ...p, thinking: rest };\n` +
  `      }\n` +
  `    }\n` +
  `  } catch {}\n` +
  `  return p;\n` +
  `};\n`;

// lcp-0u15: local backend can persist `agent.model_settings.thinking` before
// the request reaches the Anthropic SDK chokepoint. Subagents inherit those
// settings through LocalStore/effectiveAgentForConversation; if a model preset
// contributed only `{ type: "enabled" }`, the later provider turn fails with
// `thinking.enabled.budget_tokens: Field required`. Normalize model_settings at
// storage and merge boundaries as the same schema-safe fallback used for SDK
// requests.
const MODEL_SETTINGS_HELPER_DEFINITION =
  `globalThis.__lcpFixModelSettings = globalThis.__lcpFixModelSettings || function (m) {\n` +
  `  try {\n` +
  `    const t = m && m.thinking;\n` +
  `    if (t && typeof t === "object" && typeof t.type === "string") {\n` +
  `      if (t.type === "enabled" && typeof t.budget_tokens !== "number") {\n` +
  `        const configured = Number(process.env.LETTA_CODE_THINKING_BUDGET_TOKENS || 10000);\n` +
  `        const budget = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 10000;\n` +
  `        return { ...m, thinking: { ...t, budget_tokens: budget } };\n` +
  `      }\n` +
  `      if (t.type === "disabled" && Object.keys(t).length > 1) {\n` +
  `        return { ...m, thinking: { type: "disabled" } };\n` +
  `      }\n` +
  `      if (t.type !== "enabled" && "budget_tokens" in t) {\n` +
  `        const { budget_tokens, ...rest } = t;\n` +
  `        return { ...m, thinking: rest };\n` +
  `      }\n` +
  `    }\n` +
  `  } catch {}\n` +
  `  return m;\n` +
  `};\n`;

const MODEL_SETTINGS_RETURN_TOKEN = `  return modelSettings;\n}`;
const MODEL_SETTINGS_RETURN_REPLACEMENT = `  return globalThis.__lcpFixModelSettings(modelSettings);\n}`;

const EFFECTIVE_AGENT_SETTINGS_TOKEN =
  `    model_settings: {\n` +
  `      ...agent2.model_settings,\n` +
  `      ...conversationModelSettings2 ?? {},\n` +
  `      ...typeof conversationRecord.context_window_limit === "number" ? { context_window_limit: conversationRecord.context_window_limit } : {}\n` +
  `    }`;

const EFFECTIVE_AGENT_SETTINGS_REPLACEMENT =
  `    model_settings: globalThis.__lcpFixModelSettings({\n` +
  `      ...agent2.model_settings,\n` +
  `      ...conversationModelSettings2 ?? {},\n` +
  `      ...typeof conversationRecord.context_window_limit === "number" ? { context_window_limit: conversationRecord.context_window_limit } : {}\n` +
  `    })`;

// lcp-taqw: local model discovery can register vision-capable OpenAI-compatible
// models with input:["text"] even when the model id clearly maps to a vision
// family (Claude, Gemini, GPT, LLaVA, etc.). Later tool-result converters gate
// Read(image) pixels behind `model.input.includes("image")`; when discovery
// under-reports the capability, the converter emits only `(see attached image)`.
// Patch the single registeredModelToPiModel() seam so every downstream provider
// converter sees the same corrected input capabilities. Limit this to local
// backend mode so remote/Constellation model declarations remain authoritative.
const LOCAL_VISION_INPUT_HELPER_DEFINITION =
  `globalThis.__lcpFixLocalVisionInput = globalThis.__lcpFixLocalVisionInput || function (providerName, modelId, input) {\n` +
  `  try {\n` +
  `    const current = Array.isArray(input) ? input : ["text"];\n` +
  `    if (current.includes("image")) return current;\n` +
  `    if (process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL !== "1" && !process.env.LETTA_LOCAL_BACKEND_DIR) return current;\n` +
  `    const haystack = String(providerName || "") + "/" + String(modelId || "");\n` +
  `    if (/llava|vision|\bvl\b|opus|sonnet|haiku|claude|gpt-|gpt5|gemini|grok/i.test(haystack)) {\n` +
  `      return [...current, "image"];\n` +
  `    }\n` +
  `  } catch {}\n` +
  `  return Array.isArray(input) ? input : ["text"];\n` +
  `};\n`;

const LOCAL_VISION_INPUT_TOKEN = `input: input.model.input,`;
const LOCAL_VISION_INPUT_REPLACEMENT =
  `input: globalThis.__lcpFixLocalVisionInput(input.providerName, input.model.id, input.model.input),`;

// lcp-qi2f: the INBOUND user-image gate. toChatMessages(messages, supportsImages)
// computes supportsImages = `model.input.includes("image")` at the request-build
// site. For custom/discovered lmstudio handles (e.g. lmstudio/opus-4-8) the
// resolved model.input may NOT include "image" even though the model is
// vision-capable — so user-attached images are replaced with
// "(image omitted: model does not support images)" before reaching the model.
// The LOCAL_VISION_INPUT patch above fixes model.input at the construction
// site, but this request-build site can read a model object that bypassed it.
// Patch the gate directly to also honor the vision-model id check, reusing the
// same helper (it accepts an input array and returns one including "image").
const VISION_GATE_TOKEN = `toChatMessages(messages, model.input.includes("image"))`;
const VISION_GATE_REPLACEMENT =
  `toChatMessages(messages, globalThis.__lcpFixLocalVisionInput(undefined, model.id, model.input).includes("image"))`;

// lcp-qi2f: the ACTUAL inbound-user-image gate. downgradeUnsupportedImages(
// messages, model) replaces user image blocks with NON_VISION_USER_IMAGE_
// PLACEHOLDER ("(image omitted: model does not support images)") whenever
// `model.input.includes("image")` is false — a SEPARATE path from the
// toChatMessages gate above, and the one that strips images Emmanuel attaches.
// Rewrite its early-return guard to honor the vision-model id check via the
// same helper. Anchored on the unique function signature so we only touch
// this site.
const DOWNGRADE_IMAGES_TOKEN =
  `function downgradeUnsupportedImages(messages, model) {\n  if (model.input.includes("image")) {`;
const DOWNGRADE_IMAGES_REPLACEMENT =
  `function downgradeUnsupportedImages(messages, model) {\n  if (globalThis.__lcpFixLocalVisionInput(undefined, model.id, model.input).includes("image")) {`;

// lcp-taqw: executeSingleDecision() emitted `tool_return_message` stream
// chunks with getDisplayableToolReturn(toolResult.toolReturn). That helper is
// intentionally text-only for UI display, so the local store appended a
// toolResult containing just `[Image: file.png]` and then ignored the later raw
// batch result as a duplicate. Preserve the raw multimodal tool return on the
// stream chunk; projection layers can still stringify it for UI, while the next
// model turn keeps the image block.
const MULTIMODAL_TOOL_RETURN_TOKEN =
  `tool_return: getDisplayableToolReturn(toolResult.toolReturn),`;
const MULTIMODAL_TOOL_RETURN_REPLACEMENT = `tool_return: toolResult.toolReturn,`;

// lcp-taqw: normalizeOutgoingApprovalMessages() validates tool returns before
// sending approval turns back into the local backend. Its built-in
// isToolReturnContent() only accepts local stored image blocks shaped
// `{type:"image", mimeType, data}`, while Read(image) returns Anthropic-style
// legacy blocks shaped `{type:"image", source:{type:"base64", media_type,
// data}}`. Without preserving that legacy shape, coerceToolReturnContent()
// falls back to normalizeToolReturnText(), which keeps only `[Image: file.png]`
// and drops the pixels before applyApprovalResults() can persist them. Keep the
// legacy shape here because applyApprovalResults()->toolResultContentFromUnknown
// is the seam that converts legacy `source` blocks into local `mimeType/data`.
const TOOL_RETURN_CONTENT_HELPER_DEFINITION =
  `globalThis.__lcpCoerceToolReturnContent = globalThis.__lcpCoerceToolReturnContent || function (value) {\n` +
  `  try {\n` +
  `    if (typeof value === "string") return value;\n` +
  `    if (Array.isArray(value)) {\n` +
  `      const out = [];\n` +
  `      for (const part of value) {\n` +
  `        if (!part || typeof part !== "object") return normalizeToolReturnText(value);\n` +
  `        if (part.type === "text" && typeof part.text === "string") {\n` +
  `          out.push({ type: "text", text: part.text });\n` +
  `          continue;\n` +
  `        }\n` +
  `        if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {\n` +
  `          out.push({ type: "image", mimeType: part.mimeType, data: part.data });\n` +
  `          continue;\n` +
  `        }\n` +
  `        const source = part.type === "image" && part.source && typeof part.source === "object" ? part.source : null;\n` +
  `        if (source && source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {\n` +
  `          out.push({ type: "image", source: { type: "base64", media_type: source.media_type, data: source.data } });\n` +
  `          continue;\n` +
  `        }\n` +
  `        return normalizeToolReturnText(value);\n` +
  `      }\n` +
  `      return out;\n` +
  `    }\n` +
  `  } catch {}\n` +
  `  return isToolReturnContent(value) ? value : normalizeToolReturnText(value);\n` +
  `};\n`;

const TOOL_RETURN_CONTENT_TOKEN =
  `function coerceToolReturnContent(value) {\n` +
  `  if (isToolReturnContent(value))\n` +
  `    return value;\n` +
  `  return normalizeToolReturnText(value);\n` +
  `}`;

const TOOL_RETURN_CONTENT_REPLACEMENT =
  `function coerceToolReturnContent(value) {\n` +
  `  return globalThis.__lcpCoerceToolReturnContent(value);\n` +
  `}`;

// lcp-gukg: OpenCode-style recurring completion reminder for background tasks.
//
// Background subagent completion is delivered to the PARENT conversation as a
// SINGLE injected <task-notification> (spawnBackgroundSubagentTask ->
// addToMessageQueue({ kind:"task_notification", ... })). If that one push is
// lost — the documented task_N id/log-path collision across reconnects, a
// dropped queue pump, or a runtime swap between dispatch and completion — the
// parent never learns the task ended and its turn hangs "thinking" forever.
//
// We install a recurring timer (default 20s, env LCP_TASK_REMINDER_INTERVAL_MS)
// that, WHILE there are active silent background subagents, re-reads each task's
// /tmp/letta-background/task_N.log for the authoritative [Task completed] /
// [Task failed] footer (written BEFORE the notification is enqueued) and, for
// any task that is actually terminal but still shows active in the parent's
// view, (re-)delivers a synthesized <task-notification> and clears it. The
// timer is idempotent (delivered task ids are tracked), self-arming/-disarming
// (it stops when there is nothing active, so there is zero overhead in the
// common case), and unref'd so it never holds the process open.
//
// Hook: we wrap the bundle's setMessageQueueAdder so that whenever the runtime
// installs a real queue adder (the same seam the notification path delivers
// through), the reminder loop is (idempotently) armed with live references to
// the bundle's own getActiveBackgroundAgents / backgroundTasks /
// addToMessageQueue / formatTaskNotification / completeSubagent functions.
//
// The pure decision core mirrors admin-shim/lib/task-reminder.ts line-for-line
// (scanForTerminalTasks); that TS copy is what the unit tests exercise.
const TASK_REMINDER_HELPER_DEFINITION =
  `globalThis.__lcpTaskReminder = globalThis.__lcpTaskReminder || (function () {\n` +
  `  const TASK_COMPLETED_MARKER = "[Task completed]";\n` +
  `  const TASK_FAILED_MARKER = "[Task failed]";\n` +
  `  const delivered = new Set();\n` +
  `  let timer = null;\n` +
  `  let deps = null;\n` +
  `  function classifyTaskLog(logText) {\n` +
  `    if (typeof logText !== "string") return null;\n` +
  `    if (logText.includes(TASK_FAILED_MARKER)) return "failed";\n` +
  `    if (logText.includes(TASK_COMPLETED_MARKER)) return "completed";\n` +
  `    return null;\n` +
  `  }\n` +
  `  function scanForTerminalTasks(activeAgents, backgroundTasks, readLog) {\n` +
  `    if (!activeAgents || activeAgents.length === 0) return [];\n` +
  `    const bySubagent = new Map();\n` +
  `    for (const [taskId, entry] of backgroundTasks) {\n` +
  `      if (entry && typeof entry.subagentId === "string") {\n` +
  `        bySubagent.set(entry.subagentId, { taskId, entry });\n` +
  `      }\n` +
  `    }\n` +
  `    const pending = [];\n` +
  `    const seenTaskIds = new Set();\n` +
  `    for (const agent of activeAgents) {\n` +
  `      const match = bySubagent.get(agent.id);\n` +
  `      if (!match) continue;\n` +
  `      const { taskId, entry } = match;\n` +
  `      if (delivered.has(taskId) || seenTaskIds.has(taskId)) continue;\n` +
  `      if (!entry.outputFile) continue;\n` +
  `      const logText = readLog(entry.outputFile);\n` +
  `      if (logText == null) continue;\n` +
  `      const status = classifyTaskLog(logText);\n` +
  `      if (status == null) continue;\n` +
  `      seenTaskIds.add(taskId);\n` +
  `      pending.push({\n` +
  `        taskId,\n` +
  `        subagentId: agent.id,\n` +
  `        status,\n` +
  `        description: entry.description || agent.description || "background task",\n` +
  `        subagentType: entry.subagentType || "general-purpose",\n` +
  `        outputFile: entry.outputFile,\n` +
  `      });\n` +
  `    }\n` +
  `    return pending;\n` +
  `  }\n` +
  `  function intervalMs() {\n` +
  `    const n = Number(process.env.LCP_TASK_REMINDER_INTERVAL_MS || 20000);\n` +
  `    return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 20000;\n` +
  `  }\n` +
  `  function readLogFile(outputFile) {\n` +
  `    try {\n` +
  `      const req = typeof __require === "function" ? __require : (typeof require === "function" ? require : null);\n` +
  `      if (!req) return null;\n` +
  `      const fs4 = req("node:fs");\n` +
  `      if (!fs4.existsSync(outputFile)) return null;\n` +
  `      return fs4.readFileSync(outputFile, "utf8");\n` +
  `    } catch { return null; }\n` +
  `  }\n` +
  `  function tick() {\n` +
  `    try {\n` +
  `      if (!deps) return;\n` +
  `      const activeAgents = deps.getActiveBackgroundAgents() || [];\n` +
  `      if (activeAgents.length === 0) { stop(); return; }\n` +
  `      const pending = scanForTerminalTasks(activeAgents, deps.backgroundTasks, deps.readLog || readLogFile);\n` +
  `      for (const task of pending) {\n` +
  `        const summary = 'Agent "' + task.description + '" ' + (task.status === "completed" ? "completed" : "failed") + " (recovered)";\n` +
  `        let text;\n` +
  `        try {\n` +
  `          text = deps.formatTaskNotification({\n` +
  `            taskId: task.taskId,\n` +
  `            status: task.status,\n` +
  `            summary,\n` +
  `            result: summary,\n` +
  `            outputFile: task.outputFile,\n` +
  `            usage: {},\n` +
  `          });\n` +
  `        } catch {\n` +
  `          text = "<task-notification>\\n<task-id>" + task.taskId + "</task-id>\\n<status>" + task.status + "</status>\\n<summary>" + summary + "</summary>\\n<result>" + summary + "</result>\\n</task-notification>\\nFull transcript available at: " + task.outputFile;\n` +
  `        }\n` +
  `        try {\n` +
  `          deps.addToMessageQueue({\n` +
  `            kind: "task_notification",\n` +
  `            text,\n` +
  `            agentId: task.parentAgentId,\n` +
  `            conversationId: task.parentConversationId,\n` +
  `          });\n` +
  `        } catch {}\n` +
  `        delivered.add(task.taskId);\n` +
  `        try { deps.completeSubagent(task.subagentId, { success: task.status === "completed" }); } catch {}\n` +
  `        try { process.stderr.write("[letta-code-patch] lcp-gukg recovered terminal " + task.status + " for " + task.taskId + " (re-delivered task-notification)\\n"); } catch {}\n` +
  `      }\n` +
  `    } catch {}\n` +
  `  }\n` +
  `  function stop() {\n` +
  `    if (timer) { try { clearInterval(timer); } catch {} timer = null; }\n` +
  `  }\n` +
  `  function ensureRunning(liveDeps) {\n` +
  `    deps = liveDeps;\n` +
  `    if (timer) return;\n` +
  `    try {\n` +
  `      const active = deps.getActiveBackgroundAgents() || [];\n` +
  `      if (active.length === 0) return;\n` +
  `    } catch { return; }\n` +
  `    timer = setInterval(tick, intervalMs());\n` +
  `    if (timer && typeof timer.unref === "function") timer.unref();\n` +
  `  }\n` +
  `  return {\n` +
  `    ensureRunning,\n` +
  `    tick,\n` +
  `    stop,\n` +
  `    _scanForTest: scanForTerminalTasks,\n` +
  `    _classifyForTest: classifyTaskLog,\n` +
  `    _delivered: delivered,\n` +
  `  };\n` +
  `})();\n`;

// Wrap setMessageQueueAdder: whenever a real (non-null) adder is installed, arm
// the reminder loop with live bundle refs. When the adder is cleared (null), we
// leave the unref'd timer alone — it self-stops on the next tick that sees no
// active background subagents.
const TASK_REMINDER_HOOK_TOKEN =
  `function setMessageQueueAdder(fn) {\n` +
  `  queueAdder = fn;\n`;

const TASK_REMINDER_HOOK_REPLACEMENT =
  `function setMessageQueueAdder(fn) {\n` +
  `  queueAdder = fn;\n` +
  `  try {\n` +
  `    if (fn && globalThis.__lcpTaskReminder) {\n` +
  `      globalThis.__lcpTaskReminder.ensureRunning({\n` +
  `        getActiveBackgroundAgents,\n` +
  `        backgroundTasks,\n` +
  `        addToMessageQueue,\n` +
  `        formatTaskNotification,\n` +
  `        completeSubagent,\n` +
  `      });\n` +
  `    }\n` +
  `  } catch {}\n`;

let appliedOnce = false;

/**
 * @param {string} raw
 * @param {string} path
 * @param {boolean} warn
 * @returns {{ source: string; appliedPatches: number }}
 */
function patchLettaCodeSource(raw, path, warn) {
  let patched = raw;
  let appliedPatches = 0;

  if (patched.includes(SETTLE_BUG_LITERAL)) {
    patched = patched.replace(SETTLE_BUG_LITERAL, SETTLE_FIX_LITERAL);
    appliedPatches += 1;
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: settle-bug literal not found in ${path} — ` +
      `running unpatched (letta-code likely upgraded past 0.26.1)\n`,
    );
  }

  if (patched.includes(THINKING_SETTINGS_BUG_LITERAL)) {
    patched = patched.replaceAll(THINKING_SETTINGS_BUG_LITERAL, THINKING_SETTINGS_FIX_LITERAL);
    appliedPatches += 1;
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: thinking-settings literal not found in ${path} — ` +
      `running without lcp-9pn settings guard\n`,
    );
  }

  if (patched.includes(THINKING_REQUEST_GUARD_ANCHOR)) {
    patched = patched.replace(THINKING_REQUEST_GUARD_ANCHOR, THINKING_REQUEST_GUARD_INSERT);
    appliedPatches += 1;
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: thinking-request guard anchor not found in ${path} — ` +
      `running without lcp-9pn request guard\n`,
    );
  }

  // lcp-7kk: universal chokepoint normalizer for every Anthropic request.
  let appliedThinkingChokepoint = false;
  if (patched.includes(THINKING_CHOKEPOINT_TOKEN)) {
    patched = patched.replaceAll(THINKING_CHOKEPOINT_TOKEN, THINKING_CHOKEPOINT_REPLACEMENT);
    appliedPatches += 1;
    appliedThinkingChokepoint = true;
  }
  if (patched.includes(THINKING_STREAM_CHOKEPOINT_TOKEN)) {
    patched = patched.replaceAll(THINKING_STREAM_CHOKEPOINT_TOKEN, THINKING_STREAM_CHOKEPOINT_REPLACEMENT);
    appliedPatches += 1;
    appliedThinkingChokepoint = true;
  }
  if (appliedThinkingChokepoint) {
    patched = injectHelperAfterShebang(patched, THINKING_HELPER_DEFINITION);
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: thinking chokepoint token not found in ${path} — ` +
      `running without lcp-7kk request normalizer\n`,
    );
  }

  let appliedModelSettingsGuard = false;
  if (patched.includes(MODEL_SETTINGS_RETURN_TOKEN)) {
    patched = patched.replaceAll(MODEL_SETTINGS_RETURN_TOKEN, MODEL_SETTINGS_RETURN_REPLACEMENT);
    appliedPatches += 1;
    appliedModelSettingsGuard = true;
  }
  if (patched.includes(EFFECTIVE_AGENT_SETTINGS_TOKEN)) {
    patched = patched.replaceAll(EFFECTIVE_AGENT_SETTINGS_TOKEN, EFFECTIVE_AGENT_SETTINGS_REPLACEMENT);
    appliedPatches += 1;
    appliedModelSettingsGuard = true;
  }
  if (appliedModelSettingsGuard) {
    patched = injectHelperAfterShebang(patched, MODEL_SETTINGS_HELPER_DEFINITION);
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: model_settings thinking guard token not found in ${path} — ` +
      `running without lcp-0u15 settings normalizer\n`,
    );
  }

  if (patched.includes(LOCAL_VISION_INPUT_TOKEN)) {
    patched = patched.replace(LOCAL_VISION_INPUT_TOKEN, LOCAL_VISION_INPUT_REPLACEMENT);
    appliedPatches += 1;
    patched = injectHelperAfterShebang(patched, LOCAL_VISION_INPUT_HELPER_DEFINITION);
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: local vision input token not found in ${path} — ` +
      `Read(image) may still be placeholdered by model.input gates\n`,
    );
  }

  // lcp-qi2f: inbound user-image gate at the request-build site.
  if (patched.includes(VISION_GATE_TOKEN)) {
    patched = patched.replace(VISION_GATE_TOKEN, VISION_GATE_REPLACEMENT);
    appliedPatches += 1;
    // Ensure the helper is present even if the input-construction token above
    // was absent (idempotent: the helper uses `|| function` guard).
    patched = injectHelperAfterShebang(patched, LOCAL_VISION_INPUT_HELPER_DEFINITION);
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: vision gate token (toChatMessages supportsImages) not found in ${path} — ` +
      `inbound user images may still be omitted\n`,
    );
  }

  // lcp-qi2f: downgradeUnsupportedImages — the real inbound user-image strip.
  if (patched.includes(DOWNGRADE_IMAGES_TOKEN)) {
    patched = patched.replace(DOWNGRADE_IMAGES_TOKEN, DOWNGRADE_IMAGES_REPLACEMENT);
    appliedPatches += 1;
    patched = injectHelperAfterShebang(patched, LOCAL_VISION_INPUT_HELPER_DEFINITION);
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: downgradeUnsupportedImages token not found in ${path} — ` +
      `inbound user images may still be omitted\n`,
    );
  }

  if (patched.includes(MULTIMODAL_TOOL_RETURN_TOKEN)) {
    patched = patched.replace(MULTIMODAL_TOOL_RETURN_TOKEN, MULTIMODAL_TOOL_RETURN_REPLACEMENT);
    appliedPatches += 1;
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: multimodal tool-return token not found in ${path} — ` +
      `Read(image) may still be reduced to display text before storage\n`,
    );
  }

  if (patched.includes(TOOL_RETURN_CONTENT_TOKEN)) {
    patched = patched.replace(TOOL_RETURN_CONTENT_TOKEN, TOOL_RETURN_CONTENT_REPLACEMENT);
    appliedPatches += 1;
    patched = injectHelperAfterShebang(patched, TOOL_RETURN_CONTENT_HELPER_DEFINITION);
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: tool-return content coercion token not found in ${path} — ` +
      `Read(image) approval turns may still be normalized to text only\n`,
    );
  }

  // lcp-gukg: recurring background-task completion reminder. Hooks the
  // setMessageQueueAdder seam to arm a self-disarming poll that re-derives
  // terminal status from the authoritative task_N.log footer and re-delivers a
  // lost <task-notification>, so a missed completion push never leaves the
  // parent turn hanging. Only installs if the hook token matches.
  if (patched.includes(TASK_REMINDER_HOOK_TOKEN)) {
    patched = patched.replace(TASK_REMINDER_HOOK_TOKEN, TASK_REMINDER_HOOK_REPLACEMENT);
    appliedPatches += 1;
    patched = injectHelperAfterShebang(patched, TASK_REMINDER_HELPER_DEFINITION);
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: setMessageQueueAdder hook token not found in ${path} — ` +
      `running without lcp-gukg background-task completion reminder\n`,
    );
  }

  return { source: patched, appliedPatches };
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function patchLettaCodeSourceForTest(raw) {
  return patchLettaCodeSource(raw, "<test>", false).source;
}

// Insert injected source after a leading `#!` shebang (which must remain line 1
// for Node to strip it). ESM hoists `import` declarations, so a statement placed
// before them is legal — the only hard constraint is the shebang position.
/**
 * @param {string} source
 * @param {string} helper
 * @returns {string}
 */
function injectHelperAfterShebang(source, helper) {
  if (source.startsWith("#!")) {
    const nl = source.indexOf("\n");
    if (nl >= 0) {
      return source.slice(0, nl + 1) + helper + source.slice(nl + 1);
    }
  }
  return helper + source;
}

/** @type {import("node:module").LoadHook} */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!TARGET_PATH || !url.startsWith("file://")) return result;

  let path;
  try { path = fileURLToPath(url); } catch { return result; }
  if (path !== TARGET_PATH) return result;

  const raw =
    typeof result.source === "string"
      ? result.source
      : result.source instanceof Uint8Array
        ? Buffer.from(result.source).toString("utf8")
        : null;
  if (raw === null) return result;

  const { source: patched, appliedPatches } = patchLettaCodeSource(raw, path, !appliedOnce);

  if (appliedPatches === 0) return result;

  if (!appliedOnce) {
    process.stderr.write(
      `[letta-code-patch] applied ${appliedPatches} runtime patch(es) to ${path}\n`,
    );
    appliedOnce = true;
  }
  return { ...result, source: patched, shortCircuit: true };
}
