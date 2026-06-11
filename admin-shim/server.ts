/**
 * Letta-Mobile compatibility shim — exposes a subset of the Letta server
 * REST API on top of letta-code's LocalBackend on-disk state.
 *
 * Phase 1 endpoints (read + chat):
 *   GET    /v1/health/
 *   GET    /v1/agents                            list
 *   GET    /v1/agents/count                      count
 *   GET    /v1/agents/{id}                       single
 *   GET    /v1/agents/{id}/messages              messages list
 *   GET    /v1/agents/{id}/context               context window overview
 *   GET    /v1/agents/{id}/core-memory/blocks    blocks attached to agent
 *   GET    /v1/blocks                            all blocks (alias)
 *   GET    /v1/blocks/{id}                       single block
 *   GET    /v1/models                            available models
 *   POST   /v1/agents/{id}/messages              send + stream (next iter)
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import {
  getAgentRecord,
  getConversation,
  listAgents,
  listAllConversations,
  listConversationsForAgent,
  listMessages,
  readBlocksForAgent,
  readMessageTimestamps,
  readOtidMap,
  readSystemPrompt,
  resolveConversationId,
  writeAgentRecord,
  listAvailableSkills,
  getSkillDetail,
  listInstalledSkillsForAgent,
  getInstalledSkillDetail,
  installSkillToAgent,
  uninstallSkillFromAgent,
  searchSkills,
  publishSkillToStore,
  deleteSkillFromStore,
  _internals as storeInternals,
  type PublishSkillInput,
  type OnDiskAgentRecord,
  type OnDiskConversation,
} from "./lib/store.js";
import {
  agentToLettaState,
  conversationToLetta,
  localMessageToConversationMessages,
} from "./lib/translate.js";
import { handleSendMessage } from "./lib/chat.js";
import { cancelRun, getAgentPool } from "./lib/agent-pool.js";
import { resolveAgentIdAlias } from "./lib/agent-aliases.js";
import {
  aggregateUsage,
  buildMessageRunMap,
  deleteRun,
  getRun,
  inFlightMessageIds,
  listRunSteps,
  listRuns,
  type ListRunsParams,
} from "./lib/runs.js";
import {
  discoverOpenAICompatibleModels,
  FALLBACK_MODEL_CATALOG,
  VISION_MODEL_PATTERNS,
} from "./lib/model-catalog.js";
import {
  bridgeSendMessage,
  getMobileChannelAdapter,
  handleReflectionSettingsGet,
} from "./lib/mobile-channel-host.js";
import { mobileConversationCursorCapabilities } from "./lib/mobile-conversation-cursors.js";
import {
  getCronSchedulerStatus,
  startCronScheduler,
  stopCronScheduler,
} from "./lib/cron-scheduler.js";
import {
  addTask as addCronTask,
  deleteAllTasks as deleteAllCronTasks,
  deleteTask as deleteCronTask,
  getActiveTasks as getActiveCronTasks,
  getTask as getCronTask,
  isValidCron,
  listTasks as listCronTasks,
  parseAt,
  parseEvery,
  updateTask as updateCronTask,
} from "./lib/crons.js";
import { broadcastCronEvent } from "./lib/cron-events.js";
import type { AddTaskInput, CronTask } from "./lib/types/crons.js";
import {
  recordSubagentDispatch,
  markSubagentCompleted,
  markSubagentFailed,
  snapshotSubagents,
  getSubagent,
  updateSubagentTodoProgress,
  type TodoProgress,
} from "./lib/subagent-registry.js";
import {
  getStatus as getSearchStatus,
  rebuild as rebuildSearchIndex,
  search as runSearch,
} from "./lib/search.js";
import {
  evaluatePermission,
  readAgentConfigOrEffective,
  readGlobalConfig,
  writeAgentConfig,
  writeGlobalConfig,
  patchAgentConfig,
  type PermissionAction,
  type PermissionConfig,
  type PermissionRule,
} from "./lib/permissions.js";
import {
  listPendingApprovals,
  resolveApproval,
  sweepPendingApprovalsOnBoot,
} from "./lib/pending-approval.js";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env["SHIM_PORT"] || 8291);
const HOST = process.env["SHIM_HOST"] || "0.0.0.0";
const MOBILE_WS_KEEPALIVE_PING_INTERVAL_MS = Number(process.env["SHIM_MOBILE_WS_PING_INTERVAL_MS"] || 30_000);
const MOBILE_WS_KEEPALIVE_PONG_TIMEOUT_MS = Number(process.env["SHIM_MOBILE_WS_PONG_TIMEOUT_MS"] || 10_000);
const MOBILE_WS_KEEPALIVE_CLOSE_CODE = 4001;
const MOBILE_WS_KEEPALIVE_TERMINATE_GRACE_MS = 5_000;

// lcp-sdk.10: the SDK transport requires letta-code to be spawned with
// `--backend local`. The SDK doesn't pass that flag, so we route through
// a small wrapper (see admin-shim/scripts/letta-cli-sdk-wrapper.mjs)
// that injects it before exec. The SDK reads LETTA_CLI_PATH at spawn
// time; if the operator hasn't set it, point it at the wrapper here so
// the install just works out of the box. LETTA_CLI_PATH_REAL is the
// path to the actual letta-code binary the wrapper execs.
//
// Remove this auto-wiring once the SDK or CLI honors local-backend
// selection from `LETTA_LOCAL_BACKEND_EXPERIMENTAL=1` alone (LET-9013).
function autoWireSdkCliPath(): void {
  if (process.env["LETTA_CLI_PATH"]) return;
  const here = new URL(import.meta.url).pathname;
  const distRoot = join(here, "..", "..");
  const candidates = [
    join(distRoot, "..", "scripts", "letta-cli-sdk-wrapper.mjs"),
    join(distRoot, "scripts", "letta-cli-sdk-wrapper.mjs"),
  ];
  const wrapper = candidates.find((p) => existsSync(p));
  if (!wrapper) return;
  process.env["LETTA_CLI_PATH"] = wrapper;
  if (!process.env["LETTA_CLI_PATH_REAL"]) {
    try {
      const req = createRequire(import.meta.url);
      process.env["LETTA_CLI_PATH_REAL"] = req.resolve("@letta-ai/letta-code");
    } catch {
      // Operator must set LETTA_CLI_PATH_REAL explicitly if @letta-ai/letta-code
      // isn't resolvable from this process's module graph (e.g. global install).
    }
  }
}
autoWireSdkCliPath();

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    ...extraHeaders,
  });
  res.end(payload);
}

function notFound(res: ServerResponse, what: string = "not found"): void {
  json(res, 404, { detail: what });
}

interface Pagination {
  limit: number;
  offset: number;
}

function parsePagination(searchParams: URLSearchParams): Pagination {
  const limit = Number(searchParams.get("limit") ?? 50);
  const offset = Number(searchParams.get("offset") ?? 0);
  return { limit: Number.isFinite(limit) ? limit : 50, offset: Number.isFinite(offset) ? offset : 0 };
}

function defaultConversationForAgent(agentId: string): Promise<OnDiskConversation | null> {
  return getConversation("default", agentId);
}

// ── handlers ──────────────────────────────────────────────────────

// Server identity — a UUID generated on first run, persisted to disk, returned
// in every /v1/health/ response. Mobile binds its cache by (baseUrl,serverId).
// When this changes, the client should treat the cache as a different
// universe and self-invalidate. See README "Server identity" section.
const SERVER_ID_FILE = join(storeInternals.storageDir(), ".shim-server-id");
function readOrCreateServerId(): string {
  try {
    if (existsSync(SERVER_ID_FILE)) {
      const cached = readFileSync(SERVER_ID_FILE, "utf8").trim();
      if (cached) return cached;
    }
  } catch {}
  const fresh = randomUUID();
  try {
    mkdirSync(join(SERVER_ID_FILE, ".."), { recursive: true });
    writeFileSync(SERVER_ID_FILE, fresh + "\n");
  } catch (err) {
    console.error(`server_id persist failed: ${(err as Error).message}`);
  }
  return fresh;
}
const SERVER_ID = readOrCreateServerId();
const SERVER_VERSION = "shim-0.2.0";
const SERVER_STARTED_AT = new Date().toISOString();
const MOBILE_TRANSPORT_CONTRACT = Object.freeze({
  mobile_ws: true,
  ws_endpoint: "/shim/v1/mobile",
  canonical_live_transport: "ws",
  rest_role: "cold_start_reconcile_repair",
  sse_role: "legacy_non_canonical_for_mobile_ws_sessions",
  exclusivity: "after_ws_welcome_do_not_consume_sse_for_owned_conversations",
  keepalive: {
    protocol: "ws_ping_pong",
    client_ping_supported: true,
    server_ping_interval_ms: MOBILE_WS_KEEPALIVE_PING_INTERVAL_MS,
    server_pong_timeout_ms: MOBILE_WS_KEEPALIVE_PONG_TIMEOUT_MS,
    timeout_close_code: MOBILE_WS_KEEPALIVE_CLOSE_CODE,
  },
  ...mobileConversationCursorCapabilities(),
});
console.log(`server_id: ${SERVER_ID}`);

function installMobileWsProtocolKeepalive(ws: WebSocket): void {
  let awaitingPong = false;
  let pingSentAt = 0;
  let terminateTimer: NodeJS.Timeout | null = null;

  const clearTerminateTimer = (): void => {
    if (terminateTimer) {
      clearTimeout(terminateTimer);
      terminateTimer = null;
    }
  };

  const cleanup = (): void => {
    clearInterval(interval);
    clearTerminateTimer();
  };

  const closeForPongTimeout = (): void => {
    cleanup();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
      try {
        ws.close(MOBILE_WS_KEEPALIVE_CLOSE_CODE, "pong timeout");
      } catch (err) {
        console.warn(`[mobile-channel] ws keepalive close failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    terminateTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) {
        try { ws.terminate(); } catch {}
      }
    }, MOBILE_WS_KEEPALIVE_TERMINATE_GRACE_MS);
    terminateTimer.unref();
  };

  const sendPing = (): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (awaitingPong && now - pingSentAt >= MOBILE_WS_KEEPALIVE_PONG_TIMEOUT_MS) {
      closeForPongTimeout();
      return;
    }
    if (awaitingPong) return;
    awaitingPong = true;
    pingSentAt = now;
    try {
      ws.ping();
    } catch (err) {
      console.warn(`[mobile-channel] ws keepalive ping failed: ${err instanceof Error ? err.message : String(err)}`);
      closeForPongTimeout();
    }
  };

  const interval = setInterval(sendPing, MOBILE_WS_KEEPALIVE_PING_INTERVAL_MS);
  interval.unref();

  ws.on("pong", () => {
    awaitingPong = false;
    pingSentAt = 0;
  });
  ws.on("ping", (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.pong(data); } catch {}
    }
  });
  ws.once("close", cleanup);
  ws.once("error", cleanup);
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, {
    version: SERVER_VERSION,
    status: "ok",
    server_id: SERVER_ID,
    server_started_at: SERVER_STARTED_AT,
    backend: "letta-code-local",
    capabilities: {
      mobile_transport: MOBILE_TRANSPORT_CONTRACT,
    },
  });
}

function handleShimCapabilities(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, {
    server_id: SERVER_ID,
    backend: "letta-code-local",
    transports: {
      rest: {
        available: true,
        role: "cold_start_reconcile_repair",
      },
      sse: {
        available: true,
        role: "legacy_non_canonical_for_mobile_ws_sessions",
      },
      ws: {
        available: true,
        endpoint: "/shim/v1/mobile",
        canonical_for: ["mobile_live_mutations"],
      },
    },
    mobile_transport: MOBILE_TRANSPORT_CONTRACT,
    reflection_settings: {
      ws_frames: ["reflection_settings_get", "reflection_settings_set"],
      ws_push: "reflection_settings_updated",
      rest_read_mirror: "/v1/agents/{agent_id}/reflection",
    },
  });
}

// lcp-4d5f: REST read mirror. Alias resolution + defaults live in the shared
// WS handler so both transports report identical settings.
function handleAgentReflection(_req: IncomingMessage, res: ServerResponse, agentId: string): void {
  const result = handleReflectionSettingsGet(agentId);
  if (!result.success) return badRequest(res, result.error);
  json(res, 200, {
    agent_id: result.agent_id,
    settings: result.settings,
    ws_endpoint: "/shim/v1/mobile",
    ws_frames: ["reflection_settings_get", "reflection_settings_set"],
  });
}

function handlePoolStats(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, getAgentPool().stats());
}

async function handleAgentsList(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { limit, offset } = parsePagination(url.searchParams);
  const tagFilter = url.searchParams.getAll("tags");
  const nameFilter = url.searchParams.get("name");
  let agents = await listAgents();
  if (tagFilter.length > 0) {
    agents = agents.filter((a) => (a.tags ?? []).some((t) => tagFilter.includes(t)));
  }
  if (nameFilter) {
    agents = agents.filter((a) =>
      ((a.name as string | undefined) ?? "").toLowerCase().includes(nameFilter.toLowerCase()),
    );
  }
  const sliced = agents.slice(offset, offset + limit);
  const projected = await Promise.all(sliced.map(async (a) => {
    await defaultConversationForAgent(a.id);
    const messages = await listMessages("default", a.id);
    const blocks = readBlocksForAgent(a.id);
    return agentToLettaState(a, { messages, blocks });
  }));
  json(res, 200, projected);
}

async function handleAgentsCount(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  json(res, 200, (await listAgents()).length);
}

function resolveAgentRecord(agentId: string): OnDiskAgentRecord | null {
  let a = getAgentRecord(agentId);
  if (a) return a;
  const canonical = resolveAgentIdAlias(agentId, (id) => getAgentRecord(id) != null);
  if (canonical !== agentId) {
    a = getAgentRecord(canonical);
    if (!a) return null;
    console.log(`[shim] agent alias: ${agentId} → ${canonical}`);
    return a;
  }
  return null;
}

async function handleAgentDetail(_req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
  const a = resolveAgentRecord(agentId);
  if (!a) return notFound(res, `agent ${agentId}`);
  const messages = await listMessages("default", a.id);
  const blocks = readBlocksForAgent(a.id);
  json(res, 200, agentToLettaState(a, { messages, blocks }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updateModelSettingsFromLlmConfig(
  settings: Record<string, unknown>,
  llmConfig: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...settings };
  const mappedFields: ReadonlyArray<readonly [string, string]> = [
    ["temperature", "temperature"],
    ["max_tokens", "max_tokens"],
    ["context_window", "context_window_limit"],
    ["provider_name", "provider_type"],
    ["model_endpoint_type", "provider_type"],
  ];
  for (const [source, target] of mappedFields) {
    const value = llmConfig[source];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      next[target] = value;
    }
  }
  return next;
}

function modelHandleFromUpdate(body: Record<string, unknown>, current: OnDiskAgentRecord): string | undefined {
  const model = body["model"];
  if (typeof model === "string" && model.length > 0) return model;

  const llmConfig = body["llm_config"];
  if (!isRecord(llmConfig)) return undefined;

  const handle = llmConfig["handle"];
  if (typeof handle === "string" && handle.length > 0) return handle;

  const configModel = llmConfig["model"];
  if (typeof configModel !== "string" || configModel.length === 0) return undefined;
  const provider = llmConfig["provider_name"];
  if (typeof provider === "string" && provider.length > 0 && !configModel.includes("/")) {
    return `${provider}/${configModel}`;
  }
  if (!configModel.includes("/") && typeof current.model === "string" && current.model.includes("/")) {
    return `${current.model.split("/", 1)[0]}/${configModel}`;
  }
  return configModel;
}

function applyAgentUpdate(current: OnDiskAgentRecord, body: Record<string, unknown>): OnDiskAgentRecord {
  const next: OnDiskAgentRecord = { ...current };
  const model = modelHandleFromUpdate(body, current);
  if (model) next.model = model;

  if (typeof body["name"] === "string") next.name = body["name"];
  if (typeof body["description"] === "string" || body["description"] === null) next.description = body["description"];
  if (typeof body["system"] === "string") next.system = body["system"];
  if (Array.isArray(body["tags"]) && body["tags"].every((tag) => typeof tag === "string")) {
    next.tags = body["tags"];
  }

  let modelSettings = isRecord(current.model_settings) ? { ...current.model_settings } : {};
  if (isRecord(body["model_settings"])) {
    modelSettings = { ...modelSettings, ...body["model_settings"] };
  }
  if (isRecord(body["llm_config"])) {
    modelSettings = updateModelSettingsFromLlmConfig(modelSettings, body["llm_config"]);
  }
  if (Object.keys(modelSettings).length > 0) next.model_settings = modelSettings;

  if (isRecord(body["compaction_settings"]) || body["compaction_settings"] === null) {
    next.compaction_settings = body["compaction_settings"];
  }
  next["updated_at"] = new Date().toISOString();
  return next;
}

async function handleAgentUpdate(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
  const current = resolveAgentRecord(agentId);
  if (!current) return notFound(res, `agent ${agentId}`);
  const body = await readJsonBody(req);
  const next = applyAgentUpdate(current, body);
  await writeAgentRecord(next);
  const updated = getAgentRecord(next.id) ?? next;
  const messages = await listMessages("default", updated.id);
  const blocks = readBlocksForAgent(updated.id);
  json(res, 200, agentToLettaState(updated, { messages, blocks }));
}

// vibesync-tr3e / vibesync-razp: create an agent by writing the on-disk
// record directly, instead of spawning letta-code's `createAgent` CLI path
// (which the SDK invokes with `--system-custom`, rejected as ambiguous by
// the bundled letta.js 0.26.3). The shim already owns the store shape — an
// agent is just `<storageDir>/agents/<b64url(id)>.json` plus, for system
// prompt / persona, a memfs `system/*.md` block that readBlocksForAgent
// surfaces. This is the single store-owner path: vibesync (and any client)
// POSTs here over HTTP rather than each spawning its own letta-code.
//
// Accepts a vanilla-ish CreateAgent body:
//   { name?, system?|systemPrompt?, model?|llm_config.handle, tags?,
//     description?, model_settings?, memory_blocks?:[{label,value}],
//     persona?, id? }
// Returns 201 with the vanilla AgentState shape.
async function handleAgentCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);

  const id =
    (typeof body["id"] === "string" && body["id"]) ||
    `agent-${cryptoRandomUUID()}`;
  if (getAgentRecord(id)) {
    return json(res, 409, { detail: `agent ${id} already exists` });
  }

  const now = new Date().toISOString();
  const systemPrompt =
    (typeof body["system"] === "string" && body["system"]) ||
    (typeof body["systemPrompt"] === "string" && body["systemPrompt"]) ||
    "";
  const model = modelHandleFromUpdate(body, { id } as OnDiskAgentRecord);
  const tags = Array.isArray(body["tags"]) && body["tags"].every((t) => typeof t === "string")
    ? (body["tags"] as string[])
    : [];

  let modelSettings: Record<string, unknown> = {};
  if (isRecord(body["model_settings"])) modelSettings = { ...body["model_settings"] };
  if (isRecord(body["llm_config"])) {
    modelSettings = updateModelSettingsFromLlmConfig(modelSettings, body["llm_config"]);
  }

  const record: OnDiskAgentRecord = {
    id,
    name: typeof body["name"] === "string" ? body["name"] : id,
    description: typeof body["description"] === "string" ? body["description"] : null,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    tags,
    ...(model ? { model } : {}),
    ...(Object.keys(modelSettings).length > 0 ? { model_settings: modelSettings } : {}),
    created_at: now,
    updated_at: now,
    _mtimeMs: Date.now(),
    _ctimeMs: Date.now(),
  };
  await writeAgentRecord(record);

  // Persist system prompt + any supplied memory blocks as memfs system/*.md
  // files so readBlocksForAgent surfaces them (the same place the local
  // backend projects memory). persona convenience field maps to a persona
  // block; system prompt maps to a `system_prompt` block.
  const memSysDir = join(storeInternals.storageDir(), "memfs", id, "memory", "system");
  try {
    mkdirSync(memSysDir, { recursive: true });
    if (systemPrompt) {
      writeFileSync(join(memSysDir, "system_prompt.md"), systemPrompt);
    }
    if (typeof body["persona"] === "string" && body["persona"]) {
      writeFileSync(join(memSysDir, "persona.md"), body["persona"]);
    }
    const blocks = body["memory_blocks"];
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (!isRecord(b)) continue;
        const label = b["label"];
        const value = b["value"];
        if (typeof label === "string" && label && typeof value === "string") {
          // sanitize label into a filename
          const safe = label.replace(/[^A-Za-z0-9_-]/g, "_");
          writeFileSync(join(memSysDir, `${safe}.md`), value);
        }
      }
    }
  } catch (err) {
    console.error(`[shim] agent create memfs write failed for ${id}: ${(err as Error).message}`);
  }

  const created = getAgentRecord(id) ?? record;
  const messages = await listMessages("default", created.id);
  const outBlocks = readBlocksForAgent(created.id);
  json(res, 201, agentToLettaState(created, { messages, blocks: outBlocks }));
}

async function handleAgentMessages(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  agentId: string,
): Promise<void> {
  const a = resolveAgentRecord(agentId);
  if (!a) return notFound(res, `agent ${agentId}`);
  const { limit } = parsePagination(url.searchParams);
  const before = url.searchParams.get("before") ?? undefined;
  const conversationId = url.searchParams.get("conversation_id") ?? "default";
  let items = await listMessages(conversationId, agentId, { limit, before });
  // lcp-r0m: drop in-flight assistant/tool messages owned by an active run.
  // Mirrors the filter in handleConversationMessagesList — same race, same
  // fix. See lib/runs.ts inFlightMessageIds for rationale.
  const inFlight = inFlightMessageIds(
    agentId,
    conversationId,
    items.map((m) => (m as { id?: unknown }).id).filter((id): id is string => typeof id === "string"),
  );
  if (inFlight.size > 0) {
    items = items.filter((m) => {
      const mid = (m as { id?: unknown }).id;
      return typeof mid !== "string" || !inFlight.has(mid);
    });
  }
  // lcp-cox: use the same fan-out projection as /v1/conversations/{id}/messages
  // so tool turns surface as tool_call_message + tool_return_message wire
  // frames (vanilla Letta shape) instead of the legacy hybrid that hard-coded
  // tool_calls=null. Sidecars carry the real timestamps and mobile-supplied
  // otids onto the projected messages.
  const realTimes = await readMessageTimestamps(conversationId, agentId);
  const otidMap = await readOtidMap(conversationId, agentId);
  const runIdsByMessageId = buildMessageRunMap({ agentId, conversationId });
  const projected: ReturnType<typeof localMessageToConversationMessages> = [];
  for (const m of items) {
    for (const p of localMessageToConversationMessages(m, {
      realTimes,
      otidMap,
      runIdsByMessageId,
    })) {
      projected.push(p);
    }
  }
  json(res, 200, projected);
}

async function handleAgentContext(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  agentId: string,
): Promise<void> {
  const a = resolveAgentRecord(agentId);
  if (!a) return notFound(res, `agent ${agentId}`);
  // mobile passes the synthesized external conv id; resolve to internal.
  const requestedConv = url.searchParams.get("conversation_id") ?? "default";
  const resolved = requestedConv === "default"
    ? { conversationId: "default", agentId }
    : (await resolveConversationId(requestedConv)) ?? { conversationId: requestedConv, agentId };
  const sp = readSystemPrompt(resolved.conversationId, resolved.agentId);
  const messages = await listMessages(resolved.conversationId, resolved.agentId);
  const spContent =
    sp && typeof sp === "object" && "content" in sp && typeof (sp as { content: unknown }).content === "string"
      ? (sp as { content: string }).content
      : undefined;
  const systemPrompt = spContent ?? (typeof a.system === "string" ? a.system : "") ?? "";
  // lcp-nwd: same run_id attribution as the messages-list path.
  const runIdsByMessageId = buildMessageRunMap({
    agentId: resolved.agentId,
    conversationId: resolved.conversationId,
  });
  // lcp-cox: fan out to vanilla LettaMessage shape — same as the
  // /v1/conversations/{id}/messages path — so tool turns are visible in the
  // context-window view too. Sidecars supply real timestamps + otid mapping.
  const realTimes = await readMessageTimestamps(resolved.conversationId, resolved.agentId);
  const otidMap = await readOtidMap(resolved.conversationId, resolved.agentId);
  const projected: ReturnType<typeof localMessageToConversationMessages> = [];
  for (const m of messages) {
    for (const p of localMessageToConversationMessages(m, {
      realTimes,
      otidMap,
      runIdsByMessageId,
    })) {
      projected.push(p);
    }
  }
  json(res, 200, {
    context_window_size_current:
      Math.ceil(systemPrompt.length / 4) + messages.length * 50,
    context_window_size_max: 200000,
    num_messages: messages.length,
    num_archival_memory: 0,
    num_recall_memory: messages.length,
    num_tokens_external_memory_summary: 0,
    num_tokens_system: Math.ceil(systemPrompt.length / 4),
    num_tokens_core_memory: 0,
    num_tokens_summary_memory: 0,
    num_tokens_messages: messages.length * 50,
    num_tokens_functions_definitions: 0,
    num_tokens_memory_filesystem: 0,
    num_tokens_tool_usage_rules: 0,
    num_tokens_directories: 0,
    external_memory_summary: "",
    system_prompt: systemPrompt,
    core_memory: "",
    summary_memory: null,
    memory_filesystem: null,
    tool_usage_rules: null,
    directories: [],
    messages: projected,
    functions_definitions: [],
  });
}

function handleAgentBlocks(_req: IncomingMessage, res: ServerResponse, agentId: string): void {
  if (!resolveAgentRecord(agentId)) return notFound(res, `agent ${agentId}`);
  json(res, 200, readBlocksForAgent(agentId));
}

async function handleBlocksList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Union of all per-agent blocks. Real Letta has globally addressable blocks
  // but LocalBackend doesn't, so we synthesize.
  const all = [];
  for (const a of await listAgents()) {
    all.push(...readBlocksForAgent(a.id));
  }
  json(res, 200, all);
}

async function handleBlockDetail(_req: IncomingMessage, res: ServerResponse, blockId: string): Promise<void> {
  for (const a of await listAgents()) {
    const blocks = readBlocksForAgent(a.id);
    const hit = blocks.find((b) => b.id === blockId);
    if (hit) return json(res, 200, hit);
  }
  notFound(res, `block ${blockId}`);
}

interface VanillaModelOptions {
  handle: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

function vanillaModel({ handle, name, contextWindow = 200000, maxTokens = 16384 }: VanillaModelOptions): Record<string, unknown> {
  // Full vanilla Letta server model shape — every field the FastAPI server
  // surfaces, including reasoning/effort/etc fields mobile UI may reflect.
  return {
    handle,
    name,
    display_name: name,
    provider_type: "openai",
    provider_name: handle.split("/", 1)[0] || "lmstudio",
    model_type: "llm",
    model: name,
    model_endpoint_type: "openai",
    model_endpoint: process.env["LMSTUDIO_BASE_URL"] || "http://localhost:8082/v1",
    provider_category: "base",
    model_wrapper: null,
    context_window: contextWindow,
    put_inner_thoughts_in_kwargs: false,
    temperature: 1.0,
    max_tokens: maxTokens,
    enable_reasoner: /reasoning/i.test(handle),
    reasoning_effort: null,
    max_reasoning_tokens: 0,
    effort: null,
    frequency_penalty: null,
    compatibility_type: null,
    verbosity: null,
    tier: null,
    parallel_tool_calls: false,
    response_format: null,
    strict: false,
    return_logprobs: false,
    top_logprobs: null,
    return_token_ids: false,
    tool_call_parser: null,
    max_context_window: contextWindow,
  };
}

const STATIC_FALLBACK_MODELS: VanillaModelOptions[] = [
  ...Object.values(FALLBACK_MODEL_CATALOG["lmstudio"] ?? {}).map((model) => ({
    handle: `lmstudio/${model.id}`,
    name: model.id,
    contextWindow: model.contextWindow,
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
  })),
    { handle: "lmstudio/opus-4-8", name: "opus-4-8", contextWindow: 1000000, maxTokens: 16384 },
    { handle: "lmstudio/sonnet-4-5", name: "sonnet-4-5" },
    { handle: "lmstudio/gpt-5.5", name: "gpt-5.5", contextWindow: 1050000, maxTokens: 128000 },
    { handle: "lmstudio/gpt-5.3-codex-spark", name: "gpt-5.3-codex-spark", contextWindow: 400000, maxTokens: 128000 },
];

async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const baseUrl = process.env["LMSTUDIO_BASE_URL"] || "http://localhost:8082/v1";
  const discovered = await discoverOpenAICompatibleModels(baseUrl);
  const modelOptions = discovered
    .filter((id) => !id.includes("-reasoning-"))
    .map((id) => ({ handle: `lmstudio/${id}`, name: id }));
  const fallbackOptions = STATIC_FALLBACK_MODELS.filter((fallback) =>
    !modelOptions.some((model) => model.handle === fallback.handle),
  );
  json(res, 200, [...modelOptions, ...fallbackOptions].map(vanillaModel));
}

interface BuiltinToolDefinition {
  name: string;
  description: string;
}

const BUILTIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  { name: "Bash", description: "Execute a bash command on the client machine." },
  { name: "Read", description: "Read a file from the local filesystem." },
  { name: "Write", description: "Create or overwrite a file on the local filesystem." },
  { name: "Edit", description: "Apply a precise edit to a file on the local filesystem." },
  { name: "Glob", description: "Search the filesystem for files matching a glob pattern." },
  { name: "Grep", description: "Search file contents for a pattern." },
  { name: "Skill", description: "Invoke a skill from the local skill registry." },
  { name: "Agent", description: "Delegate work to a specialized subagent." },
  { name: "TodoWrite", description: "Maintain a todo list for the current session." },
  { name: "memory", description: "Manage agent memory blocks and memfs entries." },
  { name: "TaskOutput", description: "Read output from a previously dispatched task." },
  { name: "TaskStop", description: "Stop a running task." },
  { name: "EnterPlanMode", description: "Enter plan mode (proposes a plan without executing)." },
  { name: "ExitPlanMode", description: "Exit plan mode." },
];

function vanillaTool({ name, description }: BuiltinToolDefinition): Record<string, unknown> {
  // Deterministic id so successive calls return the same tool id.
  const idHash = Buffer.from(`tool:${name}`).toString("base64url").slice(0, 24).toLowerCase();
  return {
    id: `tool-${idHash}`,
    tool_type: "custom",
    description,
    source_type: "python",
    name,
    tags: [],
    source_code: `def ${name}():\n    """${description}"""\n    raise Exception("This tool executes client-side only")`,
    json_schema: {
      name,
      description,
      parameters: { type: "object", properties: {}, required: [] },
    },
    args_json_schema: {},
    return_char_limit: 50000,
    pip_requirements: null,
    npm_requirements: null,
    default_requires_approval: false,
    enable_parallel_execution: false,
    created_by_id: "user-00000000-0000-4000-8000-000000000000",
    last_updated_by_id: "user-00000000-0000-4000-8000-000000000000",
    project_id: null,
    metadata_: null,
  };
}

function handleTools(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, BUILTIN_TOOL_DEFINITIONS.map(vanillaTool));
}

function handleToolDetail(_req: IncomingMessage, res: ServerResponse, toolId: string): void {
  const match = BUILTIN_TOOL_DEFINITIONS
    .map(vanillaTool)
    .find((t) => t["id"] === toolId);
  if (!match) return notFound(res, `tool ${toolId}`);
  json(res, 200, match);
}

interface VanillaProviderOptions {
  name: string;
  providerType: string;
  baseUrl: string;
}

function vanillaProvider({ name, providerType, baseUrl }: VanillaProviderOptions): Record<string, unknown> {
  const idHash = Buffer.from(`provider:${name}`).toString("base64url").slice(0, 24).toLowerCase();
  return {
    id: `provider-${idHash}`,
    name,
    provider_type: providerType,
    provider_category: "byok",
    api_key: null,
    base_url: baseUrl,
    access_key: null,
    region: null,
    api_version: null,
    organization_id: "org-00000000-0000-4000-8000-000000000000",
    updated_at: new Date().toISOString(),
    last_synced: new Date().toISOString(),
    api_key_enc: "placeholder",
    access_key_enc: null,
  };
}

function handleProviders(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, [
    vanillaProvider({
      name: "lmstudio-local",
      providerType: "openai",
      baseUrl: process.env["LMSTUDIO_BASE_URL"] || "http://localhost:8082/v1",
    }),
  ]);
}

async function sendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  conversationId?: string,
): Promise<void> {
  if (!resolveAgentRecord(agentId)) return notFound(res, `agent ${agentId}`);
  try {
    await handleSendMessage(req, res, agentId, { conversationId });
  } catch (err) {
    if (!res.writableEnded) {
      json(res, 500, { detail: `chat dispatch failed: ${(err as Error).message}` });
    }
  }
}

// ── /v1/conversations namespace ────────────────────────────────────

async function handleConversationsList(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { limit, offset } = parsePagination(url.searchParams);
  const agentId = url.searchParams.get("agent_id") ?? undefined;
  const items = await (agentId ? listConversationsForAgent(agentId) : listAllConversations());
  items.sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  json(res, 200, items.slice(offset, offset + limit).map(conversationToLetta));
}

async function handleConversationDetail(_req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
  const conv = await getConversation(conversationId);
  if (!conv) return notFound(res, `conversation ${conversationId}`);
  json(res, 200, conversationToLetta(conv));
}

async function handleConversationCreate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const body = await readJsonBody(req);
  // mobile sends agent_id BOTH in query string AND in body — accept either.
  const agentId =
    url.searchParams.get("agent_id") ??
    (body["agent_id"] as string | null | undefined) ??
    (body["agentId"] as string | null | undefined);
  if (!agentId || !resolveAgentRecord(agentId)) {
    return json(res, 400, { detail: "agent_id required (and must exist)" });
  }

  // Vanilla Letta server behaviour: every POST creates a brand-new
  // conversation. Mobile's chat lifecycle depends on this (each fresh-route
  // chat screen creates a fresh conv); idempotency here breaks mobile UX.
  const conversationId = (body["id"] as string | null | undefined) ?? `conv-${cryptoRandomUUID()}`;
  const now = new Date().toISOString();
  const conv: OnDiskConversation = {
    id: conversationId,
    agent_id: agentId,
    archived: false,
    archived_at: null,
    created_at: now,
    updated_at: now,
    last_message_at: now,
    summary: (body["summary"] as string | null | undefined) ?? null,
    in_context_message_ids: [],
  };
  const key = `conversation:${conversationId}`;
  const dir = join(storeInternals.storageDir(), "conversations", storeInternals.b64url(key));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "conversation.json"), JSON.stringify(conv, null, 2) + "\n");
  writeFileSync(join(dir, "messages.jsonl"), "");
  json(res, 201, conversationToLetta(conv));
}

async function handleConversationUpdate(req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
  const conv = await getConversation(conversationId);
  if (!conv) return notFound(res, `conversation ${conversationId}`);
  const body = await readJsonBody(req);
  const next: OnDiskConversation = {
    ...conv,
    summary: (body["summary"] as string | null | undefined) ?? conv.summary,
    archived: (body["archived"] as unknown) ?? (conv as Record<string, unknown>)["archived"],
    archived_at: body["archived"] === true ? new Date().toISOString() : (conv as Record<string, unknown>)["archived_at"] as string | null | undefined,
    updated_at: new Date().toISOString(),
  };
  const key = conv.id === "default" ? `default:${conv.agent_id}` : `conversation:${conv.id}`;
  const dir = join(storeInternals.storageDir(), "conversations", storeInternals.b64url(key));
  writeFileSync(join(dir, "conversation.json"), JSON.stringify(next, null, 2) + "\n");
  json(res, 200, conversationToLetta(next));
}

async function handleConversationDelete(_req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
  const conv = await getConversation(conversationId);
  if (!conv) return notFound(res, `conversation ${conversationId}`);
  if (conv.id === "default") {
    return json(res, 400, { detail: "cannot delete the default conversation" });
  }
  const key = `conversation:${conv.id}`;
  const dir = join(storeInternals.storageDir(), "conversations", storeInternals.b64url(key));
  rmSync(dir, { recursive: true, force: true });
  json(res, 200, { id: conv.id, deleted: true });
}

async function handleConversationMessagesList(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  externalConvId: string,
): Promise<void> {
  const resolved = await resolveConversationId(externalConvId);
  if (!resolved) {
    // Unknown conv (e.g. cached client-side from a prior Python-Letta-server
    // session, or stale UI state). Return an empty list rather than 404 so
    // mobile's retry loop doesn't thrash.
    return json(res, 200, []);
  }
  const { limit } = parsePagination(url.searchParams);
  const before = url.searchParams.get("before") ?? undefined;
  const order = (url.searchParams.get("order") ?? "asc").toLowerCase();
  let items = await listMessages(resolved.conversationId, resolved.agentId, { limit, before });
  // lcp-r0m: drop in-flight assistant/tool messages owned by an active run.
  // The WS path is streaming pure deltas under cm-stream-<otid> for these
  // messages; returning the cumulative snapshot here races the stream and
  // produces incoherent text on the client (the 2026-05-19 "StandStanding
  // by..." repro). On the next hydrate after turn_done they appear cleanly.
  const inFlight = inFlightMessageIds(
    resolved.agentId,
    resolved.conversationId,
    items.map((m) => (m as { id?: unknown }).id).filter((id): id is string => typeof id === "string"),
  );
  if (inFlight.size > 0) {
    items = items.filter((m) => {
      const mid = (m as { id?: unknown }).id;
      return typeof mid !== "string" || !inFlight.has(mid);
    });
  }
  if (order === "desc") items = [...items].reverse();
  const realTimes = await readMessageTimestamps(resolved.conversationId, resolved.agentId);
  const otidMap = await readOtidMap(resolved.conversationId, resolved.agentId);
  // lcp-nwd: build messageId -> runId index once per request so each
  // projected message carries the run that attributed it. Mobile groups
  // chat bubbles by run_id for the collapsible run-block affordance;
  // null run_id meant every message rendered ungrouped.
  const runIdsByMessageId = buildMessageRunMap({
    agentId: resolved.agentId,
    conversationId: resolved.conversationId,
  });
  const out = [];
  for (const m of items) {
    const scope = {
      agentId: resolved.agentId,
      conversationId: externalConvId,
      realTimes,
      otidMap,
      runIdsByMessageId,
    };
    const projected = localMessageToConversationMessages(m, scope);
    for (const p of projected) out.push(p);
  }
  json(res, 200, out);
}

async function handleConversationSendMessage(req: IncomingMessage, res: ServerResponse, externalConvId: string): Promise<void> {
  const resolved = await resolveConversationId(externalConvId);
  if (!resolved) return notFound(res, `conversation ${externalConvId}`);
  // letta-code's --conversation expects the INTERNAL id (e.g. "default" or
  // a real conv-*), not our synthesized external one.
  await sendMessage(req, res, resolved.agentId, resolved.conversationId);
}

function handleConversationStream(req: IncomingMessage, res: ServerResponse, externalConvId: string): void {
  // Ambient stream stub. Mobile polls this even for conversations that
  // don't exist locally (e.g. cached from a prior Python-Letta-server
  // session). Always return 200 with a keep-alive SSE so mobile's
  // background polling doesn't thrash 404s.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  // SSE comment line as heartbeat (mobile treats lines beginning with `:` as
  // heartbeat, won't error).
  res.write(`: connected ${externalConvId}\n\n`);
  const ping = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(`: ping\n\n`); } catch { /* socket closed */ }
  }, 25_000);
  if (ping.unref) ping.unref();
  // Hard cap the SSE keep-alive duration. Without this, half-closed sockets
  // (Android backgrounding, NAT timeout, wifi flap) keep the request alive
  // server-side until kernel TCP keepalive finally tears it down — observed
  // in the wild as 20–78 minute pending POSTs that look like "the agent
  // never replied." Clients re-open as needed; SSE is meant to be a
  // short-lived long-poll, not a persistent channel (that's the WS).
  const MAX_STREAM_MS = Number(process.env["SHIM_STREAM_MAX_MS"] ?? 60_000);
  const cap = setTimeout(() => {
    clearInterval(ping);
    if (!res.writableEnded) {
      try { res.end(); } catch { /* socket gone */ }
    }
  }, MAX_STREAM_MS);
  if (cap.unref) cap.unref();
  req.on("close", () => {
    clearInterval(ping);
    clearTimeout(cap);
  });
}

