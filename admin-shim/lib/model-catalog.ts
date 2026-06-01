/**
 * Model catalog infrastructure for Letta-compatible shim.
 *
 * Provides:
 * - Robust model handle parsing (provider/model-name format)
 * - Provider → endpoint type mapping
 * - Fallback model discovery (static catalog + /models endpoint)
 * - Safe version matching and normalization
 *
 * Design principles:
 * - Handle format is canonical: "provider/model-name" (e.g., "openai/gpt-4o")
 * - Endpoint type stored separately in LLMConfig (not derived from handle)
 * - Graceful degradation: /models endpoint → env var → hardcoded fallback
 * - Both dash and dot notation for versions are normalized (e.g., claude-opus-4-6 vs claude-opus-4.6)
 */

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export interface ParsedModelHandle {
  provider: string;
  model: string;
}

export type EndpointType =
  | "openai"
  | "anthropic"
  | "bedrock"
  | "google_ai"
  | "google_vertex"
  | "azure"
  | "groq"
  | "mistral"
  | "together"
  | "deepseek"
  | "ollama"
  | "lmstudio"
  | "unknown";

export interface ModelMetadata {
  id: string; // bare model name (e.g., "gpt-4o")
  name: string; // display name
  contextWindow: number;
  maxTokens?: number;
  capabilities?: string[];
  pricing?: {
    inputCost?: number; // per 1M tokens
    outputCost?: number; // per 1M tokens
  };
  releaseDate?: string; // ISO 8601
  family?: string; // e.g., "gpt-4", "claude-opus"
  deprecated?: boolean;
}

export interface ProviderCatalog {
  [modelId: string]: ModelMetadata;
}

export interface ModelCatalog {
  [provider: string]: ProviderCatalog;
}

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

export const KNOWN_PROVIDERS = [
  "openai",
  "anthropic",
  "deepseek",
  "ollama",
  "lmstudio",
  "groq",
  "mistral",
  "together",
  "bedrock",
  "azure",
  "google_ai",
  "google_vertex",
] as const;

export const PROVIDER_TO_ENDPOINT_TYPE: Record<string, EndpointType> = {
  openai: "openai",
  anthropic: "anthropic",
  deepseek: "openai", // OpenAI-compatible
  ollama: "openai", // OpenAI-compatible
  lmstudio: "openai", // OpenAI-compatible
  groq: "openai", // OpenAI-compatible
  mistral: "openai", // OpenAI-compatible
  together: "openai", // OpenAI-compatible
  bedrock: "bedrock",
  azure: "azure",
  google_ai: "google_ai",
  google_vertex: "google_vertex",
};

/**
 * Hardcoded fallback model catalog.
 * Used when /models endpoint is unavailable or env var not set.
 * Sourced from real-world usage patterns (superagent, cline, openclaw, etc.)
 */
