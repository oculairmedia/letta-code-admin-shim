import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appendVisibleLlmFailure,
  isRetriableLlmError,
  runTurnWithLlmRetry,
  computeRetryDelayMs,
  llmRetryConfigFromEnv,
} from "../lib/llm-retry.js";
import type { AdapterRunTurnResult, RunTurnOptions } from "../lib/agent-pool.js";
import type { LettaStreamFrame } from "../lib/types/letta-stream.js";

function overloadedResult(): AdapterRunTurnResult {
  return {
    frames: [],
    frameCountTotal: 0,
    stderr: "",
    run_id: "run-overloaded",
    done: false,
    errorPayload: {
      message: "Overloaded",
      apiError: { error_type: "llm_error", detail: "Overloaded" },
    },
  };
}

function successResult(text = "ok"): AdapterRunTurnResult {
  return {
    frames: [
      {
        type: "result",
        subtype: "success",
        session_id: "s",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: text,
        agent_id: "agent-a",
        conversation_id: "conv-a",
        run_ids: ["run-success"],
        usage: null,
        uuid: "result-1",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ],
    frameCountTotal: 1,
    stderr: "",
    run_id: "run-success",
    done: true,
  };
}

test("isRetriableLlmError classifies transient provider errors only", () => {
  assert.equal(isRetriableLlmError({ stopReason: "error", apiError: { error_type: "llm_error", detail: "Overloaded" } }), true);
  assert.equal(isRetriableLlmError({ message: "HTTP 429 rate limit" }), true);
  assert.equal(isRetriableLlmError({ apiError: { detail: "503 service unavailable" } }), true);
  assert.equal(isRetriableLlmError({ stopReason: "llm_api_error" }), true);
  assert.equal(isRetriableLlmError({ metadata: { error: { retryable: true } } }), true);

  assert.equal(isRetriableLlmError({ stopReason: "cancelled", message: "Overloaded" }), false);
  assert.equal(isRetriableLlmError({ stopReason: "user_cancelled", message: "Overloaded" }), false);
  assert.equal(isRetriableLlmError({ stopReason: "end_turn", message: "Overloaded" }), false);
  assert.equal(isRetriableLlmError({ stopReason: "max_steps", message: "Overloaded" }), false);
  assert.equal(isRetriableLlmError({ stopReason: "requires_approval", message: "Overloaded" }), false);
  assert.equal(isRetriableLlmError({ metadata: { error: { retryable: false } }, message: "Overloaded" }), false);
});

test("runTurnWithLlmRetry retries Overloaded once and returns success", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const result = await runTurnWithLlmRetry({
    conversationId: "conv-a",
    agentId: "agent-a",
    input: "hello",
    runOnce: async () => {
      attempts += 1;
      return attempts === 1 ? overloadedResult() : successResult("recovered");
    },
    config: { maxAttempts: 4, baseMs: 1000, capMs: 15_000 },
    deps: { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 },
  });

  assert.equal(attempts, 2);
  assert.equal(result.done, true);
  assert.equal(result.frames.at(-1)?.type, "result");
  assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), 1000);
  assert.ok(sleeps.every((ms) => ms <= 100), "backoff is split into cancellable polling slices");
});

test("runTurnWithLlmRetry aborts during cancellable backoff", async () => {
  let attempts = 0;
  let cancelled = false;
  const result = await runTurnWithLlmRetry({
    conversationId: "conv-a",
    agentId: "agent-a",
    input: "hello",
    runOnce: async () => {
      attempts += 1;
      return overloadedResult();
    },
    config: { maxAttempts: 4, baseMs: 1000, capMs: 15_000 },
    deps: {
      random: () => 0.5,
      isCancelled: () => cancelled,
      sleep: async () => { cancelled = true; },
    },
  });

  assert.equal(attempts, 1);
  assert.equal(result.cancelled, true);
});

test("runTurnWithLlmRetry emits visible failed frames on exhaustion", async () => {
  const seen: LettaStreamFrame[] = [];
  let attempts = 0;
  const opts: RunTurnOptions = { onFrame: (frame) => { seen.push(frame); } };
  const result = await runTurnWithLlmRetry({
    conversationId: "conv-a",
    agentId: "agent-a",
    input: "hello",
    opts,
    runOnce: async () => {
      attempts += 1;
      return overloadedResult();
    },
    config: { maxAttempts: 2, baseMs: 1000, capMs: 15_000 },
    deps: { sleep: async () => {}, random: () => 0.5 },
  });

  assert.equal(attempts, 2);
  assert.equal(result.frames.length, 2);
  assert.equal(seen.length, 2);
  assert.equal(result.frames[0]?.type, "stream_event");
  assert.equal((result.frames[0] as Extract<LettaStreamFrame, { type: "stream_event" }>).event.message_type, "assistant_message");
  assert.equal((result.frames[1] as unknown as Record<string, unknown>)["message_type"], "turn_done");
  assert.equal((result.frames[1] as unknown as Record<string, unknown>)["status"], "failed");
});

