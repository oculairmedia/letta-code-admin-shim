/**
 * Regression tests for the derived FTS5 search index (lcp-c61s).
 *
 * CORE MODEL under test: MemFS is canonical; the search index is a derived,
 * deletable, rebuildable projection. These tests build fixtures on disk under
 * a temp LETTA_LOCAL_BACKEND_DIR (mirrors permissions.test.ts / runs.test.ts)
 * and drive lib/search.ts directly.
 *
 * Coverage:
 *   1. FTS5 build + query returns expected hits (block + message + conversation).
 *   2. Incremental update picks up a changed file (newer mtime).
 *   3. Bulk / non-monotonic change (older mtime, git-pull style) triggers a
 *      FULL rebuild — assert the STALE result is NOT served.
 *   4. Rebuild is idempotent + lock-serialised (concurrent rebuild + search:
 *      no corruption).
 *   5. Status reports correct counts / freshness.
 *   6. Deleting the search dir then searching rebuilds; MemFS untouched.
 *   7. Empty query / no-index returns sensibly.
 *   8. No fabricated semantic score — score_type is "keyword".
 *
 * Authoritative runner (per lcp-indw / lcp-a0rl — the documented `npm test`
 * gives false greens):
 *   NODE_OPTIONS="--import tsx/esm" node --test --test-concurrency=1 \
 *     test/search.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  search,
  getStatus,
  rebuild,
  ensureIndex,
  deleteIndex,
  _searchInternals,
} from "../lib/search.js";

// The search index requires node:sqlite (Node >= 22.5). It is an OPTIONAL
// derived feature, so on older runtimes (e.g. Node 20 in CI) these tests skip
// rather than fail — the rest of the shim works without search. Importing
// lib/search.ts no longer crashes on Node 20 (sqlite is loaded lazily), so we
// can detect availability here without a top-level throw.
const SQLITE_AVAILABLE: boolean = (() => {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();
const skipNoSqlite = SQLITE_AVAILABLE ? undefined : "requires node:sqlite (Node >= 22.5)";

// ── fixture helpers ────────────────────────────────────────────────────

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function convKey(conversationId: string, agentId: string): string {
  return conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
}

interface MsgSpec {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
}

/** Write a memory block file under memfs/<agent>/memory/system/<label>.md. */
function writeBlock(dir: string, agentId: string, label: string, content: string): string {
  const sysDir = join(dir, "memfs", agentId, "memory", "system");
  mkdirSync(sysDir, { recursive: true });
  const p = join(sysDir, `${label}.md`);
  writeFileSync(p, content);
  return p;
}

/** Write a conversation (conversation.json + messages.jsonl). Returns paths. */
function writeConversation(
  dir: string,
  agentId: string,
  conversationId: string,
  opts: { summary?: string; title?: string; messages?: MsgSpec[] } = {},
): { convJson: string; messages: string } {
  const key = convKey(conversationId, agentId);
  const cdir = join(dir, "conversations", b64url(key));
  mkdirSync(cdir, { recursive: true });
  const convJson = join(cdir, "conversation.json");
  writeFileSync(
    convJson,
    JSON.stringify({
      id: conversationId,
      agent_id: agentId,
      summary: opts.summary ?? null,
      ...(opts.title ? { title: opts.title } : {}),
      last_message_at: "2026-06-01T00:00:00.000Z",
    }),
  );
  const lines: string[] = [
    JSON.stringify({ type: "session", version: 3, id: conversationId }),
  ];
  for (const m of opts.messages ?? []) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: m.id,
        message: {
          id: m.id,
          role: m.role,
          content: [{ type: "text", text: m.text }],
          metadata: { agent_id: agentId, conversation_id: conversationId },
        },
      }),
    );
  }
  const messages = join(cdir, "messages.jsonl");
  writeFileSync(messages, lines.join("\n") + "\n");
  return { convJson, messages };
}

/** Backdate a file's mtime by N seconds (simulate git checkout of old file). */
function backdate(path: string, secondsAgo: number): void {
  const t = Date.now() / 1000 - secondsAgo;
  utimesSync(path, t, t);
}

/** Bump a file's mtime forward (simulate a fresh write). */
function touchForward(path: string, secondsAhead = 5): void {
  const t = Date.now() / 1000 + secondsAhead;
  utimesSync(path, t, t);
}

async function withBackendDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "search-test-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

const AGENT = "agent-search-test-0001";

// ── 1. build + query ────────────────────────────────────────────────────

