# A2UI shim decision log — Phase 0

**Status:** accepted for the `lcp-uo5` A2UI shim epic.  
**Scope:** server-side A2UI emission through the admin shim; renderer work lives in the mobile rig.

## Decisions

### Target A2UI version

Target **A2UI v0.9 draft** for the initial shim integration.

Although A2UI v0.8 is the stable production spec, v0.9 is the version that matches the shim architecture we validated: prompt-first model guidance, inline `<a2ui-json>` blocks, a unified Basic Catalog, and direct schema validation after generation. The May 16 demo used the v0.9 grammar pack with the Basic Catalog and produced valid outputs for all tested surfaces.

The risk is that v0.9 can still change before its planned stable release. We accept that risk for the vertical slice because v0.8 is optimized around structured-output/function-call workflows, while this shim needs the model to emit UI messages interleaved with normal streamed text.

### SDK strategy

Use the upstream Python SDK package, **`a2ui-agent-sdk`**, pinned to a known version in whichever runtime owns the adapter.

Do **not** vendor the SDK into this repository for Phase 1. Keeping it as a dependency lets us pick up upstream schema and validator fixes deliberately, while pinning protects the shim from draft-spec churn. If the SDK’s public API changes too quickly during v0.9 draft development, revisit vendoring only the minimal schema/prompt assets in a later hardening bead.

### Adapter module location

Place the A2UI adapter beside the shim core as:

```text
admin-shim/lib/a2ui-adapter.ts
```

The original planning note suggested `/opt/stacks/letta/llmux_shim/a2ui_adapter.py`, but this repository’s shim is TypeScript-first (`admin-shim/server.ts`, `admin-shim/lib/**/*.ts`). Keeping the adapter in `admin-shim/lib/` preserves the current source layout and keeps capability negotiation, prompt augmentation, stream splitting, validation, and WS frame emission close to the existing transport code.

If we later need to call the Python SDK directly from the TypeScript shim, use a narrow process boundary or generated static assets rather than moving the shim implementation into Python.

### Catalog strategy

Start with the standard **A2UI v0.9 Basic Catalog** only.

The Basic Catalog is enough for the first vertical slice, including the ToolApprovalCard-style interaction we need to prove. Custom Letta-specific widgets should be designed in a separate epic after the transport, validation, and user-action loop are working end to end. This keeps the first integration aligned with upstream examples and validators.

### Capability negotiation

A2UI must be opt-in per client/session. Non-A2UI clients must keep receiving plain text/tool frames with no behavior change.

The Phase 1 handshake should let the client declare at least:

- `a2ui_version`
- `supported_catalogs`
- `supported_widgets`
- optional `theme_hints`

Only after that capability is negotiated should the shim inject the A2UI grammar block into the upstream system prompt.

## v0.8 stable vs v0.9 draft notes

A2UI v0.8 is the stable/public-preview line and is better suited to structured output or function-calling integrations. A2UI v0.9 is draft, but it makes a deliberate shift to prompt-first generation: the catalog and schema are embedded in the model’s instructions, then generated messages are validated afterward.

Important v0.9 changes that affect the shim design:

- `beginRendering` / `surfaceUpdate` become `createSurface` / `updateComponents`.
- Components move from key-wrapper objects, such as `{ "Text": { ... } }`, to a discriminator property, such as `{ "component": "Text" }`.
- Data model updates and button contexts use normal JSON objects instead of arrays of key/value records.
- Data binding is simplified around `path` and native JSON values.
- Button `primary: true` is replaced by a `variant` enum.
- Component and function definitions move into a unified catalog (`basic_catalog.json`).
- Validation feedback is an explicit part of the prompt-generate-validate loop.
- Client-to-server data synchronization is explicit via `sendDataModel`.

These changes support the shim’s desired streaming behavior: conversational text can continue as text deltas, while complete A2UI messages can be extracted, validated, and forwarded as structured frames.

## License compatibility

A2UI is Apache 2.0 licensed. This repository is MIT licensed. Apache 2.0 dependencies are compatible with MIT-licensed projects as long as their license and notice obligations are preserved when redistributing the dependency or derived assets.

For Phase 1, depending on the upstream package is the cleanest path: keep the package license intact in dependency metadata rather than copying source into this repository.

## References

- A2UI docs: https://a2ui.org
- A2UI repository: https://github.com/google/A2UI
- v0.8 spec: https://a2ui.org/specification/v0.8-a2ui/
- v0.9 spec: https://a2ui.org/specification/v0.9-a2ui/
- v0.9 evolution guide: https://a2ui.org/specification/v0.9-evolution-guide/
- A2UI roadmap: https://a2ui.org/roadmap
- Python SDK package: https://pypi.org/project/a2ui-agent-sdk/