export const FALLBACK_MODEL_CATALOG: ModelCatalog = {
  openai: {
    "gpt-5.5": {
      id: "gpt-5.5",
      name: "GPT-5.5",
      contextWindow: 1050000,
      maxTokens: 128000,
      family: "gpt-5",
      capabilities: ["text", "vision", "reasoning"],
      releaseDate: "2026-04-23",
    },
    "gpt-5.3-codex-spark": {
      id: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      contextWindow: 400000,
      maxTokens: 128000,
      family: "gpt-5",
      capabilities: ["text", "vision", "code", "reasoning"],
      releaseDate: "2026-05-22",
    },
    "gpt-5-codex": {
      id: "gpt-5-codex",
      name: "GPT-5 Codex",
      contextWindow: 200000,
      maxTokens: 16384,
      family: "gpt-5",
      capabilities: ["text", "code"],
      releaseDate: "2026-01-01",
    },
    "gpt-5": {
      id: "gpt-5",
      name: "GPT-5",
      contextWindow: 200000,
      maxTokens: 16384,
      family: "gpt-5",
      capabilities: ["text"],
      releaseDate: "2025-12-01",
    },
    "gpt-5-mini": {
      id: "gpt-5-mini",
      name: "GPT-5 Mini",
      contextWindow: 128000,
      maxTokens: 8192,
      family: "gpt-5",
      capabilities: ["text"],
      releaseDate: "2025-12-15",
    },
    "gpt-4o": {
      id: "gpt-4o",
      name: "GPT-4 Omni",
      contextWindow: 128000,
      maxTokens: 16384,
      family: "gpt-4",
      capabilities: ["text", "vision"],
      releaseDate: "2024-05-13",
    },
    "gpt-4-turbo": {
      id: "gpt-4-turbo",
      name: "GPT-4 Turbo",
      contextWindow: 128000,
      maxTokens: 4096,
      family: "gpt-4",
      capabilities: ["text", "vision"],
      releaseDate: "2023-11-06",
    },
    "gpt-4": {
      id: "gpt-4",
      name: "GPT-4",
      contextWindow: 8192,
      maxTokens: 2048,
      family: "gpt-4",
      capabilities: ["text"],
      releaseDate: "2023-03-14",
    },
    "gpt-3.5-turbo": {
      id: "gpt-3.5-turbo",
      name: "GPT-3.5 Turbo",
      contextWindow: 4096,
      maxTokens: 2048,
      family: "gpt-3.5",
      capabilities: ["text"],
      releaseDate: "2022-11-30",
      deprecated: true,
    },
    "o1": {
      id: "o1",
      name: "O1",
      contextWindow: 128000,
      maxTokens: 32768,
      family: "o1",
      capabilities: ["text", "reasoning"],
      releaseDate: "2024-12-20",
    },
    "o3": {
      id: "o3",
      name: "O3",
      contextWindow: 200000,
      maxTokens: 32768,
      family: "o3",
      capabilities: ["text", "reasoning"],
      releaseDate: "2025-12-20",
    },
  },
  anthropic: {
    "claude-opus-4-8": {
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      contextWindow: 1000000,
      maxTokens: 16384,
      family: "claude-opus",
      capabilities: ["text"],
      releaseDate: "2026-05-22",
    },
    "claude-opus-4-7": {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      contextWindow: 1000000,
      maxTokens: 16384,
      family: "claude-opus",
      capabilities: ["text"],
      releaseDate: "2026-01-15",
    },
    "claude-opus-4-6": {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      contextWindow: 200000,
      maxTokens: 16384,
      family: "claude-opus",
      capabilities: ["text"],
      releaseDate: "2025-11-01",
    },
    "claude-opus-4-5": {
      id: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      contextWindow: 200000,
      maxTokens: 16384,
      family: "claude-opus",
      capabilities: ["text"],
      releaseDate: "2025-10-01",
    },
    "claude-sonnet-4-6": {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      contextWindow: 200000,
      maxTokens: 8192,
      family: "claude-sonnet",
      capabilities: ["text"],
      releaseDate: "2025-11-01",
    },
    "claude-haiku-4-5": {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      contextWindow: 200000,
      maxTokens: 4096,
      family: "claude-haiku",
      capabilities: ["text"],
      releaseDate: "2025-10-01",
    },
  },
  deepseek: {
    "deepseek-v4-flash": {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      contextWindow: 128000,
      maxTokens: 8192,
      family: "deepseek-v4",
      capabilities: ["text"],
      releaseDate: "2025-12-01",
    },
    "deepseek-v3": {
      id: "deepseek-v3",
      name: "DeepSeek V3",
      contextWindow: 64000,
      maxTokens: 8192,
      family: "deepseek-v3",
      capabilities: ["text"],
      releaseDate: "2024-12-26",
    },
  },
  ollama: {
    "llama3.1:8b": {
      id: "llama3.1:8b",
      name: "Llama 3.1 8B",
      contextWindow: 8192,
      maxTokens: 2048,
      family: "llama3.1",
      capabilities: ["text"],
      releaseDate: "2024-07-23",
    },
    "mistral:latest": {
      id: "mistral:latest",
      name: "Mistral Latest",
      contextWindow: 32000,
      maxTokens: 8192,
      family: "mistral",
      capabilities: ["text"],
      releaseDate: "2024-01-01",
    },
  },
  lmstudio: {
    "opus-4-7": {
      id: "opus-4-7",
      name: "Opus 4.7 (LM Studio)",
      contextWindow: 200000,
      maxTokens: 16384,
      family: "opus",
      capabilities: ["text"],
      releaseDate: "2026-01-15",
    },
  },
};