async function handleConversationCancel(_req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
  // Phase 1: there's no shared subprocess registry yet. Acknowledge so the
  // client UI clears any pending state.
  const conv = await getConversation(conversationId);
  if (!conv) return notFound(res, `conversation ${conversationId}`);
  json(res, 200, { id: conv.id, status: "accepted" });
}

async function handleConversationStub(_req: IncomingMessage, res: ServerResponse, conversationId: string, op: string): Promise<void> {
  if (!(await getConversation(conversationId))) return notFound(res, `conversation ${conversationId}`);
  json(res, 501, { detail: `conversation op ${op} not yet implemented in Phase 1` });
}

// ── /v1/runs/* (vanilla Letta run tracking) ─────────────────────────
//
// Each turn the agent pool creates a Run record. Mobile polls these for
// status, lists active runs for resume detection, and POSTs cancels.
// See lib/runs.mjs for the data model and lifecycle.

function parseBoolParam(searchParams: URLSearchParams, name: string): boolean | null {
  const raw = searchParams.get(name);
  if (raw == null) return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

// ── /v1/crons (lcp-9h3 reads, lcp-5o9o mutations) ─────────────────
//
// GET endpoints mirror the cron store; POST/PUT/PATCH/DELETE perform real
// mutations. ALL writes go through the lock-serialized store API in
// lib/crons.ts (addTask/updateTask/deleteTask/deleteAllTasks, each wrapped
// in withLock), so a REST write and a concurrent WS write are serialized on
// the same on-disk lock and neither can lose the other's update. server.ts
// NEVER writes crons.json directly. The cron `schedule` is validated on
// every write (400 on a bad expression) via the store's parse helpers.

function handleCronsList(_req: IncomingMessage, res: ServerResponse, url: URL): void {
  const agentId = url.searchParams.get("agent_id") ?? undefined;
  const conversationId = url.searchParams.get("conversation_id") ?? undefined;
  const filters: { agent_id?: string; conversation_id?: string } = {};
  if (agentId) filters.agent_id = agentId;
  if (conversationId) filters.conversation_id = conversationId;
  json(res, 200, { tasks: listCronTasks(filters) });
}

function handleCronDetail(_req: IncomingMessage, res: ServerResponse, taskId: string): void {
  const task = getCronTask(taskId);
  if (!task) return notFound(res, `cron task ${taskId}`);
  json(res, 200, task);
}

function handleCronScheduler(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, getCronSchedulerStatus());
}

