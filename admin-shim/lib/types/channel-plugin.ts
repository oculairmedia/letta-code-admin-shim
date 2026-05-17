/**
 * Channel-plugin public contract.
 *
 * This file is the type boundary between the admin-shim host and the
 * user-authored channel plugins that live at
 * `~/.letta/channels/<channelId>/plugin.mjs`. The shim discovers plugins
 * at runtime and imports them as `unknown`, so these interfaces are
 * NOT enforced by the host — they exist purely as opt-in type hints for
 * plugin authors.
 *
 * To opt in, a plugin .mjs may add a reference directive at the top:
 *
 *   /// <reference path="../../../admin-shim/dist/lib/types/channel-plugin.d.ts" />
 *
 * and then annotate exports via JSDoc. See `docs/CHANNEL_PLUGINS.md` for the
 * full guide and an example.
 *
 * Two reference plugins exemplify the contract:
 *   - home/.letta/channels/mobile/plugin.mjs   (inbound WS-driven)
 *   - home/.letta/channels/matrix/plugin.mjs   (outbound long-poll driven)
 *
 * Anything specific to one channel (e.g. the mobile WS frame shape) lives
 * in the `MobileChannelExtras` sub-interface and is OPTIONAL on
 * `ChannelAdapter`. The generic surface is what the host actually drives.
 */

import type { LettaMessage } from "./wire.js";
import type { A2uiCapability, A2uiServerCapabilities } from "../a2ui-adapter.js";

// ─── Frame surfaced from the worker pool to the plugin via onFrame ─────

/**
 * Host-synthesized frame carrying one A2UI v0.9 message extracted from the
 * model's text stream. The host emits these alongside ordinary
 * {@link LettaMessage} frames when A2UI is negotiated for the session. The
 * channel plugin is responsible for wrapping it into a channel-specific
 * envelope (e.g. the mobile WS `a2ui_frame` type).
 *
 * `ok` means the host parsed the block and its structural/envelope validator
 * accepted the A2UI message variant. It is not a renderability guarantee:
 * catalog-level component validation still belongs to the renderer. A frame
 * with `ok === false` carries the raw bytes plus a diagnostic field so the
 * plugin can choose to drop it or surface it to the client.
 */
export interface A2uiFrameMessage {
  message_type: "a2ui_frame";
  /** Run id this frame belongs to (stamped by the host). */
  run_id: string | null;
  /** Otid of the assistant_message the A2UI block was carried inside. */
  otid: string | null;
  /** The parsed A2UI message (a single object or an array of messages). Null when parse failed. */
  a2ui: unknown;
  /** Raw JSON bytes between the `<a2ui-json>` tags. */
  raw: string;
  /** True iff parse and structural/envelope validation passed. */
  ok: boolean;
  /** JSON.parse error message, when parsing failed. */
  parse_error: string | null;
  /** Validator-reported failure reason, when validation failed. */
  validation_error: string | null;
}

/**
 * A frame emitted by the worker pool (or synthesized by the host) for one
 * streamed turn. The host stamps `run_id` onto every frame before calling
 * `onFrame` so the plugin can correlate to `/v1/runs/{id}` without
 * inspecting the worker.
 */
export type BridgeFrame = LettaMessage | A2uiFrameMessage;

// ─── Inputs to the host's send-message bridge ──────────────────────────

/**
 * Args passed to {@link ChannelHost.bridgeSendMessage}. `agent_id` and
 * `conversation_id` may be either the internal `conv-<uuid>` form or an
 * external alias (e.g. `conv-default-<agentId>`) — the host resolves
 * aliases before dispatching to the worker pool.
 *
 * `otid` is an optional client-side opaque token; when present, the host
 * binds it to the user message it persists so the disk projection echoes
 * it back. Mobile uses this for `reconcileAfterSend` dedup.
 */
export interface BridgeSendMessageArgs {
  agent_id: string;
  conversation_id: string;
  text: string;
  /**
   * lcp-dlj: optional Anthropic-style content parts (text + image blocks).
   * When non-empty, wins over `text`. Schema mirrors REST
   * `MessageCreate.content` so letta-code's headless stdin can ingest the
   * value verbatim. Channel plugins MAY forward this from their own wire
   * protocol when they support multimodal input; text-only callers leave
   * it undefined and `text` carries the whole user prompt.
   */
  content_parts?: unknown[] | null;
  otid?: string | null;
  a2ui_capability?: A2uiCapability | null;
}

/**
 * Optional hooks the plugin can register on a `bridgeSendMessage` call.
 * `onRunCreated` fires once per turn the moment the worker pool surfaces
 * the `runId`. Useful for sending an early `turn_started` envelope before
 * any model frames arrive.
 */
