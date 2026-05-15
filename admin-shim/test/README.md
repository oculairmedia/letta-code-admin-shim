# admin-shim tests

Behavioral test harness for the shim. Uses `node:test` (no extra deps).

```bash
cd admin-shim
npm test               # one shot
npm run test:watch     # re-runs on file changes
```

## How it works

Each test spawns a fresh shim subprocess on a random port with an isolated
state directory and temp HOME. A mock `letta` binary replays captured
stream-json traces so no real model is needed.

```
test/
├── helpers/
│   ├── shim.mjs          # spawn + teardown
│   ├── fixtures.mjs      # seed agents/conversations/messages
│   ├── sse.mjs           # parse SSE responses
│   ├── ws.mjs            # WebSocket client with frame collector
│   ├── letta-mock.mjs    # fake `letta` binary
│   └── index.mjs         # aggregate re-exports
├── fixtures/
│   ├── state/            # full LocalStore trees to copy at startShim()
│   └── stream-traces/    # captured letta-code stream-json traces
└── *.test.mjs
```

## Writing a test

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startShim, seedAgent, seedConversation, streamMessages, externalConvId,
} from "./helpers/index.js";

test("describe what's tested", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());                       // MANDATORY

  const agentId = seedAgent(shim.stateDir, { id: "agent-...", name: "..." });
  seedConversation(shim.stateDir, agentId);

  const res = await fetch(`${shim.url}/v1/agents`);
  assert.equal(res.status, 200);
});
```

## Stream traces

Captured from real letta-code in `fixtures/stream-traces/*.jsonl`:

| Trace | Frames | Tools | Pattern |
|-------|--------|-------|---------|
| `plain` | 9 | — | single short reply ("pong") |
| `bash-tool` | 13 | Bash | tool call + text follow-up |
| `read-tool` | 13 | Read | tool call + text follow-up |
| `multi-step` | 13 | — | chunked multi-paragraph text |
| `multi-tool-bash-read` | 17 | Bash, Read | two tools in sequence |
| `interleaved-tools` | 27 | Bash×3 | text→tool→text→tool→text→tool |
| `tool-then-text` | 17 | Bash | tool then substantial text |
| `text-only-long` | 24 | — | 17 chunks across paragraphs |
| `empty-reply` | 7 | — | no assistant content |

The mock selects a trace based on the user message text (see
`helpers/letta-mock.mjs` `pickTrace()`). Force a specific trace with:

```js
await startShim({ env: { LETTA_MOCK_FORCE_TRACE: "interleaved-tools" } });
```

Add a delay between mock frames for race-condition tests:

```js
await startShim({ env: { LETTA_MOCK_DELAY_MS: "500" } });
```

## Mock limitations

- The mock does NOT write to `messages.jsonl`. So `Run.message_ids` will be
  empty after a mock turn, and `GET /v1/conversations/{id}/messages` won't
  reflect newly-sent messages unless you pre-seed them via `seedMessage()`.
- The mock's `usage_statistics` numbers come from the captured fixture, not
  from a live model. They're stable across runs but tied to the original
  capture.
- No real network — `LETTA_BASE_URL` / `LMSTUDIO_BASE_URL` are set to
  `http://127.0.0.1:0`.

## Capturing new traces

When letta-code's stream output changes (e.g., a new frame type), recapture
the fixtures against a real `letta` instance:

```bash
source ../env.sh
AGENT=agent-...
printf '%s\n' '{"type":"user","message":{"content":"YOUR PROMPT"}}' | \
  letta --backend local --agent $AGENT \
    --input-format stream-json --output-format stream-json \
    --include-partial-messages \
  > test/fixtures/stream-traces/new-trace.jsonl
```

Add a routing keyword to `helpers/letta-mock.mjs` `pickTrace()` so tests can
select the new trace by prompt text.

## Running a single file

```bash
node --test test/streaming.test.mjs
```

## CI

`.github/workflows/test.yml` runs `npm test` on every push and PR.
