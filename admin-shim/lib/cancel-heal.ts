/**
 * lcp-im5q: best-effort post-cancel transcript repair, shared by every
 * cancel entrypoint.
 *
 * A cancel-mid-tool-call leaves an orphan tool_use/tool_calls entry on
 * disk with no matching tool_return. Strict providers (OpenAI /
 * Anthropic) reject the FOLLOWING turn's replayed transcript with an
 * invalid_request_error, which surfaces to the user as
 * "Model provider error: Provider finish_reason:" until the transcript
 * is repaired. `healConversation` settles the orphan by inserting a
 * synthetic error toolResult (see lib/conversation-healer.ts).
 *
 * The heal is best-effort and detached: any failure is logged but never
 * reaches the caller — the user's UX is "cancelled", not "cancelled but
 * the heal I/O failed". Idempotent: re-running for the same run finds no
 * dangling IDs the second time.
 *
 * History: this originally lived inline in server.ts and only covered the
 * REST cancel route (POST /v1/agents/{id}/messages/cancel). The WS
 * channel cancel frame (plugin `host.cancelRun`) bypassed it, so a
 * mobile stop-button cancel still wedged the conversation. It now backs
 * both paths via `cancelRunAndHeal`.
 */

import { collectDanglingToolCallIds, getRun } from "./runs.js";
import { cancelRun } from "./agent-pool.js";
import { healConversation } from "./conversation-healer.js";

/**
 * Repair the run's conversation transcript after a successful cancel.
 * Detached best-effort: resolves without throwing, always.
 */
export async function healAfterCancel(
  runId: string,
  agentId: string | null,
  conversationId: string | null,
): Promise<void> {
  if (!agentId || !conversationId) return;
  let dangling: string[];
  try {
    dangling = collectDanglingToolCallIds(runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cancel-heal] collectDanglingToolCallIds failed for run ${runId}: ${msg}`);
    return;
  }
  if (dangling.length === 0) return;
  try {
    const report = await healConversation(conversationId, agentId, dangling, { runId });
    if (report.messagesEdited + report.messagesRemoved + report.messagesAppended > 0) {
      console.log(
        `[cancel-heal] run=${runId} conversation=${conversationId} ` +
        `settled=${report.settled.length} removed=${report.removed.length} ` +
        `unresolved=${report.unresolved.length} ` +
        `appended=${report.messagesAppended} removed_msgs=${report.messagesRemoved} edited_msgs=${report.messagesEdited}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cancel-heal] healConversation failed for run ${runId} conv ${conversationId}: ${msg}`);
  }
}

/**
 * Drop-in replacement for `cancelRun` that also schedules the post-cancel
 * transcript heal. Same synchronous contract as `cancelRun` (the caller's
 * response must not wait on heal I/O); the heal runs detached.
 */
export function cancelRunAndHeal(runId: string): boolean {
  const run = getRun(runId);
  const cancelled = cancelRun(runId);
  if (cancelled && run) {
    void healAfterCancel(runId, run.agent_id, run.conversation_id);
  }
  return cancelled;
}
