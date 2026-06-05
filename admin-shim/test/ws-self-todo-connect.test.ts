/**
 * Regression: self-todo snapshot is PUSHED on a plain connect, not only on an
 * explicit resume_conversation (letta-mobile-jb4gu).
 *
 * Root cause this pins: the phone's normal open flow is `hello` + push-register
 * WITHOUT a `resume_conversation`. Before the fix, pushSelfTodoSnapshot() was
 * invoked ONLY from the resume_conversation handler, so on a plain reconnect the
 * disk-backed self-todo snapshot was never sent and the self chip stayed empty.
 *
 * These tests drive the real .mjs ws-handler with a fake socket + mock host so
 * they're deterministic (no model turn, no disk fixtures) and assert:
 *   1. hello.resume → the snapshot frame is built + sent on connect.
 *   2. The push is guarded: building it once per conversation, never twice when
 *      resume_conversation (or a later send_message) fires for the same conv.
 *   3. A conversation first seen via resume_conversation (no hello.resume) still
 *      hydrates exactly once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

// The handler under test is a channel-plugin .mjs that is intentionally NOT
// part of the shim's TypeScript build (no tsc for the channel tree). Load it
// via a runtime-resolved dynamic import so `tsc --noEmit` doesn't pull the
// untyped .mjs body into the type-check graph.
const wsHandlerUrl = new URL(
  "../../home/.letta/channels/mobile/lib/ws-handler.mjs",
  import.meta.url,
);
type HandleConnection = (ws: unknown, request: unknown, host: unknown) => void;
const { handleConnection } = (await import(fileURLToPath(wsHandlerUrl))) as {
  handleConnection: HandleConnection;
};

const PROTOCOL_VERSION = 1;

/** A minimal fake `ws` the handler can drive: EventEmitter + send/close spies. */
function makeFakeWs(): {
  ws: EventEmitter & { send: (s: string) => void; close: (code?: number, reason?: string) => void };
  sent: unknown[];
  emitClientFrame: (frame: Record<string, unknown>) => void;
} {
  const sent: unknown[] = [];
  const ws = new EventEmitter() as EventEmitter & {
    send: (s: string) => void;
    close: (code?: number, reason?: string) => void;
  };
  ws.send = (s: string): void => {
    try {
      sent.push(JSON.parse(s));
    } catch {
      sent.push(s);
    }
  };
  ws.close = (): void => {
    ws.emit("close", 1000);
  };
  const emitClientFrame = (frame: Record<string, unknown>): void => {
    ws.emit("message", Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }), "utf8"));
  };
  return { ws, sent, emitClientFrame };
}

interface BuildCall {
  conversationId: string;
  agentIdHint: string | null;
}

/** A mock host wired with just enough to exercise hello + resume_conversation. */
function makeMockHost(buildCalls: BuildCall[]): Record<string, unknown> {
  return {
    log: () => {},
    getToken: () => "", // tokenless: any hello accepted (mirrors dev box)
    getServerId: () => "srv-test",
    config: { idleTimeoutMs: 60_000, pingIntervalMs: 60_000 },
    mobileConversationCursorCapabilities: () => ({}),
    stampConversationFrame: (_conv: string, frame: unknown) => frame,
    registerPushClient: () => () => {},
    // resume_conversation handler needs a resume result; return an empty replay.
    resumeConversation: (conversationId: string, afterSeq: number) => ({
      cursorExpired: false,
      conversationId,
      afterSeq,
      oldestSeq: null,
      lastSeq: afterSeq,
      frames: [],
    }),
    // The push under test: record each invocation and return a TodoWrite-shaped
    // frame so the handler emits a `tool_call_message`.
    buildSelfTodoSnapshotFrame: (conversationId: string, agentIdHint: string | null) => {
      buildCalls.push({ conversationId, agentIdHint: agentIdHint ?? null });
      return {
        message_type: "tool_call_message",
        agent_id: "agent-x",
        conversation_id: conversationId,
        turn_id: "turn-self-todo",
        run_id: "run-self-todo",
        tool_call: { name: "TodoWrite", tool_call_id: "tc-1", arguments: JSON.stringify({ todos: [] }) },
      };
    },
    subscribeSelfTodoEvents: () => () => {},
  };
}

function selfTodoFramesSent(sent: unknown[]): unknown[] {
  return sent.filter(
    (f) =>
      f &&
      typeof f === "object" &&
      (f as { type?: string }).type === "tool_call_message" &&
      (f as { tool_call?: { name?: string } }).tool_call?.name === "TodoWrite",
  );
}

test("ws self-todo: hello.resume pushes the self-todo snapshot on plain connect", async () => {
  const buildCalls: BuildCall[] = [];
  const { ws, sent, emitClientFrame } = makeFakeWs();
  handleConnection(ws, {}, makeMockHost(buildCalls));

  emitClientFrame({
    type: "hello",
    device_id: "dev-connect",
    resume: { conversation_id: "conv-abc", after_seq: 0 },
  });
  // Let the async push (void pushSelfTodoSnapshot) settle.
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(buildCalls.length, 1, "snapshot must be built exactly once on connect");
  assert.equal(buildCalls[0]!.conversationId, "conv-abc");
  const pushed = selfTodoFramesSent(sent);
  assert.equal(pushed.length, 1, "exactly one TodoWrite tool_call_message must be pushed on connect");
});

test("ws self-todo: connect + resume_conversation for the SAME conv pushes ONCE (double-push guard)", async () => {
  const buildCalls: BuildCall[] = [];
  const { ws, emitClientFrame } = makeFakeWs();
  handleConnection(ws, {}, makeMockHost(buildCalls));

  // Plain connect already hydrated conv-abc via hello.resume...
  emitClientFrame({
    type: "hello",
    device_id: "dev-guard",
    resume: { conversation_id: "conv-abc", after_seq: 0 },
  });
  await new Promise((r) => setTimeout(r, 20));
  // ...then an explicit resume_conversation arrives for the same conv.
  emitClientFrame({ type: "resume_conversation", conversation_id: "conv-abc", after_seq: 0 });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(buildCalls.length, 1, "snapshot must not be re-pushed for an already-hydrated conversation");
});

test("ws self-todo: resume_conversation hydrates a conv not yet seen (exactly once)", async () => {
  const buildCalls: BuildCall[] = [];
  const { ws, emitClientFrame } = makeFakeWs();
  handleConnection(ws, {}, makeMockHost(buildCalls));

  // hello with NO resume — conversation unknown at connect.
  emitClientFrame({ type: "hello", device_id: "dev-resume-only" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(buildCalls.length, 0, "no conversation known yet → no push");

  emitClientFrame({ type: "resume_conversation", conversation_id: "conv-zzz", after_seq: 0 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(buildCalls.length, 1, "resume_conversation hydrates the newly-known conversation once");
  assert.equal(buildCalls[0]!.conversationId, "conv-zzz");

  // A second resume_conversation for the same conv must not re-push.
  emitClientFrame({ type: "resume_conversation", conversation_id: "conv-zzz", after_seq: 0 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(buildCalls.length, 1, "second resume_conversation for the same conv is guarded");
});
