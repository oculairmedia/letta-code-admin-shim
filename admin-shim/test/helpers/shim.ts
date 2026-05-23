/**
 * Spawn the admin shim as a subprocess for integration testing.
 *
 * Each test gets its own isolated state directory + random port so they
 * can run in parallel without colliding. The shim is launched with the
 * mock `letta` binary so no real model is needed.
 *
 * Typical use:
 *
 *   import { startShim } from "./helpers/shim.js";
 *
 *   test("agents list returns the seeded agent", async (t) => {
 *     const shim = await startShim({ fixture: "single-agent" });
 *     t.after(() => shim.stop());
 *     const res = await fetch(`${shim.url}/v1/agents`);
 *     ...
 *   });
 *
 * `fixture` selects a directory under admin-shim/test/fixtures/state/ to
 * copy into the shim's LETTA_LOCAL_BACKEND_DIR before launch.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { cpSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_SHIM_ROOT = join(__dirname, "..", "..");
const REPO_ROOT = join(ADMIN_SHIM_ROOT, "..");
const FIXTURES_STATE = join(__dirname, "..", "fixtures", "state");
const MOCK_LETTA = join(__dirname, "letta-mock.mjs");
// lcp-sdk.6: SDK path resolves the CLI via LETTA_CLI_PATH, not LETTA_BIN.
// Exposed so integration tests can pin the SDK at the same mock binary
// the direct path already uses.
export const MOCK_LETTA_PATH = MOCK_LETTA;

// Use OS-assigned ports (SHIM_PORT=0). The shim logs the actual port after
// bind; the helper parses it from the log line. This avoids the port-cursor
// collisions we hit when many tests across multiple test files were picking
// from a small random range — under load some shims would lose the race and
// fail to start with EADDRINUSE.

export interface ShimOpts {
  /** Name of a directory under test/fixtures/state/ to copy into the shim's backend dir. */
  fixture?: string | undefined;
  /** Extra env vars to inject (overrides defaults). */
  env?: Record<string, string | undefined> | undefined;
  /** Sets MOBILE_CHANNEL_TOKEN (default "test-token-do-not-use-in-prod"). */
  mobileToken?: string | undefined;
  /** If false, return as soon as we have a port (default true). */
  waitForReady?: boolean | undefined;
}

export interface WaitForLogLineOpts {
  timeoutMs?: number;
}

export interface ShimHandle {
  url: string | null;
  port: number | null;
  stateDir: string;
  homeDir: string;
  mobileToken: string;
  pid: number | undefined;
  child: ChildProcessByStdio<null, Readable, Readable>;
  readLog(): string;
  waitForLogLine(regex: RegExp, opts?: WaitForLogLineOpts): Promise<true>;
  stop(): Promise<void>;
}

/**
 * Start the shim. Returns a handle with:
 *   url             — base URL (e.g. http://127.0.0.1:18293)
 *   port            — number
 *   stateDir        — the temp state dir (for seeding extra files)
 *   homeDir         — the temp HOME (where channels/* lives)
 *   stop()          — kill the subprocess, remove temp dirs
 *   readLog()       — stdout+stderr captured so far
 *   waitForLogLine(regex, {timeoutMs})  — promise resolving when matched
 *
 * Options:
 *   fixture       — name of a directory under test/fixtures/state/ to copy
 *                   into the shim's backend dir. If omitted, starts empty.
 *   env           — extra env vars to inject (overrides defaults)
 *   mobileToken   — sets MOBILE_CHANNEL_TOKEN (default "test-token")
 *   waitForReady  — if false, return as soon as we have a port (default true)
 */
