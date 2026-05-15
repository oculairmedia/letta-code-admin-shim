/**
 * Glue between the shim and the mobile channel plugin.
 *
 * Responsibilities:
 *  - Load the channel plugin at ~/.letta/channels/mobile/plugin.mjs.
 *  - Read its accounts.json, pick the first enabled account.
 *  - Wire up a `host` object that bridges plugin → shim's agent pool +
 *    server identity.
 *  - Expose `getAdapter()` so the WS upgrade route can hand off accepted
 *    sockets via `adapter.acceptConnection(ws, request)`.
 *
 * The plugin itself stays directory-shaped and inspectable. This file is
 * the only place the shim binds to it.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage } from "node:http";

import { reshapeFrame } from "./chat.js";
import { cancelRun, getAgentPool } from "./agent-pool.js";
import {
  findUnmappedTailUserMessageId,
  resolveConversationId,
  writeOtidForLocalId,
} from "./store.js";
import type { LettaMessage } from "./types/wire.js";
import type {
  BridgeSendMessageArgs as PublicBridgeSendMessageArgs,
  BridgeSendMessageHooks as PublicBridgeSendMessageHooks,
  ChannelAccount as PublicChannelAccount,
  ChannelAdapter as PublicChannelAdapter,
  ChannelHost as PublicChannelHost,
  ChannelPlugin as PublicChannelPlugin,
  HostLogger as PublicHostLogger,
} from "./types/channel-plugin.js";

// Re-export the public, channel-agnostic types so external callers can pick
// them up from this module too. The runtime shape below is unchanged — the
// host continues to load plugins as `unknown` and duck-type-narrow on
// `createAdapter` (Hard Rule #3).
export type {
  PublicBridgeSendMessageArgs as ChannelBridgeSendMessageArgs,
  PublicBridgeSendMessageHooks as ChannelBridgeSendMessageHooks,
  PublicChannelAccount,
  PublicChannelAdapter,
  PublicChannelHost,
  PublicChannelPlugin,
  PublicHostLogger,
};

function channelDir(): string {
  const root = process.env["LETTA_HOME"] || join(homedir(), ".letta");
  return join(root, "channels", "mobile");
}

/**
 * Account record shape we read out of accounts.json. The file is
 * user-edited and field-permissive; we only narrow the keys this module
 * actually touches and pass the whole object through to the plugin.
 */