export interface BridgeSendMessageHooks {
  onRunCreated?: (runId: string) => void;
}

// ─── Host logger ───────────────────────────────────────────────────────

/**
 * Logger shape the host hands to the plugin. Matches the subset of the
 * Node `console` plugins are allowed to rely on.
 *
 * Plugins SHOULD route human-readable progress through `host.log` so the
 * shim can route it uniformly. `console.error` calls bypass this object.
 */
export interface HostLogger {
  log?: (...args: unknown[]) => void;
}

// ─── Channel account record ────────────────────────────────────────────

/**
 * The account record the host reads out of
 * `~/.letta/channels/<channelId>/accounts.json` and hands to
 * {@link ChannelPlugin.createAdapter}. The file is user-edited and
 * field-permissive; the host only narrows the keys it uses and passes the
 * full object through. Plugins are encouraged to read their own
 * channel-specific config out of `config`.
 */
export interface ChannelAccount {
  accountId?: string;
  channel?: string;
  enabled?: boolean;
  displayName?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Host surface the plugin receives in createAdapter ────────────────

/**
 * The `host` object the shim hands a channel plugin's `createAdapter`.
 * This is the only host API a plugin is allowed to depend on.
 *
 *  - `log(msg)`             — line logger (routes through {@link HostLogger}).
 *  - `getServerId()`        — server identity for plugin welcome/handshake frames.
 *  - `bridgeSendMessage()`  — turn driver: dispatches a user message into the
 *                              worker pool and streams reshaped frames via
 *                              `onFrame`. Resolves when the turn settles.
 *  - `cancelRun(runId)`     — best-effort cancel hook. Returns `true` if a
 *                              running turn matched; `false` otherwise.
 */
export interface ChannelHost {
  log: (msg: string) => void;
  getServerId: () => string;
  getA2uiServerCapabilities?: () => A2uiServerCapabilities;
  bridgeSendMessage: (
    args: BridgeSendMessageArgs,
    onFrame: (frame: BridgeFrame) => void,
    hooks?: BridgeSendMessageHooks,
  ) => Promise<unknown>;
  cancelRun: (runId: string) => boolean;
  /**
   * Phase 5: dispatch a `user_action` frame from the channel back to the
   * agent. Returns the action id (echoed back to the channel so the
   * plugin can ack the round-trip).
   *
   * For Phase-5 scope this is a recording hook: the host writes the
   * action into the run sidecar / log so a follow-up integration can
   * pick it up. The shim does NOT yet inject the action into letta-code's
   * tool dispatcher — that integration ships in a follow-up bead once
   * letta-code exposes a stable approval API.
   */
  handleUserAction?: (action: A2uiUserAction) => Promise<A2uiUserActionAck> | A2uiUserActionAck;
}

/**
 * Inbound user-action payload, carried by the mobile WS `user_action`
 * frame. Mirrors A2UI v0.9 `Action.event`: a server-side event name plus
 * an opaque context bag the renderer populated from the surface state.
 *
 * Surface and run/turn correlation is supplied by the channel layer; the
 * agent integration consumes the (run_id, name, context) triple.
 */
export interface A2uiUserAction {
  /** Channel-supplied session id (mobile WS sess-<uuid>). */
  session_id: string;
  /** Run id this action targets. May be null when no turn is active. */
  run_id: string | null;
  /** Turn id this action targets. May be null. */
  turn_id: string | null;
  /** A2UI surface this action originated from. */
  surface_id: string | null;
  /** Event name from `Action.event.name` (free-form, agent-defined). */
  name: string;
  /** Event context bag from `Action.event.context`. */
  context: Record<string, unknown>;
  /** Optional client-generated action id for ack correlation. */
  action_id?: string | null;
}

/** Synchronous-ish ack the host returns to the channel for a user_action. */
export interface A2uiUserActionAck {
  /** Server-assigned action id (echoes the client's when provided). */
  action_id: string;
  /** "accepted" — host queued the action; "rejected" — host refused (with reason). */
  status: "accepted" | "rejected";
  /** Human-readable reason; populated when status === "rejected". */
  reason?: string;
}

// ─── Mobile-channel-specific extras ────────────────────────────────────

/**
 * Adapter surface specific to the inbound mobile WS channel. NOT part of
 * the generic contract — only plugins that host their own WS upgrade
 * route implement this. The shim's mobile WS upgrade handler hands the
 * accepted socket to `acceptConnection(ws, request)`.
 *
 * `ws` is intentionally typed as `unknown` here so the generic types
 * don't take a hard dependency on the `ws` package. Plugins narrow to
 * their own WebSocket type internally.
 */
export interface MobileChannelExtras {
  acceptConnection?: (ws: unknown, request: unknown) => void;
}

// ─── Channel adapter the plugin returns from createAdapter ─────────────

/**
 * The adapter object a channel plugin returns from
 * {@link ChannelPlugin.createAdapter}. The host invokes `start()` once
 * after construction and `stop()` on shutdown; everything else is
 * channel-specific.
 *
 * Outbound channels (Matrix, future Slack/Discord) implement
 * `sendMessage` + `sendDirectReply` and expose `onMessage` as a hook the
 * host fills in. Inbound channels (mobile) leave those as no-ops and use
 * {@link MobileChannelExtras.acceptConnection} instead.
 *
 * The index signature (`[k: string]: unknown`) is intentional: this is a
 * loose, duck-typed surface. Channels may attach private helpers
 * (`_editMessage`, etc.) without widening the contract.
 */
export interface ChannelAdapter extends MobileChannelExtras {
  /** Stable adapter identity, conventionally `${channelId}:${accountId}`. */
  id?: string;
  /** Channel-family id (e.g. `"mobile"`, `"matrix"`). */
  channelId?: string;
  /** Account id within the channel. */
  accountId?: string;
  /** Human-readable display name (surfaced in UI). */
  name?: string;

