/**
 * Streaming A2UI splitter.
 *
 * The model interleaves conversational text with A2UI JSON blocks wrapped
 * in `<a2ui-json>` ... `</a2ui-json>` tags. This module feeds in raw text
 * deltas (one per assistant_message chunk) and emits two streams:
 *
 *   - text deltas: conversational text safe to forward to the renderer
 *   - a2ui frames: each `<a2ui-json>` block, parsed (and optionally
 *     validated) as a structured A2UI message
 *
 * The splitter holds back any trailing bytes that could form a partial
 * tag opening or closing, so the next chunk can complete them without
 * the wrong half being mis-emitted as user-visible text.
 *
 * Design constraints:
 *   - The splitter is per-turn (lifetime = one assistant reply / one otid).
 *   - Malformed JSON inside a block is dropped with a parse error noted on
 *     the emitted frame so the caller can choose to skip or surface it.
 *   - The splitter never throws; downstream wiring stays robust under
 *     adversarial model output.
 */

const OPEN_TAG = "<a2ui-json>";
const CLOSE_TAG = "</a2ui-json>";

export interface A2uiBlock {
  /** Raw JSON text captured between the tags (no envelope). */
  raw: string;
  /**
   * The result of `JSON.parse(raw)` when parseable, else `null`.
   *
   * The A2UI v0.9 server-to-client schema is a single message object.
   * Multiple messages should be emitted as multiple adjacent
   * `<a2ui-json>` blocks, not as a top-level array inside one block.
   */
  parsed: unknown;
  /**
   * True when JSON parse and the configured structural/envelope validator
   * succeeded. This does not mean the renderer's catalog/schema validation
   * will accept every component in the surface.
   */
  ok: boolean;
  /** Parse error message when JSON.parse failed; else null. */
  parseError: string | null;
  /** Validator-reported failure reason; null when validation passed or no validator wired. */
  validationError: string | null;
}

export interface SplitterOutput {
  /** Text bytes safe to forward as a user-visible delta. May be empty. */
  text: string;
  /** A2UI blocks completed by this feed call. May be empty. */
  frames: A2uiBlock[];
}

export interface FlushResult {
  /** Any trailing text not held back as a partial tag opening. */
  text: string;
  /**
   * True when the splitter ended inside an `<a2ui-json>` block without a
   * matching closing tag — the JSON content is dropped, but callers may
   * want to log a warning.
   */
  unclosed: boolean;
}

export interface A2uiMetrics {
  total_frames: number;
  parse_ok: number;
  parse_err: number;
  validate_ok: number;
  validate_err: number;
  widget_types_seen: string[];
  splitter_overhead_ms: number;
}

export interface SplitterOptions {
  /**
   * Optional validator. Receives the parsed JSON and returns null when
   * the message conforms to the A2UI v0.9 server-to-client contract, or
   * a short error message describing the violation. When omitted, only
   * JSON parseability is enforced.
   */
  validate?: (message: unknown) => string | null;
  /** Fires once from flush() with this splitter's per-turn metrics. */
  onMetrics?: (metrics: A2uiMetrics) => void;
  /** Fires inline when JSON.parse fails for a completed block. */
  onParseError?: (raw: string, error: string) => void;
  /** Fires inline when the validator rejects a parseable completed block. */
  onValidationError?: (raw: string, error: string, widgetType: string | null) => void;
}

export interface A2uiValidationOptions {
  expectedCatalogId?: string | undefined;
}

/**
 * Longest k such that 0 < k < target.length and `s` ends with the first
 * k characters of `target`. Used to hold back a tail that could be the
 * partial start of a tag.
 */
function longestSuffixPrefix(s: string, target: string): number {
  const max = Math.min(s.length, target.length - 1);
  for (let k = max; k > 0; k -= 1) {
    if (s.endsWith(target.slice(0, k))) return k;
  }
  return 0;
}