interface MobileAccount {
  accountId?: string;
  channel?: string;
  enabled?: boolean;
  displayName?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

interface AccountsFile {
  accounts?: unknown;
}

function loadAccount(): MobileAccount | null {
  const path = join(channelDir(), "accounts.json");
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8")) as AccountsFile;
  const accounts: MobileAccount[] = Array.isArray(data?.accounts)
    ? (data.accounts as MobileAccount[])
    : [];
  return accounts.find((a) => a.enabled !== false && a.channel === "mobile") ?? null;
}

/**
 * Frame payload the channel-plugin receives via `onFrame`. The reshaper
 * returns a `LettaMessage`; the bridge stamps a `run_id` on each frame
 * before forwarding so mobile can correlate to `/v1/runs/{id}`. The
 * `run_id` field exists on every `LettaMessageBase` variant so the cast
 * below is structurally narrowing only.
 */
type BridgeFrame = LettaMessage;

/** Args to `bridgeSendMessage`. */
interface BridgeSendMessageArgs {
  agent_id: string;
  conversation_id: string;
  text: string;
  otid?: string | null;
}

interface BridgeSendMessageHooks {
  onRunCreated?: (runId: string) => void;
}

/**
 * Builds the bridge that the WS handler calls when a send_message frame
 * arrives. It's the same code path as the REST POST handler, factored
 * out so the channel can reuse it.
 *
 * `onFrame(reshapedFrame)` fires for each vanilla-shaped frame coming
 * out of the worker. The WS handler wraps these into protocol envelopes.
 */
async function bridgeSendMessage(
  { agent_id, conversation_id, text, otid }: BridgeSendMessageArgs,
  onFrame: (frame: BridgeFrame) => void,
  { onRunCreated }: BridgeSendMessageHooks = {},
): Promise<unknown> {
  // Accept both the INTERNAL conv id (real "conv-<uuid>") and the EXTERNAL
  // form mobile uses on the HTTP path ("conv-default-<agentId>"). Mirrors
  // what the SSE handler does via resolveConversationId so a mobile client
  // can use the same conv id over both transports. When the id resolves,
  // the resolved (agentId, conversationId) pair wins over the client's
  // agent_id — the conv on disk is the source of truth for which agent
  // owns it. When it doesn't resolve (fresh agent before its disk record
  // exists, a custom conv letta hasn't persisted yet, or the ambiguous
  // bare literal "default" which the resolver refuses), fall back to
  // the client's pair so the worker pool can still target a fresh conv.
  const resolved = await resolveConversationId(conversation_id);
  const effectiveAgentId = resolved?.agentId ?? agent_id;
  const effectiveConvId = resolved?.conversationId ?? conversation_id;

  const pool = getAgentPool();
  const worker = await pool.get(effectiveConvId, effectiveAgentId);

  // Buffer assistant_message chunks for server-side coalescing so the
  // mobile channel matches vanilla's "one assistant_message per turn"
  // contract — identical to how the REST stream path coalesces.
  // chunkBuffer is an array of content strings joined once at flush
  // time (lcp-86o); the previous `prev.content + new.content` per
  // chunk was O(n^2) in total chunk count for long streams.
  let pendingAssistant: BridgeFrame | null = null;
  let chunkBuffer: string[] | null = null;
  let pendingStop: BridgeFrame | null = null;
  let pendingUsage: BridgeFrame | null = null;

  const flushPendingAssistant = (): void => {
    if (pendingAssistant) {
      if (chunkBuffer && pendingAssistant.message_type === "assistant_message") {
        pendingAssistant.content = chunkBuffer.join("");
      }
      onFrame(pendingAssistant);
      pendingAssistant = null;
      chunkBuffer = null;
    }
  };

  const turn = await worker.runTurn(text, {
    onRunCreated: (runId: string) => {
      if (typeof onRunCreated === "function") {
        try { onRunCreated(runId); } catch {}
      }
    },
    onFrame: (raw, meta) => {
      const reshaped = reshapeFrame(raw);
      if (!reshaped) return;
      // Stamp the run_id on every reshaped frame for mobile-side correlation
      // with /v1/runs/{id}. The pool exposes it via the meta callback arg.
      // Bare-shape variants (StopReasonMessage, UsageStatisticsMessage) do
      // not declare `run_id`, but the .mjs unconditionally added it at
      // runtime; mirror that exactly by writing through a Record cast.
      if (meta?.runId) (reshaped as unknown as Record<string, unknown>)["run_id"] = meta.runId;
      const mt = reshaped.message_type;
      if (mt === "stop_reason") {
        pendingStop = reshaped;
        return;
      }
      if (mt === "usage_statistics") {
        pendingUsage = reshaped;
        return;
      }
      if (mt === "assistant_message") {
        if (
          pendingAssistant &&
          pendingAssistant.message_type === "assistant_message" &&
          pendingAssistant.otid &&
          pendingAssistant.otid === reshaped.otid
        ) {
          // Push into the chunk buffer instead of `content + content`.
          if (!chunkBuffer) chunkBuffer = [pendingAssistant.content ?? ""];
          chunkBuffer.push(reshaped.content ?? "");
          pendingAssistant.id = reshaped.id;
          pendingAssistant.date = reshaped.date;
          pendingAssistant.seq_id = reshaped.seq_id;
          return;
        }
        flushPendingAssistant();
        pendingAssistant = { ...reshaped };
        chunkBuffer = null;
        return;
      }
      flushPendingAssistant();
      onFrame(reshaped);
    },
  });

  // End-of-turn tail in vanilla order: assistant → stop_reason → usage.
  flushPendingAssistant();
  if (pendingStop) onFrame(pendingStop);
  if (pendingUsage) onFrame(pendingUsage);

  // Bind mobile's otid to the user message letta-code persisted — same
  // path the SSE handler runs so the disk projection echoes the otid back
  // for mobile's reconcileAfterSend. Without this, WS-sent turns leave
  // the optimistic Local user bubble next to the Confirmed disk twin.
  if (otid) {
    try {
      // Fast path (lcp-y88): the worker already captured the new user_message
      // id during its post-turn listMessages diff (which it does anyway for
      // run-message attribution). Fall back to a scan only if it didn't
      // surface one — defensive for older worker code paths.
      const localId = (turn as { newUserMessageId?: string | null }).newUserMessageId
        ?? await findUnmappedTailUserMessageId(effectiveConvId, effectiveAgentId);
      if (localId) await writeOtidForLocalId(effectiveConvId, effectiveAgentId, localId, otid);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[mobile-channel] otid bind failed: ${errMsg}`);
    }
  }

  return turn;
}

/**
 * Logger shape `getMobileChannelAdapter` accepts. Matches the subset of
 * `console` the .mjs used (just `log` — `console.error` calls hit the
 * global console directly, not this object).
 */
interface HostLogger {
  log?: (...args: unknown[]) => void;
}

interface GetMobileChannelAdapterOptions {
  getServerId: () => string;
  log?: HostLogger;
}

/**
 * The `host` object the shim hands the channel plugin. Mirrors the
 * informal contract the plugin reads in `acceptConnection` (see
 * home/.letta/channels/mobile/plugin.mjs):
 *  - `log(msg)` — line logger
 *  - `getServerId()` — server identity for the welcome envelope
 *  - `bridgeSendMessage(args, onFrame, hooks)` — turn driver
 *  - `cancelRun(runId)` — cancel hook from the worker pool
 */
interface MobileChannelHost {
  log: (msg: string) => void;
  getServerId: () => string;
  bridgeSendMessage: typeof bridgeSendMessage;
  cancelRun: (runId: string) => boolean;
}

/**
 * Adapter surface returned by the plugin's `createAdapter`. Phase 1 only
 * uses `acceptConnection` + `start` + `stop`; the rest of the surface is
 * the standard letta-code channel adapter shape (kept loosely typed here
 * because the channel-plugin import is the documented type boundary —
 * see the cast site below).
 */
interface MobileChannelAdapter {
  id?: string;
  channelId?: string;
  accountId?: string;
  name?: string;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  isRunning?: () => boolean;
  acceptConnection: (ws: unknown, request: IncomingMessage) => void;
  [key: string]: unknown;
}

/**
 * Expected shape of the channel plugin's runtime-imported module. The
 * `.mjs` file is user-authored and not strictly typed; this interface
 * captures the surface this host actually uses. Channel plugins are
 * user-authored .mjs (Hard Rule #3) and runtime-discovered. Phase 7c
 * later ships .d.ts for plugin authors. Until then, this is the
 * documented type boundary.
 */
interface MobileChannelPluginExport {
  createAdapter: (
    account: MobileAccount,
    host: MobileChannelHost,
  ) => Promise<MobileChannelAdapter> | MobileChannelAdapter;
}

interface MobileChannelPluginModule {
  channelPlugin?: unknown;
  default?: unknown;
}

let cachedAdapter: MobileChannelAdapter | null = null;

/**
 * Load the mobile channel plugin and create the adapter. Memoized.
 * Returns null if the channel isn't configured (no accounts.json or
 * no enabled account).
 */
export async function getMobileChannelAdapter(
  { getServerId, log = console }: GetMobileChannelAdapterOptions,
): Promise<MobileChannelAdapter | null> {
  if (cachedAdapter) return cachedAdapter;
  const account = loadAccount();
  if (!account) {
    log.log?.("[mobile-channel] no enabled account; channel disabled");
    return null;
  }
  const pluginPath = join(channelDir(), "plugin.mjs");
  if (!existsSync(pluginPath)) {
    log.log?.(`[mobile-channel] plugin not found at ${pluginPath}`);
    return null;
  }
  // Channel plugins are user-authored .mjs (Hard Rule #3) and
  // runtime-discovered. Phase 7c later ships .d.ts for plugin authors.
  // Until then, this is the documented type boundary: we import as
  // `unknown` and narrow to `MobileChannelPluginExport` via a duck-type
  // check on `createAdapter`. Do NOT pull strict types from
  // home/.letta/channels/* files — those stay .mjs per the migration.
  const module = (await import(pathToFileURL(pluginPath).href)) as MobileChannelPluginModule;
  const pluginRaw: unknown = module.channelPlugin ?? module.default;
  const plugin = pluginRaw as MobileChannelPluginExport | null | undefined;
  if (!plugin || typeof plugin.createAdapter !== "function") {
    log.log?.("[mobile-channel] plugin malformed (no createAdapter)");
    return null;
  }
  const host: MobileChannelHost = {
    log: (msg: string) => log.log?.(msg),
    getServerId,
    bridgeSendMessage,
    cancelRun: (runId: string) => cancelRun(runId),
  };
  const adapter = await plugin.createAdapter(account, host);
  await adapter.start?.();
  cachedAdapter = adapter;
  log.log?.(`[mobile-channel] adapter ready (account=${account.accountId})`);
  return adapter;
}
