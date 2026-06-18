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

import { appendFileSync, existsSync, readFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage } from "node:http";

import { reshapeFrame, attachReadImageToToolReturn } from "./chat.js";
import { cancelRun, getAgentPool, resolveApprovalGate } from "./agent-pool.js";
import { readPendingApproval, resolveApproval } from "./pending-approval.js";
import { resolveAgentIdAlias } from "./agent-aliases.js";
import { getA2uiServerCapabilities, type A2uiCapability } from "./a2ui-adapter.js";
import { getNativeGoalForConversation } from "./native-goal-mode.js";
import { makeGoalControlTool, shouldInjectGoalControlTool } from "./goal-control-tool.js";
import {
  A2uiStreamSplitter,
  validateA2uiMessage,
  type A2uiBlock,
  type A2uiMetrics,
} from "./a2ui-stream-splitter.js";
import { appendRunFrame, createRun, getFramesFilePath, getRun, recordA2uiUserAction, subscribeLiveFrames, type ApprovalScope } from "./runs.js";
import {
  getSubagent,
  ingestParentFrame,
  listActiveSubagents,
  snapshotSubagents,
  subscribeSubagentEvents,
  type SubagentEntry,
  type SubagentEvent,
} from "./subagent-registry.js";
import { readSubagentTodos, type TodoSnapshot } from "./subagent-todos.js";
import {
  ackConversation,
  mobileConversationCursorCapabilities,
  resumeConversation,
  stampConversationFrame,
} from "./mobile-conversation-cursors.js";
import {
  findUnmappedTailUserMessageId,
  getAgentRecord,
  listMessages,
  listMessagesSync,
  resolveConversationId,
  writeOtidForLocalId,
} from "./store.js";
import type { LettaMessage, ToolReturn, ToolReturnMessage } from "./types/wire.js";
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
  /**
   * lcp-4tv: marks the resulting Run as background. Cron-driven and
   * other operator-initiated turns set this true so list filters
   * (`/v1/runs?background=true`) can pull them out. Defaults to false
   * (foreground / user-initiated).
   */
  background?: boolean;
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

function localPartsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (p: unknown): p is { type: "text"; text?: string } =>
        typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text",
    )
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
}

function localPartsToImageParts(parts: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(parts)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const p of parts) {
    if (typeof p !== "object" || p === null) continue;
    const part = p as Record<string, unknown>;
    if (part["type"] !== "image") continue;
    const existingSource = part["source"];
    if (existingSource && typeof existingSource === "object") {
      out.push(part);
      continue;
    }
    const mediaType =
      (typeof part["media_type"] === "string" && (part["media_type"] as string)) ||
      (typeof part["mimeType"] === "string" && (part["mimeType"] as string)) ||
      "image/png";
    const data = typeof part["data"] === "string" ? (part["data"] as string) : null;
    if (!data) continue;
    out.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }
  return out;
}

