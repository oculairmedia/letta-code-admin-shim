import { cancelRun, collectDanglingToolCallIds, getRun } from "./runs.js";
import { healConversation } from "./conversation-healer.js";

const healingByConversation = new Map<string, Promise<void>>();

function conversationKey(agentId: string, conversationId: string): string {
  return `${agentId}::${conversationId}`;
}

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
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cancel-heal] failed to inspect run ${runId}: ${message}`);
    return;
  }
  if (dangling.length === 0) return;

  try {
    const report = await healConversation(conversationId, agentId, dangling, { runId });
    if (report.messagesEdited + report.messagesRemoved + report.messagesAppended > 0) {
      console.log(
        `[cancel-heal] run=${runId} conversation=${conversationId} ` +
        `settled=${report.settled.length} removed=${report.removed.length} ` +
        `unresolved=${report.unresolved.length}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cancel-heal] failed for run ${runId} conversation ${conversationId}: ${message}`);
  }
}

/** Wait until any cancellation repair already registered for this conversation finishes. */
export async function awaitCancelHeal(agentId: string, conversationId: string): Promise<void> {
  await healingByConversation.get(conversationKey(agentId, conversationId));
}

/**
 * Cancel a run and register its repair before cancellation continuations can start
 * the next queued turn. The boolean contract is retained for WS callers; both
 * immediate and already-queued sends await the per-conversation barrier in the
 * SDK adapter before reading or writing the transcript.
 */
export function cancelRunAndHeal(runId: string): boolean {
  const run = getRun(runId);
  const cancelled = cancelRun(runId);
  if (!cancelled || !run?.agent_id || !run.conversation_id) return cancelled;

  const key = conversationKey(run.agent_id, run.conversation_id);
  const previous = healingByConversation.get(key) ?? Promise.resolve();
  const healing = previous.then(() => healAfterCancel(runId, run.agent_id, run.conversation_id));
  healingByConversation.set(key, healing);
  void healing.finally(() => {
    if (healingByConversation.get(key) === healing) healingByConversation.delete(key);
  });
  return true;
}