// 405 retained for the scheduler sub-resource (read-only; no mutations).
function handleCronMethodNotAllowed(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Allow", "GET, OPTIONS");
  json(res, 405, {
    detail: `${req.method} not allowed on this cron endpoint`,
    ws_endpoint: "/shim/v1/mobile",
    ws_frames: ["cron_add", "cron_list", "cron_get", "cron_delete"],
  });
}

function badRequest(res: ServerResponse, detail: string): void {
  json(res, 400, { detail });
}

// After any REST mutation we broadcast a `client_mutation` cron event so peer
// WS clients receive a `crons_updated` push immediately — mirroring the WS
// mutation path in lib/mobile-channel-host.ts. The fs.watch in cron-scheduler
// would also catch the write, but the direct broadcast is lower-latency.
function broadcastCronMutation(): void {
  broadcastCronEvent({
    reason: "client_mutation",
    tasks_active: getActiveCronTasks().length,
    at: new Date().toISOString(),
  });
}

// ── POST /v1/work-activity — external work ingest (lcp-zncq) ─────────

/** Valid values for the `status` field in a work-activity ingest payload. */
const VALID_WORK_ACTIVITY_STATUSES = new Set(["running", "completed", "failed"]);

function parseWorkActivityProgress(raw: unknown): TodoProgress | null | { error: string } {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return { error: "progress must be an object with completed and total numbers" };
  const completedRaw = raw["completed"];
  const totalRaw = raw["total"];
  if (!Number.isInteger(completedRaw) || !Number.isInteger(totalRaw)) {
    return { error: "progress.completed and progress.total must be integers" };
  }
  const completed = completedRaw as number;
  const total = totalRaw as number;
  if (completed < 0 || total < 0 || completed > total) {
    return { error: "progress must satisfy 0 <= completed <= total" };
  }
  return { completed, total };
}

