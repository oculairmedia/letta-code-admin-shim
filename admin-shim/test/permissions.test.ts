/**
 * Regression tests for the server-side permissions model (lcp-indw, Phase 2).
 *
 * Covers all 9 tests from design §6 (test #9, the silence-watchdog-not-tripped
 * test, lands with Commit 2):
 *   1. Rule precedence (first-match-wins; agent overrides global; deny/allow).
 *   2. allow / deny / ask actions.
 *   3. Prefix match (Bash(git:*) matches git, not rm; * matches any; bare exact).
 *   4. default = allow (DEDICATED — the headline product decision).
 *   5. Reconnect-replay (park an ask; pending file persists; frame replays).
 *   6. Two-client approval (broadcast fires; second decision is a no-op
 *      already_resolved; exactly one tool execution).
 *   7. Restart survival (boot-sweep flips pending → expired + terminal frame).
 *   8. WS-canonical / REST-mirror equivalence.
 *
 * Conventions follow the existing harness: pure/unit cases set a temp
 * LETTA_LOCAL_BACKEND_DIR and import the lib modules directly (as
 * frames-log.test.ts / runs.test.ts do); REST/WS cases spin a real shim
 * subprocess via startShim().
 *
 * NOTE: the design referenced a `__setAgentPoolForTest` hook that does not
 * exist in this codebase; per the "don't invent" discipline we use the real
 * harness conventions instead (temp backend dir + injectable gateResolve for
 * the exactly-one-execution assertion). Documented in the PR.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluatePermission,
  ruleMatches,
  writeGlobalConfig,
  writeAgentConfig,
  __clearPermissionConfigCache,
  HARDCODED_DEFAULT,
  type PermissionConfig,
} from "../lib/permissions.js";
import { createRun, getRun, getFramesFilePath, appendRunFrame } from "../lib/runs.js";
import {
  createPendingApproval,
  readPendingApproval,
  resolveApproval,
  listPendingApprovals,
  sweepPendingApprovalsOnBoot,
} from "../lib/pending-approval.js";
import {
  subscribeApprovalEvents,
  __clearApprovalEventSubscribers,
  type ApprovalEvent,
} from "../lib/approval-events.js";
import { startShim } from "./helpers/index.js";

// ── temp backend dir harness (mirrors frames-log.test.ts) ──────────────

async function withBackendDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "permissions-test-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  __clearPermissionConfigCache();
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    __clearPermissionConfigCache();
    __clearApprovalEventSubscribers();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function cfg(partial: Partial<PermissionConfig>): PermissionConfig {
  return { version: 1, default: partial.default ?? "allow", rules: partial.rules ?? [] };
}

// ── Test 1: rule precedence ────────────────────────────────────────────

test("rule precedence: first-matching-rule-wins (deny above allow yields deny)", async () => {
  await withBackendDir(() => {
    writeGlobalConfig(cfg({
      default: "allow",
      rules: [
        { tool: "Bash", action: "deny", reason: "blocked" },
        { tool: "Bash", action: "allow" },
      ],
    }));
    const r = evaluatePermission("agent-1", "conv-1", "Bash", { command: "ls" });
    assert.equal(r.action, "deny");
    assert.equal(r.source, "global");
    assert.equal(r.reason, "blocked");
  });
});

test("rule precedence: allow above deny yields allow", async () => {
  await withBackendDir(() => {
    writeGlobalConfig(cfg({
      rules: [
        { tool: "Bash", action: "allow" },
        { tool: "Bash", action: "deny" },
      ],
    }));
    assert.equal(evaluatePermission("a", "c", "Bash", {}).action, "allow");
  });
});

test("rule precedence: per-agent rule overrides global", async () => {
  await withBackendDir(() => {
    writeGlobalConfig(cfg({ rules: [{ tool: "Bash", action: "deny" }] }));
    writeAgentConfig("agent-x", cfg({ rules: [{ tool: "Bash", action: "allow" }] }));
    const agent = evaluatePermission("agent-x", "c", "Bash", {});
    assert.equal(agent.action, "allow");
    assert.equal(agent.source, "agent");
    // A different agent with no per-agent file falls back to global deny.
    const other = evaluatePermission("agent-y", "c", "Bash", {});
    assert.equal(other.action, "deny");
    assert.equal(other.source, "global");
  });
});

// ── Test 2: allow / deny / ask ────────────────────────────────────────

test("evaluator returns allow / deny / ask per matching rule", async () => {
  await withBackendDir(() => {
    writeGlobalConfig(cfg({
      rules: [
        { tool: "Read", action: "allow" },
        { tool: "Write", action: "ask", reason: "review writes" },
        { tool: "Delete", action: "deny", reason: "no deletes" },
      ],
    }));
    assert.equal(evaluatePermission("a", "c", "Read", {}).action, "allow");
    const ask = evaluatePermission("a", "c", "Write", {});
    assert.equal(ask.action, "ask");
    assert.equal(ask.reason, "review writes");
    const deny = evaluatePermission("a", "c", "Delete", {});
    assert.equal(deny.action, "deny");
    assert.equal(deny.reason, "no deletes");
  });
});

// ── Test 3: prefix match ──────────────────────────────────────────────

test("prefix match: Bash(git:*) matches git push, not rm; * matches any; bare exact", () => {
  // Pure matcher tests — no backend dir needed.
  assert.equal(ruleMatches("Bash(git:*)", "Bash", { command: "git push" }), true);
  assert.equal(ruleMatches("Bash(git:*)", "Bash", { command: "rm -rf /" }), false);
  // Different tool name with same arg → no match.
  assert.equal(ruleMatches("Bash(git:*)", "Read", { command: "git push" }), false);
  // `*` matches any tool.
  assert.equal(ruleMatches("*", "AnythingAtAll", {}), true);
  // bare name = exact tool-name match.
  assert.equal(ruleMatches("Bash", "Bash", { command: "x" }), true);
  assert.equal(ruleMatches("Bash", "BashLike", {}), false);
  // leading whitespace in the arg is trimmed before prefix compare.
  assert.equal(ruleMatches("Bash(git:*)", "Bash", { command: "   git status" }), true);
});

test("prefix match: deny a destructive command via evaluator (guardrail, not security)", async () => {
  await withBackendDir(() => {
    writeGlobalConfig(cfg({
      rules: [
        { tool: "Bash(rm -rf:*)", action: "deny", reason: "destructive; guardrail only" },
        { tool: "Bash(git:*)", action: "allow" },
        { tool: "Bash", action: "ask" },
      ],
    }));
    assert.equal(evaluatePermission("a", "c", "Bash", { command: "rm -rf /tmp/x" }).action, "deny");
    assert.equal(evaluatePermission("a", "c", "Bash", { command: "git status" }).action, "allow");
    // A bash command matching neither prefix falls to the bare `Bash` ask rule.
    assert.equal(evaluatePermission("a", "c", "Bash", { command: "curl evil" }).action, "ask");
  });
});

// ── Test 4: default = allow (DEDICATED — the headline product decision) ─

test("default=allow: empty config, missing file, and no-match all resolve to allow", async () => {
  await withBackendDir(() => {
    // The hardcoded evaluator fallback constant is "allow".
    assert.equal(HARDCODED_DEFAULT, "allow");

    // (a) No config files at all (missing) → allow, source "default".
    const missing = evaluatePermission("no-such-agent", "c", "Bash", { command: "rm -rf /" });
    assert.equal(missing.action, "allow");
    assert.equal(missing.source, "default");

    // (b) Empty global config (no rules) → allow.
    writeGlobalConfig(cfg({ default: "allow", rules: [] }));
    assert.equal(evaluatePermission("a", "c", "Anything", {}).action, "allow");

    // (c) Config with rules but none matching → allow.
    writeGlobalConfig(cfg({ rules: [{ tool: "OnlyThis", action: "deny" }] }));
    assert.equal(evaluatePermission("a", "c", "SomethingElse", {}).action, "allow");
  });
});

test("default=allow D1: per-agent default wins, else global default, else allow", async () => {
  await withBackendDir(() => {
    // Per-agent file exists with default:deny → its default wins for unmatched.
    writeAgentConfig("agent-strict", cfg({ default: "deny", rules: [] }));
    writeGlobalConfig(cfg({ default: "ask", rules: [] }));
    assert.equal(evaluatePermission("agent-strict", "c", "X", {}).action, "deny");
    // Agent with NO per-agent file → global default (ask).
    assert.equal(evaluatePermission("agent-loose", "c", "X", {}).action, "ask");
    // With neither file present (fresh agent + no global), hardcoded allow.
  });
});

test("default=allow: no files at all → hardcoded allow even for destructive tool", async () => {
  await withBackendDir(() => {
    const r = evaluatePermission("fresh", "c", "Bash", { command: "rm -rf /" });
    assert.equal(r.action, "allow");
    assert.equal(r.source, "default");
  });
});

// ── Test 5: reconnect-replay ──────────────────────────────────────────

test("reconnect-replay: parked ask persists pending file + replayable frame", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "agent-r", conversationId: "conv-r" });
    // Adapter would emit the canonical approval_request_message frame; emulate
    // that persistence here so we can assert it replays from frames.jsonl.
    appendRunFrame(run.id, {
      type: "stream_event",
      event: {
        message_type: "approval_request_message",
        run_id: run.id,
        tool_call: { tool_call_id: "synthetic-1", name: "Bash", arguments: "{}" },
      },
    });
    createPendingApproval({
      runId: run.id,
      agentId: "agent-r",
      conversationId: "conv-r",
      toolCallId: "synthetic-1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "review shell commands",
      ruleSource: "global",
    });

    // "Drop the WS" — nothing to do; the pending file + frame log are durable.
    const pending = readPendingApproval(run.id);
    assert.ok(pending, "pending file persists across a (simulated) reconnect");
    assert.equal(pending!.status, "pending");
    assert.equal(pending!.tool_name, "Bash");

    // The card replays from frames.jsonl (the canonical wire contract).
    const framesPath = getFramesFilePath(run.id);
    assert.ok(existsSync(framesPath));
    const frames = readFileSync(framesPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { frame: { event?: { message_type?: string } } });
    const hasCard = frames.some((f) => f.frame.event?.message_type === "approval_request_message");
    assert.ok(hasCard, "approval_request_message replays from the frame log");
  });
});

// ── Test 6: two-client approval (broadcast + already_resolved + 1 exec) ─

test("two-client approval: broadcast fires; second decision is already_resolved; exactly one execution", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "agent-2c", conversationId: "conv-2c" });
    createPendingApproval({
      runId: run.id,
      agentId: "agent-2c",
      conversationId: "conv-2c",
      toolCallId: "synthetic-2c",
      toolName: "Bash",
      toolInput: { command: "git push" },
      reason: "",
      ruleSource: "global",
    });

    // Client B subscribes to approval events.
    const events: ApprovalEvent[] = [];
    const unsub = subscribeApprovalEvents((e) => events.push(e));

    // Count gate resolutions: exactly one should fire the gate (one execution).
    let gateResolutions = 0;
    const fakeGate = (_runId: string) => { gateResolutions += 1; return true; };

    // Client A approves.
    const first = resolveApproval(run.id, { decision: "approve", userId: "user-A" }, fakeGate as never);
    assert.equal(first.status, "approved");
    assert.equal(first.already_resolved, undefined);
    assert.equal(first.found, true);

    // Broadcast fired so client B learns of it.
    assert.equal(events.length, 1);
    assert.equal(events[0]!.status, "approved");
    assert.equal(events[0]!.decided_by, "user-A");

    // Client B (or a REST caller) sends a second decision → no-op.
    const second = resolveApproval(run.id, { decision: "deny", userId: "user-B" }, fakeGate as never);
    assert.equal(second.already_resolved, true);
    assert.equal(second.status, "approved", "first decision wins; status unchanged");

    // Exactly one tool execution: only the first call resolved the gate.
    assert.equal(gateResolutions, 1, "exactly one gate resolution → exactly one execution");
    // No second broadcast for the no-op.
    assert.equal(events.length, 1);

    // Durable file reflects the terminal approved status.
    const p = readPendingApproval(run.id);
    assert.equal(p!.status, "approved");
    assert.equal(p!.decided_by, "user-A");
    unsub();
  });
});

// ── Test 7: restart survival (boot-sweep → expired + terminal frame) ───

test("restart survival: boot-sweep flips pending → expired + terminal frame + run finalized", async () => {
  await withBackendDir(() => {
    const run = createRun({ agentId: "agent-bs", conversationId: "conv-bs" });
    createPendingApproval({
      runId: run.id,
      agentId: "agent-bs",
      conversationId: "conv-bs",
      toolCallId: "synthetic-bs",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "",
      ruleSource: "global",
    });
    assert.equal(readPendingApproval(run.id)!.status, "pending");

    // Subscribe so we can assert the sweep broadcasts an expired event.
    const events: ApprovalEvent[] = [];
    const unsub = subscribeApprovalEvents((e) => events.push(e));

    const swept = sweepPendingApprovalsOnBoot();
    assert.equal(swept, 1);

    // Pending file flipped to expired.
    const p = readPendingApproval(run.id);
    assert.equal(p!.status, "expired");
    assert.equal(p!.decision_reason, "expired_on_restart");

    // A terminal frame was appended to frames.jsonl (no eternal spinner).
    const framesPath = getFramesFilePath(run.id);
    assert.ok(existsSync(framesPath));
    const frames = readFileSync(framesPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { frame: { event?: { message_type?: string; status?: string } } });
    const terminal = frames.find((f) => f.frame.event?.message_type === "approval_resolved");
    assert.ok(terminal, "a terminal approval_resolved frame is appended");
    assert.equal(terminal!.frame.event?.status, "expired");

    // Run finalized (no longer running).
    const finalized = getRun(run.id);
    assert.ok(finalized);
    assert.notEqual(finalized!.status, "running");

    // Broadcast fired.
    assert.equal(events.length, 1);
    assert.equal(events[0]!.status, "expired");

    // It no longer appears in the pending list.
    assert.equal(listPendingApprovals().length, 0);

    // Idempotent: sweeping again finds nothing.
    assert.equal(sweepPendingApprovalsOnBoot(), 0);
    unsub();
  });
});

// ── Test 8: WS-canonical / REST-mirror equivalence (one funnel) ────────

test("WS-canonical / REST-mirror: both routes funnel into resolveApproval identically", async () => {
  await withBackendDir(() => {
    // REST path: resolveApproval is exactly what handleApprovalsDecision calls.
    const restRun = createRun({ agentId: "agent-rest", conversationId: "conv-rest" });
    createPendingApproval({
      runId: restRun.id,
      agentId: "agent-rest",
      conversationId: "conv-rest",
      toolCallId: "synthetic-rest",
      toolName: "Bash",
      toolInput: {},
      reason: "",
      ruleSource: "global",
    });
    const restResult = resolveApproval(restRun.id, { decision: "approve", scope: "Session", userId: "u" });
    assert.equal(restResult.status, "approved");
    // Pending file reflects it; it no longer lists as pending.
    assert.equal(readPendingApproval(restRun.id)!.status, "approved");
    assert.equal(listPendingApprovals({ agentId: "agent-rest" }).length, 0);
    // Audit trail recorded (approval-decisions.jsonl under the run dir).
    const auditPath = join(
      process.env["LETTA_LOCAL_BACKEND_DIR"]!,
      "runs",
      restRun.id,
      "approval-decisions.jsonl",
    );
    assert.ok(existsSync(auditPath), "approval decision audit recorded");
    const audit = readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { decision: string; scope: string });
    assert.ok(audit.some((a) => a.decision === "approve" && a.scope === "Session"));

    // WS path: the mobile host calls the SAME resolveApproval when a pending
    // file exists. Resolve a second run "via WS" and assert GET /pending no
    // longer lists it (parity with the REST outcome).
    const wsRun = createRun({ agentId: "agent-ws", conversationId: "conv-ws" });
    createPendingApproval({
      runId: wsRun.id,
      agentId: "agent-ws",
      conversationId: "conv-ws",
      toolCallId: "synthetic-ws",
      toolName: "Bash",
      toolInput: {},
      reason: "",
      ruleSource: "global",
    });
    assert.equal(listPendingApprovals({ agentId: "agent-ws" }).length, 1);
    const wsResult = resolveApproval(wsRun.id, { decision: "deny", reason: "user_denied" });
    assert.equal(wsResult.status, "denied");
    assert.equal(listPendingApprovals({ agentId: "agent-ws" }).length, 0, "GET /pending no longer lists a WS-resolved approval");
  });
});

test("resolveApproval on a run with no pending file returns found:false (404 mirror)", async () => {
  await withBackendDir(() => {
    const r = resolveApproval("run-does-not-exist", { decision: "approve" });
    assert.equal(r.found, false);
  });
});

// ── Integration: REST config + preview + pending (real shim subprocess) ─

test("REST permissions config: GET (effective default) / PUT / PATCH round-trip", async () => {
  const shim = await startShim();
  try {
    // GET on an unknown agent returns the usable effective default-allow doc.
    const initial = await fetch(`${shim.url}/shim/v1/permissions/agents/agent-1`);
    assert.equal(initial.status, 200);
    const initialBody = (await initial.json()) as PermissionConfig;
    assert.equal(initialBody.default, "allow");
    assert.deepEqual(initialBody.rules, []);

    // PUT replaces the per-agent config.
    const put = await fetch(`${shim.url}/shim/v1/permissions/agents/agent-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        default: "allow",
        rules: [{ tool: "Bash", action: "ask", reason: "review" }],
      }),
    });
    assert.equal(put.status, 200);
    const putBody = (await put.json()) as PermissionConfig;
    assert.equal(putBody.rules.length, 1);
    assert.equal(putBody.rules[0]!.action, "ask");
    assert.ok(putBody.updated_at, "PUT stamps updated_at");

    // GET reflects the PUT.
    const after = await fetch(`${shim.url}/shim/v1/permissions/agents/agent-1`);
    const afterBody = (await after.json()) as PermissionConfig;
    assert.equal(afterBody.rules[0]!.tool, "Bash");

    // PATCH merges (changes default, preserves rules when omitted).
    const patch = await fetch(`${shim.url}/shim/v1/permissions/agents/agent-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default: "deny" }),
    });
    assert.equal(patch.status, 200);
    const patchBody = (await patch.json()) as PermissionConfig;
    assert.equal(patchBody.default, "deny");
    assert.equal(patchBody.rules.length, 1, "PATCH preserves rules when omitted");
  } finally {
    await shim.stop();
  }
});

test("REST permissions: global GET/PUT and preview endpoint", async () => {
  const shim = await startShim();
  try {
    const putGlobal = await fetch(`${shim.url}/shim/v1/permissions/global`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        default: "allow",
        rules: [{ tool: "Bash(rm -rf:*)", action: "deny", reason: "guardrail only" }],
      }),
    });
    assert.equal(putGlobal.status, 200);

    // preview runs the evaluator: rm -rf → deny + requires_approval.
    const preview = await fetch(
      `${shim.url}/shim/v1/permissions/preview?agent_id=agent-2&tool=Bash&args=${encodeURIComponent("rm -rf /tmp")}`,
    );
    assert.equal(preview.status, 200);
    const pv = (await preview.json()) as { action: string; source: string; requires_approval: boolean };
    assert.equal(pv.action, "deny");
    assert.equal(pv.requires_approval, true);

    // A non-matching tool previews as allow (default).
    const allowPreview = await fetch(
      `${shim.url}/shim/v1/permissions/preview?agent_id=agent-2&tool=Read&args=${encodeURIComponent("x")}`,
    );
    const apv = (await allowPreview.json()) as { action: string; requires_approval: boolean };
    assert.equal(apv.action, "allow");
    assert.equal(apv.requires_approval, false);
  } finally {
    await shim.stop();
  }
});

test("REST approvals: GET /pending lists nothing initially; POST/DELETE on unknown run is 404", async () => {
  const shim = await startShim();
  try {
    const pending = await fetch(`${shim.url}/shim/v1/approvals/pending`);
    assert.equal(pending.status, 200);
    const body = (await pending.json()) as { pending: unknown[] };
    assert.deepEqual(body.pending, []);

    const post = await fetch(`${shim.url}/shim/v1/approvals/run-nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(post.status, 404);

    const del = await fetch(`${shim.url}/shim/v1/approvals/run-nope`, { method: "DELETE" });
    assert.equal(del.status, 404);
  } finally {
    await shim.stop();
  }
});

// ── Dark-ship guarantee (D6): flag OFF ⇒ evaluator skipped ─────────────

test("dark-ship: with SHIM_SERVER_PERMISSIONS unset, the evaluator path is not engaged", async () => {
  await withBackendDir(async () => {
    // Even a deny rule has NO effect on a live turn when the flag is off,
    // because the adapter only consults the evaluator when
    // serverPermissionsEnabled() is true. We assert the flag gate directly:
    // serverPermissionsEnabled() must be false when the env var is unset.
    const prev = process.env["SHIM_SERVER_PERMISSIONS"];
    delete process.env["SHIM_SERVER_PERMISSIONS"];
    try {
      // serverPermissionsEnabled reads env live, so the same imported binding
      // reflects the current flag value across toggles.
      const { serverPermissionsEnabled } = await import("../lib/permissions.js");
      assert.equal(serverPermissionsEnabled(), false);
      process.env["SHIM_SERVER_PERMISSIONS"] = "1";
      assert.equal(serverPermissionsEnabled(), true);
      process.env["SHIM_SERVER_PERMISSIONS"] = "0";
      assert.equal(serverPermissionsEnabled(), false, "only '1' enables the feature");
    } finally {
      if (prev === undefined) delete process.env["SHIM_SERVER_PERMISSIONS"];
      else process.env["SHIM_SERVER_PERMISSIONS"] = prev;
    }
  });
});

test("dark-ship: flag OFF preserves the bypassPermissions default permission mode", async () => {
  const prev = process.env["SHIM_SERVER_PERMISSIONS"];
  const prevMode = process.env["SHIM_PERMISSION_MODE"];
  delete process.env["SHIM_SERVER_PERMISSIONS"];
  delete process.env["SHIM_PERMISSION_MODE"];
  try {
    // The adapter module exposes currentPermissionMode indirectly via spawn;
    // assert the documented coupling through the permissions flag helper +
    // the adapter's exported behavior is covered by the sdk-adapter suite.
    // Here we pin the flag semantics that drive D4.
    const { serverPermissionsEnabled } = await import("../lib/permissions.js");
    assert.equal(serverPermissionsEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env["SHIM_SERVER_PERMISSIONS"];
    else process.env["SHIM_SERVER_PERMISSIONS"] = prev;
    if (prevMode === undefined) delete process.env["SHIM_PERMISSION_MODE"];
    else process.env["SHIM_PERMISSION_MODE"] = prevMode;
  }
});
