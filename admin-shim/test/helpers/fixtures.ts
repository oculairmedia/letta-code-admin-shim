/**
 * Disk fixture helpers — seed agents, conversations, and messages into a
 * shim's LETTA_LOCAL_BACKEND_DIR before launch.
 *
 * Most tests use `seedAgent` + `seedConversation` to assemble a minimal
 * state directory; integration tests can copy a pre-built tree from
 * fixtures/state/<name>/ via the `fixture` option on startShim().
 *
 * On-disk format mirrors letta-code's LocalStore:
 *   <root>/agents/<base64url(agentId)>.json
 *   <root>/conversations/<base64url(key)>/conversation.json
 *   <root>/conversations/<base64url(key)>/messages.jsonl
 *   <root>/conversations/<base64url(key)>/system-prompt.json
 *   <root>/memfs/<agentId>/memory/system/*.md
 *
 * `key` is `default:<agentId>` for an agent's default conv, or
 * `conversation:<convId>` for an explicit one.
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import type { LocalMessagePart } from "../../lib/types/letta-stream.js";

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

export interface SeedAgentOptions {
  id?: string;
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  blocks?: Record<string, string>;
  tools?: string[];
  model?: string;
}

/**
 * Write an agent record to <root>/agents/<base64>.json.
 * Returns the agentId used.
 */
export function seedAgent(stateDir: string, {
  id,
  name = "Test Agent",
  description = null,
  systemPrompt = "You are a helpful test agent.",
  blocks = { persona: "I am a test persona.", human: "The user is a tester." },
  tools = ["Bash", "Read", "Write"],
  model = "lmstudio/opus-4-7",
}: SeedAgentOptions = {}): string {
  const agentId = id ?? `agent-test-${cryptoRandom()}`;
  ensureDir(join(stateDir, "agents"));
  const record = {
    id: agentId,
    name,
    description,
    system: systemPrompt,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    agent_type: "memgpt_agent",
    llm_config: { model, model_endpoint_type: "openai", context_window: 200_000 },
    embedding_config: { embedding_model: "letta-free", embedding_endpoint_type: "letta", embedding_dim: 1536 },
    tools,
    memory: {
      blocks: Object.entries(blocks).map(([label, value]) => ({
        label,
        value,
        description: null,
        limit: 5000,
      })),
    },
    metadata: {},
    project_id: null,
    template_id: null,
    base_template_id: null,
    deployment_id: null,
    entity_id: null,
  };
  writeFileSync(join(stateDir, "agents", `${b64url(agentId)}.json`), JSON.stringify(record, null, 2));

  // memfs blocks — letta-code stores them as files for the projection layer.
  const memDir = join(stateDir, "memfs", agentId, "memory", "system");
  ensureDir(memDir);
  for (const [label, value] of Object.entries(blocks)) {
    writeFileSync(join(memDir, `${label}.md`), value);
  }
  return agentId;
}

export interface SeedConversationOptions {
  id?: string;
  title?: string;
}

export interface SeedConversationResult {
  conversationId: string;
  key: string;
  dir: string;
}

/**
 * Write a conversation + system-prompt for the given agent. Returns
 * { conversationId, internalKey } where internalKey is what the on-disk
 * dir name encodes.
 *
 * If `id` is omitted, creates the agent's "default" conversation.
 */
export function seedConversation(stateDir: string, agentId: string, {
  id,
  title = "Test Conversation",
}: SeedConversationOptions = {}): SeedConversationResult {
  const conversationId = id ?? "default";
  const key = conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
  const dir = join(stateDir, "conversations", b64url(key));
  ensureDir(dir);

  const conv = {
    id: conversationId === "default" ? "default" : conversationId,
    agent_id: agentId,
    title,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    metadata: {},
  };
  writeFileSync(join(dir, "conversation.json"), JSON.stringify(conv, null, 2));
  writeFileSync(join(dir, "system-prompt.json"), JSON.stringify({
    content: "You are a helpful test agent.",
    timestamp: new Date(0).toISOString(),
  }, null, 2));
  // Ensure messages.jsonl exists (empty).
  writeFileSync(join(dir, "messages.jsonl"), "");
  return { conversationId, key, dir };
}

export interface SeedMessageInput {
  id?: string;
  role?: string;
  parts?: LocalMessagePart[];
  content?: string;
  sourceMessageIndex?: number;
  created_at?: string;
  metadata?: Record<string, unknown>;
  /**
   * Extra top-level fields to merge into the record — used to emit the
   * letta-code 0.25.x toolResult shape, which carries top-level toolCallId
   * / toolName / isError instead of stuffing them into parts.
   */
  extra?: Record<string, unknown>;
}

/**
 * Append a LocalMessage to the conversation's messages.jsonl. `parts`
 * defaults to a single text part; pass a custom array for tool calls,
 * reasoning, etc.
 */
export function seedMessage(
  stateDir: string,
  agentId: string,
  conversationId: string,
  msg: SeedMessageInput,
): string {
  const key = conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
  const path = join(stateDir, "conversations", b64url(key), "messages.jsonl");
  const id = msg.id ?? `ui-msg-${cryptoRandom()}`;
  const sourceIdx = msg.sourceMessageIndex ?? Math.floor(Math.random() * 1000);
  const record = {
    id,
    role: msg.role ?? "user",
    parts: msg.parts ?? [{ type: "text", text: msg.content ?? "" }],
    metadata: {
      created_at: msg.created_at ?? `2026-01-01T00:00:${String(sourceIdx + 1).padStart(2, "0")}.000Z`,
      ...(msg.metadata ?? {}),
    },
    ...(msg.extra ?? {}),
  };
  appendFileSync(path, JSON.stringify(record) + "\n");
  return id;
}

function cryptoRandom(): string {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now().toString(36)}`;
}

/** External conv id used by the shim (mobile-style). */
export function externalConvId(agentId: string, conversationId: string = "default"): string {
  return conversationId === "default"
    ? `conv-default-${agentId}`
    : conversationId;
}
