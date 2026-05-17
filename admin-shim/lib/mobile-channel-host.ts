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
import { getA2uiServerCapabilities, type A2uiCapability } from "./a2ui-adapter.js";
import {
  A2uiStreamSplitter,
  validateA2uiMessage,
  type A2uiBlock,
  type A2uiMetrics,
} from "./a2ui-stream-splitter.js";
import { createRun, recordA2uiUserAction } from "./runs.js";
import {
  findUnmappedTailUserMessageId,
  resolveConversationId,
  writeOtidForLocalId,
} from "./store.js";
import type { LettaMessage } from "./types/wire.js";
import type {
  A2uiFrameMessage,
  A2uiUserAction,
  A2uiUserActionAck,
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
  A2uiFrameMessage,
  A2uiUserAction,
  A2uiUserActionAck,
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
 *
 * When A2UI is negotiated for the session the host also synthesizes
 * {@link A2uiFrameMessage} entries — one per `<a2ui-json>` block extracted
 * from the assistant_message text stream.
 */
type BridgeFrame = LettaMessage | A2uiFrameMessage;

/** Args to `bridgeSendMessage`. */
interface BridgeSendMessageArgs {
  agent_id: string;
  conversation_id: string;
  text: string;
  /**
   * lcp-dlj: optional Anthropic-style content parts (text + image blocks).
   * When non-empty, this wins over `text` and is forwarded verbatim to
   * letta-code's headless stdin (MessageCreate.content accepts the same
   * union shape). The shim does NOT validate the array — letta-code is
   * the canonical schema enforcer.
   */
  content_parts?: unknown[] | null;
  otid?: string | null;
  a2ui_capability?: A2uiCapability | null;
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
  { agent_id, conversation_id, text, content_parts, otid, a2ui_capability }: BridgeSendMessageArgs,
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

  // lcp-99a: create the Run record BEFORE awaiting pool.get() so the ws
  // handler can emit turn_started carrying a non-null run_id. Mobile
  // cancel-during-startup then always has a valid target. The cancel
  // hook is a no-op shim here — runTurn() will late-bind the real
  // SIGTERM dispatcher onto the existing run id once the worker exists
  // (see agent-pool.ts setRunCancelHandler call).
  const runHandle = createRun({
    agentId: effectiveAgentId,
    conversationId: effectiveConvId,
    onCancel: () => {
      // Replaced by runTurn(). If a cancel lands before runTurn() patches
      // this in, it's a no-op — the worker doesn't exist yet so there's
      // nothing to kill; the turn will short-circuit when the cancel
      // state is observed at run start.
    },
  });
  if (typeof onRunCreated === "function") {
    try { onRunCreated(runHandle.id); } catch {}
  }

  const pool = getAgentPool();
  const worker = await pool.get(effectiveConvId, effectiveAgentId);

  // lcp-cv3: stream assistant_message and reasoning_message chunks as
  // they arrive — DO NOT coalesce server-side. Mobile's stream ingest
  // (TimelineSyncIngest.kt) expects PURE DELTAS per the lettabot-uww.11
  // contract: it finds the existing event by serverId and appends new
  // content. To merge correctly each chunk must share the same id, so we
  // stamp a stable per-otid id (`cm-stream-<otid>` for assistants,
  // `cm-reason-<otid>` for reasoning). Without otid we fall back to the
  // upstream id, which means no merging happens and each chunk renders
  // as its own bubble (degraded but not broken).
  //
  // stop_reason and usage_statistics still buffer to end-of-turn so they
  // arrive AFTER the final assistant chunk regardless of upstream order.
  let pendingStop: BridgeFrame | null = null;
  let pendingUsage: BridgeFrame | null = null;
  // Per-otid splitters: each logical assistant message gets its own splitter
  // so trailing-tag hold-back doesn't leak across distinct assistant bubbles
  // (rare on a single turn, but possible for multi-step turns).
  const splittersByOtid = new Map<string, A2uiStreamSplitter>();
  const a2uiEnabled = a2ui_capability != null;
  const a2uiMetricsVerbosity = process.env["A2UI_METRICS_VERBOSITY"] ?? "normal";
  const a2uiMetricsEnabled = a2uiMetricsVerbosity !== "off";
  const a2uiMetrics: A2uiMetrics = {
    total_frames: 0,
    parse_ok: 0,
    parse_err: 0,
    validate_ok: 0,
    validate_err: 0,
    widget_types_seen: [],
    splitter_overhead_ms: 0,
  };
  const a2uiWidgetsSeen = new Set<string>();
  const truncateA2uiRaw = (raw: string): string => raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  const mergeA2uiMetrics = (metrics: A2uiMetrics): void => {
    a2uiMetrics.total_frames += metrics.total_frames;
    a2uiMetrics.parse_ok += metrics.parse_ok;
    a2uiMetrics.parse_err += metrics.parse_err;
    a2uiMetrics.validate_ok += metrics.validate_ok;
    a2uiMetrics.validate_err += metrics.validate_err;
    a2uiMetrics.splitter_overhead_ms += metrics.splitter_overhead_ms;
    for (const widget of metrics.widget_types_seen) a2uiWidgetsSeen.add(widget);
  };
  const logA2uiWarning = (payload: Record<string, unknown>): void => {
    if (!a2uiMetricsEnabled) return;
    console.error(JSON.stringify({ level: "warn", module: "a2ui", run_id: runHandle.id, agent_id: effectiveAgentId, ...payload }));
  };
  const newSplitter = (): A2uiStreamSplitter =>
    new A2uiStreamSplitter({
      validate: (message) => validateA2uiMessage(message, { expectedCatalogId: a2ui_capability?.catalogId }),
      onMetrics: mergeA2uiMetrics,
      onParseError: (raw, error) => {
        logA2uiWarning({ event: "parse_error", error, raw: truncateA2uiRaw(raw) });
      },
      onValidationError: (raw, error, widgetType) => {
        logA2uiWarning({ event: "validation_error", widget_type: widgetType, error, raw: truncateA2uiRaw(raw) });
      },
    });
  const buildA2uiFrame = (
    block: A2uiBlock,
    otid: string | null,
    runId: string | null,
  ): A2uiFrameMessage => ({
    message_type: "a2ui_frame",
    run_id: runId,
    otid,
    a2ui: block.parsed,
    raw: block.raw,
    ok: block.ok,
    parse_error: block.parseError,
    validation_error: block.validationError,
  });

  // Smoothing intentionally NOT done server-side. lcp-cv3 contract:
  // forward every chunk as a pure delta. The mobile renderer (Android
  // app/src/main/java/com/letta/mobile/ui/screens/chat/
  // StreamingDisplayTextSmoother.kt) already implements char-velocity
  // smoothing with a 60fps reveal loop — adding server-side batching
  // would introduce first-chunk latency without UX win. A no-op
  // StreamCoalescer module remains in lib/ for non-smoothing clients
  // (future web channel etc.) to opt into; not wired into this path.
  //
  // lcp-dlj: content_parts wins over text when present and non-empty.
  // letta-code's headless stdin accepts either shape on MessageCreate.content.
  const userInput: string | unknown[] =
    Array.isArray(content_parts) && content_parts.length > 0 ? content_parts : text;
  const turn = await worker.runTurn(userInput, {
    a2uiCapability: a2ui_capability ?? null,
    // lcp-99a: hand the pre-created run to the worker. agent-pool.ts
    // patches the SIGTERM hook onto it via setRunCancelHandler. The
    // worker will NOT call onRunCreated when a handle is provided —
    // the caller already knows the id (we fired onRunCreated above).
    runHandle,
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
        // lcp-c4d: first-wins (run-record contract).
        if (pendingStop === null) pendingStop = reshaped;
        return;
      }
      if (mt === "usage_statistics") {
        if (pendingUsage === null) pendingUsage = reshaped;
        return;
      }
      // Stable per-otid id so mobile's findByServerId merges chunks of
      // the same logical message. Spec §2.2 + §4.2 prescribes the
      // `cm-stream-` prefix for assistants; reasoning follows the same
      // pattern with `cm-reason-` (mobile dedups reasoning the same way).
      if (mt === "assistant_message") {
        const otid = (reshaped as { otid?: string | null }).otid;
        if (typeof otid === "string" && otid.length > 0) {
          (reshaped as unknown as Record<string, unknown>)["id"] = `cm-stream-${otid}`;
        }
        // A2UI: pull `<a2ui-json>` blocks out of the assistant text. The
        // splitter emits separate A2UI frames downstream and replaces the
        // assistant_message content with the surrounding conversational
        // text. Splitter only runs when a capability was negotiated; in
        // that case the model has the v0.9 prompt and may emit blocks.
        if (a2uiEnabled) {
          const otidKey = typeof otid === "string" && otid.length > 0 ? otid : "__no-otid__";
          let splitter = splittersByOtid.get(otidKey);
          if (!splitter) {
            splitter = newSplitter();
            splittersByOtid.set(otidKey, splitter);
          }
          const contentDelta = typeof (reshaped as { content?: unknown }).content === "string"
            ? (reshaped as { content: string }).content
            : "";
          const split = splitter.feed(contentDelta);
          // Emit the user-visible text delta (may be empty when the chunk
          // was 100% tag bytes). Skip pure no-op chunks so we don't ship
          // empty bubbles down the wire.
          if (split.text.length > 0) {
            (reshaped as unknown as Record<string, unknown>)["content"] = split.text;
            onFrame(reshaped);
          }
          // Forward each completed A2UI block as a host-synthesized frame.
          const runId = (reshaped as { run_id?: string | null }).run_id ?? null;
          for (const block of split.frames) {
            onFrame(buildA2uiFrame(block, otid ?? null, runId));
          }
          return;
        }
      } else if (mt === "reasoning_message") {
        const otid = (reshaped as { otid?: string | null }).otid;
        if (typeof otid === "string" && otid.length > 0) {
          (reshaped as unknown as Record<string, unknown>)["id"] = `cm-reason-${otid}`;
        }
      }
      onFrame(reshaped);
    },
  });

  // End-of-turn tail: drain each splitter's pending state. Any text the
  // splitter was holding back as a possible tag opening flushes to a final
  // assistant_message delta; unclosed `<a2ui-json>` blocks are logged and
  // dropped so the renderer never observes a truncated A2UI frame.
  if (a2uiEnabled) {
    for (const [otidKey, splitter] of splittersByOtid) {
      const flush = splitter.flush();
      if (flush.text.length > 0) {
        const fakeOtid = otidKey === "__no-otid__" ? null : otidKey;
        onFrame({
          id: fakeOtid ? `cm-stream-${fakeOtid}` : `cm-stream-flush-${Date.now()}`,
          date: new Date().toISOString(),
          name: null,
          message_type: "assistant_message",
          otid: fakeOtid,
          sender_id: null,
          step_id: null,
          is_err: null,
          seq_id: null,
          run_id: null,
          content: flush.text,
        });
      }
      if (flush.unclosed) {
        console.error(`[mobile-channel] A2UI splitter ended mid-tag (otid=${otidKey})`);
      }
    }
    if (a2uiMetricsEnabled) {
      console.log(JSON.stringify({
        level: "info",
        module: "a2ui",
        event: "turn_metrics",
        run_id: runHandle.id,
        agent_id: effectiveAgentId,
        total_frames: a2uiMetrics.total_frames,
        parse_ok: a2uiMetrics.parse_ok,
        parse_err: a2uiMetrics.parse_err,
        validate_ok: a2uiMetrics.validate_ok,
        validate_err: a2uiMetrics.validate_err,
        widget_types_seen: [...a2uiWidgetsSeen].sort(),
        splitter_overhead_ms: a2uiMetrics.splitter_overhead_ms,
      }));
    }
  }

  // End-of-turn tail: stop_reason → usage_statistics. Assistant chunks
  // were already forwarded inline above.
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
 * Phase 5: handle an inbound A2UI user_action frame. Records the action
 * to the run sidecar and returns a synchronous ack. The actual
 * tool-dispatcher gate integration ships in a follow-up bead once
 * letta-code exposes a stable approval API; for now the recorded
 * action is the canonical source of truth for downstream consumers.
 */
