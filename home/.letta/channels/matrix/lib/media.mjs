/**
 * Media handling — download attachments from Matrix to a local cache and
 * return a ChannelMessageAttachment-shaped record for letta-code.
 *
 * For images, optionally embed a base64 thumbnail so vision-capable models
 * can see the image without us having to upload it elsewhere. Size budget
 * mirrors matrix-tuwunel-deploy's agent_media.MAX_RAW_BYTES (650 KiB pre-b64)
 * to stay well under common WS / context limits.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const IMAGE_MIME_PREFIX = "image/";
const AUDIO_MIME_PREFIX = "audio/";
const VIDEO_MIME_PREFIX = "video/";
const MAX_IMAGE_BASE64_RAW_BYTES = 650 * 1024;

function mediaCacheRoot() {
  const root = process.env.LETTA_HOME || join(homedir(), ".letta");
  return join(root, "channels", "matrix", "media-cache");
}

function extFromMime(mime) {
  if (!mime) return "";
  const cleaned = mime.split(";", 1)[0].trim();
  switch (cleaned) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "audio/ogg": return ".ogg";
    case "audio/mpeg": return ".mp3";
    case "audio/mp4": return ".m4a";
    case "audio/wav": case "audio/x-wav": return ".wav";
    case "video/mp4": return ".mp4";
    case "video/webm": return ".webm";
    case "application/pdf": return ".pdf";
    case "text/plain": return ".txt";
    case "text/markdown": return ".md";
    case "application/json": return ".json";
    default: return "";
  }
}

function kindForMime(mime, msgtype) {
  if (typeof mime === "string") {
    if (mime.startsWith(IMAGE_MIME_PREFIX)) return "image";
    if (mime.startsWith(AUDIO_MIME_PREFIX)) return "audio";
    if (mime.startsWith(VIDEO_MIME_PREFIX)) return "video";
  }
  if (msgtype === "m.image") return "image";
  if (msgtype === "m.audio") return "audio";
  if (msgtype === "m.video") return "video";
  return "file";
}

function safeFilename(name, fallbackExt) {
  if (name && /^[\w.\- ()]+$/.test(name)) return name;
  const ext = extname(name || "") || fallbackExt || ".bin";
  return `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

export async function downloadAttachment({ client, event, accountId, logger = console }) {
  const content = event?.content ?? {};
  const msgtype = content.msgtype;
  if (!msgtype || !["m.image", "m.audio", "m.video", "m.file"].includes(msgtype)) {
    return null;
  }
  const mxcUri = content.url || content?.file?.url;
  if (!mxcUri || !mxcUri.startsWith("mxc://")) {
    logger.warn?.(`[matrix:${accountId}] attachment without mxc url, skipping`);
    return null;
  }
  const info = content.info ?? {};
  const mime = info.mimetype || content.mimetype || "";
  const declaredName = content.body || "";
  const filename = safeFilename(declaredName, extFromMime(mime));

  let buf;
  let contentType = mime;
  try {
    const dl = await client.downloadMedia({ mxcUri });
    buf = dl.buf;
    contentType = dl.contentType || mime || "application/octet-stream";
  } catch (err) {
    logger.warn?.(
      `[matrix:${accountId}] failed to download ${mxcUri}: ${err.message}`,
    );
    return null;
  }

  const cacheDir = join(mediaCacheRoot(), accountId);
  mkdirSync(cacheDir, { recursive: true });
  const localPath = join(cacheDir, `${event.event_id || `evt-${Date.now()}`}-${filename}`);
  try {
    writeFileSync(localPath, buf);
  } catch (err) {
    logger.warn?.(
      `[matrix:${accountId}] failed to write ${localPath}: ${err.message}`,
    );
    return null;
  }

  const kind = kindForMime(contentType, msgtype);
  const attachment = {
    name: filename,
    mimeType: contentType,
    sizeBytes: buf.length,
    kind,
    localPath,
  };
  if (kind === "image" && buf.length <= MAX_IMAGE_BASE64_RAW_BYTES) {
    attachment.imageDataBase64 = buf.toString("base64");
  }
  return attachment;
}
