import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveConversationId, type ResolvedConversation } from "./store.js";

/**
 * Thin wrapper over Letta Code's native Goal mode.
 *
 * IMPORTANT: this does NOT own goal state. Letta Code's `/goal` command and
 * CreateGoal/UpdateGoal tools persist one conversation objective in the
 * project-local `.letta/settings.local.json` under:
 *   conversationGoalsByServer[serverKey][conversationId]
 *
 * The shim only surfaces that native state to mobile. Lifecycle mutations
 * (start/pause/resume/complete/clear/disable/replace) should continue to use
 * the existing `/goal ...` command path so there is one source of truth.
 */

export interface NativeConversationGoal {
  objective: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  activeStartedAt?: string | null;
  activeTimeSeconds?: number;
  tokensUsed?: number;
  tokenBudget?: number | null;
  userStopped?: boolean;
  stoppedReason?: "paused" | "cleared" | string;
  stoppedAt?: string;
}

export interface NativeGoalStatusResponse {
  source: "letta_code_goal_mode";
  server_key: string | null;
  agent_id?: string;
  conversation_id: string | null;
  goal: NativeConversationGoal | null;
  tools_enabled?: boolean;
}

interface SessionRecord {
  agentId?: string;
  conversationId?: string;
}

interface LocalSettings {
  sessionsByServer?: Record<string, SessionRecord>;
  lastSession?: SessionRecord;
  conversationGoalsByServer?: Record<string, Record<string, NativeConversationGoal>>;
  conversationGoalToolsByServer?: Record<string, Record<string, boolean>>;
}

export interface NativeGoalCommandResult extends NativeGoalStatusResponse {
  ok: boolean;
  action: string;
  message: string;
}

export interface NativeGoalUsageDelta {
  conversationId?: string;
  agentId?: string;
  tokensUsed?: number;
  activeSeconds?: number;
}

export interface ActiveNativeGoalEntry {
  agentId: string;
  conversationId: string;
  serverKey: string;
  storageConversationId: string;
  goal: NativeConversationGoal;
}

interface GoalStorageTarget {
  serverKey: string;
  conversationId: string;
  agentId?: string;
  externalConversationId: string;
}

function localSettingsPath(workingDirectory = process.cwd()): string {
  return join(workingDirectory, ".letta", "settings.local.json");
}

function readLocalSettings(workingDirectory = process.cwd()): LocalSettings {
  const path = localSettingsPath(workingDirectory);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as LocalSettings) : {};
  } catch {
    return {};
  }
}

