/**
 * lcp-12w — synthetic settlement on tool-call interrupt or cancel.
 *
 * Defense-in-depth complement to lcp-ith. lcp-ith patches letta-code's
 * `executeConversationTurn` so the upstream `settleInterruptedToolCalls`
 * fires correctly at the START of the next turn. This file does the
 * matching work at the END of the CURRENT turn: when a turn is
 * interrupted (cancel, watchdog timeout, worker exit, stream drop), scan
 * the frames we observed and the disk records that landed, and append a
 * synthetic error `toolResult` for every `tool_call_id` that was emitted
 * but never returned. Without this, an orphan `tool_use` can sit on disk
 * until the patched settle picks it up — which is fine if you trust
 * lcp-ith to always run, but free orphans are still free orphans.
 *
 * Frame contract:
 *   - tools the assistant called this turn = any frame whose inner event
 *     carries `tool_call.tool_call_id`. Covers `tool_call_message` AND
 *     `approval_request_message` (letta-code emits the latter when
 *     awaiting approval; if the approval is denied or the turn dies
 *     before the tool resolves, the call ends up just as orphaned).
 *   - tools that returned = any new on-disk `toolResult` record (role=
 *     "toolResult", toolCallId=<id>) that wasn't present BEFORE the turn.
 *     letta-code surfaces returns via LocalStore, not the stream, so the
 *     authoritative source is the disk diff, not frames[].
 *
 * Output contract:
 *   - synthetic LocalMessage appended to messages.jsonl with:
 *       role: "toolResult", toolCallId: <id>, isError: true,
 *       content/parts: [{ type:"text", text: "<reason text>" }]
 *     same shape lcp-ezv's healer's "settled" path produces — so the
 *     two paths' on-disk output is interchangeable.
 *   - audit row appended to `state/runs/<runId>/settlements.jsonl`
 *     (mirrors the heal-audit sibling at `state/runs/<runId>/heal.jsonl`).
 *
 * Idempotent: callers may invoke this on every turn end; on a clean
 * turn the call walks frames, finds every id has a matching new
 * toolResult, and writes nothing.
 */

