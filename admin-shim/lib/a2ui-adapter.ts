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

export function augmentUserInputForA2ui(
  userInput: string | unknown[],
  capability: A2uiCapability | null | undefined,
): string | unknown[] {
  if (!capability) return userInput;
  const augmentation = buildA2uiSystemPrompt(capability);
  if (Array.isArray(userInput)) {
    return [
      { type: "text", text: augmentation },
      ...userInput,
    ];
  }
  return `${augmentation}\n\nUser request:\n${userInput}`;
}
