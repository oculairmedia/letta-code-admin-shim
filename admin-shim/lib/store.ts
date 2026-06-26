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
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  appendFile as fsAppendFile,
  mkdir as fsMkdir,
  open as fsOpen,
  readFile as fsReadFile,
  readdir as fsReaddir,
  rename as fsRename,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
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
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await fsMkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const payload = JSON.stringify(value, null, 2) + "\n";
  try {
    await fsWriteFile(tmp, payload);
    await fsRename(tmp, path);
  } catch (err) {
    try {
      await fsUnlink(tmp);
    } catch (cleanupErr) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn(`[store] failed to remove temp json file ${tmp}: ${msg}`);
    }
    throw err;
  }
}

import type { Block } from "./types/wire.js";
import type { LocalMessage } from "./types/letta-stream.js";
import { isAttachmentSidecar, type AttachmentRef, type AttachmentSidecar } from "./attachments.js";

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

/**
 * Sidecar map: LocalMessage id → lightweight client attachment refs.
 * Lives at `<convDir>/_attachments.json`. It intentionally stores metadata
 * only; raw image bytes stay out of replay/context/prompt history.
 */
export type MessageAttachmentSidecar = AttachmentSidecar;

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

async function readJsonOrNullAsync(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fsReadFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * lcp-e5hb: single-pass JSONL parser. The previous implementation did
 * `split("\n").map(trim).filter(Boolean).map(JSON.parse)`, allocating two
 * throwaway arrays over every line of files that reach multiple MB / 1500+
 * lines on the hot read path. This walks the buffer once, slicing on
 * newlines and trimming via char codes without intermediate arrays.
 *
 * It also makes parsing per-line tolerant: a single malformed line (e.g. a
 * truncated final record from a crash mid-append — see turn-settlement's
 * appendJsonl) is skipped instead of throwing and discarding the ENTIRE
 * file's contents, which is what the old all-or-nothing try/catch did. That
 * matches the tolerance turn-settlement.ts already documented and assumed.
 */
function parseJsonl(raw: string): unknown[] {
  const out: unknown[] = [];
  const len = raw.length;
  let start = 0;
  while (start < len) {
    let end = raw.indexOf("\n", start);
    if (end === -1) end = len;
    // Trim leading/trailing whitespace (space, tab, CR) by char code so we
    // only allocate a substring for non-blank lines.
    let s = start;
    let e = end;
    while (s < e) {
      const c = raw.charCodeAt(s);
      if (c === 32 || c === 9 || c === 13) s += 1;
      else break;
    }
    while (e > s) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9 || c === 13) e -= 1;
      else break;
    }
    if (e > s) {
      try {
        out.push(JSON.parse(raw.slice(s, e)) as unknown);
      } catch {
        // Skip a single malformed line rather than dropping the whole file.
      }
    }
    start = end + 1;
  }
  return out;
}

// lcp-2oxb.4: readJsonlOrEmpty{,Async} retired — the messages loaders now
// read Buffers directly so byte offsets stay valid for the suffix cache.

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
  // Legacy on-disk format used `parts`; the post-pi-backup migration
  // (letta local-backend migrate-transcripts) renamed it to `content`
  // with an identical element shape. Accept either — normalizeMessage
  // below maps `content` -> `parts` so downstream translate.ts code
  // keeps reading `m.parts` without a schema-aware branch.
  if (!Array.isArray(value["parts"]) && !Array.isArray(value["content"])) return false;
  return true;
}

/**
 * lcp-nlud: letta-code's session-log v3 format wraps every message in an
 * envelope row — `{ type: "message", id, parentId, timestamp, message: {
 * id, role, content, metadata, ... } }` — and prefixes the file with a
 * `{ type: "session", version: 3, ... }` header row. The real LocalMessage
 * (role/content/metadata) lives under `.message`. Older transcripts store
 * the message flat at the top level. Unwrap the envelope here so both
 * shapes feed the same `isLocalMessage` filter and `content`->`parts`
 * mapping below.
 *
 * Without this, listMessages dropped every v3 record (no top-level `role`)
 * and a conversation with only synthetic settle tool-returns appended by
 * turn-settlement (which DOES write flat records) surfaced as nothing but
 * those settle frames — hiding the entire real history from mobile.
 *
 * The non-message header row (`type: "session"`) has no inner `message`,
 * so it falls through unchanged and `isLocalMessage` rejects it (no role),
 * exactly as before.
 */
function unwrapSessionEnvelope(value: unknown): unknown {
  if (isRecord(value) && value["type"] === "message" && isRecord(value["message"])) {
    return value["message"];
  }
  return value;
}

/**
 * Post-migration messages.jsonl uses `content` instead of `parts`. Mirror
 * the field onto `parts` so the rest of the shim (translate.ts, sidecar
 * stampers, etc.) doesn't need to know about the on-disk schema bump.
 * Idempotent: legacy records with `parts` already set pass through.
 */
function normalizeMessage(value: unknown): unknown {
  const unwrapped = unwrapSessionEnvelope(value);
  if (!isRecord(unwrapped)) return unwrapped;
  if (!Array.isArray(unwrapped["parts"]) && Array.isArray(unwrapped["content"])) {
    return { ...unwrapped, parts: unwrapped["content"] };
  }
  return unwrapped;
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

// lcp-5e5: dir-mtime cache of the agent list. Bump on add/remove of an
// agent json file (the typical case mobile cares about). Content-only
// updates to an existing agents/X.json file (e.g. settings tweak) won't
// invalidate, but those fields aren't load-bearing for the polling
// callers that hit this hot path.
const _listAgentsCached = makeDirMtimeCache(
  () => join(storageDir(), "agents"),
  async () => {
    const root = join(storageDir(), "agents");
    const out: OnDiskAgentRecord[] = [];
    if (!existsSync(root)) return out;
    for (const fname of await fsReaddir(root)) {
      if (!fname.endsWith(".json")) continue;
      const record = await readJsonOrNullAsync(join(root, fname));
      if (!isAgentRecordCandidate(record)) continue;
      const stat = await fsStat(join(root, fname));
      out.push({ ...record, _mtimeMs: stat.mtimeMs, _ctimeMs: stat.ctimeMs } as OnDiskAgentRecord);
    }
    out.sort((a, b) => (b._mtimeMs ?? 0) - (a._mtimeMs ?? 0));
    return out;
  },
);

export function listAgents(): Promise<OnDiskAgentRecord[]> {
  return _listAgentsCached();
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

export async function writeAgentRecord(record: OnDiskAgentRecord): Promise<void> {
  const path = join(storageDir(), "agents", `${b64url(record.id)}.json`);
  const diskRecord: Record<string, unknown> = { ...record };
  delete diskRecord["_mtimeMs"];
  delete diskRecord["_ctimeMs"];
  await atomicWriteJson(path, diskRecord);
  _listAgentsCached.invalidate();
}

function conversationKey(conversationId: string, agentId: string): string {
  return conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
}

export async function listConversationsForAgent(agentId: string): Promise<OnDiskConversation[]> {
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
    out.push(await withRealTimes(conv));
  }
  return out;
}

// lcp-5e5 + lcp-5ky: dir-mtime cache of the conversation list. The
// dir-mtime check catches conv-add and conv-remove, but content-only
// writes to an existing conversation.json (e.g. last_message_at bumps
// during a turn) don't change the parent dir's mtime and would silently
// serve stale timestamps. The writer path (bumpConversationLastMessageAt)
// calls .invalidate() to drop the cached snapshot — that keeps the
// mobile conversations list correctly ordered by recent activity.
const _listAllConversationsCached = makeDirMtimeCache(
  () => join(storageDir(), "conversations"),
  async () => {
    const root = join(storageDir(), "conversations");
    const out: OnDiskConversation[] = [];
    if (!existsSync(root)) return out;
    const dirNames = await fsReaddir(root);
    const BATCH_SIZE = 32;
    for (let i = 0; i < dirNames.length; i += BATCH_SIZE) {
      const batch = dirNames.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (dirName) => {
          const conv = await readJsonOrNullAsync(join(root, dirName, "conversation.json"));
          if (!isConversationOnDisk(conv)) return null;
          return withRealTimes(conv);
        })
      );
      for (const conv of results) {
        if (conv) {
          out.push(conv);
        }
      }
    }
    return out;
  },
);

