import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { _internals as storeInternals } from "./store.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_FRAMES = 1_000;

const TTL_MS = readPositiveEnvInt("SHIM_MOBILE_CONV_REPLAY_TTL_MS", DEFAULT_TTL_MS);
const MAX_FRAMES = readPositiveEnvInt("SHIM_MOBILE_CONV_REPLAY_MAX_FRAMES", DEFAULT_MAX_FRAMES);

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
  replay: ReplayEntry[];
}

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
  state.replay.push({ convSeq, tsMs: Date.now(), frame: stamped });
  pruneReplay(state);
  return stamped;
}

export function resumeConversation(conversationId: string, afterSeqInput: unknown): ConversationResumeResult {
  const afterSeq = normalizeSeq(afterSeqInput);
  const state = getState(conversationId);
  pruneReplay(state);
  const lastSeq = state.sidecar.last_assigned_seq;
  const replay = readReplayFrames(conversationId, state.sidecar.last_ack_seq);
  const oldestSeq = replay.length > 0 ? replay[0]!.convSeq : null;
  const cursorExpired = afterSeq < lastSeq && (oldestSeq === null || afterSeq < oldestSeq - 1);
  if (cursorExpired) {
    return { ok: false, cursorExpired: true, conversationId, afterSeq, oldestSeq, lastSeq, frames: [] };
  }
  return {
    ok: true,
    cursorExpired: false,
    conversationId,
    afterSeq,
    oldestSeq,
    lastSeq,
    frames: replay.filter((entry) => entry.convSeq > afterSeq).map((entry) => ({ ...entry.frame, replayed: true })),
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
  pruneReplay(state);
  return state.sidecar;
}

function getState(conversationId: string): CursorState {
  const cached = states.get(conversationId);
  if (cached) return cached;
  const sidecar = readSidecar(conversationId);
  const state: CursorState = { sidecar, replay: [] };
  states.set(conversationId, state);
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

// lcp-02ri: the replay file is append-only and never rotated, so it grows
// without bound for the life of a conversation. The previous implementation
// readFileSync'd + JSON.parse'd the ENTIRE file on every resumeConversation
// (WS reconnect), making reconnect cost O(total frames ever stamped) even
// though only the most-recent `MAX_FRAMES` (within TTL, past the ack) are
// ever returned (see the `.slice(-MAX_FRAMES)` below). Measured: a 20k-frame
// file cost ~64ms to read+parse vs ~2ms for 500 frames — linear in history,
// the exact lcp-02ri streaming-replay regression class.
//
// Frames are appended in strict seq-ascending order, so the newest
// `MAX_FRAMES` lines live at the file's tail. We read backwards in 64 KiB
// chunks until we have at least `MAX_FRAMES + 1` complete lines (or hit the
// start of the file), then parse forward. This bounds reconnect read+parse
// work to O(MAX_FRAMES) regardless of total file size, while preserving the
// existing TTL / ack / slice filtering exactly.
const REPLAY_TAIL_CHUNK_BYTES = 64 * 1024;

function readReplayTailLines(path: string): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    let offset = size;
    let raw = "";
    let lineCount = 0;
    // We need MAX_FRAMES candidate lines; read one extra so a tail that
    // begins mid-line (after the first newline we slice off) still yields a
    // full MAX_FRAMES of complete lines.
    const wantLines = MAX_FRAMES + 1;
    while (offset > 0) {
      const len = Math.min(REPLAY_TAIL_CHUNK_BYTES, offset);
      offset -= len;
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, offset);
      raw = buf.toString("utf8") + raw;
      // Count newlines accumulated so far; stop once we have enough.
      lineCount = 0;
      for (let i = 0; i < raw.length; i += 1) {
        if (raw.charCodeAt(i) === 10) lineCount += 1;
      }
      if (lineCount >= wantLines) break;
    }
    // If we started mid-file, the first (partial) line may be incomplete —
    // drop it so we only parse whole records.
    if (offset > 0) {
      const firstNl = raw.indexOf("\n");
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
    }
    const lines = raw.split("\n");
    // Keep only the last MAX_FRAMES complete lines (the parse loop applies
    // the same -MAX_FRAMES slice on entries, but trimming here caps parse
    // work too).
    return lines.length > MAX_FRAMES ? lines.slice(lines.length - MAX_FRAMES) : lines;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mobile-conversation-cursors] replay tail read failed ${path}: ${msg}`);
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readReplayFrames(conversationId: string, lastAckSeq: number): ReplayEntry[] {
  const path = replayPath(conversationId);
  if (!existsSync(path)) return [];
  const tailLines = readReplayTailLines(path);
  const entries: ReplayEntry[] = [];
  const cutoff = Date.now() - TTL_MS;
  for (const line of tailLines) {
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

function pruneReplay(state: CursorState): void {
  const cutoff = Date.now() - TTL_MS;
  state.replay = state.replay.filter((entry) => entry.tsMs >= cutoff && entry.convSeq > state.sidecar.last_ack_seq);
  if (state.replay.length > MAX_FRAMES) {
    state.replay = state.replay.slice(state.replay.length - MAX_FRAMES);
  }
}
