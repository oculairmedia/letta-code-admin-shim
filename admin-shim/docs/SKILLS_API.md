# Skills API (app-facing contract)

The shim exposes a **skills** system: a global registry of reusable agent
capabilities plus per-agent installation. This document is the contract the
app/mobile/web client codes against.

## Configuration — where the global registry lives

The global skills directory is resolved in this order:

1. **`LETTA_SKILLS_DIR`** — explicit absolute path to the skills root. Set this
   when your skills live outside the default (e.g. `/opt/letta/skills`,
   `/srv/skills`, a shared volume, etc.). Highest priority.
2. **`LETTA_HOME`** → `<LETTA_HOME>/skills` — if you relocate the whole Letta
   home, skills follow.
3. **`~/.letta/skills`** — final fallback (`HOME` of the shim process).

`GET /v1/skills` returns the resolved path in `skills_dir` so you can confirm
which directory is active without shelling into the host. Per-agent installs
always live under `<storageDir>/agents/<agentId>/skills/` regardless of this
setting.

## Concepts

- **Global registry** — the shared catalog of available skills, stored on the
  shim host under the resolved skills directory (default `~/.letta/skills`,
  overridable via `LETTA_SKILLS_DIR` — see Configuration above).
  Catalog entries are keyed by `name`.
- **Per-agent install** — a skill *copied* into an agent's state under
  `<storageDir>/agents/<agentId>/skills/<name>/`. Installs are **independent
  snapshots**: deleting a skill from the registry does NOT remove it from
  agents that already installed it.
- **Progressive-disclosure injection (automatic)** — every turn, the shim
  writes a compact `name: description` index of the agent's installed skills
  into the agent's **system context** (a memfs system block). The client does
  **not** need to inject anything into chat payloads. Full skill bodies are
  fetched on demand via the detail endpoints below.

## Data shapes

```ts
// Catalog listing item (GET /v1/skills, search, agent list)
interface SkillListingItem {
  name: string;
  version: string;
  description: string;
  tags: string[];
  author: string;
  installed_count: number; // GLOBAL count across all agents (not per-agent)
}

// Full detail (GET /v1/skills/{name}, agent skill detail, publish response)
interface SkillDetail {
  name: string;
  version: string;
  description: string;
  tags: string[];
  author: string;
  readme: string;       // full SKILL.md body — the on-demand "heavy" content
  files: string[];      // files in the skill dir (always includes "SKILL.md")
  dependencies: string[];
}
```

> ⚠️ `installed_count` is a **global** figure. To know whether *the current
> agent* has a skill installed, diff `GET /v1/skills` against
> `GET /v1/agents/{agentId}/skills` — do not use `installed_count`.

## Endpoints

### Discovery (global registry)

#### `GET /v1/skills`
List the full catalog.

```
200 → { "skills": SkillListingItem[] }
```

#### `POST /v1/skills`
Search the catalog by keyword and/or tags. (POST is used because it carries a
JSON body; this is NOT a create — see PUT below for create.)

```jsonc
// request body (all optional)
{ "query": "pdf", "tags": ["docs"] }
```
- `query` matches case-insensitively against `name` and `description`.
- `tags` filters to skills having **any** of the given tags.
- Empty body → returns the full catalog.

```
200 → { "skills": SkillListingItem[] }
```

#### `GET /v1/skills/{name}`
Full detail incl. the `readme` body (use for a "view details before install"
screen).

```
200 → SkillDetail
404 → { "detail": "skill {name} not found" }
```

#### `GET /v1/slash-commands`
Return compact slash-command descriptors for the global skill catalog. This is
for command pickers only; it does not include full SKILL.md bodies.

```
200 → { "commands": [{ "command": "/pdf", "skill_name": "pdf", ... }] }
```

### Publish / remove (global registry write) — NEW

#### `PUT /v1/skills/{name}`
Create-or-replace a skill in the global registry. **Idempotent.**

