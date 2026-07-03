/**
 * Generic channel host (bead letta-mobile-9o50g).
 *
 * Discovers `~/.letta/channels/<id>/channel.json`, constructs one adapter
 * per enabled account via the plugin's `createAdapter(account, host)`, and
 * supervises it: crash detection, exponential backoff, health polling, and
 * inbound routing through the SAME `bridgeSendMessage` capability the
 * mobile WS host uses — one agent pool, one bridge.
 *
 * Mobile carve-out: channelId "mobile" is discovered and listed but its
 * handle is a read-only proxy over the `getMobileChannelAdapter` singleton
 * — the registry never constructs, starts, stops, or restarts mobile. That
 * is what guarantees zero mobile behavior change.
 *
 * Crash isolation: every host→plugin call and plugin→host callback is
 * wrapped; additionally the registry installs process-level
 * `unhandledRejection`/`uncaughtException` handlers, because wrapped
 * awaits cannot cover floating promises a plugin never hands back (e.g. a
 * `setTimeout(async () => …)`) or synchronous throws in plugin-owned event
 * callbacks — with no handler installed anywhere in the shim, Node's
 * default (process exit) would let one bad plugin kill the WS host and
 * mobile with it. The handlers are only installed while the registry runs,
 * so SHIM_CHANNELS_ENABLED=0 restores today's behavior exactly.
 *
 * Lifecycle state machine (see the channel-host design §3):
 *
 *   idle -> starting -> running -> stopping -> stopped
 *              |           |
 *              v           v  (start() throw, isRunning()=false poll, dispatch fatal)
 *            backoff <- crashed
 *              |
 *              v (timer fires)               disabled (account enabled:false)
 *            starting
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { channelDir, channelsRoot } from "./channel-paths.js";
import {
  discoverChannels,
  listAccounts,
  registerSecretValues,
  resolveRoute,
  scrubSecrets,
  type ChannelAccount,
  type ChannelManifest,
} from "./channel-config.js";
import { buildChannelHost, makeAdapterLog, type AdapterLog } from "./channel-host-capabilities.js";
import { bridgeSendMessage, peekMobileChannelAdapter } from "./mobile-channel-host.js";
import type { ChannelAdapter } from "./types/channel-plugin.js";

// ──────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────

export type AdapterState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"
  | "backoff"
  | "disabled";

export interface AdapterHandle {
  channelId: string;
  accountId: string;
  state: AdapterState;
  adapter: ChannelAdapter | null;
  /** false only for the mobile carve-out proxy (WS-host managed). */
  managed: boolean;
  enabled: boolean;
  restarts: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastSyncAt: string | null;
  nextRetryAt: string | null;
  /** Human-readable qualifier (mobile proxy states). */
  note: string | null;
  /** Recent (scrubbed) adapter log lines, oldest first. */
  recentLog: () => string[];
}

/** Control-flow error the REST layer maps to an HTTP status (§2.5). */
export class ChannelControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ChannelControlError";
  }
}

export interface ChannelRegistryOptions {
  log: { log(msg: string): void };
  getServerId: () => string;
}

// ──────────────────────────────────────────────────────────────────────
// Tunables
// ──────────────────────────────────────────────────────────────────────

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000] as const;
const RUNNING_RESET_MS = 5 * 60_000; // restarts counter resets after 5 min continuously running
const STALE_INBOUND_MS = 10 * 60_000; // host-side backstop for sync-token backlog replay
const SYNC_STALL_MS = 5 * 60_000; // state-file mtime staleness treated as a stalled sync loop
const PLUGIN_CALL_ERROR_WINDOW_MS = 60_000; // 2 outbound/lifecycle failures in this window ⇒ crash
const STOP_TIMEOUT_REST_MS = 10_000;
const STOP_TIMEOUT_SHUTDOWN_MS = 1_500;
const SHUTDOWN_OVERALL_CAP_MS = 2_000; // must fit inside gracefulShutdown's 4s force-exit
const ZOMBIE_GIVEUP_MS = 60_000; // REST start/restart past this while old stop() unsettled ⇒ 409

