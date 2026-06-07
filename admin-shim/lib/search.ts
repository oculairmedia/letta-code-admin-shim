/**
 * Derived FTS5 search index over canonical MemFS state (lcp-c61s).
 *
 * CORE MODEL: MemFS is CANONICAL. This index is a DERIVED, deletable,
 * rebuildable projection — never a source of truth. `rm -rf` the search dir
 * and MemFS is untouched; the next search rebuilds it. Nothing reads this
 * index as authoritative; it only accelerates keyword search.
 *
 * Storage: under the real storage dir (LETTA_LOCAL_BACKEND_DIR ||
 * $LETTA_HOME/lc-local-backend), per-agent at
 *   <storageDir>/search/<agentId>/{index.sqlite, manifest.json, index.lock/}
 *
 * The search dir is deliberately kept OUT of the git-backed memfs/<agent>/memory
 * tree (which letta-code commits) so the derived index never pollutes the
 * canonical, version-controlled memory repo.
 *
 * Indexed entities (entity_type):
 *   - block        : memory blocks under memfs/<agent>/memory/system/*.md
 *   - message      : per-conversation messages.jsonl rows
 *   - conversation : conversation.json title/summary
 *
 * FTS5 schema:
 *   CREATE VIRTUAL TABLE search USING fts5(
 *     entity_type, entity_id, conversation_id, agent_id, content,
 *     tokenize='porter unicode61')
 *
 * Freshness / incremental build:
 *   manifest.json tracks last_indexed_mtime (max source mtime folded in),
 *   message_count, block_count, and a `signature` (a cheap content-set hash:
 *   sorted list of source paths + size + mtime). On each ensureIndex we
 *   recompute the signature; if it DIFFERS from the manifest we rebuild the
 *   affected rows incrementally. If the change is non-monotonic — i.e. a
 *   source file's mtime went BACKWARDS, or the file set shrank/grew in a way
 *   mtime alone can't express (git pull / checkout rewriting old files) — we
 *   force a FULL rebuild rather than silently serving stale results.
 *
 * Concurrency: a per-agent mkdir-lock (the same pattern as crons.ts /
 * permissions.ts) serialises ALL index mutations, so a background rebuild and
 * a lazy incremental build triggered by a concurrent search can never race
 * index.sqlite. Rebuild is idempotent.
 *
 * Scoring: FTS5 `rank` only (keyword relevance), surfaced as `score` with
 * `score_type: "keyword"`. NO fabricated semantic similarity.
 */

import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  _internals as storeInternals,
  listConversationsForAgent,
  listMessages,
  readBlocksForAgent,
} from "./store.js";
import type { LocalMessage, LocalMessagePart } from "./types/letta-stream.js";

// ── storage paths ──────────────────────────────────────────────────────

function storageDir(): string {
  // Reuse store.ts' resolution (LETTA_LOCAL_BACKEND_DIR || $LETTA_HOME/...);
  // do NOT hardcode ~/.letta. The _internals hook is store.ts' documented
  // test/debug surface and is the single source of truth for this path.
  return storeInternals.storageDir();
}

/** Per-agent derived-index directory, kept out of the git-backed memory tree. */
export function searchDir(agentId: string): string {
  return join(storageDir(), "search", agentId);
}

function indexPath(agentId: string): string {
  return join(searchDir(agentId), "index.sqlite");
}

function manifestPath(agentId: string): string {
  return join(searchDir(agentId), "manifest.json");
}

function lockDirPath(agentId: string): string {
  return join(searchDir(agentId), "index.lock");
}

// ── manifest ───────────────────────────────────────────────────────────

export interface SearchManifest {
  /** Max source-file mtimeMs folded into the current index. */
  last_indexed_mtime: number;
  /** ISO wall-clock time the index last completed a (full or incremental) build. */
  last_indexed: string | null;
  message_count: number;
  block_count: number;
  /**
   * Cheap content-set signature: sha256 over the sorted set of
   * `path:size:mtimeMs` for every indexed source file. Detects bulk /
   * non-monotonic MemFS change (git pull/checkout) that mtime-max alone
   * misses — a changed signature with no forward mtime movement forces a
   * full rebuild instead of serving stale results.
   */
  signature: string;
}

