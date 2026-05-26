#!/usr/bin/env node
/**
 * SDK ↔ letta-code CLI shim wrapper (lcp-sdk.9 / LET-9013).
 *
 * The Letta Code SDK's SubprocessTransport spawns the CLI as:
 *
 *   spawn("node", [LETTA_CLI_PATH, ...sdkArgs], { stdio: ["pipe","pipe","pipe"] })
 *
 * It does NOT pass `--backend local`. Current letta-code CLI versions
 * require that flag explicitly — `LETTA_LOCAL_BACKEND_EXPERIMENTAL=1`
 * alone is not enough; without `--backend local` the CLI tries to reach
 * the remote Letta server at LETTA_BASE_URL and exits with "Failed to
 * connect to Letta server".
 *
 * Until the SDK or CLI is fixed upstream (tracked as LET-9013), point
 * the shim's LETTA_CLI_PATH at THIS file. It prepends `--backend local`
 * to the SDK-supplied argv (if not already present) and execs the real
 * CLI with inherited stdio so the SDK's pipes connect through to the
 * real binary unchanged.
 *
 * Env contract:
 *
 *   LETTA_CLI_PATH_REAL  (required) — absolute path to the real
 *                                     letta-code CLI (e.g.
 *                                     /root/.bun/install/global/node_modules/@letta-ai/letta-code/letta.js).
 *
 *   LETTA_LOCAL_BACKEND_EXPERIMENTAL=1  (required by the real CLI when
 *                                       running in local mode; the
 *                                       shim's systemd unit already
 *                                       sets this — we just pass it
 *                                       through).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const realCli = process.env["LETTA_CLI_PATH_REAL"];
if (!realCli) {
  console.error("[letta-cli-sdk-wrapper] LETTA_CLI_PATH_REAL is not set");
  process.exit(2);
}
if (!existsSync(realCli)) {
  console.error(`[letta-cli-sdk-wrapper] LETTA_CLI_PATH_REAL does not exist: ${realCli}`);
  process.exit(2);
}

// lcp-ith: register a load-time patch for letta-code's settle-on-turn bug
// before letta.js evaluates. The register file (sibling of this wrapper)
// installs the actual loader via module.register(); the loader rewrites
// the buggy `executeConversationTurn` call site so settleInterruptedToolCalls
// receives `agentId`. Without this, migrated agents (agent-<uuid>) leak
// orphan tool_use records on disk and every subsequent turn fails the
// Anthropic validator. See letta-code-patch-loader.mjs for details.
const wrapperDir = dirname(fileURLToPath(import.meta.url));
const registerPath = join(wrapperDir, "letta-code-patch-register.mjs");
const registerUrl = pathToFileURL(registerPath).href;

const sdkArgs = process.argv.slice(2);
const hasBackend = sdkArgs.includes("--backend");
const args = hasBackend ? sdkArgs : ["--backend", "local", ...sdkArgs];

const child = spawn("node", ["--import", registerUrl, realCli, ...args], {
  stdio: "inherit",
  env: process.env,
});

// Forward signals so the SDK's session.abort() (which sends SIGTERM
// to the spawned node process — our wrapper) actually terminates the
// real CLI underneath.
/** @type {NodeJS.Signals[]} */
const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
for (const sig of signals) {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* already gone */ }
  });
}

child.on("exit", (code, sig) => {
  if (sig) {
    process.kill(process.pid, sig);
  } else {
    process.exit(code ?? 0);
  }
});

child.on("error", (err) => {
  console.error(`[letta-cli-sdk-wrapper] child spawn failed: ${err.message}`);
  process.exit(127);
});
