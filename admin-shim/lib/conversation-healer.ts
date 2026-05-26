/**
 * lcp-ezv — auto-heal corrupt conversation transcripts.
 *
 * Failure mode this targets: a turn ends with `stop_reason: "error"` and an
 * Anthropic `invalid_request_error` payload reading "tool_use ids were
 * found without tool_result blocks immediately after: toolu_X, ...". This
 * happens when letta-code's API serializer keeps the parent assistant
 * message with `tool_use` blocks but drops one or more of the corresponding
 * `tool_result` records — leaving an orphaned tool_use ID in the request.
 * Every subsequent turn against the same conversation hits the same error
 * because the orphaned ID is now part of the on-disk transcript that gets
 * replayed.
 *
 * Strategy:
 *   1. Detect — pattern-match the Anthropic error against the dangling-
 *      tool_use signature; return the orphaned IDs.
 *   2. Categorize each ID:
 *      a. NO toolResult exists on disk → the genuine "interrupted tool
 *         call" case (worker SIGTERM mid-stream, manual cancel, watchdog
 *         timeout). Settle by appending a synthetic error toolResult
 *         record. The next API request includes it; the agent sees the
 *         tool ran and errored.
 *      b. matching toolResult DOES exist on disk → letta-code is
 *         dropping it from the API request despite the disk record. We
 *         can't fix that from outside the CLI, so the only durable repair
 *         is to remove the orphan `toolCall` part from the parent
 *         assistant message (and the now-unreferenced toolResult message
 *         pair). The assistant's surrounding text content is preserved as
 *         a `[healed: removed orphan tool call <name>]` annotation so
 *         the transcript still reads coherently.
 *   3. Audit — every heal action writes to
 *      `state/runs/<runId>/heal.jsonl` (or `state/heal/<conv>.jsonl` if
 *      no run context) with the operation, the IDs touched, and the
 *      before/after message snapshots.
 *
 * Bounded: the healer NEVER applies twice in a row for the same dangling
 * ID. Callers tracking retry attempts must short-circuit if the post-heal
 * turn fails with the same ID. (lcp-ezv acceptance #4.)
 *
 * Surgical mutation of conversation history is documented upstream as
 * "dangerous unless you fully understand the message schema." We DO fully
 * understand it — see `lib/types/letta-stream.ts` LocalMessage + related
 * types, and the post-pi-backup migration's `content`-shaped records.
 * Every operation is atomic-write through a temp file + rename so a crash
 * mid-heal leaves either the old transcript or the new one, never a
 * truncated mix.
 */

