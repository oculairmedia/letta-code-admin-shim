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

import { createServer } from "node:http";
import { URL } from "node:url";

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  getAgentIdForConversation,
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
  _internals as storeInternals,
} from "./lib/store.mjs";
import {
  agentToLettaState,
  conversationToLetta,
  localMessageToConversationMessages,
  localMessageToLettaMessage,
} from "./lib/translate.mjs";
import { handleSendMessage } from "./lib/chat.mjs";
import { cancelRun, getAgentPool } from "./lib/agent-pool.mjs";
import {
  aggregateUsage,
  deleteRun,
  getRun,
  listRunSteps,
  listRuns,
} from "./lib/runs.js";
import { getMobileChannelAdapter } from "./lib/mobile-channel-host.mjs";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.SHIM_PORT || 8291);
const HOST = process.env.SHIM_HOST || "0.0.0.0";

function json(res, status, body, extraHeaders = {}) {
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

function notFound(res, what = "not found") {
  json(res, 404, { detail: what });
}

function parsePagination(searchParams) {
  const limit = Number(searchParams.get("limit") ?? 50);
  const offset = Number(searchParams.get("offset") ?? 0);
  return { limit: Number.isFinite(limit) ? limit : 50, offset: Number.isFinite(offset) ? offset : 0 };
}

function defaultConversationForAgent(agentId) {
  return getConversation("default", agentId);
}

// ── handlers ──────────────────────────────────────────────────────

// Server identity — a UUID generated on first run, persisted to disk, returned
// in every /v1/health/ response. Mobile binds its cache by (baseUrl,serverId).
// When this changes, the client should treat the cache as a different
// universe and self-invalidate. See README "Server identity" section.
const SERVER_ID_FILE = join(storeInternals.storageDir(), ".shim-server-id");
function readOrCreateServerId() {
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
    console.error(`server_id persist failed: ${err.message}`);
  }
  return fresh;
}
const SERVER_ID = readOrCreateServerId();
const SERVER_VERSION = "shim-0.2.0";
const SERVER_STARTED_AT = new Date().toISOString();
console.log(`server_id: ${SERVER_ID}`);

function handleHealth(_req, res) {
  json(res, 200, {
    version: SERVER_VERSION,
    status: "ok",
    server_id: SERVER_ID,
    server_started_at: SERVER_STARTED_AT,
    backend: "letta-code-local",
  });
}

function handlePoolStats(_req, res) {
  json(res, 200, getAgentPool().stats());
}

function handleAgentsList(req, res, url) {
  const { limit, offset } = parsePagination(url.searchParams);
  const tagFilter = url.searchParams.getAll("tags");
  const nameFilter = url.searchParams.get("name");
  let agents = listAgents();
  if (tagFilter.length > 0) {
    agents = agents.filter((a) => (a.tags ?? []).some((t) => tagFilter.includes(t)));
  }
  if (nameFilter) {
    agents = agents.filter((a) =>
      (a.name ?? "").toLowerCase().includes(nameFilter.toLowerCase()),
    );
  }
  const sliced = agents.slice(offset, offset + limit);
  const projected = sliced.map((a) => {
    const conv = defaultConversationForAgent(a.id);
    const messages = listMessages("default", a.id);
    const blocks = readBlocksForAgent(a.id);
    return agentToLettaState(a, { messages, blocks });
  });
  json(res, 200, projected);
}

function handleAgentsCount(_req, res) {
  json(res, 200, listAgents().length);
}

// Stale-id alias table — mobile may have cached an agent_id from an earlier
// migration revision. Map those legacy ids to the canonical current id so
// mobile's cached navigation doesn't break.
const AGENT_ID_ALIASES = {
  // pre-rev6 migrator generated these from a name-hash; rev6 onward uses
  // the original Letta-server UUIDs. Map the hashes to their canonical ids.
  "agent-migrated-77d0a4b78ede9f8d9e1b279b": "agent-597b5756-2915-4560-ba6b-91005f085166",
  "agent-migrated-eeb0dbb6d6117617453ba793": "agent-2fae4a23-1caa-460d-9033-9f30ac84ed5e",
};

