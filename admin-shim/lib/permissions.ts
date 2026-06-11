/**
 * Server-side permissions model (lcp-indw, Phase 2).
 *
 * A pure, synchronous rule evaluator plus the on-disk permissions config
 * store. The evaluator decides — for a given (agentId, conversationId,
 * toolName, toolInput) — whether the tool call should be `allow`ed,
 * `deny`ed, or held for an `ask` (approval) round-trip.
 *
 * PRODUCT DECISION (the single most important default in this feature):
 *   `default: allow`. A tool not matched by any rule is ALLOWED.
 *   Restriction is opt-in. This is baked into THREE places:
 *     1. the on-disk schema default (emptyConfig().default),
 *     2. the evaluator's hardcoded fallback constant (HARDCODED_DEFAULT),
 *     3. a dedicated regression test (test/permissions.test.ts).
 *
 * Resolution order (§1.1 / D1):
 *   per-agent rules first → global rules → effective default. The
 *   effective default is the per-agent file's `default` when a per-agent
 *   file exists, else the global file's `default`, else HARDCODED_DEFAULT
 *   ("allow").
 *
 * SECURITY NOTE (also surfaced in user-facing docs): prefix-match deny
 * rules such as `Bash(rm -rf:*)` are a UX GUARDRAIL to prevent accidents,
 * NOT a security boundary. They are trivially bypassed
 * (`bash -c 'rm -rf …'`, aliases, env indirection, base64, …). Do not
 * market this as sandboxing. Real isolation must come from the execution
 * environment, not string matching.
 *
 * Storage (mirrors crons.json / approvals.json sharding):
 *   <storageDir>/permissions.json            global fallback
 *   <storageDir>/permissions/<agentId>.json  per-agent overrides (one file
 *                                            per agent — concurrent PUTs to
 *                                            different agents never contend)
 *   <storageDir>/permissions.lock/owner.json single serialized writer for
 *                                            read-modify-write on PUT/PATCH
 *
 * Writes use atomic tmp+rename (matching writeCronFile) under a dedicated
 * mkdir-lock (separate from crons.lock so permissions edits and cron edits
 * never block each other).
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getStorageDir } from "./runs.js";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type PermissionAction = "allow" | "ask" | "deny" | "fork";

export interface PermissionRule {
  /** Match pattern: `*`, bare tool name (`Bash`), or `Name(prefix:*)`. */
  tool: string;
  action: PermissionAction;
  /** Optional human string surfaced in the approval card / deny frame. */
  reason?: string;
}

export interface PermissionConfig {
  version: number;
  /** Action when no rule matches. Defaults to `"allow"`. */
  default: PermissionAction;
  rules: PermissionRule[];
  updated_at?: string;
}

export type RuleSource = "agent" | "global" | "default";

export interface EvalResult {
  action: PermissionAction;
  reason: string;
  source: RuleSource;
}

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

/**
 * The hardcoded fallback default action. This is the evaluator-side mirror
 * of the schema default — both MUST be "allow" (the product decision). A
 * dedicated regression test pins this.
 */
export const HARDCODED_DEFAULT: PermissionAction = "allow";

const SCHEMA_VERSION = 1;
const GLOBAL_FILE_NAME = "permissions.json";
const AGENT_DIR_NAME = "permissions";
const LOCK_DIR_NAME = "permissions.lock";
const LOCK_TOKEN_FILE = "owner.json";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_AGE_MS = 30000;

// ──────────────────────────────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────────────────────────────

function globalConfigPath(): string {
  return join(getStorageDir(), GLOBAL_FILE_NAME);
}

function agentConfigDir(): string {
  return join(getStorageDir(), AGENT_DIR_NAME);
}

function agentConfigPath(agentId: string): string {
  return join(agentConfigDir(), `${sanitizeAgentId(agentId)}.json`);
}

function lockDirPath(): string {
  return join(getStorageDir(), LOCK_DIR_NAME);
}

/**
 * Keep per-agent shard filenames to a safe charset so a hostile / weird
 * agentId can't escape the permissions dir. Anything outside the allowed
 * set collapses to `_`; the result is still deterministic per agentId.
 */
