# admin-shim — Agent Instructions

Conventions for Claude / coding-agent sessions working inside `admin-shim/`.
Repo-wide rules (beads, non-interactive shell flags) live in
`../AGENTS.md`; this file is the TypeScript-shim addendum.

## Source layout

- **Source is TypeScript.** `server.ts` is the entry point; the rest of the
  shim lives in `lib/**/*.ts`.
- **Channel plugins stay `.mjs` by design.** They live under
  `../home/.letta/channels/<id>/plugin.mjs` and are loaded at runtime as ES
  modules. Plugin authors can opt into type hints via the generated
  `dist/lib/types/channel-plugin.d.ts` — see `docs/CHANNEL_PLUGINS.md`. Do
  not rewrite plugins into `.ts` files; the contract is module-level and
  duck-typed at load.
- **Tests are TypeScript.** `test/*.test.ts` plus `test/helpers/*.ts`. They
  run through the `tsx/esm` Node loader; no precompile required.

## Scripts

From `admin-shim/`:

```
npm run dev          # tsx watch server.ts — iterative development
npm test             # node --import tsx/esm --test test/*.test.ts
npm run typecheck    # tsc --noEmit
npm run build        # tsc -p tsconfig.build.json → dist/
npm start            # node dist/server.js — production / compiled run
```

Production runs the compiled `dist/server.js`. Iterative dev uses `tsx watch`
so you do not have to rebuild on every edit.

## Strictness

See `tsconfig.json` for the full set of compiler flags. Treat it as the
source of truth — don't restate the flag list here, just read the file.

### Hard rules

1. **No `any`.** If you need an escape hatch, type it as `unknown` and narrow
   with a type guard at the boundary.
2. **No `@ts-ignore` / `@ts-expect-error`.** If the checker complains, fix
   the underlying type instead of suppressing.
3. **`unknown` + guards at every IO / JSON / subprocess boundary.** Anything
   that crosses the FS, network, or `JSON.parse` enters as `unknown` until a
   guard has validated it.
4. **Prefer narrow types over broad ones.** Discriminated unions for wire
   frames, literal types for status enums, `Readonly<...>` where applicable.
5. **Don't touch channel-plugin `.mjs` files when fixing shim types.** If a
   plugin needs richer types, update `lib/types/channel-plugin.d.ts` and let
   the plugin opt in via a triple-slash reference.

## When in doubt

- Plugin authoring: `docs/CHANNEL_PLUGINS.md`.
- Intentional wire-shape differences from vanilla Letta: `docs/DIVERGENCE.md`.
- Test harness: `test/README.md`.

## Regression testing policy

Every feature, fix, or behavior change must add or update a regression test
that would fail if that behavior regressed later. PRs without test coverage for
new or changed behavior should be rejected in review. Keep the test near the
contract it protects; for example, Read-image tool-return attachment is pinned
in `test/streaming.test.ts` so future stream or tool-return refactors cannot
silently drop the mobile image payload again.
