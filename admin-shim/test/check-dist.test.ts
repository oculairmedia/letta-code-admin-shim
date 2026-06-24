/**
 * Tests for the dist parse-gate (scripts/check-dist.mjs).
 *
 * This gate is the structural defense against the 2026-06-23 crash-loop:
 * a syntax error in an emitted dist module (not the entrypoint) that
 * `node --check dist/server.js` would NOT catch, because --check does not
 * resolve imports. The gate scans EVERY emitted file, so a broken module
 * anywhere in the tree fails the build/boot loudly instead of crash-looping.
 *
 * The same script backs CI (`npm run check:dist`) and the systemd
 * ExecStartPre parse-gate, so both agree on "does the artifact parse?".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-dist.mjs");

/**
 * Make a temp dist dir that resolves as ESM, exactly like the real
 * admin-shim/dist (whose nearest package.json is "type": "module").
 * This matters: `node --check` picks CJS vs ESM from the nearest
 * package.json, and the parsers differ. The 2026-06-23 incident file was
 * ESM, so the test must exercise the ESM path — a CJS temp dir would pass
 * for the wrong reason and give false confidence.
 */
function makeEsmDistDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  return dir;
}

/** Run check-dist against a dir; return { code, stdout, stderr }. */
function runGate(distDir: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, distDir], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

test("check-dist: passes when every emitted file parses (ESM context)", () => {
  const dir = makeEsmDistDir("check-dist-ok-");
  try {
    writeFileSync(join(dir, "server.js"), "import './lib/util.js';\nexport const ok = 1;\n");
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "util.js"), "export function f(x) { return x.split('\\n'); }\n");
    const r = runGate(dir);
    assert.equal(r.code, 0, `expected pass, got code ${r.code}: ${r.stderr}`);
    assert.match(r.stdout, /2 file\(s\) parsed OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-dist: fails on a syntax error in a NON-entrypoint ESM module (the incident class)", () => {
  // Mirrors the 2026-06-23 incident precisely: an ESM dependency module
  // (with import/export, so node parses it as ESM) carrying a stray `);`.
  // The entrypoint is fine and merely imports it — exactly what
  // `node --check server.js` alone would wave through. The ESM context is
  // essential: a CJS file would be caught by a different parser path and
  // pass the test for the wrong reason.
  const dir = makeEsmDistDir("check-dist-bad-");
  try {
    writeFileSync(join(dir, "server.js"), "import './lib/registry.js';\n");
    mkdirSync(join(dir, "lib"));
    writeFileSync(
      join(dir, "lib", "registry.js"),
      'export function read(text) {\n  const lines = text.split(", "););\n  return lines;\n}\n',
    );
    const r = runGate(dir);
    assert.equal(r.code, 1, "expected non-zero exit for a broken ESM module");
    assert.match(r.stderr, /registry\.js/);
    assert.match(r.stderr, /Unexpected token/);
    assert.match(r.stderr, /1\/2 file\(s\) failed to parse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-dist: fails when the dist directory is missing", () => {
  const r = runGate(join(tmpdir(), "check-dist-does-not-exist-zzz"));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /dist directory not found/);
});

test("check-dist: fails when the dist directory has no JS files", () => {
  const dir = makeEsmDistDir("check-dist-empty-");
  try {
    writeFileSync(join(dir, "README.md"), "# not js\n");
    const r = runGate(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no JS files found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