  /** Begin processing — host calls this once after createAdapter resolves. */
  start?: () => Promise<void> | void;
  /** Tear down — host calls this on shutdown. */
  stop?: () => Promise<void> | void;
  /** Liveness probe used by the channel registry. */
  isRunning?: () => boolean;

  /**
   * Send an outbound message. Outbound channels implement this; inbound
   * channels may return a no-op result. Shape of the result is
   * channel-defined (typically `{ messageId: string }`).
   */
  sendMessage?: (msg: Record<string, unknown>) => Promise<unknown>;

  /** Direct-reply helper, used by some agent code paths. */
  sendDirectReply?: (
    chatId: string,
    text: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown> | unknown;

  /**
   * Inbound-message hook the host fills in. The plugin calls this with
   * its own parsed `inbound` payload when a remote event arrives. Left
   * `undefined` when the host hasn't wired it yet.
   */
  onMessage?: ((inbound: unknown) => Promise<void> | void) | undefined;

  /**
   * Optional lifecycle hook for turn boundaries (e.g. used by the Matrix
   * plugin to stop typing indicators).
   */
  handleTurnLifecycleEvent?: (event: Record<string, unknown>) => Promise<void> | void;

  /** Forward-compat: plugins may attach private helpers. */
  [k: string]: unknown;
}

// ─── messageActions: optional sub-surface for agent tool dispatch ──────

/**
 * Optional sub-surface for plugins that participate in the `send_message`
 * tool dispatch path. `describeMessageTool()` returns the per-channel
 * action vocabulary the LLM sees in the tool description.
 * `handleAction(ctx)` is called by the host when the LLM emits an action
 * for this channel.
 */
export interface ChannelMessageActions {
  describeMessageTool?: () => Record<string, unknown>;
  handleAction?: (ctx: Record<string, unknown>) => Promise<unknown> | unknown;
}

// ─── The plugin export itself ──────────────────────────────────────────

/**
 * Channel-plugin metadata. The host reads this to populate the channel
 * registry. `runtimePackages` lists the npm specifiers the plugin imports
 * at runtime — the host may use this to bootstrap dependencies.
 */
export interface ChannelPluginMetadata {
  id: string;
  displayName?: string;
  runtimePackages?: string[];
  runtimeModules?: string[];
  [k: string]: unknown;
}

/**
 * The runtime-imported plugin module's `channelPlugin` export (or
 * `default` — the host accepts both). User-authored .mjs files declare
 * this; the host loads it as `unknown` and duck-type-narrows on
 * `createAdapter`.
 *
 * Reference implementations:
 *   - home/.letta/channels/mobile/plugin.mjs
 *   - home/.letta/channels/matrix/plugin.mjs
 */
export interface ChannelPlugin {
  /** Static channel metadata (id, display name, runtime deps). */
  metadata?: ChannelPluginMetadata;

  /**
   * Constructs an adapter for one account. The host invokes this once
   * per enabled account at startup. `host` exposes the bridge into the
   * worker pool — see {@link ChannelHost}.
   *
   * Plugins may treat `host` as optional (`= {}`) for back-compat; the
   * shim always passes a fully populated host object today.
   */
  createAdapter: (
    account: ChannelAccount,
    host: ChannelHost,
  ) => Promise<ChannelAdapter> | ChannelAdapter;

  /** Optional message-tool dispatch surface. */
  messageActions?: ChannelMessageActions;
}
