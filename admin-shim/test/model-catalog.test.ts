/**
 * Tests for model catalog infrastructure.
 *
 * Coverage:
 * - Model handle parsing (provider/model format)
 * - Provider → endpoint type mapping
 * - Version normalization (Anthropic dash vs. dot)
 * - Model discovery (fallback chain)
 * - Safety guardrails (validation, suggestions)
 */

import { test } from "node:test";
import * as assert from "node:assert";
import {
  parseModelHandle,
  constructModelHandle,
  getEndpointType,
  isKnownProvider,
  normalizeAnthropicVersion,
  findNearestModel,
  validateModelHandle,
  getSafeFallbackModel,
  isVisionCapableModel,
  FALLBACK_MODEL_CATALOG,
  KNOWN_PROVIDERS,
  PROVIDER_TO_ENDPOINT_TYPE,
  type ProviderCatalog,
  getDefaultOpenAIModels,
  getDefaultAnthropicModels,
  getDefaultDeepSeekModels,
  getOpenAICompatibleModelsFromEnv,
  discoverOpenAICompatibleModels,
  VISION_MODEL_PATTERNS,
} from "../lib/model-catalog.js";

function catalogFor(provider: string): ProviderCatalog {
  const catalog = FALLBACK_MODEL_CATALOG[provider];
  assert.ok(catalog, `Missing catalog for ${provider}`);
  return catalog;
}

test("parseModelHandle: valid handles", () => {
  assert.deepStrictEqual(parseModelHandle("openai/gpt-4o"), {
    provider: "openai",
    model: "gpt-4o",
  });

  assert.deepStrictEqual(parseModelHandle("anthropic/claude-opus-4-7"), {
    provider: "anthropic",
    model: "claude-opus-4-7",
  });

  assert.deepStrictEqual(parseModelHandle("deepseek/deepseek-v4-flash"), {
    provider: "deepseek",
    model: "deepseek-v4-flash",
  });
});

test("parseModelHandle: bare model names (no provider)", () => {
  assert.deepStrictEqual(parseModelHandle("gpt-4o"), {
    provider: "unknown",
    model: "gpt-4o",
  });

  assert.deepStrictEqual(parseModelHandle("claude-opus-4-7"), {
    provider: "unknown",
    model: "claude-opus-4-7",
  });
});

test("parseModelHandle: invalid inputs", () => {
  assert.deepStrictEqual(parseModelHandle(null), {
    provider: "unknown",
    model: "unknown",
  });

  assert.deepStrictEqual(parseModelHandle(undefined), {
    provider: "unknown",
    model: "unknown",
  });

  assert.deepStrictEqual(parseModelHandle(""), {
    provider: "unknown",
    model: "unknown",
  });

  assert.deepStrictEqual(parseModelHandle(123), {
    provider: "unknown",
    model: "unknown",
  });
});

test("constructModelHandle: valid inputs", () => {
  assert.strictEqual(constructModelHandle("openai", "gpt-4o"), "openai/gpt-4o");
  assert.strictEqual(
    constructModelHandle("anthropic", "claude-opus-4-7"),
    "anthropic/claude-opus-4-7",
  );
});

test("constructModelHandle: unknown provider", () => {
  assert.strictEqual(constructModelHandle("unknown", "gpt-4o"), "gpt-4o");
  assert.strictEqual(constructModelHandle("", "gpt-4o"), "gpt-4o");
});

test("getEndpointType: known providers", () => {
  assert.strictEqual(getEndpointType("openai"), "openai");
  assert.strictEqual(getEndpointType("anthropic"), "anthropic");
  assert.strictEqual(getEndpointType("deepseek"), "openai"); // OpenAI-compatible
  assert.strictEqual(getEndpointType("ollama"), "openai"); // OpenAI-compatible
  assert.strictEqual(getEndpointType("lmstudio"), "openai"); // OpenAI-compatible
  assert.strictEqual(getEndpointType("bedrock"), "bedrock");
  assert.strictEqual(getEndpointType("azure"), "azure");
});

test("getEndpointType: unknown provider", () => {
  assert.strictEqual(getEndpointType("unknown"), "unknown");
  assert.strictEqual(getEndpointType("nonexistent"), "unknown");
});

test("isKnownProvider: valid providers", () => {
  assert.strictEqual(isKnownProvider("openai"), true);
  assert.strictEqual(isKnownProvider("anthropic"), true);
  assert.strictEqual(isKnownProvider("deepseek"), true);
  assert.strictEqual(isKnownProvider("ollama"), true);
  assert.strictEqual(isKnownProvider("lmstudio"), true);
});