async function handleWorkActivityIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);

  const externalId = body["external_id"];
  if (typeof externalId !== "string" || externalId.length === 0) {
    return badRequest(res, "external_id is required (string)");
  }
  const source = body["source"];
  if (typeof source !== "string" || source.length === 0) {
    return badRequest(res, "source is required (string)");
  }
  const statusRaw = body["status"];
  if (typeof statusRaw !== "string" || !VALID_WORK_ACTIVITY_STATUSES.has(statusRaw)) {
    return badRequest(res, `status must be one of: ${[...VALID_WORK_ACTIVITY_STATUSES].join(", ")}`);
  }
  const status = statusRaw as "running" | "completed" | "failed";

  // Collision-free namespace: `ext-<source>-<external_id>`
  const toolCallId = `ext-${source}-${externalId}`;
  const description = typeof body["description"] === "string" ? (body["description"] as string) : null;
  const failureReason = typeof body["failure_reason"] === "string" ? (body["failure_reason"] as string) : null;
  const progress = parseWorkActivityProgress(body["progress"]);
  if (progress && "error" in progress) return badRequest(res, progress.error);

  if (status === "running") {
    // Upsert a running entry. recordSubagentDispatch is idempotent on
    // toolCallId — repeated POSTs update metadata without duplicating.
    const entry = recordSubagentDispatch({
      toolCallId,
      parentRunId: null,
      args: {
        subagent_type: null,
        description,
        run_in_background: false,
      },
      source,
    });
    // The registry owns timestamps; caller-supplied started_at is advisory.
    const withProgress = progress ? updateSubagentTodoProgress(toolCallId, progress) : entry;
    return json(res, 200, withProgress);
  }

  // Terminal statuses: complete or fail an existing entry, or create-then-finalize.
  let entry = getSubagent(toolCallId);

  if (!entry) {
    // Create a synthetic dispatch entry and immediately finalize it.
    recordSubagentDispatch({
      toolCallId,
      parentRunId: null,
      args: {
        subagent_type: null,
        description,
        run_in_background: false,
      },
      source,
    });
  }

  if (status === "completed") {
    markSubagentCompleted(toolCallId);
  } else {
    markSubagentFailed(toolCallId, failureReason ?? "failed");
  }

  if (progress) updateSubagentTodoProgress(toolCallId, progress);
  const final = getSubagent(toolCallId);
  return json(res, 200, final);
}

// Resolve a schedule from the request body. Accepts exactly one of `cron`
// (raw 5-field expression), `every` (e.g. "5m"), or `at` (e.g. "3:30pm" /
// "in 10m"). Returns the resolved cron expression + recurring flag +
// optional one-shot scheduled_for, or an error string for a 400.
interface ResolvedSchedule {
  cron: string;
  recurring: boolean;
  scheduledFor?: Date;
}

function resolveSchedule(body: Record<string, unknown>): ResolvedSchedule | { error: string } {
  const cronRaw = typeof body["cron"] === "string" ? (body["cron"] as string) : undefined;
  const everyRaw = typeof body["every"] === "string" ? (body["every"] as string) : undefined;
  const atRaw = typeof body["at"] === "string" ? (body["at"] as string) : undefined;
  const provided = [cronRaw, everyRaw, atRaw].filter((v) => v !== undefined && v.length > 0).length;
  if (provided === 0) {
    return { error: "one of `cron`, `every`, or `at` is required" };
  }
  if (provided > 1) {
    return { error: "exactly one of `cron`, `every`, or `at` may be set" };
  }
  if (cronRaw) {
    if (!isValidCron(cronRaw)) {
      return { error: `invalid cron expression: ${cronRaw}` };
    }
    const recurring = typeof body["recurring"] === "boolean" ? (body["recurring"] as boolean) : true;
    return { cron: cronRaw, recurring };
  }
  if (everyRaw) {
    const parsed = parseEvery(everyRaw);
    if (!parsed) return { error: `invalid every: ${everyRaw}` };
    return { cron: parsed.cron, recurring: true };
  }
  // atRaw
  const parsed = parseAt(atRaw!);
  if (!parsed) return { error: `invalid at: ${atRaw}` };
  return { cron: parsed.cron, recurring: false, scheduledFor: parsed.scheduledFor };
}

// POST /v1/crons — create a task. Body: agent_id, conversation_id, name,
// prompt, schedule (one of cron/every/at), recurring, timezone, description.
async function handleCronCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const agentId = body["agent_id"];
  if (typeof agentId !== "string" || agentId.length === 0) {
    return badRequest(res, "agent_id is required");
  }
  const prompt = body["prompt"];
  if (typeof prompt !== "string" || prompt.length === 0) {
    return badRequest(res, "prompt is required");
  }
  const schedule = resolveSchedule(body);
  if ("error" in schedule) return badRequest(res, schedule.error);

  const input: AddTaskInput = {
    agent_id: agentId,
    name: typeof body["name"] === "string" ? (body["name"] as string) : `task-${Date.now()}`,
    description: typeof body["description"] === "string" ? (body["description"] as string) : "",
    cron: schedule.cron,
    recurring: schedule.recurring,
    prompt,
  };
  if (typeof body["conversation_id"] === "string") input.conversation_id = body["conversation_id"] as string;
  if (typeof body["timezone"] === "string") input.timezone = body["timezone"] as string;
  if (schedule.scheduledFor !== undefined) input.scheduled_for = schedule.scheduledFor;

  let task: CronTask;
  let warning: string | undefined;
  try {
    const result = addCronTask(input);
    task = result.task;
    warning = result.warning;
  } catch (err) {
    return badRequest(res, err instanceof Error ? err.message : String(err));
  }
  broadcastCronMutation();
  // Response shape mirrors the GET /v1/crons/{id} body (raw CronTask), so a
  // freshly-created task is byte-identical to what a subsequent read returns.
  json(res, 201, warning === undefined ? task : { ...task, warning });
}

// Apply a schedule + mutable fields to a task in place. Shared by PUT (full
// replace) and PATCH (partial). `requireAll` enforces the PUT contract that
// the core descriptive fields are present.
function applyTaskUpdate(
  task: CronTask,
  body: Record<string, unknown>,
  schedule: ResolvedSchedule | null,
): void {
  if (schedule) {
    task.cron = schedule.cron;
    task.recurring = schedule.recurring;
    task.scheduled_for = schedule.scheduledFor?.toISOString() ?? null;
  }
  if (typeof body["name"] === "string") task.name = body["name"] as string;
  if (typeof body["description"] === "string") task.description = body["description"] as string;
  if (typeof body["prompt"] === "string") task.prompt = body["prompt"] as string;
  if (typeof body["conversation_id"] === "string") task.conversation_id = body["conversation_id"] as string;
  if (typeof body["timezone"] === "string") task.timezone = body["timezone"] as string;
  if (typeof body["enabled"] === "boolean") {
    task.status = (body["enabled"] as boolean) ? "active" : "cancelled";
    if (!(body["enabled"] as boolean) && task.cancel_reason === null) {
      task.cancel_reason = "disabled via REST";
    }
    if (body["enabled"] as boolean) task.cancel_reason = null;
  }
}

