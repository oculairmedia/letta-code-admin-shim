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