function sanitizeAgentId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function emptyConfig(): PermissionConfig {
  // Schema default — see the file header product decision.
  return { version: SCHEMA_VERSION, default: HARDCODED_DEFAULT, rules: [] };
}

// ──────────────────────────────────────────────────────────────────────
// Normalization / parsing
// ──────────────────────────────────────────────────────────────────────

function isAction(v: unknown): v is PermissionAction {
  return v === "allow" || v === "ask" || v === "deny" || v === "fork";
}

/**
 * Coerce arbitrary on-disk / wire JSON into a valid PermissionConfig.
 * Unknown/missing version → treated as empty config (default-allow), never
 * throws. Missing `default` → "allow". Malformed rules are dropped.
 */
export function normalizeConfig(raw: unknown): PermissionConfig {
  if (typeof raw !== "object" || raw === null) return emptyConfig();
  const obj = raw as Record<string, unknown>;
  // Unknown version → treat as empty (default-allow). Never throw.
  if (obj["version"] !== SCHEMA_VERSION) return emptyConfig();
  const def = isAction(obj["default"]) ? obj["default"] : HARDCODED_DEFAULT;
  const rulesRaw = Array.isArray(obj["rules"]) ? obj["rules"] : [];
  const rules: PermissionRule[] = [];
  for (const r of rulesRaw) {
    if (typeof r !== "object" || r === null) continue;
    const ro = r as Record<string, unknown>;
    if (typeof ro["tool"] !== "string" || ro["tool"].length === 0) continue;
    if (!isAction(ro["action"])) continue;
    const rule: PermissionRule = { tool: ro["tool"], action: ro["action"] };
    if (typeof ro["reason"] === "string") rule.reason = ro["reason"];
    rules.push(rule);
  }
  const out: PermissionConfig = { version: SCHEMA_VERSION, default: def, rules };
  if (typeof obj["updated_at"] === "string") out.updated_at = obj["updated_at"];
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Read (cached by mtime, invalidated on write — mirrors runFileCache)
// ──────────────────────────────────────────────────────────────────────

interface ConfigCacheEntry {
  mtimeMs: number;
  size: number;
  config: PermissionConfig | null; // null = file absent at read time
}
const configCache = new Map<string, ConfigCacheEntry>();

function readConfigAt(path: string): PermissionConfig | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    configCache.delete(path);
    return null;
  }
  const cached = configCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.config;
  }
  let config: PermissionConfig | null = null;
  try {
    config = normalizeConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    config = null;
  }
  configCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, config });
  return config;
}

/** Read the global fallback config; absent → empty (default-allow). */
export function readGlobalConfig(): PermissionConfig {
  return readConfigAt(globalConfigPath()) ?? emptyConfig();
}

/**
 * Read a per-agent config. Returns null when no per-agent file exists (so
 * callers can distinguish "no per-agent file" from "empty per-agent file"
 * for the effective-default decision, D1).
 */
export function readAgentConfig(agentId: string): PermissionConfig | null {
  return readConfigAt(agentConfigPath(agentId));
}

/**
 * The doc clients always get back from GET /permissions/agents/:id — the
 * per-agent file if present, else a usable empty default-allow doc.
 */
export function readAgentConfigOrEffective(agentId: string): PermissionConfig {
  return readAgentConfig(agentId) ?? emptyConfig();
}

// ──────────────────────────────────────────────────────────────────────
// Single serialized writer (separate mkdir-lock; mirrors crons.ts)
// ──────────────────────────────────────────────────────────────────────

interface LockOwner {
  pid: number;
  token: string;
  acquired_at: number;
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, LOCK_TOKEN_FILE), "utf-8")) as LockOwner;
  } catch {
    return null;
  }
}

function isLockStale(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  if (!owner) {
    try {
      return Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_AGE_MS;
    } catch {
      return true;
    }
  }
  let alive = true;
  try {
    process.kill(owner.pid, 0);
  } catch {
    alive = false;
  }
  return !alive && Date.now() - owner.acquired_at > LOCK_STALE_AGE_MS;
}

