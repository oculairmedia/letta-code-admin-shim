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