export function listAllConversations(): Promise<OnDiskConversation[]> {
  return _listAllConversationsCached();
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
/**
 * Generic mtime-keyed cache helper. Returns a memoized loader that
 * recomputes when the named directory's mtime changes.
 *
 * Caveat: dir-mtime bumps only on entry add/remove at that level. Updates
 * to FILES inside child directories do NOT invalidate. Use this when the
 * cached value is structural (set at create time, immutable through the
 * resource's lifetime). For content that mutates in place, prefer a TTL
 * cache or aggregate-mtime hash.
 *
 * Used by lcp-efg (convIdMap — agent_id is set at conv creation) and
 * lcp-5e5 (listAgents / listAllConversations — staleness window is
 * acceptable for mobile's poll cadence; see those callers).
 */
interface DirMtimeCache<T> {
  (): Promise<T>;
  /**
   * Drop the cached snapshot so the next caller re-runs the loader. Use
   * after a content-only write that wouldn't bump the directory's mtime
   * (e.g. updating a field inside an existing child file).
   */
  invalidate: () => void;
}

function makeDirMtimeCache<T>(
  rootFn: () => string,
  loader: () => Promise<T>,
): DirMtimeCache<T> {
  let cached: T | null = null;
  let cachedMtimeMs = -1;
  let inflight: Promise<T> | null = null;
  const fn = async (): Promise<T> => {
    const root = rootFn();
    let mtimeMs = -1;
    try {
      mtimeMs = (await fsStat(root)).mtimeMs;
    } catch (err) {
      const code = err instanceof Error && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[store] failed to stat cache root ${root}: ${msg}`);
      }
    }
    if (cached !== null && mtimeMs === cachedMtimeMs) return cached;
    if (inflight) return inflight;
    const expectedMtimeMs = mtimeMs;
    inflight = (async () => {
      try {
        const value = await loader();
        cached = value;
        cachedMtimeMs = expectedMtimeMs;
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
  (fn as DirMtimeCache<T>).invalidate = () => {
    cached = null;
    cachedMtimeMs = -1;
  };
  return fn as DirMtimeCache<T>;
}

// lcp-efg cache: external conv id -> ResolvedConversation. Invalidated when
// the conversations-root directory's mtime changes (add / remove of a
// conversation subdir bumps it). Content changes inside an existing
// conversation.json do NOT invalidate, but the only field we read here is
// `agent_id`, which is structural and set at conv creation — it doesn't
// change during the conversation's lifetime. Safe to cache.
const convIdMap = makeDirMtimeCache(
  () => join(storageDir(), "conversations"),
  async () => {
    const map = new Map<string, ResolvedConversation>();
    const root = join(storageDir(), "conversations");
    if (existsSync(root)) {
      const dirNames = await fsReaddir(root);
      const BATCH_SIZE = 32;
      for (let i = 0; i < dirNames.length; i += BATCH_SIZE) {
        const batch = dirNames.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (dirName) => {
            const conv = await readJsonOrNullAsync(join(root, dirName, "conversation.json"));
            if (!isConversationOnDisk(conv)) return null;
            return conv;
          })
        );
        for (const conv of results) {
          if (conv) {
            map.set(conv.id, { conversationId: conv.id, agentId: conv.agent_id });
          }
        }
      }
    }
    return map;
  },
);

export async function resolveConversationId(externalId: string | null | undefined): Promise<ResolvedConversation | null> {
  if (!externalId) return null;
  if (externalId === "default") return null;
  const defaultMatch = externalId.match(/^conv-default-(agent-.+)$/);
  if (defaultMatch) return { conversationId: "default", agentId: defaultMatch[1]! };
  return (await convIdMap()).get(externalId) ?? null;
}

export async function getConversation(externalId: string, agentIdHint?: string | null): Promise<OnDiskConversation | null> {
  // Fast path: caller passed agentIdHint AND a real internal id.
  if (agentIdHint) {
    const key = conversationKey(externalId, agentIdHint);
    const dir = join(storageDir(), "conversations", b64url(key));
    const conv = await readJsonOrNullAsync(join(dir, "conversation.json"));
    if (isConversationOnDisk(conv)) return withRealTimes(conv);
  }
  // Mobile's external id may be `conv-default-{agentId}` → translate.
  const resolved = await resolveConversationId(externalId);
  if (!resolved) return null;
  const key = conversationKey(resolved.conversationId, resolved.agentId);
  const dir = join(storageDir(), "conversations", b64url(key));
  const conv = await readJsonOrNullAsync(join(dir, "conversation.json"));
  return isConversationOnDisk(conv) ? withRealTimes(conv) : null;
}

export async function getAgentIdForConversation(externalId: string): Promise<string | null> {
  return (await resolveConversationId(externalId))?.agentId ?? null;
}

// lcp-h5ns: stat-gated cache of the normalized+filtered LocalMessage[] for
// each conversation's messages.jsonl. Mobile polls GET /messages repeatedly
// between turns; previously every poll re-read and JSON-parsed the whole file
// (up to ~5MB / 1500+ lines) just to slice the tail. messages.jsonl only
// changes at end-of-turn (append from the pool / turn-settlement) or during a
// heal (atomic temp+rename rewrite), and BOTH bump the file's size and/or
// mtime. So we key the cache on (size, mtimeMs): an unchanged file is served
// from memory after a single `stat`, and any change triggers exactly one full
// reparse — never more work than before.
//
// lcp-2oxb.4: suffix-read optimization. When the file grew (st.size >
// cached.size) we check whether the previously-cached tail bytes are still
// present at the same offset in the new file (probe region). If they match,
// the prefix is intact and we only parse the new suffix. If they don't
// match — rewrite detected (healer atomicWriteJsonl, or CLI snapshot) —
// we fall through to a full re-parse. This cuts O(history) work to O(new
// lines) on the hot append path while remaining correct under full rewrites.
//
// CRITICAL: messages.jsonl is NOT strictly append-only. The CLI can rewrite
// the entire file (with its in-memory snapshot) at end-of-turn — the new
// file may be larger than the old one even when the content is completely
// different. The probe catches this: if the bytes at [probeOffset,
// probeOffset+probeLen) differ from what we cached, we fall back to full
// re-parse. The healer's atomicWriteJsonl also rewrites, and calls
// invalidateMessagesCache() so the cache entry is cleared entirely before
// the new stat is taken.
interface MessagesCacheEntry {
  size: number;
  mtimeMs: number;
  filtered: LocalMessage[];
  // lcp-2oxb.4: messages parsed from the COMPLETE-line region only (bytes
  // [0, lastCompleteLineEnd)). `filtered` may additionally include a final
  // unterminated-but-parseable line; incremental reads always rebuild from
  // `filteredComplete` so that trailing line is never double-counted.
  filteredComplete: LocalMessage[];
  // lcp-2oxb.4: tail probe for rewrite detection. probeBytes are the bytes
  // at [probeOffset, lastCompleteLineEnd) as of the most recent read
  // (≤ PROBE_LEN long, ending exactly at the checkpoint).
  probeOffset: number;
  probeBytes: Buffer;
  // Byte offset one past the final '\n' as of the last read (0 if the file
  // had no newline). Incremental reads start here, so a trailing partial
  // line is re-read — and re-parsed — on the next poll.
  lastCompleteLineEnd: number;
}
const messagesCache = new Map<string, MessagesCacheEntry>();
// Bound memory: large transcripts parse to tens of MB of heap each. Keep only
// the most-recently-read conversations hot; mobile works a handful at a time.
const MESSAGES_CACHE_MAX = 24;

// lcp-2oxb.4: how many tail bytes to probe for rewrite detection.
// 1 KB is enough to span several JSONL lines — collisions are astronomically
// unlikely and the overhead is a single pread of 1 KB per changed-size poll.
const PROBE_LEN = 1024;

function touchMessagesCache(path: string, entry: MessagesCacheEntry): void {
  // Map preserves insertion order — delete+set moves the key to most-recent.
  messagesCache.delete(path);
  messagesCache.set(path, entry);
  if (messagesCache.size > MESSAGES_CACHE_MAX) {
    const oldest = messagesCache.keys().next().value;
    if (oldest !== undefined) messagesCache.delete(oldest);
  }
}

function normalizeAndFilter(items: unknown[]): LocalMessage[] {
  // Normalize content -> parts (and unwrap v3 envelopes, lcp-nlud) BEFORE
  // filtering so post-migration records pass isLocalMessage.
  return items.map(normalizeMessage).filter(isLocalMessage);
}

/**
 * lcp-2oxb.4: build a full cache entry from the complete file contents.
 * Splits the buffer at the last '\n' so the cached checkpoint always sits
 * on a line boundary; a trailing unterminated line is parsed into
 * `filtered` (preserving the old behavior of including a complete-but-
 * unterminated final JSON line) but excluded from `filteredComplete`.
 */
function buildMessagesCacheEntry(buf: Buffer, st: { size: number; mtimeMs: number }): MessagesCacheEntry {
  const nl = buf.lastIndexOf(0x0a);
  const checkpoint = nl === -1 ? 0 : nl + 1;
  const completeBuf = buf.subarray(0, checkpoint);
  const tailBuf = buf.subarray(checkpoint);
  const filteredComplete = normalizeAndFilter(parseJsonl(completeBuf.toString("utf8")));
  const filtered = tailBuf.length > 0
    ? filteredComplete.concat(normalizeAndFilter(parseJsonl(tailBuf.toString("utf8"))))
    : filteredComplete;
  const probeOffset = Math.max(0, checkpoint - PROBE_LEN);
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    filtered,
    filteredComplete,
    probeOffset,
    probeBytes: Buffer.from(completeBuf.subarray(probeOffset, checkpoint)),
    lastCompleteLineEnd: checkpoint,
  };
}

/**
 * lcp-2oxb.4: fold freshly-appended bytes into a cached entry. `appended`
 * is the file content from the previous checkpoint onward; the caller has
 * already verified via the tail probe that the prefix is unchanged.
 */
function extendMessagesCacheEntry(
  cached: MessagesCacheEntry,
  appended: Buffer,
  st: { size: number; mtimeMs: number },
): MessagesCacheEntry {
  const nl = appended.lastIndexOf(0x0a);
  const deltaCheckpoint = nl === -1 ? 0 : nl + 1;
  const completeNew = appended.subarray(0, deltaCheckpoint);
  const tailNew = appended.subarray(deltaCheckpoint);
  const filteredComplete = deltaCheckpoint > 0
    ? cached.filteredComplete.concat(normalizeAndFilter(parseJsonl(completeNew.toString("utf8"))))
    : cached.filteredComplete;
  const filtered = tailNew.length > 0
    ? filteredComplete.concat(normalizeAndFilter(parseJsonl(tailNew.toString("utf8"))))
    : filteredComplete;
  const checkpoint = cached.lastCompleteLineEnd + deltaCheckpoint;
  // Reconstruct the probe window: cached.probeBytes ends exactly where
  // completeNew begins, so their concat is contiguous file content ending
  // at the new checkpoint. Keep the last PROBE_LEN bytes of that.
  const combined = Buffer.concat([cached.probeBytes, completeNew]);
  const probeBytes = Buffer.from(combined.subarray(Math.max(0, combined.length - PROBE_LEN)));
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    filtered,
    filteredComplete,
    probeOffset: checkpoint - probeBytes.length,
    probeBytes,
    lastCompleteLineEnd: checkpoint,
  };
}

/**
 * lcp-2oxb.4 (sync): attempt the probe-verified suffix read. Returns the
 * extended entry, or null when the probe mismatches (file was rewritten),
 * the file shrank, or any read fails — callers fall back to a full parse.
 */
function tryIncrementalReadSync(
  path: string,
  cached: MessagesCacheEntry,
  st: { size: number; mtimeMs: number },
): MessagesCacheEntry | null {
  if (st.size <= cached.lastCompleteLineEnd) return null;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    if (cached.probeBytes.length > 0) {
      const probe = Buffer.allocUnsafe(cached.probeBytes.length);
      const n = readSync(fd, probe, 0, probe.length, cached.probeOffset);
      if (n !== probe.length || !probe.equals(cached.probeBytes)) return null;
    }
    const wanted = st.size - cached.lastCompleteLineEnd;
    const appended = Buffer.allocUnsafe(wanted);
    const n = readSync(fd, appended, 0, wanted, cached.lastCompleteLineEnd);
    return extendMessagesCacheEntry(cached, appended.subarray(0, n), st);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** lcp-2oxb.4 (async): same contract as tryIncrementalReadSync. */
async function tryIncrementalRead(
  path: string,
  cached: MessagesCacheEntry,
  st: { size: number; mtimeMs: number },
): Promise<MessagesCacheEntry | null> {
  if (st.size <= cached.lastCompleteLineEnd) return null;
  let fh;
  try {
    fh = await fsOpen(path, "r");
  } catch {
    return null;
  }
  try {
    if (cached.probeBytes.length > 0) {
      const probe = Buffer.allocUnsafe(cached.probeBytes.length);
      const { bytesRead } = await fh.read(probe, 0, probe.length, cached.probeOffset);
      if (bytesRead !== probe.length || !probe.equals(cached.probeBytes)) return null;
    }
    const wanted = st.size - cached.lastCompleteLineEnd;
    const appended = Buffer.allocUnsafe(wanted);
    const { bytesRead } = await fh.read(appended, 0, wanted, cached.lastCompleteLineEnd);
    return extendMessagesCacheEntry(cached, appended.subarray(0, bytesRead), st);
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

async function loadFilteredMessages(path: string): Promise<LocalMessage[]> {
  let st;
  try {
    st = await fsStat(path);
  } catch {
    messagesCache.delete(path);
    return [];
  }
  const cached = messagesCache.get(path);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    touchMessagesCache(path, cached);
    return cached.filtered;
  }
  // lcp-2oxb.4: file grew — try the probe-verified suffix read before
  // falling back to a full parse. A rewrite (healer or CLI snapshot) fails
  // the probe and falls through.
  if (cached && st.size > cached.size) {
    const extended = await tryIncrementalRead(path, cached, st);
    if (extended) {
      touchMessagesCache(path, extended);
      return extended.filtered;
    }
  }
  // Stat (taken BEFORE the read) is what we store: if the file changes after
  // this read, its next stat differs from `st` and we reparse — conservative,
  // never stale.
  let buf: Buffer;
  try {
    buf = await fsReadFile(path);
  } catch {
    messagesCache.delete(path);
    return [];
  }
  const entry = buildMessagesCacheEntry(buf, st);
  touchMessagesCache(path, entry);
  return entry.filtered;
}

function loadFilteredMessagesSync(path: string): LocalMessage[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    messagesCache.delete(path);
    return [];
  }
  const cached = messagesCache.get(path);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    touchMessagesCache(path, cached);
    return cached.filtered;
  }
  if (cached && st.size > cached.size) {
    const extended = tryIncrementalReadSync(path, cached, st);
    if (extended) {
      touchMessagesCache(path, extended);
      return extended.filtered;
    }
  }
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    messagesCache.delete(path);
    return [];
  }
  const entry = buildMessagesCacheEntry(buf, st);
  touchMessagesCache(path, entry);
  return entry.filtered;
}

/**
 * lcp-2oxb.4: drop the cached parse for one conversation's messages.jsonl.
 * Shim-side writers that rewrite the file in place (conversation-healer,
 * turn-settlement) call this after writing so the next read can never be
 * served a stale suffix-extended entry. The tail probe would catch the
 * rewrite anyway — this is belt-and-braces.
 */
export function invalidateMessagesCache(conversationId: string, agentId: string): void {
  const key = conversationKey(conversationId, agentId);
  messagesCache.delete(join(storageDir(), "conversations", b64url(key), "messages.jsonl"));
}

/**
 * Drop the cached `listAllConversations()` snapshot so the next read reflects
 * writes that happened out-of-band of the cache key (the dir mtime doesn't
 * change when only `conversation.json` is rewritten in place). Shim-side
 * writers — archive PATCH, archive DELETE — must call this after writing.
 */
export function invalidateConversationsListCache(): void {
  _listAllConversationsCached.invalidate();
}

export async function listMessages(
  conversationId: string,
  agentId: string,
  { limit, before }: ListMessagesOptions = {},
): Promise<LocalMessage[]> {
  const key = conversationKey(conversationId, agentId);
  const dir = join(storageDir(), "conversations", b64url(key));
  const all = await loadFilteredMessages(join(dir, "messages.jsonl"));
  let scoped: LocalMessage[] = all;
  if (before) {
    const idx = all.findIndex((m) => m.id === before);
    if (idx >= 0) scoped = all.slice(0, idx);
  }
  if (limit && limit > 0) scoped = scoped.slice(-limit);
  // Never hand back the cached array itself — callers must not be able to
  // mutate cache state. (slice() above already copies; cover the pass-through.)
  return scoped === all ? all.slice() : scoped;
}

/**
 * lcp-pgw: synchronous variant of `listMessages` for use in synchronous
 * callbacks (e.g. onFrame) that can't await. Same normalization pipeline;
 * no limit/before support — callers filter externally.
 */
export function listMessagesSync(
  conversationId: string,
  agentId: string,
): LocalMessage[] {
  return loadFilteredMessagesSync(messagesJsonlPath(conversationId, agentId)).slice();
}

export function messagesJsonlPath(conversationId: string, agentId: string): string {
  const key = conversationKey(conversationId, agentId);
  return join(storageDir(), "conversations", b64url(key), "messages.jsonl");
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

/**
 * lcp-2oxb.4: append-only successor to the legacy `_real-times.json` map.
 * One line per stamp: {"id":"...","iso":"..."} — last-wins on duplicate ids.
 * stampNewMessages appends only the NEWLY stamped ids each turn (O(new)
 * instead of rewriting the whole O(history) map); readMessageTimestamps
 * folds legacy JSON (if still present) + JSONL lines into the in-memory map
 * and compacts the JSONL when duplicates pile past 2× the distinct ids.
 */
function timestampJsonlPath(conversationId: string, agentId: string): string {
  const key = conversationKey(conversationId, agentId);
  return join(storageDir(), "conversations", b64url(key), "_real-times.jsonl");
}

/** lcp-2oxb.4: atomic JSONL rewrite (tmp + rename), mirrors atomicWriteJson. */
async function atomicWriteTimestampJsonl(path: string, map: TimestampSidecar): Promise<void> {
  const dir = dirname(path);
  await fsMkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  const body = Object.entries(map)
    .map(([id, iso]) => JSON.stringify({ id, iso }))
    .join("\n");
  try {
    await fsWriteFile(tmp, body.length > 0 ? body + "\n" : "");
    await fsRename(tmp, path);
  } catch (err) {
    await fsUnlink(tmp).catch(() => {});
    throw err;
  }
}

function otidSidecarPath(conversationId: string, agentId: string): string {
  const key = conversationKey(conversationId, agentId);
  return join(storageDir(), "conversations", b64url(key), "_otid-map.json");
}

function attachmentsSidecarPath(conversationId: string, agentId: string): string {
  const key = conversationKey(conversationId, agentId);
  return join(storageDir(), "conversations", b64url(key), "_attachments.json");
}

// lcp-66pv: in-memory cache of the _real-times.json sidecar, mirroring the
// otidMapCache write-through pattern below. Every GET /messages reads this
// (readMessageTimestamps) and the conversations list reads it via
// maxRealMessageTime — but it only changes when stampNewMessages writes at
// end-of-turn. stampNewMessages obtains the map via readMessageTimestamps,
// mutates it in place, and persists, so the cached object stays consistent
// with disk; on write failure the entry is evicted so the next read re-loads
// authoritative state. The only writer of this file is stampNewMessages.
const realTimesCache = new Map<string, TimestampSidecar>();

function realTimesCacheKey(conversationId: string, agentId: string): string {
  return `${conversationId}|${agentId}`;
}

export async function readMessageTimestamps(conversationId: string, agentId: string): Promise<TimestampSidecar> {
  const cacheKey = realTimesCacheKey(conversationId, agentId);
  const cached = realTimesCache.get(cacheKey);
  if (cached) return cached;
  // lcp-2oxb.4: legacy JSON map first (pre-migration conversations), then
  // overlay the append-only JSONL — later lines win, matching append order.
  const legacyRaw = await readJsonOrNullAsync(timestampSidecarPath(conversationId, agentId));
  const map: TimestampSidecar = isStringRecord(legacyRaw) ? { ...legacyRaw } : {};
  const jsonlPath = timestampJsonlPath(conversationId, agentId);
  let lineCount = 0;
  try {
    const body = await fsReadFile(jsonlPath, "utf8");
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lineCount += 1;
      try {
        const obj = JSON.parse(trimmed) as { id?: unknown; iso?: unknown };
        if (typeof obj.id === "string" && typeof obj.iso === "string") {
          map[obj.id] = obj.iso;
        }
      } catch {
        // Skip malformed / partial trailing line (crash mid-append) —
        // the worst case is one message falling back to its sentinel date.
      }
    }
  } catch {
    // No JSONL yet — legacy-only or fresh conversation.
  }
  // Compaction: duplicate ids accumulate one line per re-stamp attempt.
  // Rewrite one-line-per-id when the file is more than 2× the live set.
  const distinct = Object.keys(map).length;
  if (distinct > 0 && lineCount > distinct * 2) {
    try {
      await atomicWriteTimestampJsonl(jsonlPath, map);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[store] timestamp jsonl compaction failed for ${conversationId}: ${msg}`);
    }
  }
  realTimesCache.set(cacheKey, map);
  return map;
}