test("FTS5 build + query returns expected hits across blocks/messages/conversations", { skip: skipNoSqlite }, async () => {
  await withBackendDir(async (dir) => {
    writeBlock(dir, AGENT, "persona", "I am a helpful assistant fluent in TypeScript.");
    writeConversation(dir, AGENT, "conv-alpha", {
      summary: "Discussion about pelican migration patterns",
      messages: [
        { id: "m1", role: "user", text: "Where do pelicans migrate in winter?" },
        { id: "m2", role: "assistant", text: "Pelicans head toward warmer coastal waters." },
        { id: "m3", role: "user", text: "Tell me about quantum entanglement instead." },
      ],
    });

    const r = await search(AGENT, "pelican", 20);
    assert.equal(r.indexing, false, "small agent should build inline (ready)");
    assert.ok(r.results.length >= 2, `expected pelican hits, got ${r.results.length}`);
    const types = new Set(r.results.map((h) => h.entity_type));
    assert.ok(types.has("message"), "should hit a message");
    assert.ok(types.has("conversation"), "should hit the conversation summary");

    // porter stemming: "migrate" query matches "migration".
    const stem = await search(AGENT, "migrate", 20);
    assert.ok(stem.results.length >= 1, "porter stemming should match migration/migrate");

    // block content is searchable.
    const blk = await search(AGENT, "TypeScript", 20);
    assert.ok(
      blk.results.some((h) => h.entity_type === "block"),
      "block content should be indexed",
    );

    // score is honest keyword rank, NOT a fake semantic similarity.
    for (const h of r.results) {
      assert.equal(h.score_type, "keyword", "score must be labelled keyword");
      assert.equal(typeof h.score, "number");
    }
    // highlight wraps the match.
    const hit = r.results.find((h) => h.highlight.includes("«"));
    assert.ok(hit, "at least one hit should carry a « » highlight");
  });
});

// ── 2. incremental update picks up a changed file ───────────────────────

test("incremental update picks up a changed message file", { skip: skipNoSqlite }, async () => {
  await withBackendDir(async (dir) => {
    writeConversation(dir, AGENT, "conv-inc", {
      messages: [{ id: "m1", role: "user", text: "original content about otters" }],
    });
    let r = await search(AGENT, "otters", 20);
    assert.equal(r.results.length, 1);
    assert.equal((await search(AGENT, "narwhal", 20)).results.length, 0);

    // Append a new message with a FORWARD mtime (normal write).
    const { messages } = writeConversation(dir, AGENT, "conv-inc", {
      messages: [
        { id: "m1", role: "user", text: "original content about otters" },
        { id: "m2", role: "assistant", text: "here is a fact about a narwhal" },
      ],
    });
    touchForward(messages, 10);

    r = await search(AGENT, "narwhal", 20);
    assert.equal(r.results.length, 1, "incremental build should pick up the new message");
    // old content still present
    assert.equal((await search(AGENT, "otters", 20)).results.length, 1);
  });
});

// ── 3. bulk / non-monotonic change → full rebuild, no stale ─────────────

test("bulk/non-monotonic MemFS change triggers a full rebuild (stale not served)", { skip: skipNoSqlite }, async () => {
  await withBackendDir(async (dir) => {
    writeConversation(dir, AGENT, "conv-bulk", {
      messages: [{ id: "m1", role: "user", text: "the codeword is aardvark" }],
    });
    let r = await search(AGENT, "aardvark", 20);
    assert.equal(r.results.length, 1, "baseline index has aardvark");

    // Simulate a git pull/checkout: rewrite the file with DIFFERENT content
    // but an OLDER mtime than what we already indexed. A naive mtime-max
    // incremental would skip this and keep serving the stale 'aardvark' hit.
    const { messages } = writeConversation(dir, AGENT, "conv-bulk", {
      messages: [{ id: "m1", role: "user", text: "the codeword is buffalo now" }],
    });
    backdate(messages, 3600); // 1h in the past — non-monotonic

    // Stale term must be GONE (full rebuild fired), new term present.
    const stale = await search(AGENT, "aardvark", 20);
    assert.equal(stale.results.length, 0, "stale aardvark must NOT be served after bulk change");
    const fresh = await search(AGENT, "buffalo", 20);
    assert.equal(fresh.results.length, 1, "rebuilt index must reflect new content");
  });
});

// ── 4. rebuild idempotent + lock-serialised under concurrency ───────────