// PUT /v1/crons/{id} — full replace. All core fields required.
async function handleCronReplace(req: IncomingMessage, res: ServerResponse, taskId: string): Promise<void> {
  const body = await readJsonBody(req);
  if (!getCronTask(taskId)) return notFound(res, `cron task ${taskId}`);
  if (typeof body["prompt"] !== "string" || (body["prompt"] as string).length === 0) {
    return badRequest(res, "prompt is required for full replace");
  }
  if (typeof body["name"] !== "string" || (body["name"] as string).length === 0) {
    return badRequest(res, "name is required for full replace");
  }
  const schedule = resolveSchedule(body);
  if ("error" in schedule) return badRequest(res, schedule.error);

  const updated = updateCronTask(taskId, (task) => {
    applyTaskUpdate(task, body, schedule);
  });
  if (!updated) return notFound(res, `cron task ${taskId}`);
  broadcastCronMutation();
  json(res, 200, updated);
}

// PATCH /v1/crons/{id} — partial update. Schedule fields optional; when
// present they are validated. At least one mutable field must be supplied.
async function handleCronPatch(req: IncomingMessage, res: ServerResponse, taskId: string): Promise<void> {
  const body = await readJsonBody(req);
  if (!getCronTask(taskId)) return notFound(res, `cron task ${taskId}`);

  const hasSchedule = ["cron", "every", "at"].some(
    (k) => typeof body[k] === "string" && (body[k] as string).length > 0,
  );
  let schedule: ResolvedSchedule | null = null;
  if (hasSchedule) {
    const resolved = resolveSchedule(body);
    if ("error" in resolved) return badRequest(res, resolved.error);
    schedule = resolved;
  }

  const updated = updateCronTask(taskId, (task) => {
    applyTaskUpdate(task, body, schedule);
  });
  if (!updated) return notFound(res, `cron task ${taskId}`);
  broadcastCronMutation();
  json(res, 200, updated);
}

// DELETE /v1/crons/{id} — remove a single task.
function handleCronDelete(res: ServerResponse, taskId: string): void {
  const removed = deleteCronTask(taskId);
  if (!removed) return notFound(res, `cron task ${taskId}`);
  broadcastCronMutation();
  json(res, 200, { deleted: true, id: taskId });
}

// DELETE /v1/crons — bulk delete. Supports `?agent_id=` and/or
// `?conversation_id=` filters. agent_id alone uses the store's optimized
// deleteAllTasks; otherwise we delete the filtered set individually (still
// each lock-serialized via deleteTask).
function handleCronBulkDelete(res: ServerResponse, url: URL): void {
  const agentId = url.searchParams.get("agent_id") ?? undefined;
  const conversationId = url.searchParams.get("conversation_id") ?? undefined;
  if (!agentId && !conversationId) {
    return badRequest(res, "bulk delete requires an `agent_id` and/or `conversation_id` filter");
  }
  let deleted = 0;
  if (agentId && !conversationId) {
    deleted = deleteAllCronTasks(agentId);
  } else {
    const filters: { agent_id?: string; conversation_id?: string } = {};
    if (agentId) filters.agent_id = agentId;
    if (conversationId) filters.conversation_id = conversationId;
    const targets = listCronTasks(filters);
    for (const t of targets) {
      if (deleteCronTask(t.id)) deleted++;
    }
  }
  if (deleted > 0) broadcastCronMutation();
  json(res, 200, { deleted });
}

// ── /shim/v1/permissions/* + /shim/v1/approvals/* (lcp-indw) ──────────
//
// Thin REST mirror over the SAME files + functions the WS path uses. The
// permissions config endpoints read/write lib/permissions.ts (lock-serialized
// writes); the approval endpoints read the durable pending-approval store and
// resolve via the SINGLE resolveApproval funnel — no second source of truth.
//
// D3: config PUT/PATCH over REST is allowed (it's config, not a live turn).
//
// NOTE (must also appear in user-facing docs): prefix-match deny rules are a
// UX guardrail to prevent accidents, NOT a security boundary. They are
// trivially bypassed (bash -c '…', aliases, env indirection). Real isolation
// must come from the execution environment, not string matching.

function parseRulesBody(body: Record<string, unknown>): PermissionRule[] | { error: string } {
  const rulesRaw = body["rules"];
  if (!Array.isArray(rulesRaw)) return { error: "`rules` must be an array" };
  const rules: PermissionRule[] = [];
  for (const r of rulesRaw) {
    if (typeof r !== "object" || r === null) return { error: "each rule must be an object" };
    const ro = r as Record<string, unknown>;
    if (typeof ro["tool"] !== "string" || ro["tool"].length === 0) {
      return { error: "each rule needs a non-empty `tool`" };
    }
    const action = ro["action"];
    if (action !== "allow" && action !== "ask" && action !== "deny") {
      return { error: "each rule `action` must be allow|ask|deny" };
    }
    const rule: PermissionRule = { tool: ro["tool"], action };
    if (typeof ro["reason"] === "string") rule.reason = ro["reason"];
    rules.push(rule);
  }
  return rules;
}

function configFromBody(body: Record<string, unknown>): PermissionConfig | { error: string } {
  const rules = parseRulesBody(body);
  if ("error" in rules) return rules;
  const defRaw = body["default"];
  const def: PermissionAction =
    defRaw === "allow" || defRaw === "ask" || defRaw === "deny" ? defRaw : "allow";
  return { version: 1, default: def, rules };
}

function handlePermissionsAgentGet(res: ServerResponse, agentId: string): void {
  json(res, 200, readAgentConfigOrEffective(agentId));
}

async function handlePermissionsAgentPut(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
  const body = await readJsonBody(req);
  const config = configFromBody(body);
  if ("error" in config) return badRequest(res, config.error);
  json(res, 200, writeAgentConfig(agentId, config));
}

async function handlePermissionsAgentPatch(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
  const body = await readJsonBody(req);
  const patch: { default?: PermissionAction; rules?: PermissionRule[] } = {};
  if (body["default"] !== undefined) {
    const d = body["default"];
    if (d !== "allow" && d !== "ask" && d !== "deny") {
      return badRequest(res, "`default` must be allow|ask|deny");
    }
    patch.default = d;
  }
  if (body["rules"] !== undefined) {
    const rules = parseRulesBody(body);
    if ("error" in rules) return badRequest(res, rules.error);
    patch.rules = rules;
  }
  if (patch.default === undefined && patch.rules === undefined) {
    return badRequest(res, "PATCH requires at least `default` or `rules`");
  }
  json(res, 200, patchAgentConfig(agentId, patch));
}

function handlePermissionsGlobalGet(res: ServerResponse): void {
  json(res, 200, readGlobalConfig());
}

async function handlePermissionsGlobalPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const config = configFromBody(body);
  if ("error" in config) return badRequest(res, config.error);
  json(res, 200, writeGlobalConfig(config));
}

function handlePermissionsPreview(res: ServerResponse, url: URL): void {
  const agentId = url.searchParams.get("agent_id") ?? "";
  const tool = url.searchParams.get("tool") ?? "";
  if (!tool) return badRequest(res, "`tool` query param is required");
  const argsRaw = url.searchParams.get("args");
  let toolInput: Record<string, unknown> = {};
  if (argsRaw) {
    try {
      const parsed = JSON.parse(argsRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        toolInput = parsed as Record<string, unknown>;
      } else {
        // Treat a bare string as the primary command arg for prefix matching.
        toolInput = { command: argsRaw };
      }
    } catch {
      toolInput = { command: argsRaw };
    }
  }
  const result = evaluatePermission(
    agentId,
    url.searchParams.get("conversation_id") ?? null,
    tool,
    toolInput,
  );
  json(res, 200, {
    action: result.action,
    reason: result.reason,
    source: result.source,
    requires_approval: result.action !== "allow",
  });
}

function handleApprovalsPending(res: ServerResponse, url: URL): void {
  const filters: { agentId?: string; conversationId?: string } = {};
  const agentId = url.searchParams.get("agent_id");
  const conversationId = url.searchParams.get("conversation_id");
  if (agentId) filters.agentId = agentId;
  if (conversationId) filters.conversationId = conversationId;
  json(res, 200, { pending: listPendingApprovals(filters) });
}

async function handleApprovalsDecision(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const body = await readJsonBody(req);
  const decisionRaw = body["decision"];
  if (decisionRaw !== "approve" && decisionRaw !== "deny") {
    return badRequest(res, "`decision` must be approve|deny");
  }
  const decision: {
    decision: "approve" | "deny";
    scope?: "Once" | "Session" | "Forever" | "Deny";
    reason?: string;
    userId?: string;
  } = { decision: decisionRaw };
  const scope = body["scope"];
  if (scope === "Once" || scope === "Session" || scope === "Forever" || scope === "Deny") {
    decision.scope = scope;
  }
  if (typeof body["reason"] === "string") decision.reason = body["reason"];
  if (typeof body["user_id"] === "string") decision.userId = body["user_id"];
  const result = resolveApproval(runId, decision);
  if (!result.found) return notFound(res, `pending approval for run ${runId}`);
  json(res, 200, { status: result.status, ...(result.already_resolved ? { already_resolved: true } : {}) });
}

function handleApprovalsDelete(res: ServerResponse, runId: string): void {
  // DELETE = deny shorthand. Same resolve funnel.
  const result = resolveApproval(runId, { decision: "deny", scope: "Deny", reason: "rest_delete" });
  if (!result.found) return notFound(res, `pending approval for run ${runId}`);
  json(res, 200, { status: result.status, ...(result.already_resolved ? { already_resolved: true } : {}) });
}

function handlePermissionsMethodNotAllowed(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Allow", "GET, PUT, PATCH, OPTIONS");
  json(res, 405, { detail: `${req.method} not allowed on this permissions endpoint` });
}

// ── /v1/skills/* — skill discovery, search, install, uninstall ──────────
//
// Skills let agents discover and use specialized capabilities. The shim
// manages the skill store at ~/.letta/skills/ and per-agent installations
// at storageDir()/agents/{agentId}/skills/.

function handleSkillsList(_req: IncomingMessage, res: ServerResponse): void {
  const skills = listAvailableSkills();
  json(res, 200, { skills });
}

function handleSkillDetail(_req: IncomingMessage, res: ServerResponse, skillName: string): void {
  const skill = getSkillDetail(skillName);
  if (!skill) return notFound(res, `skill ${skillName}`);
  json(res, 200, skill);
}

async function handleSkillsSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const query = typeof body["query"] === "string" ? body["query"] as string : "";
  const tags = Array.isArray(body["tags"]) ? (body["tags"] as string[]).filter((t) => typeof t === "string") : undefined;
  const skills = searchSkills(query, tags);
  json(res, 200, { skills });
}

// PUT /v1/skills/{name} — create-or-replace a skill in the GLOBAL registry.
// Idempotent: 201 on first create, 200 on overwrite. Body accepts either a
// full `readme` (SKILL.md written verbatim) or structured metadata
// (description/version/tags/author) from which a minimal SKILL.md is built.
async function handleSkillPublish(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
  // Name validation up front (defense in depth; the store layer re-checks).
  if (skillName.includes("/") || skillName.includes("\\") || skillName.includes("..") || !/^[A-Za-z0-9._-]+$/.test(skillName)) {
    return json(res, 400, { detail: "invalid skill name" });
  }
  const body = await readJsonBody(req);
  // Build the input with only the keys actually supplied (exactOptionalPropertyTypes).
  const input: PublishSkillInput = {};
  if (typeof body["description"] === "string") input.description = body["description"];
  if (typeof body["version"] === "string") input.version = body["version"];
  if (typeof body["author"] === "string") input.author = body["author"];
  if (Array.isArray(body["tags"])) {
    input.tags = (body["tags"] as unknown[]).filter((t): t is string => typeof t === "string");
  }
  if (typeof body["readme"] === "string") input.readme = body["readme"];
  const result = publishSkillToStore(skillName, input);
  if (!result.ok) {
    if (result.error === "invalid_name") return json(res, 400, { detail: "invalid skill name" });
    if (result.error === "invalid_body") {
      return json(res, 400, { detail: "skill must include a non-empty `readme` or `description`" });
    }
    return json(res, 500, { detail: "failed to write skill" });
  }
  const skill = getSkillDetail(skillName);
  json(res, result.created ? 201 : 200, skill);
}

// DELETE /v1/skills/{name} — remove a skill from the GLOBAL registry.
// Per-agent installed copies are left intact (independent snapshots).
function handleSkillDelete(_req: IncomingMessage, res: ServerResponse, skillName: string): void {
  const ok = deleteSkillFromStore(skillName);
  if (!ok) return notFound(res, `skill ${skillName}`);
  json(res, 200, { name: skillName, deleted: true });
}

function handleAgentSkillsList(_req: IncomingMessage, res: ServerResponse, agentId: string): void {
  if (!resolveAgentRecord(agentId)) return notFound(res, `agent ${agentId}`);
  const skills = listInstalledSkillsForAgent(agentId);
  json(res, 200, { skills });
}