// ──────────────────────────────────────────────────────────────────────
// Model handle parsing
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse a model handle into provider and model name.
 *
 * Format: "provider/model-name"
 * Examples:
 *   "openai/gpt-4o" → { provider: "openai", model: "gpt-4o" }
 *   "anthropic/claude-opus-4-7" → { provider: "anthropic", model: "claude-opus-4-7" }
 *   "gpt-4o" → { provider: "unknown", model: "gpt-4o" }
 *   null/undefined → { provider: "unknown", model: "unknown" }
 */
export function parseModelHandle(handle: unknown): ParsedModelHandle {
  if (!handle || typeof handle !== "string") {
    return { provider: "unknown", model: "unknown" };
  }

  const idx = handle.indexOf("/");
  if (idx < 0) {
    return { provider: "unknown", model: handle };
  }

  return {
    provider: handle.slice(0, idx),
    model: handle.slice(idx + 1),
  };
}

/**
 * Construct a model handle from provider and model name.
 *
 * Examples:
 *   ("openai", "gpt-4o") → "openai/gpt-4o"
 *   ("unknown", "gpt-4o") → "gpt-4o"
 */
export function constructModelHandle(provider: string, model: string): string {
  if (provider === "unknown" || !provider) {
    return model;
  }
  return `${provider}/${model}`;
}

// ──────────────────────────────────────────────────────────────────────
// Provider → endpoint type mapping
// ──────────────────────────────────────────────────────────────────────

/**
 * Map a provider name to its endpoint type.
 * Used to determine which API client to use (OpenAI-compatible, Anthropic, etc.)
 */
export function getEndpointType(provider: string): EndpointType {
  return PROVIDER_TO_ENDPOINT_TYPE[provider] ?? "unknown";
}

/**
 * Check if a provider is known.
 */
export function isKnownProvider(provider: string): boolean {
  return (KNOWN_PROVIDERS as readonly string[]).includes(provider);
}

function isOpenAIModelListResponse(value: unknown): value is { data: Array<{ id: string }> } {
  if (typeof value !== "object" || value === null || !("data" in value)) return false;
  const data = (value as { data: unknown }).data;
  return Array.isArray(data) && data.every((item) => {
    if (typeof item !== "object" || item === null || !("id" in item)) return false;
    return typeof (item as { id: unknown }).id === "string";
  });
}

// ──────────────────────────────────────────────────────────────────────
// Version normalization
// ──────────────────────────────────────────────────────────────────────

/**
 * Normalize Anthropic model versions.
 * Both dash and dot notation are valid in the wild; normalize to dash form.
 *
 * Examples:
 *   "claude-opus-4.6" → "claude-opus-4-6"
 *   "claude-opus-4-6" → "claude-opus-4-6"
 *   "claude-sonnet-4.6" → "claude-sonnet-4-6"
 */
export function normalizeAnthropicVersion(model: string): string {
  // Replace dot notation with dash for version numbers
  // e.g., "claude-opus-4.6" → "claude-opus-4-6"
  return model.replace(/(\d)\.(\d)/g, "$1-$2");
}

/**
 * Find the nearest available model version in a catalog.
 * Useful for suggesting fallbacks when a requested model doesn't exist.
 *
 * Examples:
 *   findNearestModel("claude-opus-4-8", anthropic_catalog)
 *   → "claude-opus-4-7" (if 4-8 doesn't exist but 4-7 does)
 */
export function findNearestModel(
  requestedModel: string,
  catalog: ProviderCatalog,
): string | null {
  // Exact match
  if (catalog[requestedModel]) {
    return requestedModel;
  }

  // For Anthropic, try normalized version
  if (requestedModel.includes("claude")) {
    const normalized = normalizeAnthropicVersion(requestedModel);
    if (catalog[normalized]) {
      return normalized;
    }
  }

  // Fallback: return the first available model in the catalog
  const available = Object.keys(catalog).filter((m) => !catalog[m]?.deprecated);
  return available[0] ?? null;
}

// ──────────────────────────────────────────────────────────────────────
// Model discovery
// ──────────────────────────────────────────────────────────────────────

/**
 * Fetch available models from an OpenAI-compatible /models endpoint.
 * Gracefully degrades to env var fallback, then hardcoded catalog.
 *
 * Returns: array of model IDs (bare names, e.g., ["gpt-4o", "gpt-4-turbo"])
 */
