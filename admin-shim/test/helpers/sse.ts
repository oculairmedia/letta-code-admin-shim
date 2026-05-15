/**
 * Helpers for talking to the shim's SSE streaming endpoint.
 *
 * Mobile (and the chat.mjs path) speak the bare-data SSE shape:
 *   data: <json>\n\n
 *   ...
 *   data: [DONE]\n\n
 *
 * `streamMessages(url, body, opts)` POSTs to a /messages endpoint and
 * returns a promise resolving to:
 *   { frames: Frame[], doneSeen: boolean, status: number, raw: string }
 *
 * Useful asserts to layer on top of this:
 *   - `frames.find(f => f.message_type === "assistant_message").content`
 *   - frame order matches vanilla contract
 *   - `[DONE]` terminator emitted
 *   - every turn frame carries the same `run_id`
 */

import type { LettaMessage } from "../../lib/types/wire.js";

/**
 * Frames parsed from the SSE stream. The shim writes JSON conforming to the
 * `LettaMessage` union (or close variants thereof); tests narrow per-case via
 * `message_type`. We keep a loose surface here so tests don't have to widen.
 */
export type SseFrame = LettaMessage & Record<string, unknown>;

export interface StreamMessagesOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface StreamMessagesResult {
  frames: SseFrame[];
  doneSeen: boolean;
  status: number;
  raw: string;
}

export async function streamMessages(
  url: string,
  body: unknown,
  {
    headers = {},
    timeoutMs = 15_000,
  }: StreamMessagesOptions = {},
): Promise<StreamMessagesResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    // We don't clear here; the consumer-loop below clears on completion.
  }
  const reader = res.body?.getReader();
  if (!reader) {
    clearTimeout(timer);
    return { frames: [], doneSeen: false, status: res.status, raw: "" };
  }
  const decoder = new TextDecoder("utf-8");
  let raw = "";
  const frames: SseFrame[] = [];
  let doneSeen = false;
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            doneSeen = true;
            continue;
          }
          try {
            frames.push(JSON.parse(payload) as SseFrame);
          } catch {
            // ignore malformed frames; the test will fail elsewhere
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { frames, doneSeen, status: res.status, raw };
}

/** Filter helper: framesOfType(frames, "assistant_message") */
export function framesOfType(frames: SseFrame[], type: string): SseFrame[] {
  return frames.filter((f) => f.message_type === type);
}

/** Index helper: indexOfType(frames, "stop_reason") returns -1 if missing. */
export function indexOfType(frames: SseFrame[], type: string): number {
  return frames.findIndex((f) => f.message_type === type);
}
