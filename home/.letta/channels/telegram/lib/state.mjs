/**
 * Persistent state: getUpdates offset + update_id dedupe.
 *
 * Offset: one JSON file per accountId — `state/<accountId>.json`. Mirrors
 *   the matrix plugin's sync-token file so the channel registry's health
 *   poll and stale-inbound guard can stat the same path. The file is
 *   rewritten after EVERY successful poll (even an empty long-poll return)
 *   so its mtime tracks liveness, not just offset advances.
 *
 * Dedupe: `state/<accountId>.dedupe.json` keyed by update_id, TTL-trimmed.
 *   File-backed (not SQLite) because the plugin is zero-dep. One listener
 *   process per account, so multi-process safety is a non-goal.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function stateRoot() {
  const root = process.env.LETTA_HOME || join(homedir(), ".letta");
  return join(root, "channels", "telegram", "state");
}

export function getOffsetPath(accountId) {
  return join(stateRoot(), `${accountId}.json`);
}

export function getDedupePath(accountId) {
  return join(stateRoot(), `${accountId}.dedupe.json`);
}

/**
 * Returns the persisted next-offset (a number), or undefined when no offset
 * file exists yet — the caller uses `undefined` to detect a fresh install
 * and drop the bootstrap backlog.
 */
export function loadOffset(accountId) {
  try {
    const path = getOffsetPath(accountId);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed.offset === "number" ? parsed.offset : undefined;
  } catch {
    return undefined;
  }
}

export function saveOffset(accountId, offset) {
  try {
    const path = getOffsetPath(accountId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ offset, updatedAt: new Date().toISOString() }, null, 2),
    );
  } catch (err) {
    console.error(`[telegram:${accountId}] failed to persist offset: ${err.message}`);
  }
}

export class UpdateDedupe {
  constructor(accountId, { ttlMs = 60 * 60 * 1000, maxEntries = 5000 } = {}) {
    this.accountId = accountId;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.path = getDedupePath(accountId);
    this.seen = new Map(); // updateId (string) -> epochMs
    this.dirty = false;
    this.flushTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!existsSync(this.path)) return;
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      const entries = parsed?.entries ?? {};
      const cutoff = Date.now() - this.ttlMs;
      for (const [updateId, ts] of Object.entries(entries)) {
        if (typeof ts === "number" && ts >= cutoff) this.seen.set(updateId, ts);
      }
    } catch (err) {
      console.error(`[telegram:${this.accountId}] dedupe load failed: ${err.message}`);
    }
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 2000);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /** Returns true if updateId was newly recorded (i.e. NOT a duplicate). */
  mark(updateId) {
    if (updateId === undefined || updateId === null) return true;
    const key = String(updateId);
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now());
    this.dirty = true;
    this._scheduleFlush();
    if (this.seen.size > this.maxEntries) this._trim();
    return true;
  }

  _trim() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
    if (this.seen.size > this.maxEntries) {
      const sorted = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      while (sorted.length > this.maxEntries) {
        const [id] = sorted.shift();
        this.seen.delete(id);
      }
    }
  }

  flush() {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(
        this.path,
        JSON.stringify({ entries: Object.fromEntries(this.seen), updatedAt: new Date().toISOString() }, null, 0),
      );
      this.dirty = false;
    } catch (err) {
      console.error(`[telegram:${this.accountId}] dedupe flush failed: ${err.message}`);
    }
  }

  close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
