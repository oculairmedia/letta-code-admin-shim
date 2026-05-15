#!/usr/bin/env node
// One-shot backfill for lcp-pwz.
//
// For each conversation directory under <storageDir>/conversations/, read
// _real-times.json (the per-message timestamp sidecar). Take its max value
// and write it to conversation.json as last_message_at + updated_at when
// strictly later than what's already on disk.
//
// Usage:
//   LETTA_LOCAL_BACKEND_DIR=/opt/stacks/letta-code-parallel/migrator/out \
//     node admin-shim/scripts/backfill-last-message-at.mjs
//
// Idempotent: re-running after no new messages have arrived is a no-op.

import { readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const storageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
if (!storageDir) {
  console.error("LETTA_LOCAL_BACKEND_DIR is required");
  process.exit(2);
}

const convRoot = join(storageDir, "conversations");
if (!existsSync(convRoot)) {
  console.error(`no conversations dir at ${convRoot}`);
  process.exit(2);
}

async function readJsonOrNull(path) {
  try {
    const txt = await readFile(path, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

let scanned = 0;
let updated = 0;
let skippedNoSidecar = 0;
let skippedAlreadyCurrent = 0;

const dirs = await readdir(convRoot);
for (const dirName of dirs) {
  const convDir = join(convRoot, dirName);
  const convFile = join(convDir, "conversation.json");
  const sidecarFile = join(convDir, "_real-times.json");
  const conv = await readJsonOrNull(convFile);
  if (!conv) continue;
  scanned += 1;
  const sidecar = await readJsonOrNull(sidecarFile);
  if (!sidecar || typeof sidecar !== "object") {
    skippedNoSidecar += 1;
    continue;
  }
  let maxIso = "";
  for (const v of Object.values(sidecar)) {
    if (typeof v === "string" && v > maxIso) maxIso = v;
  }
  if (!maxIso) {
    skippedNoSidecar += 1;
    continue;
  }
  const currentLast = typeof conv.last_message_at === "string" ? conv.last_message_at : "";
  if (currentLast >= maxIso) {
    skippedAlreadyCurrent += 1;
    continue;
  }
  conv.last_message_at = maxIso;
  conv.updated_at = maxIso;
  await atomicWriteJson(convFile, conv);
  updated += 1;
  console.log(`bumped ${conv.id ?? dirName}: ${currentLast || "<unset>"} -> ${maxIso}`);
}

console.log(`\nscanned=${scanned} updated=${updated} skipped_no_sidecar=${skippedNoSidecar} skipped_current=${skippedAlreadyCurrent}`);