export class A2uiStreamSplitter {
  private mode: "text" | "tag" = "text";
  private pending = "";
  private jsonBuf = "";
  private readonly validate: ((message: unknown) => string | null) | null;
  private readonly onMetrics: ((metrics: A2uiMetrics) => void) | null;
  private readonly onParseError: ((raw: string, error: string) => void) | null;
  private readonly onValidationError: ((raw: string, error: string, widgetType: string | null) => void) | null;
  private totalFrames = 0;
  private parseOk = 0;
  private parseErr = 0;
  private validateOk = 0;
  private validateErr = 0;
  private splitterOverheadMs = 0;
  private readonly widgetTypesSeen = new Set<string>();

  constructor(options: SplitterOptions = {}) {
    this.validate = options.validate ?? null;
    this.onMetrics = options.onMetrics ?? null;
    this.onParseError = options.onParseError ?? null;
    this.onValidationError = options.onValidationError ?? null;
  }

  /** Feed the next chunk of model text. */
  feed(delta: string): SplitterOutput {
    const started = Date.now();
    try {
    if (typeof delta !== "string" || delta.length === 0) {
      return { text: "", frames: [] };
    }
    this.pending += delta;
    let text = "";
    const frames: A2uiBlock[] = [];

    let progress = true;
    while (progress) {
      progress = false;
      if (this.mode === "text") {
        const idx = this.pending.indexOf(OPEN_TAG);
        if (idx >= 0) {
          text += this.pending.slice(0, idx);
          this.pending = this.pending.slice(idx + OPEN_TAG.length);
          this.mode = "tag";
          this.jsonBuf = "";
          progress = true;
        } else {
          const hold = longestSuffixPrefix(this.pending, OPEN_TAG);
          text += this.pending.slice(0, this.pending.length - hold);
          this.pending = this.pending.slice(this.pending.length - hold);
        }
      } else {
        const idx = this.pending.indexOf(CLOSE_TAG);
        if (idx >= 0) {
          this.jsonBuf += this.pending.slice(0, idx);
          this.pending = this.pending.slice(idx + CLOSE_TAG.length);
          frames.push(this.completeBlock(this.jsonBuf));
          this.jsonBuf = "";
          this.mode = "text";
          progress = true;
        } else {
          const hold = longestSuffixPrefix(this.pending, CLOSE_TAG);
          this.jsonBuf += this.pending.slice(0, this.pending.length - hold);
          this.pending = this.pending.slice(this.pending.length - hold);
        }
      }
    }
    return { text, frames };
    } finally {
      this.splitterOverheadMs += Date.now() - started;
    }
  }

  /**
   * End-of-stream flush. Returns any trailing text held back as a
   * possible tag opening, and reports whether the stream ended mid-tag.
   */
  flush(): FlushResult {
    const started = Date.now();
    try {
    if (this.mode === "tag") {
      this.mode = "text";
      this.jsonBuf = "";
      this.pending = "";
      return { text: "", unclosed: true };
    }
    const text = this.pending;
    this.pending = "";
    return { text, unclosed: false };
    } finally {
      this.splitterOverheadMs += Date.now() - started;
      this.onMetrics?.(this.snapshotMetrics());
    }
  }

  private snapshotMetrics(): A2uiMetrics {
    return {
      total_frames: this.totalFrames,
      parse_ok: this.parseOk,
      parse_err: this.parseErr,
      validate_ok: this.validateOk,
      validate_err: this.validateErr,
      widget_types_seen: [...this.widgetTypesSeen].sort(),
      splitter_overhead_ms: this.splitterOverheadMs,
    };
  }

  private completeBlock(raw: string): A2uiBlock {
    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    this.totalFrames += 1;
    let validationError: string | null = null;
    const widgetType = parseError === null ? firstWidgetType(parsed) : null;
    if (widgetType) this.widgetTypesSeen.add(widgetType);
    if (parseError !== null) {
      this.parseErr += 1;
      this.onParseError?.(raw, parseError);
    } else {
      this.parseOk += 1;
    }
    if (parseError === null && this.validate) {
      try {
        validationError = this.validate(parsed);
      } catch (err) {
        validationError = err instanceof Error ? err.message : String(err);
      }
      if (validationError === null) {
        this.validateOk += 1;
      } else {
        this.validateErr += 1;
        this.onValidationError?.(raw, validationError, widgetType);
      }
    }
    return {
      raw,
      parsed,
      ok: parseError === null && validationError === null,
      parseError,
      validationError,
    };
  }
}