function writeLocalSettings(settings: LocalSettings, workingDirectory = process.cwd()): void {
  const path = localSettingsPath(workingDirectory);
  mkdirSync(join(workingDirectory, ".letta"), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function statusForSession(
  settings: LocalSettings,
  serverKey: string,
  conversationId: string,
  agentId?: string,
): NativeGoalStatusResponse {
  const goal = settings.conversationGoalsByServer?.[serverKey]?.[conversationId] ?? null;
  const toolsEnabled = settings.conversationGoalToolsByServer?.[serverKey]?.[conversationId];
  return {
    source: "letta_code_goal_mode",
    server_key: serverKey,
    ...(agentId ? { agent_id: agentId } : {}),
    conversation_id: agentId ? externalConversationId(agentId, conversationId) : conversationId,
    goal,
    ...(toolsEnabled !== undefined ? { tools_enabled: toolsEnabled } : {}),
  };
}

/** Fallback global settings reader for projects that only have global session info. */
function readGlobalSettings(): LocalSettings {
  const path = join(process.env["HOME"] || homedir(), ".letta", "settings.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as LocalSettings) : {};
  } catch {
    return {};
  }
}

function mergedSettings(): LocalSettings {
  const local = readLocalSettings();
  const global = readGlobalSettings();
  // Letta Code stores conversation goals in project-local settings. Sessions can
  // be present globally or locally; merge both for agent→conversation lookup.
  return {
    ...global,
    ...local,
    sessionsByServer: {
      ...(global.sessionsByServer ?? {}),
      ...(local.sessionsByServer ?? {}),
    },
  };
}

function externalConversationId(agentId: string, conversationId: string): string {
  return conversationId === "default" ? `conv-default-${agentId}` : conversationId;
}

function findDefaultAlias(
  settings: LocalSettings,
  conversationId: string,
): { serverKey: string; agentId: string; storageConversationId: string } | null {
  const match = conversationId.match(/^conv-default-(agent-.+)$/);
  if (!match) return null;
  const agentId = match[1]!;
  for (const session of sortSessionsForAgent(settings, sessionsForAgent(agentId, settings))) {
    if (session.conversationId === "default") {
      return { serverKey: session.serverKey, agentId, storageConversationId: session.conversationId };
    }
  }
  return null;
}

function findByConversationId(settings: LocalSettings, conversationId: string): NativeGoalStatusResponse | null {
  const alias = findDefaultAlias(settings, conversationId);
  const lookupConversationId = alias?.storageConversationId ?? conversationId;
  const lookupServerKey = alias?.serverKey ?? null;
  const byServer = settings.conversationGoalsByServer ?? {};
  for (const [serverKey, goalsByConversation] of Object.entries(byServer)) {
    if (lookupServerKey && serverKey !== lookupServerKey) continue;
    const goal = goalsByConversation[lookupConversationId] ?? null;
    if (goal) {
      const toolsEnabled = settings.conversationGoalToolsByServer?.[serverKey]?.[lookupConversationId];
      return {
        source: "letta_code_goal_mode",
        server_key: serverKey,
        ...(alias?.agentId ? { agent_id: alias.agentId } : {}),
        conversation_id: conversationId,
        goal,
        ...(toolsEnabled !== undefined ? { tools_enabled: toolsEnabled } : {}),
      };
    }
  }
  return null;
}

function findStorageTargetByConversationId(settings: LocalSettings, conversationId: string): GoalStorageTarget | null {
  const alias = findDefaultAlias(settings, conversationId);
  const lookupConversationId = alias?.storageConversationId ?? conversationId;
  const lookupServerKey = alias?.serverKey ?? null;
  const byServer = settings.conversationGoalsByServer ?? {};
  for (const [serverKey, goalsByConversation] of Object.entries(byServer)) {
    if (lookupServerKey && serverKey !== lookupServerKey) continue;
    if (goalsByConversation[lookupConversationId]) {
      return {
        serverKey,
        conversationId: lookupConversationId,
        ...(alias?.agentId ? { agentId: alias.agentId } : {}),
        externalConversationId: conversationId,
      };
    }
  }
  return null;
}

function findStorageTargetByAgentId(settings: LocalSettings, agentId: string): GoalStorageTarget | null {
  for (const session of sortSessionsForAgent(settings, sessionsForAgent(agentId, settings))) {
    const goal = settings.conversationGoalsByServer?.[session.serverKey]?.[session.conversationId] ?? null;
    if (goal) {
      return {
        serverKey: session.serverKey,
        conversationId: session.conversationId,
        agentId,
        externalConversationId: externalConversationId(agentId, session.conversationId),
      };
    }
  }
  return null;
}

export function getNativeGoalForConversation(conversationId: string): NativeGoalStatusResponse | null {
  return findByConversationId(mergedSettings(), conversationId);
}

export function getNativeGoalForAgent(agentId: string): NativeGoalStatusResponse | null {
  const settings = mergedSettings();
  for (const session of sortSessionsForAgent(settings, sessionsForAgent(agentId, settings))) {
    const goal = settings.conversationGoalsByServer?.[session.serverKey]?.[session.conversationId] ?? null;
    const toolsEnabled = settings.conversationGoalToolsByServer?.[session.serverKey]?.[session.conversationId];
    return {
      source: "letta_code_goal_mode",
      server_key: session.serverKey,
      agent_id: agentId,
      conversation_id: externalConversationId(agentId, session.conversationId),
      goal,
      ...(toolsEnabled !== undefined ? { tools_enabled: toolsEnabled } : {}),
    };
  }
  return null;
}

export function wasNativeGoalUserStopped(goal: NativeConversationGoal | null | undefined): boolean {
  return goal?.userStopped === true || goal?.status === "paused" || goal?.status === "cleared";
}


export function addNativeGoalUsage(delta: NativeGoalUsageDelta): NativeGoalStatusResponse | null {
  const tokensUsed = Number.isFinite(delta.tokensUsed) ? Math.max(0, Math.floor(delta.tokensUsed ?? 0)) : 0;
  const activeSeconds = Number.isFinite(delta.activeSeconds) ? Math.max(0, Math.floor(delta.activeSeconds ?? 0)) : 0;
  if (tokensUsed <= 0 && activeSeconds <= 0) return null;

  const local = readLocalSettings();
  const global = readGlobalSettings();
  const settings: LocalSettings = {
    ...local,
    sessionsByServer: { ...(global.sessionsByServer ?? {}), ...(local.sessionsByServer ?? {}) },
  };
  const target = delta.conversationId
    ? findStorageTargetByConversationId(settings, delta.conversationId)
    : delta.agentId
      ? findStorageTargetByAgentId(settings, delta.agentId)
      : null;
  if (!target) return null;

  const byServer = { ...(local.conversationGoalsByServer ?? {}) };
  const goalsForServer = { ...(byServer[target.serverKey] ?? {}) };
  const existing = goalsForServer[target.conversationId] ?? null;
  if (!existing || existing.status !== "active") return null;

  const now = new Date().toISOString();
  const goal: NativeConversationGoal = {
    ...existing,
    tokensUsed: (existing.tokensUsed ?? 0) + tokensUsed,
    activeTimeSeconds: (existing.activeTimeSeconds ?? 0) + activeSeconds,
    updatedAt: now,
  };
  goalsForServer[target.conversationId] = goal;
  byServer[target.serverKey] = goalsForServer;
  local.conversationGoalsByServer = byServer;
  writeLocalSettings(local);

  return statusForSession(local, target.serverKey, target.conversationId, target.agentId);
}

interface AgentSession {
  serverKey: string;
  conversationId: string;
}

export type ConversationResolver = (conversationId: string) => Promise<ResolvedConversation | null>;

export interface NativeGoalListLogger {
  warn?: (...args: unknown[]) => void;
}

function localBackendServerKey(): string | null {
  const dir = process.env["LETTA_LOCAL_BACKEND_DIR"];
  return dir ? `local:${dir}` : null;
}

function sessionsForAgent(agentId: string, settings: LocalSettings): AgentSession[] {
  const out: AgentSession[] = [];
  for (const [serverKey, session] of Object.entries(settings.sessionsByServer ?? {})) {
    if (session.agentId === agentId && session.conversationId) {
      out.push({ serverKey, conversationId: session.conversationId });
    }
  }
  return out;
}

function sessionHasGoal(settings: LocalSettings, session: AgentSession): boolean {
  return settings.conversationGoalsByServer?.[session.serverKey]?.[session.conversationId] != null;
}

function sortSessionsForAgent(settings: LocalSettings, sessions: AgentSession[]): AgentSession[] {
  const preferredLocalKey = localBackendServerKey();
  return [...sessions].sort((a, b) => {
    const aIsPreferredLocal = preferredLocalKey != null && a.serverKey === preferredLocalKey;
    const bIsPreferredLocal = preferredLocalKey != null && b.serverKey === preferredLocalKey;
    if (aIsPreferredLocal !== bIsPreferredLocal) return aIsPreferredLocal ? -1 : 1;

    const aIsLocal = a.serverKey.startsWith("local:");
    const bIsLocal = b.serverKey.startsWith("local:");
    if (aIsLocal !== bIsLocal) return aIsLocal ? -1 : 1;

    const aHasGoal = sessionHasGoal(settings, a);
    const bHasGoal = sessionHasGoal(settings, b);
    if (aHasGoal !== bHasGoal) return aHasGoal ? -1 : 1;

    return 0;
  });
}

function sessionsForStorageConversation(settings: LocalSettings, serverKey: string, conversationId: string): Array<AgentSession & { agentId: string }> {
  const sessions: Array<AgentSession & { agentId: string }> = [];
  for (const [sessionServerKey, session] of Object.entries(settings.sessionsByServer ?? {})) {
    if (sessionServerKey !== serverKey) continue;
    if (!session.agentId || session.conversationId !== conversationId) continue;
    sessions.push({ serverKey: sessionServerKey, conversationId: session.conversationId, agentId: session.agentId });
  }
  return sortSessionsForAgent(settings, sessions) as Array<AgentSession & { agentId: string }>;
}

function goalBudgetExhausted(goal: NativeConversationGoal): boolean {
  return goal.tokenBudget != null && (goal.tokensUsed ?? 0) >= goal.tokenBudget;
}

export async function listActiveNativeGoals(
  resolver: ConversationResolver = resolveConversationId,
  logger: NativeGoalListLogger = console,
): Promise<ActiveNativeGoalEntry[]> {
  const settings = mergedSettings();
  const activeGoals: ActiveNativeGoalEntry[] = [];

  for (const [serverKey, goalsByConversation] of Object.entries(settings.conversationGoalsByServer ?? {})) {
    for (const [storageConversationId, goal] of Object.entries(goalsByConversation)) {
      if (goal.status !== "active" || wasNativeGoalUserStopped(goal)) continue;
      if (goalBudgetExhausted(goal)) continue;

      const sessions = sessionsForStorageConversation(settings, serverKey, storageConversationId);
      if (sessions.length === 0) {
        logger.warn?.(`[goal] skip active goal without session server=${serverKey} conv=${storageConversationId}`);
        continue;
      }

      let resolvedEntry: ActiveNativeGoalEntry | null = null;
      for (const session of sessions) {
        const conversationId = externalConversationId(session.agentId, storageConversationId);
        const resolved = await resolver(conversationId);
        if (resolved?.agentId === session.agentId && resolved.conversationId === storageConversationId) {
          resolvedEntry = {
            agentId: session.agentId,
            conversationId,
            serverKey,
            storageConversationId,
            goal,
          };
          break;
        }
      }

      if (resolvedEntry) activeGoals.push(resolvedEntry);
      else logger.warn?.(`[goal] skip active goal with unresolved conversation server=${serverKey} conv=${storageConversationId}`);
    }
  }

  return activeGoals;
}

async function sessionForAgent(
  agentId: string,
  settings: LocalSettings,
  resolver: ConversationResolver = resolveConversationId,
): Promise<AgentSession | null> {
  const sessions = sortSessionsForAgent(settings, sessionsForAgent(agentId, settings));
  for (const session of sessions) {
    const candidateConversationId = externalConversationId(agentId, session.conversationId);
    const resolved = await resolver(candidateConversationId);
    if (resolved?.agentId === agentId && resolved.conversationId === session.conversationId) {
      return session;
    }
  }
  return sessions[0] ?? null;
}

function accrueActiveSeconds(goal: NativeConversationGoal, now: string): NativeConversationGoal {
  if (goal.status !== "active" || !goal.activeStartedAt) return goal;
  const delta = Math.max(0, Math.floor((Date.parse(now) - Date.parse(goal.activeStartedAt)) / 1000));
  return { ...goal, activeTimeSeconds: (goal.activeTimeSeconds ?? 0) + delta };
}

function suppressNativeGoalTools(local: LocalSettings, serverKey: string, conversationId: string): void {
  const existingTools = local.conversationGoalToolsByServer?.[serverKey];
  if (existingTools?.[conversationId] !== true) return;

  local.conversationGoalToolsByServer = {
    ...(local.conversationGoalToolsByServer ?? {}),
    [serverKey]: {
      ...existingTools,
      [conversationId]: false,
    },
  };
}

function parseTokenBudget(argv: string[]): { tokenBudget: number | null; rest: string[]; replace: boolean } {
  let tokenBudget: number | null = null;
  let replace = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--replace") {
      replace = true;
      continue;
    }
    if (a === "--token-budget") {
      const raw = argv[++i];
      const n = raw ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n <= 0) throw new Error("--token-budget requires a positive number");
      tokenBudget = Math.floor(n);
      continue;
    }
    rest.push(a);
  }
  return { tokenBudget, rest, replace };
}

