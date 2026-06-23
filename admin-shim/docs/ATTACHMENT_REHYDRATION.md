# Image / Attachment Rehydration (lcp-67lp)

## Problem

Mobile preserves locally-sent image attachments during the same-session
confirmation flow (the optimistic Local bubble holds the bytes the user just
picked). But a full conversation **reload** loses those images, because the
upstream Letta server's `GET /conversations/{id}/messages` does **not**
persist or expose image parts — it returns text-only messages. After a reload
the client only has the text, so the image disappears.

## Contract

The admin-shim adds server-side affordances so a reload can rehydrate images:

1. **Persist before stripping.** On SEND, the shim content-addresses every
   client-submitted image part (sha256), enforces size/type bounds, and writes
   a lightweight ref envelope to a per-conversation sidecar **before** the
   message is forwarded to (and the image stripped by) the model. No raw bytes
   are stored in the sidecar — only the content-addressed reference + metadata.
2. **Rehydrate on read.** On every message READ/RELOAD, the shim loads the
   sidecar and re-attaches the refs to the projected `user_message` envelopes.
   The message `content` stays text-only (upstream-compatible); the refs ride
   alongside in an `attachments` array.
3. **Text-only compatibility.** Messages with no persisted refs are returned
   unchanged — no `attachments` field is added.

The image bytes themselves are sent to the model on the send turn (so the
model still "sees" the image); they are simply not re-sent on reload. Mobile is
expected to keep/resolve the actual pixel data out-of-band (e.g. its own local
cache keyed by the `sha256` / `ref`), or to treat the ref as a placeholder.
Resolving the ref back to bytes server-side is **out of scope** for this bead
and tracked on the mobile side (letta-mobile `iinkd` / `xybm2`).

## Attachment-ref envelope (what mobile consumes)

On a `user_message` read, when the shim has persisted image refs for that
message, the wire message carries an `attachments` array:

```jsonc
{
  "id": "ui-msg-...",
  "message_type": "user_message",
  "content": "what is this?",        // text-only, upstream-compatible
  "otid": "...",
  "run_id": "...",
  "attachments": [
    {
      "kind": "image",               // only "image" today
      "ref": "sha256:<64-hex>",      // stable content-addressed id
      "sha256": "<64-hex>",          // raw digest (== ref minus the "sha256:" prefix)
      "media_type": "image/png",     // one of: gif, jpeg, png, webp
      "size_bytes": 12345            // decoded byte length, 0 < n <= max
    }
  ]
}
```

- `attachments` is **absent** on text-only messages and on all non-user
  message types.
- `ref` is stable across reloads (content-addressed by sha256 of the decoded
  bytes), and stable across messages that send the same image.
- The envelope **never** contains the base64 payload.

## Storage / keying

- **Sidecar file:** `<storageDir>/conversations/<b64url(convKey)>/_attachments.json`
  where `convKey` is `default:<agentId>` for the default conversation, else
  `conversation:<conversationId>` — the same keying as the otid / real-times
  sidecars.
- **Shape:** `Record<localMessageId, AttachmentRef[]>`. Keyed by the persisted
  `LocalMessage` id (the same id the read projection emits), so refs join
  back onto the right message on reload.
- **Cache:** an in-process write-through cache mirrors the otid-map cache;
  a failed write invalidates the cache entry.

## Bounds & safety

- **Max size:** `SHIM_ATTACHMENT_MAX_BYTES` env var, default `10485760`
  (10 MiB), measured on the decoded bytes.
- **Allowed media types:** `image/gif`, `image/jpeg`, `image/png`, `image/webp`.
- Oversize, disallowed, or malformed-base64 parts are **skipped gracefully**:
  they produce no ref (the image still reaches the model on the send turn, it
  just isn't rehydratable on reload). Nothing throws.
- The sidecar read path validates every loaded entry (`isAttachmentSidecar`)
  and discards anything that doesn't match the bounded envelope shape, so a
  corrupt/tampered sidecar can't inject arbitrary refs.

## Send paths covered

Both shim send transports persist refs against the new user message:

- **REST/SSE** — `POST .../messages` (`lib/chat.ts`, `handleSendMessage`).
- **Mobile WS bridge** — `lib/mobile-channel-host.ts` (`bridgeSendMessage`),
  mobile's primary transport; refs are extracted from `content_parts`.

## Read paths covered

`lib/server.ts` loads `readAttachmentMap` and threads
`attachmentsByMessageId` into `localMessageToConversationMessages` on:

- `handleAgentMessages`
- `handleConversationMessagesList`
- `handleRunMessages`

## Mobile follow-up

The consuming side (rendering the rehydrated ref, and resolving `ref`/`sha256`
back to displayable bytes from the mobile-local cache) is tracked separately
under letta-mobile `iinkd` / the `xybm2` work.