function firstWidgetType(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const updateComponents = (value as Record<string, unknown>)["updateComponents"];
  if (!updateComponents || typeof updateComponents !== "object" || Array.isArray(updateComponents)) return null;
  const components = (updateComponents as Record<string, unknown>)["components"];
  if (!Array.isArray(components)) return null;
  for (const component of components) {
    if (!component || typeof component !== "object" || Array.isArray(component)) continue;
    const widget = (component as Record<string, unknown>)["component"];
    if (typeof widget === "string" && widget.length > 0) return widget;
  }
  return null;
}

/**
 * Structural validator for A2UI v0.9 server-to-client messages.
 *
  * Accepts a single message object. Returns null when the value matches one
  * of the four v0.9 message variants (createSurface, updateComponents,
  * updateDataModel, deleteSurface) with the minimum required keys. Otherwise
  * returns a short human-readable explanation. Top-level arrays are rejected
  * for upstream A2UI v0.9 interop; emit multiple adjacent `<a2ui-json>`
  * blocks when a turn needs multiple messages.
 *
 * This is intentionally narrow — it covers the structural shape that
 * downstream renderers depend on; deeper component-tree validation
 * lives in the renderer (which already runs the upstream catalog
 * schema).
 */
export function validateA2uiMessage(value: unknown, options: A2uiValidationOptions = {}): string | null {
  if (value === null || value === undefined) return "value is null or undefined";
  if (Array.isArray(value)) return "top-level arrays are not valid A2UI v0.9 message envelopes; emit multiple <a2ui-json> blocks instead";
  if (typeof value !== "object") return `expected object, got ${typeof value}`;
  const obj = value as Record<string, unknown>;
  if (obj["version"] !== "v0.9") return "missing or non-v0.9 version field";
  const keys = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"] as const;
  const present = keys.filter((k) => k in obj);
  if (present.length === 0) {
    return `must include one of: ${keys.join(", ")}`;
  }
  if (present.length > 1) {
    return `must include only one of: ${present.join(", ")}`;
  }
  const variant = present[0]!;
  const inner = obj[variant];
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
    return `${variant} body must be an object`;
  }
  const innerRec = inner as Record<string, unknown>;
  if (typeof innerRec["surfaceId"] !== "string" || innerRec["surfaceId"].length === 0) {
    return `${variant} requires non-empty surfaceId`;
  }
  if (variant === "createSurface") {
    if (typeof innerRec["catalogId"] !== "string" || innerRec["catalogId"].length === 0) {
      return "createSurface requires non-empty catalogId";
    }
    if (options.expectedCatalogId !== undefined && innerRec["catalogId"] !== options.expectedCatalogId) {
      return `createSurface catalogId must match negotiated catalog ${options.expectedCatalogId}`;
    }
    if (innerRec["sendDataModel"] === true) {
      return "createSurface.sendDataModel=true is not supported by this shim profile";
    }
  } else if (variant === "updateComponents") {
    const components = innerRec["components"];
    if (!Array.isArray(components) || components.length === 0) {
      return "updateComponents requires a non-empty components array";
    }
    for (let i = 0; i < components.length; i += 1) {
      const c = components[i];
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        return `updateComponents.components[${i}] must be an object`;
      }
      const rec = c as Record<string, unknown>;
      if (typeof rec["id"] !== "string" || rec["id"].length === 0) {
        return `updateComponents.components[${i}] requires non-empty id`;
      }
      if (typeof rec["component"] !== "string" || rec["component"].length === 0) {
        return `updateComponents.components[${i}] requires non-empty component discriminator`;
      }
    }
  }
  return null;
}