// lcp-dfz: derive the effective last_message_at from the sidecar. letta-code's
// in-process LocalStore rewrites conversation.json at end-of-turn with sentinel
// dates (2026-01-01T00:00:<seqIndex+1>.000Z), clobbering whatever
// bumpConversationLastMessageAt wrote ~seconds earlier. The sidecar is the only
// file letta-code never touches, so it's the race-free source of truth.
async function maxRealMessageTime(conversationId: string, agentId: string): Promise<string> {
  const map = await readMessageTimestamps(conversationId, agentId);
  let max = "";
  for (const iso of Object.values(map)) {
    if (typeof iso === "string" && iso > max) max = iso;
  }
  return max;
}

/**
 * Return a conv record whose last_message_at / updated_at reflect the
 * sidecar's max real timestamp if it's newer than what's on disk.
 *
 * Pure substitution — never writes. Run on every read path that projects to
 * the wire so the conversations list sorts by real recent activity.
 */
// lcp-28r: the CLI's local-backend mode uses 2026-01-01T... as a
// deterministic monotonic sentinel. Any date matching this prefix is
// implausible and should be replaced with a real fallback.
function isSentinelDate(iso: unknown): boolean {
  return typeof iso === "string" && iso.startsWith("2026-01-01T");
}

async function withRealTimes(conv: OnDiskConversation): Promise<OnDiskConversation> {
  const max = await maxRealMessageTime(conv.id, conv.agent_id);
  let last = typeof conv.last_message_at === "string" ? conv.last_message_at : "";
  let updated = typeof conv.updated_at === "string" ? conv.updated_at : "";
  const created = typeof conv.created_at === "string" ? conv.created_at : "";
  // lcp-28r: if the on-disk values are CLI sentinels, substitute the
  // sidecar max, then created_at, then current time — in that order.
  if (isSentinelDate(last)) last = max || created || new Date().toISOString();
  if (isSentinelDate(updated)) updated = max || created || new Date().toISOString();
  if (max && max > last) last = max;
  if (max && max > updated) updated = max;
  if (last === conv.last_message_at && updated === conv.updated_at) return conv;
  return { ...conv, last_message_at: last, updated_at: updated };
}

