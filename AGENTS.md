<!-- VIBESYNC:project-info:START -->
# Agent Instructions

## Project Identity

- **Project Code**: `letta-code-parallel`
- **Project Name**: letta-code-parallel
- **Letta Agent ID**: ``

## Workflow Instructions

1. **Before starting work**: Use the local Beads tracker (`bd ready`, `bd show <id>`, `bd update <id> --claim`) to find and claim related work.
2. **Issue references**: Use Beads issue IDs exactly as reported by `bd` (for example, `letta-code-parallel-abc` or the repository's configured prefix).
3. **On task completion**: Report to this project's Letta agent via `matrix-identity-bridge` using `talk_to_agent`.
4. **Memory**: Store important discoveries with the configured project memory tool.
<!-- VIBESYNC:project-info:END -->

<!-- VIBESYNC:reporting-hierarchy:START -->
## PM Agent Communication

**Project PM Agent:** `` ()

### Reporting Hierarchy

```
Emmanuel (Stakeholder)
    ↓
Meridian (Director of Engineering)
    ↓
PM Agent (Technical Product Owner - mega-experienced)
    ↓ communicates with
You (Developer Agent - experienced)
```

### MANDATORY: Report to PM Agent

**BEFORE reporting outcomes to the user**, send a report to the PM agent via Matrix:

```json
{
  "operation": "talk_to_agent",
  "agent": "",
  "message": "<your report>",
  "caller_directory": "/opt/stacks/letta-code-parallel"
}
```

### When to Contact PM Agent

| Situation             | Action                                                              |
| --------------------- | ------------------------------------------------------------------- |
| Task completed        | Report outcome to PM before responding to user                      |
| Blocking question     | Forward to PM - they know user's wishes and will escalate if needed |
| Architecture decision | Consult PM for guidance                                             |
| Unclear requirements  | PM can clarify or contact user                                      |

### Report Format

```
**Status**: [Completed/Blocked/In Progress]
**Task**: [Brief description]
**Outcome**: [What was done/What's blocking]
**Files Changed**: [List if applicable]
**Next Steps**: [If any]
```
<!-- VIBESYNC:reporting-hierarchy:END -->

<!-- VIBESYNC:beads-instructions:START -->
## Issue Tracking

This project uses **bd** (Beads) for local issue tracking. Beads is a CLI tool: interact with it only through `bd` commands, not by reading or writing its backing database directly. Run `bd prime` for the current workflow context and command reference.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for task tracking and follow-up work; do not route issue operations through external issue tools.
- Do not access the Beads/Dolt backing database directly. Use the `bd` CLI for all issue reads, updates, claims, closes, syncs, and durable notes.
- Create or update Beads issues before writing code when the work is non-trivial.
- Close completed issues with `bd close <id>` and include a reason when helpful.
- Use `bd remember` for durable project knowledge instead of ad-hoc memory files.

### Preflight (vibesync-1sb, vibesync-v02)

Before claiming work in any Beads-backed project, run the per-project preflight check:

```bash
bun /opt/stacks/vibesync/scripts/preflight/bd-preflight.ts $(pwd)
```

This reports:
- `.beads` directory present + writable
- Deprecated `.beads/dolt_server_port` ABSENT (presence = pre-migration shape; fix before working)
- Current `.beads/dolt-server.port` present + valid port
- `bd` and `dolt` binaries on PATH
- `bd list --json` smoke check succeeds
- `bd dolt status` reports a running server (when backend=dolt)
- A Dolt remote is configured (warning only if absent — local-only is sometimes intentional)

Exit codes: `0` = all clean, `1` = warnings (proceed with care), `2` = errors (fix before working).

**Do NOT** mutate `.beads/dolt/` directly. All writes go through the `bd` CLI; reads can also go directly to the local Dolt MySQL port that `bd init` manages (this is the daemon-hot-path; see VibeSync's `src/orchestration/store/dolt-client.ts` for the pattern).

### Persistence

- Beads state is local-first. If the repository has a remote, persist issue changes with the configured Beads sync command before ending a session.
- If no git remote is configured, leave the Beads database and JSONL export in a clean local state and note that work is local-only.
<!-- VIBESYNC:beads-instructions:END -->

<!-- VIBESYNC:bookstack-docs:START -->
## BookStack Documentation

- **Source of truth**: [BookStack](https://knowledge.oculair.ca)
- **Local sync**: `docs/bookstack/` (read-only mirror, syncs hourly)
- **To read docs**: Check `docs/bookstack/{book-slug}/` in your project directory
- **To create/edit docs**: Use `bookstack-mcp` tools to write directly to BookStack
- **Never edit** files in `docs/bookstack/` locally — they will be overwritten on next sync
- **PRDs and design docs** must be stored in BookStack, not local markdown files
<!-- VIBESYNC:bookstack-docs:END -->

<!-- VIBESYNC:session-completion:START -->
## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is not complete until code changes, Beads state, and handoff notes are in a clean state.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Persist changes** - If a git remote is configured, push code and Beads state:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
   If no remote is configured, verify `git status` and Beads state locally and mention that the session is local-only.
5. **Clean up** - Clear stashes and prune stale branches when applicable
6. **Verify** - All intended changes are committed or explicitly handed off
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Do not leave issue updates half-applied; Beads is the source of truth for task state.
- Use the `bd` CLI only; do not inspect or mutate the Beads/Dolt backing database directly.
- Do not use external issue tools for issue tracking.
- If push is available and fails, resolve and retry until it succeeds.
<!-- VIBESYNC:session-completion:END -->

<!-- VIBESYNC:codebase-context:START -->
## Codebase Context

**Project**: letta-code-parallel (`letta-code-parallel`)
**Path**: `/opt/stacks/letta-code-parallel`

This project's PM agent has a `codebase_ast` memory block with live structural data including:

- File counts and function counts per directory
- Key modules and their roles
- Quality signals (doc gaps, untested modules, complexity hotspots)
- Recent file changes

Ask the PM agent for architectural guidance before making significant changes.
<!-- VIBESYNC:codebase-context:END -->

<!-- VIBESYNC:custom-rules:START -->
## Project-Specific Rules

No custom rules configured. Add project-specific agent instructions here, then change the marker above to `<!-- VIBESYNC:custom-rules:CUSTOM -->` to prevent overwriting.
<!-- VIBESYNC:custom-rules:END -->

# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
