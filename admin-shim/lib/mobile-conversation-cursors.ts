import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { _internals as storeInternals } from "./store.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_FRAMES = 1_000;
const DEFAULT_CURSOR_CACHE_MAX = 256;
const DEFAULT_COMPACT_CHECK_APPENDS = 1_000;

const TTL_MS = readPositiveEnvInt("SHIM_MOBILE_CONV_REPLAY_TTL_MS", DEFAULT_TTL_MS);
const MAX_FRAMES = readPositiveEnvInt("SHIM_MOBILE_CONV_REPLAY_MAX_FRAMES", DEFAULT_MAX_FRAMES);
const CURSOR_CACHE_MAX = readPositiveEnvInt("SHIM_MOBILE_CONV_CURSOR_CACHE_MAX", DEFAULT_CURSOR_CACHE_MAX);
const COMPACT_CHECK_APPENDS = readPositiveEnvInt(
  "SHIM_MOBILE_CONV_REPLAY_COMPACT_APPENDS",
  DEFAULT_COMPACT_CHECK_APPENDS,
);

export interface CursorSidecar {
  version: 1;
  conversation_id: string;
  last_assigned_seq: number;
  last_ack_seq: number;
  updated_at: string;
}

interface ReplayEntry {
  convSeq: number;
  tsMs: number;
  frame: Record<string, unknown>;
}

interface CursorState {
  sidecar: CursorSidecar;
  appendsSinceCompactCheck: number;
}

export interface ConversationFrameEvent {
  conversationId: string;
  frame: Record<string, unknown>;
}

type ConversationFrameListener = (event: ConversationFrameEvent) => void;

export interface ConversationResumeResult {
  ok: boolean;
  cursorExpired: boolean;
  conversationId: string;
  afterSeq: number;
  oldestSeq: number | null;
  lastSeq: number;
  frames: Record<string, unknown>[];
}

export interface MobileConversationCursorCapabilities {
  resume_cursor_supported: true;
  conversation_seq_field: "conv_seq";
  resume_frame: "resume_conversation";
  ack_frame: "ack";
  cursor_expired_error: "cursor_expired";
  replay_ttl_ms: number;
  replay_max_frames: number;
  replay_storage: "durable_jsonl";
}

const states = new Map<string, CursorState>();
const conversationListeners = new Set<ConversationFrameListener>();

export function mobileConversationCursorCapabilities(): MobileConversationCursorCapabilities {
  return {
    resume_cursor_supported: true,
    conversation_seq_field: "conv_seq",
    resume_frame: "resume_conversation",
    ack_frame: "ack",
    cursor_expired_error: "cursor_expired",
    replay_ttl_ms: TTL_MS,
    replay_max_frames: MAX_FRAMES,
    replay_storage: "durable_jsonl",
  };
}

export function stampConversationFrame(
  conversationId: string,
  frame: Record<string, unknown>,
): Record<string, unknown> {
  const state = getState(conversationId);
  const convSeq = state.sidecar.last_assigned_seq + 1;
  state.sidecar = {
    ...state.sidecar,
    last_assigned_seq: convSeq,
    updated_at: new Date().toISOString(),
  };
  writeSidecar(conversationId, state.sidecar);
  const stamped = { ...frame, conversation_id: conversationId, conv_seq: convSeq };
  appendReplayFrame(conversationId, { convSeq, tsMs: Date.now(), frame: stamped });
  state.appendsSinceCompactCheck += 1;
  if (state.appendsSinceCompactCheck >= COMPACT_CHECK_APPENDS) {
    state.appendsSinceCompactCheck = 0;
    maybeCompactReplayLog(conversationId, state.sidecar.last_ack_seq);
  }
  emitConversationFrame(conversationId, stamped);
  return stamped;
}

export function subscribeConversationEvents(listener: ConversationFrameListener): () => void {
  conversationListeners.add(listener);
  return () => {
    conversationListeners.delete(listener);
  };
}

