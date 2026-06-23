import { createHash } from "node:crypto";

import type { LettaMessage } from "./types/wire.js";

export const MAX_ATTACHMENT_BYTES = Number(process.env["SHIM_ATTACHMENT_MAX_BYTES"] ?? 10 * 1024 * 1024);

const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface AttachmentRef {
  kind: "image";
  ref: string;
  sha256: string;
  media_type: string;
  size_bytes: number;
}

export type AttachmentSidecar = Record<string, AttachmentRef[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Length(data: string): number | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  try {
    return Buffer.byteLength(Buffer.from(data, "base64"));
  } catch {
    return null;
  }
}

function imageRefFromSource(source: unknown): AttachmentRef | null {
  if (!isRecord(source)) return null;
  if (source["type"] !== "base64") return null;
  const mediaType = source["media_type"];
  const data = source["data"];
  if (typeof mediaType !== "string" || !ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)) return null;
  if (typeof data !== "string" || data.length === 0) return null;
  const sizeBytes = decodeBase64Length(data);
  if (sizeBytes === null || sizeBytes <= 0 || sizeBytes > MAX_ATTACHMENT_BYTES) return null;
  const bytes = Buffer.from(data, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    kind: "image",
    ref: `sha256:${sha256}`,
    sha256,
    media_type: mediaType,
    size_bytes: sizeBytes,
  };
}

function collectRefsFromContent(content: unknown, refs: AttachmentRef[]): void {
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = part["type"];
    if (type !== "image" && type !== "input_image") continue;
    const ref = imageRefFromSource(part["source"]);
    if (ref) refs.push(ref);
  }
}

export function extractAttachmentRefsFromMessageBody(body: unknown): AttachmentRef[] {
  if (!isRecord(body)) return [];
  const refs: AttachmentRef[] = [];
  const messages = body["messages"] ?? body["message"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (isRecord(message)) collectRefsFromContent(message["content"], refs);
    }
  }
  collectRefsFromContent(body["content"], refs);

  const deduped = new Map<string, AttachmentRef>();
  for (const ref of refs) deduped.set(`${ref.ref}|${ref.media_type}|${ref.size_bytes}`, ref);
  return [...deduped.values()];
}

export function isAttachmentSidecar(value: unknown): value is AttachmentSidecar {
  if (!isRecord(value)) return false;
  for (const refs of Object.values(value)) {
    if (!Array.isArray(refs)) return false;
    for (const ref of refs) {
      if (!isRecord(ref)) return false;
      if (ref["kind"] !== "image") return false;
      if (typeof ref["ref"] !== "string" || !ref["ref"].startsWith("sha256:")) return false;
      if (typeof ref["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(ref["sha256"])) return false;
      if (typeof ref["media_type"] !== "string" || !ALLOWED_IMAGE_MEDIA_TYPES.has(ref["media_type"])) return false;
      if (typeof ref["size_bytes"] !== "number" || !Number.isFinite(ref["size_bytes"])) return false;
      if (ref["size_bytes"] <= 0 || ref["size_bytes"] > MAX_ATTACHMENT_BYTES) return false;
    }
  }
  return true;
}

export function attachRefsToWireMessage<T extends LettaMessage>(message: T, refs: readonly AttachmentRef[] | null | undefined): T {
  if (!refs || refs.length === 0) return message;
  if (message.message_type !== "user_message") return message;
  return { ...message, attachments: refs } as T;
}
