/**
 * letta-mobile-jb4gu — bridgeSendMessage turn-end settle hook.
 *
 * The main agent's session-task calls (TaskCreate/TaskUpdate) are handled
 * client-side and NEVER cross the shim as tool_call frames, so live ingest
 * (planCallsFromFrame -> 0) can never populate the self-todo snapshot for
 * them. The ONLY way to surface them is a disk re-read AFTER the turn
 * settles.
 *
 * SELF_TODO_DEBUG=1 on the live shim proved the pre-existing settle hook
 * (refreshSelfTodoFromDisk wired into finalizeTurnLifecycle) NEVER runs on
 * the bridgeSendMessage -> pool.runTurnWithHeal driver these turns take. The
 * fix wires refreshSelfTodoFromDisk directly onto the PROVEN-firing path:
 * immediately after `await pool.runTurnWithHeal(...)` returns in
 * bridgeSendMessage.
 *
 * This test exercises that exact path: it injects a fake pool whose
 * runTurnWithHeal resolves (without emitting any frame, mirroring the live
 * session-task turns where no plan-carrying tool_call frame is emitted),
 * seeds the conversation transcript on disk with TaskCreate calls, drives a
 * turn through bridgeSendMessage, and asserts the settle hook fired:
 *   - a self-todo CHANGE event was emitted (the disk re-read found the tasks
 *     and refreshSelfTodoFromDisk emitted), and
 *   - getSelfTodoSnapshot(conv) is now populated with those tasks.
 * Both effects are produced ONLY by refreshSelfTodoFromDisk running on the
 * turn-end path — the fake pool emits nothing, so live ingest contributes
 * nothing.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bridgeSendMessage } from "../lib/mobile-channel-host.js";
import {
  __resetSelfTodo,
  getSelfTodoSnapshot,
  subscribeSelfTodoEvents,
  type SelfTodoEvent,
} from "../lib/self-todo.js";
import {
  __setAgentPoolForTest,
  type AdapterRunTurnResult,
} from "../lib/agent-pool.js";

/** The (unexported) AgentPool shape `__setAgentPoolForTest` accepts. */
type AgentPoolArg = NonNullable<Parameters<typeof __setAgentPoolForTest>[0]>;

const STORE_DIR = mkdtempSync(join(tmpdir(), "shim-bridge-selftodo-"));
process.env["LETTA_LOCAL_BACKEND_DIR"] = STORE_DIR;

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
function conversationKey(conversationId: string, agentId: string): string {
  return conversationId === "default" ? `default:${agentId}` : `conversation:${conversationId}`;
}
function writeMessages(conversationId: string, agentId: string, lines: unknown[]): void {
  const dir = join(STORE_DIR, "conversations", b64url(conversationKey(conversationId, agentId)));
  mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(dir, "messages.jsonl"), body, "utf8");
}
function userMsg(id: string, text: string) {
  return { id, role: "user", content: [{ type: "text", text }] };
}
function taskCallMsg(id: string, name: "TaskCreate" | "TaskUpdate", args: unknown) {
  return {
    id,
    role: "assistant",
    content: [{ type: "toolCall", id: `tc-${id}`, name, arguments: args }],
  };
}

beforeEach(() => {
  __resetSelfTodo();
});
afterEach(() => {
  __setAgentPoolForTest(null);
  __resetSelfTodo();
});

test("bridgeSendMessage: turn-end settle hook refreshes the self-todo snapshot from disk", async () => {
  const agentId = "agent-local-settle-1";
  const conversationId = "conv-settle-abc123";

  // The transcript the CLI/headless backend wrote during the turn: the main
  // agent's session tasks land ONLY as TaskCreate calls on disk (no
  // tool_call frame crosses the shim).
  writeMessages(conversationId, agentId, [
    userMsg("u1", "plan it"),
    taskCallMsg("a1", "TaskCreate", { subject: "Validate the self chip renders", activeForm: "Validating the self chip renders" }),
    taskCallMsg("a2", "TaskCreate", { subject: "Confirm progress updates", activeForm: "Confirming progress updates" }),
  ]);

  // Fake pool: runTurnWithHeal resolves WITHOUT emitting any frame — exactly
  // like the live session-task turns. If the snapshot becomes populated, it
  // can ONLY have come from the post-await disk re-read (the settle hook).
  let runTurnCalled = 0;
  const fakePool = {
    runTurnWithHeal: async (
      _conversationId: string,
      _agentId: string,
      _input: string | unknown[],
    ): Promise<AdapterRunTurnResult> => {
      runTurnCalled += 1;
      return { frames: [], stderr: "" };
    },
  } as unknown as AgentPoolArg;
  __setAgentPoolForTest(fakePool);

  // Sanity: nothing is in the live snapshot before the turn.
  assert.equal(getSelfTodoSnapshot(conversationId), null, "snapshot must start empty");

  const events: SelfTodoEvent[] = [];
  const unsub = subscribeSelfTodoEvents((e) => events.push(e));

  try {
    await bridgeSendMessage(
      { agent_id: agentId, conversation_id: conversationId, text: "plan it" },
      () => {
        /* no frames emitted by the fake pool */
      },
    );
  } finally {
    unsub();
  }

  assert.equal(runTurnCalled, 1, "the awaited pool.runTurnWithHeal must have driven the turn");

  // The settle hook ran refreshSelfTodoFromDisk AFTER the awaited turn and
  // emitted a change carrying the on-disk session tasks.
  assert.equal(events.length, 1, "exactly one self-todo change event should fire from the settle hook");
  const emitted = events[0]!;
  assert.equal(emitted.conversationId, conversationId);
  assert.deepEqual(
    emitted.todos.map((t) => t.content),
    ["Validate the self chip renders", "Confirm progress updates"],
  );

  // ...and the live snapshot is now populated (so a subscribed socket / the
  // server broadcast delivers the chip).
  const snap = getSelfTodoSnapshot(conversationId);
  assert.ok(snap, "getSelfTodoSnapshot must be populated by the settle hook");
  assert.equal(snap!.agentId, agentId);
  assert.deepEqual(
    snap!.todos.map((t) => t.content),
    ["Validate the self chip renders", "Confirm progress updates"],
  );
});

test("bridgeSendMessage: settle hook is a no-op when the conversation has no plan on disk", async () => {
  const agentId = "agent-local-settle-2";
  const conversationId = "conv-settle-empty";

  // A transcript with no Task*/TodoWrite calls — the settle hook must not
  // invent a snapshot or emit a spurious change.
  writeMessages(conversationId, agentId, [userMsg("u1", "hi there")]);

  const fakePool = {
    runTurnWithHeal: async (): Promise<AdapterRunTurnResult> => ({ frames: [], stderr: "" }),
  } as unknown as AgentPoolArg;
  __setAgentPoolForTest(fakePool);

  const events: SelfTodoEvent[] = [];
  const unsub = subscribeSelfTodoEvents((e) => events.push(e));
  try {
    await bridgeSendMessage(
      { agent_id: agentId, conversation_id: conversationId, text: "hi there" },
      () => undefined,
    );
  } finally {
    unsub();
  }

  assert.equal(events.length, 0, "no plan on disk -> no self-todo change event");
  assert.equal(getSelfTodoSnapshot(conversationId), null, "no plan on disk -> snapshot stays empty");
});

process.on("exit", () => {
  try {
    rmSync(STORE_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