function emitConversationFrame(conversationId: string, frame: Record<string, unknown>): void {
  const event: ConversationFrameEvent = { conversationId, frame };
  for (const listener of [...conversationListeners]) {
    try {
      listener(event);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mobile-conversation-cursors] conversation listener failed conversation=${conversationId}: ${msg}`);
    }
  }
}

export function resumeConversation(conversationId: string, afterSeqInput: unknown): ConversationResumeResult {
  const afterSeq = normalizeSeq(afterSeqInput);
  const state = getState(conversationId);
  const lastSeq = state.sidecar.last_assigned_seq;
  const replay = readReplayFrames(conversationId, state.sidecar.last_ack_seq);
  const oldestSeq = replay.length > 0 ? replay[0]!.convSeq : null;
  const cursorExpired = afterSeq < lastSeq && (oldestSeq === null || afterSeq < oldestSeq - 1);
  if (cursorExpired) {
    return { ok: false, cursorExpired: true, conversationId, afterSeq, oldestSeq, lastSeq, frames: [] };
  }
  // lcp xwi3z (§2b): implicit ack on successful resume — shim-side only,
  // no protocol change (the Android client never sends `ack` frames; it
  // only presents `after_seq` in the hello resume block). A resume cursor
  // `after_seq = N` means "the client has SEEN every frame ≤ N" (mobile
  // records the cursor at the top of handleInbound, before dispatch), not
  // "persisted durably". That is acceptable ONLY because mobile's
  // cursor_expired handler clears cursors and does a cold REST hydrate
  // (CursorResumeCoordinator) — REST is the recovery path for anything
  // this ack over-promises. Without this ack, sidecars never advance past
  // last_ack_seq=0 and compaction never shrinks the replay JSONL.
  //
  // Clamp: min(after_seq, last_assigned_seq). A corrupt/foreign after_seq
  // greater than anything we ever assigned must not permanently suppress
  // replay for all devices — compaction is destructive, so an over-ack is
  // unrecoverable by revert.
  //
  // Known multi-device regression (accepted, owned by the xwi3z design):
  // last_ack_seq is per-conversation, not per-device. When device A
  // resumes at seq 500, device B still at seq 200 gets cursor_expired on
  // its next resume — degraded (full REST refetch), not data loss.
  // Per-device cursors are the full fix and are explicitly out of scope.
  //
  // Ack strictly AFTER the success determination above (never before the
  // cursor_expired branch) and after the replay set is materialized, via
  // the existing max()-only ackConversation.
  const frames = replay
    .filter((entry) => entry.convSeq > afterSeq)
    .map((entry) => ({ ...entry.frame, replayed: true }));
  const impliedAck = Math.min(afterSeq, lastSeq);
  if (impliedAck > state.sidecar.last_ack_seq) {
    ackConversation(conversationId, impliedAck);
  }
  return {
    ok: true,
    cursorExpired: false,
    conversationId,
    afterSeq,
    oldestSeq,
    lastSeq,
    frames,
  };
}

export function ackConversation(conversationId: string, ackSeqInput: unknown): CursorSidecar {
  const ackSeq = normalizeSeq(ackSeqInput);
  const state = getState(conversationId);
  state.sidecar = {
    ...state.sidecar,
    last_ack_seq: Math.max(state.sidecar.last_ack_seq, ackSeq),
    updated_at: new Date().toISOString(),
  };
  writeSidecar(conversationId, state.sidecar);
  return state.sidecar;
}

// Sidecars are persisted on every write, so eviction is lossless — an evicted
// conversation transparently reloads from disk on its next touch.
function getState(conversationId: string): CursorState {
  const cached = states.get(conversationId);
  if (cached) {
    // Refresh LRU position (Map preserves insertion order).
    states.delete(conversationId);
    states.set(conversationId, cached);
    return cached;
  }
  const sidecar = readSidecar(conversationId);
  const state: CursorState = { sidecar, appendsSinceCompactCheck: 0 };
  states.set(conversationId, state);
  while (states.size > CURSOR_CACHE_MAX) {
    const oldest = states.keys().next().value;
    if (oldest === undefined) break;
    states.delete(oldest);
  }
  return state;
}

function normalizeSeq(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function readPositiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  console.warn(`[mobile-conversation-cursors] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

function sidecarPath(conversationId: string): string {
  return join(
    storeInternals.storageDir(),
    "mobile-conversation-cursors",
    `${storeInternals.b64url(conversationId)}.json`,
  );
}

function replayPath(conversationId: string): string {
  return join(
    storeInternals.storageDir(),
    "mobile-conversation-cursors",
    `${storeInternals.b64url(conversationId)}.frames.jsonl`,
  );
}

function readSidecar(conversationId: string): CursorSidecar {
  const path = sidecarPath(conversationId);
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(parsed)) {
        throw new Error("sidecar root is not an object");
      }
      return {
        version: 1,
        conversation_id: conversationId,
        last_assigned_seq: normalizeSeq(parsed["last_assigned_seq"]),
        last_ack_seq: normalizeSeq(parsed["last_ack_seq"]),
        updated_at: typeof parsed["updated_at"] === "string" ? parsed["updated_at"] : new Date().toISOString(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mobile-conversation-cursors] ignoring malformed sidecar ${path}: ${msg}`);
      // Fall through to a fresh sidecar. A malformed cursor sidecar should not
      // break the WS handshake; clients can still cold-hydrate.
    }
  }
  return {
    version: 1,
    conversation_id: conversationId,
    last_assigned_seq: 0,
    last_ack_seq: 0,
    updated_at: new Date().toISOString(),
  };
}

function writeSidecar(conversationId: string, sidecar: CursorSidecar): void {
  const path = sidecarPath(conversationId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch (cleanupErr) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn(`[mobile-conversation-cursors] failed to remove temp sidecar ${tmp}: ${msg}`);
    }
    throw err;
  }
}

function appendReplayFrame(conversationId: string, entry: ReplayEntry): void {
  const path = replayPath(conversationId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ seq: entry.convSeq, ts: new Date(entry.tsMs).toISOString(), frame: entry.frame }) + "\n");
}

function readReplayFrames(conversationId: string, lastAckSeq: number): ReplayEntry[] {
  const path = replayPath(conversationId);
  if (!existsSync(path)) return [];
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mobile-conversation-cursors] replay read failed ${path}: ${msg}`);
    return [];
  }
  const entries: ReplayEntry[] = [];
  const cutoff = Date.now() - TTL_MS;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) continue;
      const convSeq = normalizeSeq(parsed["seq"]);
      const frame = parsed["frame"];
      if (convSeq <= 0 || !isRecord(frame)) continue;
      const ts = parsed["ts"];
      const tsMs = typeof ts === "string" ? Date.parse(ts) : NaN;
      const normalizedTsMs = Number.isFinite(tsMs) ? tsMs : 0;
      if (normalizedTsMs < cutoff || convSeq <= lastAckSeq) continue;
      entries.push({
        convSeq,
        tsMs: normalizedTsMs,
        frame,
      });
    } catch {
      // Match the run frame-log reader: ignore malformed/partial trailing lines.
    }
  }
  return entries.sort((a, b) => a.convSeq - b.convSeq).slice(-MAX_FRAMES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Rewrite the replay JSONL keeping only frames still eligible for replay
// (within TTL, unacked, last MAX_FRAMES). Without this the log grows without
// bound and every reconnect re-reads/parses the full history (lcp-2s5e).
function maybeCompactReplayLog(conversationId: string, lastAckSeq: number): void {
  const path = replayPath(conversationId);
  if (!existsSync(path)) return;
  try {
    const retained = readReplayFrames(conversationId, lastAckSeq);
    if (retained.length === 0) {
      unlinkSync(path);
      return;
    }
    const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    const body = retained
      .map((entry) => JSON.stringify({ seq: entry.convSeq, ts: new Date(entry.tsMs).toISOString(), frame: entry.frame }))
      .join("\n");
    writeFileSync(tmp, body + "\n");
    renameSync(tmp, path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mobile-conversation-cursors] replay compaction failed ${path}: ${msg}`);
  }
}

export const _cursorInternals = {
  maybeCompactReplayLog,
  resetCache(): void {
    states.clear();
  },
  cacheSize(): number {
    return states.size;
  },
};
