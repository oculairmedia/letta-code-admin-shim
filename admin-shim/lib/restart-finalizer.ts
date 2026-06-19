import { randomUUID } from "node:crypto";

import { resolveApprovalGate, type ApprovalDecision } from "./agent-pool.js";
import { broadcastApprovalEvent } from "./approval-events.js";
import {
  appendRunFrameOnDisk,
  finalizeRunOnDisk,
  getRun,
  listRunIdsOnDisk,
} from "./runs.js";
import {
  readPendingApproval,
  resolveApproval,
} from "./pending-approval.js";
import type { LettaStreamFrame, LettaInnerEvent } from "./types/letta-stream.js";

export const SHIM_RESTART_REASON = "shim_restarting";
export const SHIM_RESTART_MESSAGE = "Restarting shim to deploy — reconnecting…";

export function isShimSelfRestartTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "Bash") return false;
  const command = typeof toolInput["command"] === "string" ? toolInput["command"] : "";
  if (!command) return false;
  return /(?:^|[;&|()\s])systemctl\s+(?:--\S+\s+)*(?:restart|stop)\s+(?:--\S+\s+)*lettashim(?:\.service)?(?:\s|$|[;&|()])/m.test(command)
    || /(?:^|[;&|()\s])kill(?:\s+-\w+)?\s+\$?\(?\s*(?:cat\s+)?(?:\/run\/lettashim\.pid|\/var\/run\/lettashim\.pid|\$\$)\s*\)?(?:\s|$|[;&|()])/m.test(command);
}

export function detachShimSelfRestartInput(toolInput: Record<string, unknown>): Record<string, unknown> {
  const command = typeof toolInput["command"] === "string" ? toolInput["command"] : "";
  if (!command) return toolInput;
  const escaped = command.replace(/'/g, `'"'"'`);
  return {
    ...toolInput,
    command: `setsid sh -c 'sleep 0.25; ${escaped}' >/dev/null 2>&1 < /dev/null &`,
    description: typeof toolInput["description"] === "string"
      ? toolInput["description"]
      : "Restart shim service after reporting status",
  };
}

export function makeShimRestartNoticeFrame(input: {
  sessionId?: string;
  agentId: string;
  conversationId: string;
  runId: string;
  seqId: number;
  toolName?: string;
  toolCallId?: string;
}): LettaStreamFrame {
  const at = new Date().toISOString();
  return {
    type: "stream_event",
    session_id: input.sessionId ?? "shim-restart",
    uuid: `shim-restart-${randomUUID()}`,
    timestamp: at,
    event: {
      message_type: "approval_resolved",
      id: `shim-restart-${input.seqId}`,
      date: at,
      agent_id: input.agentId,
      conversation_id: input.conversationId,
      run_id: input.runId,
      seq_id: input.seqId,
      status: "approved",
      reason: SHIM_RESTART_MESSAGE,
      tool_name: input.toolName ?? "Bash",
      ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {}),
    } as unknown as LettaInnerEvent,
  };
}

export function emitShimRestartNotice(input: {
  onFrame?: ((frame: LettaStreamFrame, meta: { runId: string }) => void) | null;
  sessionId?: string;
  agentId: string;
  conversationId: string;
  runId: string;
  seqId: number;
  toolName?: string;
  toolCallId?: string;
}): void {
  const frame = makeShimRestartNoticeFrame(input);
  try { input.onFrame?.(frame, { runId: input.runId }); } catch { /* best-effort */ }
}

export function resolveShimRestartApproval(runId: string, toolName = "Bash"): ApprovalDecision {
  const decision: ApprovalDecision = {
    decision: "approve",
    scope: "Once",
    reason: SHIM_RESTART_MESSAGE,
    actionId: `shim-restart-${randomUUID()}`,
  };
  resolveApprovalGate(runId, decision);
  const pending = readPendingApproval(runId);
  if (pending?.status === "pending") {
    resolveApproval(runId, {
      decision: "approve",
      scope: "Once",
      reason: decision.reason,
      actionId: decision.actionId,
    });
  }
  return { ...decision, reason: `${decision.reason} (${toolName})` };
}

export function finalizeRestartingRunsOnShutdown(): number {
  let finalized = 0;
  for (const runId of listRunIdsOnDisk()) {
    const record = getRun(runId);
    if (!record || record.status !== "running") continue;
    const pending = readPendingApproval(runId);
    if (pending?.status === "pending") {
      resolveApproval(runId, {
        decision: "deny",
        scope: "Deny",
        reason: SHIM_RESTART_REASON,
        actionId: `shim-restarting-${randomUUID()}`,
      });
      appendRunFrameOnDisk(runId, {
        type: "stream_event",
        event: {
          message_type: "approval_resolved",
          run_id: runId,
          tool_call_id: pending.tool_call_id,
          status: "expired",
          reason: SHIM_RESTART_REASON,
          date: new Date().toISOString(),
        },
      });
    }
    appendRunFrameOnDisk(runId, {
      message_type: "stop_reason",
      run_id: runId,
      agent_id: record.agent_id ?? null,
      conversation_id: record.conversation_id ?? null,
      stop_reason: SHIM_RESTART_REASON,
      status: "interrupted",
    });
    appendRunFrameOnDisk(runId, {
      type: "turn_done",
      message_type: "turn_done",
      turn_id: runId,
      run_id: runId,
      agent_id: record.agent_id ?? null,
      conversation_id: record.conversation_id ?? null,
      status: "interrupted",
      stop_reason: SHIM_RESTART_REASON,
      reason: SHIM_RESTART_MESSAGE,
    });
    if (finalizeRunOnDisk(runId, { status: "failed", stopReason: SHIM_RESTART_REASON })) finalized += 1;
  }
  return finalized;
}
