/**
 * Store layer for the per-channel config files the letta CLI also writes:
 *
 *   ~/.letta/channels/<id>/channel.json    — static manifest (discovery)
 *   ~/.letta/channels/<id>/accounts.json   — { accounts: ChannelAccount[] }
 *   ~/.letta/channels/<id>/routing.yaml    — JSON body { routes: Route[] }
 *                                            (JSON despite the extension —
 *                                            the CLI's saveRoutes uses
 *                                            JSON.stringify; writing real
 *                                            YAML would make the CLI read
 *                                            the file as empty)
 *
 * Mirrors the lib/crons.ts contract: handlers never touch the files
 * directly; all I/O goes through this store, and mutators run under a
 * per-channel mkdir lock. Unlike crons.ts the contended lock path here is
 * ASYNC (setTimeout retry loop, never Atomics.wait) — a stale lock left by
 * a crashed CLI must not freeze the event loop and stall mobile WS frames.
 *
 * Mutators are read-modify-write of the whole file and spread-preserve
 * unknown fields so CLI-written snake_case extras, `dmPolicy`,
 * `__letta_secret_refs`, etc. survive untouched. Reads never rewrite or
 * normalize the files — only explicit mutations write.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  channelAccountsPath,
  channelDir,
  channelManifestPath,
  channelRoutingPath,
  channelsRoot,
} from "./channel-paths.js";
import type { ChannelAccount } from "./types/channel-plugin.js";

export type { ChannelAccount };

/**
 * Thrown by `upsertAccount`/`upsertRoute` with `{ expectAbsent: true }`
 * when the key already exists — the check runs INSIDE the channel lock so
 * two concurrent creates cannot both pass a lock-free pre-check and have
 * the second silently merge over the first. REST maps this to 409.
 */
export class ChannelStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelStoreConflictError";
  }
}

/**
 * JSON.parse with the file content kept OUT of the error message: V8 parse
 * errors embed a snippet of the source (`Unexpected token 's', ..."ssToken":
 * sek"...`), so a corrupt accounts.json could leak a secret FRAGMENT through
 * REST error bodies and warn logs — fragments that the full-value
 * scrubSecrets registry cannot match.
 */
function parseJsonFileBody(path: string, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`invalid JSON in ${path}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Discovery
// ──────────────────────────────────────────────────────────────────────

export interface ChannelManifest {
  id: string;
  displayName?: string;
  entry?: string;
  runtimePackages?: string[];
  runtimeModules?: string[];
  [k: string]: unknown;
}

/**
 * Enumerate `~/.letta/channels/<dir>/channel.json`. Directories without a
 * manifest are skipped silently (state dirs, media caches); manifests that
 * fail to parse are skipped with a warning so one corrupt file cannot hide
 * every other channel.
 */
export function discoverChannels(): ChannelManifest[] {
  const root = channelsRoot();
  if (!existsSync(root)) return [];
  const out: ChannelManifest[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const name of entries.sort()) {
    const manifestPath = channelManifestPath(name);
    if (!existsSync(manifestPath)) continue;
    try {
      const parsed = parseJsonFileBody(manifestPath, readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const id = typeof parsed["id"] === "string" && parsed["id"].length > 0 ? parsed["id"] : name;
      out.push({ ...parsed, id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[channel-config] skipping ${manifestPath}: ${msg}`);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Per-channel write lock (mkdir-based, ASYNC acquisition)
// ──────────────────────────────────────────────────────────────────────

const LOCK_DIR_NAME = ".shim-lock";
const LOCK_STALE_AGE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Serialize shim-side WRITES on one channel against each other. Reads are
 * lock-free (§4.3 of the channel-host design). NOT the crons.ts recipe:
 * the contended path there parks the thread with Atomics.wait, which with
 * a stale lock (crashed CLI) would freeze the whole shim — including
 * mobile WS frames — for seconds. Here contention yields to the event
 * loop on a setTimeout retry.
 */