/**
 * Apply a documented `/goal` command to Letta Code's native project settings.
 * This is intentionally a compatibility wrapper over native Goal-mode state,
 * not a parallel implementation. Mobile can call this endpoint; CLI users can
 * continue to use `/goal` directly.
 */
export async function applyNativeGoalCommandForAgent(
  agentId: string,
  command: string,
  resolver: ConversationResolver = resolveConversationId,
): Promise<NativeGoalCommandResult> {
  const trimmed = command.trim();
  if (!trimmed.startsWith("/goal")) throw new Error("command must start with /goal");
  const local = readLocalSettings();
  const global = readGlobalSettings();
  const settings: LocalSettings = {
    ...local,
    sessionsByServer: { ...(global.sessionsByServer ?? {}), ...(local.sessionsByServer ?? {}) },
  };
  const session = await sessionForAgent(agentId, settings, resolver);
  if (!session) throw new Error(`no active conversation for agent ${agentId}`);
  const now = new Date().toISOString();
  const words = trimmed.split(/\s+/).slice(1);
  const { tokenBudget, rest, replace } = parseTokenBudget(words);
  const sub = rest[0]?.toLowerCase();
  const objective = rest.join(" ").trim();

  const byServer = { ...(local.conversationGoalsByServer ?? {}) };
  const goalsForServer = { ...(byServer[session.serverKey] ?? {}) };
  const existing = goalsForServer[session.conversationId] ?? null;
  let goal: NativeConversationGoal | null = existing;
  let action = "status";
  let message = "Goal status.";

  if (rest.length === 0 || sub === "status") {
    // read-only
  } else if (sub === "pause") {
    if (!existing) throw new Error("no active goal to pause");
    goal = { ...accrueActiveSeconds(existing, now), status: "paused", activeStartedAt: null, updatedAt: now, userStopped: true, stoppedReason: "paused", stoppedAt: now };
    action = "pause";
    message = "Goal paused.";
  } else if (sub === "resume") {
    if (!existing) throw new Error("no goal to resume");
    const { stoppedReason: _stoppedReason, stoppedAt: _stoppedAt, ...resumedGoal } = existing;
    goal = { ...resumedGoal, status: "active", activeStartedAt: now, updatedAt: now, userStopped: false };
    action = "resume";
    message = "Goal resumed.";
  } else if (sub === "complete") {
    if (!existing) throw new Error("no goal to complete");
    goal = { ...accrueActiveSeconds(existing, now), status: "complete", activeStartedAt: null, updatedAt: now };
    action = "complete";
    message = "Goal marked complete.";
  } else if (sub === "clear") {
    delete goalsForServer[session.conversationId];
    goal = null;
    action = "clear";
    message = "Goal cleared.";
  } else if (sub === "disable") {
    delete goalsForServer[session.conversationId];
    const toolsByServer = { ...(local.conversationGoalToolsByServer ?? {}) };
    const tools = { ...(toolsByServer[session.serverKey] ?? {}) };
    delete tools[session.conversationId];
    toolsByServer[session.serverKey] = tools;
    local.conversationGoalToolsByServer = toolsByServer;
    goal = null;
    action = "disable";
    message = "Goal cleared and goal tools disabled for this conversation.";
  } else {
    if (existing && !replace) throw new Error("goal already exists; use /goal --replace <objective>");
    if (!objective) throw new Error("objective is required");
    suppressNativeGoalTools(local, session.serverKey, session.conversationId);
    goal = {
      objective,
      status: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      activeStartedAt: now,
      activeTimeSeconds: replace ? 0 : (existing?.activeTimeSeconds ?? 0),
      tokensUsed: replace ? 0 : (existing?.tokensUsed ?? 0),
      tokenBudget,
      userStopped: false,
    };
    action = replace ? "replace" : "create";
    message = replace ? "Goal replaced." : "Goal created.";
  }

  if (goal) goalsForServer[session.serverKey ? session.conversationId : session.conversationId] = goal;
  byServer[session.serverKey] = goalsForServer;
  local.conversationGoalsByServer = byServer;
  writeLocalSettings(local);
  // Stop any running shim-side continuation loop when the goal is no longer
  // active. Dynamic import avoids a circular dependency (the driver imports
  // this module). Fail-open: the driver also re-checks status each iteration.
  if (action === "pause" || action === "complete" || action === "clear" || action === "disable") {
    void import("./goal-continuation.js")
      .then((mod) => mod.stopContinuation(externalConversationId(agentId, session.conversationId)))
      .catch(() => {});
  }
  return {
    ok: true,
    action,
    message,
    source: "letta_code_goal_mode",
    server_key: session.serverKey,
    agent_id: agentId,
    conversation_id: externalConversationId(agentId, session.conversationId),
    goal,
    ...(local.conversationGoalToolsByServer?.[session.serverKey]?.[session.conversationId] !== undefined
      ? { tools_enabled: local.conversationGoalToolsByServer[session.serverKey]![session.conversationId] }
      : {}),
  };
}

