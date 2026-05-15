/**
 * Read-only access to letta-code's LocalBackend on-disk state.
 *
 * Encodes path segments the way LocalStore does (base64url of the key) so
 * we read exactly what letta-code writes.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync as _writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}
function b64urlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function storageDir() {
  return (
    process.env.LETTA_LOCAL_BACKEND_DIR ||
    join(process.env.LETTA_HOME || join(homedir(), ".letta"), "lc-local-backend")
  );
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readJsonlOrEmpty(path) {
  try {
    const raw = readFileSync(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function listAgents() {
  const root = join(storageDir(), "agents");
  if (!existsSync(root)) return [];
  const out = [];
  for (const fname of readdirSync(root)) {
    if (!fname.endsWith(".json")) continue;
    const record = readJsonOrNull(join(root, fname));
    if (!record?.id) continue;
    const stat = statSync(join(root, fname));
    out.push({ ...record, _mtimeMs: stat.mtimeMs, _ctimeMs: stat.ctimeMs });
  }
  out.sort((a, b) => (b._mtimeMs ?? 0) - (a._mtimeMs ?? 0));
  return out;
}

export function getAgentRecord(agentId) {
  const path = join(storageDir(), "agents", `${b64url(agentId)}.json`);
  const stat = (() => { try { return statSync(path); } catch { return null; } })();
  const r = readJsonOrNull(path);
  if (!r) return null;
  return { ...r, _mtimeMs: stat?.mtimeMs ?? Date.now(), _ctimeMs: stat?.ctimeMs ?? Date.now() };
}

function conversationKey(conversationId, agentId) {
  return conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
}

export function listConversationsForAgent(agentId) {
  const root = join(storageDir(), "conversations");
  if (!existsSync(root)) return [];
  const out = [];
  for (const dirName of readdirSync(root)) {
    let key;
    try { key = b64urlDecode(dirName); } catch { continue; }
    if (
      key !== `default:${agentId}` &&
      !key.startsWith(`conversation:`)
    ) continue;
    const conv = readJsonOrNull(join(root, dirName, "conversation.json"));
    if (!conv || conv.agent_id !== agentId) continue;
    out.push(conv);
  }
  return out;
}

export function listAllConversations() {
  const root = join(storageDir(), "conversations");
  if (!existsSync(root)) return [];
  const out = [];
  for (const dirName of readdirSync(root)) {
    const conv = readJsonOrNull(join(root, dirName, "conversation.json"));
    if (!conv?.id || !conv?.agent_id) continue;
    out.push(conv);
  }
  return out;
}

/**
 * Resolve a shim-external conv id like `conv-default-agent-foo` (or a real
 * `conv-...` id) into the LocalStore-internal pair (conversationId, agentId).
 *
 * Refuses to resolve the bare literal `"default"`. Every agent has its own
 * default conv, so the id alone is ambiguous — disk-scanning for "default"
 * silently routes to the first agent we find, which mis-targets the wrong
 * agent on any multi-agent backend. Callers that need to address an
 * agent's default conv MUST use the external `conv-default-<agentId>`
 * form (the conversation list endpoint synthesizes this), or supply the
 * agent context out-of-band (e.g. `/v1/agents/{id}/...` routes).
 */
export function resolveConversationId(externalId) {
  if (!externalId) return null;
  if (externalId === "default") return null;
  const defaultMatch = externalId.match(/^conv-default-(agent-.+)$/);
  if (defaultMatch) return { conversationId: "default", agentId: defaultMatch[1] };
  // Otherwise scan disk for a matching conv-* id.
  for (const conv of listAllConversations()) {
    if (conv.id === externalId) {
      return { conversationId: conv.id, agentId: conv.agent_id };
    }
  }
  return null;
}

export function getConversation(externalId, agentIdHint) {
  // Fast path: caller passed agentIdHint AND a real internal id.
  if (agentIdHint) {
    const key = conversationKey(externalId, agentIdHint);
    const dir = join(storageDir(), "conversations", b64url(key));
    const conv = readJsonOrNull(join(dir, "conversation.json"));
    if (conv) return conv;
  }
  // Mobile's external id may be `conv-default-{agentId}` → translate.
  const resolved = resolveConversationId(externalId);
  if (!resolved) return null;
  const key = conversationKey(resolved.conversationId, resolved.agentId);
  const dir = join(storageDir(), "conversations", b64url(key));
  return readJsonOrNull(join(dir, "conversation.json"));
}

export function getAgentIdForConversation(externalId) {
  return resolveConversationId(externalId)?.agentId ?? null;
}

export function listMessages(conversationId, agentId, { limit, before } = {}) {
  const key = conversationKey(conversationId, agentId);
  const dir = join(storageDir(), "conversations", b64url(key));
  const items = readJsonlOrEmpty(join(dir, "messages.jsonl"));
  let scoped = items;
  if (before) {
    const idx = scoped.findIndex((m) => m.id === before);
    if (idx >= 0) scoped = scoped.slice(0, idx);
  }
  if (limit && limit > 0) scoped = scoped.slice(-limit);
  return scoped;
}

export function readSystemPrompt(conversationId, agentId) {
  const key = conversationKey(conversationId, agentId);
  const dir = join(storageDir(), "conversations", b64url(key));
  return readJsonOrNull(join(dir, "system-prompt.json"));
}

