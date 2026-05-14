/**
 * Persistent state: sync token, event dedupe.
 *
 * Sync token: one JSON file per accountId.
 * Dedupe: JSON file with { processedAt: { eventId: epochMs } } trimmed by TTL.
 *   File-backed (not SQLite) because the plugin is zero-dep. Trade-off:
 *   not multi-process safe — fine since one listener process per account.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function stateRoot() {
  const root = process.env.LETTA_HOME || join(homedir(), ".letta");
  return join(root, "channels", "matrix", "state");
}

export function getSyncTokenPath(accountId) {
  return join(stateRoot(), `${accountId}.json`);
}

export function getDedupePath(accountId) {
  return join(stateRoot(), `${accountId}.dedupe.json`);
}

export function loadSyncToken(accountId) {
  try {
    const path = getSyncTokenPath(accountId);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed.syncToken === "string" ? parsed.syncToken : undefined;
  } catch {
    return undefined;
  }
}

export function saveSyncToken(accountId, syncToken) {
  try {
    const path = getSyncTokenPath(accountId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ syncToken, updatedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error(`[matrix:${accountId}] failed to persist sync token: ${err.message}`);
  }
}

export class EventDedupe {
  constructor(accountId, { ttlMs = 60 * 60 * 1000, maxEntries = 5000 } = {}) {
    this.accountId = accountId;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.path = getDedupePath(accountId);
    this.seen = new Map(); // eventId -> epochMs
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
      for (const [eventId, ts] of Object.entries(entries)) {
        if (typeof ts === "number" && ts >= cutoff) {
          this.seen.set(eventId, ts);
        }
      }
    } catch (err) {
      console.error(`[matrix:${this.accountId}] dedupe load failed: ${err.message}`);
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

  /** Returns true if eventId was newly recorded (i.e. not a duplicate). */
  mark(eventId) {
    if (!eventId) return true;
    const now = Date.now();
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, now);
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
      // drop oldest beyond the cap
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
      const entries = Object.fromEntries(this.seen);
      writeFileSync(
        this.path,
        JSON.stringify({ entries, updatedAt: new Date().toISOString() }, null, 0),
      );
      this.dirty = false;
    } catch (err) {
      console.error(`[matrix:${this.accountId}] dedupe flush failed: ${err.message}`);
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
