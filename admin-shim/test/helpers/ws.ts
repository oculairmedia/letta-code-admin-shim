/**
 * WebSocket test helper. Wraps the `ws` client with a frame collector,
 * hello/welcome handshake, and time-bound waiters for specific frame types.
 *
 * Typical use:
 *
 *   const conn = await openMobileWs(shim.url, { token: shim.mobileToken });
 *   conn.send({ type: "send_message", agent_id, conversation_id, text });
 *   const done = await conn.waitFor("turn_done", { timeoutMs: 5000 });
 *   conn.close();
 *
 * The `frames` array is the entire collected stream (mutable, append-only).
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { WebSocket as WsWebSocket, RawData } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_SHIM_ROOT = join(__dirname, "..", "..");
const shimRequire = createRequire(join(ADMIN_SHIM_ROOT, "package.json"));
// `ws` is CJS-friendly via require; load it through admin-shim's node_modules
// so we don't accidentally pull a copy from a parent project.
type WsCtor = new (url: string) => WsWebSocket;
const WebSocket = shimRequire("ws") as WsCtor;

/**
 * Frame shape received over the mobile channel. Mobile frames carry
 * `type` (mandatory), `session_id` on `welcome`, and arbitrary extras —
 * tests narrow per-case. Outgoing frames also pass through this surface
 * via `send()`, which stamps `v`, `id`, `ts`.
 */
export interface MobileWsFrame {
  type: string;
  session_id?: string;
  [k: string]: unknown;
}

export interface OpenMobileWsOptions {
  token?: string;
  deviceId?: string;
  clientVersion?: string;
  path?: string;
  timeoutMs?: number;
  skipHello?: boolean;
  helloExtras?: Record<string, unknown>;
}

export interface MobileWsHandle {
  ws: WsWebSocket;
  frames: MobileWsFrame[];
  sessionId: string | null;
  closed: boolean;
  closeCode: number | null;
  send(obj: { type: string } & Record<string, unknown>): MobileWsFrame;
  waitFor(type: string, opts?: { timeoutMs?: number }): Promise<MobileWsFrame>;
  collectTurn(opts?: { until?: string; timeoutMs?: number }): Promise<MobileWsFrame[]>;
  close(code?: number, reason?: string): void;
}

export async function openMobileWs(httpUrl: string, {
  token = "test-token-do-not-use-in-prod",
  deviceId = `test-${randomUUID().slice(0, 8)}`,
  clientVersion = "node-test/0.1",
  path = "/shim/v1/mobile",
  timeoutMs = 5000,
  skipHello = false,
  helloExtras = {},
}: OpenMobileWsOptions = {}): Promise<MobileWsHandle> {
  const wsUrl = httpUrl.replace(/^http/, "ws") + path;
  const ws = new WebSocket(wsUrl);

  const frames: MobileWsFrame[] = [];
  const handle: MobileWsHandle = {
    ws,
    frames,
    sessionId: null,
    closed: false,
    closeCode: null,
    send(obj) {
      const frame: MobileWsFrame = {
        v: 1,
        id: randomUUID(),
        ts: new Date().toISOString(),
        ...obj,
      };
      ws.send(JSON.stringify(frame));
      return frame;
    },
    /**
     * Wait until a frame of `type` arrives. Resolves with the frame.
     * Rejects on timeout or socket close.
     */
    waitFor(type, { timeoutMs = 5000 } = {}) {
      const existing = frames.find((f) => f.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          reject(new Error(`waitFor(${type}) timed out after ${timeoutMs}ms (frames: ${frames.map((f) => f.type).join(",")})`));
        }, timeoutMs);
        const onMsg = (data: RawData) => {
          let f: MobileWsFrame;
          try { f = JSON.parse(data.toString("utf8")) as MobileWsFrame; } catch { return; }
          if (f.type === type) {
            clearTimeout(t);
            ws.off("message", onMsg);
            resolve(f);
          }
        };
        ws.on("message", onMsg);
        ws.once("close", (code: number) => {
          clearTimeout(t);
          reject(new Error(`socket closed (code=${code}) before ${type}`));
        });
      });
    },
    /** Collect all frames between now and stop_reason or turn_done. */
    async collectTurn({ until = "turn_done", timeoutMs = 15_000 } = {}) {
      const before = frames.length;
      await handle.waitFor(until, { timeoutMs });
      return frames.slice(before);
    },
    close(code = 1000, reason = "test done") {
      try { ws.close(code, reason); } catch {}
    },
  };

  ws.on("message", (data: RawData) => {
    let f: MobileWsFrame;
    try { f = JSON.parse(data.toString("utf8")) as MobileWsFrame; } catch { return; }
    frames.push(f);
    if (f.type === "welcome" && typeof f.session_id === "string") {
      handle.sessionId = f.session_id;
    }
  });
  ws.on("close", (code: number) => {
    handle.closed = true;
    handle.closeCode = code;
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    ws.once("open", () => { clearTimeout(t); resolve(); });
    ws.once("error", (err: Error) => { clearTimeout(t); reject(err); });
  });

  if (!skipHello) {
    handle.send({
      type: "hello",
      token,
      device_id: deviceId,
      client_version: clientVersion,
      ...helloExtras,
    });
    await handle.waitFor("welcome", { timeoutMs });
  }

  return handle;
}