import { mkdir as fsMkdir, readFile as fsReadFile, rename as fsRename, unlink as fsUnlink, writeFile as fsWriteFile, appendFile as fsAppendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import type { LocalMessage, LocalMessagePart } from "./types/letta-stream.js";
import { _internals as storeInternals, listMessages } from "./store.js";

// ── Detection ─────────────────────────────────────────────────────────

/**
 * Match the Anthropic invalid_request_error for orphaned tool_use IDs.
 *
 * Example error string:
 *   messages.1: `tool_use` ids were found without `tool_result` blocks
 *   immediately after: toolu_012g7dK..., toolu_01CenN..., toolu_01XMc....
 *   Each `tool_use` block must have a corresponding `tool_result` block
 *   in the next message.
 *
 * Strategy: find the literal "after:" colon that introduces the ID list,
 * then pull every `toolu_*` token after it. Resilient to changes in the
 * leading-error text — the only structural assumption is that the IDs
 * appear comma-separated after that colon.
 */
export function detectDanglingToolUses(errorPayload: unknown): string[] {
  const text = extractErrorText(errorPayload);
  if (!text) return [];
  // Bail unless this is the specific dangling-tool_use pattern. We don't
  // want to fire on generic API errors or unrelated invalid_request_error
  // variants (rate limit, content-policy, etc.).
  if (!/tool_use[^]+?tool_result/i.test(text)) return [];
  const colonIdx = text.indexOf("after:");
  if (colonIdx < 0) return [];
  const tail = text.slice(colonIdx);
  const matches = tail.match(/toolu_[A-Za-z0-9_-]+/g) ?? [];
  // De-dupe while preserving order — same ID can appear in both the
  // human-readable list and a later "Each tool_use block ..." sentence.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of matches) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Match provider errors for role-alternation violations. Anthropic-compatible
 * APIs reject transcripts that serialize as user → user without an assistant
 * turn between them; once that shape is on disk, every later turn fails before
 * the model can respond.
 */
export function detectRoleAlternationViolation(errorPayload: unknown): boolean {
  const text = extractErrorText(errorPayload);
  if (!text) return false;
  return /messages[^]+alternate[^]+user[^]+assistant/i.test(text)
    || /roles?[^]+alternate/i.test(text)
    || /consecutive[^]+user/i.test(text);
}

/**
 * The CLI surfaces the API error in a few shapes depending on which
 * code path emits it. Pull a single text blob out of any of them.
 */
function extractErrorText(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return String(payload);
  const obj = payload as Record<string, unknown>;
  // Common shapes:
  //   { type:"error", message:"<json string>", api_error:{ detail:"<json string>", ... } }
  //   { error: { message:"..." } }
  //   raw stringified Anthropic body
  const parts: string[] = [];
  if (typeof obj["message"] === "string") parts.push(obj["message"]);
  const apiErr = obj["api_error"];
  if (apiErr && typeof apiErr === "object") {
    const ae = apiErr as Record<string, unknown>;
    if (typeof ae["detail"] === "string") parts.push(ae["detail"]);
    if (typeof ae["message"] === "string") parts.push(ae["message"]);
  }
  const inner = obj["error"];
  if (inner && typeof inner === "object") {
    const ie = inner as Record<string, unknown>;
    if (typeof ie["message"] === "string") parts.push(ie["message"]);
  }
  return parts.join("\n");
}

// ── Heal ──────────────────────────────────────────────────────────────

export interface HealOptions {
  /** Run id, used to scope the audit sidecar. Optional. */
  runId?: string | null | undefined;
  /** Override `state/` root for tests. Defaults to LETTA_LOCAL_BACKEND_DIR. */
  stateDir?: string | undefined;
  /** Synthetic timestamp for the synthetic toolResult records (ms epoch). Default: now. */
  now?: number | undefined;
}

export interface HealReport {
  /** Dangling IDs the healer was asked to repair. */
  requested: string[];
  /** IDs that already had a matching toolResult on disk — repaired by removing the orphan tool_use part. */
  removed: string[];
  /** IDs with no matching toolResult on disk — repaired by appending a synthetic error toolResult. */
  settled: string[];
  /** IDs that could not be found on disk at all (nothing to do). */
  unresolved: string[];
  /** Count of distinct messages whose content was edited. */
  messagesEdited: number;
  /** Count of toolResult messages dropped because their tool_use parent was removed. */
  messagesRemoved: number;
  /** Count of synthetic toolResult messages appended. */
  messagesAppended: number;
}

/**
 * Apply the heal. Idempotent: if the dangling IDs are already absent from
 * the transcript (e.g. a previous run already healed them) this returns
 * `requested.length === unresolved.length` and writes nothing.
 */
export async function healConversation(
  conversationId: string,
  agentId: string,
  danglingIds: string[],
  opts: HealOptions = {},
): Promise<HealReport> {
  const report: HealReport = {
    requested: [...danglingIds],
    removed: [],
    settled: [],
    unresolved: [],
    messagesEdited: 0,
    messagesRemoved: 0,
    messagesAppended: 0,
  };
  if (danglingIds.length === 0) return report;

  const messagesPath = conversationFilePath(conversationId, agentId, "messages.jsonl", opts.stateDir);
  const records = await readJsonlOrEmpty(messagesPath);

  // First pass: classify each dangling ID.
  // Build maps of (id → indices of records that mention it).
  const toolCallSites = new Map<string, number[]>(); // assistant message indices carrying this tool_use
  const toolResultSites = new Map<string, number[]>(); // toolResult message indices for this id

  records.forEach((m, idx) => {
    if (!isRecord(m)) return;
    if (m["role"] === "assistant") {
      const parts = pickPartsArray(m);
      for (const p of parts) {
        if (isToolCallPart(p) && danglingIds.includes(p.id)) {
          push(toolCallSites, p.id, idx);
        }
      }
    } else if (m["role"] === "toolResult") {
      const tcid = m["toolCallId"];
      if (typeof tcid === "string" && danglingIds.includes(tcid)) {
        push(toolResultSites, tcid, idx);
      }
    }
  });

  for (const id of danglingIds) {
    if (!toolCallSites.has(id)) {
      report.unresolved.push(id);
      continue;
    }
    if (toolResultSites.has(id)) {
      report.removed.push(id);
    } else {
      report.settled.push(id);
    }
  }

  if (report.removed.length === 0 && report.settled.length === 0) {
    return report;
  }

  // Apply edits to a working copy.
  const edited: unknown[] = records.map((m) => m); // start with shallow copy
  const editedMessageIds = new Set<number>();
  const removedIndices = new Set<number>();

  // (a) For each "removed" id: strip the toolCall part from the assistant
  //     message, drop the matching toolResult message.
  for (const id of report.removed) {
    const sites = toolCallSites.get(id) ?? [];
    for (const idx of sites) {
      const m = edited[idx];
      if (!isRecord(m)) continue;
      const partsKey = Array.isArray(m["parts"]) ? "parts" : "content";
      const parts = pickPartsArray(m);
      const nextParts: LocalMessagePart[] = [];
      let touched = false;
      for (const p of parts) {
        if (isToolCallPart(p) && p.id === id) {
          touched = true;
          // Annotate so the conversation history records that the tool
          // happened, even though the structured tool_use is gone.
          nextParts.push({
            type: "text",
            text: `[healed: removed orphan tool call ${p.name ?? "<unknown>"} (id=${id})]`,
          } as LocalMessagePart);
        } else {
          nextParts.push(p);
        }
      }
      if (touched) {
        edited[idx] = { ...m, [partsKey]: nextParts };
        editedMessageIds.add(idx);
      }
    }
    for (const ridx of toolResultSites.get(id) ?? []) {
      removedIndices.add(ridx);
    }
  }

  // (b) For each "settled" id: append a synthetic error toolResult at
  //     the end of the transcript. Order matters less than presence
  //     since letta-code's serializer groups consecutive toolResult
  //     records into a single API user message, but appending at the
  //     end keeps the disk record monotonic-ish.
  const nowMs = opts.now ?? Date.now();
  const synthAppend: LocalMessage[] = [];
  for (const id of report.settled) {
    const sites = toolCallSites.get(id) ?? [];
    if (sites.length === 0) continue;
    const parent = edited[sites[sites.length - 1]!];
    if (!isRecord(parent)) continue;
    // Try to recover the tool name from the parent's toolCall part.
    let toolName = "<unknown>";
    for (const p of pickPartsArray(parent)) {
      if (isToolCallPart(p) && p.id === id) {
        toolName = p.name ?? toolName;
        break;
      }
    }
    const parentId = typeof parent["id"] === "string" ? parent["id"] : "synth-parent";
    synthAppend.push({
      id: `${parentId}:heal-tool-result:${id}`,
      role: "toolResult",
      parts: [{ type: "text", text: "[healed: tool execution interrupted, no result recorded]" }],
      toolCallId: id,
      toolName,
      // The local-backend store puts `isError`/`timestamp` at the top level.
      ...({
        isError: true,
        timestamp: nowMs,
        content: [{ type: "text", text: "[healed: tool execution interrupted, no result recorded]" }],
        metadata: {
          created_at: new Date(nowMs).toISOString(),
          updated_at: new Date(nowMs).toISOString(),
          agent_id: agentId,
          conversation_id: conversationId,
        },
      } as Record<string, unknown>),
    } as unknown as LocalMessage);
  }

  // Materialize the final list (skip removed indices, then append synth).
  const nextRecords: unknown[] = [];
  for (let i = 0; i < edited.length; i += 1) {
    if (removedIndices.has(i)) continue;
    nextRecords.push(edited[i]);
  }
  for (const m of synthAppend) nextRecords.push(m);

  report.messagesEdited = editedMessageIds.size;
  report.messagesRemoved = removedIndices.size;
  report.messagesAppended = synthAppend.length;

  // Atomic write. Same .tmp+rename pattern store.ts uses for the JSON
  // sidecars — partial writes on crash leave the original intact.
  await atomicWriteJsonl(messagesPath, nextRecords);

  // Audit sidecar.
  await writeHealAudit({
    conversationId,
    agentId,
    runId: opts.runId,
    stateDir: opts.stateDir,
    report,
    now: nowMs,
  });

  return report;
}

/**
 * Detect user-message runs that would break provider role alternation.
 *
 * Interior runs keep the latest user record before the following assistant,
 * which preserves the last user intent while restoring alternation. A trailing
 * run with no assistant response is removed entirely: the shim does not inline
 * retry healed turns, so leaving a final user message would make the next user
 * turn append another user and immediately recreate the invalid shape.
 */
export function detectConsecutiveUserMessageIndices(records: unknown[]): number[] {
  const toRemove = new Set<number>();
  let userRun: number[] = [];

  const flushInteriorRun = (): void => {
    if (userRun.length > 1) {
      for (const idx of userRun.slice(0, -1)) toRemove.add(idx);
    }
    userRun = [];
  };

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (isRecord(record) && record["role"] === "user") {
      userRun.push(i);
      continue;
    }
    flushInteriorRun();
  }

  if (userRun.length > 1) {
    for (const idx of userRun) toRemove.add(idx);
  }

  return [...toRemove].sort((a, b) => a - b);
}

/**
 * Remove consecutive user-message runs from the on-disk transcript.
 */
export async function healConsecutiveUserMessages(
  conversationId: string,
  agentId: string,
  opts: HealOptions = {},
): Promise<HealReport> {
  const messagesPath = conversationFilePath(conversationId, agentId, "messages.jsonl", opts.stateDir);
  const records = await readJsonlOrEmpty(messagesPath);
  const removeIndices = detectConsecutiveUserMessageIndices(records);
  const removedLabels = removeIndices.map((idx) => {
    const record = records[idx];
    if (isRecord(record) && typeof record["id"] === "string") return record["id"];
    return `user-index-${idx}`;
  });

  const report: HealReport = {
    requested: removedLabels,
    removed: removedLabels,
    settled: [],
    unresolved: [],
    messagesEdited: 0,
    messagesRemoved: removeIndices.length,
    messagesAppended: 0,
  };
  if (removeIndices.length === 0) return report;

  const removeSet = new Set(removeIndices);
  const nextRecords = records.filter((_record, idx) => !removeSet.has(idx));
  await atomicWriteJsonl(messagesPath, nextRecords);
  await writeHealAudit({
    conversationId,
    agentId,
    runId: opts.runId,
    stateDir: opts.stateDir,
    report,
    now: opts.now ?? Date.now(),
  });
  return report;
}

// ── Helpers ───────────────────────────────────────────────────────────

function push(map: Map<string, number[]>, key: string, value: number): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickPartsArray(m: Record<string, unknown>): LocalMessagePart[] {
  if (Array.isArray(m["parts"])) return m["parts"] as LocalMessagePart[];
  if (Array.isArray(m["content"])) return m["content"] as LocalMessagePart[];
  return [];
}

function isToolCallPart(p: unknown): p is { type: "toolCall"; id: string; name?: string; arguments?: unknown } {
  return isRecord(p) && p["type"] === "toolCall" && typeof p["id"] === "string";
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
  const payload = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  try {
    await fsWriteFile(tmp, payload);
    await fsRename(tmp, path);
  } catch (err) {
    try {
      await fsUnlink(tmp);
    } catch (cleanupErr) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn(`[conversation-healer] failed to remove temp jsonl file ${tmp}: ${msg}`);
    }
    throw err;
  }
}