function healthPollMs(): number {
  const raw = process.env["SHIM_CHANNEL_HEALTH_POLL_MS"];
  if (!raw) return 30_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function errMsg(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : String(err));
}

// ──────────────────────────────────────────────────────────────────────
// Plugin module shape (duck-typed, same boundary as mobile-channel-host)
// ──────────────────────────────────────────────────────────────────────

interface PluginModule {
  channelPlugin?: unknown;
  default?: unknown;
}

interface PluginExport {
  createAdapter: (
    account: ChannelAccount,
    host: unknown,
  ) => Promise<ChannelAdapter> | ChannelAdapter;
}

// ──────────────────────────────────────────────────────────────────────
// Registry state
// ──────────────────────────────────────────────────────────────────────

let registryOpts: ChannelRegistryOptions | null = null;
let registryStopping = false;
const supervisors = new Map<string, Supervisor>();
let healthTimer: NodeJS.Timeout | null = null;
let onUnhandledRejection: ((reason: unknown) => void) | null = null;
let onUncaughtException: ((err: Error) => void) | null = null;

function supKey(channelId: string, accountId: string): string {
  return `${channelId}:${accountId}`;
}

function registryLog(msg: string): void {
  registryOpts?.log.log(scrubSecrets(msg));
}

// ──────────────────────────────────────────────────────────────────────
// Supervisor — one per (channelId, accountId)
// ──────────────────────────────────────────────────────────────────────

class Supervisor {
  readonly channelId: string;
  readonly accountId: string;
  manifest: ChannelManifest;
  account: ChannelAccount;
  readonly managed: boolean;
  readonly adapterLog: AdapterLog;
  readonly handle: AdapterHandle;

  /** Serializes state transitions — one in flight at a time (§3). */
  private chain: Promise<void> = Promise.resolve();
  private backoffTimer: NodeJS.Timeout | null = null;
  private runningResetTimer: NodeJS.Timeout | null = null;
  /** Old instance whose stop() timed out but has not settled yet. */
  private zombieStop: { promise: Promise<void>; since: number } | null = null;
  /** Operator stop (REST/shutdown): supervision must NOT auto-restart. */
  private stopRequested = false;
  /** Bumped on every start/stop so a stale instance's inbound is inert. */
  private instanceSeq = 0;
  private pluginCallErrorTimes: number[] = [];
  private staleSyncPolls = 0;

  constructor(manifest: ChannelManifest, account: ChannelAccount, accountId: string) {
    this.channelId = manifest.id;
    this.accountId = accountId;
    this.manifest = manifest;
    this.account = account;
    this.managed = manifest.id !== "mobile";
    this.adapterLog = makeAdapterLog(this.channelId, accountId);
    this.handle = {
      channelId: this.channelId,
      accountId,
      state: "idle",
      adapter: null,
      managed: this.managed,
      enabled: account.enabled !== false,
      restarts: 0,
      lastError: null,
      lastErrorAt: null,
      lastStartedAt: null,
      lastStoppedAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastSyncAt: null,
      nextRetryAt: null,
      note: null,
      recentLog: () => this.adapterLog.ring(),
    };
  }

  setAccount(manifest: ChannelManifest, account: ChannelAccount): void {
    this.manifest = manifest;
    this.account = account;
    this.handle.enabled = account.enabled !== false;
  }

  clearStopRequested(): void {
    this.stopRequested = false;
  }

