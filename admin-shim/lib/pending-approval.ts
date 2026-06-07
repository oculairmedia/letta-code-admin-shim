/**
 * Durable pending-approval store (lcp-indw, Phase 2) — the load-bearing
 * piece of the server-side permissions feature.
 *
 * The existing in-memory `approvalGates` Map (agent-pool.ts) is the live
 * rendezvous between a parked turn and the inbound decision. It is correct
 * for the live case but is the ONLY record that "a turn is waiting" —
 * nothing on disk says so, so a restart or a long client gap loses it.
 *
 * This module adds the missing on-disk truth: ONE file per pending
 * approval, keyed by runId, co-located under the run dir so it travels with
 * frames.jsonl and is swept by the existing run machinery for free:
 *
 *   <storageDir>/runs/<runId>/pending-approval.json
 *
 * Single-writer-per-run already holds (turns are serialized per worker), so
 * these files use atomic tmp+rename only — NO global lock (unlike the
 * permissions config, which is read-modify-write).
 *
 * The `resolveApproval(runId, decision)` funnel is the SINGLE internal
 * function that both the WS user_action path AND the REST approval
 * endpoints call. There is no second code path that can diverge — WS frames
 * are canonical, REST is a strict thin mirror. Resolution is idempotent:
 * first decision wins; a second (other client or REST) is a no-op
 * `already_resolved`. Exactly one tool execution.
 *
 * DURABILITY GUARANTEE (R1, honestly scoped): a restart cannot truly resume
 * a parked tool call — the parked turn's letta-code CLI session dies with
 * the shim. The guarantee we honor is "no pending approval is silently lost
 * / no eternal spinner": on boot we sweep surviving `pending` files, flip
 * them to `expired`, append a synthetic terminal frame so a reconnecting
 * client sees a resolved card, and finalize the run. This is NOT
 * tool-resume-after-reboot.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  appendRunFrameOnDisk,
  finalizeRunOnDisk,
  getRunDir,
  listRunIdsOnDisk,
  recordApprovalDecision,
  recordApprovalPolicy,
  type ApprovalScope,
} from "./runs.js";
import { resolveApprovalGate, rejectApprovalGate } from "./agent-pool.js";
import { broadcastApprovalEvent } from "./approval-events.js";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type PendingStatus = "pending" | "approved" | "denied" | "expired";

export interface PendingApproval {
  run_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  tool_call_id: string; // synthetic id (SDK limitation)
  tool_name: string;
  tool_input: Record<string, unknown>;
  reason: string; // from the matched rule
  rule_source: "agent" | "global" | "default";
  status: PendingStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null; // userId / deviceId if supplied
  decision_reason: string | null;
}

/** Decision payload accepted by resolveApproval (mirrors ApprovalDecision). */
export interface ResolveDecision {
  decision: "approve" | "deny";
  scope?: ApprovalScope;
  reason?: string;
  userId?: string;
  actionId?: string;
}

export interface ResolveResult {
  status: PendingStatus;
  already_resolved?: boolean;
  /** false when there was no pending approval on disk for this run. */
  found: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Paths + atomic IO (one file per run; single-writer-per-run; no lock)
// ──────────────────────────────────────────────────────────────────────

const FILE_NAME = "pending-approval.json";

function pendingPath(runId: string): string {
  return join(getRunDir(runId), FILE_NAME);
}

export function readPendingApproval(runId: string): PendingApproval | null {
  const path = pendingPath(runId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p["run_id"] !== "string") return null;
    return parsed as PendingApproval;
  } catch {
    return null;
  }
}

function writePendingApproval(record: PendingApproval): void {
  const dir = getRunDir(record.run_id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FILE_NAME);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { flush: true });
  renameSync(tmp, path);
}

/** Remove the pending-approval file (turn end / cleanup). Best-effort. */
export function clearPendingApproval(runId: string): void {
  try {
    rmSync(pendingPath(runId), { force: true });
  } catch {
    // best-effort
  }
}