function handleAgentSkillDetail(_req: IncomingMessage, res: ServerResponse, agentId: string, skillName: string): void {
  if (!resolveAgentRecord(agentId)) return notFound(res, `agent ${agentId}`);
  const skill = getInstalledSkillDetail(agentId, skillName);
  if (!skill) return notFound(res, `skill ${skillName} for agent ${agentId}`);
  json(res, 200, skill);
}

async function handleAgentSkillInstall(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
  if (!resolveAgentRecord(agentId)) return notFound(res, `agent ${agentId}`);
  const body = await readJsonBody(req);
  const skillName = typeof body["name"] === "string" ? body["name"] as string : "";
  if (!skillName) {
    return json(res, 400, { detail: "skill name is required" });
  }
  // Reject path-traversal / separator names up front (defense in depth; the
  // store layer also validates). Keeps a malicious name from reaching fs joins.
  if (skillName.includes("/") || skillName.includes("\\") || skillName.includes("..") || !/^[A-Za-z0-9._-]+$/.test(skillName)) {
    return json(res, 400, { detail: "invalid skill name" });
  }
  const ok = installSkillToAgent(agentId, skillName);
  if (!ok) {
    return notFound(res, `skill ${skillName} not found in global store`);
  }
  const skill = getInstalledSkillDetail(agentId, skillName);
  json(res, 201, skill);
}

async function handleAgentSkillUninstall(_req: IncomingMessage, res: ServerResponse, agentId: string, skillName: string): Promise<void> {
  if (!resolveAgentRecord(agentId)) return notFound(res, `agent ${agentId}`);
  const ok = uninstallSkillFromAgent(agentId, skillName);
  if (!ok) {
    return notFound(res, `skill ${skillName} not installed for agent ${agentId}`);
  }
  json(res, 200, { name: skillName, uninstalled: true });
}

function handleRunsList(_req: IncomingMessage, res: ServerResponse, url: URL): void {
  const { limit } = parsePagination(url.searchParams);
  const params: ListRunsParams & { agentIds?: string[]; statuses?: string[] } = {
    agentId: url.searchParams.get("agent_id") ?? undefined,
    agentIds: url.searchParams.getAll("agent_ids"),
    conversationId: url.searchParams.get("conversation_id") ?? undefined,
    active: parseBoolParam(url.searchParams, "active") ?? undefined,
    background: parseBoolParam(url.searchParams, "background") ?? undefined,
    statuses: url.searchParams.getAll("statuses"),
    stopReason: url.searchParams.get("stop_reason") ?? undefined,
    before: url.searchParams.get("before") ?? undefined,
    after: url.searchParams.get("after") ?? undefined,
    limit,
    order: (url.searchParams.get("order") ?? "desc") as "asc" | "desc",
    ascending: parseBoolParam(url.searchParams, "ascending") ?? undefined,
  };
  if (params.agentIds?.length === 0) delete params.agentIds;
  if (params.statuses?.length === 0) delete params.statuses;
  json(res, 200, listRuns(params));
}

function handleRunDetail(_req: IncomingMessage, res: ServerResponse, runId: string): void {
  const run = getRun(runId);
  if (!run) return notFound(res, `run ${runId}`);
  json(res, 200, run);
}

async function handleRunMessages(_req: IncomingMessage, res: ServerResponse, url: URL, runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return notFound(res, `run ${runId}`);
  const order = (url.searchParams.get("order") ?? "asc").toLowerCase();
  const before = url.searchParams.get("before") ?? undefined;
  const after = url.searchParams.get("after") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 100);

  // Resolve the conversation that owned this run and fetch its messages,
  // filtered to the ids the run claimed. Project to vanilla shape so the
  // response matches what mobile gets from /v1/conversations/{id}/messages.
  const conv = run.conversation_id ? await getConversation(run.conversation_id, run.agent_id) : null;
  const resolved = conv ? { conversationId: conv.id, agentId: conv.agent_id } : null;
  if (!resolved) return json(res, 200, []);
  const items = await listMessages(resolved.conversationId, resolved.agentId, {});
  const realTimes = await readMessageTimestamps(resolved.conversationId, resolved.agentId);
  const otidMap = await readOtidMap(resolved.conversationId, resolved.agentId);
  const runMessageIds = new Set(run.message_ids ?? []);
  // lcp-nwd: this endpoint already knows the run id, so build a trivial
  // single-run map rather than walking all runs. Every message we emit
  // here belongs to `run` by construction.
  const runIdsByMessageId: Record<string, string> = {};
  for (const mid of run.message_ids ?? []) {
    if (typeof mid === "string") runIdsByMessageId[mid] = run.id;
  }
  let out: Array<{ id?: string }> = [];
  for (const m of items) {
    if (!runMessageIds.has(m?.id)) continue;
    const scope = {
      agentId: resolved.agentId,
      conversationId: run.conversation_id,
      realTimes,
      otidMap,
      runIdsByMessageId,
    };
    const projected = localMessageToConversationMessages(m, scope);
    for (const p of projected) out.push(p as { id?: string });
  }
  if (order === "desc") out = out.reverse();
  if (after) {
    const idx = out.findIndex((p) => p.id === after);
    if (idx >= 0) out = out.slice(idx + 1);
  }
  if (before) {
    const idx = out.findIndex((p) => p.id === before);
    if (idx >= 0) out = out.slice(0, idx);
  }
  if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
  json(res, 200, out);
}

function handleRunUsage(_req: IncomingMessage, res: ServerResponse, runId: string): void {
  const run = getRun(runId);
  if (!run) return notFound(res, `run ${runId}`);
  const u = (run.usage ?? {}) as Record<string, unknown>;
  json(res, 200, {
    completion_tokens: (u["completion_tokens"] as number | undefined) ?? 0,
    prompt_tokens: (u["prompt_tokens"] as number | undefined) ?? 0,
    total_tokens: (u["total_tokens"] as number | undefined) ?? 0,
    step_count: (u["step_count"] as number | undefined) ?? run.num_steps ?? 0,
    cached_input_tokens: (u["cached_input_tokens"] as number | undefined) ?? 0,
    cache_write_tokens: (u["cache_write_tokens"] as number | undefined) ?? 0,
    reasoning_tokens: (u["reasoning_tokens"] as number | undefined) ?? 0,
  });
}

function handleRunMetrics(_req: IncomingMessage, res: ServerResponse, runId: string): void {
  const run = getRun(runId);
  if (!run) return notFound(res, `run ${runId}`);
  // vanilla RunMetrics: { id, organization_id, agent_id, project_id,
  // run_start_ns, run_ns, num_steps, tools_used, template_id, base_template_id }
  const createdAtNs = run.created_at
    ? BigInt(new Date(run.created_at).getTime()) * 1_000_000n
    : null;
  json(res, 200, {
    id: run.id,
    organization_id: null,
    agent_id: run.agent_id,
    project_id: null,
    run_start_ns: createdAtNs != null ? Number(createdAtNs) : null,
    run_ns: run.total_duration_ns ?? null,
    num_steps: run.num_steps ?? 0,
    tools_used: run.tools_used ?? [],
    template_id: null,
    base_template_id: run.base_template_id ?? null,
  });
}

function handleRunSteps(_req: IncomingMessage, res: ServerResponse, url: URL, runId: string): void {
  const run = getRun(runId);
  if (!run) return notFound(res, `run ${runId}`);
  const steps = listRunSteps(runId, {
    before: url.searchParams.get("before") ?? undefined,
    after: url.searchParams.get("after") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
    order: (url.searchParams.get("order") ?? "desc") as "asc" | "desc",
  });
  json(res, 200, steps);
}

async function handleRunDelete(_req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const ok = deleteRun(runId);
  if (!ok) return notFound(res, `run ${runId}`);
  json(res, 200, { id: runId, deleted: true });
}

// ── /shim/v1/usage/* — token usage aggregation ─────────────────────
//
// Greenfield (not in vanilla Letta). Sums token counts across runs with
// optional grouping. Mobile/clients call this instead of fanning out
// `/v1/runs/{id}/steps` for every run in a window.

function handleUsageSummary(_req: IncomingMessage, res: ServerResponse, url: URL): void {
  const allowedGroupBy = new Set(["agent", "conversation", "model", "day"]);
  const groupBy = url.searchParams.get("group_by");
  if (groupBy && !allowedGroupBy.has(groupBy)) {
    return json(res, 400, {
      detail: `group_by must be one of: ${[...allowedGroupBy].join(", ")}`,
    });
  }
  const result = aggregateUsage({
    agentId: url.searchParams.get("agent_id") ?? undefined,
    agentIds: url.searchParams.getAll("agent_ids"),
    conversationId: url.searchParams.get("conversation_id") ?? undefined,
    start: url.searchParams.get("start") ?? undefined,
    end: url.searchParams.get("end") ?? undefined,
    statuses: url.searchParams.getAll("statuses"),
    groupBy: (groupBy as "agent" | "conversation" | "model" | "day" | null) ?? null,
  });
  json(res, 200, result);
}

async function handleAgentMessagesCancel(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
  // Vanilla shape: POST /v1/agents/{agent_id}/messages/cancel with body
  // `{ run_ids: ["run-..."] }`. If run_ids is omitted/empty, vanilla
  // cancels ALL active runs for the agent. Returns a map { run_id: status }.
  const body = await readJsonBody(req);
  const rawRunIds = (body as { run_ids?: unknown }).run_ids;
  let runIds: string[] | null = Array.isArray(rawRunIds)
    ? rawRunIds.filter((x): x is string => typeof x === "string")
    : null;
  if (!runIds || runIds.length === 0) {
    const active = listRuns({ agentId, active: true, limit: 100 });
    runIds = active.map((r) => r.id);
  }
  const out: Record<string, string> = {};
  for (const id of runIds) {
    const run = getRun(id);
    if (!run) {
      out[id] = "not_found";
      continue;
    }
    if (run.agent_id && run.agent_id !== agentId) {
      out[id] = "agent_mismatch";
      continue;
    }
    out[id] = cancelRun(id) ? "cancelled" : "not_active";
  }
  json(res, 200, out);
}

// ── search (lcp-c61s) ──────────────────────────────────────────────
//
// Derived FTS5 index over canonical MemFS. The index is deletable /
// rebuildable; nothing here treats it as a source of truth. Cold path is
// BOUNDED: lib/search.ensureIndex returns indexing=true if a build runs past
// the cap, in which case we answer 202 and the client polls
// GET /v1/agents/{id}/search/status. We never hold the request open for the
// full ~30s cold build.

async function handleMessagesSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const query = typeof body["query"] === "string" ? body["query"] : "";
  const rawAgent = typeof body["agent_id"] === "string" ? body["agent_id"] : "";
  const agentId = rawAgent
    ? resolveAgentIdAlias(rawAgent, (id) => getAgentRecord(id) != null)
    : "";
  const limitRaw = Number(body["limit"]);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 20;
  if (!agentId) {
    return badRequest(res, "agent_id is required");
  }
  try {
    const result = await runSearch(agentId, query, limit);
    if (result.indexing) {
      // Cold build still running — tell the client to poll status. Results may
      // be empty/partial; we return 202 with what we have so far.
      return json(res, 202, result);
    }
    return json(res, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json(res, 500, { detail: `search failed: ${msg}` });
  }
}

function handleSearchStatus(_req: IncomingMessage, res: ServerResponse, agentIdRaw: string): void {
  const agentId = resolveAgentIdAlias(agentIdRaw, (id) => getAgentRecord(id) != null);
  json(res, 200, getSearchStatus(agentId));
}