  private setState(next: AdapterState, detail = ""): void {
    const prev = this.handle.state;
    this.handle.state = next;
    if (prev !== next) {
      registryLog(`[channel-registry] ${this.channelId}:${this.accountId} ${prev} -> ${next}${detail}`);
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private clearTimers(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    if (this.runningResetTimer) {
      clearTimeout(this.runningResetTimer);
      this.runningResetTimer = null;
    }
    this.handle.nextRetryAt = null;
  }

  // ── start ──────────────────────────────────────────────────────────

  /** kind: "boot"|"backoff" swallow failures into crash/backoff; "rest" also rethrows. */
  start(kind: "boot" | "backoff" | "rest"): Promise<void> {
    return this.enqueue(() => this.doStart(kind));
  }

  private async doStart(kind: "boot" | "backoff" | "rest"): Promise<void> {
    if (registryStopping) return;
    if (this.handle.state === "running" || this.handle.state === "starting") return;
    if (this.stopRequested && kind === "backoff") return; // operator stop wins over a queued retry

    // Zombie gate (§3 "stopping"): never spawn a second live instance while
    // the previous stop() is unsettled — it would double-consume the
    // channel's inbound and emit duplicate agent turns/replies.
    if (this.zombieStop) {
      if (kind === "rest" && Date.now() - this.zombieStop.since > ZOMBIE_GIVEUP_MS) {
        throw new ChannelControlError(
          "previous adapter instance still stopping; restart the shim to force",
          409,
        );
      }
      await this.zombieStop.promise;
      this.zombieStop = null;
    }

    this.clearTimers();
    this.setState("starting");
    try {
      const entry = typeof this.manifest.entry === "string" && this.manifest.entry.length > 0
        ? this.manifest.entry
        : "plugin.mjs";
      const pluginPath = join(channelDir(this.channelId), entry);
      if (!existsSync(pluginPath)) {
        throw new Error(`plugin not found at ${pluginPath}`);
      }
      // Same duck-typing as mobile-channel-host: import as unknown, narrow
      // on createAdapter (`channelPlugin ?? default`).
      const module = (await import(pathToFileURL(pluginPath).href)) as PluginModule;
      const pluginRaw: unknown = module.channelPlugin ?? module.default;
      const plugin = pluginRaw as PluginExport | null | undefined;
      if (!plugin || typeof plugin.createAdapter !== "function") {
        throw new Error("plugin malformed (no createAdapter)");
      }
      const host = buildChannelHost({
        log: this.adapterLog,
        getServerId: () => registryOpts?.getServerId() ?? "unknown",
      });
      const adapter = await plugin.createAdapter(this.account, host);
      // Host fills the inbound hook (contract: the host owns this slot).
      const instance = ++this.instanceSeq;
      adapter.onMessage = (inbound: unknown) => this.handleInbound(instance, inbound);
      this.handle.adapter = adapter;
      await adapter.start?.();
      this.handle.lastStartedAt = nowIso();
      this.staleSyncPolls = 0;
      this.pluginCallErrorTimes = [];
      this.setState("running", ` (restarts=${this.handle.restarts})`);
      // Reset the restart counter only after sustained health — a
      // restart-looping adapter must not keep reporting restarts=0.
      this.runningResetTimer = setTimeout(() => {
        if (this.handle.state === "running") this.handle.restarts = 0;
      }, RUNNING_RESET_MS);
      this.runningResetTimer.unref?.();
    } catch (err) {
      this.recordCrash(err, "start failed");
      if (kind === "rest") {
        if (err instanceof ChannelControlError) throw err;
        throw new ChannelControlError(`start failed: ${errMsg(err)}`, 502);
      }
    }
  }

  // ── crash + backoff ────────────────────────────────────────────────

  /** Synchronous state flip; callers already hold the transition chain or accept the race via the state gate. */
  private recordCrash(err: unknown, context: string): void {
    const msg = errMsg(err);
    this.handle.lastError = `${context}: ${msg}`;
    this.handle.lastErrorAt = nowIso();
    // Sever the inbound hook immediately: a half-dead instance must never
    // bridge another turn.
    this.instanceSeq += 1;
    const adapter = this.handle.adapter;
    if (adapter) {
      try {
        adapter.onMessage = () => {};
      } catch {}
      // Best-effort teardown of the broken instance; failures are expected.
      try {
        void Promise.resolve(adapter.stop?.()).catch(() => {});
      } catch {}
    }
    this.handle.adapter = null;
    if (this.runningResetTimer) {
      clearTimeout(this.runningResetTimer);
      this.runningResetTimer = null;
    }
    this.setState("crashed", `: ${this.handle.lastError}`);
    if (registryStopping || this.stopRequested) {
      this.setState("stopped");
      return;
    }
    this.scheduleBackoff();
  }

  private scheduleBackoff(): void {
    const delay = BACKOFF_MS[Math.min(this.handle.restarts, BACKOFF_MS.length - 1)] ?? 60_000;
    this.handle.nextRetryAt = new Date(Date.now() + delay).toISOString();
    this.setState("backoff", ` (retry in ${delay}ms)`);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.handle.nextRetryAt = null;
      this.handle.restarts += 1;
      void this.start("backoff").catch(() => {});
    }, delay);
    this.backoffTimer.unref?.();
  }