function resolveAgentRecord(agentId) {
  let a = getAgentRecord(agentId);
  if (a) return a;
  const canonical = AGENT_ID_ALIASES[agentId];
  if (canonical) {
    a = getAgentRecord(canonical);
    if (a) {
      console.log(`[shim] agent alias: ${agentId} → ${canonical}`);
      return a;
    }
  }
  return null;
}

function handleAgentDetail(req, res, agentId) {
  const a = resolveAgentRecord(agentId);
  if (!a) return notFound(res, `agent ${agentId}`);
  const messages = listMessages("default", a.id);
  const blocks = readBlocksForAgent(a.id);
  json(res, 200, agentToLettaState(a, { messages, blocks }));
}

function handleAgentMessages(req, res, url, agentId) {
  const a = resolveAgentRecord(agentId);
  if (!a) return notFound(res, `agent ${agentId}`);
  const { limit } = parsePagination(url.searchParams);
  const before = url.searchParams.get("before") ?? undefined;
  const conversationId = url.searchParams.get("conversation_id") ?? "default";
  const items = listMessages(conversationId, agentId, { limit, before });
  json(
    res,
    200,
    items.map((m) => localMessageToLettaMessage(m, { agentId, conversationId })),
  );
}

function handleAgentContext(req, res, url, agentId) {
  const a = resolveAgentRecord(agentId);
  if (!a) return notFound(res, `agent ${agentId}`);
  // mobile passes the synthesized external conv id; resolve to internal.
  const requestedConv = url.searchParams.get("conversation_id") ?? "default";
  const resolved = requestedConv === "default"
    ? { conversationId: "default", agentId }
    : resolveConversationId(requestedConv) ?? { conversationId: requestedConv, agentId };
  const sp = readSystemPrompt(resolved.conversationId, resolved.agentId);
  const messages = listMessages(resolved.conversationId, resolved.agentId);
  const systemPrompt = sp?.content ?? a.system ?? "";
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
    messages: messages.map((m) => localMessageToLettaMessage(m, { agentId, conversationId: requestedConv })),
    functions_definitions: [],
  });
}

function handleAgentBlocks(req, res, agentId) {
  if (!resolveAgentRecord(agentId)) return notFound(res, `agent ${agentId}`);
  json(res, 200, readBlocksForAgent(agentId));
}

function handleBlocksList(_req, res) {
  // Union of all per-agent blocks. Real Letta has globally addressable blocks
  // but LocalBackend doesn't, so we synthesize.
  const all = [];
  for (const a of listAgents()) {
    all.push(...readBlocksForAgent(a.id));
  }
  json(res, 200, all);
}

function handleBlockDetail(req, res, blockId) {
  for (const a of listAgents()) {
    const blocks = readBlocksForAgent(a.id);
    const hit = blocks.find((b) => b.id === blockId);
    if (hit) return json(res, 200, hit);
  }
  notFound(res, `block ${blockId}`);
}