export async function startShim(opts: ShimOpts = {}): Promise<ShimHandle> {
  const tmp = mkdtempSync(join(tmpdir(), "shim-test-"));
  const stateDir = join(tmp, "state");
  const homeDir = join(tmp, "home");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  // Seed state if a fixture was requested.
  if (opts.fixture) {
    const src = join(FIXTURES_STATE, opts.fixture);
    if (!existsSync(src)) {
      throw new Error(`test fixture not found: ${src}`);
    }
    cpSync(src, stateDir, { recursive: true });
  }

  // Always seed a mobile channel plugin so /shim/v1/mobile is mountable.
  // We point at the project's plugin source rather than copying — channel
  // plugins are read-only at runtime, so sharing is safe across tests.
  const channelsSrc = join(REPO_ROOT, "home", ".letta", "channels");
  const channelsDst = join(homeDir, ".letta", "channels");
  mkdirSync(dirname(channelsDst), { recursive: true });
  cpSync(channelsSrc, channelsDst, { recursive: true });

  // Copy accounts.example.json → accounts.json with the test token baked in.
  const mobileToken = opts.mobileToken ?? "test-token-do-not-use-in-prod";
  const mobileAccountsPath = join(channelsDst, "mobile", "accounts.json");
  const mobileAccounts = {
    accounts: [{
      channel: "mobile",
      accountId: "default",
      displayName: "Test Mobile",
      enabled: true,
      dmPolicy: "open",
      allowedUsers: [],
      config: {
        tokenEnv: "MOBILE_CHANNEL_TOKEN",
        tokenFallback: mobileToken,
        pingIntervalMs: 25000,
        idleTimeoutMs: 120000,
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    }],
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(mobileAccountsPath, JSON.stringify(mobileAccounts, null, 2));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    LETTA_LOCAL_BACKEND_DIR: stateDir,
    LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
    LETTA_BASE_URL: "http://127.0.0.1:0",
    LMSTUDIO_BASE_URL: "http://127.0.0.1:0",
    // lcp-sdk.10: the SDK transport reads LETTA_CLI_PATH (not LETTA_BIN). Set
    // both so tests work transparently regardless of which the production
    // code path is using.
    LETTA_BIN: MOCK_LETTA,
    LETTA_CLI_PATH: MOCK_LETTA,
    SHIM_PORT: "0",
    SHIM_HOST: "127.0.0.1",
    MOBILE_CHANNEL_TOKEN: mobileToken,
    NODE_PATH: join(ADMIN_SHIM_ROOT, "node_modules"),
    ...opts.env,
  };
  delete env["LETTA_API_KEY"];
  delete env["LETTA_API_URL"];

  const serverPath = join(ADMIN_SHIM_ROOT, "server.ts");
  // Run via `node <mock> args...` since LETTA_BIN points at a .mjs file.
  // The agent-pool uses `spawn(LETTA_BIN, args)` — for the mock to actually
  // execute, we need it interpreted by node. Easiest: wrap it.
  const child = spawn("node", ["--import", "tsx/esm", serverPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessByStdio<null, Readable, Readable>;

  let log = "";
  child.stdout.on("data", (b: Buffer) => { log += b.toString("utf8"); });
  child.stderr.on("data", (b: Buffer) => { log += b.toString("utf8"); });

  // Port is OS-assigned at bind time; we parse it from the "listening on"
  // log line once the shim is ready (see below). Url/port are populated
  // before startShim() resolves.
  const handle: ShimHandle = {
    url: null,
    port: null,
    stateDir,
    homeDir,
    mobileToken,
    pid: child.pid,
    child,
    readLog: () => log,
    waitForLogLine(regex, { timeoutMs = 5000 } = {}) {
      return new Promise<true>((resolve, reject) => {
        if (regex.test(log)) return resolve(true);
        const timer = setTimeout(() => {
          reject(new Error(`timeout waiting for log line ${regex}`));
        }, timeoutMs);
        const checker = (_b: Buffer) => {
          if (regex.test(log)) {
            clearTimeout(timer);
            child.stdout.off("data", checker);
            child.stderr.off("data", checker);
            resolve(true);
          }
        };
        child.stdout.on("data", checker);
        child.stderr.on("data", checker);
      });
    },
    async stop() {
      if (!child.killed) {
        child.kill("SIGTERM");
        await new Promise<void>((r) => {
          const onExit = () => r();
          child.once("exit", onExit);
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
            r();
          }, 2000).unref();
        });
      }
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    },
  };

  if (opts.waitForReady === false) return handle;

  // Wait for the listen line and parse the actual OS-assigned port from it.
  // Generous timeout because the suite spawns many shims back-to-back; an
  // event-loop hiccup while a prior shim is still tearing down can delay
  // startup well past a tight 5s budget.
  const READY_TIMEOUT_MS = Number(process.env["SHIM_TEST_READY_TIMEOUT_MS"] ?? 15000);
  await handle.waitForLogLine(/listening on/, { timeoutMs: READY_TIMEOUT_MS });
  const portMatch = log.match(/listening on http:\/\/[^:]+:(\d+)/);
  if (!portMatch) {
    await handle.stop();
    throw new Error(`could not parse port from log: ${log.slice(0, 500)}`);
  }
  handle.port = Number(portMatch[1]);
  handle.url = `http://127.0.0.1:${handle.port}`;
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try {
      const res = await fetch(`${handle.url}/v1/health/`);
      if (res.ok) return handle;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  await handle.stop();
  throw new Error(`shim did not become healthy within 5s\nlog:\n${log}`);
}
