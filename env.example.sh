#!/bin/bash
# Sample environment for the letta-code admin shim.
# Copy to env.sh and edit; env.sh is gitignored.
#
# Usage:  source ./env.example.sh    (or copy to env.sh and source that)

# Project root (defaults to the directory this file lives in).
export SHIM_ROOT="${SHIM_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"

# letta-code backend mode — leave these as-is for self-host.
export LETTA_LOCAL_BACKEND_EXPERIMENTAL=1
export LETTA_LOCAL_BACKEND_DIR="${LETTA_LOCAL_BACKEND_DIR:-$SHIM_ROOT/state}"

# Point HOME at the project-local home/ so ~/.letta and the channel plugins
# are sandboxed away from any system-wide letta config.
export HOME="${HOME_OVERRIDE:-$SHIM_ROOT/home}"
mkdir -p "$HOME" "$LETTA_LOCAL_BACKEND_DIR"

# Disable cloud auth — required for local-channels mode.
unset LETTA_API_KEY
unset LETTA_API_URL
export LETTA_BASE_URL=http://127.0.0.1:0

# Model provider. Default: OpenAI-compatible endpoint at $LMSTUDIO_BASE_URL.
# Examples:
#   LM Studio (default port):       http://localhost:1234/v1
#   Anthropic Max Proxy (OAuth):    http://localhost:8082/v1
#   OpenRouter:                     https://openrouter.ai/api/v1
export LMSTUDIO_BASE_URL="${LMSTUDIO_BASE_URL:-http://localhost:1234/v1}"

# Mobile channel WS token. Generate a strong one with `openssl rand -hex 32`
# (or `uuidgen`). The plugin REJECTS the placeholder in accounts.example.json.
export MOBILE_CHANNEL_TOKEN="${MOBILE_CHANNEL_TOKEN:-}"

# Shim HTTP port. 8291 by default.
export SHIM_PORT="${SHIM_PORT:-8291}"
export SHIM_HOST="${SHIM_HOST:-0.0.0.0}"

# Optional: pool tuning (lcp-2oxb.6 sizing guidance).
#
# Each warm pool worker is a full letta-code CLI subprocess. Measured on
# this host 2026-06-10: ~450 MB RSS for a warm shim worker with loaded
# conversation state (plain letta.js instances idle at ~80-100 MB; budget
# toward the high end for agents with real history). Size the cap as:
#
#   SHIM_POOL_MAX ≈ (RAM you can spend on workers) / 450 MB
#
# e.g. ~4.5 GB worst case at the default of 10. The pool LRU-evicts idle
# non-busy workers past the cap and may temporarily exceed it rather than
# kill an in-flight turn (lcp-2oxb.2 overflow), so leave headroom. Cold
# start of an evicted worker is a full Node boot of the ~491k-line bundle
# plus session resume — keep SHIM_POOL_IDLE_SEC generous (default 300s)
# if your traffic pattern revisits conversations.
# export SHIM_POOL_MAX=10
# export SHIM_POOL_IDLE_SEC=300
# export SHIM_POOL_TURN_TIMEOUT=1800000        # absolute turn ceiling (ms)
# export SHIM_POOL_TURN_SILENCE_MS=120000      # silence watchdog (ms)

# Letta Code CLI binary the SDK adapter spawns.
#
# The shim drives letta-code through @letta-ai/letta-code-sdk's Session,
# which spawns `node <cliPath>` and resolves cliPath via LETTA_CLI_PATH
# first, then require.resolve("@letta-ai/letta-code"). For local-backend
# mode, the shim routes through admin-shim/scripts/letta-cli-sdk-wrapper.mjs,
# which prepends `--backend local` before exec'ing the real CLI (see
# LET-9013). server.ts auto-wires this when LETTA_CLI_PATH is unset; set
# both vars explicitly to pin to a specific binary:
# export LETTA_CLI_PATH=/opt/stacks/letta-code-parallel/admin-shim/scripts/letta-cli-sdk-wrapper.mjs
# export LETTA_CLI_PATH_REAL=/root/.bun/install/global/node_modules/@letta-ai/letta-code/letta.js

# A2UI dynamic UI support. The shim injects the v0.9 Basic Catalog grammar
# into the upstream model's system prompt when a WS client opts in via
# its `hello` frame (a2ui_version + supported_catalogs + supported_widgets)
# AND A2UI_ENABLED=1 here. Off by default keeps non-A2UI clients on the
# exact phase-1 text/tool behavior; on flips the whole pipeline (prompt
# injection, stream splitter, a2ui_frame emission, user_action ingestion).
#
# Mobile shows a "· A2UI" badge in the chip when negotiation succeeds.
# Verify with `tail -f /tmp/shim-restart.log` — the ws-handler logs
# "a2ui negotiated …" / "a2ui rejected …" / "a2ui not requested …" per
# hello so you can diagnose mismatches without instrumentation.
export A2UI_ENABLED="${A2UI_ENABLED:-1}"
export A2UI_VERSION="${A2UI_VERSION:-0.9}"
export A2UI_CATALOG_ID="${A2UI_CATALOG_ID:-basic}"
# Optional prompt overrides — uncomment to customize.
# export A2UI_ROLE_DESCRIPTION="You are a Letta agent that can emit A2UI dynamic interface messages when useful."
# export A2UI_UI_DESCRIPTION="Use the A2UI v0.9 Basic Catalog to create concise, safe, task-focused UI surfaces for the connected client."

echo "letta-code shim env active:"
echo "  SHIM_ROOT=$SHIM_ROOT"
echo "  HOME=$HOME"
echo "  LETTA_LOCAL_BACKEND_DIR=$LETTA_LOCAL_BACKEND_DIR"
echo "  LMSTUDIO_BASE_URL=$LMSTUDIO_BASE_URL"
echo "  SHIM_PORT=$SHIM_PORT"
if [ -z "$MOBILE_CHANNEL_TOKEN" ]; then
  echo "  warn: MOBILE_CHANNEL_TOKEN is empty — mobile channel will be unusable"
fi
echo "  letta version: $(letta --version 2>/dev/null || echo 'NOT INSTALLED')"
