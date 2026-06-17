#!/usr/bin/env node
// @ts-nocheck — standalone ExecStartPre runtime utility (not part of the typed
// shim surface). It parses arbitrary on-disk JSON sidecars, so strict checkJs
// rules (index-signature env access, implicit-any JSON.parse results) add noise
// without value here. Behavior is covered by the script running on every boot.
// Self-heal guard (incident 2026-06-17): a disk-full / EDQUOT event truncated
// letta-code's non-atomic end-of-turn conversation.json rewrite to 0 bytes.
// The shim's REST layer skips conversations whose conversation.json is empty
// or unparseable (isConversationOnDisk requires id + agent_id), so the conv
// silently vanishes from the app's list even though messages.jsonl is intact.
//
// This script scans the local-backend conversations dir and rebuilds any
// empty/corrupt conversation.json from the intact sidecars (manifest.json +
// messages.jsonl + _otid-map.json), writing atomically (tmp + rename). It is
// idempotent and only touches files that fail to parse. Wired as the shim's
// systemd ExecStartPre so every start repairs damage from a prior crash.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const BACKEND_DIR = process.env.LETTA_LOCAL_BACKEND_DIR || join(process.env.HOME || "/root", ".letta/lc-local-backend");
const ROOT = join(BACKEND_DIR, "conversations");

function readJsonOrNull(path) {
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Dir name is base64url(key); key is "conversation:<convId>" or "default:<agentId>".
function decodeKey(dirName) {
  try {
    return Buffer.from(dirName.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function lastNonEmptyLine(path) {
  // messages.jsonl can be large (>100MB); read the tail rather than the whole file.
  const size = statSync(path).size;
  const chunk = Math.min(size, 64 * 1024);
  const fd = readFileSync(path);
  const tail = fd.subarray(fd.length - chunk).toString("utf8");
  const lines = tail.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

function scanForAgentIdAndDates(messagesPath) {
  // First line carries the conv id; entries carry agent_id + date. Read head
  // (for agent_id/created) and tail (for last_message_at) without loading all.
  let agentId = null, firstDate = null, lastDate = null;
  try {
    const buf = readFileSync(messagesPath);
    const head = buf.subarray(0, Math.min(buf.length, 256 * 1024)).toString("utf8");
    for (const line of head.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const m = JSON.parse(t);
        if (!agentId && typeof m.agent_id === "string") agentId = m.agent_id;
        const d = m.date || m.timestamp || m.created_at;
        if (d && !firstDate) firstDate = d;
        if (agentId && firstDate) break;
      } catch { /* skip partial */ }
    }
    const last = lastNonEmptyLine(messagesPath);
    if (last) {
      try {
        const m = JSON.parse(last);
        if (!agentId && typeof m.agent_id === "string") agentId = m.agent_id;
        lastDate = m.date || m.timestamp || m.created_at || null;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { agentId, firstDate, lastDate };
}

function latestUiMsgId(dir) {
  const map = readJsonOrNull(join(dir, "_otid-map.json"));
  if (!map) return null;
  let max = -1;
  for (const k of Object.keys(map)) {
    const n = k.startsWith("ui-msg-") ? Number(k.slice("ui-msg-".length)) : NaN;
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max >= 0 ? `ui-msg-${max}` : null;
}

function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(value, null, 4), "utf8");
  renameSync(tmp, path);
}

function main() {
  if (!existsSync(ROOT)) {
    console.log(`[heal-conversations] no conversations dir at ${ROOT}; nothing to do`);
    return;
  }
  let healed = 0, checked = 0, skipped = 0;
  for (const dirName of readdirSync(ROOT)) {
    const dir = join(ROOT, dirName);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const convPath = join(dir, "conversation.json");
    const messagesPath = join(dir, "messages.jsonl");
    checked++;

    const parsed = readJsonOrNull(convPath);
    const valid = parsed && typeof parsed.id === "string" && typeof parsed.agent_id === "string";
    if (valid) continue; // healthy — leave untouched

    if (!existsSync(messagesPath) || statSync(messagesPath).size === 0) {
      skipped++; // no source of truth to rebuild from
      continue;
    }

    const key = decodeKey(dirName);
    const convId = key.startsWith("conversation:") ? key.slice("conversation:".length) : null;
    const { agentId, firstDate, lastDate } = scanForAgentIdAndDates(messagesPath);
    if (!convId || !agentId) {
      console.warn(`[heal-conversations] cannot rebuild ${dirName}: convId=${convId} agentId=${agentId}`);
      skipped++;
      continue;
    }

    const manifest = readJsonOrNull(join(dir, "manifest.json")) || {};
    const created = manifest.created_at || firstDate || lastDate || new Date().toISOString();
    const last = lastDate || created;
    const anchor = latestUiMsgId(dir);

    const record = {
      id: convId,
      agent_id: agentId,
      archived: false,
      archived_at: null,
      created_at: created,
      updated_at: last,
      last_message_at: last,
      summary: null,
      in_context_message_ids: anchor ? [anchor] : [],
    };
    atomicWriteJson(convPath, record);
    healed++;
    console.log(`[heal-conversations] rebuilt ${convId} (agent=${agentId}, last_message_at=${last})`);
  }
  console.log(`[heal-conversations] done: checked=${checked} healed=${healed} skipped=${skipped}`);
}

main();
