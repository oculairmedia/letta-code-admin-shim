/**
 * lcp-4d5f: per-agent reflection (sleeptime) settings.
 *
 * The shim is the authority for reflection settings of agents it hosts.
 * Settings persist as one JSON sidecar per agent under
 * `<storageDir>/reflection-settings/<b64url(agentId)>.json` and are applied
 * by passing SDK `sleeptime` options on session resume (letta-code maps them
 * to its /sleeptime-equivalent overrides). A change therefore takes effect
 * when the agent's next SDK session spawns; the WS set handler recycles idle
 * pool workers so that is normally immediate.
 *
 * Defaults mirror letta-code's DEFAULT_REFLECTION_SETTINGS
 * (trigger "compaction-event", step count 25) with behavior "reminder".
 *
 * NOTE: there is intentionally no `model` field yet — in local-backend mode
 * letta-code's resolveSubagentModel always inherits the parent agent's model
 * for reflection, and launchReflectionSubagent passes no override. A model
 * knob needs upstream letta-code support first (tracked in lcp-4d5f notes).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { _internals as storeInternals } from "./store.js";

export type ReflectionTrigger = "off" | "step-count" | "compaction-event";
export type ReflectionBehavior = "reminder" | "auto-launch";

export interface ReflectionSettings {
  trigger: ReflectionTrigger;
  behavior: ReflectionBehavior;
  step_count: number;
}

export interface ReflectionSettingsRecord extends ReflectionSettings {
  /** True when the agent has an explicit persisted override (vs pure defaults). */
  persisted: boolean;
  updated_at: string | null;
}

export const DEFAULT_REFLECTION_SETTINGS: ReflectionSettings = {
  trigger: "compaction-event",
  behavior: "reminder",
  step_count: 25,
};

const TRIGGERS: ReadonlySet<string> = new Set(["off", "step-count", "compaction-event"]);
const BEHAVIORS: ReadonlySet<string> = new Set(["reminder", "auto-launch"]);

export interface ReflectionSettingsEvent {
  agent_id: string;
  settings: ReflectionSettings;
  at: string;
}

type ReflectionListener = (event: ReflectionSettingsEvent) => void;
const listeners = new Set<ReflectionListener>();

export function subscribeReflectionEvents(listener: ReflectionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function broadcast(event: ReflectionSettingsEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[reflection-settings] listener threw:", err);
    }
  }
}

function settingsPath(agentId: string): string {
  return join(
    storeInternals.storageDir(),
    "reflection-settings",
    `${storeInternals.b64url(agentId)}.json`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStepCount(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  return floored >= 1 ? floored : null;
}

export function getReflectionSettings(agentId: string): ReflectionSettingsRecord {
  const path = settingsPath(agentId);
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(parsed)) {
        const trigger = typeof parsed["trigger"] === "string" && TRIGGERS.has(parsed["trigger"])
          ? (parsed["trigger"] as ReflectionTrigger)
          : DEFAULT_REFLECTION_SETTINGS.trigger;
        const behavior = typeof parsed["behavior"] === "string" && BEHAVIORS.has(parsed["behavior"])
          ? (parsed["behavior"] as ReflectionBehavior)
          : DEFAULT_REFLECTION_SETTINGS.behavior;
        const stepCount = normalizeStepCount(parsed["step_count"]) ?? DEFAULT_REFLECTION_SETTINGS.step_count;
        return {
          trigger,
          behavior,
          step_count: stepCount,
          persisted: true,
          updated_at: typeof parsed["updated_at"] === "string" ? parsed["updated_at"] : null,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[reflection-settings] ignoring malformed sidecar ${path}: ${msg}`);
    }
  }
  return { ...DEFAULT_REFLECTION_SETTINGS, persisted: false, updated_at: null };
}

export interface SetReflectionSettingsInput {
  trigger?: unknown;
  behavior?: unknown;
  step_count?: unknown;
}

export type SetReflectionSettingsResult =
  | { success: true; settings: ReflectionSettingsRecord }
  | { success: false; error: string };

export function setReflectionSettings(
  agentId: string,
  input: SetReflectionSettingsInput,
): SetReflectionSettingsResult {
  const current = getReflectionSettings(agentId);
  const next: ReflectionSettings = {
    trigger: current.trigger,
    behavior: current.behavior,
    step_count: current.step_count,
  };

  if (input.trigger !== undefined) {
    if (typeof input.trigger !== "string" || !TRIGGERS.has(input.trigger)) {
      return { success: false, error: `invalid trigger ${JSON.stringify(input.trigger)}; valid: off, step-count, compaction-event` };
    }
    next.trigger = input.trigger as ReflectionTrigger;
  }
  if (input.behavior !== undefined) {
    if (typeof input.behavior !== "string" || !BEHAVIORS.has(input.behavior)) {
      return { success: false, error: `invalid behavior ${JSON.stringify(input.behavior)}; valid: reminder, auto-launch` };
    }
    next.behavior = input.behavior as ReflectionBehavior;
  }
  if (input.step_count !== undefined) {
    const stepCount = normalizeStepCount(input.step_count);
    if (stepCount === null) {
      return { success: false, error: `invalid step_count ${JSON.stringify(input.step_count)}; must be a positive integer` };
    }
    next.step_count = stepCount;
  }

  const updatedAt = new Date().toISOString();
  const path = settingsPath(agentId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...next, updated_at: updatedAt }, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort temp cleanup
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `failed to persist reflection settings: ${msg}` };
  }

  broadcast({ agent_id: agentId, settings: next, at: updatedAt });
  return { success: true, settings: { ...next, persisted: true, updated_at: updatedAt } };
}

/**
 * SDK `sleeptime` option block for session resume, or undefined when the
 * agent has no persisted override (preserves server/CLI defaults).
 */
export function sleeptimeOptionsForAgent(
  agentId: string,
): { trigger: ReflectionTrigger; behavior: ReflectionBehavior; stepCount: number } | undefined {
  const settings = getReflectionSettings(agentId);
  if (!settings.persisted) return undefined;
  return { trigger: settings.trigger, behavior: settings.behavior, stepCount: settings.step_count };
}
