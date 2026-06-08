import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SKILLS_BLOCK_LABEL,
  buildSkillsBlockContent,
  getInstalledSkillDetail,
  getSkillDetail,
  installSkillToAgent,
  isSkillInstalledForAgent,
  listAvailableSkills,
  listInstalledSkillsForAgent,
  readInstalledSkillDescriptions,
  searchSkills,
  syncSkillsBlockForAgent,
  uninstallSkillFromAgent,
} from "../lib/store.js";

// ──────────────────────────────────────────────────────────────────────
// Isolation: skills tests touch two disjoint roots —
//   - LETTA_SKILLS_DIR    → the user-level global registry (skillsStoreDir)
//   - LETTA_LOCAL_BACKEND_DIR → storageDir(): per-agent installs + memfs
// Both are redirected to fresh temp dirs per test so nothing leaks into
// ~/.letta or the live lc-local-backend.
// ──────────────────────────────────────────────────────────────────────

const AGENT = "agent-skills-test-0000";

let registryRoot: string;
let backendRoot: string;
let prevSkillsDir: string | undefined;
let prevBackendDir: string | undefined;

/**
 * A skill body is a real SKILL.md with YAML frontmatter (name/description/
 * tags) plus a large body. The body is what FIX 1 forbids from per-turn
 * injection; it is deliberately big + uniquely marked so the regression
 * test can assert it never appears in the injected block.
 */
const BODY_SENTINEL = "FULL_BODY_SENTINEL_SHOULD_NEVER_BE_INJECTED";

function writeGlobalSkill(opts: {
  name: string;
  description: string;
  tags?: string[];
  bodyExtra?: string;
}): void {
  const dir = join(registryRoot, opts.name);
  mkdirSync(dir, { recursive: true });
  const tags = opts.tags ?? [];
  const tagsLine = tags.length
    ? `tags: [${tags.map((t) => `"${t}"`).join(", ")}]\n`
    : "tags: []\n";
  const frontmatter =
    `---\n` +
    `name: ${opts.name}\n` +
    `description: ${opts.description}\n` +
    `version: 1.0.0\n` +
    tagsLine +
    `---\n`;
  const body =
    `# ${opts.name}\n\n` +
    `${BODY_SENTINEL}\n\n` +
    `${opts.bodyExtra ?? ""}\n` +
    // pad the body so it is unmistakably "heavy" content
    `${"x".repeat(4096)}\n`;
  writeFileSync(join(dir, "SKILL.md"), frontmatter + body);
}

beforeEach(() => {
  registryRoot = mkdtempSync(join(tmpdir(), "lcp-skills-reg-"));
  backendRoot = mkdtempSync(join(tmpdir(), "lcp-skills-be-"));
  prevSkillsDir = process.env["LETTA_SKILLS_DIR"];
  prevBackendDir = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_SKILLS_DIR"] = registryRoot;
  process.env["LETTA_LOCAL_BACKEND_DIR"] = backendRoot;
});

afterEach(() => {
  if (prevSkillsDir === undefined) delete process.env["LETTA_SKILLS_DIR"];
  else process.env["LETTA_SKILLS_DIR"] = prevSkillsDir;
  if (prevBackendDir === undefined) delete process.env["LETTA_LOCAL_BACKEND_DIR"];
  else process.env["LETTA_LOCAL_BACKEND_DIR"] = prevBackendDir;
  rmSync(registryRoot, { recursive: true, force: true });
  rmSync(backendRoot, { recursive: true, force: true });
});

test("skills: listAvailableSkills returns the global registry catalog", () => {
  writeGlobalSkill({ name: "alpha", description: "Alpha helper", tags: ["search"] });
  writeGlobalSkill({ name: "beta", description: "Beta helper", tags: ["pdf"] });

  const listed = listAvailableSkills();
  const names = listed.map((s) => s.name).sort();
  assert.deepEqual(names, ["alpha", "beta"]);
  const alpha = listed.find((s) => s.name === "alpha");
  assert.ok(alpha);
  assert.equal(alpha.description, "Alpha helper");
  assert.equal(alpha.installed_count, 0, "no agents installed yet");
});