export async function bridgeSendMessage(
  { agent_id, conversation_id, text, content_parts, otid, a2ui_capability, background }: BridgeSendMessageArgs,
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
  const requestedAgentId = resolved?.agentId ?? agent_id;
  const effectiveAgentId = resolveAgentIdAlias(requestedAgentId, (id) => getAgentRecord(id) != null);
  const effectiveConvId = resolved?.conversationId ?? conversation_id;

  // lcp-4vz: snapshot pre-turn message ids so post-turn disk diff can find
  // new tool results the CLI wrote but never emitted on the wire.
  const preTurnMessageIds = new Set(
    (await listMessages(effectiveConvId, effectiveAgentId)).map((m) => m.id),
  );

  // lcp-99a: create the Run record BEFORE awaiting pool.get() so the ws
  // handler can emit turn_started carrying a non-null run_id. Mobile
  // cancel-during-startup then always has a valid target. The cancel
  // hook is a no-op shim here — runTurn() will late-bind the real
  // SIGTERM dispatcher onto the existing run id once the worker exists
  // (see agent-pool.ts setRunCancelHandler call).
  const runHandle = createRun({
    agentId: effectiveAgentId,
    conversationId: effectiveConvId,
    background: background ?? false,
    onCancel: () => {
      // Replaced by runTurn(). If a cancel lands before runTurn() patches
      // this in, it's a no-op — the worker doesn't exist yet so there's
      // nothing to kill; the turn will short-circuit when the cancel
      // state is observed at run start.
    },
  });
  if (otid?.startsWith("goalcont-")) {
    runHandle.record.metadata = { ...(runHandle.record.metadata ?? {}), goal_continuation: true, otid };
  }
  if (typeof onRunCreated === "function") {
    try {
      onRunCreated(runHandle.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mobile-channel] onRunCreated hook failed for ${runHandle.id}: ${msg}`);
    }
  }

  // lcp-p74.1: every frame the host emits also lands in state/runs/<id>/frames.jsonl
  // so a disconnected mobile client can later subscribe(run_id, cursor) (lcp-p74.2)
  // and replay. Wrapping at the consumer-emit boundary captures the post-reshape
  // shape — i.e. exactly what the WS would see, not the raw upstream frame.
  // lcp-p74.2: stamp the assigned seq onto the frame so live consumers track
  // their cursor in lockstep with what subscribe(run_id, cursor) would replay.
  const emit = (frame: BridgeFrame): void => {
    try {
      ingestParentFrame(frame, runHandle.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mobile-channel] subagent-registry ingest failed: ${msg}`);
    }
    const { seq } = appendRunFrame(runHandle.id, frame);
    if (seq > 0) {
      const asRec = frame as unknown as Record<string, unknown>;
      asRec["seq"] = seq;
      // lcp-pro: alias `seq` as `seq_id` on delta-shaped frames so mobile's
      // `hasAlreadyIngestedStreamFrame` gate (which dedups by `seqId: Int?`)
      // fires on the WS path without a mobile-side change. Without this
      // every reconnect-replay / WS-vs-REST race silently appends a
      // duplicate delta (the 2026-05-19 "Hello worldHello world" repro).
      // We overwrite any upstream-supplied seq_id so the wire value is
      // ALWAYS the shim's authoritative per-run cursor — upstream's value
      // may be null on synthetic frames (end-of-turn splitter flush, A2UI
      // host-synthesized frames) and a single source of truth keeps the
      // gate's monotonicity invariant unbroken across the whole turn.
      const mt = (frame as { message_type?: unknown }).message_type;
      if (mt === "assistant_message" || mt === "reasoning_message") {
        asRec["seq_id"] = seq;
      }
    }
    onFrame(frame);
  };

  const pool = getAgentPool();

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
  // lcp-4vz + lcp-pgw: track tool_call_ids for inline + end-of-turn synthesis.
  const toolCallIdsSeen: string[] = [];
  const toolReturnIdsSeen = new Set<string>();
  const toolCallsById = new Map<string, import("./types/wire.js").ToolCall>();
  // lcp-pgw: flag that flips true when a new tool_call arrives and resets
  // once the inline flush resolves it. Prevents re-reading disk on every
  // assistant_message delta — only on the first content frame after each
  // tool execution completes.
  let needsInlineFlush = false;
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
  let a2uiFramesDelivered = 0;
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
  const emitA2uiFrame = (frame: A2uiFrameMessage): void => {
    a2uiFramesDelivered += 1;
    onFrame(frame);
  };

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
  let userInput: string | unknown[] =
    Array.isArray(content_parts) && content_parts.length > 0 ? content_parts : text;

  // lcp-d0za: passive runtime introspection — inject serving model,
  // context utilization, and session role as a system-reminder so
  // the agent always knows its runtime state without a tool call.
  // Also detect mid-conversation model changes and surface a delta.
  //
  // **Fail-open**: the introspection block runs inside a try/catch.
  // The reminder is an enhancement — if any lookup fails the message
  // path proceeds unblocked with the original user input.
  try {
    // lcp-d0za: dynamic import so the module graph is only loaded
    // when a message is actually being sent, not at shim startup.
    // This prevents a startup hang on Node 20 CI where eager
    // evaluation of the introspection module's import tree blocks
    // the server from binding its port.
    const introspect = await import("./runtime-introspection.js");
    const connectionReminder = introspect.buildConnectionReminder(effectiveAgentId, effectiveConvId);
    const modelDelta = introspect.detectModelChange(effectiveAgentId, effectiveConvId, introspect.getServingModelHandle(effectiveAgentId));
    const prefix = [connectionReminder, modelDelta].filter(Boolean).join("\n");
    if (prefix) {
      if (typeof userInput === "string") {
        userInput = prefix + "\n\n" + userInput;
      } else if (Array.isArray(userInput)) {
        userInput = [{ type: "text", text: prefix + "\n\n" }, ...userInput];
      }
    }
    // Seed the model tracker so the first turn doesn't emit a spurious
    // "changed" frame.
    introspect.seedModelHandle(effectiveAgentId, effectiveConvId, introspect.getServingModelHandle(effectiveAgentId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mobile-channel] runtime-introspection injection failed (fail-open): ${msg}`);
    // userInput is unchanged — message delivery proceeds normally.
  }

  // lcp-0vi: route through pool.runTurnWithHeal so a dangling-tool-use
  // failure on this turn evicts the warm adapter + heals the transcript
  // before returning. The caller sees the original turn result unchanged;
  // the cleaned disk is picked up on the next user turn.
  const isGoalContinuation = shouldInjectGoalControlTool({
    metadata: runHandle.record.metadata ?? null,
    otid: otid ?? null,
    hasActiveGoal: getNativeGoalForConversation(effectiveConvId)?.goal?.status === "active",
  });
  const goalControlTools = isGoalContinuation
    ? [makeGoalControlTool({ agentId: effectiveAgentId, conversationId: effectiveConvId })]
    : undefined;

  const turn = await pool.runTurnWithHeal(effectiveConvId, effectiveAgentId, userInput, {
    a2uiCapability: a2ui_capability ?? null,
    ...(goalControlTools ? { tools: goalControlTools, closeAfterTurn: true } : {}),
    // lcp-99a: hand the pre-created run to the worker. agent-pool.ts
    // patches the SIGTERM hook onto it via setRunCancelHandler. The
    // worker will NOT call onRunCreated when a handle is provided —
    // the caller already knows the id (we fired onRunCreated above).
    runHandle,
    onFrame: (raw, meta) => {
      let reshaped = reshapeFrame(raw);
      if (!reshaped) return;
      // Stamp the run_id on every reshaped frame for mobile-side correlation
      // with /v1/runs/{id}. The pool exposes it via the meta callback arg.
      // Bare-shape variants (StopReasonMessage, UsageStatisticsMessage) do
      // not declare `run_id`, but the .mjs unconditionally added it at
      // runtime; mirror that exactly by writing through a Record cast.
      if (meta?.runId) (reshaped as unknown as Record<string, unknown>)["run_id"] = meta.runId;
      const mt = reshaped.message_type;
      if (mt === "stop_reason") {
        // lcp-8ri: last-wins for the WS emission. Multi-step turns emit
        // stop_reason per step (first is usually requires_approval, last
        // is end_turn). The wire and run summary both reflect the terminal
        // state; per-step records preserve intermediate approval stops for
        // diagnostics.
        pendingStop = reshaped;
        return;
      }
      if (mt === "usage_statistics") {
        if (pendingUsage === null) pendingUsage = reshaped;
        return;
      }
      // lcp-4vz + lcp-pgw: inline tool_return synthesis. When a content
      // frame arrives and there are unresolved tool calls, read disk for
      // their results and emit tool_return frames BEFORE the current frame.
      // This gives per-tool progressive resolution instead of end-of-turn
      // batching. Gated by needsInlineFlush so we don't re-read disk on
      // every assistant_message delta.
      if (mt === "tool_return_message") {
        const callId = (reshaped as { tool_call_id?: string | null }).tool_call_id;
        if (callId) toolReturnIdsSeen.add(callId);
        reshaped = attachReadImageToToolReturn(
          reshaped as unknown as Parameters<typeof attachReadImageToToolReturn>[0],
          toolCallsById,
        ) as unknown as typeof reshaped;
      }
      if (needsInlineFlush && (mt === "tool_call_message" || mt === "assistant_message" || mt === "reasoning_message")) {
        const unresolvedNow = toolCallIdsSeen.filter((id) => !toolReturnIdsSeen.has(id));
        if (unresolvedNow.length > 0) {
          try {
            const diskMsgs = listMessagesSync(effectiveConvId, effectiveAgentId);
            const newResults = diskMsgs.filter(
              (m) => m.role === "toolResult" && !preTurnMessageIds.has(m.id),
            );
            const byCallId = new Map(newResults.filter((m) => m.toolCallId).map((m) => [m.toolCallId!, m]));
            // lcp-j3r: positional fallback for synthetic tool_call_ids
            // (from the canUseTool path) that don't match any disk entry.
            const unmatchedInline = [...newResults];
            for (const callId of unresolvedNow) {
              let entry = byCallId.get(callId);
              if (!entry && unmatchedInline.length > 0) {
                entry = unmatchedInline.shift()!;
              } else if (entry) {
                const idx = unmatchedInline.indexOf(entry);
                if (idx >= 0) unmatchedInline.splice(idx, 1);
              }
              if (!entry) continue;
              const returnText = localPartsToText(entry.parts);
              const isError = entry.isError === true;
              const status = isError ? "error" : "success";
              const tr: ToolReturn = {
                tool_call_id: callId, status,
                func_response: returnText, stdout: null, stderr: null, type: "tool",
              };
              const imageParts = localPartsToImageParts(entry.parts);
              const toolReturnValue: unknown = imageParts.length > 0
                ? [...(returnText ? [{ type: "text", text: returnText }] : []), ...imageParts]
                : returnText;
              emit({
                id: `toolreturn-${callId}`,
                date: new Date().toISOString(),
                name: (entry.toolName as string | undefined) ?? null,
                message_type: "tool_return_message",
                otid: null, sender_id: null, step_id: null,
                is_err: isError ? true : null, seq_id: null,
                run_id: runHandle.id,
                tool_call_id: callId, status,
                tool_return: toolReturnValue as ToolReturnMessage["tool_return"], stdout: null, stderr: null,
                tool_returns: [tr],
              } satisfies ToolReturnMessage);
              toolReturnIdsSeen.add(callId);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[mobile-channel] lcp-pgw: inline tool_return synthesis failed: ${msg}`);
          }
        }
        needsInlineFlush = toolCallIdsSeen.some((id) => !toolReturnIdsSeen.has(id));
      }
      if (mt === "tool_call_message") {
        const tcm = reshaped as {
          tool_call?: import("./types/wire.js").ToolCall | null;
          tool_calls?: import("./types/wire.js").ToolCall[] | null;
        };
        const tc = tcm.tool_call;
        if (tc?.tool_call_id) {
          toolCallsById.set(tc.tool_call_id, tc);
          toolCallIdsSeen.push(tc.tool_call_id);
          needsInlineFlush = true;
        }
        for (const call of tcm.tool_calls ?? []) {
          if (call?.tool_call_id) toolCallsById.set(call.tool_call_id, call);
        }
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
            emit(reshaped);
          }
          // Forward each completed A2UI block as a host-synthesized frame.
          const runId = (reshaped as { run_id?: string | null }).run_id ?? null;
          for (const block of split.frames) {
            emitA2uiFrame(buildA2uiFrame(block, otid ?? null, runId));
          }
          return;
        }
      } else if (mt === "reasoning_message") {
        const otid = (reshaped as { otid?: string | null }).otid;
        if (typeof otid === "string" && otid.length > 0) {
          (reshaped as unknown as Record<string, unknown>)["id"] = `cm-reason-${otid}`;
        }
      }
      emit(reshaped);
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
        emit({
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
        total_frames: a2uiFramesDelivered,
        parse_ok: a2uiMetrics.parse_ok,
        parse_err: a2uiMetrics.parse_err,
        validate_ok: a2uiMetrics.validate_ok,
        validate_err: a2uiMetrics.validate_err,
        widget_types_seen: [...a2uiWidgetsSeen].sort(),
        splitter_overhead_ms: a2uiMetrics.splitter_overhead_ms,
      }));
    }
  }

  // lcp-4vz: synthesize missing tool_return_message frames from disk.
  // The CLI's headless SDK transport never emits tool_return on the wire —
  // the results exist on disk in messages.jsonl but never cross the SDK
  // boundary. For each tool_call without a matching tool_return, read the
  // result from disk and emit it so mobile's tool cards resolve.
  //
  // Timing: this runs AFTER pool.runTurnWithHeal returns, which means
  // finalizeRun has already removed the run from _activeRuns. The normal
  // emit() path calls appendRunFrame which silently no-ops on finalized
  // runs (returns seq=-1). To ensure synthesized frames persist for
  // reconnect/replay, we append directly to the frames file.
  const unresolvedCallIds = toolCallIdsSeen.filter((id) => !toolReturnIdsSeen.has(id));
  if (unresolvedCallIds.length > 0) {
    try {
      const postMessages = await listMessages(effectiveConvId, effectiveAgentId);
      const newToolResults = postMessages.filter(
        (m) => m.role === "toolResult" && !preTurnMessageIds.has(m.id),
      );
      const diskByCallId = new Map<string, typeof newToolResults[number]>();
      for (const m of newToolResults) {
        if (m.toolCallId) diskByCallId.set(m.toolCallId, m);
      }
      const unmatchedDisk = [...newToolResults];
      const framesPath = getFramesFilePath(runHandle.id);
      let synthSeq = 900_000;
      for (const callId of unresolvedCallIds) {
        let entry = diskByCallId.get(callId);
        if (!entry && unmatchedDisk.length > 0) {
          entry = unmatchedDisk.shift()!;
        } else if (entry) {
          const idx = unmatchedDisk.indexOf(entry);
          if (idx >= 0) unmatchedDisk.splice(idx, 1);
        }
        if (!entry) continue;
        const returnText = localPartsToText(entry.parts);
        const isError = entry.isError === true;
        const status = isError ? "error" : "success";
        const tr: ToolReturn = {
          tool_call_id: callId,
          status,
          func_response: returnText,
          stdout: null,
          stderr: null,
          type: "tool",
        };
        const imageParts = localPartsToImageParts(entry.parts);
        const toolReturnValue: unknown = imageParts.length > 0
          ? [...(returnText ? [{ type: "text", text: returnText }] : []), ...imageParts]
          : returnText;
        const frame: ToolReturnMessage = {
          id: `toolreturn-${callId}`,
          date: new Date().toISOString(),
          name: (entry.toolName as string | undefined) ?? null,
          message_type: "tool_return_message",
          otid: null,
          sender_id: null,
          step_id: null,
          is_err: isError ? true : null,
          seq_id: null,
          run_id: runHandle.id,
          tool_call_id: callId,
          status,
          tool_return: toolReturnValue as ToolReturnMessage["tool_return"],
          stdout: null,
          stderr: null,
          tool_returns: [tr],
        };
        try {
          const seq = ++synthSeq;
          appendFileSync(framesPath, JSON.stringify({ seq, ts: new Date().toISOString(), frame }) + "\n");
          (frame as unknown as Record<string, unknown>)["seq"] = seq;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[mobile-channel] lcp-4vz: failed to persist synthesized tool_return frame: ${msg}`);
        }
        onFrame(frame);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mobile-channel] lcp-4vz: tool_return synthesis failed: ${msg}`);
    }
  }

  // End-of-turn tail: stop_reason → usage_statistics. Assistant chunks
  // were already forwarded inline above. On authoritative user cancel the
  // SDK stream may not yield an upstream stop_reason, so synthesize the
  // terminal reason here before the plugin emits turn_done(cancelled).
  if (turn.cancelled) {
    pendingStop = {
      message_type: "stop_reason",
      stop_reason: "user_cancelled",
      run_id: runHandle.id,
    } as BridgeFrame;
    pendingUsage = null;
  }
  if (pendingStop) emit(pendingStop);
  if (pendingUsage) emit(pendingUsage);

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

  // Goal continuation (shim-side autonomous loop). Native /goal
  // auto-continuation is CLI-only; on this listener path we drive it here.
  // After a NON-continuation turn finishes for a conversation with an active
  // native goal, kick off the continuation driver. Continuation turns carry
  // an `otid` prefixed `goalcont-` and are skipped so the driver owns the
  // loop (single-flight + iteration cap + budget guards live in the driver).
  // Fire-and-forget: must not block the caller's turn result.
  if (!otid || !otid.startsWith("goalcont-")) {
    try {
      const { maybeContinue, configureGoalContinuationCancellation } = await import("./goal-continuation.js");
      configureGoalContinuationCancellation(cancelRun);
      void maybeContinue(effectiveConvId, effectiveAgentId, async (contArgs) => {
        let tokensUsed = 0;
        await bridgeSendMessage(
          contArgs,
          (frame) => {
            if ((frame as { message_type?: unknown }).message_type !== "usage_statistics") return;
            const totalTokens = (frame as { total_tokens?: unknown }).total_tokens;
            if (typeof totalTokens === "number" && Number.isFinite(totalTokens)) {
              tokensUsed += Math.max(0, Math.floor(totalTokens));
            }
          },
          contArgs.onRunCreated ? { onRunCreated: contArgs.onRunCreated } : {},
        );
        // Completion is detected via native goal status (update_goal); the
        // text-sentinel fallback is unused on this path.
        return { assistantText: "", usage: { tokensUsed } };
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[mobile-channel] goal-continuation hook failed: ${errMsg}`);
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
 * Phase 5: handle an inbound A2UI user_action frame. Approval actions resolve
 * pending dispatcher gates; non-approval actions with a resolvable run become
 * synthetic agent input; every action is recorded to the run sidecar.
 */
function handleUserAction(action: A2uiUserAction): A2uiUserActionAck {
  const actionId =
    typeof action.action_id === "string" && action.action_id.length > 0
      ? action.action_id
      : `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (typeof action.name !== "string" || action.name.length === 0) {
    return { action_id: actionId, status: "rejected", reason: "missing event name" };
  }
  const approvalDecision = approvalDecisionFromAction(action, actionId);
  // lcp-indw: WS is the canonical decision entrypoint. When a durable
  // pending-approval file exists (server-side permissions path), funnel the
  // decision through the SINGLE resolveApproval funnel so the durable file is
  // rewritten, the audit/policy recorded, the live gate resolved, and the
  // approval_resolved broadcast fired — exactly the same path REST uses. When
  // there is NO pending file (legacy live A2UI path, or feature off), fall
  // back to resolving the in-memory gate directly so behavior is unchanged.
  let matchedApproval = false;
  if (approvalDecision && action.run_id) {
    const hasPending = Boolean(readPendingApproval(action.run_id));
    if (hasPending) {
      const result = resolveApproval(action.run_id, approvalDecision);
      matchedApproval = result.found;
    } else {
      matchedApproval = resolveApprovalGate(action.run_id, approvalDecision);
    }
  }
  const syntheticInput = !approvalDecision ? syntheticInputFromAction(action, actionId) : null;
  const routedAs = matchedApproval
    ? "approval"
    : syntheticInput
      ? "synthetic_input"
      : "recorded_only";
  recordA2uiUserAction({
    run_id: action.run_id,
    session_id: action.session_id,
    turn_id: action.turn_id,
    surface_id: action.surface_id,
    component_id: action.component_id ?? null,
    name: action.name,
    context: action.context ?? {},
    action_id: actionId,
    routed_as: routedAs,
  });
  console.log(JSON.stringify({
    level: "info",
    module: "a2ui",
    event: "user_action_routed",
    run_id: action.run_id,
    surface_id: action.surface_id,
    component_id: action.component_id ?? null,
    action_name: action.name,
    action_id: actionId,
    routed_as: routedAs,
  }));
  if (syntheticInput) {
    return { action_id: actionId, status: "accepted", routed_as: routedAs, synthetic_input: syntheticInput };
  }
  return { action_id: actionId, status: "accepted", routed_as: routedAs };
}

function syntheticInputFromAction(
  action: A2uiUserAction,
  actionId: string,
): { agent_id: string; conversation_id: string; text: string } | null {
  // Tool-approval UI events are control-plane signals, not user prompts. The
  // stable dispatcher path is `tool_approval_response`; older/alternate card
  // names are recorded for audit but must not be injected as chat input.
  if (action.name.startsWith("tool_approval_")) return null;
  if (!action.run_id) return null;
  const run = getRun(action.run_id);
  if (!run?.agent_id || !run.conversation_id) return null;
  return {
    agent_id: run.agent_id,
    conversation_id: run.conversation_id,
    text: formatSyntheticA2uiAction(action, actionId),
  };
}

function formatSyntheticA2uiAction(action: A2uiUserAction, actionId: string): string {
  // lcp-crp follow-up: previous format read like a system log ("[system: A2UI
  // user action] event: demo.send context: {...}") so the LLM treated it as a
  // notification and responded in 7 tokens. Rephrase as a clear user-input
  // signal with the full context body inline so any data the mobile client
  // captures (TextField values, picker choices, form snapshots) is visible
  // to the agent without it having to parse "context: <json>" out of band.
  const componentId = action.component_id ?? componentIdFromContext(action.context) ?? null;
  const componentClause = componentId !== null ? ` (component "${componentId}")` : "";
  const ctx = action.context ?? {};
  const ctxHasData = Object.keys(ctx).length > 0;
  const ctxBody = ctxHasData ? JSON.stringify(ctx, null, 2) : "(no additional data)";
  return [
    "[User UI interaction via A2UI]",
    "",
    `The user performed the action "${action.name}" on surface "${action.surface_id ?? "(unspecified)"}"${componentClause}.`,
    "",
    "Data the user submitted with this interaction:",
    ctxBody,
    "",
    "Respond as you would to a normal user message based on this interaction. Treat the data above as the user's input.",
    `(traceId: ${actionId})`,
  ].join("\n");
}

function componentIdFromContext(context: Record<string, unknown>): string | null {
  const camel = context["componentId"];
  if (typeof camel === "string" && camel.length > 0) return camel;
  const snake = context["component_id"];
  if (typeof snake === "string" && snake.length > 0) return snake;
  const id = context["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

function approvalDecisionFromAction(
  action: A2uiUserAction,
  actionId: string,
): { decision: "approve" | "deny"; scope: ApprovalScope; reason: string; userId?: string; actionId: string } | null {
  if (action.name !== "tool_approval_response") return null;
  const context = action.context;
  const rawScope = typeof context["scope"] === "string" ? context["scope"] : "Once";
  const normalizedScope = normalizeApprovalScope(rawScope);
  if (!normalizedScope) return null;
  const rawDecision = context["decision"];
  const rawApprove = context["approve"];
  const decision: "approve" | "deny" =
    normalizedScope === "Deny" || rawDecision === "deny" || rawApprove === false
      ? "deny"
      : "approve";
  const reason = typeof context["reason"] === "string"
    ? context["reason"]
    : decision === "deny"
      ? "user_denied"
      : "user_approved";
  const userId = typeof context["user_id"] === "string" ? context["user_id"] : undefined;
  return {
    decision,
    scope: normalizedScope,
    reason,
    actionId,
    ...(userId ? { userId } : {}),
  };
}

function normalizeApprovalScope(value: string): ApprovalScope | null {
  switch (value.toLowerCase()) {
    case "once":
      return "Once";
    case "session":
      return "Session";
    case "forever":
      return "Forever";
    case "deny":
      return "Deny";
    default:
      return null;
  }
}

/**
 * lcp-p74.2: subscribe to a run's frame log. Replays every frame with
 * seq > cursor in original order, then live-tails new appends as the
 * worker continues to emit. Calls `onDone` once the run reaches a
 * terminal state AND the tail has caught up. Returns an `unsubscribe`
 * function the caller binds to its WS close handler.
 *
 * Errors via `onError` and stops: unknown runId (no frames.jsonl on
 * disk), file read failure. The function does NOT throw — callers
 * propagate via the error callback so the WS layer can map to a
 * protocol frame uniformly.
 */
export interface SubscribeToRunCallbacks {
  onFrame: (frame: unknown, seq: number) => void;
  onDone: (info: { last_seq: number; status: string }) => void;
  onError: (info: { code: string; message: string }) => void;
}

export function subscribeToRun(
  runId: string,
  cursor: number,
  cbs: SubscribeToRunCallbacks,
): { unsubscribe: () => void } {
  const path = getFramesFilePath(runId);
  if (!existsSync(path)) {
    cbs.onError({ code: "run_not_found", message: `no frames recorded for run ${runId}` });
    return { unsubscribe: () => {} };
  }

  let lastSeqSent = Math.max(0, Number.isFinite(cursor) ? cursor : 0);
  let stopped = false;
  let watcher: FSWatcher | null = null;
  let polling = false;
  let liveUnsubscribe: (() => void) | null = null;
  let terminalDrainTimer: NodeJS.Timeout | null = null;

  // lcp-2oxb.3: catch-up replay reads the whole file ONCE (and again only on
  // rare gap/terminal edges). Live tailing no longer re-reads the file per
  // append — frames arrive via the in-process subscribeLiveFrames fanout in
  // runs.ts, which is O(1) per frame. The fs.watch implementation below is
  // retained only as the fallback for runs with no in-memory handle (a
  // non-terminal run observed across a shim restart — rare, and the boot
  // sweep finalizes those shortly after).
  const readAndEmit = (): void => {
    if (stopped) return;
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cbs.onError({ code: "internal_error", message: `frames.jsonl read failed: ${msg}` });
      stop();
      return;
    }
    for (const line of body.split("\n")) {
      if (stopped) return;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: { seq?: number; frame?: unknown };
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // skip malformed (partial trailing line during a write race, etc.)
      }
      if (typeof obj.seq !== "number" || obj.seq <= lastSeqSent) continue;
      cbs.onFrame(obj.frame, obj.seq);
      lastSeqSent = obj.seq;
    }
  };

  const checkTerminalAndMaybeFinish = (): boolean => {
    if (stopped) return true;
    const run = getRun(runId);
    if (!run) return false;
    const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "expired";
    if (!terminal) return false;
    // Final tail to make sure we got everything written after the status
    // flip — finalizeRun writes run.json before any final flush of frames
    // in practice, but a defensive re-read closes the race.
    readAndEmit();
    if (!stopped) {
      cbs.onDone({ last_seq: lastSeqSent, status: run.status ?? "unknown" });
      stop();
    }
    return true;
  };

  function stop(): void {
    stopped = true;
    if (liveUnsubscribe) {
      liveUnsubscribe();
      liveUnsubscribe = null;
    }
    if (terminalDrainTimer) {
      clearTimeout(terminalDrainTimer);
      terminalDrainTimer = null;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mobile-channel] failed to close run subscription watcher for ${runId}: ${msg}`);
      }
      watcher = null;
    }
  }

  // Initial replay + immediate terminal check (handles already-completed runs).
  readAndEmit();
  if (checkTerminalAndMaybeFinish()) return { unsubscribe: stop };

  // lcp-2oxb.3: preferred live path — in-process fanout from runs.ts.
  // Frames are delivered O(1) per append; the disk file is only consulted
  // for the catch-up read above and the terminal tail re-read below.
  const live = subscribeLiveFrames(runId, lastSeqSent, (seq, frame) => {
    if (stopped) return;
    if (seq === -1) {
      // Terminal sentinel. The run finalized, but the late terminal tail
      // (stop_reason/usage, lcp-xu4l) is emitted by the WS host shortly
      // AFTER finalizeRun — those frames still flow through this listener.
      // Hold the subscription open briefly to drain them, then do one
      // last disk read (belt-and-braces for anything the ring missed) and
      // finish.
      const status =
        frame && typeof frame === "object" && typeof (frame as { __terminal__?: unknown }).__terminal__ === "string"
          ? (frame as { __terminal__: string }).__terminal__
          : "completed";
      if (terminalDrainTimer) return; // already draining
      // Drain budget: the late tail is emitted in the same macrotask chain
      // as finalizeRun (bridgeSendMessage's post-turn flush), so a small
      // budget suffices; tunable for slower hosts.
      const drainMs = Number(process.env["SHIM_SUBSCRIBE_TERMINAL_DRAIN_MS"] ?? 25);
      terminalDrainTimer = setTimeout(() => {
        if (stopped) return;
        readAndEmit();
        cbs.onDone({ last_seq: lastSeqSent, status });
        stop();
      }, drainMs);
      terminalDrainTimer.unref?.();
      return;
    }
    if (seq <= lastSeqSent) return;
    cbs.onFrame(frame, seq);
    lastSeqSent = seq;
  });

  if (live.ok) {
    liveUnsubscribe = live.unsubscribe;
    // Bridge the attach gap. If the ring has shifted past our cursor
    // (oldest buffered seq leaves a hole), fill from disk first.
    const oldest = live.ring[0];
    if (oldest && oldest.seq > lastSeqSent + 1) readAndEmit();
    for (const entry of live.ring) {
      if (stopped) break;
      if (entry.seq <= lastSeqSent) continue;
      cbs.onFrame(entry.frame, entry.seq);
      lastSeqSent = entry.seq;
    }
    // The run may have finalized between the catch-up read and the attach —
    // the sentinel would have fired before our listener existed.
    if (!stopped) checkTerminalAndMaybeFinish();
    return { unsubscribe: stop };
  }

  // Fallback: no in-memory handle (non-terminal run across a shim restart).
  // Legacy fs.watch tail — O(file) per change, acceptable for this rare
  // edge; the boot sweep finalizes such runs shortly after startup anyway.
  try {
    watcher = fsWatch(path, (eventType) => {
      if (stopped || polling) return;
      polling = true;
      try {
        if (eventType === "change") {
          readAndEmit();
          checkTerminalAndMaybeFinish();
        } else if (eventType === "rename") {
          cbs.onError({ code: "internal_error", message: "frames.jsonl was rotated or deleted during subscription" });
          stop();
        }
      } finally {
        polling = false;
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cbs.onError({ code: "internal_error", message: `fs.watch failed: ${msg}` });
    stop();
  }

  return { unsubscribe: stop };
}

// ── Cron WS handlers (lcp-2gx) ──────────────────────────────────
//
// Backed by lib/crons.ts. The same store the bundled letta-code self-schedule
// skill writes to, so frames here interoperate with that.
//
// After each successful mutation we broadcast a `client_mutation` cron event
// so peer WS clients receive a `crons_updated` push within a few hundred μs
// — the fs.watch path in cron-scheduler would also catch the write, but its
// 200ms debounce is slower than direct broadcast.

import {
  addTask as cronAddTask,
  deleteAllTasks as cronDeleteAllTasks,
  deleteTask as cronDeleteTask,
  getTask as cronGetTask,
  isValidCron,
  listTasks as cronListTasks,
  parseAt,
  parseEvery,
  getActiveTasks as cronGetActiveTasks,
} from "./crons.js";
import { broadcastCronEvent, subscribeCronEvents } from "./cron-events.js";
import { subscribeGoalEvents } from "./goal-events.js";
import { subscribeApprovalEvents } from "./approval-events.js";
import type {
  AddTaskInput,
  AddTaskResult,
  CronTask,
  ListTaskFilters,
} from "./types/crons.js";

export interface CronAddRequest {
  agent_id: string;
  conversation_id?: string;
  name?: string;
  description?: string;
  prompt: string;
  recurring?: boolean;
  cron?: string;
  every?: string;
  at?: string;
  timezone?: string;
}

export interface CronAddResponse {
  success: true;
  task: CronTask;
  warning?: string;
}

export interface CronErrorResponse {
  success: false;
  error: string;
}

/** Read a snapshot of crons. Agent_id alias is resolved before listing. */
export function handleCronList(filters: ListTaskFilters = {}): { tasks: CronTask[] } {
  const effective: ListTaskFilters = {};
  if (filters.agent_id) {
    effective.agent_id = resolveAgentIdAlias(filters.agent_id, (id) => getAgentRecord(id) != null);
  }
  if (filters.conversation_id) effective.conversation_id = filters.conversation_id;
  return { tasks: cronListTasks(effective) };
}

export function handleCronGet(taskId: string): CronTask | null {
  return cronGetTask(taskId);
}

/**
 * Validate + add a cron task. Supports raw `cron` expression or shortcuts
 * via `every` / `at`. Resolves agent_id alias before persistence.
 */
export function handleCronAdd(req: CronAddRequest): CronAddResponse | CronErrorResponse {
  if (!req.agent_id || typeof req.agent_id !== "string") {
    return { success: false, error: "agent_id is required" };
  }
  if (typeof req.prompt !== "string" || req.prompt.length === 0) {
    return { success: false, error: "prompt is required" };
  }

  const effectiveAgent = resolveAgentIdAlias(req.agent_id, (id) => getAgentRecord(id) != null);

  // Resolve schedule: exactly one of cron / every / at.
  let cronExpr: string | null = null;
  let scheduledFor: Date | undefined;
  let recurring = req.recurring ?? true;
  const provided = [req.cron, req.every, req.at].filter((v) => typeof v === "string" && v.length > 0).length;
  if (provided === 0) {
    return { success: false, error: "one of `cron`, `every`, or `at` is required" };
  }
  if (provided > 1) {
    return { success: false, error: "exactly one of `cron`, `every`, or `at` may be set" };
  }
  if (req.cron) {
    if (!isValidCron(req.cron)) {
      return { success: false, error: `invalid cron expression: ${req.cron}` };
    }
    cronExpr = req.cron;
  } else if (req.every) {
    const parsed = parseEvery(req.every);
    if (!parsed) return { success: false, error: `invalid every: ${req.every}` };
    cronExpr = parsed.cron;
    recurring = true;
  } else if (req.at) {
    const parsed = parseAt(req.at);
    if (!parsed) return { success: false, error: `invalid at: ${req.at}` };
    cronExpr = parsed.cron;
    scheduledFor = parsed.scheduledFor;
    recurring = false;
  }
  if (!cronExpr) {
    return { success: false, error: "could not resolve cron expression" };
  }

  const input: AddTaskInput = {
    agent_id: effectiveAgent,
    name: req.name ?? `task-${Date.now()}`,
    description: req.description ?? "",
    cron: cronExpr,
    recurring,
    prompt: req.prompt,
  };
  if (req.conversation_id) input.conversation_id = req.conversation_id;
  if (req.timezone) input.timezone = req.timezone;
  if (scheduledFor !== undefined) input.scheduled_for = scheduledFor;

  let result: AddTaskResult;
  try {
    result = cronAddTask(input);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  broadcastCronEvent({
    reason: "client_mutation",
    tasks_active: cronGetActiveTasks().length,
    at: new Date().toISOString(),
  });

  const response: CronAddResponse = { success: true, task: result.task };
  if (result.warning) response.warning = result.warning;
  return response;
}

export function handleCronDelete(taskId: string): { success: boolean; error?: string } {
  if (typeof taskId !== "string" || taskId.length === 0) {
    return { success: false, error: "task_id is required" };
  }
  const removed = cronDeleteTask(taskId);
  if (!removed) return { success: false, error: `task ${taskId} not found` };

  broadcastCronEvent({
    reason: "client_mutation",
    tasks_active: cronGetActiveTasks().length,
    at: new Date().toISOString(),
  });
  return { success: true };
}

export function handleCronDeleteAll(agentId: string): { success: boolean; count: number; error?: string } {
  if (typeof agentId !== "string" || agentId.length === 0) {
    return { success: false, count: 0, error: "agent_id is required" };
  }
  const effective = resolveAgentIdAlias(agentId, (id) => getAgentRecord(id) != null);
  const count = cronDeleteAllTasks(effective);
  if (count > 0) {
    broadcastCronEvent({
      reason: "client_mutation",
      tasks_active: cronGetActiveTasks().length,
      at: new Date().toISOString(),
    });
  }
  return { success: true, count };
}

// ── Active-subagent registry WS handlers (letta-mobile-73o2h.1) ───────

export function handleSubagentList(
  { all = false }: { all?: boolean } = {},
): { subagents: SubagentEntry[] } {
  return { subagents: all ? snapshotSubagents() : listActiveSubagents() };
}

export function handleSubagentTodos(
  toolCallId: string,
): {
  found: boolean;
  subagent: SubagentEntry | null;
  todos: TodoSnapshot["todos"];
  todos_found: boolean;
} {
  const subagent = getSubagent(toolCallId);
  if (!subagent) {
    return { found: false, subagent: null, todos: [], todos_found: false };
  }
  let snapshot: TodoSnapshot = { todos: [], found: false };
  if (subagent.subagentAgentId) {
    snapshot = readSubagentTodos(
      subagent.subagentAgentId,
      subagent.subagentConversationId ?? "default",
    );
  }
  return {
    found: true,
    subagent,
    todos: snapshot.todos,
    todos_found: snapshot.found,
  };
}

/** Re-export the registry event subscription for the host wiring. */
export { subscribeSubagentEvents };
export type { SubagentEntry, SubagentEvent };

// ── Reflection (sleeptime) settings WS handlers (lcp-4d5f) ──────────────
//
// Backed by lib/reflection-settings.ts. WS is the canonical mutation path
// (shim-new-features rule); REST mirrors the read side only
// (GET /v1/agents/:id/reflection in server.ts). Settings are applied as SDK
// `sleeptime` options on session resume, so after a successful set we
// recycle the agent's IDLE pool workers — the next turn then spawns a fresh
// session with the new settings. Busy workers are never touched; they pick
// up the change when they next recycle.

import {
  getReflectionSettings,
  setReflectionSettings,
  subscribeReflectionEvents,
  type ReflectionSettingsRecord,
  type SetReflectionSettingsInput,
} from "./reflection-settings.js";

export interface ReflectionSettingsGetResponse {
  success: true;
  agent_id: string;
  settings: ReflectionSettingsRecord;
}

export interface ReflectionSettingsSetResponse {
  success: true;
  agent_id: string;
  settings: ReflectionSettingsRecord;
  /** Idle pool workers recycled so the change applies on the next turn. */
  workers_recycled: number;
}

export function handleReflectionSettingsGet(
  agentId: string,
): ReflectionSettingsGetResponse | CronErrorResponse {
  if (typeof agentId !== "string" || agentId.length === 0) {
    return { success: false, error: "agent_id is required" };
  }
  const effective = resolveAgentIdAlias(agentId, (id) => getAgentRecord(id) != null);
  return { success: true, agent_id: effective, settings: getReflectionSettings(effective) };
}

export function handleReflectionSettingsSet(
  agentId: string,
  input: SetReflectionSettingsInput,
): ReflectionSettingsSetResponse | CronErrorResponse {
  if (typeof agentId !== "string" || agentId.length === 0) {
    return { success: false, error: "agent_id is required" };
  }
  const effective = resolveAgentIdAlias(agentId, (id) => getAgentRecord(id) != null);
  const result = setReflectionSettings(effective, input);
  if (!result.success) return { success: false, error: result.error };

  // Recycle idle workers for this agent so the new settings take effect on
  // the next turn instead of after the (potentially day-long) idle TTL.
  const pool = getAgentPool();
  let recycled = 0;
  for (const worker of [...pool.workers.values()]) {
    if (worker.agentId !== effective || worker.busy) continue;
    void pool.evict(worker.conversationId, worker.agentId).then((evicted) => {
      if (!evicted) {
        console.warn(`[reflection-settings] worker for ${effective} vanished before recycle`);
      }
    });
    recycled += 1;
  }

  return { success: true, agent_id: effective, settings: result.settings, workers_recycled: recycled };
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
 *  - `subscribeToRun(runId, cursor, cbs)` — lcp-p74.2 replay + live-tail
 *  - `handleCron*` — lcp-2gx WS-side CRUD for crons.json
 *  - `subscribeCronEvents(listener)` — register for crons_updated push
 *  - `subscribeGoalEvents(listener)` — register for goals_updated push
 */
interface MobileChannelHost {
  log: (msg: string) => void;
  getServerId: () => string;
  getA2uiServerCapabilities: typeof getA2uiServerCapabilities;
  bridgeSendMessage: typeof bridgeSendMessage;
  cancelRun: (runId: string) => boolean;
  /** lcp-rfb: bump adapter lastUsedAt so inbound WS frames prevent idle eviction. */
  touchAdapter: (conversationId: string, agentId: string) => void;
  handleUserAction: typeof handleUserAction;
  mobileConversationCursorCapabilities: typeof mobileConversationCursorCapabilities;
  stampConversationFrame: typeof stampConversationFrame;
  resumeConversation: typeof resumeConversation;
  ackConversation: typeof ackConversation;
  subscribeToRun: typeof subscribeToRun;
  handleCronList: typeof handleCronList;
  handleCronAdd: typeof handleCronAdd;
  handleCronGet: typeof handleCronGet;
  handleCronDelete: typeof handleCronDelete;
  handleCronDeleteAll: typeof handleCronDeleteAll;
  subscribeCronEvents: typeof subscribeCronEvents;
  subscribeGoalEvents: typeof subscribeGoalEvents;
  /** lcp-indw: per-connection subscription for approval_resolved pushes. */
  subscribeApprovalEvents: typeof subscribeApprovalEvents;
  /** lcp-4d5f: reflection (sleeptime) settings get/set + updated push. */
  handleReflectionSettingsGet: typeof handleReflectionSettingsGet;
  handleReflectionSettingsSet: typeof handleReflectionSettingsSet;
  subscribeReflectionEvents: typeof subscribeReflectionEvents;

  handleSubagentList: typeof handleSubagentList;
  handleSubagentTodos: typeof handleSubagentTodos;
  subscribeSubagentEvents: typeof subscribeSubagentEvents;
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
    touchAdapter: (convId: string, agId: string) => getAgentPool().touch(convId, agId),
    handleUserAction,
    mobileConversationCursorCapabilities,
    stampConversationFrame,
    resumeConversation,
    ackConversation,
    subscribeToRun,
    handleCronList,
    handleCronAdd,
    handleCronGet,
    handleCronDelete,
    handleCronDeleteAll,
    subscribeCronEvents,
    subscribeGoalEvents,
    subscribeApprovalEvents,
    handleReflectionSettingsGet,
    handleReflectionSettingsSet,
    subscribeReflectionEvents,
      handleSubagentList,
    handleSubagentTodos,
    subscribeSubagentEvents,
  };
  const adapter = await plugin.createAdapter(account, host);
  await adapter.start?.();
  log.log?.(`[mobile-channel] adapter ready (account=${account.accountId})`);
  return adapter;
}
