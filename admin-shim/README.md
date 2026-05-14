# letta-code admin shim

Tiny zero-dep Node service that exposes a Letta-server-compatible REST surface
on top of letta-code's `LocalBackend` on-disk state, so `letta-mobile` (and any
other Letta REST client) can read agents and chat with them without the Python
Letta server.

## Status: Phase 1 ✓

Read + chat coverage proven against the migrated Meridian agent.

| Endpoint | Method | Status |
|---|---|---|
| `/v1/health/` | GET | ✓ |
| `/v1/agents` | GET | ✓ list, filter by tags / name |
| `/v1/agents/count` | GET | ✓ |
| `/v1/agents/{id}` | GET | ✓ full Letta `AgentState` shape |
| `/v1/agents/{id}/messages` | GET | ✓ list, paginated |
| `/v1/agents/{id}/messages` | POST | ✓ stream (SSE) + non-stream |
| `/v1/agents/{id}/context` | GET | ✓ context window overview |
| `/v1/agents/{id}/core-memory/blocks` | GET | ✓ |
| `/v1/blocks`, `/v1/blocks/{id}` | GET | ✓ |
| `/v1/models` | GET | ✓ (single entry, expand later) |
| anything else | * | 404 — mobile UI degrades gracefully |

## Run

```bash
source /opt/stacks/letta-code-parallel/env.sh
export LETTA_LOCAL_BACKEND_DIR=/opt/stacks/letta-code-parallel/migrator/out
node /opt/stacks/letta-code-parallel/admin-shim/server.mjs
# → listening on http://0.0.0.0:8291
```

Override port: `SHIM_PORT=8292 node …`.

Point letta-mobile at `http://<this-host>:8291` instead of the Python Letta
server (default `192.168.50.90:8289`).

## How chat works

`POST /v1/agents/{id}/messages` spawns `letta --backend local --agent <id> -p
<text> --output-format stream-json` as a subprocess per request, then either:

- **stream**: relays each stdout line as an SSE event (`event: <message_type>\ndata: <json>\n\n`)
- **non-stream**: collects all frames, returns a single JSON with the
  assistant messages, usage, and stop reason

The subprocess is killed if the HTTP client disconnects.

## Layout

```
admin-shim/
├── README.md
├── server.mjs           # HTTP server + routes
└── lib/
    ├── store.mjs        # Read LocalStore from disk
    ├── translate.mjs    # LocalAgentRecord/LocalMessage → Letta server shapes
    └── chat.mjs         # POST /v1/agents/{id}/messages
```

## What's deliberately missing in Phase 1

- POST/PATCH/DELETE on agents, blocks, archival memory, schedule — Phase 2
- Tools / providers / MCP servers / identities / folders / groups / jobs / runs — Phase 3+
- Real `/v1/models` enumeration from the lmstudio backend — Phase 2 (just returns the one we've validated)
- Auth — currently open; gate behind a bearer token once we wire up a real client
- The "cached_input_tokens" returned in usage right now includes the entire
  system prompt + history. Phase 2 cache reporting tweaks.

## Known caveats

- letta-code splits long assistant outputs into multiple `assistant_message`
  frames. Mobile UIs that don't concatenate may show fragmented bubbles.
  Easy fix: collapse consecutive frames in the non-streaming path.
- The subprocess-per-message model has ~1–2s startup overhead per turn.
  Phase 2 idea: keep a single long-running `letta server` and pipe via a
  control socket. (Or — channels-as-transport, the mobile channel plugin.)