function handleUserAction(action: A2uiUserAction): A2uiUserActionAck {
  const actionId =
    typeof action.action_id === "string" && action.action_id.length > 0
      ? action.action_id
      : `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (typeof action.name !== "string" || action.name.length === 0) {
    return { action_id: actionId, status: "rejected", reason: "missing event name" };
  }
  recordA2uiUserAction({
    run_id: action.run_id,
    session_id: action.session_id,
    turn_id: action.turn_id,
    surface_id: action.surface_id,
    name: action.name,
    context: action.context ?? {},
    action_id: actionId,
  });
  return { action_id: actionId, status: "accepted" };
}

/**
 * The `host` object the shim hands the channel plugin. Mirrors the
 * informal contract the plugin reads in `acceptConnection` (see
 * home/.letta/channels/mobile/plugin.mjs):
 *  - `log(msg)` — line logger
 *  - `getServerId()` — server identity for the welcome envelope
 *  - `bridgeSendMessage(args, onFrame, hooks)` — turn driver
 *  - `cancelRun(runId)` — cancel hook from the worker pool
 *  - `handleUserAction(action)` — A2UI user_action ingestion
 */
interface MobileChannelHost {
  log: (msg: string) => void;
  getServerId: () => string;
  getA2uiServerCapabilities: typeof getA2uiServerCapabilities;
  bridgeSendMessage: typeof bridgeSendMessage;
  cancelRun: (runId: string) => boolean;
  handleUserAction: typeof handleUserAction;
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

// lcp-m06: cache the in-flight Promise rather than the resolved value.
// Concurrent first-callers all await the same promise — start() runs
// exactly once, only one adapter instance lives. On rejection we clear
// the slot so a retry is possible.
let cachedAdapterPromise: Promise<MobileChannelAdapter | null> | null = null;

/**
 * Load the mobile channel plugin and create the adapter. Memoized.
 * Returns null if the channel isn't configured (no accounts.json or
 * no enabled account).
 */
export function getMobileChannelAdapter(
  options: GetMobileChannelAdapterOptions,
): Promise<MobileChannelAdapter | null> {
  if (cachedAdapterPromise) return cachedAdapterPromise;
  const promise = createMobileChannelAdapter(options);
  cachedAdapterPromise = promise;
  // Clear the cache on rejection so a fresh upgrade attempt can retry
  // (e.g. accounts.json was just written, plugin file appears).
  promise.catch(() => { cachedAdapterPromise = null; });
  return promise;
}

async function createMobileChannelAdapter(
  { getServerId, log = console }: GetMobileChannelAdapterOptions,
): Promise<MobileChannelAdapter | null> {
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
    getA2uiServerCapabilities,
    bridgeSendMessage,
    cancelRun: (runId: string) => cancelRun(runId),
    handleUserAction,
  };
  const adapter = await plugin.createAdapter(account, host);
  await adapter.start?.();
  log.log?.(`[mobile-channel] adapter ready (account=${account.accountId})`);
  return adapter;
}