export async function withChannelLock<T>(
  channelId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const dir = channelDir(channelId);
  mkdirSync(dir, { recursive: true });
  const lockDir = join(dir, LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_AGE_MS;
      } catch {
        // Lock vanished between mkdir and stat — retry immediately.
        continue;
      }
      if (stale) {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`failed to acquire channel lock for ${channelId} after ${LOCK_TIMEOUT_MS}ms`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────
// Atomic file write (temp + rename — the CLI's saveRoutes is NOT atomic,
// but ours is; torn CLI writes are tolerated on the read side instead)
// ──────────────────────────────────────────────────────────────────────

function writeFileAtomic(path: string, body: string): void {
  const tmp = `${path}.shim-tmp`;
  writeFileSync(tmp, body, { flush: true });
  renameSync(tmp, path);
}

// ──────────────────────────────────────────────────────────────────────
// accounts.json — shape { accounts: ChannelAccount[] }
// ──────────────────────────────────────────────────────────────────────

function readAccountsFile(channelId: string): { accounts: ChannelAccount[]; extras: Record<string, unknown> } {
  const path = channelAccountsPath(channelId);
  if (!existsSync(path)) return { accounts: [], extras: {} };
  const parsed = parseJsonFileBody(path, readFileSync(path, "utf8")) as Record<string, unknown>;
  const accounts = Array.isArray(parsed["accounts"]) ? (parsed["accounts"] as ChannelAccount[]) : [];
  const { accounts: _drop, ...extras } = parsed;
  return { accounts, extras };
}

function writeAccountsFile(
  channelId: string,
  accounts: ChannelAccount[],
  extras: Record<string, unknown>,
): void {
  writeFileAtomic(
    channelAccountsPath(channelId),
    JSON.stringify({ ...extras, accounts }, null, 2) + "\n",
  );
}

export function listAccounts(channelId: string): ChannelAccount[] {
  try {
    return readAccountsFile(channelId).accounts;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[channel-config] accounts.json read failed for ${channelId}: ${msg}`);
    return [];
  }
}

/**
 * Create-or-replace one account. On create the store stamps
 * `channel: <channelId>` when absent — consumers filter on it (e.g.
 * mobile's loadAccount()), so a record without it would be silently dead.
 * On update, unknown fields on the existing record are spread-preserved.
 */
export async function upsertAccount(
  channelId: string,
  account: ChannelAccount,
  opts?: { expectAbsent?: boolean },
): Promise<ChannelAccount> {
  if (typeof account.accountId !== "string" || account.accountId.length === 0) {
    throw new Error("accountId is required");
  }
  return withChannelLock(channelId, () => {
    const { accounts, extras } = readAccountsFile(channelId);
    const idx = accounts.findIndex((a) => a.accountId === account.accountId);
    if (opts?.expectAbsent && idx >= 0) {
      throw new ChannelStoreConflictError(`account ${account.accountId} already exists`);
    }
    let persisted: ChannelAccount;
    if (idx >= 0) {
      persisted = { ...accounts[idx], ...account };
      accounts[idx] = persisted;
    } else {
      persisted = { channel: channelId, ...account };
      accounts.push(persisted);
    }
    writeAccountsFile(channelId, accounts, extras);
    return persisted;
  });
}

/**
 * Partial update. `patch.config` merges via
 * {@link mergeConfigPreservingSecrets} so a caller round-tripping a
 * redacted GET body (secret sentinels) never clobbers stored secrets.
 * Returns null when the account does not exist.
 */
export async function patchAccount(
  channelId: string,
  accountId: string,
  patch: Partial<ChannelAccount>,
): Promise<ChannelAccount | null> {
  return withChannelLock(channelId, () => {
    const { accounts, extras } = readAccountsFile(channelId);
    const idx = accounts.findIndex((a) => a.accountId === accountId);
    const existing = idx >= 0 ? accounts[idx] : undefined;
    if (idx < 0 || !existing) return null;
    const { config: patchConfig, ...rest } = patch;
    const updated: ChannelAccount = { ...existing, ...rest };
    if (patchConfig && typeof patchConfig === "object") {
      updated.config = mergeConfigPreservingSecrets(
        (existing.config ?? {}) as Record<string, unknown>,
        patchConfig as Record<string, unknown>,
      );
    }
    accounts[idx] = updated;
    writeAccountsFile(channelId, accounts, extras);
    return updated;
  });
}

export async function deleteAccount(channelId: string, accountId: string): Promise<boolean> {
  return withChannelLock(channelId, () => {
    const { accounts, extras } = readAccountsFile(channelId);
    const next = accounts.filter((a) => a.accountId !== accountId);
    if (next.length === accounts.length) return false;
    writeAccountsFile(channelId, next, extras);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────
// routing.yaml — JSON body { routes: Route[] } (CLI-compatible)
// ──────────────────────────────────────────────────────────────────────

/**
 * Route record. Fields beyond the key (accountId/chatId/threadId) and the
 * target (agentId/conversationId) are optional IN PRACTICE: real
 * CLI-vintage files lack `chatType`, `outboundEnabled`, and `updatedAt`.
 * Absence is treated as defaults (`outboundEnabled` absent ⇒ enabled) and
 * reads never rewrite or normalize the file.
 */
export interface Route {
  accountId?: string;
  chatId: string;
  chatType?: string;
  threadId?: string | null;
  agentId: string;
  conversationId: string;
  enabled?: boolean;
  outboundEnabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

const LEGACY_ACCOUNT_ID = "__legacy_migrated__";
const ROOT_THREAD_ID = "__root__";

/**
 * Matches the CLI's `normalizeThreadId`: trim, and a missing or
 * empty/whitespace-only value collapses to `__root__`. Without the trim, a
 * REST route with `threadId: ""` would key `acct:chat:` while the CLI keys
 * the same target `acct:chat:__root__` — divergent dedup and resolution.
 */
function normalizeThreadId(threadId?: string | null): string {
  const trimmed = typeof threadId === "string" ? threadId.trim() : null;
  return trimmed && trimmed.length > 0 ? trimmed : ROOT_THREAD_ID;
}

/**
 * The CLI's exact colon-separated route identity (letta.js `routeKey`):
 * `accountId:chatId:threadId` with `__legacy_migrated__`/`__root__`
 * fallbacks. Shim upserts dedupe on this key exactly like
 * `letta channels route add`.
 */
export function routeKey(
  accountId: string | null | undefined,
  chatId: string,
  threadId?: string | null,
): string {
  return `${accountId ?? LEGACY_ACCOUNT_ID}:${chatId}:${normalizeThreadId(threadId)}`;
}

function routeKeyOf(route: Route): string {
  return routeKey(route.accountId ?? null, route.chatId, route.threadId ?? null);
}

/**
 * Derived (never persisted) stable route id for the REST surface:
 * base64url of {@link routeKey}. Not persisted because the CLI's
 * saveRoutes serializes only known fields — any shim-added extra would die
 * on the next CLI write.
 */
export function deriveRouteId(route: Route): string {
  return Buffer.from(routeKeyOf(route), "utf8").toString("base64url");
}

export function routeKeyFromId(routeId: string): string | null {
  try {
    const decoded = Buffer.from(routeId, "base64url").toString("utf8");
    return decoded.includes(":") ? decoded : null;
  } catch {
    return null;
  }
}

interface RoutesCacheEntry {
  mtimeMs: number;
  size: number;
  generation: number;
  routes: Route[];
}

// Last-good parse per channel. Torn mid-write reads (the CLI's saveRoutes
// is a plain writeFileSync) must not be treated as "no routes" — that
// would silently drop inbound. On parse failure we keep serving the
// last-good routes and warn.
const routesCache = new Map<string, RoutesCacheEntry>();
// Bumped on every shim-side write: mtime resolution alone can miss a
// second write landing within the same tick, which would leave the cache
// stale and misroute the next inbound.
const routesWriteGeneration = new Map<string, number>();

function currentGeneration(channelId: string): number {
  return routesWriteGeneration.get(channelId) ?? 0;
}

function bumpGeneration(channelId: string): void {
  routesWriteGeneration.set(channelId, currentGeneration(channelId) + 1);
}

function parseRoutesBody(path: string, body: string): Route[] {
  const parsed = parseJsonFileBody(path, body) as Record<string, unknown>;
  return Array.isArray(parsed["routes"]) ? (parsed["routes"] as Route[]) : [];
}

/** Read routes fresh (stat-cached on mtimeMs + size + shim write generation). */
export function listRoutes(channelId: string): Route[] {
  const path = channelRoutingPath(channelId);
  const cached = routesCache.get(channelId);
  const generation = currentGeneration(channelId);
  let stat: { mtimeMs: number; size: number } | null = null;
  try {
    const s = statSync(path);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    // Missing file ⇒ genuinely no routes; drop any stale cache.
    routesCache.delete(channelId);
    return [];
  }
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.generation === generation
  ) {
    return cached.routes;
  }
  try {
    const routes = parseRoutesBody(path, readFileSync(path, "utf8"));
    routesCache.set(channelId, { mtimeMs: stat.mtimeMs, size: stat.size, generation, routes });
    return routes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[channel-config] routing.yaml parse failed for ${channelId} (keeping last-good): ${msg}`);
    return cached?.routes ?? [];
  }
}

/**
 * Resolve the route for one inbound message. EXACT-key lookup only,
 * matching the CLI's `getRoute` (a plain `routesByKey.get`, no fallback):
 * a `__legacy_migrated__` route must not catch traffic from every account
 * the shim hosts when the native host would route none of it. Disabled
 * routes return null.
 */
export function resolveRoute(
  channelId: string,
  accountId: string | null | undefined,
  chatId: string,
  threadId?: string | null,
): Route | null {
  const key = routeKey(accountId, chatId, threadId);
  const match = listRoutes(channelId).find((r) => routeKeyOf(r) === key);
  if (!match) return null;
  if (match.enabled === false) return null;
  return match;
}

function readRoutesForWrite(channelId: string): { routes: Route[]; extras: Record<string, unknown> } {
  const path = channelRoutingPath(channelId);
  if (!existsSync(path)) return { routes: [], extras: {} };
  // Mutators read the file directly (not the cache) and fail loudly on a
  // parse error rather than clobbering a file we could not read.
  const parsed = parseJsonFileBody(path, readFileSync(path, "utf8")) as Record<string, unknown>;
  const routes = Array.isArray(parsed["routes"]) ? (parsed["routes"] as Route[]) : [];
  const { routes: _drop, ...extras } = parsed;
  return { routes, extras };
}

function writeRoutesFile(channelId: string, routes: Route[], extras: Record<string, unknown>): void {
  // Byte-compatible with the CLI's saveRoutes (JSON.stringify, 2-space).
  writeFileAtomic(
    channelRoutingPath(channelId),
    JSON.stringify({ ...extras, routes }, null, 2) + "\n",
  );
  bumpGeneration(channelId);
}

/** Create-or-replace by CLI route key. Preserves unknown fields on update. */
export async function upsertRoute(
  channelId: string,
  route: Route,
  opts?: { expectAbsent?: boolean },
): Promise<Route> {
  return withChannelLock(channelId, () => {
    const { routes, extras } = readRoutesForWrite(channelId);
    const key = routeKeyOf(route);
    const now = new Date().toISOString();
    const idx = routes.findIndex((r) => routeKeyOf(r) === key);
    if (opts?.expectAbsent && idx >= 0) {
      throw new ChannelStoreConflictError("route already exists for this accountId/chatId/threadId");
    }
    const existing = idx >= 0 ? routes[idx] : undefined;
    let persisted: Route;
    if (idx >= 0 && existing) {
      persisted = { ...existing, ...route, updatedAt: now };
      routes[idx] = persisted;
    } else {
      persisted = {
        enabled: true,
        outboundEnabled: true,
        createdAt: now,
        updatedAt: now,
        ...route,
      };
      routes.push(persisted);
    }
    writeRoutesFile(channelId, routes, extras);
    return persisted;
  });
}

export async function deleteRoute(
  channelId: string,
  key: { accountId?: string | null; chatId: string; threadId?: string | null },
): Promise<boolean> {
  return withChannelLock(channelId, () => {
    const { routes, extras } = readRoutesForWrite(channelId);
    const target = routeKey(key.accountId, key.chatId, key.threadId);
    const next = routes.filter((r) => routeKeyOf(r) !== target);
    if (next.length === routes.length) return false;
    writeRoutesFile(channelId, next, extras);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────
// Secrets — redaction sentinel + log scrubber registry
// ──────────────────────────────────────────────────────────────────────

/**
 * SUBSTRING match on the key, deliberately not anchored: production
 * config already has keys like `tokenFallback` and common variants like
 * `authToken` that an anchored alternation would leak verbatim through
 * GET /accounts and skip in the log scrubber.
 */
export const SECRET_KEY_RE = /token|secret|passw|api[_-]?key|credential|auth|signing[_-]?key/i;

const SECRET_SENTINEL_KEY = "__secret_set";

function isSecretSentinel(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[SECRET_SENTINEL_KEY] === true
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replace every SECRET_KEY_RE-matching key's value with the
 * `{ __secret_set: true }` sentinel. Recurses one level into nested plain
 * objects. The raw value is never serialized to a REST response.
 */
export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = value === undefined || value === null ? value : { [SECRET_SENTINEL_KEY]: true };
    } else if (isPlainObject(value)) {
      const nested: Record<string, unknown> = {};
      for (const [nk, nv] of Object.entries(value)) {
        nested[nk] = SECRET_KEY_RE.test(nk) && nv !== undefined && nv !== null
          ? { [SECRET_SENTINEL_KEY]: true }
          : nv;
      }
      out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Merge an incoming (possibly redacted-round-tripped) config over the
 * existing one. Per key: sentinel ⇒ keep existing value; `null` ⇒ delete;
 * anything else ⇒ replace. Recurses one level to mirror redactConfig.
 */
export function mergeConfigPreservingSecrets(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    if (isSecretSentinel(value)) continue; // keep existing
    if (isPlainObject(value) && isPlainObject(out[key])) {
      const base = out[key] as Record<string, unknown>;
      const nested: Record<string, unknown> = { ...base };
      for (const [nk, nv] of Object.entries(value)) {
        if (nv === null) {
          delete nested[nk];
        } else if (!isSecretSentinel(nv)) {
          nested[nk] = nv;
        }
      }
      out[key] = nested;
      continue;
    }
    out[key] = value;
  }
  return out;
}

// Global registry of known secret VALUES, fed by account loads and REST
// mutations; consumed by scrubSecrets (adapter logs, lastError text).
const registeredSecretValues = new Set<string>();

function collectSecretValues(config: Record<string, unknown>, into: Set<string>): void {
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEY_RE.test(key) && typeof value === "string" && value.length >= 4) {
      into.add(value);
    } else if (isPlainObject(value)) {
      for (const [nk, nv] of Object.entries(value)) {
        if (SECRET_KEY_RE.test(nk) && typeof nv === "string" && nv.length >= 4) {
          into.add(nv);
        }
      }
    }
  }
}

/** Feed the log scrubber with every secret value in one account's config. */
export function registerSecretValues(
  _channelId: string,
  _accountId: string,
  config: Record<string, unknown> | null | undefined,
): void {
  if (!config) return;
  collectSecretValues(config, registeredSecretValues);
}

/** Replace every registered secret value occurring in `text` with "***". */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const secret of registeredSecretValues) {
    if (out.includes(secret)) out = out.split(secret).join("***");
  }
  return out;
}