const EMPTY_MANIFEST: SearchManifest = {
  last_indexed_mtime: 0,
  last_indexed: null,
  message_count: 0,
  block_count: 0,
  signature: "",
};

function readManifest(agentId: string): SearchManifest | null {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(agentId), "utf8")) as Partial<SearchManifest>;
    if (typeof raw !== "object" || raw === null) return null;
    return {
      last_indexed_mtime: Number(raw.last_indexed_mtime) || 0,
      last_indexed: typeof raw.last_indexed === "string" ? raw.last_indexed : null,
      message_count: Number(raw.message_count) || 0,
      block_count: Number(raw.block_count) || 0,
      signature: typeof raw.signature === "string" ? raw.signature : "",
    };
  } catch {
    return null;
  }
}

function writeManifest(agentId: string, m: SearchManifest): void {
  mkdirSync(searchDir(agentId), { recursive: true });
  const tmp = `${manifestPath(agentId)}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n");
  // rename is atomic on the same fs — readers never see a torn manifest.
  // (writeFileSync + rename mirrors store.ts atomicWriteJson.)
  renameSync(tmp, manifestPath(agentId));
}

// ── per-agent mkdir-lock (mirrors crons.ts / permissions.ts) ───────────

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_AGE_MS = 5 * 60_000;
const LOCK_OWNER_FILE = "owner.json";

interface LockOwner {
  pid: number;
  token: string;
  acquired_at: number;
}

function sleepBusy(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_FILE), "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

function isLockStale(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  if (!owner) {
    try {
      return Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_AGE_MS;
    } catch {
      return true;
    }
  }
  let pidDead = false;
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    pidDead = (err as NodeJS.ErrnoException).code === "ESRCH";
  }
  return pidDead && Date.now() - owner.acquired_at > LOCK_STALE_AGE_MS;
}

interface LockHandle {
  release(): void;
}

function acquireIndexLock(agentId: string): LockHandle {
  const lockDir = lockDirPath(agentId);
  mkdirSync(searchDir(agentId), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomBytes(4).toString("hex");
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir, { recursive: false });
      const owner: LockOwner = { pid: process.pid, token, acquired_at: Date.now() };
      writeFileSync(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(owner));
      return {
        release() {
          try {
            const current = readLockOwner(lockDir);
            if (current && current.token === token) {
              rmSync(lockDir, { recursive: true, force: true });
            }
          } catch {
            // best-effort; stale detection covers leaks.
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isLockStale(lockDir)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* next mkdir surfaces real failures */
        }
        continue;
      }
      sleepBusy(Math.min(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS, deadline - Date.now()));
    }
  }
  throw new Error(`search index lock for ${agentId} timed out after ${LOCK_TIMEOUT_MS}ms`);
}

function withIndexLock<T>(agentId: string, fn: () => T): T {
  const lock = acquireIndexLock(agentId);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

// ── source enumeration (canonical paths + mtimes for signature) ────────

interface SourceFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** memfs/<agent>/memory/system/*.md — the memory blocks. */
function blockSourceFiles(agentId: string): SourceFile[] {
  const dir = join(storageDir(), "memfs", agentId, "memory", "system");
  if (!existsSync(dir)) return [];
  const out: SourceFile[] = [];
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith(".md")) continue;
    const p = join(dir, fname);
    try {
      const st = statSync(p);
      out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* file vanished mid-scan; skip */
    }
  }
  return out;
}

/**
 * conversation dirs for this agent: each contributes conversation.json
 * (title/summary) + messages.jsonl. Returns the encoded conversation key
 * (the LocalStore-internal key) so we can map files back to entities.
 */
interface ConvSource {
  conversationId: string;
  agentId: string;
  convJson: SourceFile | null;
  messages: SourceFile | null;
}

async function conversationSources(agentId: string): Promise<ConvSource[]> {
  const convs = await listConversationsForAgent(agentId);
  const out: ConvSource[] = [];
  for (const conv of convs) {
    const conversationId = typeof conv.id === "string" ? conv.id : "default";
    const key =
      conversationId === "default" ? `default:${agentId}` : `conversation:${conversationId}`;
    const dir = join(storageDir(), "conversations", storeInternals.b64url(key));
    const stat = (p: string): SourceFile | null => {
      try {
        const st = statSync(p);
        return { path: p, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    };
    out.push({
      conversationId,
      agentId,
      convJson: stat(join(dir, "conversation.json")),
      messages: stat(join(dir, "messages.jsonl")),
    });
  }
  return out;
}

/**
 * Cheap content-set signature over every source file. A change in this hash
 * with NO forward movement of last_indexed_mtime is the bulk/non-monotonic
 * signal (git pull/checkout rewriting older files) → full rebuild.
 */
function computeSignature(files: SourceFile[]): { signature: string; maxMtime: number } {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash("sha256");
  let maxMtime = 0;
  for (const f of sorted) {
    h.update(`${f.path}:${f.size}:${f.mtimeMs}\n`);
    if (f.mtimeMs > maxMtime) maxMtime = f.mtimeMs;
  }
  return { signature: h.digest("hex"), maxMtime };
}

// ── content extraction ─────────────────────────────────────────────────

function partText(part: LocalMessagePart): string {
  if (!part || typeof part !== "object") return "";
  const p = part as Record<string, unknown>;
  const out: string[] = [];
  if (typeof p["text"] === "string") out.push(p["text"]);
  // tool call args / tool return text carry searchable content too.
  if (typeof p["tool_return"] === "string") out.push(p["tool_return"]);
  if (typeof p["errorText"] === "string") out.push(p["errorText"]);
  const args = p["arguments"];
  if (typeof args === "string") out.push(args);
  else if (args && typeof args === "object") {
    try {
      out.push(JSON.stringify(args));
    } catch {
      /* ignore unserialisable */
    }
  }
  const input = p["input"];
  if (typeof input === "string") out.push(input);
  else if (input && typeof input === "object") {
    try {
      out.push(JSON.stringify(input));
    } catch {
      /* ignore */
    }
  }
  return out.join(" ");
}

function messageText(m: LocalMessage): string {
  const parts = Array.isArray(m.parts) ? m.parts : [];
  return parts.map(partText).filter(Boolean).join("\n").trim();
}

/** message_type derived from role/parts, aligned with the wire projection. */
function messageType(m: LocalMessage): string {
  if (m.role === "user") return "user_message";
  if (m.role === "system") return "system_message";
  if (m.role === "tool" || m.role === "toolResult") return "tool_return_message";
  return "assistant_message";
}

// ── sqlite / FTS5 ──────────────────────────────────────────────────────

function openDb(agentId: string): DatabaseSync {
  mkdirSync(searchDir(agentId), { recursive: true });
  const db = new DatabaseSync(indexPath(agentId));
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(" +
      "entity_type, entity_id, conversation_id, agent_id, content, " +
      "tokenize='porter unicode61')",
  );
  return db;
}

interface IndexedRow {
  entity_type: "block" | "message" | "conversation";
  entity_id: string;
  conversation_id: string;
  agent_id: string;
  content: string;
}

/**
 * Collect every indexable row for an agent from CANONICAL state. Returns the
 * rows plus counts so the manifest can record them.
 */
async function collectRows(
  agentId: string,
): Promise<{ rows: IndexedRow[]; blockCount: number; messageCount: number }> {
  const rows: IndexedRow[] = [];

  // blocks: name(label) + description + content
  const blocks = readBlocksForAgent(agentId);
  for (const b of blocks) {
    const content = [b.label, b.description ?? "", b.value ?? ""].filter(Boolean).join("\n");
    rows.push({
      entity_type: "block",
      entity_id: b.id,
      conversation_id: "",
      agent_id: agentId,
      content,
    });
  }

  // conversations + messages
  const convs = await listConversationsForAgent(agentId);
  let messageCount = 0;
  for (const conv of convs) {
    const conversationId = typeof conv.id === "string" ? conv.id : "default";
    const title = typeof conv["title"] === "string" ? (conv["title"] as string) : "";
    const summary = typeof conv.summary === "string" ? conv.summary : "";
    const convContent = [title, summary].filter(Boolean).join("\n");
    if (convContent) {
      rows.push({
        entity_type: "conversation",
        entity_id: conversationId,
        conversation_id: conversationId,
        agent_id: agentId,
        content: convContent,
      });
    }
    const messages = await listMessages(conversationId, agentId);
    for (const m of messages) {
      const content = messageText(m);
      if (!content) continue;
      messageCount += 1;
      rows.push({
        entity_type: "message",
        entity_id: m.id,
        conversation_id: conversationId,
        agent_id: agentId,
        content: `${m.role} ${messageType(m)}\n${content}`,
      });
    }
  }

  return { rows, blockCount: blocks.length, messageCount };
}

/**
 * Full (re)build: drop everything and re-insert from canonical state. Holds
 * the per-agent lock for the whole operation so it can't race a concurrent
 * search-triggered build. Idempotent — running twice yields the same index.
 */
async function fullRebuild(agentId: string): Promise<SearchManifest> {
  const { rows, blockCount, messageCount } = await collectRows(agentId);
  const files = [
    ...blockSourceFiles(agentId),
    ...(await conversationSources(agentId)).flatMap((c) =>
      [c.convJson, c.messages].filter((f): f is SourceFile => f !== null),
    ),
  ];
  const { signature, maxMtime } = computeSignature(files);

  return withIndexLock(agentId, () => {
    const db = openDb(agentId);
    try {
      db.exec("BEGIN");
      db.exec("DELETE FROM search");
      const ins = db.prepare(
        "INSERT INTO search(entity_type, entity_id, conversation_id, agent_id, content) " +
          "VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of rows) {
        ins.run(r.entity_type, r.entity_id, r.conversation_id, r.agent_id, r.content);
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      db.close();
    }
    const manifest: SearchManifest = {
      last_indexed_mtime: maxMtime,
      last_indexed: new Date().toISOString(),
      message_count: messageCount,
      block_count: blockCount,
      signature,
    };
    writeManifest(agentId, manifest);
    return manifest;
  });
}

/**
 * Decide whether the on-disk index is fresh, can be incrementally updated, or
 * must be fully rebuilt — WITHOUT taking the lock (cheap stat-only pass).
 *
 *   - "fresh"       : signature matches manifest; nothing to do.
 *   - "incremental" : signature changed but monotonically (only forward mtime
 *                     movement, no removed files) → update changed entities.
 *   - "full"        : no index/manifest yet, OR non-monotonic change (a source
 *                     mtime went backwards or the file set shrank — git
 *                     pull/checkout) → rebuild from scratch, never serve stale.
 */
type BuildPlan = "fresh" | "incremental" | "full";

interface PlanResult {
  plan: BuildPlan;
  signature: string;
  maxMtime: number;
  files: SourceFile[];
}

async function planBuild(agentId: string): Promise<PlanResult> {
  const files = [
    ...blockSourceFiles(agentId),
    ...(await conversationSources(agentId)).flatMap((c) =>
      [c.convJson, c.messages].filter((f): f is SourceFile => f !== null),
    ),
  ];
  const { signature, maxMtime } = computeSignature(files);
  const manifest = readManifest(agentId);
  const haveIndex = existsSync(indexPath(agentId)) && manifest !== null;

  if (!haveIndex) return { plan: "full", signature, maxMtime, files };
  if (manifest.signature === signature) return { plan: "fresh", signature, maxMtime, files };

  // Signature changed. Is it monotonic (purely additive / forward)?
  // Non-monotonic if ANY current source has an mtime OLDER than what we last
  // indexed (a file was rewritten with an older timestamp — git checkout), or
  // if the indexed file *set* shrank. We can't cheaply know the old set from
  // the signature alone, so we use two cheap signals:
  //   (a) any file mtime < last_indexed_mtime  → backwards in time
  //   (b) total file count decreased vs what we'd expect from the manifest
  //       counts (best-effort; counts aren't file counts, so we lean on (a)
  //       plus the maxMtime-not-advancing check below).
  const anyBackwards = files.some((f) => f.mtimeMs < manifest.last_indexed_mtime);
  const maxAdvanced = maxMtime > manifest.last_indexed_mtime;
  if (anyBackwards || !maxAdvanced) {
    // Content changed but the newest mtime did NOT advance past what we already
    // folded in — classic git-pull-with-older-mtimes. mtime-incremental would
    // silently serve stale results, so force a FULL rebuild.
    return { plan: "full", signature, maxMtime, files };
  }
  return { plan: "incremental", signature, maxMtime, files };
}

/**
 * Incremental update: re-index only entities whose source advanced past
 * last_indexed_mtime. Runs under the lock. Always rewrites the full set of
 * rows for any conversation/block that changed (delete-then-insert that
 * conversation's rows), which keeps it idempotent and correct without
 * per-message diffing.
 */
async function incrementalUpdate(agentId: string, prev: SearchManifest): Promise<SearchManifest> {
  const cutoff = prev.last_indexed_mtime;
  const blocks = readBlocksForAgent(agentId);
  const blockFiles = blockSourceFiles(agentId);
  const blocksChanged = blockFiles.some((f) => f.mtimeMs > cutoff);

  const convSources = await conversationSources(agentId);
  const changedConvs = convSources.filter(
    (c) =>
      (c.convJson && c.convJson.mtimeMs > cutoff) ||
      (c.messages && c.messages.mtimeMs > cutoff),
  );

  // Gather replacement rows for changed entities only.
  const blockRows: IndexedRow[] = [];
  if (blocksChanged) {
    for (const b of blocks) {
      const content = [b.label, b.description ?? "", b.value ?? ""].filter(Boolean).join("\n");
      blockRows.push({
        entity_type: "block",
        entity_id: b.id,
        conversation_id: "",
        agent_id: agentId,
        content,
      });
    }
  }

  const convRowMap = new Map<string, IndexedRow[]>();
  let messageDelta = 0;
  for (const c of changedConvs) {
    const conversationId = c.conversationId;
    const rows: IndexedRow[] = [];
    const conv = (await listConversationsForAgent(agentId)).find(
      (x) => (typeof x.id === "string" ? x.id : "default") === conversationId,
    );
    const title = conv && typeof conv["title"] === "string" ? (conv["title"] as string) : "";
    const summary = conv && typeof conv.summary === "string" ? conv.summary : "";
    const convContent = [title, summary].filter(Boolean).join("\n");
    if (convContent) {
      rows.push({
        entity_type: "conversation",
        entity_id: conversationId,
        conversation_id: conversationId,
        agent_id: agentId,
        content: convContent,
      });
    }
    const messages = await listMessages(conversationId, agentId);
    for (const m of messages) {
      const content = messageText(m);
      if (!content) continue;
      messageDelta += 1;
      rows.push({
        entity_type: "message",
        entity_id: m.id,
        conversation_id: conversationId,
        agent_id: agentId,
        content: `${m.role} ${messageType(m)}\n${content}`,
      });
    }
    convRowMap.set(conversationId, rows);
  }

  const allFiles = [
    ...blockFiles,
    ...convSources.flatMap((c) =>
      [c.convJson, c.messages].filter((f): f is SourceFile => f !== null),
    ),
  ];
  const { signature, maxMtime } = computeSignature(allFiles);

  return withIndexLock(agentId, () => {
    const db = openDb(agentId);
    let priorMsgInChanged = 0;
    try {
      db.exec("BEGIN");
      if (blocksChanged) {
        db.exec("DELETE FROM search WHERE entity_type = 'block'");
        const ins = db.prepare(
          "INSERT INTO search(entity_type, entity_id, conversation_id, agent_id, content) " +
            "VALUES (?, ?, ?, ?, ?)",
        );
        for (const r of blockRows) {
          ins.run(r.entity_type, r.entity_id, r.conversation_id, r.agent_id, r.content);
        }
      }
      const delConv = db.prepare(
        "DELETE FROM search WHERE conversation_id = ? AND entity_type IN ('message','conversation')",
      );
      const countConv = db.prepare(
        "SELECT count(*) AS n FROM search WHERE conversation_id = ? AND entity_type = 'message'",
      );
      const ins = db.prepare(
        "INSERT INTO search(entity_type, entity_id, conversation_id, agent_id, content) " +
          "VALUES (?, ?, ?, ?, ?)",
      );
      for (const [conversationId, rows] of convRowMap) {
        const before = countConv.get(conversationId) as { n: number } | undefined;
        priorMsgInChanged += before?.n ?? 0;
        delConv.run(conversationId);
        for (const r of rows) {
          ins.run(r.entity_type, r.entity_id, r.conversation_id, r.agent_id, r.content);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      db.close();
    }
    const manifest: SearchManifest = {
      last_indexed_mtime: maxMtime,
      last_indexed: new Date().toISOString(),
      // message_count = previous total - messages we removed from changed
      // convs + messages we re-inserted for them.
      message_count: prev.message_count - priorMsgInChanged + messageDelta,
      block_count: blocksChanged ? blockRows.length : prev.block_count,
      signature,
    };
    writeManifest(agentId, manifest);
    return manifest;
  });
}

// ── public API ─────────────────────────────────────────────────────────

/** In-process guard so two awaited ensureIndex calls in the SAME process
 *  coalesce onto one build promise per agent (the mkdir-lock still guards
 *  cross-process). Keyed by agentId. */
const inflightBuilds = new Map<string, Promise<SearchManifest>>();

/** Hard cap (ms) on the synchronous cold-build before we hand back a
 *  202/indexing response and let the build finish in the background. */
const COLD_BUILD_CAP_MS = Number(process.env["SHIM_SEARCH_COLD_CAP_MS"] ?? 5000);

function runPlan(agentId: string, plan: PlanResult, prev: SearchManifest | null): Promise<SearchManifest> {
  if (plan.plan === "fresh") {
    return Promise.resolve(prev ?? readManifest(agentId) ?? EMPTY_MANIFEST);
  }
  if (plan.plan === "incremental" && prev) {
    return incrementalUpdate(agentId, prev);
  }
  return fullRebuild(agentId);
}

/** Coalesced build dispatch — one in-flight build per agent per process. */
function dispatchBuild(agentId: string): Promise<SearchManifest> {
  const existing = inflightBuilds.get(agentId);
  if (existing) return existing;
  const p = (async () => {
    const plan = await planBuild(agentId);
    const prev = readManifest(agentId);
    return runPlan(agentId, plan, prev);
  })().finally(() => {
    inflightBuilds.delete(agentId);
  });
  inflightBuilds.set(agentId, p);
  return p;
}

export interface EnsureIndexResult {
  /** True once the index reflects current canonical state and is queryable. */
  ready: boolean;
  /** True if a build is still running in the background (cold path). */
  indexing: boolean;
  manifest: SearchManifest;
}

/**
 * Ensure the index is fresh, with a BOUNDED cold path. If the build (full or
 * incremental) completes within COLD_BUILD_CAP_MS it returns ready=true. If it
 * runs past the cap, it returns ready=false / indexing=true immediately while
 * the build continues in the background — the caller responds 202 and the
 * client polls /search/status. This guarantees we never hold an HTTP request
 * open for a ~30s cold build.
 */
export async function ensureIndex(agentId: string): Promise<EnsureIndexResult> {
  // Fast path: stat-only plan; if fresh, return immediately.
  const plan = await planBuild(agentId);
  const prev = readManifest(agentId);
  if (plan.plan === "fresh" && prev) {
    return { ready: true, indexing: false, manifest: prev };
  }

  const buildPromise = dispatchBuild(agentId);
  let timedOut = false;
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, COLD_BUILD_CAP_MS).unref?.();
  });
  const outcome = await Promise.race([buildPromise.then(() => "done" as const), timeout]);
  if (outcome === "done" && !timedOut) {
    const manifest = readManifest(agentId) ?? EMPTY_MANIFEST;
    return { ready: true, indexing: false, manifest };
  }
  // Build still running — hand back the (possibly stale-or-empty) current
  // manifest and signal indexing. The background build keeps going.
  const manifest = readManifest(agentId) ?? EMPTY_MANIFEST;
  return { ready: false, indexing: true, manifest };
}

export interface SearchHit {
  entity_type: string;
  entity_id: string;
  conversation_id: string | null;
  agent_id: string;
  /** FTS5 rank — keyword relevance, NOT a semantic similarity score. */
  score: number;
  score_type: "keyword";
  /** FTS5 snippet() highlight; match wrapped in «…». */
  highlight: string;
}

export interface SearchResponse {
  query: string;
  agent_id: string;
  /** True when a cold/background build is still running; results may be partial. */
  indexing: boolean;
  last_indexed: string | null;
  results: SearchHit[];
}

/**
 * Run a keyword search. Triggers a lazy build first (bounded — see
 * ensureIndex). When the index isn't ready yet, returns indexing=true with
 * whatever the current index can serve (possibly empty) so the caller can
 * respond 202.
 */
export async function search(
  agentId: string,
  query: string,
  limit = 20,
): Promise<SearchResponse> {
  const q = (query ?? "").trim();
  const ensured = await ensureIndex(agentId);
  const base: SearchResponse = {
    query: q,
    agent_id: agentId,
    indexing: ensured.indexing,
    last_indexed: ensured.manifest.last_indexed,
    results: [],
  };
  if (!q) return base;
  if (!existsSync(indexPath(agentId))) return base;

  // Build a safe FTS5 MATCH expression. Tokenise on non-word chars and AND the
  // terms together as prefix-free quoted phrases so user punctuation can't
  // inject FTS5 syntax. Empty after tokenising → no results.
  const terms = q
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (terms.length === 0) return base;
  const matchExpr = terms.join(" ");

  const db = openDb(agentId);
  try {
    const rows = db
      .prepare(
        "SELECT entity_type, entity_id, conversation_id, agent_id, " +
          "rank AS score, " +
          "snippet(search, 4, '«', '»', '…', 12) AS highlight " +
          "FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(matchExpr, Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    base.results = rows.map((r) => ({
      entity_type: String(r["entity_type"]),
      entity_id: String(r["entity_id"]),
      conversation_id: r["conversation_id"] ? String(r["conversation_id"]) : null,
      agent_id: String(r["agent_id"]),
      score: Number(r["score"]),
      score_type: "keyword" as const,
      highlight: String(r["highlight"] ?? ""),
    }));
  } finally {
    db.close();
  }
  return base;
}

export interface SearchStatus {
  agent_id: string;
  indexed: boolean;
  indexing: boolean;
  last_indexed: string | null;
  message_count: number;
  block_count: number;
  size_bytes: number;
}

/** Honest freshness report. Does NOT trigger a build. */
export function getStatus(agentId: string): SearchStatus {
  const manifest = readManifest(agentId);
  const indexed = existsSync(indexPath(agentId)) && manifest !== null;
  let sizeBytes = 0;
  try {
    sizeBytes = statSync(indexPath(agentId)).size;
  } catch {
    sizeBytes = 0;
  }
  return {
    agent_id: agentId,
    indexed,
    indexing: inflightBuilds.has(agentId),
    last_indexed: manifest?.last_indexed ?? null,
    message_count: manifest?.message_count ?? 0,
    block_count: manifest?.block_count ?? 0,
    size_bytes: sizeBytes,
  };
}

/**
 * Explicit rebuild. Forces a FULL rebuild (idempotent, lock-serialised) and
 * returns immediately with a promise the caller can choose to await or detach.
 * The server handler detaches it (202) and lets it run in the background.
 */
export function rebuild(agentId: string): Promise<SearchManifest> {
  const existing = inflightBuilds.get(agentId);
  if (existing) return existing;
  const p = fullRebuild(agentId).finally(() => {
    inflightBuilds.delete(agentId);
  });
  inflightBuilds.set(agentId, p);
  return p;
}

/** Delete the entire derived index for an agent. MemFS is untouched. */
export function deleteIndex(agentId: string): void {
  rmSync(searchDir(agentId), { recursive: true, force: true });
}

export const _searchInternals = Object.freeze({
  searchDir,
  indexPath,
  manifestPath,
  readManifest,
  planBuild,
  fullRebuild,
  incrementalUpdate,
  COLD_BUILD_CAP_MS,
});