  /** Crash reported from outside the chain (health poll, process trap). */
  crashFromOutside(reason: string): void {
    void this.enqueue(async () => {
      if (this.handle.state !== "running" && this.handle.state !== "starting") return;
      this.recordCrash(new Error(reason), "supervision");
    });
  }

  recordPluginCallError(what: string, err: unknown): void {
    const msg = errMsg(err);
    this.handle.lastError = `${what} failed: ${msg}`;
    this.handle.lastErrorAt = nowIso();
    this.adapterLog.log(`${what} failed: ${msg}`);
    const now = Date.now();
    this.pluginCallErrorTimes = this.pluginCallErrorTimes.filter(
      (t) => now - t < PLUGIN_CALL_ERROR_WINDOW_MS,
    );
    this.pluginCallErrorTimes.push(now);
    // A single outbound failure is usually transient (matrix send hiccups);
    // two inside the window means the instance is broken.
    if (this.pluginCallErrorTimes.length >= 2) {
      this.pluginCallErrorTimes = [];
      this.crashFromOutside(`repeated ${what} failures: ${msg}`);
    }
  }

  // ── stop ───────────────────────────────────────────────────────────

  requestStop(timeoutMs: number, { operator }: { operator: boolean }): Promise<void> {
    return this.enqueue(() => this.doStop(timeoutMs, operator));
  }

  private async doStop(timeoutMs: number, operator: boolean): Promise<void> {
    if (operator) this.stopRequested = true;
    this.clearTimers();
    const adapter = this.handle.adapter;
    if (!adapter) {
      // Nothing live — halt supervision (covers crashed/backoff/idle).
      if (this.handle.state !== "disabled") this.setState("stopped");
      return;
    }
    // Sever the inbound hook FIRST (the host owns that slot) so a slow or
    // stuck stop() can never bridge another turn; the instanceSeq bump also
    // kills any in-flight handleInbound at its state gate.
    this.instanceSeq += 1;
    try {
      adapter.onMessage = () => {};
    } catch {}
    this.setState("stopping");
    const stopPromise: Promise<void> = Promise.resolve()
      .then(() => adapter.stop?.())
      .then(
        () => undefined,
        (err: unknown) => {
          this.adapterLog.log(`stop() failed: ${errMsg(err)}`);
        },
      );
    const timedOut = await Promise.race([
      stopPromise.then(() => false),
      sleep(timeoutMs).then(() => true),
    ]);
    if (timedOut) {
      // The handle reports stopped but the old instance is a tracked
      // zombie: start/restart defers until its stop() settles (§3).
      const zombie = { promise: stopPromise, since: Date.now() };
      this.zombieStop = zombie;
      void stopPromise.then(() => {
        if (this.zombieStop === zombie) this.zombieStop = null;
      });
      this.adapterLog.log(`stop() exceeded ${timeoutMs}ms; old instance tracked as zombie`);
    }
    this.handle.adapter = null;
    this.handle.lastStoppedAt = nowIso();
    this.setState("stopped");
  }

  // ── inbound routing dispatcher (§1.5 handleInbound) ────────────────

