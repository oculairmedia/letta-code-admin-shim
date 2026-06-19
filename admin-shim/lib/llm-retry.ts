import type { AdapterRunTurnResult, RunTurnOptions } from "./agent-pool.js";
import type { LettaStreamFrame } from "./types/letta-stream.js";
import { isRunUserStopped } from "./runs.js";

const NON_RETRIABLE_STOP_REASONS = new Set([
  "cancelled",
  "user_cancelled",
  "requires_approval",
  "max_steps",
  "max_tokens_exceeded",
  "context_window_overflow_in_system_prompt",
  "context_window_overflow",
  "end_turn",
  "tool_rule",
  "no_tool_call",
]);

const RETRIABLE_TEXT_RE = /overloaded|overloaded_error|rate\s*limit|429|503|service unavailable/i;

export interface LlmRetryConfig {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

export interface LlmRetryDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  isCancelled?: () => boolean;
}

export interface RunTurnRetryArgs {
  conversationId: string;
  agentId: string;
  input: string | unknown[];
  opts?: RunTurnOptions;
  runOnce: (input: string | unknown[], opts: RunTurnOptions) => Promise<AdapterRunTurnResult>;
  log?: (message: string) => void;
  config?: Partial<LlmRetryConfig>;
  deps?: LlmRetryDeps;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function metadataRetryable(value: unknown): boolean | null {
  const record = asRecord(value);
  const metadata = asRecord(record?.["metadata"]);
  const error = asRecord(metadata?.["error"]);
  const retryable = error?.["retryable"];
  return typeof retryable === "boolean" ? retryable : null;
}

function stopReasonOf(value: unknown): string | undefined {
  const record = asRecord(value);
  return stringField(record, "stopReason") ?? stringField(record, "stop_reason");
}

function apiErrorType(value: unknown): string | undefined {
  const record = asRecord(value);
  const apiError = asRecord(record?.["apiError"]);
  return stringField(apiError, "error_type") ?? stringField(apiError, "type") ?? stringField(apiError, "code");
}

function searchableErrorText(value: unknown): string {
  const record = asRecord(value);
  const apiError = asRecord(record?.["apiError"]);
  return [
    stringField(record, "message"),
    stringField(record, "error"),
    stringField(record, "errorDetail"),
    stringField(record, "detail"),
    stringField(apiError, "message"),
    stringField(apiError, "detail"),
    stringField(apiError, "error_type"),
    stringField(apiError, "type"),
    stringField(apiError, "code"),
  ].filter(Boolean).join(" ");
}

export function isRetriableLlmError(value: unknown): boolean {
  const retryable = metadataRetryable(value);
  if (retryable === false) return false;

  const stopReason = stopReasonOf(value);
  if (stopReason && NON_RETRIABLE_STOP_REASONS.has(stopReason)) return false;
  if (retryable === true) return true;
  if (stopReason === "llm_api_error") return true;

  const errorType = apiErrorType(value);
  if (stopReason === "error" && errorType === "llm_error") return true;
  if (errorType === "overloaded_error") return true;

  return RETRIABLE_TEXT_RE.test(searchableErrorText(value));
}

export function hasUsableAssistantOutput(result: AdapterRunTurnResult): boolean {
  if (result.frames.some((frame) => frame.type === "stream_event" && asRecord(frame.event)?.["message_type"] === "assistant_message")) {
    return true;
  }
  if (result.frames.some((frame) => frame.type === "result" && typeof frame.result === "string" && frame.result.length > 0)) {
    return true;
  }
  return false;
}

export function shouldRetryLlmTurn(result: AdapterRunTurnResult): boolean {
  if (result.cancelled) return false;
  if (!result.errorPayload) return false;
  if (hasUsableAssistantOutput(result)) return false;
  return isRetriableLlmError(result.errorPayload);
}

export function llmRetryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmRetryConfig {
  const parse = (key: string, fallback: number): number => {
    const value = Number(env[key] ?? fallback);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    maxAttempts: parse("SHIM_LLM_RETRY_MAX", 4),
    baseMs: parse("SHIM_LLM_RETRY_BASE_MS", 1000),
    capMs: parse("SHIM_LLM_RETRY_CAP_MS", 15_000),
  };
}

export function computeRetryDelayMs(attempt: number, config: LlmRetryConfig, random = Math.random): number {
  const exponential = Math.min(config.baseMs * 2 ** Math.max(0, attempt - 1), config.capMs);
  const jitter = exponential * 0.25 * ((random() * 2) - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cancellableSleep(
  ms: number,
  isCancelled: () => boolean,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<"slept" | "cancelled"> {
  if (isCancelled()) return "cancelled";
  const sliceMs = Math.max(1, Math.min(100, ms));
  let remaining = ms;
  while (remaining > 0) {
    await sleep(Math.min(sliceMs, remaining));
    if (isCancelled()) return "cancelled";
    remaining -= sliceMs;
  }
  return isCancelled() ? "cancelled" : "slept";
}

function visibleErrorText(result: AdapterRunTurnResult): string {
  const payload = asRecord(result.errorPayload);
  const apiError = asRecord(payload?.["apiError"]);
  return stringField(apiError, "detail")
    ?? stringField(payload, "errorDetail")
    ?? stringField(payload, "message")
    ?? result.error
    ?? "model provider error";
}

export function appendVisibleLlmFailure(
  result: AdapterRunTurnResult,
  opts: RunTurnOptions = {},
): AdapterRunTurnResult {
  if (result.cancelled || hasUsableAssistantOutput(result)) return result;
  const runId = result.run_id ?? opts.runHandle?.id ?? `run-llm-error-${Date.now()}`;
  const now = new Date().toISOString();
  const message = visibleErrorText(result);
  const errorFrame: LettaStreamFrame = {
    type: "stream_event",
    event: {
      message_type: "assistant_message",
      id: `llm-error-${runId}`,
      date: now,
      agent_id: opts.runHandle?.record.agent_id ?? null,
      conversation_id: opts.runHandle?.record.conversation_id ?? null,
      run_id: runId,
      seq_id: 0,
      otid: null,
      content: [{ type: "text", text: `Model provider error: ${message}` }],
      is_err: true,
    } as never,
    session_id: "shim-llm-retry",
    uuid: `llm-error-${runId}`,
    timestamp: now,
  };
  const doneFrame = {
    type: "turn_done",
    message_type: "turn_done",
    turn_id: runId,
    run_id: runId,
    agent_id: opts.runHandle?.record.agent_id ?? null,
    conversation_id: opts.runHandle?.record.conversation_id ?? null,
    status: "failed",
    stop_reason: "llm_error",
    error_code: "llm_error",
    error_message: message,
  } as unknown as LettaStreamFrame;
  const frames = [...result.frames, errorFrame, doneFrame];
  opts.onFrame?.(errorFrame, { runId });
  opts.onFrame?.(doneFrame, { runId });
  return { ...result, frames, frameCountTotal: (result.frameCountTotal ?? result.frames.length) + 2 };
}

export async function runTurnWithLlmRetry(args: RunTurnRetryArgs): Promise<AdapterRunTurnResult> {
  const opts = args.opts ?? {};
  const config = { ...llmRetryConfigFromEnv(), ...args.config };
  const sleep = args.deps?.sleep ?? defaultSleep;
  const random = args.deps?.random ?? Math.random;
  const isCancelled = (): boolean => {
    if (args.deps?.isCancelled?.()) return true;
    if (opts.runHandle?.record.status === "cancelled") return true;
    if (opts.runHandle && isRunUserStopped(opts.runHandle.id)) return true;
    return false;
  };

  let attempt = 1;
  while (true) {
    if (isCancelled()) {
      return { frames: [], stderr: "", cancelled: true, ...(opts.runHandle?.id ? { run_id: opts.runHandle.id } : {}) };
    }
    const result = await args.runOnce(args.input, opts);
    if (!shouldRetryLlmTurn(result)) {
      return result.errorPayload && !result.cancelled && !hasUsableAssistantOutput(result)
        ? appendVisibleLlmFailure(result, opts)
        : result;
    }
    if (attempt >= config.maxAttempts) {
      args.log?.(`llm retry exhausted conv=${args.conversationId} run=${result.run_id ?? "?"} attempts=${attempt} error=${searchableErrorText(result.errorPayload)}`);
      return appendVisibleLlmFailure(result, opts);
    }
    const delayMs = computeRetryDelayMs(attempt, config, random);
    args.log?.(`llm retry scheduled conv=${args.conversationId} run=${result.run_id ?? "?"} attempt=${attempt + 1}/${config.maxAttempts} delay_ms=${delayMs} error=${searchableErrorText(result.errorPayload)}`);
    const slept = await cancellableSleep(delayMs, isCancelled, sleep);
    if (slept === "cancelled") {
      args.log?.(`llm retry aborted by cancel conv=${args.conversationId} run=${result.run_id ?? "?"}`);
      return { ...result, cancelled: true, frames: result.frames };
    }
    attempt += 1;
  }
}
