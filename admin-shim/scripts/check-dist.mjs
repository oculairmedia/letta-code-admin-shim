#!/usr/bin/env node
// Parse-validate every emitted JS file under dist/ using V8's parser
// (`node --check`), WITHOUT executing anything.
//
// Why a whole-tree scan instead of `node --check dist/server.js`:
// `--check` parses a single file and does NOT resolve its imports, so a
// syntax error in a transitively-imported module (exactly the 2026-06-23
// incident: a mangled newline in lib/subagent-registry.ts -> a broken
// dist/lib/subagent-registry.js) would slip past an entrypoint-only check
// and only blow up at runtime, crash-looping the service.
//
// This is the single gate shared by:
//   - CI (`npm run check:dist` after `npm run build`), and
//   - the systemd `ExecStartPre` parse-gate drop-in,
// so "does the deployable artifact parse?" has one answer both agree on.
//
// Usage: node scripts/check-dist.mjs [distDir]
// Exit 0 if every file parses; exit 1 (with the offending files) otherwise.

import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? join(here, "..", "dist");

if (!existsSync(distDir)) {
  console.error(`check-dist: dist directory not found: ${distDir}\nRun \`npm run build\` first.`);
  process.exit(1);
}

/**
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* jsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(p);
    else if (entry.isFile() && (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs"))) yield p;
  }
}

let checked = 0;
/** @type {{ file: string, message: string }[]} */
const failures = [];
for (const file of jsFiles(distDir)) {
  checked++;
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    const e = /** @type {{ stderr?: Buffer, message?: string }} */ (err);
    const message = (e.stderr?.toString() || e.message || "").trim();
    failures.push({ file, message });
  }
}

if (checked === 0) {
  console.error(`check-dist: no JS files found under ${distDir} — did the build run?`);
  process.exit(1);
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`✗ ${f.file}\n${f.message}\n`);
  }
  console.error(`check-dist: ${failures.length}/${checked} file(s) failed to parse`);
  process.exit(1);
}

console.log(`check-dist: ${checked} file(s) parsed OK`);