export function withPermissionsLock<T>(fn: () => T): T {
  const lockDir = lockDirPath();
  const root = getStorageDir();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomBytes(4).toString("hex");
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false });
      writeFileSync(
        join(lockDir, LOCK_TOKEN_FILE),
        JSON.stringify({ pid: process.pid, token, acquired_at: Date.now() }),
      );
      try {
        return fn();
      } finally {
        try {
          const current = readLockOwner(lockDir);
          if (current && current.token === token) {
            rmSync(lockDir, { recursive: true, force: true });
          }
        } catch {
          // Release is best-effort; stale-lock detection covers leaks.
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        throw new Error("Failed to acquire permissions.lock — timed out after 5s");
      }
      if (isLockStale(lockDir)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
        continue;
      }
      const sleepMs = Math.min(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS, deadline - Date.now());
      if (sleepMs > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
      }
    }
  }
}

function writeConfigAtomic(path: string, config: PermissionConfig): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { flush: true });
  renameSync(tmp, path);
  configCache.delete(path); // invalidate read cache
}

/** Replace (PUT) the global config under the lock. Stamps updated_at. */
export function writeGlobalConfig(config: PermissionConfig): PermissionConfig {
  return withPermissionsLock(() => {
    const normalized = normalizeConfig(config);
    normalized.updated_at = new Date().toISOString();
    writeConfigAtomic(globalConfigPath(), normalized);
    return normalized;
  });
}

/** Replace (PUT) a per-agent config under the lock. Stamps updated_at. */
export function writeAgentConfig(agentId: string, config: PermissionConfig): PermissionConfig {
  return withPermissionsLock(() => {
    const normalized = normalizeConfig(config);
    normalized.updated_at = new Date().toISOString();
    writeConfigAtomic(agentConfigPath(agentId), normalized);
    return normalized;
  });
}

/**
 * PATCH-merge a per-agent config under the lock: read-modify-write so a
 * concurrent edit to a different agent never contends, and an edit to the
 * SAME agent is serialized (the load-bearing reason for the lock).
 *
 * Merge semantics: `default` and `rules` are replaced wholesale when
 * present in the patch (rules is an ordered list — partial array merges are
 * ambiguous, so a PATCH that includes `rules` replaces them). Absent fields
 * are preserved.
 */
export function patchAgentConfig(
  agentId: string,
  patch: { default?: PermissionAction; rules?: PermissionRule[] },
): PermissionConfig {
  return withPermissionsLock(() => {
    const existing = readAgentConfig(agentId) ?? emptyConfig();
    const merged: PermissionConfig = {
      version: SCHEMA_VERSION,
      default: isAction(patch.default) ? patch.default : existing.default,
      rules: Array.isArray(patch.rules) ? patch.rules : existing.rules,
    };
    const normalized = normalizeConfig(merged);
    normalized.updated_at = new Date().toISOString();
    writeConfigAtomic(agentConfigPath(agentId), normalized);
    return normalized;
  });
}

/** Test-only: drop the mtime read-cache so a test's writes are observed. */
export function __clearPermissionConfigCache(): void {
  configCache.clear();
}

/** Test-only: list per-agent config shard agentIds present on disk. */
export function __listAgentConfigIds(): string[] {
  const dir = agentConfigDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length));
}

// ──────────────────────────────────────────────────────────────────────
// Matching
// ──────────────────────────────────────────────────────────────────────

/**
 * Extract the "argument string" used for prefix matching. v1 uses the
 * primary string arg (Bash → `command`) and falls back to
 * JSON.stringify(toolInput). Compared case-sensitively after trimming
 * leading whitespace.
 */
function argString(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  if (toolInput) {
    // Bash → command. Other tools with an obvious primary string arg get a
    // best-effort pick; everything else falls back to the serialized input.
    const primaryKeys = ["command", "cmd", "path", "file_path", "url", "query"];
    for (const k of primaryKeys) {
      const v = toolInput[k];
      if (typeof v === "string") return v.replace(/^\s+/, "");
    }
  }
  try {
    return JSON.stringify(toolInput ?? {});
  } catch {
    return "";
  }
}