import {
  mkdir as fsMkdir,
  appendFile as fsAppendFile,
  readFile as fsReadFile,
  rename as fsRename,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import type {
  LettaStreamFrame,
  LettaInnerEvent,
} from "./types/letta-stream.js";
import { _internals as storeInternals, listMessages } from "./store.js";

export type SettlementReason =
  | "cancelled"
  | "turn_timeout"
  | "worker_exit"
  | "stream_dropped"
  | "requires_approval";

/**
 * Human-readable text written into the synthetic toolResult `content`
 * field. Matches the spirit of letta-code's `INTERRUPTED_BY_USER` /
 * `TURN_DID_NOT_COMPLETE` constants so the agent can read the result
 * coherently next turn.
 */
const REASON_TEXT: Record<SettlementReason, string> = {
  cancelled: "Tool execution interrupted by cancellation",
  turn_timeout: "Tool execution interrupted by turn timeout",
  worker_exit: "Tool execution interrupted by worker exit",
  stream_dropped: "Tool execution interrupted by stream drop",
  requires_approval: "Tool execution interrupted because approval was required",
};

export interface SettleInput {
  frames: LettaStreamFrame[];
  conversationId: string;
  agentId: string;
  runId: string;
  reason: SettlementReason;
  /** Snapshot of message ids that existed BEFORE the turn started. */
  messageIdsBefore: Set<string>;
  /** epoch ms for synthetic record timestamps. Defaults to Date.now(). */
  now?: number;
  /** Override state root for tests. Defaults to LETTA_LOCAL_BACKEND_DIR. */
  stateDir?: string;
}

export interface SettleReport {
  reason: SettlementReason;
  /** Tool call ids the assistant emitted this turn (from frames). */
  emitted: string[];
  /** Tool call ids whose toolResult landed on disk this turn. */
  returned: string[];
  /** ids settled by a synthetic toolResult write. */
  settled: Array<{ tool_call_id: string; tool_name: string }>;
  messagesAppended: number;
}

/**
 * Run the settlement pass. Safe to call on any turn end — no-op when
 * everything's accounted for.
 */
export async function settleDanglingToolCallsFromFrames(
  args: SettleInput,
): Promise<SettleReport> {
  const nowMs = args.now ?? Date.now();
  const report: SettleReport = {
    reason: args.reason,
    emitted: [],
    returned: [],
    settled: [],
    messagesAppended: 0,
  };

  // Frame side: collect (id → name) for every tool_call observed.
  const emitted = new Map<string, string>();
  for (const frame of args.frames) {
    const ev = frameEvent(frame);
    const tc = readToolCall(ev);
    if (tc && typeof tc.tool_call_id === "string" && tc.tool_call_id.length > 0) {
      // Preserve first-seen tool name; reasonable for retries/duplicates.
      if (!emitted.has(tc.tool_call_id)) {
        emitted.set(tc.tool_call_id, typeof tc.name === "string" ? tc.name : "<unknown>");
      }
    }
  }
  report.emitted = [...emitted.keys()];
  if (emitted.size === 0) return report;

  // Disk side: which new toolResults landed since the turn started?
  const messages = await listMessages(args.conversationId, args.agentId);
  const returnedIds = new Set<string>();
  for (const m of messages) {
    if (!m || m.role !== "toolResult") continue;
    const id = (m as { toolCallId?: unknown }).toolCallId;
    const msgId = (m as { id?: unknown }).id;
    if (typeof id !== "string" || typeof msgId !== "string") continue;
    if (args.messageIdsBefore.has(msgId)) continue; // pre-existing return
    returnedIds.add(id);
  }
  report.returned = [...returnedIds];

  const dangling: string[] = [];
  for (const id of emitted.keys()) {
    if (!returnedIds.has(id)) dangling.push(id);
  }
  if (dangling.length === 0) return report;

  // Build synthetic toolResult records. Shape mirrors lcp-ezv's healer
  // "settled" path so both write paths produce interchangeable records.
  const messagesPath = conversationFilePath(
    args.conversationId,
    args.agentId,
    "messages.jsonl",
    args.stateDir,
  );
  const isoNow = new Date(nowMs).toISOString();
  const reasonText = REASON_TEXT[args.reason];
  const records = await readJsonlOrEmpty(messagesPath);
  const synthByParent = new Map<number, unknown[]>();
  for (let i = 0; i < dangling.length; i += 1) {
    const id = dangling[i]!;
    const name = emitted.get(id) ?? "<unknown>";
    const parentIdx = findAssistantToolCallIndex(records, id);
    if (parentIdx < 0) continue;
    report.settled.push({ tool_call_id: id, tool_name: name });
    const bucket = synthByParent.get(parentIdx) ?? [];
    bucket.push({
      id: `synth-settle:${args.runId}:${id}`,
      role: "toolResult",
      parts: [{ type: "text", text: reasonText }],
      toolCallId: id,
      toolName: name,
      isError: true,
      timestamp: nowMs + i,
      content: [{ type: "text", text: reasonText }],
      metadata: {
        created_at: isoNow,
        updated_at: isoNow,
        agent_id: args.agentId,
        conversation_id: args.conversationId,
      },
    });
    synthByParent.set(parentIdx, bucket);
  }

  if (synthByParent.size > 0) {
    const nextRecords: unknown[] = [];
    for (let i = 0; i < records.length; i += 1) {
      nextRecords.push(records[i]);
      for (const record of synthByParent.get(i) ?? []) nextRecords.push(record);
    }
    await atomicWriteJsonl(messagesPath, nextRecords);
  }
  report.messagesAppended = [...synthByParent.values()].reduce((sum, recordsForParent) => sum + recordsForParent.length, 0);

  await writeSettlementAudit({
    conversationId: args.conversationId,
    agentId: args.agentId,
    runId: args.runId,
    stateDir: args.stateDir,
    report,
    now: nowMs,
  });

  return report;
}

// ── Helpers ───────────────────────────────────────────────────────────

function frameEvent(frame: LettaStreamFrame): LettaInnerEvent | LettaStreamFrame {
  if (frame.type === "stream_event") return frame.event;
  return frame;
}

function readToolCall(ev: unknown): { tool_call_id?: unknown; name?: unknown } | null {
  if (!ev || typeof ev !== "object") return null;
  const obj = ev as Record<string, unknown>;
  const tc = obj["tool_call"];
  if (tc && typeof tc === "object") return tc as { tool_call_id?: unknown; name?: unknown };
  return null;
}

function conversationFilePath(
  conversationId: string,
  agentId: string,
  filename: string,
  stateDirOverride?: string,
): string {
  const stateDir = stateDirOverride ?? storeInternals.storageDir();
  const key = conversationId === "default" ? `default:${agentId}` : `conversation:${conversationId}`;
  return join(stateDir, "conversations", storeInternals.b64url(key), filename);
}

async function readJsonlOrEmpty(path: string): Promise<unknown[]> {
  try {
    const raw = await fsReadFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

async function atomicWriteJsonl(path: string, records: unknown[]): Promise<void> {
  const dir = dirname(path);
  await fsMkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const payload = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
  try {
    await fsWriteFile(tmp, payload);
    await fsRename(tmp, path);
  } catch (err) {
    try {
      await fsUnlink(tmp);
    } catch (cleanupErr) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn(`[turn-settlement] failed to remove temp jsonl file ${tmp}: ${msg}`);
    }
    throw err;
  }
}

function findAssistantToolCallIndex(records: unknown[], id: string): number {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const message = localMessagePayload(records[i]);
    if (!message || message["role"] !== "assistant") continue;
    if (assistantToolCallIds(message).includes(id)) return i;
  }
  return -1;
}

function localMessagePayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nested = record["message"];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  return record;
}

