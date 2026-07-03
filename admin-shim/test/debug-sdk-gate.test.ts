/**
 * lcp xwi3z (§2c): the per-frame SDK_MSG probe in letta-sdk-adapter.ts is
 * gated behind a REAL module-level DEBUG_SDK const (previously the comment
 * claimed a gate that did not exist and production logged every stream
 * event unconditionally).
 *
 * DEBUG_SDK is read at module load, so each polarity runs in a child
 * process: stream a fake stream_event through sdkMessageToLettaFrame and
 * capture stdout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const adapterUrl = pathToFileURL(join(repoRoot, "lib", "letta-sdk-adapter.ts")).href;

function runProbe(debugSdk: string | undefined): { stdout: string; stderr: string; status: number | null } {
  const backendDir = mkdtempSync(join(tmpdir(), "debug-sdk-gate-"));
  const script = [
    `const { _internals } = await import(${JSON.stringify(adapterUrl)});`,
    `_internals.sdkMessageToLettaFrame(`,
    `  { type: "stream_event", event: { message_type: "assistant_message" }, uuid: "u1" },`,
    `  "sess", "agent", "conv",`,
    `);`,
  ].join("\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LETTA_LOCAL_BACKEND_DIR: backendDir,
  };
  delete env["DEBUG_SDK"];
  if (debugSdk !== undefined) env["DEBUG_SDK"] = debugSdk;
  try {
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", script],
      { cwd: repoRoot, env, encoding: "utf8", timeout: 60_000 },
    );
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
  } finally {
    rmSync(backendDir, { recursive: true, force: true });
  }
}

test("DEBUG_SDK unset → no SDK_MSG probe output for a streamed frame", () => {
  const res = runProbe(undefined);
  assert.equal(res.status, 0, `probe process failed: ${res.stderr}`);
  assert.ok(!res.stdout.includes("SDK_MSG"), `expected no SDK_MSG lines, got:\n${res.stdout}`);
});

test("DEBUG_SDK=1 → SDK_MSG probe fires with frame type + inner message_type", () => {
  const res = runProbe("1");
  assert.equal(res.status, 0, `probe process failed: ${res.stderr}`);
  assert.ok(
    res.stdout.includes("SDK_MSG type=stream_event inner=assistant_message"),
    `expected SDK_MSG probe line, got:\n${res.stdout}`,
  );
});

test("DEBUG_SDK=true is also honored", () => {
  const res = runProbe("true");
  assert.equal(res.status, 0, `probe process failed: ${res.stderr}`);
  assert.ok(res.stdout.includes("SDK_MSG type=stream_event"), `expected SDK_MSG probe line, got:\n${res.stdout}`);
});
