import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { A2UI_V09_BASIC_PROMPT_TEMPLATE } from "./a2ui-v09-basic-prompt.js";

// Handshake/capability frames use the shim-local version string ("0.9").
// A2UI JSON message envelopes remain upstream-spec shaped and require
// `version: "v0.9"`; see validateA2uiMessage in a2ui-stream-splitter.ts.
export const DEFAULT_A2UI_VERSION = "0.9";
export const DEFAULT_A2UI_CATALOG_ID = "basic";
const UPSTREAM_A2UI_BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json";
const DEFAULT_A2UI_SUPPORTED_WIDGETS = [
  "Text",
  "Button",
  "Card",
  "List",
  "TextField",
  "ChoicePicker",
] as const;

export interface A2uiCapability {
  version: string;
  catalogId: string;
  supportedCatalogs: readonly string[];
  supportedWidgets: readonly string[];
  themeHints?: Readonly<Record<string, unknown>>;
}

export interface A2uiServerCapabilities {
  enabled: boolean;
  version: string;
  catalogId: string;
  roleDescription: string;
  uiDescription: string;
  supportedCatalogs: readonly string[];
  supportedWidgets: readonly string[];
}

const A2UI_PRIMARY_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envString(name: string, defaultValue: string): string {
  const raw = process.env[name];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : defaultValue;
}

export function getA2uiServerCapabilities(): A2uiServerCapabilities {
  const version = envString("A2UI_VERSION", DEFAULT_A2UI_VERSION);
  const catalogId = envString("A2UI_CATALOG_ID", DEFAULT_A2UI_CATALOG_ID);
  return {
    enabled: envFlag("A2UI_ENABLED", false),
    version,
    catalogId,
    roleDescription: envString("A2UI_ROLE_DESCRIPTION", "You are a Letta agent that can emit A2UI dynamic interface messages when useful."),
    uiDescription: envString("A2UI_UI_DESCRIPTION", "Use the A2UI v0.9 Basic Catalog to create concise, safe, task-focused UI surfaces for the connected client."),
    supportedCatalogs: [catalogId],
    supportedWidgets: DEFAULT_A2UI_SUPPORTED_WIDGETS,
  };
}

function asStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) return null;
    out.push(item.trim());
  }
  return out;
}

function asThemeHints(value: unknown): Readonly<Record<string, unknown>> | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const hints = { ...(value as Record<string, unknown>) };
  const primaryColor = hints["primaryColor"];
  if (primaryColor !== undefined && (typeof primaryColor !== "string" || !A2UI_PRIMARY_COLOR_RE.test(primaryColor))) {
    console.error("[a2ui] ignoring invalid theme_hints.primaryColor; expected ^#[0-9a-fA-F]{6}$");
    delete hints["primaryColor"];
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}

function buildThemeHintsPrompt(themeHints: Readonly<Record<string, unknown>> | undefined): string | null {
  if (!themeHints) return null;
  return [
    "Client theme hints for A2UI surfaces:",
    JSON.stringify(themeHints),
    "When emitting createSurface, set createSurface.theme from these sanitized hints when useful. theme.primaryColor, if present, is already validated as a strict 6-digit hex string. color_scheme is a renderer preference hint (light/dark/system), not a direct primaryColor value.",
  ].join("\n");
}

export function negotiateA2uiCapability(
  helloFrame: Readonly<Record<string, unknown>>,
  server = getA2uiServerCapabilities(),
): A2uiCapability | null {
  const requestedVersion = helloFrame["a2ui_version"];
  const requestedCatalogs = asStringArray(helloFrame["supported_catalogs"]);
  const requestedWidgets = asStringArray(helloFrame["supported_widgets"]);
  const themeHints = asThemeHints(helloFrame["theme_hints"]);

  if (requestedCatalogs === null || requestedWidgets === null || themeHints === null) return null;
  if (requestedVersion === undefined || requestedVersion === null || requestedVersion === "") return null;
  if (typeof requestedVersion !== "string") return null;
  if (!server.enabled) return null;

  const version = requestedVersion.trim();
  if (version !== server.version) return null;

  const catalogs = requestedCatalogs.length > 0 ? requestedCatalogs : [server.catalogId];
  if (!catalogs.includes(server.catalogId)) return null;
  const supportedByServer = new Set(server.supportedWidgets);
  const widgets = requestedWidgets.filter((widget) => supportedByServer.has(widget));

  return {
    version,
    catalogId: server.catalogId,
    supportedCatalogs: catalogs,
    supportedWidgets: widgets.length > 0 ? widgets : server.supportedWidgets,
    ...(themeHints ? { themeHints } : {}),
  };
}

export function buildA2uiSystemPrompt(capability: A2uiCapability): string {
  const server = getA2uiServerCapabilities();
  const widgets = capability.supportedWidgets.length > 0
    ? capability.supportedWidgets.join(", ")
    : "the standard Basic Catalog widgets";
  const prompt = A2UI_V09_BASIC_PROMPT_TEMPLATE
    .replace("__A2UI_ROLE_DESCRIPTION__", server.roleDescription)
    .replace("__A2UI_UI_DESCRIPTION__", server.uiDescription)
    .replaceAll(UPSTREAM_A2UI_BASIC_CATALOG_ID, capability.catalogId);
  const themeHintsPrompt = buildThemeHintsPrompt(capability.themeHints);

  return [
    prompt,
    "## Shim Session Capability Negotiation:",
    `A2UI dynamic UI mode is enabled for this session. Target A2UI version: ${capability.version}. Catalog: ${capability.catalogId}.`,
    `The connected client declared render support for: ${widgets}.`,
    "Each `<a2ui-json>` block must contain exactly one A2UI v0.9 message object. Do not emit a top-level array; emit multiple adjacent `<a2ui-json>` blocks when you need createSurface plus updateComponents or other multi-message sequences.",
    "Do not set createSurface.sendDataModel to true in this shim profile. User-action data-model delivery is deferred until the tool-dispatcher gate can consume it end-to-end.",
    ...(themeHintsPrompt ? [themeHintsPrompt] : []),
    "Only emit A2UI blocks when a rich UI helps the user; otherwise continue with normal conversational text.",
  ].join("\n\n");
}