function vanillaModel({ handle, name, contextWindow = 200000, maxTokens = 16384 }) {
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
    model_endpoint: process.env.LMSTUDIO_BASE_URL || "http://localhost:8082/v1",
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

function handleModels(_req, res) {
  // Surface the model(s) we have wired through the lmstudio provider — and
  // a couple of common handles so mobile's model picker has options.
  json(res, 200, [
    vanillaModel({ handle: "lmstudio/opus-4-7", name: "opus-4-7" }),
    vanillaModel({ handle: "lmstudio/sonnet-4-5", name: "sonnet-4-5" }),
    vanillaModel({ handle: "lmstudio/opus-4-7-reasoning-high", name: "opus-4-7-reasoning-high" }),
    vanillaModel({ handle: "lmstudio/gpt-5.4", name: "gpt-5.4" }),
    vanillaModel({ handle: "lmstudio/gpt-5.4-mini", name: "gpt-5.4-mini", contextWindow: 400000 }),
  ]);
}

const BUILTIN_TOOL_DEFINITIONS = [
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

function vanillaTool({ name, description }) {
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

function handleTools(_req, res) {
  json(res, 200, BUILTIN_TOOL_DEFINITIONS.map(vanillaTool));
}

function handleToolDetail(_req, res, toolId) {
  const match = BUILTIN_TOOL_DEFINITIONS
    .map(vanillaTool)
    .find((t) => t.id === toolId);
  if (!match) return notFound(res, `tool ${toolId}`);
  json(res, 200, match);
}

function vanillaProvider({ name, providerType, baseUrl }) {
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

function handleProviders(_req, res) {
  json(res, 200, [
    vanillaProvider({
      name: "lmstudio-local",
      providerType: "openai",
      baseUrl: process.env.LMSTUDIO_BASE_URL || "http://localhost:8082/v1",
    }),
  ]);
}

async function sendMessage(req, res, agentId, conversationId) {
  if (!resolveAgentRecord(agentId)) return notFound(res, `agent ${agentId}`);
  try {
    await handleSendMessage(req, res, agentId, { conversationId });
  } catch (err) {
    if (!res.writableEnded) {
      json(res, 500, { detail: `chat dispatch failed: ${err.message}` });
    }
  }
}

// ── /v1/conversations namespace ────────────────────────────────────

function handleConversationsList(req, res, url) {
  const { limit, offset } = parsePagination(url.searchParams);
  const agentId = url.searchParams.get("agent_id") ?? undefined;
  const items = agentId ? listConversationsForAgent(agentId) : listAllConversations();
  items.sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  json(res, 200, items.slice(offset, offset + limit).map(conversationToLetta));
}

function handleConversationDetail(req, res, conversationId) {
  const conv = getConversation(conversationId);
  if (!conv) return notFound(res, `conversation ${conversationId}`);
  json(res, 200, conversationToLetta(conv));
}

async function handleConversationCreate(req, res, url) {
  const body = await readJsonBody(req);
  // mobile sends agent_id BOTH in query string AND in body — accept either.
  const agentId =
    url.searchParams.get("agent_id") ??
    body.agent_id ??
    body.agentId;
  if (!agentId || !resolveAgentRecord(agentId)) {
    return json(res, 400, { detail: "agent_id required (and must exist)" });
  }

  // Vanilla Letta server behaviour: every POST creates a brand-new
  // conversation. Mobile's chat lifecycle depends on this (each fresh-route
  // chat screen creates a fresh conv); idempotency here breaks mobile UX.
  const conversationId = body.id ?? `conv-${cryptoRandomUUID()}`;
  const now = new Date().toISOString();
  const conv = {
    id: conversationId,
    agent_id: agentId,
    archived: false,
    archived_at: null,
    created_at: now,
    updated_at: now,
    last_message_at: now,
    summary: body.summary ?? null,
    in_context_message_ids: [],
  };
  const key = `conversation:${conversationId}`;
  const dir = join(storeInternals.storageDir(), "conversations", storeInternals.b64url(key));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "conversation.json"), JSON.stringify(conv, null, 2) + "\n");
  writeFileSync(join(dir, "messages.jsonl"), "");
  json(res, 201, conversationToLetta(conv));
}

async function handleConversationUpdate(req, res, conversationId) {
  const conv = getConversation(conversationId);
  if (!conv) return notFound(res, `conversation ${conversationId}`);
  const body = await readJsonBody(req);
  const next = {
    ...conv,
    summary: body.summary ?? conv.summary,
    archived: body.archived ?? conv.archived,
    archived_at: body.archived === true ? new Date().toISOString() : conv.archived_at,
    updated_at: new Date().toISOString(),
  };
  const key = conv.id === "default" ? `default:${conv.agent_id}` : `conversation:${conv.id}`;
  const dir = join(storeInternals.storageDir(), "conversations", storeInternals.b64url(key));
  writeFileSync(join(dir, "conversation.json"), JSON.stringify(next, null, 2) + "\n");
  json(res, 200, conversationToLetta(next));
}

function handleConversationDelete(req, res, conversationId) {
  const conv = getConversation(conversationId);
  if (!conv) return notFound(res, `conversation ${conversationId}`);
  if (conv.id === "default") {
    return json(res, 400, { detail: "cannot delete the default conversation" });
  }
  const key = `conversation:${conv.id}`;
  const dir = join(storeInternals.storageDir(), "conversations", storeInternals.b64url(key));
  rmSync(dir, { recursive: true, force: true });
  json(res, 200, { id: conv.id, deleted: true });
}

function handleConversationMessagesList(req, res, url, externalConvId) {
  const resolved = resolveConversationId(externalConvId);
  if (!resolved) {
    // Unknown conv (e.g. cached client-side from a prior Python-Letta-server
    // session, or stale UI state). Return an empty list rather than 404 so
    // mobile's retry loop doesn't thrash.
    return json(res, 200, []);
  }
  const { limit } = parsePagination(url.searchParams);
  const before = url.searchParams.get("before") ?? undefined;
  const order = (url.searchParams.get("order") ?? "asc").toLowerCase();
  let items = listMessages(resolved.conversationId, resolved.agentId, { limit, before });
  if (order === "desc") items = [...items].reverse();
  const realTimes = readMessageTimestamps(resolved.conversationId, resolved.agentId);
  const otidMap = readOtidMap(resolved.conversationId, resolved.agentId);
  const out = [];
  for (const m of items) {
    const projected = localMessageToConversationMessages(m, {
      agentId: resolved.agentId,
      conversationId: externalConvId,
      realTimes,
      otidMap,
    });
    for (const p of projected) out.push(p);
  }
  json(res, 200, out);
}

async function handleConversationSendMessage(req, res, externalConvId) {
  const resolved = resolveConversationId(externalConvId);
  if (!resolved) return notFound(res, `conversation ${externalConvId}`);
  // letta-code's --conversation expects the INTERNAL id (e.g. "default" or
  // a real conv-*), not our synthesized external one.
  await sendMessage(req, res, resolved.agentId, resolved.conversationId);
}

function handleConversationStream(req, res, externalConvId) {
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
  req.on("close", () => clearInterval(ping));
}

function handleConversationCancel(req, res, conversationId) {
  // Phase 1: there's no shared subprocess registry yet. Acknowledge so the
  // client UI clears any pending state.
  const conv = getConversation(conversationId);
  if (!conv) return notFound(res, `conversation ${conversationId}`);
  json(res, 200, { id: conv.id, status: "accepted" });
}

function handleConversationStub(req, res, conversationId, op) {
  if (!getConversation(conversationId)) return notFound(res, `conversation ${conversationId}`);
  json(res, 501, { detail: `conversation op ${op} not yet implemented in Phase 1` });
}

// ── /v1/runs/* (vanilla Letta run tracking) ─────────────────────────
//
// Each turn the agent pool creates a Run record. Mobile polls these for
// status, lists active runs for resume detection, and POSTs cancels.
// See lib/runs.mjs for the data model and lifecycle.

function parseBoolParam(searchParams, name) {
  const raw = searchParams.get(name);
  if (raw == null) return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function handleRunsList(req, res, url) {
  const { limit } = parsePagination(url.searchParams);
  const params = {
    agentId: url.searchParams.get("agent_id") ?? undefined,
    agentIds: url.searchParams.getAll("agent_ids"),
    conversationId: url.searchParams.get("conversation_id") ?? undefined,
    active: parseBoolParam(url.searchParams, "active"),
    background: parseBoolParam(url.searchParams, "background"),
    statuses: url.searchParams.getAll("statuses"),
    stopReason: url.searchParams.get("stop_reason") ?? undefined,
    before: url.searchParams.get("before") ?? undefined,
    after: url.searchParams.get("after") ?? undefined,
    limit,
    order: url.searchParams.get("order") ?? "desc",
    ascending: parseBoolParam(url.searchParams, "ascending"),
  };
  if (params.agentIds?.length === 0) delete params.agentIds;
  if (params.statuses?.length === 0) delete params.statuses;
  json(res, 200, listRuns(params));
}

function handleRunDetail(req, res, runId) {
  const run = getRun(runId);
  if (!run) return notFound(res, `run ${runId}`);
  json(res, 200, run);
}

function handleRunMessages(req, res, url, runId) {
  const run = getRun(runId);
  if (!run) return notFound(res, `run ${runId}`);
  const order = (url.searchParams.get("order") ?? "asc").toLowerCase();
  const before = url.searchParams.get("before") ?? undefined;
  const after = url.searchParams.get("after") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 100);

  // Resolve the conversation that owned this run and fetch its messages,
  // filtered to the ids the run claimed. Project to vanilla shape so the
  // response matches what mobile gets from /v1/conversations/{id}/messages.
  const conv = run.conversation_id ? getConversation(run.conversation_id, run.agent_id) : null;
  const resolved = conv ? { conversationId: conv.id, agentId: conv.agent_id } : null;
  if (!resolved) return json(res, 200, []);
  const items = listMessages(resolved.conversationId, resolved.agentId, {});
  const realTimes = readMessageTimestamps(resolved.conversationId, resolved.agentId);
  const otidMap = readOtidMap(resolved.conversationId, resolved.agentId);
  const runMessageIds = new Set(run.message_ids ?? []);
  let out = [];
  for (const m of items) {
    if (!runMessageIds.has(m?.id)) continue;
    const projected = localMessageToConversationMessages(m, {
      agentId: resolved.agentId,
      conversationId: run.conversation_id,
      realTimes,
      otidMap,
    });
    for (const p of projected) out.push(p);
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

function handleRunUsage(req, res, runId) {
  const run = getRun(runId);
  if (!run) return notFound(res, `run ${runId}`);
  const u = run.usage ?? {};
  json(res, 200, {
    completion_tokens: u.completion_tokens ?? 0,
    prompt_tokens: u.prompt_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
    step_count: u.step_count ?? run.num_steps ?? 0,
    cached_input_tokens: u.cached_input_tokens ?? 0,
    cache_write_tokens: u.cache_write_tokens ?? 0,
    reasoning_tokens: u.reasoning_tokens ?? 0,
  });
}

function handleRunMetrics(req, res, runId) {
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

function handleRunSteps(req, res, url, runId) {
  const run = getRun(runId);
  if (!run) return notFound(res, `run ${runId}`);
  const steps = listRunSteps(runId, {
    before: url.searchParams.get("before") ?? undefined,
    after: url.searchParams.get("after") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
    order: url.searchParams.get("order") ?? "desc",
  });
  json(res, 200, steps);
}

async function handleRunDelete(req, res, runId) {
  const ok = deleteRun(runId);
  if (!ok) return notFound(res, `run ${runId}`);
  json(res, 200, { id: runId, deleted: true });
}

// ── /shim/v1/usage/* — token usage aggregation ─────────────────────
//
// Greenfield (not in vanilla Letta). Sums token counts across runs with
// optional grouping. Mobile/clients call this instead of fanning out
// `/v1/runs/{id}/steps` for every run in a window.

function handleUsageSummary(req, res, url) {
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
    groupBy: groupBy ?? null,
  });
  json(res, 200, result);
}

async function handleAgentMessagesCancel(req, res, agentId) {
  // Vanilla shape: POST /v1/agents/{agent_id}/messages/cancel with body
  // `{ run_ids: ["run-..."] }`. If run_ids is omitted/empty, vanilla
  // cancels ALL active runs for the agent. Returns a map { run_id: status }.
  const body = await readJsonBody(req);
  let runIds = Array.isArray(body?.run_ids) ? body.run_ids.filter((x) => typeof x === "string") : null;
  if (!runIds || runIds.length === 0) {
    const active = listRuns({ agentId, active: true, limit: 100 });
    runIds = active.map((r) => r.id);
  }
  const out = {};
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

// ── helpers ────────────────────────────────────────────────────────

function cryptoRandomUUID() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readJsonBody(req) {
  const buf = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
  if (buf.length === 0) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch { return {}; }
}

// ── router ────────────────────────────────────────────────────────

function pad(s, n) { return String(s).padEnd(n); }

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
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
  res.write = (chunk, ...rest) => {
    if (chunk) respBytes += Buffer.byteLength(chunk);
    return origWrite(chunk, ...rest);
  };
  res.end = (chunk, ...rest) => {
    if (chunk) respBytes += Buffer.byteLength(chunk);
    return origEnd(chunk, ...rest);
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

  // Health
  if (req.method === "GET" && (pathname === "/v1/health/" || pathname === "/v1/health")) {
    return handleHealth(req, res);
  }
  if (req.method === "GET" && pathname === "/shim/pool") {
    return handlePoolStats(req, res);
  }
  // Agents
  if (req.method === "GET" && pathname === "/v1/agents/count") return handleAgentsCount(req, res);
  if (req.method === "GET" && pathname === "/v1/agents") return handleAgentsList(req, res, url);
  if (req.method === "GET" && pathname === "/v1/models") return handleModels(req, res);

  const agentDetail = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/?$/);
  if (agentDetail && req.method === "GET") return handleAgentDetail(req, res, agentDetail[1]);

  const agentMessages = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/messages\/?$/);
  if (agentMessages && req.method === "GET") return handleAgentMessages(req, res, url, agentMessages[1]);
  if (agentMessages && req.method === "POST") return sendMessage(req, res, agentMessages[1]);

  const agentContext = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/context\/?$/);
  if (agentContext && req.method === "GET") return handleAgentContext(req, res, url, agentContext[1]);

  const agentBlocks = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/core-memory\/blocks\/?$/);
  if (agentBlocks && req.method === "GET") return handleAgentBlocks(req, res, agentBlocks[1]);

  if (req.method === "GET" && pathname === "/v1/blocks") return handleBlocksList(req, res);
  if (req.method === "GET" && (pathname === "/v1/blocks/count" || pathname === "/v1/blocks/count/"))
    return json(res, 200, 0);
  const blockDetail = pathname.match(/^\/v1\/blocks\/([^/]+)\/?$/);
  if (blockDetail && req.method === "GET") return handleBlockDetail(req, res, blockDetail[1]);

  // ── Endpoints we partially populate from letta-code state ──
  if (pathname === "/v1/tools" && req.method === "GET") return handleTools(req, res);
  if (pathname === "/v1/tools/count" && req.method === "GET")
    return json(res, 200, BUILTIN_TOOL_DEFINITIONS.length);
  const toolDetail = pathname.match(/^\/v1\/tools\/(tool-[^/]+)\/?$/);
  if (toolDetail && req.method === "GET") return handleToolDetail(req, res, toolDetail[1]);
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
  const stubList = ({ pn, methods = ["GET"] }) =>
    methods.includes(req.method) &&
    (pathname === pn || pathname === pn + "/") &&
    (json(res, 200, []), true);
  const stubCount = ({ pn }) =>
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
    return json(res, 200, { messages: [] });
  }
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
  if (runMessages && req.method === "GET") return handleRunMessages(req, res, url, runMessages[1]);
  const runUsage = pathname.match(/^\/v1\/runs\/(run-[^/]+)\/usage\/?$/);
  if (runUsage && req.method === "GET") return handleRunUsage(req, res, runUsage[1]);
  const runMetrics = pathname.match(/^\/v1\/runs\/(run-[^/]+)\/metrics\/?$/);
  if (runMetrics && req.method === "GET") return handleRunMetrics(req, res, runMetrics[1]);
  const runSteps = pathname.match(/^\/v1\/runs\/(run-[^/]+)\/steps\/?$/);
  if (runSteps && req.method === "GET") return handleRunSteps(req, res, url, runSteps[1]);
  const runDetail = pathname.match(/^\/v1\/runs\/(run-[^/]+)\/?$/);
  if (runDetail) {
    if (req.method === "GET") return handleRunDetail(req, res, runDetail[1]);
    if (req.method === "DELETE") return handleRunDelete(req, res, runDetail[1]);
  }
  const agentCancel = pathname.match(/^\/v1\/agents\/(agent-[^/]+)\/messages\/cancel\/?$/);
  if (agentCancel && req.method === "POST") return handleAgentMessagesCancel(req, res, agentCancel[1]);

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
    if (req.method === "GET") return handleConversationMessagesList(req, res, url, convMessages[1]);
    if (req.method === "POST") return handleConversationSendMessage(req, res, convMessages[1]);
  }
  const convCancel = pathname.match(/^\/v1\/conversations\/([^/]+)\/cancel\/?$/);
  if (convCancel && req.method === "POST") return handleConversationCancel(req, res, convCancel[1]);
  const convFork = pathname.match(/^\/v1\/conversations\/([^/]+)\/fork\/?$/);
  if (convFork && req.method === "POST") return handleConversationStub(req, res, convFork[1], "fork");
  const convRecompile = pathname.match(/^\/v1\/conversations\/([^/]+)\/recompile\/?$/);
  if (convRecompile && req.method === "POST") return handleConversationStub(req, res, convRecompile[1], "recompile");
  const convStream = pathname.match(/^\/v1\/conversations\/([^/]+)\/stream\/?$/);
  if (convStream && req.method === "POST") return handleConversationStream(req, res, convStream[1]);
  const convDetail = pathname.match(/^\/v1\/conversations\/([^/]+)\/?$/);
  if (convDetail) {
    if (req.method === "GET") return handleConversationDetail(req, res, convDetail[1]);
    if (req.method === "PATCH") return handleConversationUpdate(req, res, convDetail[1]);
    if (req.method === "DELETE") return handleConversationDelete(req, res, convDetail[1]);
  }

  notFound(res, `${req.method} ${pathname}`);
});