/**
 * Does `pattern` match this tool call?
 *   `*`              → any tool
 *   `Bash`           → exact tool-name match
 *   `Name(prefix:*)` → tool `Name` whose arg string starts with `prefix`
 *
 * The `Name(prefix:*)` form: the literal `:*` suffix is optional sugar; we
 * match on the prefix between `(` and the closing `)`, stripping a trailing
 * `:*` if present. Prefix-match deny is a UX GUARDRAIL, NOT a security
 * boundary (trivially bypassed) — see file header.
 */
export function ruleMatches(
  pattern: string,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): boolean {
  if (pattern === "*") return true;
  const open = pattern.indexOf("(");
  if (open === -1) {
    return pattern === toolName;
  }
  const name = pattern.slice(0, open);
  if (name !== toolName) return false;
  const close = pattern.lastIndexOf(")");
  let prefix = close > open ? pattern.slice(open + 1, close) : pattern.slice(open + 1);
  // Strip the conventional trailing `:*` glob marker.
  if (prefix.endsWith(":*")) prefix = prefix.slice(0, -2);
  else if (prefix.endsWith("*")) prefix = prefix.slice(0, -1);
  const arg = argString(toolName, toolInput);
  return arg.startsWith(prefix);
}

function firstMatch(
  rules: PermissionRule[],
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): PermissionRule | null {
  for (const rule of rules) {
    if (ruleMatches(rule.tool, toolName, toolInput)) return rule;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Evaluator
// ──────────────────────────────────────────────────────────────────────

/**
 * Evaluate the effective permission for a tool call. Pure relative to the
 * on-disk config (which is mtime-cached). First-matching-rule-wins,
 * top-to-bottom: per-agent rules are consulted first, then global rules,
 * then the effective default (D1: per-agent file's `default` if a per-agent
 * file exists, else global `default`, else HARDCODED_DEFAULT "allow").
 */
export function evaluatePermission(
  agentId: string,
  _conversationId: string | null | undefined,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): EvalResult {
  const agentConfig = readAgentConfig(agentId); // null if no per-agent file
  if (agentConfig) {
    const hit = firstMatch(agentConfig.rules, toolName, toolInput);
    if (hit) {
      return { action: hit.action, reason: hit.reason ?? "", source: "agent" };
    }
  }
  const globalConfig = readGlobalConfig();
  const globalHit = firstMatch(globalConfig.rules, toolName, toolInput);
  if (globalHit) {
    return { action: globalHit.action, reason: globalHit.reason ?? "", source: "global" };
  }
  // Effective default (D1).
  const effectiveDefault = agentConfig ? agentConfig.default : globalConfig.default;
  return { action: effectiveDefault, reason: "", source: "default" };
}

/** Is server-side permissions enabled? Dark-ship flag (D6, default OFF). */
export function serverPermissionsEnabled(): boolean {
  return process.env["SHIM_SERVER_PERMISSIONS"] === "1";
}

// ══════════════════════════════════════════════════════════════════════
// Fork verdict (lcp-wd3i)
// ══════════════════════════════════════════════════════════════════════

/**
 * Whether the fork verdict is enabled. Default-off behind
 * SHIM_FORK_VERDICT=1. When off, the entire fork-verdict path is
 * bypassed, and a rule with action "fork" is treated as "allow"
 * (the behavior is byte-identical to the feature being absent).
 */
export function forkVerdictEnabled(): boolean {
  return process.env["SHIM_FORK_VERDICT"] === "1";
}

/**
 * Session roles recognised by the fork-verdict exemption logic.
 * Fork and subagent sessions are EXEMPT from fork rules (workers
 * must work — only the front-man thread gets forked).
 */
export type ForkSessionRole = "main" | "fork" | "subagent";

/**
 * Evaluate the effective permission with fork-verdict awareness.
 *
 * When SHIM_FORK_VERDICT=1 AND the session role is "main":
 *   - A rule with action "fork" returns a fork verdict.
 *   - The fork verdict is a structured denial instructing the agent
 *     to dispatch Agent(subagent_type:'fork') instead.
 *
 * When SHIM_FORK_VERDICT=1 but session role is "fork" or "subagent":
 *   - Fork rules are treated as "allow" (workers must work).
 *
 * When SHIM_FORK_VERDICT is unset/0:
 *   - Fork rules are treated as "allow" (byte-identical legacy).
 */
export function evaluatePermissionWithFork(
  agentId: string,
  conversationId: string | null | undefined,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  sessionRole: ForkSessionRole,
): EvalResult {
  const base = evaluatePermission(agentId, conversationId, toolName, toolInput);

  // Fork verdict only activates when the feature flag is on AND the
  // rule actually returned a fork action.
  if (base.action !== "fork") return base;

  if (!forkVerdictEnabled()) {
    // Dark-ship: fork verdict is off → treat as allow (byte-identical).
    return { action: "allow", reason: base.reason, source: base.source };
  }

  if (sessionRole !== "main") {
    // Workers must work — fork rules are a no-op on non-main threads.
    return { action: "allow", reason: `${base.reason} (fork exempt: session role is ${sessionRole})`, source: base.source };
  }

  // Main thread + fork enabled → return the fork verdict.
  return base;
}

// ── Agent-actuated override (sudo semantics) ─────────────────────────

/**
 * Shape of the permissions_override field an agent may include in
 * a tool call to bypass a fork verdict.
 */
export interface PermissionsOverride {
  /** The rule being overridden, e.g. "Bash(*)". */
  rule: string;
  /** One-line justification for the override. Required, non-empty. */
  reason: string;
}

/**
 * Extract a permissions_override from the tool input. The override
 * can be at the top level of the toolInput alongside the tool's
 * real parameters, or nested under a `permissions_override` key.
 */
export function extractOverride(
  toolInput: Record<string, unknown> | undefined,
): PermissionsOverride | null {
  if (!toolInput) return null;
  // Direct top-level keys (the agent may inline them alongside other args)
  const rule = toolInput["permissions_override_rule"];
  const reason = toolInput["permissions_override_reason"];
  if (typeof rule === "string" && rule.length > 0 &&
      typeof reason === "string" && reason.length > 0) {
    return { rule, reason };
  }
  // Nested object form
  const nested = toolInput["permissions_override"];
  if (nested && typeof nested === "object") {
    const no = nested as Record<string, unknown>;
    const nr = no["rule"];
    const nrs = no["reason"];
    if (typeof nr === "string" && nr.length > 0 &&
        typeof nrs === "string" && nrs.length > 0) {
      return { rule: nr, reason: nrs };
    }
  }
  return null;
}

/**
 * Strip permissions_override fields from toolInput so the actual
 * tool execution doesn't see them.
 */
export function stripOverrideFields(
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = { ...toolInput };
  delete cleaned["permissions_override_rule"];
  delete cleaned["permissions_override_reason"];
  delete cleaned["permissions_override"];
  return cleaned;
}

/**
 * Audit log entry for an override event.
 */
export interface OverrideAuditEntry {
  agentId: string;
  conversationId: string;
  toolName: string;
  rule: string;
  justification: string;
  timestamp: string;
}

/** In-memory override audit log (ring-buffer style, last N entries). */
const OVERRIDE_AUDIT_MAX = 1000;
const overrideAuditLog: OverrideAuditEntry[] = [];

/** Simple in-memory rate-limiter state scoped to (agentId, conversationId). */
interface OverrideRateState {
  countThisTurn: number;
  countThisHour: number;
  hourStart: number;
  turnStart: number;
}

const overrideRateState = new Map<string, OverrideRateState>();

function rateKey(agentId: string, conversationId: string): string {
  return `${agentId}::${conversationId}`;
}

function getOverrideRateState(agentId: string, conversationId: string): OverrideRateState {
  const key = rateKey(agentId, conversationId);
  let state = overrideRateState.get(key);
  if (!state) {
    state = { countThisTurn: 0, countThisHour: 0, hourStart: Date.now(), turnStart: Date.now() };
    overrideRateState.set(key, state);
  }
  // Rotate hour window
  if (Date.now() - state.hourStart > 3_600_000) {
    state.countThisHour = 0;
    state.hourStart = Date.now();
  }
  return state;
}

/** Reset per-turn counter (call at start of each turn). */
export function resetOverrideTurnCounter(agentId: string, conversationId: string): void {
  const key = rateKey(agentId, conversationId);
  let state = overrideRateState.get(key);
  if (!state) {
    state = { countThisTurn: 0, countThisHour: 0, hourStart: Date.now(), turnStart: Date.now() };
    overrideRateState.set(key, state);
  }
  state.countThisTurn = 0;
  state.turnStart = Date.now();
}

/**
 * Parse an environment variable as a non-negative integer for
 * fork-override rate-limit configuration. Returns the parsed value
 * when valid. On any unparseable value (NaN, Infinity, negative,
 * fractional, or non-numeric strings like "three"), logs an explicit
 * warning with the raw value and returns the hardcoded default.
 *
 * Zero is valid — it explicitly disables the rate limit (as designed).
 */
function parseOverrideRateLimit(envKey: string, defaultVal: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return defaultVal;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    console.warn(
      `[permissions] ${envKey}=${JSON.stringify(raw)} is not a valid non-negative integer — using default ${defaultVal}`,
    );
    return defaultVal;
  }
  return num;
}

/**
 * Check whether an override is allowed under the current rate limits.
 * Returns null if allowed, or a reason string if denied.
 *
 * Rate limits (env-configurable, validated via parseOverrideRateLimit):
 *   SHIM_FORK_OVERRIDE_PER_TURN     default 3
 *   SHIM_FORK_OVERRIDE_PER_HOUR     default 10
 */
export function checkOverrideRateLimit(
  agentId: string,
  conversationId: string,
): string | null {
  const maxPerTurn = parseOverrideRateLimit("SHIM_FORK_OVERRIDE_PER_TURN", 3);
  const maxPerHour = parseOverrideRateLimit("SHIM_FORK_OVERRIDE_PER_HOUR", 10);

  const state = getOverrideRateState(agentId, conversationId);

  if (state.countThisTurn >= maxPerTurn) {
    return `override rate limit exceeded: ${state.countThisTurn}/${maxPerTurn} this turn`;
  }
  if (state.countThisHour >= maxPerHour) {
    return `override rate limit exceeded: ${state.countThisHour}/${maxPerHour} this hour`;
  }
  return null;
}

/** Record a successful override in the rate-limiter state. */
export function recordOverride(agentId: string, conversationId: string): void {
  const state = getOverrideRateState(agentId, conversationId);
  state.countThisTurn += 1;
  state.countThisHour += 1;
}

/** Append an override event to the audit log. */
export function appendOverrideAudit(entry: OverrideAuditEntry): void {
  overrideAuditLog.push(entry);
  if (overrideAuditLog.length > OVERRIDE_AUDIT_MAX) {
    overrideAuditLog.splice(0, overrideAuditLog.length - OVERRIDE_AUDIT_MAX);
  }
}

/** Query the override audit log (newest first). */
export function getOverrideAuditLog(): OverrideAuditEntry[] {
  return [...overrideAuditLog].reverse();
}

/**
 * Whether the agent-actuated override path is enabled.
 * Controlled by SHIM_FORK_OVERRIDE_ENABLED (default "1" when
 * SHIM_FORK_VERDICT=1, "0" to disable overrides entirely).
 */
export function forkOverrideEnabled(): boolean {
  if (!forkVerdictEnabled()) return false;
  const env = process.env["SHIM_FORK_OVERRIDE_ENABLED"];
  if (env === "0") return false;
  return true;
}

/** Test-only: clear audit log + rate state. */
export function __clearForkAuditAndRateState(): void {
  overrideAuditLog.length = 0;
  overrideRateState.clear();
}

