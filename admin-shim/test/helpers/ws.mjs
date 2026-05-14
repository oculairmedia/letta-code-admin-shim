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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_SHIM_ROOT = join(__dirname, "..", "..");
const shimRequire = createRequire(join(ADMIN_SHIM_ROOT, "package.json"));
const WebSocket = shimRequire("ws");

export async function openMobileWs(httpUrl, {
  token = "test-token-do-not-use-in-prod",
  deviceId = `test-${randomUUID().slice(0, 8)}`,
  clientVersion = "node-test/0.1",
  path = "/shim/v1/mobile",
  timeoutMs = 5000,
  skipHello = false,
} = {}) {
  const wsUrl = httpUrl.replace(/^http/, "ws") + path;
  const ws = new WebSocket(wsUrl);

  const frames = [];
  const handle = {
    ws,
    frames,
    sessionId: null,
    closed: false,
    closeCode: null,
    send(obj) {
      const frame = {
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
        const onMsg = (data) => {
          let f;
          try { f = JSON.parse(data.toString("utf8")); } catch { return; }
          if (f.type === type) {
            clearTimeout(t);
            ws.off("message", onMsg);
            resolve(f);
          }
        };
        ws.on("message", onMsg);
        ws.once("close", (code) => {
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

  ws.on("message", (data) => {
    let f;
    try { f = JSON.parse(data.toString("utf8")); } catch { return; }
    frames.push(f);
    if (f.type === "welcome") handle.sessionId = f.session_id;
  });
  ws.on("close", (code) => {
    handle.closed = true;
    handle.closeCode = code;
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    ws.once("open", () => { clearTimeout(t); resolve(); });
    ws.once("error", (err) => { clearTimeout(t); reject(err); });
  });

  if (!skipHello) {
    handle.send({
      type: "hello",
      token,
      device_id: deviceId,
      client_version: clientVersion,
    });
    await handle.waitFor("welcome", { timeoutMs });
  }

  return handle;
}