// ──────────────────────────────────────────────────────────────────────
// Create (called from the evaluator's `ask` path before parking)
// ──────────────────────────────────────────────────────────────────────

export interface CreatePendingInput {
  runId: string;
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason: string;
  ruleSource: "agent" | "global" | "default";
}

/**
 * Write `pending-approval.json` with status:"pending" BEFORE the turn parks
 * on the durable wait. The canonical `approval_request_message` frame is
 * emitted separately by the adapter (it persists to frames.jsonl and
 * replays via subscribeToRun) — this file is the durable "a turn is
 * waiting" truth that the frame log alone does not carry.
 */
export function createPendingApproval(input: CreatePendingInput): PendingApproval {
  const record: PendingApproval = {
    run_id: input.runId,
    agent_id: input.agentId,
    conversation_id: input.conversationId,
    tool_call_id: input.toolCallId,
    tool_name: input.toolName,
    tool_input: input.toolInput,
    reason: input.reason,
    rule_source: input.ruleSource,
    status: "pending",
    created_at: new Date().toISOString(),
    decided_at: null,
    decided_by: null,
    decision_reason: null,
  };
  writePendingApproval(record);
  return record;
}

// ──────────────────────────────────────────────────────────────────────
// The single resolve funnel (WS-canonical, REST-mirror)
// ──────────────────────────────────────────────────────────────────────

/**
 * The ONE internal function both the WS user_action path and the REST
 * approval endpoints call. It:
 *   1. Reads the durable pending file. Absent → {found:false}.
 *   2. Idempotency: if already terminal (not "pending") → no-op
 *      {already_resolved:true}. First decision wins; exactly one tool
 *      execution because only the first call resolves the in-memory gate.
 *   3. Rewrites the file to approved/denied + decided_at/by.
 *   4. Records the audit decision (and, for Session/Forever approve, the
 *      reusable policy) via runs.ts — same audit trail as the live path.
 *   5. Resolves the in-process approvalGate (the live rendezvous) so the
 *      parked turn proceeds. This is what produces exactly-one execution.
 *   6. Broadcasts `approval_resolved` so a second connected client updates.
 *
 * `gateResolve` defaults to the real resolveApprovalGate but is injectable
 * for tests that want to assert "exactly one execution" without a live SDK.
 */
export function resolveApproval(
  runId: string,
  decision: ResolveDecision,
  gateResolve: typeof resolveApprovalGate = resolveApprovalGate,
): ResolveResult {
  const existing = readPendingApproval(runId);
  if (!existing) {
    return { status: "expired", found: false };
  }
  if (existing.status !== "pending") {
    // Idempotent: second decision (other client / REST) is a no-op.
    return { status: existing.status, already_resolved: true, found: true };
  }

  const at = new Date().toISOString();
  const scope: ApprovalScope = decision.scope ?? (decision.decision === "deny" ? "Deny" : "Once");
  const reason =
    decision.reason ?? (decision.decision === "deny" ? "user_denied" : "user_approved");
  const actionId = decision.actionId ?? `resolve-${runId}-${Date.now()}`;
  const status: PendingStatus = decision.decision === "approve" ? "approved" : "denied";

  // 3. Rewrite the durable file FIRST so a concurrent second resolver sees a
  //    terminal status and short-circuits as already_resolved.
  const updated: PendingApproval = {
    ...existing,
    status,
    decided_at: at,
    decided_by: decision.userId ?? null,
    decision_reason: reason,
  };
  writePendingApproval(updated);

  // 4. Audit + (optional) reusable policy — same helpers the live path uses.
  recordApprovalDecision(runId, {
    action_id: actionId,
    tool_name: existing.tool_name,
    decision: decision.decision,
    scope,
    reason,
    timestamp: at,
    ...(decision.userId ? { user_id: decision.userId } : {}),
  });
  if (decision.decision === "approve" && (scope === "Session" || scope === "Forever")) {
    recordApprovalPolicy(runId, existing.conversation_id, {
      action_id: actionId,
      tool_name: existing.tool_name,
      scope,
      timestamp: at,
      ...(decision.userId ? { user_id: decision.userId } : {}),
    });
  }

  // 5. Resolve the live in-memory gate so the parked turn proceeds. The gate
  //    being keyed by runId (matching this store) is what guarantees exactly
  //    one tool execution: only the FIRST resolveApproval finds the file in
  //    "pending" and reaches here; the gate is then consumed and gone.
  gateResolve(runId, {
    decision: decision.decision,
    scope,
    reason,
    actionId,
    ...(decision.userId ? { userId: decision.userId } : {}),
  });

  // 6. Broadcast so a second connected client learns of the resolution.
  broadcastApprovalEvent({
    run_id: runId,
    tool_call_id: existing.tool_call_id,
    status,
    decided_by: decision.userId ?? null,
    at,
  });

  return { status, found: true };
}

