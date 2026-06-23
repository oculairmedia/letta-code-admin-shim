import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractAttachmentRefsFromMessageBody,
  isAttachmentSidecar,
  MAX_ATTACHMENT_BYTES,
  type AttachmentSidecar,
} from "../lib/attachments.js";
import { localMessageToConversationMessages } from "../lib/translate.js";
import type { LocalMessage } from "../lib/types/letta-stream.js";

const onePixelPngBase64 = "iVBORw0KGgo=";
const onePixelPngBytes = Buffer.from(onePixelPngBase64, "base64");
const onePixelPngSha = createHash("sha256").update(onePixelPngBytes).digest("hex");

test("attachment refs: extracts content-addressed image metadata without raw bytes", () => {
  const refs = extractAttachmentRefsFromMessageBody({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: onePixelPngBase64,
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(refs, [
    {
      kind: "image",
      ref: `sha256:${onePixelPngSha}`,
      sha256: onePixelPngSha,
      media_type: "image/png",
      size_bytes: onePixelPngBytes.byteLength,
    },
  ]);
  assert.equal(JSON.stringify(refs).includes(onePixelPngBase64), false);
});

test("attachment refs: rejects unsupported media, malformed base64, and oversize images", () => {
  assert.deepEqual(
    extractAttachmentRefsFromMessageBody({
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "text/plain", data: onePixelPngBase64 } }] }],
    }),
    [],
  );
  assert.deepEqual(
    extractAttachmentRefsFromMessageBody({
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "../not-base64" } }] }],
    }),
    [],
  );
  const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");
  assert.deepEqual(
    extractAttachmentRefsFromMessageBody({
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: huge } }] }],
    }),
    [],
  );
});

test("attachment sidecar guard enforces ref shape and bounds", () => {
  assert.equal(isAttachmentSidecar({
    "ui-msg-1": [{
      kind: "image",
      ref: `sha256:${onePixelPngSha}`,
      sha256: onePixelPngSha,
      media_type: "image/png",
      size_bytes: onePixelPngBytes.byteLength,
    }],
  }), true);

  assert.equal(isAttachmentSidecar({ "../escape": [{ kind: "image", ref: "file:///tmp/x", sha256: onePixelPngSha, media_type: "image/png", size_bytes: 1 }] }), false);
  assert.equal(isAttachmentSidecar({ "ui-msg-1": [{ kind: "image", ref: `sha256:${onePixelPngSha}`, sha256: onePixelPngSha, media_type: "image/png", size_bytes: MAX_ATTACHMENT_BYTES + 1 }] }), false);
});

test("projection: rehydrates refs on client read while keeping content text-only", () => {
  const local = {
    id: "ui-msg-1",
    role: "user",
    parts: [
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: onePixelPngBase64 },
      },
    ],
    metadata: { created_at: "2026-01-01T00:00:01.000Z" },
  } as unknown as LocalMessage;
  const sidecar: AttachmentSidecar = {
    "ui-msg-1": [{
      kind: "image",
      ref: `sha256:${onePixelPngSha}`,
      sha256: onePixelPngSha,
      media_type: "image/png",
      size_bytes: onePixelPngBytes.byteLength,
    }],
  };

  const [projected] = localMessageToConversationMessages(local, { attachmentsByMessageId: sidecar });

  assert.equal(projected?.message_type, "user_message");
  assert.equal(projected?.content, "look");
  assert.equal(JSON.stringify(projected).includes(onePixelPngBase64), false);
  assert.deepEqual((projected as { attachments?: unknown }).attachments, sidecar["ui-msg-1"]);
});

test("projection: text-only messages are unchanged", () => {
  const local = {
    id: "ui-msg-text",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
    metadata: { created_at: "2026-01-01T00:00:01.000Z" },
  } as unknown as LocalMessage;

  const [projected] = localMessageToConversationMessages(local);

  assert.equal(projected?.message_type, "user_message");
  assert.equal(projected?.content, "hello");
  assert.equal("attachments" in (projected as unknown as Record<string, unknown>), false);
});