function handleSearchRebuild(_req: IncomingMessage, res: ServerResponse, agentIdRaw: string): void {
  const agentId = resolveAgentIdAlias(agentIdRaw, (id) => getAgentRecord(id) != null);
  // Kick the rebuild and return immediately (202). The promise is detached;
  // failures are logged but don't crash the request — status will reflect
  // the result once the build settles.
  rebuildSearchIndex(agentId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[search] rebuild for ${agentId} failed: ${msg}`);
  });
  json(res, 202, { rebuilding: true, agent_id: agentId });
}

// ── helpers ────────────────────────────────────────────────────────

function cryptoRandomUUID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
  if (buf.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(buf.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch { return {}; }
}

// ── router ────────────────────────────────────────────────────────

function pad(s: unknown, n: number): string { return String(s).padEnd(n); }

// Reverse-proxy /api/* through to vibesync's ApiServer. The Android client
// uses the shim as its single base URL for both Letta routes (/v1/*) and
// vibesync routes (/api/*); vibesync runs as a separate process on
// VIBESYNC_HOST:VIBESYNC_PORT, so we splice the two surfaces here instead
// of giving the client two URLs to configure. SSE works because we just
// pipe the upstream response body straight through — no buffering.
const VIBESYNC_PROXY_PREFIX = "/api/";
const VIBESYNC_PROXY_HOST = process.env["VIBESYNC_HOST"] ?? "127.0.0.1";
const VIBESYNC_PROXY_PORT = Number(process.env["VIBESYNC_PORT"] ?? 3099);

function proxyToVibesync(req: IncomingMessage, res: ServerResponse): void {
  // Copy headers but strip ones that don't apply to the upstream hop.
  // - `host` would name the shim, not vibesync.
  // - `content-length` is recomputed by the upstream agent.
  // - `accept-encoding` is dropped so we don't have to decompress mid-pipe
  //   (vibesync serves text/SSE; the bandwidth cost is negligible).
  const upstreamHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
  delete upstreamHeaders["host"];
  delete upstreamHeaders["content-length"];
  delete upstreamHeaders["accept-encoding"];

  const upstream = httpRequest({
    host: VIBESYNC_PROXY_HOST,
    port: VIBESYNC_PROXY_PORT,
    method: req.method,
    path: req.url ?? "/",
    headers: upstreamHeaders,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`vibesync upstream unreachable: ${err.message}`);
    } else {
      // Headers already flushed (e.g. mid-SSE). Best we can do is close.
      res.end();
    }
  });

  // Forward request body (POST/PUT/PATCH). For GET this just ends the stream
  // quickly with no payload.
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;
  const started = Date.now();
  const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "?";

  // NOTE: do NOT pre-attach a `data` listener here — that puts the stream
  // into flowing mode and races with handler-side body readers (chat.mjs,
  // readJsonBody). Track byte count via the `data` event WITHOUT capturing
  // by using `on('readable')` would also work; cheapest path is just to
  // record content-length header.
  const reqBytesHeader = Number(req.headers["content-length"] ?? 0);

  let respBytes = 0;
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  (res as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]): boolean => {
    if (chunk) respBytes += Buffer.byteLength(chunk as string | Buffer);
    return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  (res as { end: (...args: unknown[]) => ServerResponse }).end = (chunk?: unknown, ...rest: unknown[]): ServerResponse => {
    if (chunk) respBytes += Buffer.byteLength(chunk as string | Buffer);
    return (origEnd as (...args: unknown[]) => ServerResponse)(chunk, ...rest);
  };

  res.on("close", () => {
    const ms = Date.now() - started;
    const status = res.statusCode;
    const ua = (req.headers["user-agent"] || "").slice(0, 80);
    const auth = req.headers.authorization ? "auth✓" : "no-auth";
    console.log(
      `[${new Date().toISOString()}] ${pad(remote, 15)} ${pad(req.method, 6)} ${status} ${ms}ms ` +
      `req=${reqBytesHeader}B res=${respBytes}B ${auth} ${pathname}${url.search} ua="${ua}"`,
    );
  });

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
    });
    return res.end();
  }

  // Shim-native mobile hydrate endpoint. This must sit before the broad
  // /api/* VibeSync proxy: shim-aware mobile clients use /api for local
  // admin-shim reads, while unknown /api paths still belong to VibeSync.
  const apiConvMessages = pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/?$/);
  if (apiConvMessages && req.method === "GET") {
    return handleConversationMessagesList(req, res, url, apiConvMessages[1]!);
  }

  // Reverse-proxy vibesync's /api/* surface through the same base URL so
  // the Android client can drive both letta (/v1/*) and vibesync (/api/*)
  // from one configured endpoint. Routed before any /v1 dispatch so the
  // prefix match wins immediately, except for explicit shim-native /api
  // routes above.
  if (pathname.startsWith(VIBESYNC_PROXY_PREFIX)) {
    return proxyToVibesync(req, res);
  }

  // Health
  if (req.method === "GET" && (pathname === "/v1/health/" || pathname === "/v1/health")) {
    return handleHealth(req, res);
  }
  if (req.method === "GET" && (pathname === "/shim/v1/capabilities" || pathname === "/shim/v1/capabilities/")) {
    return handleShimCapabilities(req, res);
  }
  if (req.method === "GET" && pathname === "/shim/pool") {
    return handlePoolStats(req, res);
  }
  // Agents
  // Canonical Letta defines these as `/v1/agents/` and `/v1/agents/count`
  // (trailing slash on the collection). FastAPI's default redirect_slashes
  // makes the non-slash form work too, so accept both here.
  if (req.method === "GET" && (pathname === "/v1/agents/count" || pathname === "/v1/agents/count/")) return handleAgentsCount(req, res);
  if (req.method === "GET" && (pathname === "/v1/agents" || pathname === "/v1/agents/")) return handleAgentsList(req, res, url);
  // vibesync-tr3e/razp: create an agent by writing the store record directly
  // (no letta-code createAgent CLI spawn). Single store-owner provisioning path.
  if (req.method === "POST" && (pathname === "/v1/agents" || pathname === "/v1/agents/")) return handleAgentCreate(req, res);
  if (req.method === "GET" && pathname === "/v1/models") return handleModels(req, res);

  const agentDetail = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/?$/);
  if (agentDetail && req.method === "GET") return handleAgentDetail(req, res, agentDetail[1]!);
  if (agentDetail && req.method === "PATCH") return handleAgentUpdate(req, res, agentDetail[1]!);

  const agentMessages = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/messages\/?$/);
  if (agentMessages && req.method === "GET") return handleAgentMessages(req, res, url, agentMessages[1]!);
  if (agentMessages && req.method === "POST") return sendMessage(req, res, agentMessages[1]!);

  const agentContext = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/context\/?$/);
  if (agentContext && req.method === "GET") return handleAgentContext(req, res, url, agentContext[1]!);

  // lcp-4d5f: read-only mirror of reflection (sleeptime) settings. Mutations
  // are WS-only (reflection_settings_set on /shim/v1/mobile) per the
  // WS-first rule for net-new features.
  const agentReflection = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/reflection\/?$/);
  if (agentReflection && req.method === "GET") return handleAgentReflection(req, res, agentReflection[1]!);
  if (agentReflection) {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, {
      detail: `${req.method} not allowed; reflection settings mutate over WS`,
      ws_endpoint: "/shim/v1/mobile",
      ws_frames: ["reflection_settings_get", "reflection_settings_set"],
    });
  }

  const agentBlocks = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/core-memory\/blocks\/?$/);
  if (agentBlocks && req.method === "GET") return handleAgentBlocks(req, res, agentBlocks[1]!);

  if (req.method === "GET" && pathname === "/v1/blocks") return handleBlocksList(req, res);
  if (req.method === "GET" && (pathname === "/v1/blocks/count" || pathname === "/v1/blocks/count/"))
    return json(res, 200, 0);
  const blockDetail = pathname.match(/^\/v1\/blocks\/([^/]+)\/?$/);
  if (blockDetail && req.method === "GET") return handleBlockDetail(req, res, blockDetail[1]!);

  // ── Endpoints we partially populate from letta-code state ──
  if (pathname === "/v1/tools" && req.method === "GET") return handleTools(req, res);
  if (pathname === "/v1/tools/count" && req.method === "GET")
    return json(res, 200, BUILTIN_TOOL_DEFINITIONS.length);
  const toolDetail = pathname.match(/^\/v1\/tools\/(tool-[^/]+)\/?$/);
  if (toolDetail && req.method === "GET") return handleToolDetail(req, res, toolDetail[1]!);
  if (pathname === "/v1/providers" && req.method === "GET") return handleProviders(req, res);
  if (pathname === "/v1/models/embedding" && req.method === "GET") {
    return json(res, 200, [
      {
        handle: "openai/text-embedding-3-small",
        name: "text-embedding-3-small",
        display_name: "text-embedding-3-small",
        provider_type: "openai",
        provider_name: "openai",
        model_type: "embedding",
        embedding_model: "text-embedding-3-small",
        embedding_endpoint_type: "openai",
        embedding_endpoint: "https://api.openai.com/v1",
        embedding_dim: 1536,
        embedding_chunk_size: 300,
      },
    ]);
  }

  // ── Endpoints LocalBackend doesn't surface; vanilla returns lists too,
  // but we have no source data. Return empty arrays to match the vanilla
  // success shape rather than 404. Accept both bare and trailing-slash
  // forms because mobile sometimes appends "/" before query strings. ──
  const stubList = ({ pn, methods = ["GET"] }: { pn: string; methods?: string[] }): boolean =>
    methods.includes(req.method ?? "") &&
    (pathname === pn || pathname === pn + "/") &&
    (json(res, 200, []), true);
  const stubCount = ({ pn }: { pn: string }): boolean =>
    req.method === "GET" &&
    (pathname === pn || pathname === pn + "/") &&
    (json(res, 200, 0), true);

  if (stubList({ pn: "/v1/folders" })) return;
  if (stubList({ pn: "/v1/groups" })) return;
  if (stubList({ pn: "/v1/identities" })) return;
  if (stubList({ pn: "/v1/mcp-servers" })) return;
  if (stubList({ pn: "/v1/jobs" })) return;
  // /v1/runs is implemented for real below — do NOT stub it.
  if (stubList({ pn: "/v1/steps" })) return;
  if (stubList({ pn: "/v1/archives" })) return;
  if (stubCount({ pn: "/v1/blocks/count" })) return;
  if (stubCount({ pn: "/v1/folders/count" })) return;
  if (stubCount({ pn: "/v1/groups/count" })) return;
  if (stubCount({ pn: "/v1/identities/count" })) return;
  if (stubCount({ pn: "/v1/mcp-servers/count" })) return;
  if (stubCount({ pn: "/v1/jobs/count" })) return;
  // /v1/runs/count handled below via the real implementation.
  if (stubCount({ pn: "/v1/steps/count" })) return;
  if (stubCount({ pn: "/v1/archives/count" })) return;
  if (pathname === "/v1/messages/search" && req.method === "POST") {
    return handleMessagesSearch(req, res);
  }
  const searchStatus = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/search\/status\/?$/);
  if (searchStatus && req.method === "GET") return handleSearchStatus(req, res, searchStatus[1]!);
  const searchRebuild = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/search\/rebuild\/?$/);
  if (searchRebuild && req.method === "POST") return handleSearchRebuild(req, res, searchRebuild[1]!);
  if (pathname === "/api/projects" && req.method === "GET") return json(res, 200, []);
  if (pathname === "/v1/projects" && req.method === "GET") return json(res, 200, []);

  // /v1/runs/* — run tracking
  if (req.method === "GET" && (pathname === "/v1/runs" || pathname === "/v1/runs/")) {
    return handleRunsList(req, res, url);
  }
  if (req.method === "GET" && (pathname === "/v1/runs/count" || pathname === "/v1/runs/count/")) {
    return json(res, 200, listRuns({ limit: 10000 }).length);
  }
  const runMessages = pathname.match(/^\/v1\/runs\/(run-[^/]+)\/messages\/?$/);
  if (runMessages && req.method === "GET") return handleRunMessages(req, res, url, runMessages[1]!);
  const runUsage = pathname.match(/^\/v1\/runs\/(run-[^/]+)\/usage\/?$/);
  if (runUsage && req.method === "GET") return handleRunUsage(req, res, runUsage[1]!);
  const runMetrics = pathname.match(/^\/v1\/runs\/(run-[^/]+)\/metrics\/?$/);
  if (runMetrics && req.method === "GET") return handleRunMetrics(req, res, runMetrics[1]!);
  const runSteps = pathname.match(/^\/v1\/runs\/(run-[^/]+)\/steps\/?$/);
  if (runSteps && req.method === "GET") return handleRunSteps(req, res, url, runSteps[1]!);
  const runDetail = pathname.match(/^\/v1\/runs\/(run-[^/]+)\/?$/);
  if (runDetail) {
    if (req.method === "GET") return handleRunDetail(req, res, runDetail[1]!);
    if (req.method === "DELETE") return handleRunDelete(req, res, runDetail[1]!);
  }
  const agentCancel = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/messages\/cancel\/?$/);
  if (agentCancel && req.method === "POST") return handleAgentMessagesCancel(req, res, agentCancel[1]!);

  // /shim/v1/permissions/* + /shim/v1/approvals/* — server-side permissions
  // (lcp-indw). Config PUT/PATCH over REST is allowed (D3 — it's config, not
  // a live turn). Approval decisions funnel through the SAME resolveApproval
  // the WS path uses. The entire evaluator path is dark-shipped behind
  // SHIM_SERVER_PERMISSIONS=1, but these config/read endpoints are always
  // mounted (they have no effect on live turns when the flag is off).
  if (pathname === "/shim/v1/permissions/global" || pathname === "/shim/v1/permissions/global/") {
    if (req.method === "GET") return handlePermissionsGlobalGet(res);
    if (req.method === "PUT") return void handlePermissionsGlobalPut(req, res);
    return handlePermissionsMethodNotAllowed(req, res);
  }
  if (pathname === "/shim/v1/permissions/preview" || pathname === "/shim/v1/permissions/preview/") {
    if (req.method === "GET") return handlePermissionsPreview(res, url);
    return handlePermissionsMethodNotAllowed(req, res);
  }
  const permAgent = pathname.match(/^\/shim\/v1\/permissions\/agents\/([^/]+)\/?$/);
  if (permAgent) {
    const agentId = decodeURIComponent(permAgent[1]!);
    if (req.method === "GET") return handlePermissionsAgentGet(res, agentId);
    if (req.method === "PUT") return void handlePermissionsAgentPut(req, res, agentId);
    if (req.method === "PATCH") return void handlePermissionsAgentPatch(req, res, agentId);
    return handlePermissionsMethodNotAllowed(req, res);
  }
  if (pathname === "/shim/v1/approvals/pending" || pathname === "/shim/v1/approvals/pending/") {
    if (req.method === "GET") return handleApprovalsPending(res, url);
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { detail: `${req.method} not allowed on /shim/v1/approvals/pending` });
  }
  const approvalDecision = pathname.match(/^\/shim\/v1\/approvals\/([^/]+)\/?$/);
  if (approvalDecision && approvalDecision[1] !== "pending") {
    const runId = decodeURIComponent(approvalDecision[1]!);
    if (req.method === "POST") return void handleApprovalsDecision(req, res, runId);
    if (req.method === "DELETE") return handleApprovalsDelete(res, runId);
    res.setHeader("Allow", "POST, DELETE, OPTIONS");
    return json(res, 405, { detail: `${req.method} not allowed on /shim/v1/approvals/:runId` });
  }

  // /v1/crons/* — read mirror (lcp-9h3) + REST mutations (lcp-5o9o). All
  // writes go through the lock-serialized store in lib/crons.ts so concurrent
  // WS-write + REST-write cannot lose updates; we never touch crons.json here.
  if (pathname === "/v1/crons" || pathname === "/v1/crons/") {
    if (req.method === "GET") return handleCronsList(req, res, url);
    if (req.method === "POST") return handleCronCreate(req, res);
    if (req.method === "DELETE") return handleCronBulkDelete(res, url);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    return handleCronMethodNotAllowed(req, res);
  }
  if (pathname === "/v1/crons/scheduler" || pathname === "/v1/crons/scheduler/") {
    if (req.method === "GET") return handleCronScheduler(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    return handleCronMethodNotAllowed(req, res);
  }
  const cronDetail = pathname.match(/^\/v1\/crons\/([a-zA-Z0-9_-]+)\/?$/);
  if (cronDetail) {
    if (req.method === "GET") return handleCronDetail(req, res, cronDetail[1]!);
    if (req.method === "PUT") return handleCronReplace(req, res, cronDetail[1]!);
    if (req.method === "PATCH") return handleCronPatch(req, res, cronDetail[1]!);
    if (req.method === "DELETE") return handleCronDelete(res, cronDetail[1]!);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    return handleCronMethodNotAllowed(req, res);
  }

  // /v1/work-activity — external work ingest (lcp-zncq)
  if (pathname === "/v1/work-activity" || pathname === "/v1/work-activity/") {
    if (req.method === "POST") return handleWorkActivityIngest(req, res);
    if (req.method === "GET") return json(res, 200, snapshotSubagents());
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    res.setHeader("Allow", "POST, GET, OPTIONS");
    return json(res, 405, { detail: `${req.method} not allowed on /v1/work-activity` });
  }

  // /v1/skills/* — skill discovery, search, install, uninstall
  if (pathname === "/v1/skills" || pathname === "/v1/skills/") {
    if (req.method === "GET") return handleSkillsList(req, res);
    if (req.method === "POST") return handleSkillsSearch(req, res);
  }
  const skillDetail = pathname.match(/^\/v1\/skills\/([^/]+)\/?$/);
  if (skillDetail) {
    if (req.method === "GET") return handleSkillDetail(req, res, skillDetail[1]!);
    if (req.method === "PUT") return handleSkillPublish(req, res, skillDetail[1]!);
    if (req.method === "DELETE") return handleSkillDelete(req, res, skillDetail[1]!);
  }

  // /v1/agents/{agentId}/skills/* — per-agent skill management
  const agentSkillsList = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/skills\/?$/);
  if (agentSkillsList) {
    if (req.method === "GET") return handleAgentSkillsList(req, res, agentSkillsList[1]!);
    if (req.method === "POST") return handleAgentSkillInstall(req, res, agentSkillsList[1]!);
  }
  const agentSkillDetail = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/skills\/([^/]+)\/?$/);
  if (agentSkillDetail) {
    if (req.method === "GET") return handleAgentSkillDetail(req, res, agentSkillDetail[1]!, agentSkillDetail[2]!);
    if (req.method === "DELETE") return handleAgentSkillUninstall(req, res, agentSkillDetail[1]!, agentSkillDetail[2]!);
  }

  // /shim/v1/usage — aggregate token tracking (shim extension, not vanilla)
  if (req.method === "GET" && (pathname === "/shim/v1/usage/summary" || pathname === "/shim/v1/usage/summary/")) {
    return handleUsageSummary(req, res, url);
  }

  // /v1/conversations — match ANY id (mobile uses "default", conv-..., etc.)
  if (pathname === "/v1/conversations") {
    if (req.method === "GET") return handleConversationsList(req, res, url);
    if (req.method === "POST") return handleConversationCreate(req, res, url);
  }
  const convMessages = pathname.match(/^\/v1\/conversations\/([^/]+)\/messages\/?$/);
  if (convMessages) {
    if (req.method === "GET") return handleConversationMessagesList(req, res, url, convMessages[1]!);
    if (req.method === "POST") return handleConversationSendMessage(req, res, convMessages[1]!);
  }
  const convCancel = pathname.match(/^\/v1\/conversations\/([^/]+)\/cancel\/?$/);
  if (convCancel && req.method === "POST") return handleConversationCancel(req, res, convCancel[1]!);
  const convFork = pathname.match(/^\/v1\/conversations\/([^/]+)\/fork\/?$/);
  if (convFork && req.method === "POST") return handleConversationStub(req, res, convFork[1]!, "fork");
  const convRecompile = pathname.match(/^\/v1\/conversations\/([^/]+)\/recompile\/?$/);
  if (convRecompile && req.method === "POST") return handleConversationStub(req, res, convRecompile[1]!, "recompile");
  const convStream = pathname.match(/^\/v1\/conversations\/([^/]+)\/stream\/?$/);
  if (convStream && req.method === "POST") return handleConversationStream(req, res, convStream[1]!);
  const convDetail = pathname.match(/^\/v1\/conversations\/([^/]+)\/?$/);
  if (convDetail) {
    if (req.method === "GET") return handleConversationDetail(req, res, convDetail[1]!);
    if (req.method === "PATCH") return handleConversationUpdate(req, res, convDetail[1]!);
    if (req.method === "DELETE") return handleConversationDelete(req, res, convDetail[1]!);
  }

  notFound(res, `${req.method} ${pathname}`);
});

server.listen(PORT, HOST, () => {
  // Report the actual bound port — SHIM_PORT=0 lets the OS assign one,
  // which the test harness uses to avoid port collisions across parallel
  // suite invocations.
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
  console.log(`letta-code admin shim listening on http://${HOST}:${actualPort}`);
  console.log(`  LETTA_LOCAL_BACKEND_DIR=${process.env["LETTA_LOCAL_BACKEND_DIR"] ?? "(default)"}`);

  // Vision capability is data, not patches: export the catalog's pattern
  // list (plus operator extras) into our own env so every SDK-spawned
  // letta-code CLI child inherits it. The patch-loader's
  // __lcpFixLocalVisionInput helper reads LETTA_VISION_MODELS instead of a
  // hardcoded regex — adding a vision model means editing
  // VISION_MODEL_PATTERNS in lib/model-catalog.ts (or setting
  // SHIM_VISION_MODELS_EXTRA on the unit), never the patch-loader.
  const visionExtra = (process.env["SHIM_VISION_MODELS_EXTRA"] ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  process.env["LETTA_VISION_MODELS"] = [...VISION_MODEL_PATTERNS, ...visionExtra].join(",");
  console.log(`  LETTA_VISION_MODELS=${process.env["LETTA_VISION_MODELS"]}`);

  // lcp-indw: boot-sweep surviving pending approvals (R1). A turn parked on
  // an `ask` when the shim died cannot resume (its CLI session is gone), so
  // we flip each surviving `pending` → `expired`, append a synthetic terminal
  // frame (no eternal spinner on reconnect), and finalize the run. Runs
  // unconditionally — even with the feature flag off — so a restart after a
  // flag-on deploy never leaves a stuck approval. No-op when there are none.
  try {
    const swept = sweepPendingApprovalsOnBoot();
    if (swept > 0) console.log(`[permissions] boot-sweep expired ${swept} pending approval(s)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[permissions] boot-sweep failed: ${msg}`);
  }

  // lcp-0mw: claim the cron scheduler lease and start ticking. Set
  // SHIM_CRON_ENABLED=0 to opt out (tests do this so the suite doesn't
  // race a live scheduler). Default is on because cron is the shim's
  // canonical scheduler — bundled letta-code workers don't outlive
  // their idle window.
  if (process.env["SHIM_CRON_ENABLED"] !== "0") {
    startCronScheduler({
      fireTask: async (task, wrappedPrompt) => {
        await ensureMobileAdapter();
        const conversationId = task.conversation_id === "default"
          ? `conv-default-${task.agent_id}`
          : task.conversation_id;
        const turnId = `turn-channel-push-${randomUUID()}`;
        let runId: string | null = null;
        const base = {
          agent_id: task.agent_id,
          conversation_id: conversationId,
          turn_id: turnId,
          source: "channel_push",
        };
        try {
          await bridgeSendMessage(
            {
              agent_id: task.agent_id,
              conversation_id: conversationId,
              text: wrappedPrompt,
              // lcp-4tv: cron fires are operator-initiated, not user-initiated.
              // Mark them background so /v1/runs?background=true surfaces them
              // distinctly from regular mobile turns.
              background: true,
            },
            (frame) => {
              const frameRecord = frame as unknown as Record<string, unknown>;
              const frameRunId = typeof frameRecord["run_id"] === "string" ? frameRecord["run_id"] : runId;
              pushMobileChannelFrame({
                ...frame,
                ...base,
                run_id: frameRunId,
              });
            },
            {
              onRunCreated: (id) => {
                runId = id;
                pushMobileChannelFrame({
                  type: "turn_started",
                  ...base,
                  run_id: id,
                });
              },
            },
          );
          pushMobileChannelFrame({
            type: "turn_done",
            ...base,
            run_id: runId,
            status: "completed",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pushMobileChannelFrame({
            type: "error",
            ...base,
            run_id: runId,
            code: "internal_error",
            message,
          });
          pushMobileChannelFrame({
            type: "turn_done",
            ...base,
            run_id: runId,
            status: "failed",
            error_code: "internal_error",
            error_message: message,
          });
          throw err;
        }
      },
    });
  }
});

// ── Mobile channel WS upgrade route ───────────────────────────────
//
// /shim/v1/mobile is the WebSocket endpoint for the letta-mobile channel
// transport (Phase 1 of the mobile-as-channel epic). Other paths get a
// 404 on upgrade so unknown WS targets don't hang.
const wss = new WebSocketServer({ noServer: true, autoPong: false });
type MobileAdapter = Awaited<ReturnType<typeof getMobileChannelAdapter>>;
let mobileAdapter: MobileAdapter = null;

async function ensureMobileAdapter(): Promise<MobileAdapter> {
  if (!mobileAdapter) {
    mobileAdapter = await getMobileChannelAdapter({
      getServerId: () => SERVER_ID,
    });
  }
  return mobileAdapter;
}

function pushMobileChannelFrame(frame: Record<string, unknown>): void {
  const sender = mobileAdapter?.["sendMessage"];
  if (typeof sender !== "function") return;
  void sender(frame).catch((err: unknown) => {
    console.warn(`[mobile-channel] channel push failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/shim/v1/mobile") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  try {
    await ensureMobileAdapter();
    if (!mobileAdapter) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
  } catch (err) {
    console.error(`[mobile-channel] adapter load failed: ${(err as Error).message}`);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket as never, head, (ws) => {
    installMobileWsProtocolKeepalive(ws);
    mobileAdapter!.acceptConnection(ws, req);
  });
});

let shutdownInProgress = false;
async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[shim] received ${signal}, shutting down`);
  // Hard deadline: if anything below hangs, exit anyway so systemd doesn't
  // sit in stop-sigterm until TimeoutStopSec fires.
  const forceExit = setTimeout(() => {
    console.warn("[shim] graceful shutdown exceeded 4s, forcing exit");
    process.exit(0);
  }, 4000);
  forceExit.unref();
  try { stopCronScheduler(); } catch {}
  try { await getAgentPool().stopAll(); } catch {}
  try { await mobileAdapter?.stop?.(); } catch {}
  // Terminate live WS clients so server.close() can resolve.
  try {
    for (const client of wss.clients) {
      try { client.terminate(); } catch {}
    }
    wss.close();
  } catch {}
  server.close(() => process.exit(0));
}
process.on("SIGINT", (sig) => { void gracefulShutdown(sig); });
process.on("SIGTERM", (sig) => { void gracefulShutdown(sig); });