  private async handleInbound(instance: number, inboundRaw: unknown): Promise<void> {
    const inbound = (inboundRaw && typeof inboundRaw === "object" ? inboundRaw : {}) as Record<string, unknown>;
    // The matrix plugin already maps `chatId: roomId`; `roomId` is kept as a
    // defensive fallback for other plugins.
    const chatId =
      typeof inbound["chatId"] === "string" && inbound["chatId"].length > 0
        ? inbound["chatId"]
        : typeof inbound["roomId"] === "string" && inbound["roomId"].length > 0
          ? inbound["roomId"]
          : null;
    try {
      // State gate: a stuck old instance must never bridge turns after a
      // REST stop/restart.
      if (this.handle.state !== "running" || instance !== this.instanceSeq) {
        registryLog(
          `[channel-registry] ${this.channelId}:${this.accountId} dropping inbound (state=${this.handle.state})`,
        );
        return;
      }
      this.handle.lastInboundAt = nowIso();
      if (!chatId) {
        this.adapterLog.log("inbound missing chatId; dropped");
        return;
      }
      const threadId = typeof inbound["threadId"] === "string" ? inbound["threadId"] : null;
      const accountId =
        typeof inbound["accountId"] === "string" && inbound["accountId"].length > 0
          ? inbound["accountId"]
          : this.accountId;

      // Stale-inbound guard: host-side backstop for sync-token backlog
      // replay (the matrix plugin's own age guard is inert whenever a saved
      // sync token exists).
      const tsMs = inboundTimestampMs(inbound);
      if (tsMs !== null && Date.now() - tsMs > STALE_INBOUND_MS) {
        registryLog(
          `[channel-registry] ${this.channelId}:${this.accountId} stale inbound ${chatId} (ts=${new Date(tsMs).toISOString()}); dropped`,
        );
        return;
      }

      const route = resolveRoute(this.channelId, accountId, chatId, threadId);
      if (!route) {
        registryLog(`[channel-registry] unrouted inbound ${this.channelId}:${chatId}`);
        return;
      }

      this.safeLifecycle("queued", chatId);
      const text = typeof inbound["text"] === "string" ? inbound["text"] : "";
      const contentParts = buildContentParts(text, inbound);
      let replyText = "";
      let processingFired = false;
      await bridgeSendMessage(
        {
          agent_id: route.agentId,
          conversation_id: route.conversationId,
          text,
          ...(contentParts ? { content_parts: contentParts } : {}),
        },
        (frame) => {
          if (!processingFired) {
            processingFired = true;
            this.safeLifecycle("processing", chatId);
          }
          const mt = (frame as { message_type?: unknown }).message_type;
          if (mt === "assistant_message") replyText += frameText(frame);
        },
      );

      // v1 = one reply at end of turn; per-frame streaming to channels is a
      // non-goal. Distinct routes ⇒ distinct conversation ⇒ distinct run, so
      // no two adapters ever drive the same run.
      if (
        route.outboundEnabled !== false &&
        replyText.length > 0 &&
        instance === this.instanceSeq &&
        this.handle.adapter
      ) {
        try {
          await this.handle.adapter.sendMessage?.({
            chatId,
            text: replyText,
            replyToMessageId: inbound["messageId"] ?? null,
            threadId,
          });
          this.handle.lastOutboundAt = nowIso();
        } catch (err) {
          this.recordPluginCallError("sendMessage", err);
        }
      }
    } catch (err) {
      const msg = errMsg(err);
      this.handle.lastError = `inbound dispatch failed: ${msg}`;
      this.handle.lastErrorAt = nowIso();
      this.adapterLog.log(`inbound dispatch failed: ${msg}`);
    } finally {
      // Mandatory on EVERY exit (including drops): matrix starts a typing
      // heartbeat before onMessage and only a `finished` lifecycle event
      // (or a send to the room) releases it.
      this.safeLifecycle("finished", chatId);
    }
  }

