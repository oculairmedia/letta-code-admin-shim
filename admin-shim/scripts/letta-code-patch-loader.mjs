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
// Vision model identification is DATA, not code: the shim owns the pattern
// list in lib/model-catalog.ts (VISION_MODEL_PATTERNS) and exports it into
// LETTA_VISION_MODELS (comma-separated, case-insensitive substrings) at
// startup, which this spawned CLI process inherits. The regex below is only
// a fallback for processes launched outside the shim (manual CLI runs).
// To add a vision model: edit VISION_MODEL_PATTERNS once, or set
// SHIM_VISION_MODELS_EXTRA on the service unit — no edit here needed.
const LOCAL_VISION_INPUT_HELPER_DEFINITION =
  `globalThis.__lcpFixLocalVisionInput = globalThis.__lcpFixLocalVisionInput || function (providerName, modelId, input) {\n` +
  `  try {\n` +
  `    const current = Array.isArray(input) ? input : ["text"];\n` +
  `    if (current.includes("image")) return current;\n` +
  `    if (process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL !== "1" && !process.env.LETTA_LOCAL_BACKEND_DIR) return current;\n` +
  `    const haystack = (String(providerName || "") + "/" + String(modelId || "")).toLowerCase();\n` +
  `    const envList = String(process.env.LETTA_VISION_MODELS || "")\n` +
  `      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);\n` +
  `    if (envList.length > 0) {\n` +
  `      if (envList.some((p) => haystack.includes(p)) || /\\bvl\\b/.test(haystack)) {\n` +
  `        return [...current, "image"];\n` +
  `      }\n` +
  `    } else if (/llava|vision|\\bvl\\b|opus|sonnet|haiku|claude|fable|gpt-|gpt5|gemini|grok|minimax/i.test(haystack)) {\n` +
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

// lcp-8e41: restore the native image generation tool clobbered by divergent
// patch-loader history. Patch the bundled local tool registry and model default
// allowlists so agents can call image generation through the normal tool
// pipeline without spending quota in startup/tests.
const GENERATE_IMAGE_TOOL_HELPER_DEFINITION =
  `globalThis.__lcpAddGenerateImageTool = globalThis.__lcpAddGenerateImageTool || function (toolDefinitions, defineToolFn) {\n` +
  `  if (!toolDefinitions || typeof toolDefinitions !== "object" || toolDefinitions.generate_image) return toolDefinitions;\n` +
  `  const schema = {\n` +
  `    type: "object",\n` +
  `    additionalProperties: false,\n` +
  `    properties: {\n` +
  `      prompt: { type: "string", description: "Detailed description of the image to generate." },\n` +
  `      size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024"], description: "Output dimensions. Defaults to 1024x1024." },\n` +
  `      quality: { type: "string", enum: ["low", "medium", "high"], description: "Generation quality. Defaults to medium." },\n` +
  `      model: { type: "string", description: "Image model handle. Defaults to gpt-image-2." },\n` +
  `      output_dir: { type: "string", description: "Directory where the generated image should be saved. Defaults to .letta/generated-images under the current working directory." }\n` +
  `    },\n` +
  `    required: ["prompt"]\n` +
  `  };\n` +
  `  const description = "Generate an image from a text prompt using the local max proxy image endpoint. Saves the image to disk and returns the artifact path, metadata, and an inline image block.";\n` +
  `  async function generateImage(args) {\n` +
  `    const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";\n` +
  `    if (!prompt) throw new Error("prompt required");\n` +
  `    const size = typeof args?.size === "string" && ["1024x1024", "1024x1536", "1536x1024"].includes(args.size) ? args.size : "1024x1024";\n` +
  `    const quality = typeof args?.quality === "string" && ["low", "medium", "high"].includes(args.quality) ? args.quality : "medium";\n` +
  `    const model = typeof args?.model === "string" && args.model.trim() ? args.model.trim() : "gpt-image-2";\n` +
  `    const endpoint = process.env.LETTA_IMAGE_GENERATION_URL || process.env.OPENAI_IMAGES_BASE_URL && process.env.OPENAI_IMAGES_BASE_URL.replace(/\\/$/, "") + "/images/generations" || "http://127.0.0.1:8082/v1/images/generations";\n` +
  `    const response = await fetch(endpoint, {\n` +
  `      method: "POST",\n` +
  `      headers: { "content-type": "application/json", "authorization": "Bearer " + (process.env.LETTA_IMAGE_GENERATION_API_KEY || process.env.OPENAI_API_KEY || "dummy") },\n` +
  `      body: JSON.stringify({ model, prompt, size, quality, n: 1, response_format: "b64_json" })\n` +
  `    });\n` +
  `    if (!response.ok) {\n` +
  `      const detail = await response.text().catch(() => "");\n` +
  `      throw new Error("image generation failed: HTTP " + response.status + (detail ? " " + detail.slice(0, 500) : ""));\n` +
  `    }\n` +
  `    const payload = await response.json();\n` +
  `    const first = payload && Array.isArray(payload.data) ? payload.data[0] : undefined;\n` +
  `    const b64 = first && typeof first.b64_json === "string" ? first.b64_json : undefined;\n` +
  `    if (!b64) throw new Error("image generation response did not include data[0].b64_json");\n` +
  `    const fs = await import("node:fs/promises");\n` +
  `    const path = await import("node:path");\n` +
  `    const crypto = await import("node:crypto");\n` +
  `    const outputDir = typeof args?.output_dir === "string" && args.output_dir.trim() ? args.output_dir.trim() : path.join(process.cwd(), ".letta", "generated-images");\n` +
  `    await fs.mkdir(outputDir, { recursive: true });\n` +
  `    const digest = crypto.createHash("sha256").update(prompt + "\\0" + Date.now().toString() + "\\0" + b64.slice(0, 64)).digest("hex").slice(0, 16);\n` +
  `    const filePath = path.join(outputDir, "generated-" + digest + ".png");\n` +
  `    await fs.writeFile(filePath, Buffer.from(b64, "base64"));\n` +
  `    const meta = { path: filePath, mime_type: "image/png", model, size, quality, prompt };\n` +
  `    return {\n` +
  `      content: [\n` +
  `        { type: "text", text: JSON.stringify(meta, null, 2) },\n` +
  `        { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }\n` +
  `      ],\n` +
  `      details: meta\n` +
  `    };\n` +
  `  }\n` +
  `  return { ...toolDefinitions, generate_image: defineToolFn({ schema, description, impl: generateImage }) };\n` +
  `};\n`;