function assistantToolCallIds(message: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const part of pickPartsArray(message)) {
    if (part && typeof part === "object" && !Array.isArray(part)) {
      const record = part as Record<string, unknown>;
      if (record["type"] === "toolCall" && typeof record["id"] === "string") ids.push(record["id"]);
    }
  }
  for (const key of ["tool_calls", "toolCalls"] as const) {
    const calls = message[key];
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (call && typeof call === "object" && !Array.isArray(call)) {
        const record = call as Record<string, unknown>;
        if (typeof record["id"] === "string") ids.push(record["id"]);
      }
    }
  }
  return [...new Set(ids)];
}

function pickPartsArray(message: Record<string, unknown>): unknown[] {
  if (Array.isArray(message["parts"])) return message["parts"];
  if (Array.isArray(message["content"])) return message["content"];
  return [];
}

async function writeSettlementAudit(args: {
  conversationId: string;
  agentId: string;
  runId: string;
  stateDir?: string | undefined;
  report: SettleReport;
  now: number;
}): Promise<void> {
  const stateDir = args.stateDir ?? storeInternals.storageDir();
  // Same parent-of-storageDir convention lcp-ezv's writeHealAudit uses,
  // so settlement + heal records sit side-by-side under state/runs/<id>/.
  const root = join(stateDir, "..", "state", "runs", args.runId);
  await fsMkdir(root, { recursive: true });
  const path = join(root, "settlements.jsonl");
  const entry = {
    ts: new Date(args.now).toISOString(),
    conversation_id: args.conversationId,
    agent_id: args.agentId,
    run_id: args.runId,
    ...args.report,
  };
  try {
    await fsAppendFile(path, JSON.stringify(entry) + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[turn-settlement] audit write failed for ${path}: ${msg}`);
  }
}

// ── Test surface ──────────────────────────────────────────────────────

export const _internals = Object.freeze({
  REASON_TEXT,
  frameEvent,
  readToolCall,
  conversationFilePath,
});
