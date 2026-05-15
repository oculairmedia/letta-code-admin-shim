/**
 * Read-only access to letta-code's LocalBackend on-disk state.
 *
 * Encodes path segments the way LocalStore does (base64url of the key) so
 * we read exactly what letta-code writes.
 *
 * This module is the *primary consumer* of `LocalMessage` (the on-disk
 * record format defined in `./types/letta-stream.js`). Agent and
 * conversation records live on disk in shapes that DO NOT perfectly match
 * the outbound wire types — see the `OnDiskAgentRecord` and
 * `OnDiskConversation` interfaces below for the divergence.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync as _writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Atomic JSON write: write to a tmp sibling, fsync (via writeFile O_SYNC
 * default semantics on Linux), then rename over the target. POSIX rename is
 * atomic on the same filesystem, so readers either see the old bytes or the
 * new bytes — never a torn JSON file. Cleans up the tmp on partial failure.
 *
 * Fixes lcp-ayo. Previously these sidecars used a bare writeFileSync which
 * leaves a truncated file on crash; readJsonOrNull silently treats that as
 * empty, losing every otid / timestamp mapping for the conversation.
 */
function atomicWriteJson(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const payload = JSON.stringify(value, null, 2) + "\n";
  try {
    _writeFileSync(tmp, payload);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

import type { Block } from "./types/wire.js";
import type { LocalMessage } from "./types/letta-stream.js";

// ──────────────────────────────────────────────────────────────────────
// On-disk shapes (NOT identical to wire types — see translate.mjs)
// ──────────────────────────────────────────────────────────────────────

/**
 * Agent record as letta-code writes it under
 * `<storageDir>/agents/<b64url(agentId)>.json`. The shim then attaches
 * synthetic `_mtimeMs` / `_ctimeMs` fields (read from `statSync`) before
 * returning to callers — those drive `created_at` / `updated_at` in the
 * wire `Agent` shape (see translate.mjs `agentToLettaState`).
 *
 * The disk shape is a permissive subset of the wire `Agent`: required
 * wire fields like `agent_type`, `last_run_completion`, `timezone`, etc.
 * are NOT on disk — translate.mjs fills them in. We type only the keys
 * store.ts actually reads or forwards, leaving the rest as `unknown`-ish
 * via `[k: string]: unknown` so downstream spread copies survive.
 *
 * NOTE: disk `model_settings.provider_type` carries lmstudio/openai/etc;
 * translate.mjs maps "lmstudio" → "openai" for `model_endpoint_type`.
 */
export interface OnDiskAgentRecord {
  id: string;
  name?: string;
  description?: string | null;
  system?: string;
  tags?: string[];
  model?: string;
  model_settings?: Record<string, unknown>;
  compaction_settings?: Record<string, unknown> | null;
  /** Attached by store.ts after stat. Real on-disk fs mtime in ms. */
  _mtimeMs: number;
  /** Attached by store.ts after stat. Real on-disk fs ctime in ms. */
  _ctimeMs: number;
  [k: string]: unknown;
}

/**
 * Conversation record as letta-code writes it under
 * `<storageDir>/conversations/<b64url(key)>/conversation.json`.
 *
 * Diverges from the wire `Conversation` (lib/types/wire.ts):
 *   - On disk, the per-agent default thread is stored with bare
 *     `id: "default"`. The wire shape rewrites it to
 *     `conv-default-${agent_id}` via `translate.externalConversationId`.
 *   - On disk lacks `created_by_id` / `last_updated_by_id` —
 *     translate.mjs fills them with a canned user uuid.
 *   - `in_context_message_ids` may be absent; translate defaults to [].
 *   - On disk lacks `isolated_block_ids` / `model` / `model_settings` —
 *     translate emits [] / null / null.
 *
 * Only the keys store.ts actually reads or forwards are explicit.
 */
export interface OnDiskConversation {
  id: string;
  agent_id: string;
  created_at?: string | null | undefined;
  updated_at?: string | null | undefined;
  last_message_at?: string | null | undefined;
  summary?: string | null | undefined;
  in_context_message_ids?: string[] | undefined;
  [k: string]: unknown;
}

/**
 * Sidecar map: LocalMessage id → real ISO timestamp string.
 * Lives at `<convDir>/_real-times.json`. See `stampNewMessages`.
 */
export type TimestampSidecar = Record<string, string>;

/**
 * Sidecar map: LocalMessage id → mobile-supplied otid string.
 * Lives at `<convDir>/_otid-map.json`. See `writeOtidForLocalId`.
 */
export type OtidSidecar = Record<string, string>;

/** Pair returned by `resolveConversationId` — the LocalStore-internal key. */
export interface ResolvedConversation {
  conversationId: string;
  agentId: string;
}

/** Options for `listMessages`. */
export interface ListMessagesOptions {
  limit?: number | undefined;
  before?: string | undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers (NOT exported — base64url stays module-private; the
// _internals export below is the only test/debug surface).
// ──────────────────────────────────────────────────────────────────────

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function b64urlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function storageDir(): string {
  return (
    process.env["LETTA_LOCAL_BACKEND_DIR"] ||
    join(process.env["LETTA_HOME"] || join(homedir(), ".letta"), "lc-local-backend")
  );
}

function readJsonOrNull(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readJsonlOrEmpty(path: string): unknown[] {
  try {
    const raw = readFileSync(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

// ── Type guards ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentRecordCandidate(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value["id"] === "string" && (value["id"] as string).length > 0;
}

function isConversationOnDisk(value: unknown): value is OnDiskConversation {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["agent_id"] === "string"
  );
}

function isLocalMessage(value: unknown): value is LocalMessage {
  if (!isRecord(value)) return false;
  if (typeof value["id"] !== "string") return false;
  if (typeof value["role"] !== "string") return false;
  if (!Array.isArray(value["parts"])) return false;
  return true;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  for (const v of Object.values(value)) {
    if (typeof v !== "string") return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────

export function listAgents(): OnDiskAgentRecord[] {
  const root = join(storageDir(), "agents");
  if (!existsSync(root)) return [];
  const out: OnDiskAgentRecord[] = [];
  for (const fname of readdirSync(root)) {
    if (!fname.endsWith(".json")) continue;
    const record = readJsonOrNull(join(root, fname));
    if (!isAgentRecordCandidate(record)) continue;
    const stat = statSync(join(root, fname));
    out.push({ ...record, _mtimeMs: stat.mtimeMs, _ctimeMs: stat.ctimeMs } as OnDiskAgentRecord);
  }
  out.sort((a, b) => (b._mtimeMs ?? 0) - (a._mtimeMs ?? 0));
  return out;
}

export function getAgentRecord(agentId: string): OnDiskAgentRecord | null {
  const path = join(storageDir(), "agents", `${b64url(agentId)}.json`);
  const stat = (() => {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  })();
  const r = readJsonOrNull(path);
  if (!isAgentRecordCandidate(r)) return null;
  return {
    ...r,
    _mtimeMs: stat?.mtimeMs ?? Date.now(),
    _ctimeMs: stat?.ctimeMs ?? Date.now(),
  } as OnDiskAgentRecord;
}

function conversationKey(conversationId: string, agentId: string): string {
  return conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
}

export function listConversationsForAgent(agentId: string): OnDiskConversation[] {
  const root = join(storageDir(), "conversations");
  if (!existsSync(root)) return [];
  const out: OnDiskConversation[] = [];
  for (const dirName of readdirSync(root)) {
    let key: string;
    try {
      key = b64urlDecode(dirName);
    } catch {
      continue;
    }
    if (
      key !== `default:${agentId}` &&
      !key.startsWith(`conversation:`)
    )
      continue;
    const conv = readJsonOrNull(join(root, dirName, "conversation.json"));
    if (!isConversationOnDisk(conv) || conv.agent_id !== agentId) continue;
    out.push(conv);
  }
  return out;
}

export function listAllConversations(): OnDiskConversation[] {
  const root = join(storageDir(), "conversations");
  if (!existsSync(root)) return [];
  const out: OnDiskConversation[] = [];
  for (const dirName of readdirSync(root)) {
    const conv = readJsonOrNull(join(root, dirName, "conversation.json"));
    if (!isConversationOnDisk(conv)) continue;
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
export function resolveConversationId(externalId: string | null | undefined): ResolvedConversation | null {
  if (!externalId) return null;
  if (externalId === "default") return null;
  const defaultMatch = externalId.match(/^conv-default-(agent-.+)$/);
  if (defaultMatch) return { conversationId: "default", agentId: defaultMatch[1]! };
  // Otherwise scan disk for a matching conv-* id.
  for (const conv of listAllConversations()) {
    if (conv.id === externalId) {
      return { conversationId: conv.id, agentId: conv.agent_id };
    }
  }
  return null;
}

export function getConversation(externalId: string, agentIdHint?: string | null): OnDiskConversation | null {
  // Fast path: caller passed agentIdHint AND a real internal id.
  if (agentIdHint) {
    const key = conversationKey(externalId, agentIdHint);
    const dir = join(storageDir(), "conversations", b64url(key));
    const conv = readJsonOrNull(join(dir, "conversation.json"));
    if (isConversationOnDisk(conv)) return conv;
  }
  // Mobile's external id may be `conv-default-{agentId}` → translate.
  const resolved = resolveConversationId(externalId);
  if (!resolved) return null;
  const key = conversationKey(resolved.conversationId, resolved.agentId);
  const dir = join(storageDir(), "conversations", b64url(key));
  const conv = readJsonOrNull(join(dir, "conversation.json"));
  return isConversationOnDisk(conv) ? conv : null;
}

export function getAgentIdForConversation(externalId: string): string | null {
  return resolveConversationId(externalId)?.agentId ?? null;
}

export function listMessages(
  conversationId: string,
  agentId: string,
  { limit, before }: ListMessagesOptions = {},
): LocalMessage[] {
  const key = conversationKey(conversationId, agentId);
  const dir = join(storageDir(), "conversations", b64url(key));
  const items = readJsonlOrEmpty(join(dir, "messages.jsonl"));
  let scoped: LocalMessage[] = items.filter(isLocalMessage);
  if (before) {
    const idx = scoped.findIndex((m) => m.id === before);
    if (idx >= 0) scoped = scoped.slice(0, idx);
  }
  if (limit && limit > 0) scoped = scoped.slice(-limit);
  return scoped;
}

export function readSystemPrompt(conversationId: string, agentId: string): unknown {
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

function timestampSidecarPath(conversationId: string, agentId: string): string {
  const key = conversationKey(conversationId, agentId);
  return join(storageDir(), "conversations", b64url(key), "_real-times.json");
}

function otidSidecarPath(conversationId: string, agentId: string): string {
  const key = conversationKey(conversationId, agentId);
  return join(storageDir(), "conversations", b64url(key), "_otid-map.json");
}

export function readMessageTimestamps(conversationId: string, agentId: string): TimestampSidecar {
  const path = timestampSidecarPath(conversationId, agentId);
  const raw = readJsonOrNull(path);
  return isStringRecord(raw) ? raw : {};
}

// Mobile reconciles its optimistic Local user bubble against the server-issued
// Confirmed by matching `otid` (sent in the POST body's `messages[].otid`,
// then expected back on the user_message returned by GET /messages). letta-code
// has no concept of otid, so we maintain our own sidecar mapping LocalMessage
// `id` → mobile-supplied otid. The projection joins this on read so the
// user_message wire frame echoes the original otid, letting mobile collapse
// the Local-vs-Confirmed pair via its existing reconcileAfterSend flow.
export function readOtidMap(conversationId: string, agentId: string): OtidSidecar {
  const path = otidSidecarPath(conversationId, agentId);
  const raw = readJsonOrNull(path);
  return isStringRecord(raw) ? raw : {};
}

export function writeOtidForLocalId(
  conversationId: string,
  agentId: string,
  localId: string | null | undefined,
  otid: string | null | undefined,
): void {
  if (!localId || !otid) return;
  const path = otidSidecarPath(conversationId, agentId);
  const raw = readJsonOrNull(path);
  const current: OtidSidecar = isStringRecord(raw) ? raw : {};
  if (current[localId] === otid) return;
  current[localId] = otid;
  try {
    atomicWriteJson(path, current);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[store] otid sidecar write failed for ${conversationId}: ${msg}`);
  }
}

/**
 * Find the most-recently-added user-role LocalMessage in messages.jsonl
 * whose id ISN'T already mapped. Used immediately after a turn to bind the
 * mobile-supplied otid to the user message letta-code just persisted.
 *
 * Returns the localId or null if none found.
 */
export function findUnmappedTailUserMessageId(conversationId: string, agentId: string): string | null {
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
export function stampNewMessages(
  conversationId: string,
  agentId: string,
  startTime: Date = new Date(),
): void {
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
      atomicWriteJson(path, current);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[store] stamp sidecar write failed for ${conversationId}: ${msg}`);
    }
  }
}

export function readBlocksForAgent(agentId: string): Block[] {
  // LocalBackend doesn't store blocks separately — they're files under
  // memfs/<agent>/memory/system/*.md. Each file = one block. Shape MUST
  // match vanilla Letta server's Block schema exactly.
  const memSysDir = join(storageDir(), "memfs", agentId, "memory", "system");
  if (!existsSync(memSysDir)) return [];
  const out: Block[] = [];
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

// ──────────────────────────────────────────────────────────────────────
// _internals — test/debug hook. Frozen to make the contract explicit.
// Keys preserved verbatim from the previous .mjs implementation.
// ──────────────────────────────────────────────────────────────────────

/**
 * Test/debug hook. Type captures the exact signature of each helper so the
 * callers (and any test that inspects this) get strict typing. Frozen so
 * accidental writes throw under strict mode.
 *
 * Note: keeping `b64url` exposed here is the ONLY way it leaves the module —
 * the helper stays internal per HANDOFF.md ("base64url path-encoding helper
 * stays internal"). server.mjs uses `_internals.b64url` rather than a
 * top-level export so the contract is explicit and inspectable.
 */
export interface StoreInternals {
  readonly b64url: (value: string) => string;
  readonly b64urlDecode: (value: string) => string;
  readonly storageDir: () => string;
}

export const _internals: StoreInternals = Object.freeze({
  b64url,
  b64urlDecode,
  storageDir,
});
