/**
 * Host-capability composition for channel adapters.
 *
 * Extraction, not rewrite: the object built here is the exact host
 * literal the mobile WS path constructed inline in
 * `mobile-channel-host.ts` (createMobileChannelAdapter). Factoring it out
 * lets the generic channel registry (lib/channel-registry.ts) hand every
 * plugin — matrix, future channels — the SAME bridge into the agent pool,
 * run registry, frames.jsonl, and goal continuation that mobile uses
 * today. Nothing about bridge semantics, cm-stream/cm-reason otid
 * stamping, or seq handling moves or changes.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { cancelRun, getAgentPool } from "./agent-pool.js";
import { getA2uiServerCapabilities } from "./a2ui-adapter.js";
import {
  ackConversation,
  mobileConversationCursorCapabilities,
  resumeConversation,
  stampConversationFrame,
  subscribeConversationEvents,
} from "./mobile-conversation-cursors.js";
import { subscribeCronEvents } from "./cron-events.js";
import { subscribeAgentEvents } from "./agent-events.js";
import { subscribeGoalEvents } from "./goal-events.js";
import { subscribeApprovalEvents } from "./approval-events.js";
import { subscribeReflectionEvents } from "./reflection-settings.js";
import { channelLogDir } from "./channel-paths.js";
import { scrubSecrets } from "./channel-config.js";
import {
  bridgeSendMessage,
  handleCronAdd,
  handleCronDelete,
  handleCronDeleteAll,
  handleCronGet,
  handleCronList,
  handleReflectionSettingsGet,
  handleReflectionSettingsSet,
  handleSubagentList,
  handleSubagentTodos,
  handleUserAction,
  subscribeSubagentEvents,
  subscribeToRun,
  type MobileChannelHost,
} from "./mobile-channel-host.js";

export interface ChannelHostOptions {
  log: { log(msg: string): void };
  getServerId(): string;
}

/**
 * Build the `host` object handed to a channel plugin's `createAdapter`.
 * Wires exactly what mobile wires today — one agent pool, one bridge.
 */
export function buildChannelHost(options: ChannelHostOptions): MobileChannelHost {
  return {
    log: (msg: string) => options.log.log(msg),
    getServerId: () => options.getServerId(),
    getA2uiServerCapabilities,
    bridgeSendMessage,
    cancelRun: (runId: string) => cancelRun(runId),
    touchAdapter: (convId: string, agId: string) => getAgentPool().touch(convId, agId),
    handleUserAction,
    mobileConversationCursorCapabilities,
    stampConversationFrame,
    resumeConversation,
    ackConversation,
    subscribeConversationEvents,
    subscribeToRun,
    handleCronList,
    handleCronAdd,
    handleCronGet,
    handleCronDelete,
    handleCronDeleteAll,
    subscribeCronEvents,
    subscribeAgentEvents,
    subscribeGoalEvents,
    subscribeApprovalEvents,
    handleReflectionSettingsGet,
    handleReflectionSettingsSet,
    subscribeReflectionEvents,
    handleSubagentList,
    handleSubagentTodos,
    subscribeSubagentEvents,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Per-adapter logger
// ──────────────────────────────────────────────────────────────────────

const LOG_RING_SIZE = 500;
const LOG_FILE_CAP_BYTES = 10 * 1024 * 1024; // 10 MiB, single .1 rotation

export interface AdapterLog {
  log(msg: string): void;
  /** In-memory ring buffer of the most recent (scrubbed) lines, oldest first. */
  ring(): string[];
}

/**
 * Logger the registry hands each adapter's host object. Every line is:
 *  - scrubbed of any registered secret value (see channel-config.ts) —
 *    guards host-originated lines; plugins that log via console.error
 *    bypass this object by design,
 *  - written as `[<channelId>:<accountId>] <msg>` to the shim's stderr log,
 *  - appended to `<channelDir>/logs/<accountId>.log` (10 MiB cap, single
 *    `.1` rotation),
 *  - kept in a 500-entry ring surfaced by the status API.
 *
 * Logging must never throw into a plugin or the registry: every I/O step
 * is individually best-effort.
 */
export function makeAdapterLog(channelId: string, accountId: string): AdapterLog {
  const ring: string[] = [];
  const logDir = channelLogDir(channelId);
  const logPath = join(logDir, `${accountId}.log`);

  return {
    log(msg: string): void {
      const scrubbed = scrubSecrets(String(msg));
      const line = `[${channelId}:${accountId}] ${scrubbed}`;
      try {
        console.error(line);
      } catch {}
      ring.push(scrubbed);
      if (ring.length > LOG_RING_SIZE) ring.splice(0, ring.length - LOG_RING_SIZE);
      try {
        mkdirSync(logDir, { recursive: true });
        if (existsSync(logPath) && statSync(logPath).size >= LOG_FILE_CAP_BYTES) {
          renameSync(logPath, `${logPath}.1`);
        }
        appendFileSync(logPath, `${new Date().toISOString()} ${scrubbed}\n`);
      } catch {
        // Disk logging is best-effort; stderr + ring already have the line.
      }
    },
    ring: () => [...ring],
  };
}