  /** Lifecycle events matching the undocumented shape matrix consumes. */
  private safeLifecycle(type: string, chatId: string | null): void {
    const adapter = this.handle.adapter;
    if (!adapter || typeof adapter.handleTurnLifecycleEvent !== "function") return;
    try {
      const result = adapter.handleTurnLifecycleEvent({
        type,
        sources: [{ chatId }],
        source: { chatId },
      });
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch((err: unknown) => {
          this.recordPluginCallError("handleTurnLifecycleEvent", err);
        });
      }
    } catch (err) {
      this.recordPluginCallError("handleTurnLifecycleEvent", err);
    }
  }

  // ── health poll ────────────────────────────────────────────────────

  healthCheck(): void {
    if (!this.managed || this.handle.state !== "running") return;
    const adapter = this.handle.adapter;
    let crashReason: string | null = null;
    try {
      if (adapter && typeof adapter.isRunning === "function" && !adapter.isRunning()) {
        crashReason = "health check: isRunning() returned false";
      }
    } catch (err) {
      crashReason = `health check: isRunning() threw: ${errMsg(err)}`;
    }
    // isRunning() alone is not a health signal for matrix (its flag stays
    // true while the sync loop error-retries forever) — also stat the
    // plugin's per-account state file, rewritten after every successful
    // sync, and treat a stale mtime on two consecutive polls as a crash.
    const statePath = join(channelDir(this.channelId), "state", `${this.accountId}.json`);
    try {
      if (existsSync(statePath)) {
        const mtimeMs = statSync(statePath).mtimeMs;
        this.handle.lastSyncAt = new Date(mtimeMs).toISOString();
        if (Date.now() - mtimeMs > SYNC_STALL_MS) {
          this.staleSyncPolls += 1;
          if (!crashReason && this.staleSyncPolls >= 2) {
            crashReason = `sync stalled (last success ${this.handle.lastSyncAt})`;
          }
        } else {
          this.staleSyncPolls = 0;
        }
      } else if (!crashReason) {
        // Channels without a state file: best-effort liveness stamp.
        this.handle.lastSyncAt = nowIso();
      }
    } catch {}
    if (crashReason) this.crashFromOutside(crashReason);
  }

  // ── mobile carve-out proxy refresh ─────────────────────────────────

  refreshMobileProxy(): void {
    if (this.managed) return;
    if (this.account.enabled === false) {
      this.handle.state = "disabled";
      this.handle.note = "no enabled mobile account";
      return;
    }
    const peek = peekMobileChannelAdapter();
    switch (peek.phase) {
      case "unstarted":
      case "starting":
        this.handle.state = "idle";
        this.handle.note = "starts on first WS connection";
        this.handle.adapter = null;
        break;
      case "disabled":
        this.handle.state = "disabled";
        this.handle.note = "no enabled mobile account";
        this.handle.adapter = null;
        break;
      case "running":
        this.handle.state = "running";
        this.handle.note = null;
        this.handle.adapter = peek.adapter as unknown as ChannelAdapter;
        break;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Inbound payload helpers
// ──────────────────────────────────────────────────────────────────────

function inboundTimestampMs(inbound: Record<string, unknown>): number | null {
  const raw =
    inbound["timestamp"] ?? inbound["origin_server_ts"] ?? inbound["originServerTs"] ?? inbound["ts"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Extract assistant text from a reshaped frame (string or parts array). */
function frameText(frame: unknown): string {
  const content = (frame as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p: unknown): p is { type: "text"; text?: string } =>
          typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text",
      )
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

/**
 * Map channel media records (matrix attachments with `imageDataBase64`) to
 * Anthropic-style content parts, the same shape mobile builds. Returns
 * null when there is nothing beyond plain text.
 */
function buildContentParts(text: string, inbound: Record<string, unknown>): unknown[] | null {
  const attachments = inbound["attachments"];
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  const parts: unknown[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const att of attachments) {
    if (typeof att !== "object" || att === null) continue;
    const rec = att as Record<string, unknown>;
    const data = typeof rec["imageDataBase64"] === "string" ? rec["imageDataBase64"] : null;
    if (!data) continue;
    const mediaType =
      (typeof rec["media_type"] === "string" && rec["media_type"]) ||
      (typeof rec["mimeType"] === "string" && rec["mimeType"]) ||
      "image/png";
    parts.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }
  return parts.length > (text.length > 0 ? 1 : 0) ? parts : null;
}

// ──────────────────────────────────────────────────────────────────────
// Process-level trap (§1.5) — required for the crash-isolation guarantee
// ──────────────────────────────────────────────────────────────────────

function handleProcessLevelFailure(kind: string, reason: unknown): void {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const msg = scrubSecrets(err.message || String(reason));
  const stack = scrubSecrets(err.stack ?? "");
  const root = channelsRoot();
  let attributed: Supervisor | null = null;
  for (const sup of supervisors.values()) {
    if (!sup.managed) continue;
    if (stack.includes(join(root, sup.channelId))) {
      attributed = sup;
      break;
    }
  }
  if (attributed) {
    registryLog(
      `[channel-registry] ${kind} attributed to ${attributed.channelId}:${attributed.accountId}: ${msg}`,
    );
    attributed.crashFromOutside(`${kind}: ${msg}`);
  } else {
    // Continuing after an uncaughtException is against Node's general
    // advice; accepted deliberately — once plugins run in-process, "one bad
    // plugin must not end mobile" outranks purist process hygiene.
    registryLog(`[channel-registry] unattributed ${kind}: ${msg}`);
  }
}

function installProcessTraps(): void {
  if (onUnhandledRejection || onUncaughtException) return;
  onUnhandledRejection = (reason: unknown) => handleProcessLevelFailure("unhandledRejection", reason);
  onUncaughtException = (err: Error) => handleProcessLevelFailure("uncaughtException", err);
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
}

function removeProcessTraps(): void {
  if (onUnhandledRejection) {
    process.off("unhandledRejection", onUnhandledRejection);
    onUnhandledRejection = null;
  }
  if (onUncaughtException) {
    process.off("uncaughtException", onUncaughtException);
    onUncaughtException = null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Registry lifecycle
// ──────────────────────────────────────────────────────────────────────

export function startChannelRegistry(opts: ChannelRegistryOptions): void {
  if (registryOpts) return;
  registryOpts = opts;
  registryStopping = false;
  installProcessTraps();

  let started = 0;
  for (const manifest of discoverChannels()) {
    for (const account of listAccounts(manifest.id)) {
      const accountId =
        typeof account.accountId === "string" && account.accountId.length > 0
          ? account.accountId
          : null;
      if (!accountId) {
        registryLog(`[channel-registry] ${manifest.id}: skipping account without accountId`);
        continue;
      }
      registerSecretValues(manifest.id, accountId, account.config ?? null);
      const sup = new Supervisor(manifest, account, accountId);
      supervisors.set(supKey(manifest.id, accountId), sup);
      if (!sup.managed) {
        // Mobile carve-out: listed, never constructed/started by the registry.
        sup.refreshMobileProxy();
        continue;
      }
      if (account.enabled === false) {
        sup.handle.state = "disabled";
        continue;
      }
      started += 1;
      void sup.start("boot").catch(() => {}); // failure already recorded as crash/backoff
    }
  }

  healthTimer = setInterval(() => {
    for (const sup of supervisors.values()) sup.healthCheck();
  }, healthPollMs());
  healthTimer.unref?.();

  // Count = adapters the registry STARTS (mobile is listed, never started).
  registryLog(`[channel-registry] started (${started} adapters)`);
}

/**
 * Graceful stop. Overall cap 2s (per-adapter stop race 1.5s, all adapters
 * concurrently) — must fit inside gracefulShutdown's 4s force-exit with
 * room left for pool workers, the mobile adapter, and WS clients.
 */
export async function stopChannelRegistry(): Promise<void> {
  if (!registryOpts) return;
  registryStopping = true;
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  const stops = [...supervisors.values()]
    .filter((sup) => sup.managed)
    .map((sup) => sup.requestStop(STOP_TIMEOUT_SHUTDOWN_MS, { operator: true }).catch(() => {}));
  await Promise.race([Promise.allSettled(stops), sleep(SHUTDOWN_OVERALL_CAP_MS)]);
  removeProcessTraps();
  supervisors.clear();
  registryOpts = null;
}

// ──────────────────────────────────────────────────────────────────────
// Introspection + REST control surface (consumed by server.ts §1.6)
// ──────────────────────────────────────────────────────────────────────

export function listAdapterHandles(): AdapterHandle[] {
  const out: AdapterHandle[] = [];
  for (const sup of supervisors.values()) {
    sup.refreshMobileProxy();
    out.push(sup.handle);
  }
  return out;
}

export function getAdapterHandle(channelId: string, accountId: string): AdapterHandle | null {
  const sup = supervisors.get(supKey(channelId, accountId));
  if (!sup) return null;
  sup.refreshMobileProxy();
  return sup.handle;
}

function requireSupervisor(channelId: string, accountId: string): Supervisor {
  const sup = supervisors.get(supKey(channelId, accountId));
  if (!sup) {
    throw new ChannelControlError(`unknown adapter ${channelId}:${accountId}`, 404);
  }
  return sup;
}

function assertManaged(sup: Supervisor): void {
  if (!sup.managed) {
    throw new ChannelControlError("mobile adapter is managed by the WS host", 409);
  }
}

export async function startAdapter(channelId: string, accountId: string): Promise<AdapterHandle> {
  const sup = requireSupervisor(channelId, accountId);
  assertManaged(sup);
  if (sup.handle.state === "running") return sup.handle; // no-op
  sup.clearStopRequested();
  await sup.start("rest");
  return sup.handle;
}

export async function stopAdapter(channelId: string, accountId: string): Promise<AdapterHandle> {
  const sup = requireSupervisor(channelId, accountId);
  assertManaged(sup);
  await sup.requestStop(STOP_TIMEOUT_REST_MS, { operator: true });
  return sup.handle;
}

export async function restartAdapter(channelId: string, accountId: string): Promise<AdapterHandle> {
  const sup = requireSupervisor(channelId, accountId);
  assertManaged(sup);
  await sup.requestStop(STOP_TIMEOUT_REST_MS, { operator: true });
  sup.clearStopRequested();
  await sup.start("rest");
  return sup.handle;
}

/** Key-order-independent stringify: the create path persists `{channel,
 * ...account}` while the patch path persists `{...existing, ...rest}`, and a
 * pure key-order difference must not read as a change. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Restart-relevant account fingerprint (§2.3: restart on CONFIG change).
 * `displayName` is cosmetic — the plugins never render it — and a
 * displayName-only PATCH must not bounce a running adapter mid-turn (the
 * instanceSeq outbound gate would silently eat the in-flight reply).
 */
function accountRestartFingerprint(account: ChannelAccount): string {
  const { displayName: _cosmetic, ...rest } = account;
  return stableStringify(rest);
}

/**
 * Re-diff one channel's handles against accounts.json after a REST account
 * mutation: new enabled account ⇒ create+start; enabled:false or delete ⇒
 * stop+remove/disable; account change on a running adapter ⇒ restart.
 * Mobile is persisted-only (WS host reloads on shim restart) — no-op here.
 */
export async function reloadChannelAccounts(channelId: string): Promise<void> {
  if (!registryOpts || registryStopping || channelId === "mobile") return;
  const manifest = discoverChannels().find((m) => m.id === channelId);
  if (!manifest) return;
  const accounts = listAccounts(channelId);
  const seen = new Set<string>();
  for (const account of accounts) {
    const accountId =
      typeof account.accountId === "string" && account.accountId.length > 0
        ? account.accountId
        : null;
    if (!accountId) continue;
    seen.add(accountId);
    registerSecretValues(channelId, accountId, account.config ?? null);
    const key = supKey(channelId, accountId);
    let sup = supervisors.get(key);
    if (!sup) {
      sup = new Supervisor(manifest, account, accountId);
      supervisors.set(key, sup);
      if (account.enabled !== false) {
        await sup.start("boot").catch(() => {});
      } else {
        sup.handle.state = "disabled";
      }
      continue;
    }
    const changed = accountRestartFingerprint(sup.account) !== accountRestartFingerprint(account);
    sup.setAccount(manifest, account);
    if (account.enabled === false) {
      if (sup.handle.state !== "disabled") {
        await sup.requestStop(STOP_TIMEOUT_REST_MS, { operator: true }).catch(() => {});
        sup.handle.state = "disabled";
      }
      continue;
    }
    if (sup.handle.state === "disabled" || sup.handle.state === "stopped") {
      sup.clearStopRequested();
      await sup.start("boot").catch(() => {});
    } else if (changed) {
      await sup.requestStop(STOP_TIMEOUT_REST_MS, { operator: true }).catch(() => {});
      sup.clearStopRequested();
      await sup.start("boot").catch(() => {});
    }
  }
  for (const [key, sup] of [...supervisors.entries()]) {
    if (sup.channelId !== channelId || seen.has(sup.accountId)) continue;
    await sup.requestStop(STOP_TIMEOUT_REST_MS, { operator: true }).catch(() => {});
    supervisors.delete(key);
  }
}