// ── Real-timestamp sidecar ────────────────────────────────────────
//
// letta-code's LocalStore writes messages with sentinel `metadata.created_at`
// dates (`2026-01-01T00:00:<seqIndex+1>.000Z`) that encode source-message
// order, not real wall-clock time. Mobile and other date-sorting clients
// bucket those into Jan 1 2026 — duplicating recently-streamed messages
// against their disk-persisted twins.
//
// We maintain a per-conversation sidecar `_real-times.json` mapping
// LocalMessage `id` → real ISO timestamp. The pool calls `stampNewMessages`
// after every turn to record real times for any newly-written messages.
// On read, the projection joins this map and substitutes the sentinel.

function timestampSidecarPath(conversationId, agentId) {
  const key = conversationKey(conversationId, agentId);
  return join(storageDir(), "conversations", b64url(key), "_real-times.json");
}

function otidSidecarPath(conversationId, agentId) {
  const key = conversationKey(conversationId, agentId);
  return join(storageDir(), "conversations", b64url(key), "_otid-map.json");
}

export function readMessageTimestamps(conversationId, agentId) {
  const path = timestampSidecarPath(conversationId, agentId);
  return readJsonOrNull(path) ?? {};
}

// Mobile reconciles its optimistic Local user bubble against the server-issued
// Confirmed by matching `otid` (sent in the POST body's `messages[].otid`,
// then expected back on the user_message returned by GET /messages). letta-code
// has no concept of otid, so we maintain our own sidecar mapping LocalMessage
// `id` → mobile-supplied otid. The projection joins this on read so the
// user_message wire frame echoes the original otid, letting mobile collapse
// the Local-vs-Confirmed pair via its existing reconcileAfterSend flow.
export function readOtidMap(conversationId, agentId) {
  const path = otidSidecarPath(conversationId, agentId);
  return readJsonOrNull(path) ?? {};
}

export function writeOtidForLocalId(conversationId, agentId, localId, otid) {
  if (!localId || !otid) return;
  const path = otidSidecarPath(conversationId, agentId);
  const current = readJsonOrNull(path) ?? {};
  if (current[localId] === otid) return;
  current[localId] = otid;
  try {
    mkdirSync(dirname(path), { recursive: true });
    _writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
  } catch (err) {
    console.error(`[store] otid sidecar write failed for ${conversationId}: ${err.message}`);
  }
}

/**
 * Find the most-recently-added user-role LocalMessage in messages.jsonl
 * whose id ISN'T already mapped. Used immediately after a turn to bind the
 * mobile-supplied otid to the user message letta-code just persisted.
 *
 * Returns the localId or null if none found.
 */
export function findUnmappedTailUserMessageId(conversationId, agentId) {
  const messages = listMessages(conversationId, agentId);
  const map = readOtidMap(conversationId, agentId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && m?.id && !map[m.id]) return m.id;
  }
  return null;
}

/**
 * Scan the conv's messages.jsonl, find any whose id isn't in the sidecar,
 * stamp them with timestamps starting at `startTime` and rising by 1ms per
 * message so the on-disk order is preserved when clients sort by `date`.
 *
 * Stamping every new message with the same end-of-turn `now` would push the
 * user's prompt AFTER the streamed assistant reply (which carries letta-code's
 * earlier real frame timestamp) — mobile then renders the prompt below the
 * response, looking like a new turn started mid-render. The 1ms stagger keeps
 * the user message first, the agent's tool_call/tool_return next, and the
 * assistant reply last, matching the stream frame order naturally.
 *
 * Idempotent — already-stamped messages keep their original real timestamp.
 * Safe to call after every turn.
 */
export function stampNewMessages(conversationId, agentId, startTime = new Date()) {
  const messages = listMessages(conversationId, agentId);
  if (messages.length === 0) return;
  const current = readMessageTimestamps(conversationId, agentId);
  let dirty = false;
  let offset = 0;
  const baseMs = startTime.getTime();
  for (const m of messages) {
    if (m?.id && !current[m.id]) {
      current[m.id] = new Date(baseMs + offset).toISOString();
      offset += 1;
      dirty = true;
    }
  }
  if (dirty) {
    const path = timestampSidecarPath(conversationId, agentId);
    try {
      mkdirSync(dirname(path), { recursive: true });
      _writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
    } catch (err) {
      console.error(`[store] stamp sidecar write failed for ${conversationId}: ${err.message}`);
    }
  }
}

export function readBlocksForAgent(agentId) {
  // LocalBackend doesn't store blocks separately — they're files under
  // memfs/<agent>/memory/system/*.md. Each file = one block. Shape MUST
  // match vanilla Letta server's Block schema exactly.
  const memSysDir = join(storageDir(), "memfs", agentId, "memory", "system");
  if (!existsSync(memSysDir)) return [];
  const out = [];
  for (const fname of readdirSync(memSysDir)) {
    if (!fname.endsWith(".md")) continue;
    const label = fname.replace(/\.md$/, "");
    const value = readFileSync(join(memSysDir, fname), "utf8");
    out.push({
      id: `block-${b64url(`${agentId}:${label}`).slice(0, 24)}`,
      label,
      value,
      description: null,
      metadata: null,
      limit: 5000,
      created_by_id: null,
      last_updated_by_id: null,
      is_template: false,
      template_name: null,
      preserve_on_migration: false,
      read_only: false,
      tags: [],
      hidden: null,
      project_id: null,
      template_id: null,
      base_template_id: null,
      deployment_id: null,
      entity_id: null,
    });
  }
  return out;
}

export const _internals = { b64url, b64urlDecode, storageDir };
