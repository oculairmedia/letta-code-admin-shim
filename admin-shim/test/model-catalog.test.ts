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
  FALLBACK_MODEL_CATALOG,
  KNOWN_PROVIDERS,
  PROVIDER_TO_ENDPOINT_TYPE,
  type ProviderCatalog,
  getDefaultOpenAIModels,
  getDefaultAnthropicModels,
  getDefaultDeepSeekModels,
  getOpenAICompatibleModelsFromEnv,
  discoverOpenAICompatibleModels,
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


// ──────────────────────────────────────────────────────────────────────
// discoverOpenAICompatibleModels — async discovery via /models endpoint.
// Mocks globalThis.fetch; restores original fetch on test teardown.
// ──────────────────────────────────────────────────────────────────────

type FetchFn = (input: unknown, init?: unknown) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

function withMockFetch<T>(
  t: { mock: { restoreAll?: () => void } } | unknown,
  fake: FetchFn,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake as typeof globalThis.fetch;
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      globalThis.fetch = original;
    });
}

test("discoverOpenAICompatibleModels: returns parsed model ids on a 200 /models response", async () => {
  const fake: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "gpt-4o" }, { id: "gpt-4-turbo" }, { id: "custom-1" }] }),
  });
  await withMockFetch(null, fake, async () => {
    const models = await discoverOpenAICompatibleModels("https://example.com/v1");
    assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "custom-1"]);
  });
});

test("discoverOpenAICompatibleModels: falls back to env defaults when /models returns empty data array", async () => {
  const fake: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  });
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  delete process.env["OPENAI_LIKE_API_MODELS"];
  try {
    await withMockFetch(null, fake, async () => {
      const models = await discoverOpenAICompatibleModels("https://example.com/v1");
      assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
    });
  } finally {
    if (prev !== undefined) process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("discoverOpenAICompatibleModels: falls back to env defaults on non-OK status", async () => {
  const fake: FetchFn = async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  });
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  process.env["OPENAI_LIKE_API_MODELS"] = JSON.stringify(["env-fallback-1"]);
  try {
    await withMockFetch(null, fake, async () => {
      const models = await discoverOpenAICompatibleModels("https://example.com/v1");
      assert.deepStrictEqual(models, ["env-fallback-1"]);
    });
  } finally {
    if (prev === undefined) delete process.env["OPENAI_LIKE_API_MODELS"];
    else process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("discoverOpenAICompatibleModels: falls back to env defaults when fetch throws (network error)", async () => {
  const fake: FetchFn = async () => {
    throw new Error("ECONNREFUSED");
  };
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  delete process.env["OPENAI_LIKE_API_MODELS"];
  try {
    await withMockFetch(null, fake, async () => {
      const models = await discoverOpenAICompatibleModels("https://example.com/v1");
      assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
    });
  } finally {
    if (prev !== undefined) process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("discoverOpenAICompatibleModels: falls back to env defaults on response payload shape mismatch", async () => {
  // /models returns something that isn't the OpenAI { data: [{id}] } shape.
  const fake: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ models: ["x", "y"] }), // wrong shape
  });
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  delete process.env["OPENAI_LIKE_API_MODELS"];
  try {
    await withMockFetch(null, fake, async () => {
      const models = await discoverOpenAICompatibleModels("https://example.com/v1");
      assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
    });
  } finally {
    if (prev !== undefined) process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});

test("discoverOpenAICompatibleModels: respects a small timeoutMs and falls back when aborted", async () => {
  // Simulate an AbortError-style rejection from fetch when the timeout fires.
  const fake: FetchFn = async (_input, init) => {
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw new Error("should not reach");
  };
  const prev = process.env["OPENAI_LIKE_API_MODELS"];
  delete process.env["OPENAI_LIKE_API_MODELS"];
  try {
    await withMockFetch(null, fake, async () => {
      const models = await discoverOpenAICompatibleModels("https://example.com/v1", 25);
      assert.deepStrictEqual(models, ["gpt-4o", "gpt-4-turbo", "gpt-4"]);
    });
  } finally {
    if (prev !== undefined) process.env["OPENAI_LIKE_API_MODELS"] = prev;
  }
});