export async function updateNativeGoalStatusForAgent(
  agentId: string,
  status: "complete" | "blocked" | "clear",
  resolver: ConversationResolver = resolveConversationId,
): Promise<NativeGoalCommandResult> {
  const local = readLocalSettings();
  const global = readGlobalSettings();
  const settings: LocalSettings = {
    ...local,
    sessionsByServer: { ...(global.sessionsByServer ?? {}), ...(local.sessionsByServer ?? {}) },
  };
  const session = await sessionForAgent(agentId, settings, resolver);
  if (!session) throw new Error(`no active conversation for agent ${agentId}`);

  const byServer = { ...(local.conversationGoalsByServer ?? {}) };
  const goalsForServer = { ...(byServer[session.serverKey] ?? {}) };
  const existing = goalsForServer[session.conversationId] ?? null;
  if (!existing) throw new Error(`no active goal to mark ${status}`);

  const now = new Date().toISOString();
  let goal: NativeConversationGoal | null = null;
  if (status === "clear") {
    delete goalsForServer[session.conversationId];
  } else {
    goal = { ...accrueActiveSeconds(existing, now), status, activeStartedAt: null, updatedAt: now };
    goalsForServer[session.conversationId] = goal;
  }
  byServer[session.serverKey] = goalsForServer;
  local.conversationGoalsByServer = byServer;
  writeLocalSettings(local);

  void import("./goal-continuation.js")
    .then((mod) => mod.stopContinuation(externalConversationId(agentId, session.conversationId)))
    .catch(() => {});

  return {
    ok: true,
    action: status,
    message: status === "complete" ? "Goal marked complete." : status === "clear" ? "Goal cleared." : "Goal marked blocked.",
    ...statusForSession(local, session.serverKey, session.conversationId, agentId),
  };
}

export const _nativeGoalModeInternals = Object.freeze({
  readLocalSettings,
  readGlobalSettings,
  writeLocalSettings,
});