test("isKnownProvider: unknown providers", () => {
  assert.strictEqual(isKnownProvider("unknown"), false);
  assert.strictEqual(isKnownProvider("nonexistent"), false);
  assert.strictEqual(isKnownProvider(""), false);
});

test("normalizeAnthropicVersion: dot to dash", () => {
  assert.strictEqual(
    normalizeAnthropicVersion("claude-opus-4.6"),
    "claude-opus-4-6",
  );
  assert.strictEqual(
    normalizeAnthropicVersion("claude-opus-4.7"),
    "claude-opus-4-7",
  );
  assert.strictEqual(
    normalizeAnthropicVersion("claude-sonnet-4.6"),
    "claude-sonnet-4-6",
  );
  assert.strictEqual(
    normalizeAnthropicVersion("claude-haiku-4.5"),
    "claude-haiku-4-5",
  );
});

test("normalizeAnthropicVersion: already dash", () => {
  assert.strictEqual(
    normalizeAnthropicVersion("claude-opus-4-6"),
    "claude-opus-4-6",
  );
  assert.strictEqual(
    normalizeAnthropicVersion("claude-opus-4-7"),
    "claude-opus-4-7",
  );
});

test("findNearestModel: exact match", () => {
  const catalog = catalogFor("openai");
  assert.strictEqual(findNearestModel("gpt-4o", catalog), "gpt-4o");
  assert.strictEqual(findNearestModel("gpt-4-turbo", catalog), "gpt-4-turbo");
});

test("findNearestModel: Anthropic version normalization", () => {
  const catalog = catalogFor("anthropic");
  // Dot notation should normalize to dash
  assert.strictEqual(
    findNearestModel("claude-opus-4.6", catalog),
    "claude-opus-4-6",
  );
  assert.strictEqual(
    findNearestModel("claude-opus-4.7", catalog),
    "claude-opus-4-7",
  );
});

test("findNearestModel: fallback to first available", () => {
  const catalog = catalogFor("openai");
  // Non-existent model should return first available
  const result = findNearestModel("gpt-99-ultra", catalog);
  assert.ok(result !== null);
  assert.ok(catalog[result] !== undefined);
});

test("findNearestModel: empty catalog", () => {
  const emptyCatalog = {};
  assert.strictEqual(findNearestModel("any-model", emptyCatalog), null);
});

test("validateModelHandle: valid handles", () => {
  const result = validateModelHandle("openai/gpt-4o");
  assert.strictEqual(result.valid, true);
  if (result.valid) {
    assert.strictEqual(result.provider, "openai");
    assert.strictEqual(result.model, "gpt-4o");
    assert.strictEqual(result.handle, "openai/gpt-4o");
  }
});

test("validateModelHandle: unknown provider", () => {
  const result = validateModelHandle("gpt-4o");
  assert.strictEqual(result.valid, false);
  if (!result.valid) {
    assert.ok(result.suggested.includes("lmstudio"));
    assert.ok(result.reason.includes("Unknown provider"));
  }
});

test("validateModelHandle: unknown model in known provider", () => {
  const result = validateModelHandle("openai/gpt-99-ultra");
  assert.strictEqual(result.valid, false);
  if (!result.valid) {
    assert.ok(result.suggested.includes("openai"));
    assert.ok(result.reason.includes("not found"));
  }
});

test("validateModelHandle: Anthropic version normalization", () => {
  const result = validateModelHandle("anthropic/claude-opus-4.6");
  assert.strictEqual(result.valid, false); // Dot notation not exact match
  if (!result.valid) {
    assert.ok(result.suggested.includes("claude-opus-4-6"));
  }
});

test("getSafeFallbackModel: returns valid fallback", () => {
  const fallback = getSafeFallbackModel();
  assert.strictEqual(fallback, "lmstudio/opus-4-7");

  // Verify it's in the catalog
  const parsed = parseModelHandle(fallback);
  const catalog = FALLBACK_MODEL_CATALOG[parsed.provider];
  assert.ok(catalog !== undefined);
  assert.ok(catalog[parsed.model] !== undefined);
});