Two body shapes are accepted:

```jsonc
// (a) full SKILL.md — written verbatim (primary path)
{ "readme": "---\nname: my-skill\ndescription: ...\n---\n\n# my-skill\n..." }

// (b) structured metadata — a minimal SKILL.md is synthesized
{ "description": "What it does", "version": "1.0.0",
  "tags": ["search"], "author": "alice" }
```

- Body MUST include a non-empty `readme` **or** a non-empty `description`.
- `{name}` must match `^[A-Za-z0-9._-]+$` (no `/`, `\`, `..`).
- Write is atomic (staging dir + rename); a failed write leaves no partial entry.

```
201 → SkillDetail   // created (skill did not previously exist)
200 → SkillDetail   // overwrote an existing skill
400 → { "detail": "invalid skill name" }
400 → { "detail": "skill must include a non-empty `readme` or `description`" }
500 → { "detail": "failed to write skill" }
```

#### `DELETE /v1/skills/{name}`
Remove a skill from the global registry. **Per-agent installed copies are left
intact.**

```
200 → { "name": "{name}", "deleted": true }
404 → { "detail": "skill {name} not found" }
```

### Per-agent management

#### `GET /v1/agents/{agentId}/skills`
List skills installed for an agent.

```
200 → { "skills": SkillListingItem[] }
404 → { "detail": "agent {agentId} not found" }
```

#### `GET /v1/agents/{agentId}/skills/{name}`
Installed skill detail (full `readme` body — the on-demand body channel for an
installed skill).

```
200 → SkillDetail
404 → agent or skill not found
```

#### `POST /v1/agents/{agentId}/skills`
Install a registry skill to the agent. **Idempotent** (re-install overwrites).

```jsonc
{ "name": "skill-name" }
```
```
201 → SkillDetail
400 → { "detail": "skill name is required" } | { "detail": "invalid skill name" }
404 → { "detail": "skill {name} not found in global store" }
```

#### `DELETE /v1/agents/{agentId}/skills/{name}`
Uninstall a skill from the agent.

```
200 → { "name": "{name}", "uninstalled": true }
404 → not installed for this agent
```

#### `GET /v1/agents/{agentId}/slash-commands`
Return compact slash-command descriptors for the agent's installed skills only.
Clients can render these as `/skill-name` suggestions while still fetching full
instructions on demand through the installed-skill detail endpoint.

```
200 → { "commands": SlashCommand[] }
404 → { "detail": "agent {agentId} not found" }
```

## Client UX guidance

1. **Skills screen** — `GET /v1/skills` for the catalog; search box → `POST
   /v1/skills`. Show `installed_count` as social proof only.
2. **Per-agent install toggle** — compute installed state by diffing the
   catalog against `GET /v1/agents/{id}/skills`. Install = `POST
   .../skills {name}`; uninstall = `DELETE .../skills/{name}`.
3. **Detail view** — `GET /v1/skills/{name}` to render the README before install.
4. **Authoring/publishing** (if exposed to users) — `PUT /v1/skills/{name}`
   with a full `readme` (a SKILL.md the user wrote) or structured metadata.
   Removing a catalog entry → `DELETE /v1/skills/{name}`.
5. **No chat-payload work** — installed-skill awareness is injected into agent
   context automatically each turn. The client never adds skill text to messages.

## Notes / caveats

- The registry has no auth/ownership model of its own beyond whatever the shim
  already enforces on its HTTP surface. `PUT`/`DELETE` are unrestricted at the
  shim layer — gate them in the app if end users shouldn't mutate the catalog.
- Publishing does not validate SKILL.md *content* beyond requiring the file be
  writable; malformed frontmatter simply yields a skill with empty/derived
  metadata (same lenient parsing as the rest of the catalog).
- `version`/`author` default to `1.0.0` / `community` when omitted in the
  metadata-publish path.
