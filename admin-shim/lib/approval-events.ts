/**
 * In-process pub/sub for approval-resolution broadcast events (lcp-indw).
 *
 * Modeled exactly on `cron-events.ts`. The single `resolveApproval` funnel
 * (lib/pending-approval.ts) publishes here whenever a parked `ask` is
 * resolved (from WS user_action OR REST). The mobile channel WS handler
 * (home/.letta/channels/mobile/lib/ws-handler.mjs) subscribes per-connection
 * and forwards each event as an `approval_resolved` frame so a SECOND
 * connected client learns that the FIRST client (or a REST caller) decided.
 *
 * The bus is intentionally minimal — no replay, no buffering. Late
 * subscribers see only events emitted after they registered. Canonical
 * state lives in the pending-approval file + the frame log (frames.jsonl),
 * both of which a reconnecting client re-reads on demand.
 */

export interface ApprovalEvent {
  run_id: string;
  tool_call_id: string;
  /** Terminal status of the approval. */
  status: "approved" | "denied" | "expired";
  /** userId / deviceId of the decider, when supplied. */
  decided_by: string | null;
  /** ISO timestamp of when the decision was recorded. */
  at: string;
}

type Listener = (event: ApprovalEvent) => void;

const listeners = new Set<Listener>();

export function subscribeApprovalEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function broadcastApprovalEvent(event: ApprovalEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // Listeners must not break each other or the publisher.
      console.error("[approval-events] listener threw:", err);
    }
  }
}

/** Test-only helper: drop every listener. Never called from prod code. */
export function __clearApprovalEventSubscribers(): void {
  listeners.clear();
}