test("skills: getSkillDetail returns the FULL body on demand", () => {
  writeGlobalSkill({ name: "alpha", description: "Alpha helper" });
  const detail = getSkillDetail("alpha");
  assert.ok(detail, "expected detail");
  assert.equal(detail.name, "alpha");
  // The detail endpoint is the on-demand full-body channel.
  assert.match(detail.readme, new RegExp(BODY_SENTINEL));
  assert.ok(detail.files.includes("SKILL.md"));
  assert.equal(getSkillDetail("does-not-exist"), null);
});

test("skills: searchSkills matches by keyword and by tag", () => {
  writeGlobalSkill({ name: "pdf-tools", description: "Work with PDFs", tags: ["pdf", "docs"] });
  writeGlobalSkill({ name: "web-search", description: "Search the web", tags: ["search"] });

  // keyword (name/description)
  const byKeyword = searchSkills("search").map((s) => s.name);
  assert.deepEqual(byKeyword, ["web-search"]);

  // tag filter
  const byTag = searchSkills("", ["pdf"]).map((s) => s.name);
  assert.deepEqual(byTag, ["pdf-tools"]);

  // no match
  assert.deepEqual(searchSkills("nonexistent-xyz"), []);
});

test("skills: install to agent, list installed, then uninstall", () => {
  writeGlobalSkill({ name: "alpha", description: "Alpha helper" });

  assert.equal(isSkillInstalledForAgent(AGENT, "alpha"), false);
  assert.equal(installSkillToAgent(AGENT, "alpha"), true);
  assert.equal(isSkillInstalledForAgent(AGENT, "alpha"), true);

  // installed copy lives under storageDir()/agents/<id>/skills (Fix 3)
  const installedPath = join(backendRoot, "agents", AGENT, "skills", "alpha", "SKILL.md");
  assert.ok(existsSync(installedPath), "installed under lc-local-backend/agents/<id>/skills");

  const installed = listInstalledSkillsForAgent(AGENT);
  assert.deepEqual(installed.map((s) => s.name), ["alpha"]);

  // on-demand full body still reachable for an installed skill
  const detail = getInstalledSkillDetail(AGENT, "alpha");
  assert.ok(detail);
  assert.match(detail.readme, new RegExp(BODY_SENTINEL));

  // listAvailableSkills reflects the install count
  const avail = listAvailableSkills().find((s) => s.name === "alpha");
  assert.ok(avail);
  assert.equal(avail.installed_count, 1);

  assert.equal(uninstallSkillFromAgent(AGENT, "alpha"), true);
  assert.equal(isSkillInstalledForAgent(AGENT, "alpha"), false);
  assert.deepEqual(listInstalledSkillsForAgent(AGENT), []);
});

test("skills: installing the same skill twice is idempotent", () => {
  writeGlobalSkill({ name: "alpha", description: "Alpha helper" });

  assert.equal(installSkillToAgent(AGENT, "alpha"), true);
  // Second install must succeed and not duplicate the entry.
  assert.equal(installSkillToAgent(AGENT, "alpha"), true);

  const installed = listInstalledSkillsForAgent(AGENT);
  assert.equal(installed.length, 1, "no duplicate install entry");
  assert.equal(installed[0]?.name, "alpha");

  // installing a missing source must fail cleanly.
  assert.equal(installSkillToAgent(AGENT, "ghost"), false);
});

// ──────────────────────────────────────────────────────────────────────
// FIX 1 regression guard (lcp-6eef): per-turn injection must contain
// DESCRIPTIONS ONLY — never full SKILL.md bodies.
// ──────────────────────────────────────────────────────────────────────

test("skills: readInstalledSkillDescriptions returns name+description only", () => {
  writeGlobalSkill({
    name: "alpha",
    description: "Alpha helper",
    bodyExtra: "secret body line",
  });
  installSkillToAgent(AGENT, "alpha");

  const descs = readInstalledSkillDescriptions(AGENT);
  assert.deepEqual(descs, [{ name: "alpha", description: "Alpha helper" }]);
  // Defensive: serialized form carries no body content.
  const serialized = JSON.stringify(descs);
  assert.doesNotMatch(serialized, new RegExp(BODY_SENTINEL));
  assert.doesNotMatch(serialized, /secret body line/);
});

