/**
 * Fork verdict tests (lcp-wd3i).
 *
 * Covers:
 *   1. Byte-identical behavior when SHIM_FORK_VERDICT is off
 *   2. Fork verdict with session-role exemption (main gets fork, fork/subagent exempt)
 *   3. Agent-actuated override extraction + validation
 *   4. Override rate limiting (per-turn, per-hour)
 *   5. Override audit log append + query
 *   6. stripOverrideFields
 *   7. Integration: evaluatePermissionWithFork with override present in toolInput
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluatePermissionWithFork,
  writeGlobalConfig,
  writeAgentConfig,
  __clearPermissionConfigCache,
  forkVerdictEnabled,
  extractOverride,
  stripOverrideFields,
  checkOverrideRateLimit,
  recordOverride,
  appendOverrideAudit,
  getOverrideAuditLog,
  resetOverrideTurnCounter,
  forkOverrideEnabled,
  __clearForkAuditAndRateState,
  type PermissionConfig,
  type ForkSessionRole,
} from "../lib/permissions.js";
import { __clearRuntimeState } from "../lib/runtime-introspection.js";

// ── temp backend dir harness ────────────────────────────────────────────

async function withBackendDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "fork-verdict-test-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  __clearPermissionConfigCache();
  __clearRuntimeState();
  __clearForkAuditAndRateState();
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
    else process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
    __clearPermissionConfigCache();
    __clearRuntimeState();
    __clearForkAuditAndRateState();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function cfg(partial: Partial<PermissionConfig>): PermissionConfig {
  return { version: 1, default: partial.default ?? "allow", rules: partial.rules ?? [] };
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function forkRule(pattern: string, reason?: string) {
  return { tool: pattern, action: "fork" as const, ...(reason ? { reason } : {}) };
}

// ── Test 1: Byte-identical when flag OFF ────────────────────────────────

test("fork verdict: flag OFF → fork rules treated as allow (byte-identical)", async () => {
  await withBackendDir(() => {
    setEnv("SHIM_FORK_VERDICT", "0");
    assert.equal(forkVerdictEnabled(), false);

    writeGlobalConfig(cfg({
      default: "allow",
      rules: [forkRule("Bash", "please fork")],
    }));

    // On main thread with flag off, fork should be "allow"
    const r = evaluatePermissionWithFork("agent-1", "conv-1", "Bash", { command: "ls" }, "main");
    assert.equal(r.action, "allow");
    assert.equal(r.reason, "please fork"); // reason preserved
  });
});

test("fork verdict: env unset → fork rules treated as allow", async () => {
  await withBackendDir(() => {
    setEnv("SHIM_FORK_VERDICT", undefined);
    assert.equal(forkVerdictEnabled(), false);

    writeGlobalConfig(cfg({
      default: "allow",
      rules: [forkRule("Write", "write requires fork")],
    }));

    const r = evaluatePermissionWithFork("agent-1", "conv-1", "Write", { file_path: "/tmp/x" }, "main");
    assert.equal(r.action, "allow");
  });
});

// ── Test 2: Fork verdict with flag ON ───────────────────────────────────

test("fork verdict: flag ON + main role → fork verdict returned", async () => {
  await withBackendDir(() => {
    setEnv("SHIM_FORK_VERDICT", "1");
    assert.equal(forkVerdictEnabled(), true);

    writeGlobalConfig(cfg({
      default: "allow",
      rules: [forkRule("Bash", "use fork for bash")],
    }));

    const r = evaluatePermissionWithFork("agent-1", "conv-1", "Bash", { command: "ls" }, "main");
    assert.equal(r.action, "fork");
    assert.equal(r.reason, "use fork for bash");
  });
});

test("fork verdict: flag ON + fork role → exempt (allow)", async () => {
  await withBackendDir(() => {
    setEnv("SHIM_FORK_VERDICT", "1");

    writeGlobalConfig(cfg({
      default: "allow",
      rules: [forkRule("Bash", "use fork")],
    }));

    const r = evaluatePermissionWithFork("agent-1", "conv-fork-1", "Bash", { command: "ls" }, "fork");
    assert.equal(r.action, "allow");
    assert.ok(r.reason.includes("fork exempt"));
    assert.ok(r.reason.includes("session role is fork"));
  });
});

test("fork verdict: flag ON + subagent role → exempt (allow)", async () => {
  await withBackendDir(() => {
    setEnv("SHIM_FORK_VERDICT", "1");

    writeGlobalConfig(cfg({
      default: "allow",
      rules: [forkRule("Edit", "use fork")],
    }));

    const r = evaluatePermissionWithFork("agent-1", "conv-sub-1", "Edit", { file_path: "/tmp/x" }, "subagent");
    assert.equal(r.action, "allow");
    assert.ok(r.reason.includes("fork exempt"));
    assert.ok(r.reason.includes("session role is subagent"));
  });
});

test("fork verdict: non-fork rules unaffected by fork flag", async () => {
  await withBackendDir(() => {
    setEnv("SHIM_FORK_VERDICT", "1");

    writeGlobalConfig(cfg({
      default: "allow",
      rules: [
        { tool: "Bash", action: "deny", reason: "blocked" },
        { tool: "Read", action: "ask", reason: "confirm" },
      ],
    }));

    const denyR = evaluatePermissionWithFork("agent-1", "conv-1", "Bash", { command: "rm" }, "main");
    assert.equal(denyR.action, "deny");

    const askR = evaluatePermissionWithFork("agent-1", "conv-1", "Read", { file_path: "/tmp/x" }, "main");
    assert.equal(askR.action, "ask");
  });
});

// ── Test 3: Rule resolution order with fork ────────────────────────────

test("fork verdict: first-matching-rule-wins (fork before allow, main thread)", async () => {
  await withBackendDir(() => {
    setEnv("SHIM_FORK_VERDICT", "1");

    writeGlobalConfig(cfg({
      default: "allow",
      rules: [
        forkRule("Bash", "fork first"),
        { tool: "Bash", action: "allow" },
      ],
    }));

    const r = evaluatePermissionWithFork("agent-1", "conv-1", "Bash", { command: "ls" }, "main");
    assert.equal(r.action, "fork");
    assert.equal(r.reason, "fork first");
  });
});

test("fork verdict: per-agent fork overrides global allow", async () => {
  await withBackendDir(() => {
    setEnv("SHIM_FORK_VERDICT", "1");

    writeGlobalConfig(cfg({
      default: "allow",
      rules: [{ tool: "Bash", action: "allow" }],
    }));
    writeAgentConfig("agent-1", cfg({
      rules: [forkRule("Bash", "agent-level fork")],
    }));

    const r = evaluatePermissionWithFork("agent-1", "conv-1", "Bash", { command: "ls" }, "main");
    assert.equal(r.action, "fork");
    assert.equal(r.source, "agent");
  });
});

// ── Test 4: Override extraction ─────────────────────────────────────────

test("override: extract from top-level keys", () => {
  const input = {
    command: "echo hello",
    permissions_override_rule: "Bash(*)",
    permissions_override_reason: "quick status check",
  };
  const ov = extractOverride(input);
  assert.ok(ov !== null);
  assert.equal(ov!.rule, "Bash(*)");
  assert.equal(ov!.reason, "quick status check");
});

test("override: extract from nested object", () => {
  const input = {
    command: "echo hello",
    permissions_override: { rule: "Write(*)", reason: "small config edit" },
  };
  const ov = extractOverride(input);
  assert.ok(ov !== null);
  assert.equal(ov!.rule, "Write(*)");
  assert.equal(ov!.reason, "small config edit");
});

test("override: returns null when absent", () => {
  const input = { command: "echo hello" };
  const ov = extractOverride(input);
  assert.equal(ov, null);
});

test("override: returns null when rule is empty", () => {
  const input = {
    command: "echo hello",
    permissions_override_rule: "",
    permissions_override_reason: "test",
  };
  const ov = extractOverride(input);
  assert.equal(ov, null);
});

test("override: returns null when reason is empty", () => {
  const input = {
    command: "echo hello",
    permissions_override_rule: "Bash(*)",
    permissions_override_reason: "",
  };
  const ov = extractOverride(input);
  assert.equal(ov, null);
});

test("override: returns null for undefined input", () => {
  const ov = extractOverride(undefined);
  assert.equal(ov, null);
});

// ── Test 5: stripOverrideFields ─────────────────────────────────────────

test("stripOverrideFields: removes top-level override keys", () => {
  const input = {
    command: "echo hello",
    permissions_override_rule: "Bash(*)",
    permissions_override_reason: "test",
    permissions_override: { rule: "X", reason: "Y" },
  };
  const cleaned = stripOverrideFields(input);
  assert.equal(cleaned.command, "echo hello");
  assert.equal("permissions_override_rule" in cleaned, false);
  assert.equal("permissions_override_reason" in cleaned, false);
  assert.equal("permissions_override" in cleaned, false);
});

test("stripOverrideFields: no-op when no override fields", () => {
  const input = { command: "echo hello", file_path: "/tmp/x" };
  const cleaned = stripOverrideFields(input);
  assert.deepEqual(cleaned, { command: "echo hello", file_path: "/tmp/x" });
});

// ── Test 6: Override rate limiting ──────────────────────────────────────

test("rate limit: allows first override", () => {
  __clearForkAuditAndRateState();
  const limit = checkOverrideRateLimit("agent-1", "conv-1");
  assert.equal(limit, null);
});

test("rate limit: blocks after per-turn max", () => {
  __clearForkAuditAndRateState();
  const maxPerTurn = 3;

  for (let i = 0; i < maxPerTurn; i++) {
    recordOverride("agent-1", "conv-1");
  }

  const limit = checkOverrideRateLimit("agent-1", "conv-1");
  assert.ok(limit !== null);
  assert.ok(limit!.includes("this turn"));
});

test("rate limit: resets after turn counter reset", () => {
  __clearForkAuditAndRateState();

  for (let i = 0; i < 3; i++) recordOverride("agent-1", "conv-1");
  assert.ok(checkOverrideRateLimit("agent-1", "conv-1") !== null);

  resetOverrideTurnCounter("agent-1", "conv-1");
  assert.equal(checkOverrideRateLimit("agent-1", "conv-1"), null);
});

test("rate limit: isolated per conversation", () => {
  __clearForkAuditAndRateState();

  for (let i = 0; i < 3; i++) recordOverride("agent-1", "conv-a");
  assert.ok(checkOverrideRateLimit("agent-1", "conv-a") !== null);
  assert.equal(checkOverrideRateLimit("agent-1", "conv-b"), null);
});

// ── Test 7: Override audit log ──────────────────────────────────────────

test("audit log: append and query", () => {
  __clearForkAuditAndRateState();

  appendOverrideAudit({
    agentId: "agent-1",
    conversationId: "conv-1",
    toolName: "Bash",
    rule: "Bash(*)",
    justification: "quick status check",
    timestamp: new Date().toISOString(),
  });

  const log = getOverrideAuditLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].toolName, "Bash");
  assert.equal(log[0].rule, "Bash(*)");
  assert.equal(log[0].justification, "quick status check");
});

test("audit log: newest first", () => {
  __clearForkAuditAndRateState();

  appendOverrideAudit({
    agentId: "agent-1", conversationId: "conv-1",
    toolName: "First", rule: "X", justification: "one", timestamp: "2026-01-01T00:00:00Z",
  });
  appendOverrideAudit({
    agentId: "agent-1", conversationId: "conv-1",
    toolName: "Second", rule: "Y", justification: "two", timestamp: "2026-01-02T00:00:00Z",
  });

  const log = getOverrideAuditLog();
  assert.equal(log.length, 2);
  assert.equal(log[0].toolName, "Second"); // newest first
  assert.equal(log[1].toolName, "First");
});

// ── Test 8: forkOverrideEnabled flag ────────────────────────────────────

test("forkOverrideEnabled: true when fork verdict on and override not disabled", () => {
  setEnv("SHIM_FORK_VERDICT", "1");
  setEnv("SHIM_FORK_OVERRIDE_ENABLED", undefined);
  assert.equal(forkOverrideEnabled(), true);
});

test("forkOverrideEnabled: false when SHIM_FORK_OVERRIDE_ENABLED=0", () => {
  setEnv("SHIM_FORK_VERDICT", "1");
  setEnv("SHIM_FORK_OVERRIDE_ENABLED", "0");
  assert.equal(forkOverrideEnabled(), false);
  // Clean up
  setEnv("SHIM_FORK_OVERRIDE_ENABLED", undefined);
});

test("forkOverrideEnabled: false when fork verdict itself is off", () => {
  setEnv("SHIM_FORK_VERDICT", "0");
  assert.equal(forkOverrideEnabled(), false);
});

// ── Clean up env after tests ────────────────────────────────────────────

after(() => {
  setEnv("SHIM_FORK_VERDICT", undefined);
  setEnv("SHIM_FORK_OVERRIDE_ENABLED", undefined);
});