// Mobile reconciles its optimistic Local user bubble against the server-issued
// Confirmed by matching `otid` (sent in the POST body's `messages[].otid`,
// then expected back on the user_message returned by GET /messages). letta-code
// has no concept of otid, so we maintain our own sidecar mapping LocalMessage
// `id` → mobile-supplied otid. The projection joins this on read so the
// user_message wire frame echoes the original otid, letting mobile collapse
// the Local-vs-Confirmed pair via its existing reconcileAfterSend flow.

// lcp-6ai: in-memory cache of otid sidecars, keyed by `${convId}|${agentId}`.
// Avoids re-reading the file every turn: writeOtidForLocalId mutates the
// cached map in place and persists, readOtidMap returns the cached map if
// present and only loads from disk on cold access. On write failure the
// cache entry is evicted so the next read re-fetches authoritative state.
const otidMapCache = new Map<string, OtidSidecar>();

function otidCacheKey(conversationId: string, agentId: string): string {
  return `${conversationId}|${agentId}`;
}

async function loadOtidMap(conversationId: string, agentId: string): Promise<OtidSidecar> {
  const key = otidCacheKey(conversationId, agentId);
  const cached = otidMapCache.get(key);
  if (cached) return cached;
  const path = otidSidecarPath(conversationId, agentId);
  const raw = await readJsonOrNullAsync(path);
  const map: OtidSidecar = isStringRecord(raw) ? raw : {};
  otidMapCache.set(key, map);
  return map;
}