// ──────────────────────────────────────────────────────────────────────
// List (REST GET /approvals/pending)
// ──────────────────────────────────────────────────────────────────────

export interface ListPendingFilters {
  agentId?: string | undefined;
  conversationId?: string | undefined;
}

/** Scan each run dir's pending-approval.json for status:"pending", filtered. */
export function listPendingApprovals(filters: ListPendingFilters = {}): PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const runId of listRunIdsOnDisk()) {
    const p = readPendingApproval(runId);
    if (!p || p.status !== "pending") continue;
    if (filters.agentId && p.agent_id !== filters.agentId) continue;
    if (filters.conversationId && p.conversation_id !== filters.conversationId) continue;
    out.push(p);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Boot sweep (R1: no eternal spinner after restart)
// ──────────────────────────────────────────────────────────────────────

/**
 * On boot, scan for surviving `status:"pending"` approvals. Each represents
 * a turn that was parked when the shim died — its CLI session is gone, so
 * the tool call cannot resume. Flip to `expired`, append a synthetic
 * terminal frame to frames.jsonl (so a reconnecting client sees a resolved/
 * expired card, not an eternal spinner), finalize the run as failed/expired,
 * reject any (impossible-but-defensive) live gate, and broadcast.
 *
 * Returns the number of pending approvals expired.
 */
export function sweepPendingApprovalsOnBoot(): number {
  let expired = 0;
  for (const runId of listRunIdsOnDisk()) {
    const p = readPendingApproval(runId);
    if (!p || p.status !== "pending") continue;
    const at = new Date().toISOString();
    const updated: PendingApproval = {
      ...p,
      status: "expired",
      decided_at: at,
      decided_by: null,
      decision_reason: "expired_on_restart",
    };
    writePendingApproval(updated);

    // Append a synthetic terminal frame so reconnect/replay shows the card
    // resolved instead of an eternal spinner. The run's in-memory handle is
    // gone after a restart, so we write directly to frames.jsonl on disk.
    try {
      appendRunFrameOnDisk(runId, {
        type: "stream_event",
        event: {
          message_type: "approval_resolved",
          run_id: runId,
          tool_call_id: p.tool_call_id,
          status: "expired",
          reason: "expired_on_restart",
          date: at,
        },
      });
    } catch {
      // best-effort
    }

    // Finalize the run as failed/expired (on-disk; no handle after restart).
    try {
      finalizeRunOnDisk(runId, { status: "failed", stopReason: "approval_expired_on_restart" });
    } catch {
      // best-effort
    }

    // Defensive: reject any live gate (there won't be one post-restart).
    try {
      rejectApprovalGate(runId, new Error("expired_on_restart"));
    } catch {
      // best-effort
    }

    broadcastApprovalEvent({
      run_id: runId,
      tool_call_id: p.tool_call_id,
      status: "expired",
      decided_by: null,
      at,
    });
    expired += 1;
  }
  return expired;
}