// lcp-crp: per-turn injection retired. The 40KB A2UI prompt (97% inline
// JSON Schema) used to be prepended to every user turn here, which
// overflowed context on existing chats. The contract now lives in a
// per-agent core-memory block written by ensureA2uiBlockAttached on first
// A2UI-enabled turn (see below). Kept as a typed no-op for API stability;
// remove in a follow-up after callsites are confirmed clean.
export function augmentUserInputForA2ui(
  userInput: string | unknown[],
  _capability: A2uiCapability | null | undefined,
): string | unknown[] {
  return userInput;
}

// Core-memory block label written into <storageDir>/memfs/<agent>/memory/system/.
// Matches the existing snake_case convention (human, language, matrix_capabilities).
export const A2UI_BLOCK_LABEL = "a2ui_protocol";

function blockStorageDir(): string {
  return (
    process.env["LETTA_LOCAL_BACKEND_DIR"] ||
    join(process.env["LETTA_HOME"] || join(process.env["HOME"] || "/root", ".letta"), "lc-local-backend")
  );
}

// Slim ~2KB block content: rules + examples, NO embedded JSON Schema.
// Letta-code's memfs reader includes every system/*.md file in the agent's
// persistent context on every turn, so the contract is available without
// being re-stuffed into the user message.
export function buildA2uiBlockContent(): string {
  const server = getA2uiServerCapabilities();
  return [
    "# A2UI Dynamic UI Protocol (v0.9, Basic Catalog)",
    "",
    server.roleDescription,
    "",
    "## Output format",
    "- Wrap each A2UI message in `<a2ui-json>` and `</a2ui-json>` tags.",
    "- Each block contains exactly one A2UI v0.9 message object. To send multiple messages, use multiple adjacent `<a2ui-json>` blocks; do NOT use a top-level array.",
    "- Between or around blocks, you may write conversational text.",
    "",
    "## Component ordering",
    "Within `components`:",
    "- The `root` component MUST be the FIRST element.",
    "- Parent components MUST appear before their child components.",
    "This lets the streaming parser render the UI incrementally.",
    "",
    "## Profile rules",
    "- Do NOT set `createSurface.sendDataModel: true` in this shim profile. User-action data-model delivery is deferred until the tool-dispatcher gate can consume it end-to-end.",
    "- Only emit A2UI blocks when a rich UI helps the user; otherwise continue with normal conversational text.",
    "",
    `## Supported widgets (catalog: ${server.catalogId})`,
    server.supportedWidgets.join(", "),
    "",
    "## Examples",
    "",
    "### createSurface — create a new UI surface",
    "<a2ui-json>",
    JSON.stringify(
      {
        version: "v0.9",
        createSurface: {
          surface: { id: "main", root: "rootCard" },
          components: [
            { id: "rootCard", Card: { child: "greeting" } },
            { id: "greeting", Text: { value: "Hello!" } },
          ],
        },
      },
      null,
      2,
    ),
    "</a2ui-json>",
    "",
    "### updateComponents — patch existing components",
    "<a2ui-json>",
    JSON.stringify(
      {
        version: "v0.9",
        updateComponents: {
          surface: "main",
          components: [
            { id: "greeting", Text: { value: "Updated!" } },
          ],
        },
      },
      null,
      2,
    ),
    "</a2ui-json>",
    "",
    "### deleteSurface — close a surface",
    "<a2ui-json>",
    JSON.stringify(
      {
        version: "v0.9",
        deleteSurface: { surface: "main" },
      },
      null,
      2,
    ),
    "</a2ui-json>",
  ].join("\n");
}

// Per-process cache so we touch disk once per agent, not every turn.
const a2uiBlockAttachedAgents = new Set<string>();

// Idempotent: writes <storageDir>/memfs/<agent>/memory/system/a2ui_protocol.md
// to match the canonical block content. Safe to call repeatedly; the in-process
// Set short-circuits subsequent calls for the same agent.
export function ensureA2uiBlockAttached(agentId: string): void {
  if (a2uiBlockAttachedAgents.has(agentId)) return;
  const sysDir = join(blockStorageDir(), "memfs", agentId, "memory", "system");
  const blockPath = join(sysDir, `${A2UI_BLOCK_LABEL}.md`);
  const desired = buildA2uiBlockContent();
  try {
    if (!existsSync(sysDir)) mkdirSync(sysDir, { recursive: true });
    const existing = existsSync(blockPath) ? readFileSync(blockPath, "utf8") : null;
    if (existing !== desired) {
      writeFileSync(blockPath, desired);
    }
    a2uiBlockAttachedAgents.add(agentId);
  } catch (err) {
    // Non-fatal: if attach fails the worst case is the agent loses the
    // contract for one turn. Per-turn augment is already a no-op, so we'd
    // rather miss the UI than break the turn with an unrelated FS error.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[a2ui] ensureA2uiBlockAttached failed for ${agentId}: ${msg}`);
  }
}