export async function readOtidMap(conversationId: string, agentId: string): Promise<OtidSidecar> {
  return loadOtidMap(conversationId, agentId);
}

export async function writeOtidForLocalId(
  conversationId: string,
  agentId: string,
  localId: string | null | undefined,
  otid: string | null | undefined,
): Promise<void> {
  if (!localId || !otid) return;
  const path = otidSidecarPath(conversationId, agentId);
  const key = otidCacheKey(conversationId, agentId);
  const current = await loadOtidMap(conversationId, agentId);
  if (current[localId] === otid) return;
  current[localId] = otid;
  try {
    await atomicWriteJson(path, current);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[store] otid sidecar write failed for ${conversationId}: ${msg}`);
    // Evict so the next reader doesn't trust an in-memory state that didn't
    // make it to disk; subsequent loadOtidMap will reread the file.
    otidMapCache.delete(key);
  }
}

const attachmentMapCache = new Map<string, MessageAttachmentSidecar>();

function attachmentCacheKey(conversationId: string, agentId: string): string {
  return `${conversationId}|${agentId}`;
}

export async function readAttachmentMap(conversationId: string, agentId: string): Promise<MessageAttachmentSidecar> {
  const key = attachmentCacheKey(conversationId, agentId);
  const cached = attachmentMapCache.get(key);
  if (cached) return cached;
  const raw = await readJsonOrNullAsync(attachmentsSidecarPath(conversationId, agentId));
  const map: MessageAttachmentSidecar = isAttachmentSidecar(raw) ? raw : {};
  attachmentMapCache.set(key, map);
  return map;
}

export async function writeAttachmentsForLocalId(
  conversationId: string,
  agentId: string,
  localId: string | null | undefined,
  refs: readonly AttachmentRef[],
): Promise<void> {
  if (!localId || refs.length === 0) return;
  const path = attachmentsSidecarPath(conversationId, agentId);
  const key = attachmentCacheKey(conversationId, agentId);
  const current = await readAttachmentMap(conversationId, agentId);
  current[localId] = [...refs];
  try {
    await atomicWriteJson(path, current);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[store] attachment sidecar write failed for ${conversationId}: ${msg}`);
    attachmentMapCache.delete(key);
  }
}

/**
 * Find the most-recently-added user-role LocalMessage in messages.jsonl
 * whose id ISN'T already mapped. Used immediately after a turn to bind the
 * mobile-supplied otid to the user message letta-code just persisted.
 *
 * Returns the localId or null if none found.
 */
export async function findUnmappedTailUserMessageId(conversationId: string, agentId: string): Promise<string | null> {
  const messages = await listMessages(conversationId, agentId);
  const map = await readOtidMap(conversationId, agentId);
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
export async function stampNewMessages(
  conversationId: string,
  agentId: string,
  startTime: Date = new Date(),
): Promise<void> {
  const messages = await listMessages(conversationId, agentId);
  if (messages.length === 0) return;
  const current = await readMessageTimestamps(conversationId, agentId);
  let dirty = false;
  let offset = 0;
  let maxStampedIso = "";
  const baseMs = startTime.getTime();
  const newlyStamped: Array<{ id: string; iso: string }> = [];
  for (const m of messages) {
    if (m?.id && !current[m.id]) {
      const iso = new Date(baseMs + offset).toISOString();
      current[m.id] = iso;
      newlyStamped.push({ id: m.id, iso });
      maxStampedIso = iso;
      offset += 1;
      dirty = true;
    }
  }
  if (dirty) {
    const legacyPath = timestampSidecarPath(conversationId, agentId);
    const jsonlPath = timestampJsonlPath(conversationId, agentId);
    try {
      if (existsSync(legacyPath)) {
        // lcp-2oxb.4 one-time migration: fold the legacy JSON map (already
        // merged into `current` by readMessageTimestamps) into a compacted
        // JSONL, then drop the legacy file. Subsequent turns take the cheap
        // append path below.
        await atomicWriteTimestampJsonl(jsonlPath, current);
        await fsUnlink(legacyPath).catch(() => {});
      } else {
        // Hot path: append ONLY this turn's new stamps — O(new messages)
        // instead of rewriting the whole O(history) map (lcp-2oxb.4).
        await fsAppendFile(
          jsonlPath,
          newlyStamped.map((e) => JSON.stringify(e)).join("\n") + "\n",
        );
      }
    } catch (err) {
      // lcp-66pv: the in-place mutation above already updated the cached map;
      // if persistence failed, evict so the next read re-loads authoritative
      // (un-mutated) state from disk rather than serving the un-persisted map.
      realTimesCache.delete(realTimesCacheKey(conversationId, agentId));
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[store] stamp sidecar write failed for ${conversationId}: ${msg}`);
    }
    // lcp-dfz: invalidate the list cache as soon as the sidecar is on disk.
    // Read paths derive last_message_at from this sidecar (see withRealTimes)
    // so the next GET /v1/conversations rebuilds with the fresh max time —
    // even if bumpConversationLastMessageAt below loses its race with
    // letta-code's end-of-turn conversation.json rewrite.
    _listAllConversationsCached.invalidate();
    // lcp-pwz: also try to persist the bump to conversation.json. Best-effort
    // — letta-code's LocalStore commonly rewrites conversation.json a few
    // seconds later with sentinel dates, clobbering this. The read-time
    // substitution above is the load-bearing fix; this write just keeps
    // disk-state consistent for external readers when no race occurs.
    await bumpConversationLastMessageAt(conversationId, agentId, maxStampedIso);
  }
}

async function bumpConversationLastMessageAt(
  conversationId: string,
  agentId: string,
  iso: string,
): Promise<void> {
  if (!iso) return;
  const key = conversationKey(conversationId, agentId);
  const path = join(storageDir(), "conversations", b64url(key), "conversation.json");
  const raw = await readJsonOrNullAsync(path);
  if (!raw || typeof raw !== "object") return;
  const conv = raw as Record<string, unknown>;
  const currentLast = typeof conv["last_message_at"] === "string" ? (conv["last_message_at"] as string) : "";
  // Never go backwards: only bump if the new timestamp is strictly later.
  if (currentLast && currentLast >= iso) return;
  conv["last_message_at"] = iso;
  conv["updated_at"] = iso;
  try {
    await atomicWriteJson(path, conv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[store] conversation.json bump failed for ${conversationId}: ${msg}`);
  }
  // Cache invalidation lives in the caller (stampNewMessages) so it fires
  // regardless of whether this best-effort persistent write wins or loses
  // the race with letta-code's end-of-turn conversation.json rewrite.
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
      // lcp-pwz follow-up: previously this used
      //   `block-${b64url(`${agentId}:${label}`).slice(0, 24)}`
      // The slice cut off everything past the agent-id prefix because
      // base64-encoded agent UUIDs already exceed 24 chars before reaching
      // the `:` separator. Every block on the same agent ended up sharing
      // an id, which crashed mobile's blocks screen on duplicate
      // LazyColumn keys. Switch to a sha256 hash so the id is unique by
      // construction and still fixed-width (vanilla Letta shape).
      id: `block-${createHash("sha256").update(`${agentId}:${label}`).digest("hex").slice(0, 24)}`,
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
// Directory copy helper
// ──────────────────────────────────────────────────────────────────────

/**
 * Copy a directory recursively from src to dst.
 */
function copyDirRecursive(src: string, dst: string): void {
  // cpSync preserves file mode bits (executable scripts keep +x). The manual
  // readFileSync/writeFileSync copy stripped permissions, so skill scripts
  // copied on install failed when invoked directly. (CodeRabbit: skill copy
  // strips source file mode bits.)
  cpSync(src, dst, { recursive: true, preserveTimestamps: true });
}

/**
 * Validate a skill name before using it in filesystem path joins.
 *
 * skillName arrives from request bodies and URL path segments and is joined
 * into the skills store / per-agent dirs. Reject any value containing path
 * separators or `..` traversal so it can never escape the skills directory
 * (notably uninstall, which deletes). (CodeRabbit: path traversal risk.)
 */
function isSafeSkillName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 128 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name !== "." &&
    name !== ".." &&
    // allow only a conservative skill-id charset
    /^[A-Za-z0-9._-]+$/.test(name) &&
    !name.includes("..")
  );
}