export async function discoverOpenAICompatibleModels(
  baseUrl: string,
  timeoutMs: number = 5000,
): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${baseUrl}/models`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(
        `[model-catalog] /models endpoint returned ${response.status}, falling back to env var`,
      );
      return getOpenAICompatibleModelsFromEnv();
    }

    const data = (await response.json()) as unknown;
    if (isOpenAIModelListResponse(data)) {
      const models = data.data.map((item) => item.id);
      return models.length > 0 ? models : getOpenAICompatibleModelsFromEnv();
    }

    return getOpenAICompatibleModelsFromEnv();
  } catch (err) {
    console.warn(
      `[model-catalog] Failed to fetch /models: ${err instanceof Error ? err.message : String(err)}, falling back to env var`,
    );
    return getOpenAICompatibleModelsFromEnv();
  }
}

/**
 * Get OpenAI-compatible models from OPENAI_LIKE_API_MODELS env var.
 * Expected format: JSON array of model IDs, e.g., '["gpt-4o", "gpt-4-turbo"]'
 */
export function getOpenAICompatibleModelsFromEnv(): string[] {
  const envVar = process.env["OPENAI_LIKE_API_MODELS"];
  if (!envVar) {
    return getDefaultOpenAIModels();
  }

  try {
    const parsed = JSON.parse(envVar);
    if (Array.isArray(parsed) && parsed.every((m) => typeof m === "string")) {
      return parsed;
    }
  } catch (err) {
    console.warn(
      `[model-catalog] Failed to parse OPENAI_LIKE_API_MODELS: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return getDefaultOpenAIModels();
}

/**
 * Get default OpenAI models (hardcoded fallback).
 */
export function getDefaultOpenAIModels(): string[] {
  return ["gpt-4o", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo"];
}

/**
 * Get default Anthropic models (hardcoded fallback).
 */
export function getDefaultAnthropicModels(): string[] {
  return ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"];
}

/**
 * Get default DeepSeek models (hardcoded fallback).
 */
export function getDefaultDeepSeekModels(): string[] {
  return ["deepseek-v4-flash", "deepseek-v3"];
}

// ──────────────────────────────────────────────────────────────────────
// Safety guardrails
// ──────────────────────────────────────────────────────────────────────

/**
 * Validate a model handle and suggest a fallback if invalid.
 *
 * Returns:
 *   - { valid: true, handle, provider, model } if valid
 *   - { valid: false, suggested: "provider/model", reason: "..." } if invalid
 */
export function validateModelHandle(
  handle: unknown,
): { valid: true; handle: string; provider: string; model: string } | { valid: false; suggested: string; reason: string } {
  const parsed = parseModelHandle(handle);

  // Unknown provider is a warning but not a hard error
  if (parsed.provider === "unknown") {
    return {
      valid: false,
      suggested: `lmstudio/${parsed.model}`,
      reason: `Unknown provider in handle "${handle}"; suggested fallback: lmstudio/${parsed.model}`,
    };
  }

  // Check if provider is known
  if (!isKnownProvider(parsed.provider)) {
    return {
      valid: false,
      suggested: `lmstudio/${parsed.model}`,
      reason: `Provider "${parsed.provider}" not in known list; suggested fallback: lmstudio/${parsed.model}`,
    };
  }

  // Check if model exists in catalog
  const catalog = FALLBACK_MODEL_CATALOG[parsed.provider];
  if (!catalog) {
    return {
      valid: false,
      suggested: `lmstudio/opus-4-7`,
      reason: `No catalog entry for provider "${parsed.provider}"; using default fallback`,
    };
  }

  const nearest = findNearestModel(parsed.model, catalog);
  if (!nearest) {
    return {
      valid: false,
      suggested: `${parsed.provider}/${Object.keys(catalog)[0]}`,
      reason: `Model "${parsed.model}" not found in ${parsed.provider} catalog; suggested: ${parsed.provider}/${Object.keys(catalog)[0]}`,
    };
  }

  if (nearest !== parsed.model) {
    return {
      valid: false,
      suggested: `${parsed.provider}/${nearest}`,
      reason: `Model "${parsed.model}" not found; nearest available: ${parsed.provider}/${nearest}`,
    };
  }

  return {
    valid: true,
    handle: `${parsed.provider}/${parsed.model}`,
    provider: parsed.provider,
    model: parsed.model,
  };
}

/**
 * Get a safe fallback model handle.
 * Used when validation fails or model is unavailable.
 */
export function getSafeFallbackModel(): string {
  return "lmstudio/opus-4-7";
}
