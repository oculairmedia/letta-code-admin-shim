/** In-process pub/sub for agent metadata update notifications. */

export type AgentEventReason =
  | "created"
  | "updated"
  | "deleted"
  | "skill_installed"
  | "skill_uninstalled";

export interface AgentEvent {
  agent_id: string;
  reason: AgentEventReason;
  at: string;
  version?: string;
}

type Listener = (event: AgentEvent) => void;

const listeners = new Set<Listener>();

export function subscribeAgentEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function broadcastAgentEvent(event: AgentEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[agent-events] listener threw:", err);
    }
  }
}

export function __clearAgentEventSubscribers(): void {
  listeners.clear();
}