const TOOL_DEFINITIONS_ASSIGN_TOKEN = `  TOOL_DEFINITIONS = toolDefinitions;\n});`;
const TOOL_DEFINITIONS_ASSIGN_REPLACEMENT =
  `  TOOL_DEFINITIONS = globalThis.__lcpAddGenerateImageTool(toolDefinitions, defineTool);\n});`;

const DEFAULT_TOOLS_TOKEN =
  `  "TaskUpdate",\n` +
  `  "Write"\n` +
  `];`;
const DEFAULT_TOOLS_REPLACEMENT =
  `  "TaskUpdate",\n` +
  `  "Write",\n` +
  `  "generate_image"\n` +
  `];`;

const DEFAULT_TOOLS_INDENTED_TOKEN =
  `    "TaskUpdate",\n` +
  `    "Write"\n` +
  `  ];`;
const DEFAULT_TOOLS_INDENTED_REPLACEMENT =
  `    "TaskUpdate",\n` +
  `    "Write",\n` +
  `    "generate_image"\n` +
  `  ];`;

const OPENAI_TOOLS_TOKEN =
  `  "ApplyPatch",\n` +
  `  "UpdatePlan"\n` +
  `];`;
const OPENAI_TOOLS_REPLACEMENT =
  `  "ApplyPatch",\n` +
  `  "UpdatePlan",\n` +
  `  "generate_image"\n` +
  `];`;

const OPENAI_TOOLS_INDENTED_TOKEN =
  `    "ApplyPatch",\n` +
  `    "UpdatePlan"\n` +
  `  ];`;
const OPENAI_TOOLS_INDENTED_REPLACEMENT =
  `    "ApplyPatch",\n` +
  `    "UpdatePlan",\n` +
  `    "generate_image"\n` +
  `  ];`;

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

  let appliedGenerateImageTool = false;
  if (patched.includes(TOOL_DEFINITIONS_ASSIGN_TOKEN)) {
    patched = patched.replace(TOOL_DEFINITIONS_ASSIGN_TOKEN, TOOL_DEFINITIONS_ASSIGN_REPLACEMENT);
    appliedPatches += 1;
    appliedGenerateImageTool = true;
  }
  if (patched.includes(DEFAULT_TOOLS_TOKEN)) {
    patched = patched.replaceAll(DEFAULT_TOOLS_TOKEN, DEFAULT_TOOLS_REPLACEMENT);
    appliedPatches += 1;
    appliedGenerateImageTool = true;
  }
  if (patched.includes(DEFAULT_TOOLS_INDENTED_TOKEN)) {
    patched = patched.replaceAll(DEFAULT_TOOLS_INDENTED_TOKEN, DEFAULT_TOOLS_INDENTED_REPLACEMENT);
    appliedPatches += 1;
    appliedGenerateImageTool = true;
  }
  if (patched.includes(OPENAI_TOOLS_TOKEN)) {
    patched = patched.replaceAll(OPENAI_TOOLS_TOKEN, OPENAI_TOOLS_REPLACEMENT);
    appliedPatches += 1;
    appliedGenerateImageTool = true;
  }
  if (patched.includes(OPENAI_TOOLS_INDENTED_TOKEN)) {
    patched = patched.replaceAll(OPENAI_TOOLS_INDENTED_TOKEN, OPENAI_TOOLS_INDENTED_REPLACEMENT);
    appliedPatches += 1;
    appliedGenerateImageTool = true;
  }
  if (appliedGenerateImageTool) {
    patched = injectHelperAfterShebang(patched, GENERATE_IMAGE_TOOL_HELPER_DEFINITION);
  } else if (warn) {
    process.stderr.write(
      `[letta-code-patch] WARN: generate_image tool registry tokens not found in ${path} — ` +
      `native image generation tool will not be registered\n`,
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
