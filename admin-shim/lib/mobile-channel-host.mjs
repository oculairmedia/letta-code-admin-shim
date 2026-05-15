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

import { reshapeFrame } from "./chat.mjs";
import { cancelRun, getAgentPool } from "./agent-pool.js";
import {
  findUnmappedTailUserMessageId,
  resolveConversationId,
  writeOtidForLocalId,
} from "./store.js";

function channelDir() {
  const root = process.env.LETTA_HOME || join(homedir(), ".letta");
  return join(root, "channels", "mobile");
}

function loadAccount() {
  const path = join(channelDir(), "accounts.json");
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8"));
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  return accounts.find((a) => a.enabled !== false && a.channel === "mobile") ?? null;
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
  { agent_id, conversation_id, text, otid },
  onFrame,
  { onRunCreated } = {},
) {
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
  const resolved = resolveConversationId(conversation_id);
  const effectiveAgentId = resolved?.agentId ?? agent_id;
  const effectiveConvId = resolved?.conversationId ?? conversation_id;

  const pool = getAgentPool();
  const worker = await pool.get(effectiveConvId, effectiveAgentId);

  // Buffer assistant_message chunks for server-side coalescing so the
  // mobile channel matches vanilla's "one assistant_message per turn"
  // contract — identical to how the REST stream path coalesces.
  let pendingAssistant = null;
  let pendingStop = null;
  let pendingUsage = null;

  const flushPendingAssistant = () => {
    if (pendingAssistant) {
      onFrame(pendingAssistant);
      pendingAssistant = null;
    }
  };

  const turn = await worker.runTurn(text, {
    onRunCreated: (runId) => {
      if (typeof onRunCreated === "function") {
        try { onRunCreated(runId); } catch {}
      }
    },
    onFrame: (raw, meta) => {
      const reshaped = reshapeFrame(raw);
      if (!reshaped) return;
      // Stamp the run_id on every reshaped frame for mobile-side correlation
      // with /v1/runs/{id}. The pool exposes it via the meta callback arg.
      if (meta?.runId) reshaped.run_id = meta.runId;
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
          pendingAssistant.otid &&
          pendingAssistant.otid === reshaped.otid
        ) {
          pendingAssistant.content =
            (pendingAssistant.content ?? "") + (reshaped.content ?? "");
          pendingAssistant.id = reshaped.id;
          pendingAssistant.date = reshaped.date;
          pendingAssistant.seq_id = reshaped.seq_id;
          return;
        }
        flushPendingAssistant();
        pendingAssistant = { ...reshaped };
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
      const localId = findUnmappedTailUserMessageId(effectiveConvId, effectiveAgentId);
      if (localId) writeOtidForLocalId(effectiveConvId, effectiveAgentId, localId, otid);
    } catch (err) {
      console.error(`[mobile-channel] otid bind failed: ${err.message}`);
    }
  }

  return turn;
}

let cachedAdapter = null;

/**
 * Load the mobile channel plugin and create the adapter. Memoized.
 * Returns null if the channel isn't configured (no accounts.json or
 * no enabled account).
 */
export async function getMobileChannelAdapter({ getServerId, log = console }) {
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
  const module = await import(pathToFileURL(pluginPath).href);
  const plugin = module.channelPlugin ?? module.default;
  if (!plugin || typeof plugin.createAdapter !== "function") {
    log.log?.("[mobile-channel] plugin malformed (no createAdapter)");
    return null;
  }
  const host = {
    log: (msg) => log.log?.(msg),
    getServerId,
    bridgeSendMessage,
    cancelRun: (runId) => cancelRun(runId),
  };
  const adapter = await plugin.createAdapter(account, host);
  await adapter.start?.();
  cachedAdapter = adapter;
  log.log?.(`[mobile-channel] adapter ready (account=${account.accountId})`);
  return adapter;
}