test("FALLBACK_MODEL_CATALOG: structure validation", () => {
  // Check that all providers in catalog are known
  for (const provider of Object.keys(FALLBACK_MODEL_CATALOG)) {
    assert.ok(
      isKnownProvider(provider),
      `Provider "${provider}" in catalog but not in KNOWN_PROVIDERS`,
    );
  }

  // Check that all models have required metadata
  for (const [provider, models] of Object.entries(FALLBACK_MODEL_CATALOG)) {
    for (const [modelId, metadata] of Object.entries(models)) {
      assert.strictEqual(
        metadata.id,
        modelId,
        `Model ID mismatch in ${provider}/${modelId}`,
      );
      assert.ok(metadata.name, `Missing name for ${provider}/${modelId}`);
      assert.ok(
        metadata.contextWindow > 0,
        `Invalid contextWindow for ${provider}/${modelId}`,
      );
    }
  }
});

test("PROVIDER_TO_ENDPOINT_TYPE: all known providers mapped", () => {
  for (const provider of KNOWN_PROVIDERS) {
    assert.ok(
      PROVIDER_TO_ENDPOINT_TYPE[provider] !== undefined,
      `Provider "${provider}" not in PROVIDER_TO_ENDPOINT_TYPE mapping`,
    );
  }
});

test("Model catalog: OpenAI models", () => {
  const openai = catalogFor("openai");
  assert.ok(openai["gpt-4o"] !== undefined);
  assert.ok(openai["gpt-4-turbo"] !== undefined);
  assert.ok(openai["gpt-5"] !== undefined);
  assert.ok(openai["gpt-5-codex"] !== undefined);
  assert.ok(openai["o1"] !== undefined);
  assert.ok(openai["o3"] !== undefined);
});

test("Model catalog: Anthropic models", () => {
  const anthropic = catalogFor("anthropic");
  assert.ok(anthropic["claude-opus-4-7"] !== undefined);
  assert.ok(anthropic["claude-opus-4-6"] !== undefined);
  assert.ok(anthropic["claude-sonnet-4-6"] !== undefined);
  assert.ok(anthropic["claude-haiku-4-5"] !== undefined);
});

test("Model catalog: DeepSeek models", () => {
  const deepseek = catalogFor("deepseek");
  assert.ok(deepseek["deepseek-v4-flash"] !== undefined);
  assert.ok(deepseek["deepseek-v3"] !== undefined);
});

test("Model catalog: Ollama models", () => {
  const ollama = catalogFor("ollama");
  assert.ok(ollama["llama3.1:8b"] !== undefined);
  assert.ok(ollama["mistral:latest"] !== undefined);
});

test("Model catalog: LM Studio models", () => {
  const lmstudio = catalogFor("lmstudio");
  assert.ok(lmstudio["opus-4-7"] !== undefined);
});

test("isVisionCapableModel: empty string", () => {
  assert.strictEqual(isVisionCapableModel(""), false);
});

test("isVisionCapableModel: non-string inputs", () => {
  // Although TS types catch this, at runtime we shouldn't throw when fed bad data
  assert.strictEqual(isVisionCapableModel(null as unknown as string), false);
  assert.strictEqual(isVisionCapableModel(undefined as unknown as string), false);
  assert.strictEqual(isVisionCapableModel(123 as unknown as string), false);
  assert.strictEqual(isVisionCapableModel({} as unknown as string), false);
});

test("isVisionCapableModel: NaN and Infinity", () => {
  assert.strictEqual(isVisionCapableModel(NaN as unknown as string), false);
  assert.strictEqual(isVisionCapableModel(Infinity as unknown as string), false);
});

test("isVisionCapableModel: true for known vision patterns", () => {
  assert.strictEqual(isVisionCapableModel("gpt-4-vision"), true);
  assert.strictEqual(isVisionCapableModel("claude-3-opus"), true);
  assert.strictEqual(isVisionCapableModel("llava-1.5"), true);
  assert.strictEqual(isVisionCapableModel("gemini-1.5-pro"), true);
  assert.strictEqual(isVisionCapableModel("qwen-vl-max"), true);
  assert.strictEqual(isVisionCapableModel("minimax-m3"), true);
});

test("isVisionCapableModel: false for text-only models", () => {
  assert.strictEqual(isVisionCapableModel("llama-3"), false);
  assert.strictEqual(isVisionCapableModel("mixtral-8x7b"), false);
  assert.strictEqual(isVisionCapableModel("command-r"), false);
  assert.strictEqual(isVisionCapableModel("deepseek-coder"), false);
});

