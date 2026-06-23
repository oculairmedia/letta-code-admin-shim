import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractAttachmentRefsFromMessageBody,
  isAttachmentSidecar,
  MAX_ATTACHMENT_BYTES,
  type AttachmentSidecar,
} from "../lib/attachments.js";
import { localMessageToConversationMessages } from "../lib/translate.js";
import {
  readAttachmentMap,
  writeAttachmentsForLocalId,
} from "../lib/store.js";
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

// ──────────────────────────────────────────────────────────────────────
// End-to-end contract (lcp-67lp): send → persist (sidecar) → reload read.
// Exercises the REAL store sidecar (writeAttachmentsForLocalId /
// readAttachmentMap) plus the read projection, proving an image survives a
// full conversation reload even though the upstream Letta message is
// text-only and the disk LocalMessage's image bytes are dropped on read.
// ──────────────────────────────────────────────────────────────────────

async function withBackendDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "shim-attach-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("e2e: send→persist→reload rehydrates a stable image ref from text-only upstream", async () => {
  await withBackendDir(async () => {
    const conversationId = "conv-attach-e2e";
    const agentId = "agent-attach-e2e";
    const localId = "ui-msg-send-1";

    // 1. SEND: client submits text + image. The shim content-addresses the
    //    image part (sha256), enforces type/size bounds, and gets refs to
    //    persist BEFORE the image is stripped/forwarded to the model.
    const sendBody = {
      otid: "ui-msg-send-1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: onePixelPngBase64 },
            },
          ],
        },
      ],
    };
    const refs = extractAttachmentRefsFromMessageBody(sendBody);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.ref, `sha256:${onePixelPngSha}`);
    // The persisted ref envelope carries NO raw image bytes.
    assert.equal(JSON.stringify(refs).includes(onePixelPngBase64), false);

    // 2. PERSIST: bind refs to the LocalMessage id in the on-disk sidecar.
    await writeAttachmentsForLocalId(conversationId, agentId, localId, refs);

    // 3. RELOAD: a fresh read loads the sidecar from disk (simulate cold
    //    read by clearing the in-process cache via a distinct conv/agent is
    //    not needed — readAttachmentMap reads through to disk on first call
    //    of this process; here we just call it as the read path does).
    const sidecar = await readAttachmentMap(conversationId, agentId);
    assert.deepEqual(sidecar[localId], refs);

    // The upstream Letta server only persists a TEXT-ONLY message — model
    // never sees the image on reload, the disk LocalMessage here has been
    // collapsed to text. Build that text-only disk shape and project it.
    const diskMessage = {
      id: localId,
      role: "user",
      parts: [{ type: "text", text: "what is this?" }],
      metadata: { created_at: "2026-01-01T00:00:01.000Z" },
    } as unknown as LocalMessage;

    const [projected] = localMessageToConversationMessages(diskMessage, {
      attachmentsByMessageId: sidecar,
    });

    // The read returns the message WITH a stable attachment ref re-attached,
    // while content stays text-only and no raw bytes leak into the wire JSON.
    assert.equal(projected?.message_type, "user_message");
    assert.equal(projected?.content, "what is this?");
    assert.equal(JSON.stringify(projected).includes(onePixelPngBase64), false);
    assert.deepEqual((projected as { attachments?: unknown }).attachments, refs);

    // Stability: a SECOND reload yields the identical ref (content-addressed,
    // keyed by stable LocalMessage id).
    const sidecar2 = await readAttachmentMap(conversationId, agentId);
    assert.deepEqual(sidecar2[localId], refs);
  });
});

test("e2e: oversize/disallowed image parts persist no ref but do not throw", async () => {
  await withBackendDir(async () => {
    const conversationId = "conv-attach-reject";
    const agentId = "agent-attach-reject";
    const localId = "ui-msg-reject-1";

    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");
    const refs = extractAttachmentRefsFromMessageBody({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "too big" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: huge } },
            { type: "image", source: { type: "base64", media_type: "application/pdf", data: onePixelPngBase64 } },
          ],
        },
      ],
    });
    assert.deepEqual(refs, []);

    // writeAttachmentsForLocalId is a no-op on an empty ref array — the
    // sidecar stays absent so the read path emits a plain text message.
    await writeAttachmentsForLocalId(conversationId, agentId, localId, refs);
    const sidecar = await readAttachmentMap(conversationId, agentId);
    assert.equal(localId in sidecar, false);
  });
});