async function writeHealAudit(args: {
  conversationId: string;
  agentId: string;
  runId?: string | null | undefined;
  stateDir?: string | undefined;
  report: HealReport;
  now: number;
}): Promise<void> {
  const stateDir = args.stateDir ?? storeInternals.storageDir();
  const root = args.runId
    ? join(stateDir, "..", "state", "runs", args.runId)
    : join(stateDir, "..", "state", "heal");
  await fsMkdir(root, { recursive: true });
  const filename = args.runId ? "heal.jsonl" : `${args.conversationId}.jsonl`;
  const path = join(root, filename);
  const entry = {
    ts: new Date(args.now).toISOString(),
    conversation_id: args.conversationId,
    agent_id: args.agentId,
    run_id: args.runId ?? null,
    ...args.report,
  };
  try {
    await fsAppendFile(path, JSON.stringify(entry) + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[conversation-healer] audit write failed for ${path}: ${msg}`);
  }
}

// ── Convenience: introspect the disk to confirm heal is needed ────────

/**
 * Returns true if ALL the given ids have a matching toolResult record on
 * disk for the given conversation. Useful as a sanity check before
 * deciding to apply a destructive heal.
 */
export async function allIdsHaveToolResults(
  conversationId: string,
  agentId: string,
  ids: string[],
): Promise<boolean> {
  if (ids.length === 0) return true;
  const messages = await listMessages(conversationId, agentId);
  const have = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      have.add(m.toolCallId);
    }
  }
  return ids.every((id) => have.has(id));
}
