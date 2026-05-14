# Matrix channel plugin for letta-code (v2)

User-defined channel plugin loaded from `~/.letta/channels/matrix/` per the
plugin contract documented in upstream `src/channels/README.md`. No fork of
letta-code needed.

Feature parity uplift inspired by the production
`/opt/stacks/matrix-tuwunel-deploy` client. This rev adds inbound media,
markdown→HTML, mentions, typing indicators, reactions/edits/deletes, event
dedupe, and echo-filtering.

## What's in v2

| Capability | v2 | Notes |
|---|---|---|
| Long-poll `/sync` with persisted token | ✅ | resumes cleanly across restarts |
| Bootstrap-backlog drop | ✅ | fresh install doesn't replay history |
| Inbound text (`m.text`/`m.notice`/`m.emote`) | ✅ | |
| Inbound images (`m.image`) | ✅ | downloaded to media-cache, ≤ 650 KiB inlined as base64 for vision models |
| Inbound audio / video / files | ✅ | downloaded to media-cache, surfaced as `attachments[]` |
| Auto-join room invites | ✅ | toggle via `config.autoJoinInvites` |
| Mention detection | ✅ | `m.mentions.user_ids` (MSC3952) + `@localpart` text + regex |
| Reply context preserved | ✅ | extracted to `threadContext.starter` |
| Event dedupe | ✅ | file-backed cache (`state/<id>.dedupe.json`), 1h TTL, 5k entries |
| Echo filter | ✅ | drops bot's own streaming-progress messages (🔧 💭 ✅ ❌ ⏳ ⚠️) |
| Outbound plain text | ✅ | |
| Outbound markdown→HTML | ✅ | auto-detected; tiny zero-dep converter (bold/italic/code/lists/links/headings/blockquote) |
| Threaded reply (`m.thread`) | ✅ | via `OutboundChannelMessage.threadId` |
| Reactions (`m.reaction`) | ✅ | via `messageActions.handleAction` (`action: "react"`) |
| Edits (`m.replace`) | ✅ | action: `"edit"` |
| Deletes (redaction) | ✅ | action: `"delete"` |
| Typing indicators with heartbeat | ✅ | refreshes every 4s during an inbound turn |
| Read receipts | opt-in | `config.readReceipts: true` |

## Intentionally not in v2

These exist in the production matrix-tuwunel client but were skipped here:

- **Multi-identity / per-agent Matrix users**: needs an identity service
  (`src/core/identity_storage`) and an OAuth/login pool. Significant
  infrastructure — defer.
- **Voice transcription**: needs Whisper or Voxtral hosted somewhere.
  Inbound audio attachments still flow to the agent as files; just no auto
  STT yet.
- **Document parsing (PDF/DOCX → text)**: production uses MarkItDown. We
  ship the raw file path and let the agent invoke its own document tools.
- **Live-edit streaming during agent turns**: would require hooking
  letta-code's turn lifecycle events to push partial outputs into a single
  in-place edited Matrix message. Typing indicators cover the visible-UX gap
  for now.
- **Matrix pills for outgoing mentions**: outbound HTML doesn't yet rewrite
  `@AgentName` → `<a href="https://matrix.to/#/@user:domain">…</a>`. Plain
  text passes through; clients render it as `@AgentName` unstyled.
- **Polls (MSC3381)**: not handled inbound.
- **Encryption (E2EE)**: requires a real client SDK with Olm. Plain rooms only.
- **Conversation metrics, alerting, room cache, portal handler**: domain
  glue from the existing stack — would live above the plugin if needed.

## File layout

```
~/.letta/channels/matrix/
├── channel.json
├── plugin.mjs                 # ~280 lines, wires lib/ modules together
├── accounts.json
├── README.md
├── lib/
│   ├── api.mjs                # Matrix Client-Server v3 HTTP wrapper (zero-dep)
│   ├── inbound.mjs            # timeline event → InboundChannelMessage
│   ├── outbound.mjs           # send / react / edit / delete builders
│   ├── media.mjs              # download attachments + base64 budget
│   ├── markdown.mjs           # md → HTML (subset)
│   ├── mentions.mjs           # MSC3952 + @localpart + regex
│   ├── echo.mjs               # streaming-progress echo filter
│   ├── state.mjs              # sync token + dedupe (file-backed)
│   └── typing.mjs             # typing indicators + heartbeat
├── state/                     # auto-managed
│   ├── <accountId>.json       # next /sync token
│   └── <accountId>.dedupe.json
├── media-cache/<accountId>/   # auto-managed downloads
└── test/smoke.mjs             # standalone end-to-end exerciser
```

## Account config (`accounts.json`)

```jsonc
{
  "accounts": [{
    "channel": "matrix",
    "accountId": "lettabot",
    "displayName": "lettabot@matrix.oculair.ca",
    "enabled": true,
    "dmPolicy": "open",            // "open" | "allowlist" | "pairing"
    "allowedUsers": [],
    "config": {
      "homeserverUrl": "http://192.168.50.90:8008",
      "accessToken":   "<bot access token>",
      "userId":        "@lettabot:matrix.oculair.ca",
      "autoJoinInvites": true,
      "syncTimeoutMs":   30000,
      "typingIndicators": true,
      "readReceipts":     false,
      "mentionPatterns":  ["\\bmeridian\\b", "\\btriage\\b"]
    }
  }]
}
```

## Running

```bash
source /opt/stacks/letta-code-parallel/env.sh
letta server --channels matrix --env-name local-test
```

`LETTA_BASE_URL=http://127.0.0.1:0` (set in `env.sh`) selects the
`local-channels` listener startup mode (no Letta Cloud OAuth).

## Wiring a room → agent route

```bash
letta channels route add \
  --channel matrix \
  --account-id lettabot \
  --chat-id "!Pe4ArriZEzEOQwAzxI:matrix.oculair.ca" \
  --agent agent-local-ffa3a92b-f5d6-45e1-8866-f3c965a92133 \
  --conversation local-conv-1
```

Without a route, inbound messages enter letta-code's pairing flow.

## Standalone smoke test

```bash
node ~/.letta/channels/matrix/test/smoke.mjs '!Pe4ArriZEzEOQwAzxI:matrix.oculair.ca' 20
```

Sends a plain message, a markdown message, a reaction, an edit, and a reply,
then tails `/sync` for 20 s so you can verify inbound parsing (incl.
attachments).
