/**
 * lcp-ith — registers the letta-code source-mutation loader.
 *
 * The SDK wrapper passes this file as `node --import file://<this>` so the
 * loader hook installs before letta.js loads. `module.register()` is the
 * Node 20+ supported way to install loader hooks at runtime; it returns
 * immediately and the hook runs in a worker thread isolated from the main
 * application. See letta-code-patch-loader.mjs for the patch itself.
 */
import { register } from "node:module";

register("./letta-code-patch-loader.mjs", import.meta.url);

// lcp (subagent thinking-budget fix): ensure the patch loader reaches EVERY
// descendant node process, including the ones letta.js spawns for Agent/Task
// subagents.
//
// Root cause (proven empirically): the patch-loader's transform correctly
// wraps all messages.create/stream sites with __lcpFixThinking, so when it is
// applied the thinking.budget_tokens fix is complete. BUT a subagent dispatched
// via the Agent tool (especially with an explicit model) was spawning a node
// process that did NOT load this loader — its Anthropic request went out with
// `thinking:{type:"enabled"}` and no `budget_tokens`, which Anthropic rejects
// with `thinking.enabled.budget_tokens: Field required` (instant 400, 0 tool
// uses). The SDK wrapper propagates NODE_OPTIONS to its own child, but deeper
// subagent spawns derive their env from a curated settings env (not the full
// process env), so the `--import` flag was lost on that hop.
//
// Belt-and-suspenders: force the import flag into process.env.NODE_OPTIONS
// here (in EVERY process that loads this register file, including subagents
// once they DO get it). Any child spawned with `...process.env` then inherits
// the loader, so the patch propagates transitively down the whole subagent
// tree. Idempotent: only appended if not already present.
try {
  const selfHref = new URL("./letta-code-patch-register.mjs", import.meta.url).href;
  const importFlag = `--import=${selfHref}`;
  const existing = process.env["NODE_OPTIONS"] ?? "";
  if (!existing.includes("letta-code-patch-register")) {
    process.env["NODE_OPTIONS"] = `${existing} ${importFlag}`.trim();
  }
  // Ensure the thinking budget default is visible to descendants too, so the
  // __lcpFixThinking fallback (process.env.LETTA_CODE_THINKING_BUDGET_TOKENS
  // || 10000) always has a sane value even if a spawn drops the explicit env.
  if (!process.env["LETTA_CODE_THINKING_BUDGET_TOKENS"]) {
    process.env["LETTA_CODE_THINKING_BUDGET_TOKENS"] = "10000";
  }
} catch {
  // Never block startup on the propagation shim — the explicit-argv --import
  // on the parent still patches the parent process.
}
