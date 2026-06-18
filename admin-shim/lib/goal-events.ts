/** In-process pub/sub for native Goal mode update notifications. */

import type { NativeGoalStatusResponse } from "./native-goal-mode.js";

export type GoalEventReason = "client_mutation" | "external_write";

export interface GoalEvent {
  reason: GoalEventReason;
  at: string;
  status: NativeGoalStatusResponse;
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

export function __clearGoalEventSubscribers(): void {
  listeners.clear();
}
