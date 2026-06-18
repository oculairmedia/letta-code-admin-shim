import type { AnyAgentTool, AgentToolResult } from "@letta-ai/letta-code-sdk";

import {
  getNativeGoalForConversation,
  updateNativeGoalStatusForAgent,
  type NativeGoalStatusResponse,
} from "./native-goal-mode.js";
import { broadcastGoalEvent } from "./goal-events.js";

export const GOAL_CONTROL_TOOL_NAME = "goal_control";

export type GoalControlAction = "status" | "complete" | "blocked";

export interface GoalControlArgs {
  action?: GoalControlAction;
  reason?: string;
}

export interface GoalControlContext {
  agentId: string;
  conversationId: string;
}

export interface GoalControlResult {
  ok: boolean;
  action: GoalControlAction;
  message: string;
  status: NativeGoalStatusResponse | null;
  reason?: string;
}

function parseGoalControlArgs(args: unknown): GoalControlArgs {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      return typeof parsed === "object" && parsed !== null ? parsed as GoalControlArgs : {};
    } catch {
      return {};
    }
  }
  return typeof args === "object" && args !== null ? args as GoalControlArgs : {};
}

function textResult(result: GoalControlResult): AgentToolResult<GoalControlResult> {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result,
  };
}

export async function handleGoalControl(
  context: GoalControlContext,
  rawArgs: unknown,
): Promise<AgentToolResult<GoalControlResult>> {
  const args = parseGoalControlArgs(rawArgs);
  const action = args.action;
  if (action !== "status" && action !== "complete" && action !== "blocked") {
    throw new Error('goal_control action must be "status", "complete", or "blocked"');
  }

  if (action === "status") {
    const status = getNativeGoalForConversation(context.conversationId);
    return textResult({ ok: true, action, message: "Goal status.", status });
  }

  const updated = await updateNativeGoalStatusForAgent(context.agentId, action);
  broadcastGoalEvent({ reason: "client_mutation", at: new Date().toISOString(), status: updated });
  const message = action === "complete"
    ? "Goal marked complete."
    : "Goal marked blocked." + (args.reason ? " Reason: " + args.reason : "");
  return textResult({
    ok: true,
    action,
    message,
    status: updated,
    ...(args.reason ? { reason: args.reason } : {}),
  });
}

export function makeGoalControlTool(context: GoalControlContext): AnyAgentTool {
  return {
    name: GOAL_CONTROL_TOOL_NAME,
    label: "Goal Control",
    description: "Internal hidden control channel for an active shim-driven goal continuation. Reports status or marks the active goal complete/blocked.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "complete", "blocked"],
          description: "status returns current goal summary; complete marks the active goal complete; blocked marks the active goal blocked after the repeated-blocker rule.",
        },
        reason: {
          type: "string",
          description: "Required when action is blocked; concise blocker summary and unblock condition.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: (_toolCallId, args) => handleGoalControl(context, args),
  };
}

export function shouldInjectGoalControlTool(args: {
  metadata?: Record<string, unknown> | null;
  otid?: string | null;
  hasActiveGoal?: boolean;
}): boolean {
  return args.hasActiveGoal === true && (
    args.metadata?.["goal_continuation"] === true ||
    (typeof args.otid === "string" && args.otid.startsWith("goalcont-"))
  );
}