// ──────────────────────────────────────────────────────────────────────
// Skills — skill discovery, installation, and management
// ──────────────────────────────────────────────────────────────────────

/**
 * Skill manifest shape as returned by the skills API.
 */
export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  tags: string[];
  author: string;
}

/**
 * Extended skill detail returned by GET /v1/skills/{name}.
 */
export interface SkillDetail extends SkillManifest {
  readme: string;
  files: string[];
  dependencies: string[];
}

/**
 * Skill listing item with installation count.
 */
export interface SkillListingItem extends SkillManifest {
  installed_count: number;
}

/**
 * Slash-command descriptor surfaced to clients. Skills are invokable by name
 * through the existing Skill tool; this shape lets apps render `/name`
 * command pickers without loading full SKILL.md bodies.
 */
export interface SkillSlashCommand {
  name: string;
  command: string;
  description: string;
  skill_name: string;
  source: "global_skill" | "agent_skill" | "builtin_goal";
  installed: boolean;
}

/**
 * Get the global skills store directory.
 *
 * The global registry is intentionally a USER-LEVEL shared store (default
 * `~/.letta/skills`, overridable via `LETTA_HOME`). It is shared across
 * deployments and is interoperable with the official Letta client (see
 * DIVERGENCE.md). This is deliberately NOT under `storageDir()` so that
 * the same global skill catalog is visible regardless of which
 * lc-local-backend a given shim instance points at.
 *
 * Tests / isolated installs may override the registry root explicitly via
 * `LETTA_SKILLS_DIR`.
 */
export function skillsStoreDir(): string {
  return (
    process.env["LETTA_SKILLS_DIR"] ||
    join(process.env["LETTA_HOME"] || join(homedir(), ".letta"), "skills")
  );
}

/**
 * Get the directory for an agent's installed skills.
 *
 * Per-agent installed skills are SHIM STATE — they live alongside the rest
 * of the agent's state under `storageDir()/agents/<id>/skills/` (the same
 * root as `agents/<b64url(id)>.json`, `memfs/<id>/...`, etc.) rather than a
 * hardcoded `~/.letta`. This keeps per-agent state co-located with the
 * lc-local-backend it belongs to.
 */
export function agentSkillsDir(agentId: string): string {
  return join(storageDir(), "agents", agentId, "skills");
}

/**
 * Parse skill metadata from a SKILL.md file's frontmatter or first lines.
 * Returns the parsed metadata or null if the file doesn't contain valid skill info.
 */
