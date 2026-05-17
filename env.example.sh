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

# Optional: pool tuning.
# export SHIM_POOL_MAX=10
# export SHIM_POOL_IDLE_SEC=300
# export SHIM_POOL_TURN_TIMEOUT=180000

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