test("isVisionCapableModel: case insensitive", () => {
  assert.strictEqual(isVisionCapableModel("GPT-4-VISION"), true);
  assert.strictEqual(isVisionCapableModel("Claude-3-Opus"), true);
  assert.strictEqual(isVisionCapableModel("MiniMax-M3"), true);
  assert.strictEqual(isVisionCapableModel("Opus-4"), true);
  assert.strictEqual(isVisionCapableModel("Gpt-4o"), true);
  assert.strictEqual(isVisionCapableModel("GEMINI-1.5-pro"), true);
  assert.strictEqual(isVisionCapableModel("QWEN-VL-MAX"), true);
});

test("isVisionCapableModel: false for unrelated handles containing vision keywords", () => {
  assert.strictEqual(isVisionCapableModel("gpt-oss-text-only-stub"), false);
});

test("isVisionCapableModel: word-boundary 'vl' logic", () => {
  // Should match "vl"
  assert.strictEqual(isVisionCapableModel("qwen-vl"), true);
  assert.strictEqual(isVisionCapableModel("qwen2-vl"), true);
  // Shouldn't match vllm
  assert.strictEqual(isVisionCapableModel("meta-llama/Meta-Llama-3-8B-Instruct-vllm"), false);
});

test("isVisionCapableModel: VISION_MODEL_PATTERNS detected with provider prefixes case-insensitively", () => {
  // Ensure we can iterate over the patterns array exported from model-catalog
  assert.ok(VISION_MODEL_PATTERNS.length > 0, "VISION_MODEL_PATTERNS should not be empty");

  for (const pattern of VISION_MODEL_PATTERNS) {
    // If the pattern is word boundary dependent like 'vl', skip basic includes checks
    // or handle specially. Since qwen-vl and qwen2-vl are explicitly in the patterns array,
    // they act as standard substrings here.

    // Test lowercase
    assert.strictEqual(isVisionCapableModel(`provider/prefix-${pattern}-suffix`), true);

    // Test uppercase
    assert.strictEqual(isVisionCapableModel(`PROVIDER/PREFIX-${pattern.toUpperCase()}-SUFFIX`), true);

    // Test mixed case
    const mixedCasePattern = pattern.split('').map((c, i) => i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()).join('');
    assert.strictEqual(isVisionCapableModel(`Provider/Prefix-${mixedCasePattern}-Suffix`), true);
  }
});

test("getDefaultOpenAIModels: returns expected hardcoded models", () => {
  const models = getDefaultOpenAIModels();
  assert.ok(Array.isArray(models), "Should return an array");
  assert.ok(models.length > 0, "Should return at least one model");
  assert.ok(models.includes("gpt-4o"));
  assert.ok(models.includes("gpt-4-turbo"));
  assert.ok(models.includes("gpt-4"));
});

test("getDefaultAnthropicModels: returns expected hardcoded models", () => {
  const models = getDefaultAnthropicModels();
  assert.ok(Array.isArray(models), "Should return an array");
  assert.ok(models.length > 0, "Should return at least one model");
  assert.ok(models.includes("claude-fable-5"));
  assert.ok(models.includes("claude-opus-4-8"));
  assert.ok(models.includes("claude-sonnet-4-6"));
});

test("getDefaultDeepSeekModels: returns expected hardcoded models", () => {
  const models = getDefaultDeepSeekModels();
  assert.ok(Array.isArray(models), "Should return an array");
  assert.ok(models.length > 0, "Should return at least one model");
  assert.ok(models.includes("deepseek-v4-flash"));
  assert.ok(models.includes("deepseek-v3"));
});


