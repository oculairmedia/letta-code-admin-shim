/**
 * In-process pub/sub for goal-related broadcast events (epic lcp-ctz2,
 * bead lcp-wgn7). Mirrors cron-events.ts.
 *
 * The goals REST handlers publish here when an agent's goals change
 * (create/update/delete/progress). The mobile channel WS handler subscribes
 * per-connection and forwards as `goals_updated` frames so mobile reflects
 * goal changes live. Minimal bus — no replay/buffering; canonical state lives
 * in goals.json and is re-read on demand (GET /v1/agents/{id}/goals).
 */

export type GoalEventReason =
  | "created"
  | "updated"
  | "deleted"
  | "progress"
  | "client_mutation";

export interface GoalEvent {
  /** Agent whose goals changed, so clients can scope refreshes. */
  agent_id: string;
  reason: GoalEventReason;
  /** Number of ACTIVE goals for the agent, post-event. */
  goals_active: number;
  /** The goal id this event concerns, when applicable. */
  goal_id?: string;
  /** Timestamp of when the event was published. */
  at: string;
}

type Listener = (event: GoalEvent) => void;

const listeners = new Set<Listener>();

export function subscribeGoalEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function broadcastGoalEvent(event: GoalEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[goal-events] listener threw:", err);
    }
  }
}

/** Test-only helper: drop every listener. Never called from prod code. */
export function __clearGoalEventSubscribers(): void {
  listeners.clear();
}
