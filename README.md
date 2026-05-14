# letta-code admin shim

A vanilla-Letta-compatible HTTP API + mobile WebSocket channel that sits on top of
[`letta-code`](https://github.com/letta-ai/letta-code)'s LocalBackend. Lets you point
mobile apps, scripts, and the rest of the Letta ecosystem at a self-hosted
letta-code instance without a Python Letta server in the loop.

**What you get:**

- `/v1/agents`, `/v1/conversations`, `/v1/messages`, `/v1/runs/*`, `/v1/blocks` etc.
  matching the vanilla Letta REST surface — drop-in for clients built against
  the Letta API.
- Persistent **Run tracking** (status, ttft, duration, tools_used, usage) backing
  mobile's `/v1/runs/{id}/*` calls and POST cancel.
- **Token usage aggregation** at `GET /shim/v1/usage/summary` with filters and
  group-by agent / conversation / model / day.
- **Mobile channel** at `WS /shim/v1/mobile` — first-class channel plugin that
  carries `tool_call_message`, `tool_return_message`, `assistant_message`,
  `stop_reason`, `usage_statistics`, `turn_done`, plus run_id correlation and
  in-flight cancel.
- **Matrix channel** plugin for ambient agent presence in Matrix rooms.
- Migrator script for moving agents off a vanilla Letta server (export `.af` → LocalStore).

**What it isn't:**

- Not a fork of letta-code. It runs `letta` as a subprocess via worker pool.
- Not a Python Letta server replacement at the wire level for endpoints we don't
  expose. See `admin-shim/docs/DIVERGENCE.md` for what's intentionally different.

---

## Quickstart

Prereqs: Node 20+, [letta-code](https://github.com/letta-ai/letta-code) installed
on PATH (`letta --version`), an OpenAI-compatible model endpoint (LM Studio,
Anthropic Max Proxy, OpenRouter, etc.).

```bash
git clone https://github.com/oculairmedia/letta-code-admin-shim.git
cd letta-code-admin-shim

# 1. Configure
cp env.example.sh env.sh
$EDITOR env.sh              # set LMSTUDIO_BASE_URL, MOBILE_CHANNEL_TOKEN

cp home/.letta/channels/mobile/accounts.example.json \
   home/.letta/channels/mobile/accounts.json

# 2. Install + run the shim
cd admin-shim && npm install && cd ..

source ./env.sh
node admin-shim/server.mjs
```

The shim listens on `http://0.0.0.0:8291` by default. Health check:

```bash
curl http://localhost:8291/v1/health/
```

You'll need at least one agent — either create one via the `letta` CLI, or
migrate an existing one (see "Migrating from a Python Letta server" below).

### Mobile channel smoke test

With the shim running and `MOBILE_CHANNEL_TOKEN` exported:

```bash
node home/.letta/channels/mobile/test/ws-smoke.mjs \
  --token "$MOBILE_CHANNEL_TOKEN" \
  --agent agent-XXXX-...
```

A plain turn finishes in a few seconds with `[smoke] PASS`. Add
`--expect-tool Bash --text "run bash pwd"` to assert a tool-call turn.

---

## Layout

```
.
├── admin-shim/                 # The HTTP server (Node, no framework)
│   ├── server.mjs              # Route table
│   ├── lib/
│   │   ├── store.mjs           # Read letta-code's LocalBackend on disk
│   │   ├── translate.mjs       # LocalMessage ↔ vanilla Letta wire shape
│   │   ├── chat.mjs            # POST /messages, SSE streaming, otid bind
│   │   ├── agent-pool.mjs      # Long-running `letta` workers per conv
│   │   ├── runs.mjs            # Run records + usage aggregation
│   │   └── mobile-channel-host.mjs  # Bridge to the mobile channel plugin
│   └── docs/DIVERGENCE.md      # Intentional differences from vanilla
├── home/.letta/channels/
│   ├── mobile/                 # Mobile WS channel plugin (Phase 1)
│   │   ├── plugin.mjs
│   │   ├── lib/{protocol,ws-handler,state}.mjs
│   │   └── test/ws-smoke.mjs
│   └── matrix/                 # Matrix channel plugin (optional)
├── migrator/scripts/translate.mjs   # .af export → LocalStore migrator
├── docs/
│   └── MOBILE_CHANNEL_DESIGN.md
└── env.example.sh              # Copy to env.sh and edit
```

Runtime state lives in `state/` and `home/.letta/lc-local-backend/` — both
gitignored. The on-disk format is authoritative; the shim is stateless beyond
short-lived agent-pool workers and active-run handles.

---

## Configuration

All knobs are env vars (see `env.example.sh`):

| Var | Default | Purpose |
| --- | --- | --- |
| `SHIM_PORT` | `8291` | HTTP listen port |
| `SHIM_HOST` | `0.0.0.0` | HTTP listen iface |
| `LETTA_LOCAL_BACKEND_DIR` | `./state` | letta-code on-disk root |
| `HOME` | `./home` | sandboxed `~/.letta` location |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible model endpoint |
| `MOBILE_CHANNEL_TOKEN` | _(required for mobile)_ | shared secret for WS auth |
| `SHIM_POOL_MAX` | `10` | warm letta worker cap |
| `SHIM_POOL_IDLE_SEC` | `300` | evict workers idle this long |
| `SHIM_POOL_TURN_TIMEOUT` | `180000` ms | safety timeout per turn |
| `SHIM_POOL_DISABLE` | _(unset)_ | set `1` to spawn `letta` per request (no pooling) |

---

## API summary

### Vanilla-shaped (`/v1/*`)

- `GET /v1/agents`, `GET /v1/agents/{id}`, `GET /v1/agents/{id}/messages`
- `GET /v1/conversations`, `POST /v1/conversations`, `GET /v1/conversations/{id}/messages`
- `POST /v1/conversations/{id}/messages` (SSE streaming, with `otid` reconcile)
- `GET /v1/runs/` (filters: agent_id, conversation_id, active, statuses, before/after)
- `GET /v1/runs/{id}` / `/messages` / `/usage` / `/metrics` / `/steps`
- `DELETE /v1/runs/{id}`
- `POST /v1/agents/{id}/messages/cancel` (`{ run_ids: [...] }`)
- `GET /v1/blocks`, `GET /v1/agents/{id}/core-memory/blocks`
- `GET /v1/models`, `GET /v1/providers`, `GET /v1/tools`

### Shim extensions (`/shim/*`)

- `GET /shim/v1/usage/summary?[agent_id|conversation_id|start|end|statuses[]|group_by]`
  — Aggregate token usage. `group_by` ∈ `{agent, conversation, model, day}`.
- `WS /shim/v1/mobile` — Mobile channel transport (see `docs/MOBILE_CHANNEL_DESIGN.md`).
- `GET /shim/pool` — agent worker pool stats.

See `admin-shim/docs/DIVERGENCE.md` for the full list of intentional differences
from vanilla Letta.

---

## Migrating from a Python Letta server

If you have an existing agent on a vanilla Letta server, export it as `.af`
and run the migrator:

```bash
# On the vanilla server:
curl -H "Authorization: Bearer $LETTA_TOKEN" \
  "$LETTA_API_URL/v1/agents/{agent_id}/export" \
  -o migrator/data/myagent/export.af

# In this repo, with env.sh sourced:
node migrator/scripts/translate.mjs --in migrator/data/myagent --out state
```

The migrator writes a LocalStore-shaped tree. By default it generates a fresh
agent id; pass `--preserve-id` to keep the original UUID.

---

## Development

```bash
cd admin-shim && npm install
node ../home/.letta/channels/mobile/test/ws-smoke.mjs --text "ack"
```

There's no test framework — channels and the shim ship smoke tests that
exercise the wire surface end-to-end. The codebase deliberately favors
zero-dependency, filesystem-state, manifest-driven plugins — see `AGENTS.md`
for the principles.

## License

MIT. See `LICENSE`.