server.listen(PORT, HOST, () => {
  // Report the actual bound port — SHIM_PORT=0 lets the OS assign one,
  // which the test harness uses to avoid port collisions across parallel
  // suite invocations.
  const actualPort = server.address()?.port ?? PORT;
  console.log(`letta-code admin shim listening on http://${HOST}:${actualPort}`);
  console.log(`  LETTA_LOCAL_BACKEND_DIR=${process.env.LETTA_LOCAL_BACKEND_DIR ?? "(default)"}`);
});

// ── Mobile channel WS upgrade route ───────────────────────────────
//
// /shim/v1/mobile is the WebSocket endpoint for the letta-mobile channel
// transport (Phase 1 of the mobile-as-channel epic). Other paths get a
// 404 on upgrade so unknown WS targets don't hang.
const wss = new WebSocketServer({ noServer: true });
let mobileAdapter = null;

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/shim/v1/mobile") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  try {
    if (!mobileAdapter) {
      mobileAdapter = await getMobileChannelAdapter({
        getServerId: () => SERVER_ID,
      });
    }
    if (!mobileAdapter) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
  } catch (err) {
    console.error(`[mobile-channel] adapter load failed: ${err.message}`);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    mobileAdapter.acceptConnection(ws, req);
  });
});

async function gracefulShutdown() {
  try { await getAgentPool().stopAll(); } catch {}
  try { await mobileAdapter?.stop?.(); } catch {}
  server.close(() => process.exit(0));
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