test("runTurnWithLlmRetry does not retry non-retriable stop reasons", async () => {
  let attempts = 0;
  const result = await runTurnWithLlmRetry({
    conversationId: "conv-a",
    agentId: "agent-a",
    input: "hello",
    runOnce: async () => {
      attempts += 1;
      return {
        frames: [],
        stderr: "",
        run_id: "run-max-steps",
        done: false,
        errorPayload: { stopReason: "max_steps", message: "max steps" },
      };
    },
    deps: { sleep: async () => { throw new Error("should not sleep"); } },
  });

  assert.equal(attempts, 1);
  assert.equal(result.frames.length, 2);
  assert.equal((result.frames[1] as unknown as Record<string, unknown>)["message_type"], "turn_done");
});

test("appendVisibleLlmFailure does not add frames after usable output", () => {
  const result = appendVisibleLlmFailure({
    ...successResult("partial"),
    errorPayload: { message: "Overloaded" },
  });
  assert.equal(result.frames.length, 1);
});

test("computeRetryDelayMs calculates exponential backoff with bounded jitter", () => {
  const config = { maxAttempts: 5, baseMs: 1000, capMs: 5000 };

  // Min jitter (-25%)
  assert.equal(computeRetryDelayMs(1, config, () => 0.0), 750);
  assert.equal(computeRetryDelayMs(2, config, () => 0.0), 1500);
  assert.equal(computeRetryDelayMs(3, config, () => 0.0), 3000);

  // Max jitter (+25%)
  assert.equal(computeRetryDelayMs(1, config, () => 0.99999), 1250);
  assert.equal(computeRetryDelayMs(2, config, () => 0.99999), 2500);
  assert.equal(computeRetryDelayMs(3, config, () => 0.99999), 5000);

  // Capping
  assert.equal(computeRetryDelayMs(4, config, () => 0.5), 5000); // 1000 * 2^3 = 8000 -> 5000
});

test("appendVisibleLlmFailure extracts clearest available error message", () => {
  const runHandle = { id: "run-err", record: { agent_id: "agent-a", conversation_id: "conv-a" } };

  // Test fallback chain: apiError.detail > errorDetail > message > error > fallback

  // 1. apiError.detail
  let res = appendVisibleLlmFailure(
    { frames: [], stderr: "", done: false, errorPayload: { apiError: { detail: "api detail error" }, errorDetail: "error detail", message: "message error" } },
    { runHandle: runHandle as any }
  );
  assert.equal((res.frames[0] as any).event.content[0].text, "Model provider error: api detail error");

  // 2. errorDetail
  res = appendVisibleLlmFailure(
    { frames: [], stderr: "", done: false, errorPayload: { errorDetail: "error detail", message: "message error" } },
    { runHandle: runHandle as any }
  );
  assert.equal((res.frames[0] as any).event.content[0].text, "Model provider error: error detail");

  // 3. message
  res = appendVisibleLlmFailure(
    { frames: [], stderr: "", done: false, errorPayload: { message: "message error" } },
    { runHandle: runHandle as any }
  );
  assert.equal((res.frames[0] as any).event.content[0].text, "Model provider error: message error");

  // 4. result.error
  res = appendVisibleLlmFailure(
    { frames: [], stderr: "", done: false, error: "root error" },
    { runHandle: runHandle as any }
  );
  assert.equal((res.frames[0] as any).event.content[0].text, "Model provider error: root error");

  // 5. fallback
  res = appendVisibleLlmFailure(
    { frames: [], stderr: "", done: false, errorPayload: {} },
    { runHandle: runHandle as any }
  );
  assert.equal((res.frames[0] as any).event.content[0].text, "Model provider error: model provider error");
});

test("llmRetryConfigFromEnv parses environment and falls back correctly", () => {
  // Defaults
  assert.deepEqual(llmRetryConfigFromEnv({}), {
    maxAttempts: 4,
    baseMs: 1000,
    capMs: 15_000,
  });

  // Valid overrides
  assert.deepEqual(llmRetryConfigFromEnv({
    SHIM_LLM_RETRY_MAX: "10",
    SHIM_LLM_RETRY_BASE_MS: "2000",
    SHIM_LLM_RETRY_CAP_MS: "30000",
  }), {
    maxAttempts: 10,
    baseMs: 2000,
    capMs: 30000,
  });

  // Invalid overrides (negative, NaN) fall back to defaults
  assert.deepEqual(llmRetryConfigFromEnv({
    SHIM_LLM_RETRY_MAX: "-1",
    SHIM_LLM_RETRY_BASE_MS: "invalid",
    SHIM_LLM_RETRY_CAP_MS: "0",
  }), {
    maxAttempts: 4,
    baseMs: 1000,
    capMs: 15_000,
  });
});