test("skills: per-turn injection block is DESCRIPTIONS-ONLY, never full bodies", () => {
  writeGlobalSkill({
    name: "alpha",
    description: "Alpha helper for searching",
    bodyExtra: "ALPHA_BODY_DETAIL_LINE",
  });
  writeGlobalSkill({
    name: "beta",
    description: "Beta helper for PDFs",
    bodyExtra: "BETA_BODY_DETAIL_LINE",
  });
  installSkillToAgent(AGENT, "alpha");
  installSkillToAgent(AGENT, "beta");

  // 1) buildSkillsBlockContent (pure renderer) is descriptions-only.
  const block = buildSkillsBlockContent(readInstalledSkillDescriptions(AGENT));
  assert.ok(block, "expected a non-null block when skills are installed");
  assert.match(block, /## Available Skills/);
  assert.match(block, /alpha: Alpha helper for searching/);
  assert.match(block, /beta: Beta helper for PDFs/);
  // The full SKILL.md body MUST NOT be present.
  assert.doesNotMatch(block, new RegExp(BODY_SENTINEL));
  assert.doesNotMatch(block, /ALPHA_BODY_DETAIL_LINE/);
  assert.doesNotMatch(block, /BETA_BODY_DETAIL_LINE/);
  // The block stays compact (one bounded line per skill, not KB of body).
  assert.ok(block.length < 1024, `block should be compact, was ${block.length} bytes`);

  // 2) syncSkillsBlockForAgent writes that same descriptions-only block into
  //    the agent's SYSTEM CONTEXT (memfs system block), NOT the user message.
  syncSkillsBlockForAgent(AGENT);
  const blockPath = join(
    backendRoot,
    "memfs",
    AGENT,
    "memory",
    "system",
    `${SKILLS_BLOCK_LABEL}.md`,
  );
  assert.ok(existsSync(blockPath), "skills block written to memfs system context");
  const onDisk = readFileSync(blockPath, "utf8");
  assert.match(onDisk, /alpha: Alpha helper for searching/);
  assert.match(onDisk, /beta: Beta helper for PDFs/);
  assert.doesNotMatch(onDisk, new RegExp(BODY_SENTINEL), "no full body in system context");
  assert.doesNotMatch(onDisk, /ALPHA_BODY_DETAIL_LINE/);
  assert.doesNotMatch(onDisk, /BETA_BODY_DETAIL_LINE/);
});

test("skills: syncSkillsBlockForAgent is idempotent and self-cleaning", () => {
  writeGlobalSkill({ name: "alpha", description: "Alpha helper" });
  installSkillToAgent(AGENT, "alpha");

  const blockPath = join(
    backendRoot,
    "memfs",
    AGENT,
    "memory",
    "system",
    `${SKILLS_BLOCK_LABEL}.md`,
  );

  syncSkillsBlockForAgent(AGENT);
  assert.ok(existsSync(blockPath));
  const first = readFileSync(blockPath, "utf8");

  // Re-running with no change produces identical content (write-if-changed).
  syncSkillsBlockForAgent(AGENT);
  assert.equal(readFileSync(blockPath, "utf8"), first);

  // Uninstalling all skills removes the stale block.
  uninstallSkillFromAgent(AGENT, "alpha");
  syncSkillsBlockForAgent(AGENT);
  assert.equal(existsSync(blockPath), false, "stale skills block removed when none installed");

  // No skills installed → buildSkillsBlockContent returns null.
  assert.equal(buildSkillsBlockContent([]), null);
});

test("skills: path-traversal skill names are rejected (no fs escape)", () => {
  // CodeRabbit critical: skillName must not allow ../ or separators into fs joins.
  for (const bad of ["../evil", "..", "a/b", "a\\b", "foo/../../etc", "."]) {
    assert.equal(installSkillToAgent(AGENT, bad), false, `install rejects ${JSON.stringify(bad)}`);
    assert.equal(uninstallSkillFromAgent(AGENT, bad), false, `uninstall rejects ${JSON.stringify(bad)}`);
    assert.equal(getSkillDetail(bad), null, `getSkillDetail rejects ${JSON.stringify(bad)}`);
    assert.equal(isSkillInstalledForAgent(AGENT, bad), false, `isInstalled rejects ${JSON.stringify(bad)}`);
  }
});