test("rebuild is idempotent and lock-serialised with a concurrent search (no corruption)", { skip: skipNoSqlite }, async () => {
  await withBackendDir(async (dir) => {
    writeBlock(dir, AGENT, "persona", "assistant loves capybaras");
    writeConversation(dir, AGENT, "conv-lock", {
      messages: [
        { id: "m1", role: "user", text: "capybara facts please" },
        { id: "m2", role: "assistant", text: "capybaras are the largest rodents" },
      ],
    });
    // Prime once.
    await rebuild(AGENT);
    const s1 = getStatus(AGENT);

    // Fire a rebuild and a search concurrently — they must not corrupt the db.
    const [, r] = await Promise.all([rebuild(AGENT), search(AGENT, "capybara", 20)]);
    assert.ok(r.results.length >= 1, "concurrent search still returns results");

    // Idempotent: a second rebuild yields the same counts.
    await rebuild(AGENT);
    const s2 = getStatus(AGENT);
    assert.equal(s2.message_count, s1.message_count, "message_count stable across rebuilds");
    assert.equal(s2.block_count, s1.block_count, "block_count stable across rebuilds");

    // Index still queryable & uncorrupted.
    const after = await search(AGENT, "rodents", 20);
    assert.ok(after.results.length >= 1, "index queryable after concurrent ops");
  });
});

// ── 5. status reports correct counts / freshness ────────────────────────

test("status reports correct counts and real freshness", { skip: skipNoSqlite }, async () => {
  await withBackendDir(async (dir) => {
    writeBlock(dir, AGENT, "a", "block one");
    writeBlock(dir, AGENT, "b", "block two");
    writeConversation(dir, AGENT, "conv-s", {
      messages: [
        { id: "m1", role: "user", text: "hello world" },
        { id: "m2", role: "assistant", text: "hi there" },
      ],
    });

    // Before any build, status is honest about not being indexed.
    const before = getStatus(AGENT);
    assert.equal(before.indexed, false);
    assert.equal(before.last_indexed, null);

    await rebuild(AGENT);
    const st = getStatus(AGENT);
    assert.equal(st.indexed, true);
    assert.equal(st.block_count, 2, "two blocks indexed");
    assert.equal(st.message_count, 2, "two messages indexed");
    assert.ok(st.size_bytes > 0, "index file has bytes");
    assert.ok(st.last_indexed && !Number.isNaN(Date.parse(st.last_indexed)), "real ISO last_indexed");
  });
});

// ── 6. deleting the search dir loses nothing canonical; rebuilds ────────

test("deleting the search dir loses nothing canonical and next search rebuilds", { skip: skipNoSqlite }, async () => {
  await withBackendDir(async (dir) => {
    const blockPath = writeBlock(dir, AGENT, "persona", "the secret animal is platypus");
    writeConversation(dir, AGENT, "conv-del", {
      messages: [{ id: "m1", role: "user", text: "platypus sightings logged" }],
    });
    await search(AGENT, "platypus", 20);
    assert.ok(existsSync(_searchInternals.indexPath(AGENT)), "index built");

    // rm -rf the derived index.
    deleteIndex(AGENT);
    assert.equal(existsSync(_searchInternals.searchDir(AGENT)), false, "search dir gone");
    // Canonical MemFS untouched.
    assert.ok(existsSync(blockPath), "canonical block file untouched by index delete");

    // Next search rebuilds from canonical state.
    const r = await search(AGENT, "platypus", 20);
    assert.ok(r.results.length >= 1, "search rebuilds the deleted index");
    assert.ok(existsSync(_searchInternals.indexPath(AGENT)), "index recreated");
  });
});

// ── 7. empty query / no-index returns sensibly ──────────────────────────

test("empty query returns empty results, no-index agent returns sensibly", { skip: skipNoSqlite }, async () => {
  await withBackendDir(async () => {
    // No fixtures at all for this agent.
    const empty = await search("agent-search-empty-9999", "", 20);
    assert.deepEqual(empty.results, [], "empty query → empty results");

    const noHits = await search("agent-search-empty-9999", "nonexistentterm", 20);
    assert.deepEqual(noHits.results, [], "no canonical data → empty results");
    assert.equal(noHits.indexing, false);
  });
});

// ── 8. ensureIndex fresh fast-path ──────────────────────────────────────

test("ensureIndex is a no-op when nothing changed (fresh)", { skip: skipNoSqlite }, async () => {
  await withBackendDir(async (dir) => {
    writeConversation(dir, AGENT, "conv-fresh", {
      messages: [{ id: "m1", role: "user", text: "stable content here" }],
    });
    const first = await ensureIndex(AGENT);
    assert.equal(first.ready, true);
    const ts1 = first.manifest.last_indexed;

    // Nothing changed → second ensureIndex must NOT re-index (same last_indexed).
    const second = await ensureIndex(AGENT);
    assert.equal(second.ready, true);
    assert.equal(second.manifest.last_indexed, ts1, "fresh path does not rebuild");
  });
});
