import { A2UI_V09_BASIC_PROMPT_TEMPLATE } from "./a2ui-v09-basic-prompt.js";

export const DEFAULT_A2UI_VERSION = "0.9";
export const DEFAULT_A2UI_CATALOG_ID = "basic";

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
    supportedWidgets: [
      "Text",
      "Button",
      "Card",
      "Form",
      "List",
      "TextField",
      "ChoicePicker",
      "StatusBeacon",
      "ToolApprovalCard",
    ],
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
  return value as Readonly<Record<string, unknown>>;
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

  return {
    version,
    catalogId: server.catalogId,
    supportedCatalogs: catalogs,
    supportedWidgets: requestedWidgets,
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
    .replace("__A2UI_UI_DESCRIPTION__", server.uiDescription);

  return [
    prompt,
    "## Shim Session Capability Negotiation:",
    `A2UI dynamic UI mode is enabled for this session. Target A2UI version: ${capability.version}. Catalog: ${capability.catalogId}.`,
    `The connected client declared render support for: ${widgets}.`,
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