function parseSkillMetadata(skillDir: string, skillName: string): SkillManifest | null {
  const skillMdPath = join(skillDir, "SKILL.md");
  const metadataPath = join(skillDir, "metadata.json");

  // Try metadata.json first
  if (existsSync(metadataPath)) {
    try {
      const raw = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      if (typeof raw["name"] === "string") {
        return {
          name: raw["name"] as string,
          version: typeof raw["version"] === "string" ? raw["version"] as string : "1.0.0",
          description: typeof raw["description"] === "string" ? raw["description"] as string : "",
          tags: Array.isArray(raw["tags"]) ? (raw["tags"] as string[]).filter((t) => typeof t === "string") : [],
          author: typeof raw["author"] === "string" ? raw["author"] as string : "community",
        };
      }
    } catch {
      // Fall through to SKILL.md parsing
    }
  }

  // Parse SKILL.md for frontmatter or structured content
  if (existsSync(skillMdPath)) {
    try {
      const content = readFileSync(skillMdPath, "utf8");
      let name = skillName;
      let description = "";
      let version = "1.0.0";
      let author = "community";
      const tags: string[] = [];

      // Try YAML frontmatter
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
      if (frontmatterMatch && frontmatterMatch[1]) {
        const fm = frontmatterMatch[1];
        const nameMatch = fm.match(/name:\s*["']?([^"'\n]+)["']?/i);
        if (nameMatch && nameMatch[1]) name = nameMatch[1].trim();
        const descMatch = fm.match(/description:\s*["']?([^"'\n]+)["']?/i);
        if (descMatch && descMatch[1]) description = descMatch[1].trim();
        const verMatch = fm.match(/version:\s*["']?([^"'\n]+)["']?/i);
        if (verMatch && verMatch[1]) version = verMatch[1].trim();
        const authMatch = fm.match(/author:\s*["']?([^"'\n]+)["']?/i);
        if (authMatch && authMatch[1]) author = authMatch[1].trim();
        const tagsMatch = fm.match(/tags:\s*\[(.*?)\]/i);
        if (tagsMatch && tagsMatch[1]) {
          const tagsStr = tagsMatch[1];
          const tagMatches = tagsStr.match(/["']([^"']+)["']/g);
          if (tagMatches) {
            for (const tm of tagMatches) {
              tags.push(tm.replace(/["']/g, "").trim());
            }
          }
        }
      } else {
        // Try extracting from first few lines (name: ... / description: ...)
        const lines = content.split("\n").slice(0, 20);
        for (const line of lines) {
          const nameMatch = line.match(/^#\s*(?:skill\s+)?name:\s*(.+)/i);
          if (nameMatch && nameMatch[1]) { name = nameMatch[1].trim(); continue; }
          const descMatch = line.match(/^#\s*description:\s*(.+)/i);
          if (descMatch && descMatch[1]) { description = descMatch[1].trim(); continue; }
          const verMatch = line.match(/^#\s*version:\s*(.+)/i);
          if (verMatch && verMatch[1]) { version = verMatch[1].trim(); continue; }
          const authMatch = line.match(/^#\s*author:\s*(.+)/i);
          if (authMatch && authMatch[1]) { author = authMatch[1].trim(); continue; }
          const tagsMatch = line.match(/^#\s*tags:\s*(.+)/i);
          if (tagsMatch && tagsMatch[1]) {
            const tagsStr = tagsMatch[1];
            const tagMatches = tagsStr.match(/[\w-]+/g);
            if (tagMatches) tags.push(...tagMatches);
          }
        }
        // Use first heading as description fallback
        if (!description) {
          const headingMatch = content.match(/^#\s+(.+)/m);
          if (headingMatch && headingMatch[1]) description = headingMatch[1].trim();
        }
      }

      return { name, version, description, tags, author };
    } catch {
      // Return default manifest
    }
  }

  // Return default manifest
  return {
    name: skillName,
    version: "1.0.0",
    description: "",
    tags: [],
    author: "community",
  };
}

/**
 * List all available skills in the global store.
 */
export function listAvailableSkills(): SkillListingItem[] {
  const storeDir = skillsStoreDir();
  if (!existsSync(storeDir)) return [];

  const out: SkillListingItem[] = [];
  try {
    const entries = readdirSync(storeDir);
    for (const entry of entries) {
      const skillDir = join(storeDir, entry);
      // Check if this is a directory with a SKILL.md file
      if (!statSync(skillDir).isDirectory()) continue;
      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      const manifest = parseSkillMetadata(skillDir, entry);
      if (!manifest) continue;

      // Count how many agents have this skill installed. Per-agent skills
      // live under storageDir()/agents/<id>/skills/ (see agentSkillsDir).
      const agentsDir = join(storageDir(), "agents");
      let installedCount = 0;
      if (existsSync(agentsDir)) {
        try {
          const agentDirs = readdirSync(agentsDir);
          for (const agentDir of agentDirs) {
            const agentSkillPath = join(agentsDir, agentDir, "skills", entry);
            if (existsSync(agentSkillPath)) installedCount++;
          }
        } catch {
          // Ignore errors counting installations
        }
      }

      out.push({
        ...manifest,
        installed_count: installedCount,
      });
    }
  } catch {
    // Return empty list on error
  }
  return out;
}

/**
 * Get detailed information about a specific skill in the global store.
 */
export function getSkillDetail(skillName: string): SkillDetail | null {
  if (!isSafeSkillName(skillName)) return null;
  const storeDir = skillsStoreDir();
  const skillDir = join(storeDir, skillName);

  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) return null;

  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) return null;

  const manifest = parseSkillMetadata(skillDir, skillName);
  if (!manifest) return null;

  // Read the SKILL.md content
  let readme = "";
  try {
    readme = readFileSync(skillMdPath, "utf8");
  } catch {
    // Keep empty
  }

  // List all files in the skill directory
  const files: string[] = [];
  try {
    const entries = readdirSync(skillDir);
    for (const entry of entries) {
      const fullPath = join(skillDir, entry);
      if (statSync(fullPath).isDirectory()) {
        files.push(`${entry}/`);
 // Add files within subdirectories
        try {
          const subEntries = readdirSync(fullPath);
          for (const subEntry of subEntries) {
            files.push(`${entry}/${subEntry}`);
          }
        } catch {
          // Ignore
        }
      } else {
        files.push(entry);
      }
    }
  } catch {
    // Keep empty
  }

  return {
    ...manifest,
    readme,
    files,
    dependencies: [],
  };
}

/**
 * Result of a publish attempt. `created` distinguishes a brand-new skill
 * (HTTP 201) from an overwrite of an existing one (HTTP 200).
 */
export interface PublishSkillResult {
  ok: boolean;
  created: boolean;
  /** Set when ok=false so the route can return a precise 4xx detail. */
  error?: "invalid_name" | "invalid_body" | "write_failed";
}

/**
 * Input for publishing a skill into the GLOBAL registry (skillsStoreDir()).
 *
 * Two shapes are accepted:
 *   - `readme` (a full SKILL.md document) is written verbatim. This is the
 *     primary path — the app sends the complete SKILL.md the user authored.
 *   - otherwise a minimal SKILL.md is synthesized from the metadata fields
 *     (name/description/version/tags/author) so callers that only have
 *     structured metadata can still publish.
 *
 * Either way the on-disk result is `<store>/<name>/SKILL.md`, which is what
 * every reader (listAvailableSkills/getSkillDetail/install) already expects.
 */
export interface PublishSkillInput {
  description?: string;
  version?: string;
  tags?: string[];
  author?: string;
  /** Full SKILL.md document. Written verbatim when present. */
  readme?: string;
}

/** Escape a value for safe single-line YAML frontmatter. */
function yamlScalar(value: string): string {
  // Wrap in double quotes and escape backslashes/quotes so a description
  // containing `:` or `#` can't break the frontmatter or inject keys.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build a minimal SKILL.md document from structured metadata. Used only
 * when the caller did not supply a full `readme`.
 */
function synthesizeSkillMd(name: string, input: PublishSkillInput): string {
  const description = (input.description ?? "").trim();
  const version = (input.version ?? "1.0.0").trim() || "1.0.0";
  const author = (input.author ?? "community").trim() || "community";
  const tags = (input.tags ?? []).filter((t) => typeof t === "string" && t.length > 0);
  const tagsLine = tags.length
    ? `tags: [${tags.map((t) => yamlScalar(t)).join(", ")}]`
    : "tags: []";
  return [
    "---",
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(description)}`,
    `version: ${yamlScalar(version)}`,
    tagsLine,
    `author: ${yamlScalar(author)}`,
    "---",
    "",
    `# ${name}`,
    "",
    description,
    "",
  ].join("\n");
}

/**
 * Publish (create-or-replace) a skill in the GLOBAL registry.
 *
 * This is the missing write half of the skills catalog: discovery/install
 * already existed, but there was no way to ADD a skill to the registry over
 * HTTP. PUT semantics — idempotent create-or-overwrite keyed on `name`.
 *
 * Writes atomically via a staging dir + rename, mirroring installSkillToAgent,
 * so a mid-write failure never leaves a half-written skill that readers would
 * treat as valid.
 */
export function publishSkillToStore(
  skillName: string,
  input: PublishSkillInput,
): PublishSkillResult {
  if (!isSafeSkillName(skillName)) return { ok: false, created: false, error: "invalid_name" };

  // Require SOMETHING to write: either a full readme or a description.
  const hasReadme = typeof input.readme === "string" && input.readme.trim().length > 0;
  const hasDescription =
    typeof input.description === "string" && input.description.trim().length > 0;
  if (!hasReadme && !hasDescription) {
    return { ok: false, created: false, error: "invalid_body" };
  }

  const storeDir = skillsStoreDir();
  const targetDir = join(storeDir, skillName);
  const created = !existsSync(targetDir);

  const content = hasReadme ? (input.readme as string) : synthesizeSkillMd(skillName, input);

  const stagingDir = `${targetDir}.publishing-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "SKILL.md"), content);
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(storeDir, { recursive: true });
    renameSync(stagingDir, targetDir);
    return { ok: true, created };
  } catch {
    try {
      if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return { ok: false, created: false, error: "write_failed" };
  }
}

/**
 * Delete a skill from the GLOBAL registry. Per-agent INSTALLED copies are
 * independent snapshots and are intentionally NOT touched — removing a skill
 * from the catalog must not yank it out from under agents already using it.
 * Returns true if a skill was removed, false if it did not exist / failed.
 */
export function deleteSkillFromStore(skillName: string): boolean {
  if (!isSafeSkillName(skillName)) return false;
  const skillDir = join(skillsStoreDir(), skillName);
  if (!existsSync(skillDir)) return false;
  try {
    rmSync(skillDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * List skills installed for a specific agent.
 */
export function listInstalledSkillsForAgent(agentId: string): SkillManifest[] {
  const agentSkills = agentSkillsDir(agentId);
  if (!existsSync(agentSkills)) return [];

  const out: SkillManifest[] = [];
  try {
    const entries = readdirSync(agentSkills);
    for (const entry of entries) {
      const skillDir = join(agentSkills, entry);
      if (!statSync(skillDir).isDirectory()) continue;
      const manifest = parseSkillMetadata(skillDir, entry);
      if (manifest) out.push(manifest);
    }
  } catch {
    // Return empty
  }
  return out;
}

/**
 * Get details about an installed skill for an agent.
 */
export function getInstalledSkillDetail(agentId: string, skillName: string): SkillDetail | null {
  if (!isSafeSkillName(skillName)) return null;
  const skillDir = join(agentSkillsDir(agentId), skillName);
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) return null;

  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) return null;

  const manifest = parseSkillMetadata(skillDir, skillName);
  if (!manifest) return null;

  let readme = "";
  try {
    readme = readFileSync(skillMdPath, "utf8");
  } catch {
    // Keep empty
  }

  const files: string[] = [];
  try {
    const entries = readdirSync(skillDir);
    for (const entry of entries) {
      const fullPath = join(skillDir, entry);
      if (statSync(fullPath).isDirectory()) {
        files.push(`${entry}/`);
        try {
          const subEntries = readdirSync(fullPath);
          for (const subEntry of subEntries) {
            files.push(`${entry}/${subEntry}`);
          }
        } catch {
          // Ignore
        }
      } else {
        files.push(entry);
      }
    }
  } catch {
    // Keep empty
  }

  return {
    ...manifest,
    readme,
    files,
    dependencies: [],
  };
}

/**
 * Install a skill to an agent by copying from the global store.
 * Returns true on success, false on failure.
 */
export function installSkillToAgent(agentId: string, skillName: string): boolean {
  // Reject traversal/separator names before touching the filesystem.
  if (!isSafeSkillName(skillName)) return false;

  const storeDir = skillsStoreDir();
  const sourceDir = join(storeDir, skillName);
  const targetDir = join(agentSkillsDir(agentId), skillName);

  // Verify source exists
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) return false;
  const skillMdPath = join(sourceDir, "SKILL.md");
  if (!existsSync(skillMdPath)) return false;

  // Copy atomically-ish: stage into a temp dir, then swap into place, so a
  // mid-copy failure never leaves a partially-installed skill that later reads
  // treat as installed. (CodeRabbit: partial installs leave corrupted state.)
  const stagingDir = `${targetDir}.installing-${process.pid}-${Date.now()}`;
  try {
    // cpSync preserves mode bits (executable skill scripts keep +x).
    cpSync(sourceDir, stagingDir, { recursive: true, preserveTimestamps: true });
    // Remove any prior install, then move staging into place.
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(join(targetDir, ".."), { recursive: true });
    // rename is atomic within the same filesystem.
    renameSync(stagingDir, targetDir);
    return true;
  } catch {
    // Clean up the staging dir on any failure so no partial state remains.
    try {
      if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return false;
  }
}

/**
 * Uninstall a skill from an agent (remove the installed copy).
 * Returns true on success, false on failure.
 */
export function uninstallSkillFromAgent(agentId: string, skillName: string): boolean {
  // Reject traversal/separator names — this path is fed to a recursive delete.
  if (!isSafeSkillName(skillName)) return false;
  const skillDir = join(agentSkillsDir(agentId), skillName);
  if (!existsSync(skillDir)) return false;

  try {
    rmSync(skillDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a skill is installed for an agent.
 */
export function isSkillInstalledForAgent(agentId: string, skillName: string): boolean {
  if (!isSafeSkillName(skillName)) return false;
  const skillDir = join(agentSkillsDir(agentId), skillName);
  return existsSync(skillDir) && statSync(skillDir).isDirectory();
}

/**
 * Lightweight `{ name, description }` listing of an agent's installed
 * skills. This is the PROGRESSIVE-DISCLOSURE source: it parses the small
 * per-skill manifests (frontmatter / metadata.json) via
 * listInstalledSkillsForAgent — it never reads SKILL.md BODIES. The full
 * body is retrieved on demand only, via getInstalledSkillDetail
 * (GET /v1/agents/{id}/skills/{name}).
 *
 * Used to build the per-turn "Available Skills" system block so the
 * context carries a compact one-line-per-skill index instead of the full
 * O(installed-skills × body-size) text every turn.
 */
export function readInstalledSkillDescriptions(
  agentId: string,
): { name: string; description: string }[] {
  return listInstalledSkillsForAgent(agentId).map((m) => ({
    name: m.name,
    description: m.description,
  }));
}

/**
 * Read all installed SKILL.md files for an agent and return their content.
 *
 * NOTE: This reads the FULL SKILL.md body for every installed skill and is
 * therefore expensive. It MUST NOT be used for per-turn context injection
 * (that pollutes every turn with O(installed-skills × body) text — see
 * readInstalledSkillDescriptions for the progressive-disclosure path).
 * Retained for any caller that genuinely needs the full bodies in bulk.
 */
export function readInstalledSkillContents(agentId: string): string[] {
  const agentSkills = agentSkillsDir(agentId);
  if (!existsSync(agentSkills)) return [];

  const contents: string[] = [];
  try {
    const entries = readdirSync(agentSkills);
    for (const entry of entries) {
      const skillDir = join(agentSkills, entry);
      if (!statSync(skillDir).isDirectory()) continue;
      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;
      try {
        const content = readFileSync(skillMdPath, "utf8");
        contents.push(content);
      } catch {
        // Skip files we can't read
      }
    }
  } catch {
    // Return what we have
  }
  return contents;
}

// ──────────────────────────────────────────────────────────────────────
// Progressive-disclosure system-context injection
//
// The skills index is injected into the agent's SYSTEM CONTEXT (not the
// user message) via the LocalBackend memfs mechanism: every `.md` file in
// `<storageDir>/memfs/<agent>/memory/system/` is read by letta-code as a
// memory block and included in the agent's persistent context every turn
// (see readBlocksForAgent + lib/a2ui-adapter.ts for the same pattern).
//
// We write ONLY a compact `name: description` index here — never the full
// SKILL.md bodies. The full body is retrieved on demand via
// getInstalledSkillDetail (GET /v1/agents/{id}/skills/{name}). Unlike the
// static A2UI block, the skills list is dynamic (install/uninstall), so we
// re-sync write-if-changed rather than write-if-absent.
// ──────────────────────────────────────────────────────────────────────

/** Memory-block label for the per-agent installed-skills index. */
export const SKILLS_BLOCK_LABEL = "available_skills";

/**
 * Build the compact, descriptions-only "Available Skills" block content.
 * One line per installed skill (`- <name>: <description>`) plus a short
 * instruction telling the agent the full instructions can be loaded on
 * demand. Returns null when no skills are installed (caller removes any
 * stale block in that case).
 */
export function buildSkillsBlockContent(
  skills: { name: string; description: string }[],
): string | null {
  if (skills.length === 0) return null;
  const lines = skills.map((s) =>
    s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`,
  );
  return [
    "## Available Skills",
    "",
    "The following skills are installed for you. Each line is `name: description`.",
    "Load a skill's full instructions on demand only when you actually need it",
    "(e.g. fetch GET /v1/agents/{id}/skills/{name}); the full skill bodies are NOT",
    "inlined here to keep this context compact.",
    "",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Sync the per-agent installed-skills index into the agent's system-context
 * memfs block (`available_skills.md`). Idempotent and write-if-changed:
 *   - no installed skills        → remove any stale block file
 *   - installed skills present   → write the compact descriptions-only block
 *     iff its content differs from what's on disk
 *
 * This is called once per turn from chat.ts. It is cheap: it parses the
 * small per-skill manifests (NOT SKILL.md bodies) and only touches disk
 * when the rendered index actually changed.
 */
export function syncSkillsBlockForAgent(agentId: string): void {
  const sysDir = join(storageDir(), "memfs", agentId, "memory", "system");
  const blockPath = join(sysDir, `${SKILLS_BLOCK_LABEL}.md`);
  try {
    const skills = readInstalledSkillDescriptions(agentId);
    const next = buildSkillsBlockContent(skills);

    if (next === null) {
      // No skills installed — drop any stale block so we don't leave a
      // dangling (or empty) "Available Skills" section in context.
      if (existsSync(blockPath)) rmSync(blockPath, { force: true });
      return;
    }

    if (!existsSync(sysDir)) mkdirSync(sysDir, { recursive: true });
    const current = existsSync(blockPath) ? readFileSync(blockPath, "utf8") : null;
    if (current !== next) writeFileSync(blockPath, next);
  } catch {
    // Non-fatal: missing the index for one turn is far better than failing
    // the turn on an unrelated FS error.
  }
}

/**
 * Search skills by tag or keyword in name/description.
 */
export function searchSkills(query: string, tags?: string[]): SkillListingItem[] {
  const allSkills = listAvailableSkills();
  const q = query.toLowerCase();
  const tagSet = new Set((tags ?? []).map((t) => t.toLowerCase()));

  return allSkills.filter((skill) => {
    // Match by query string
    if (q) {
      const nameMatch = skill.name.toLowerCase().includes(q);
      const descMatch = skill.description.toLowerCase().includes(q);
      if (!nameMatch && !descMatch) return false;
    }

    // Match by tags (if any tags specified)
    if (tagSet.size > 0) {
      const skillTags = new Set(skill.tags.map((t) => t.toLowerCase()));
      const hasMatch = [...tagSet].some((t) => skillTags.has(t));
      if (!hasMatch) return false;
    }

    return true;
  });
}

function skillToSlashCommand(
  skill: SkillManifest,
  source: "global_skill" | "agent_skill",
  installed: boolean,
): SkillSlashCommand {
  return {
    name: skill.name,
    command: `/${skill.name}`,
    description: skill.description,
    skill_name: skill.name,
    source,
    installed,
  };
}

export function listBuiltinGoalSlashCommands(): SkillSlashCommand[] {
  const mk = (name: string, command: string, description: string): SkillSlashCommand => ({
    name,
    command,
    description,
    skill_name: "__builtin_goal_mode__",
    source: "builtin_goal",
    installed: true,
  });
  return [
    mk("goal", "/goal", "Show the current native Letta Code Goal mode status."),
    mk("goal status", "/goal status", "Show the current goal, active time, and token usage."),
    mk("goal pause", "/goal pause", "Pause autonomous continuation for the current goal."),
    mk("goal resume", "/goal resume", "Resume a paused goal."),
    mk("goal complete", "/goal complete", "Mark the current goal complete after verification."),
    mk("goal clear", "/goal clear", "Remove the current conversation goal."),
    mk("goal disable", "/goal disable", "Clear the goal and disable goal tools for this conversation."),
    mk("goal replace", "/goal --replace", "Replace the current goal with a new objective."),
    mk("goal budget", "/goal --token-budget", "Start a goal with a token budget."),
  ];
}

export function listSkillSlashCommands(agentId?: string): SkillSlashCommand[] {
  const builtins = listBuiltinGoalSlashCommands();
  if (agentId) {
    return [
      ...builtins,
      ...listInstalledSkillsForAgent(agentId).map((skill) => skillToSlashCommand(skill, "agent_skill", true)),
    ].sort((a, b) => a.command.localeCompare(b.command));
  }

  return [
    ...builtins,
    ...listAvailableSkills().map((skill) => skillToSlashCommand(skill, "global_skill", skill.installed_count > 0)),
  ].sort((a, b) => a.command.localeCompare(b.command));
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
