/**
 * In-process pub/sub for cron-related broadcast events.
 *
 * The cron scheduler (`cron-scheduler.ts`) publishes here when the
 * underlying `crons.json` changes (locally or externally). The mobile
 * channel WS handler (`home/.letta/channels/mobile/lib/ws-handler.mjs`)
 * subscribes per-connection and forwards as `crons_updated` frames.
 *
 * The bus is intentionally minimal — no replay, no buffering. Late
 * subscribers see only events emitted after they registered. This is
 * the right model for "live notifications"; the canonical state lives
 * in crons.json and can be re-read on demand.
 */

export type CronEventReason =
  | "scheduler_write" // tick fired a task and updated its row
  | "external_write" // mtime moved without our scheduler doing anything
  | "client_mutation" // a WS client called cron_add/cron_delete/cron_delete_all
  | "scheduler_started"
  | "scheduler_stopped";

export interface CronEvent {
  reason: CronEventReason;
  /** Number of tasks currently active in the file, post-event. */
  tasks_active: number;
  /** Timestamp of when the event was published. */
  at: string;
}

type Listener = (event: CronEvent) => void;

const listeners = new Set<Listener>();

export function subscribeCronEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function broadcastCronEvent(event: CronEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // Listeners must not break each other or the publisher.
      console.error("[cron-events] listener threw:", err);
    }
  }
}

/** Test-only helper: drop every listener. Never called from prod code. */
export function __clearCronEventSubscribers(): void {
  listeners.clear();
}