test("getOpenAICompatibleModelsFromEnv: returns defaults when env var is unset", () => {
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  delete process.env["OPENAI_LIKE_API_MODELS"];
  try {
    const models = getOpenAICompatibleModelsFromEnv();
    assert.ok(Array.isArray(models));
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
  } finally {
    if (prev !== undefined) process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("getOpenAICompatibleModelsFromEnv: returns defaults when env var is empty string", () => {
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  process.env["OPENAI_LIKE_API_MODELS"] = "";
  try {
    const models = getOpenAICompatibleModelsFromEnv();
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
  } finally {
    if (prev === undefined) delete process.env["OPENAI_LIKE_API_MODELS"];
    else process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("getOpenAICompatibleModelsFromEnv: parses a single-model JSON array", () => {
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  process.env["OPENAI_LIKE_API_MODELS"] = JSON.stringify(["custom-model-x"]);
  try {
    const models = getOpenAICompatibleModelsFromEnv();
    assert.deepStrictEqual(models, ["custom-model-x"]);
  } finally {
    if (prev === undefined) delete process.env["OPENAI_LIKE_API_MODELS"];
    else process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("getOpenAICompatibleModelsFromEnv: parses a multi-model JSON array preserving order", () => {
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  process.env["OPENAI_LIKE_API_MODELS"] = JSON.stringify(["alpha", "beta", "gamma", "delta"]);
  try {
    const models = getOpenAICompatibleModelsFromEnv();
    assert.deepStrictEqual(models, ["alpha", "beta", "gamma", "delta"]);
  } finally {
    if (prev === undefined) delete process.env["OPENAI_LIKE_API_MODELS"];
    else process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("getOpenAICompatibleModelsFromEnv: falls back to defaults on malformed JSON", () => {
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  process.env["OPENAI_LIKE_API_MODELS"] = "this is not valid json {[";
  try {
    const models = getOpenAICompatibleModelsFromEnv();
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
  } finally {
    if (prev === undefined) delete process.env["OPENAI_LIKE_API_MODELS"];
    else process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("getOpenAICompatibleModelsFromEnv: falls back to defaults on valid JSON that is not a string array", () => {
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  // Object instead of array.
  process.env["OPENAI_LIKE_API_MODELS"] = JSON.stringify({ model: "x" });
  try {
    const models = getOpenAICompatibleModelsFromEnv();
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
  } finally {
    if (prev === undefined) delete process.env["OPENAI_LIKE_API_MODELS"];
    else process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("getOpenAICompatibleModelsFromEnv: falls back to defaults when array contains non-string entries", () => {
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  process.env["OPENAI_LIKE_API_MODELS"] = JSON.stringify(["ok", 42, true, null]);
  try {
    const models = getOpenAICompatibleModelsFromEnv();
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
  } finally {
    if (prev === undefined) delete process.env["OPENAI_LIKE_API_MODELS"];
    else process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("getOpenAICompatibleModelsFromEnv: empty JSON array yields empty result (no defaults)", () => {
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  process.env["OPENAI_LIKE_API_MODELS"] = "[]";
  try {
    const models = getOpenAICompatibleModelsFromEnv();
    assert.deepStrictEqual(models, []);
  } finally {
    if (prev === undefined) delete process.env["OPENAI_LIKE_API_MODELS"];
    else process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

type FetchFn = (input: unknown, init?: unknown) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

async function withMockFetch<T>(fake: FetchFn, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("discoverOpenAICompatibleModels: returns parsed model ids on a 200 /models response", async () => {
  const fake: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "gpt-4o" }, { id: "gpt-4-turbo" }, { id: "custom-1" }] }),
  });
  await withMockFetch(fake, async () => {
    const models = await discoverOpenAICompatibleModels("https://example.com/v1");
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "custom-1"]);
  });
});

test("discoverOpenAICompatibleModels: falls back to env defaults when /models returns empty data array", async () => {
  const fake: FetchFn = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  await withMockFetch(fake, async () => {
    const models = await discoverOpenAICompatibleModels("https://example.com/v1");
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
  });
});

test("discoverOpenAICompatibleModels: falls back to env defaults on non-OK status", async () => {
  const fake: FetchFn = async () => ({ ok: false, status: 503, json: async () => ({ error: "unavailable" }) });
  await withMockFetch(fake, async () => {
    const models = await discoverOpenAICompatibleModels("https://example.com/v1");
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
  });
});

test("discoverOpenAICompatibleModels: falls back to env defaults when fetch throws", async () => {
  const fake: FetchFn = async () => { throw new Error("network down"); };
  await withMockFetch(fake, async () => {
    const models = await discoverOpenAICompatibleModels("https://example.com/v1");
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
  });
});

test("discoverOpenAICompatibleModels: falls back to env defaults on response payload shape mismatch", async () => {
  const fake: FetchFn = async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: "not-data" }] }) });
  await withMockFetch(fake, async () => {
    const models = await discoverOpenAICompatibleModels("https://example.com/v1");
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
  });
});

test("discoverOpenAICompatibleModels: respects a small timeoutMs and falls back when aborted", async () => {
  const fake: FetchFn = async (_input, init) => new Promise((_resolve, reject) => {
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  await withMockFetch(fake, async () => {
    const models = await discoverOpenAICompatibleModels("https://example.com/v1", 1);
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
  });
});

