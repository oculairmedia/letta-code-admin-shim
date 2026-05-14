/**
 * Translate a Letta AgentFile (.af) export into letta-code LocalBackend
 * on-disk format.
 *
 * Phase 1 MVP scope:
 *   - 1+ agent per .af (the Meridian export has 2: Meridian + Meridian-Triage)
 *   - Inline memory blocks → memfs (with git init + initial commit)
 *   - Remap model handle (since LocalBackend's provider catalog differs)
 *   - Translate message history (text-only first pass; tool_calls/tool_returns
 *     get serialized as text parts so the LLM still sees a coherent history)
 *
 * Usage:
 *   node translate.mjs <path-to-af.json> <state-dir> [--model lmstudio/opus-4-7]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: translate.mjs <af-path> <state-dir> [--model handle]");
  process.exit(2);
}
const [afPath, stateDir] = args;
const modelArgIdx = args.indexOf("--model");
const targetModel = modelArgIdx >= 0 ? args[modelArgIdx + 1] : "lmstudio/opus-4-7";

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, obj) {
  ensureDir(join(path, ".."));
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function writeJsonl(path, items) {
  ensureDir(join(path, ".."));
  writeFileSync(path, `${items.map((i) => JSON.stringify(i)).join("\n")}\n`);
}

function sanitizeFilename(label) {
  return label.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function resolveBlockMap(af) {
  // Blocks at top level. Each agent has block_ids referencing them.
  const map = new Map();
  for (const b of af.blocks ?? []) {
    if (b.id) map.set(b.id, b);
  }
  return map;
}

function initGitMemoryRepo(memoryDir, agentName, agentId) {
  // Initialize git, commit initial state
  ensureDir(memoryDir);
  try {
    execSync("git init -q", { cwd: memoryDir });
    execSync("git config user.email letta-migrator@local", { cwd: memoryDir });
    execSync("git config user.name letta-migrator", { cwd: memoryDir });
    execSync("git add -A", { cwd: memoryDir });
    execSync(
      `git commit -q --allow-empty --author=${JSON.stringify(`${agentName} <${agentId}@letta.com>`)} -m "migrate: import from AgentFile"`,
      { cwd: memoryDir },
    );
    const headSha = execSync("git rev-parse HEAD", { cwd: memoryDir }).toString().trim();
    return headSha;
  } catch (err) {
    console.error(`  ⚠ memfs git init failed: ${err.message}`);
    return null;
  }
}

function writeMemfs(stateDir, agent, blockMap) {
  const memoryDir = join(stateDir, "memfs", agent.id, "memory");
  const systemDir = join(memoryDir, "system");
  ensureDir(systemDir);

  // Inline memory_blocks (Meridian had 0 here, all blocks via block_ids ref)
  for (const block of agent.memory_blocks ?? []) {
    if (!block.label) continue;
    const path = join(systemDir, `${sanitizeFilename(block.label)}.md`);
    writeFileSync(path, block.value ?? "");
  }

  // Resolved block_ids
  for (const blockId of agent.block_ids ?? []) {
    const block = blockMap.get(blockId);
    if (!block || !block.label) continue;
    const path = join(systemDir, `${sanitizeFilename(block.label)}.md`);
    writeFileSync(path, block.value ?? "");
  }

  return memoryDir;
}

function buildSystemPrompt(agent, blockMap) {
  // Compose the on-disk system prompt as: agent.system + concatenated memory blocks
  // (LocalBackend's runtime composes this at turn time too; we capture a snapshot.)
  const parts = [agent.system?.trim() ?? ""];
  const blocks = [];
  for (const block of agent.memory_blocks ?? []) {
    if (!block.label) continue;
    blocks.push(`# ${block.label}\n${block.value ?? ""}`);
  }
  for (const blockId of agent.block_ids ?? []) {
    const block = blockMap.get(blockId);
    if (!block || !block.label) continue;
    blocks.push(`# ${block.label}\n${block.value ?? ""}`);
  }
  if (blocks.length > 0) {
    parts.push("\n\n<memory_blocks>\n" + blocks.join("\n\n") + "\n</memory_blocks>");
  }
  return parts.join("\n").trim();
}

function partsFromLettaMessage(lm) {
  // Convert a Letta SDK Message → structured parts that the shim can later
  // project to the Letta wire format (assistant_message, tool_call_message,
  // tool_return_message). Preserves tool calls and returns as first-class
  // structured data rather than text-flattening them.
  const parts = [];

  // Text content
  for (const c of lm.content ?? []) {
    if (c.type === "text" && c.text) {
      parts.push({ type: "text", text: c.text });
    }
  }

  // Tool calls — emit one `tool-call` part per call (assistant role)
  if (Array.isArray(lm.tool_calls) && lm.tool_calls.length > 0) {
    for (const call of lm.tool_calls) {
      const name = call.function?.name || call.name || "tool";
      const tool_call_id = call.id || call.tool_call_id || "";
      const rawArgs = call.function?.arguments ?? call.arguments;
      const argumentsStr =
        typeof rawArgs === "string"
          ? rawArgs
          : rawArgs == null
            ? "{}"
            : JSON.stringify(rawArgs);
      parts.push({
        type: "tool-call",
        toolCallId: tool_call_id,
        name,
        arguments: argumentsStr,
      });
    }
  }

  // Tool returns — emit one `tool-return` part per return (tool role)
  if (Array.isArray(lm.tool_returns) && lm.tool_returns.length > 0) {
    for (const ret of lm.tool_returns) {
      const status = ret.status === "error" ? "error" : "success";
      const body =
        typeof ret.func_response === "string"
          ? ret.func_response
          : typeof ret.tool_return === "string"
            ? ret.tool_return
            : JSON.stringify(ret.func_response ?? ret.tool_return ?? "");
      parts.push({
        type: "tool-return",
        toolCallId: ret.tool_call_id || lm.tool_call_id || "",
        name: lm.name || ret.name || "tool",
        status,
        tool_return: body,
        stdout: ret.stdout ?? null,
        stderr: ret.stderr ?? null,
      });
    }
  } else if (lm.role === "tool" && lm.tool_call_id) {
    // Legacy single-return shape: content has the response text directly.
    const body = (lm.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("");
    parts.push({
      type: "tool-return",
      toolCallId: lm.tool_call_id,
      name: lm.name || "tool",
      status: "success",
      tool_return: body,
      stdout: null,
      stderr: null,
    });
    // Drop the text-part duplicate we already wrote above to avoid showing
    // raw JSON twice (once as assistant text, once as tool return).
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      if (parts[i]?.type === "text") {
        parts.splice(i, 1);
        break;
      }
    }
  }

  if (parts.length === 0) {
    parts.push({ type: "text", text: "" });
  }
  return parts;
}

function mapRole(letta) {
  // ai-SDK UIMessage roles: "system" | "user" | "assistant"
  // Letta roles: "system" | "user" | "assistant" | "tool" | "approval"
  switch (letta) {
    case "user":
      return "user";
    case "assistant":
    case "approval": // approval requests originate from the assistant
      return "assistant";
    case "tool":
      // tool messages → assistant-side observation in UI ordering
      return "assistant";
    case "system":
    default:
      return "system";
  }
}

function translateMessages(agent, agentId, conversationId, defaults = {}) {
  const messages = [];
  let counter = 0;
  for (const lm of agent.messages ?? []) {
    counter += 1;
    const uiId = `ui-msg-${counter}`;
    const created = lm.created_at || defaults.createdAt || new Date().toISOString();
    messages.push({
      id: uiId,
      role: mapRole(lm.role || lm.message_type),
      metadata: {
        created_at: created,
        updated_at: lm.updated_at || created,
        agent_id: agentId,
        conversation_id: conversationId,
      },
      parts: partsFromLettaMessage(lm),
    });
  }
  return messages;
}

// Map of agent name → original Letta server UUID. Lets migrated agents keep
// the same id mobile already has cached from a prior Letta server. Override
// at runtime with --id-map name=uuid,name=uuid.
const ID_MAP_DEFAULT = {
  "Meridian": "agent-597b5756-2915-4560-ba6b-91005f085166",
  "Meridian-Triage": "agent-2fae4a23-1caa-460d-9033-9f30ac84ed5e",
};
const idMapIdx = args.indexOf("--id-map");
const idMap = { ...ID_MAP_DEFAULT };
if (idMapIdx >= 0 && args[idMapIdx + 1]) {
  for (const pair of args[idMapIdx + 1].split(",")) {
    const [n, id] = pair.split("=");
    if (n && id) idMap[n.trim()] = id.trim();
  }
}

function writeAgent(stateDir, agent, blockMap) {
  // Prefer the canonical UUID from the id-map so mobile's cached agent id
  // resolves on the shim. Fall back to a deterministic hash of name.
  const baseId =
    idMap[agent.name] ??
    `agent-migrated-${createHash("sha1")
      .update(agent.name)
      .digest("hex")
      .slice(0, 24)}`;
  const agentId = baseId;

  // Resolve and write memfs first
  const memoryDir = writeMemfs(stateDir, { ...agent, id: agentId }, blockMap);
  const headSha = initGitMemoryRepo(memoryDir, agent.name, agentId);

  // Write agent record
  const record = {
    id: agentId,
    name: agent.name,
    description: agent.description ?? null,
    system: buildSystemPrompt(agent, blockMap),
    tags: agent.tags ?? [],
    model: targetModel,
    model_settings: {
      parallel_tool_calls: true,
      provider_type: targetModel.split("/", 1)[0] || "openai",
    },
  };
  writeJson(
    join(stateDir, "agents", `${b64url(agentId)}.json`),
    record,
  );

  // Translate messages once; both default & in_context_message_ids derive from it.
  const messages = translateMessages(agent, agentId, "default");

  // Default conversation (always-on per-agent thread) — holds migrated history
  const defaultKey = `default:${agentId}`;
  const defaultDir = join(stateDir, "conversations", b64url(defaultKey));
  ensureDir(defaultDir);
  writeJson(join(defaultDir, "conversation.json"), {
    id: "default",
    agent_id: agentId,
    archived: false,
    archived_at: null,
    created_at: messages[0]?.metadata?.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: messages.at(-1)?.metadata?.created_at ?? new Date().toISOString(),
    last_message_at: messages.at(-1)?.metadata?.created_at ?? new Date().toISOString(),
    summary: null,
    in_context_message_ids: messages.map((m) => m.id),
  });
  writeJsonl(join(defaultDir, "messages.jsonl"), messages);
  writeJson(join(defaultDir, "system-prompt.json"), {
    content: record.system,
    compiledAt: new Date().toISOString(),
    rawSystemHash: createHash("sha256").update(record.system).digest("hex"),
    memfsRevision: headSha ?? "0".repeat(40),
  });

  return { agentId, messageCount: messages.length, headSha };
}

// ── main ───────────────────────────────────────────────────────────

const af = JSON.parse(readFileSync(afPath, "utf8"));
const blockMap = resolveBlockMap(af);
ensureDir(stateDir);
ensureDir(join(stateDir, "agents"));
ensureDir(join(stateDir, "conversations"));
ensureDir(join(stateDir, "memfs"));

const results = [];
for (const agent of af.agents ?? []) {
  console.log(`Migrating agent "${agent.name}"…`);
  const r = writeAgent(stateDir, agent, blockMap);
  console.log(
    `  id=${r.agentId} messages=${r.messageCount} memfs_head=${r.headSha?.slice(0, 12) ?? "?"}`,
  );
  results.push({ name: agent.name, ...r });
}
console.log(`\nDone. Migrated ${results.length} agent(s) → ${stateDir}`);
