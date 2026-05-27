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
  `        ...updateArgs?.enable_reasoner !== false && typeof updateArgs?.max_reasoning_tokens === "number" && {\n` +
  `          budget_tokens: updateArgs.max_reasoning_tokens\n` +
  `        }\n` +
  `      };`;

const THINKING_REQUEST_GUARD_ANCHOR =
  `  if (options3?.metadata) {\n` +
  `    const userId = options3.metadata.user_id;`;

const THINKING_REQUEST_GUARD_INSERT =
  `  if (params.thinking && params.thinking.type !== "enabled" && "budget_tokens" in params.thinking) {\n` +
  `    delete params.thinking.budget_tokens;\n` +
  `  }\n` +
  `  if (options3?.metadata) {\n` +
  `    const userId = options3.metadata.user_id;`;

let appliedOnce = false;

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

  let patched = raw;
  let appliedPatches = 0;

  if (patched.includes(SETTLE_BUG_LITERAL)) {
    patched = patched.replace(SETTLE_BUG_LITERAL, SETTLE_FIX_LITERAL);
    appliedPatches += 1;
  } else {
    if (!appliedOnce) {
      process.stderr.write(
        `[letta-code-patch] WARN: settle-bug literal not found in ${path} — ` +
        `running unpatched (letta-code likely upgraded past 0.26.1)\n`,
      );
    }
  }

  if (patched.includes(THINKING_SETTINGS_BUG_LITERAL)) {
    patched = patched.replaceAll(THINKING_SETTINGS_BUG_LITERAL, THINKING_SETTINGS_FIX_LITERAL);
    appliedPatches += 1;
  } else if (!appliedOnce) {
    process.stderr.write(
      `[letta-code-patch] WARN: thinking-settings literal not found in ${path} — ` +
      `running without lcp-9pn settings guard\n`,
    );
  }

  if (patched.includes(THINKING_REQUEST_GUARD_ANCHOR)) {
    patched = patched.replace(THINKING_REQUEST_GUARD_ANCHOR, THINKING_REQUEST_GUARD_INSERT);
    appliedPatches += 1;
  } else if (!appliedOnce) {
    process.stderr.write(
      `[letta-code-patch] WARN: thinking-request guard anchor not found in ${path} — ` +
      `running without lcp-9pn request guard\n`,
    );
  }

  if (appliedPatches === 0) return result;

  if (!appliedOnce) {
    process.stderr.write(
      `[letta-code-patch] applied ${appliedPatches} runtime patch(es) to ${path}\n`,
    );
    appliedOnce = true;
  }
  return { ...result, source: patched, shortCircuit: true };
}
