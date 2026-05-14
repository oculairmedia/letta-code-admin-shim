/**
 * Spawn the admin shim as a subprocess for integration testing.
 *
 * Each test gets its own isolated state directory + random port so they
 * can run in parallel without colliding. The shim is launched with the
 * mock `letta` binary so no real model is needed.
 *
 * Typical use:
 *
 *   import { startShim } from "./helpers/shim.mjs";
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

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_SHIM_ROOT = join(__dirname, "..", "..");
const REPO_ROOT = join(ADMIN_SHIM_ROOT, "..");
const FIXTURES_STATE = join(__dirname, "..", "fixtures", "state");
const MOCK_LETTA = join(__dirname, "letta-mock.mjs");

let _portCursor = 18290 + Math.floor(Math.random() * 1000);
function nextPort() {
  _portCursor += 1;
  return _portCursor;
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
export async function startShim(opts = {}) {
  const port = nextPort();
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

  const env = {
    ...process.env,
    HOME: homeDir,
    LETTA_LOCAL_BACKEND_DIR: stateDir,
    LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
    LETTA_BASE_URL: "http://127.0.0.1:0",
    LMSTUDIO_BASE_URL: "http://127.0.0.1:0",
    LETTA_BIN: MOCK_LETTA,
    SHIM_PORT: String(port),
    SHIM_HOST: "127.0.0.1",
    MOBILE_CHANNEL_TOKEN: mobileToken,
    NODE_PATH: join(ADMIN_SHIM_ROOT, "node_modules"),
    ...opts.env,
  };
  delete env.LETTA_API_KEY;
  delete env.LETTA_API_URL;

  const serverPath = join(ADMIN_SHIM_ROOT, "server.mjs");
  // Run via `node <mock> args...` since LETTA_BIN points at a .mjs file.
  // The agent-pool uses `spawn(LETTA_BIN, args)` — for the mock to actually
  // execute, we need it interpreted by node. Easiest: wrap it.
  const child = spawn("node", [serverPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout.on("data", (b) => { log += b.toString("utf8"); });
  child.stderr.on("data", (b) => { log += b.toString("utf8"); });

  const handle = {
    url: `http://127.0.0.1:${port}`,
    port,
    stateDir,
    homeDir,
    mobileToken,
    pid: child.pid,
    child,
    readLog: () => log,
    waitForLogLine(regex, { timeoutMs = 5000 } = {}) {
      return new Promise((resolve, reject) => {
        if (regex.test(log)) return resolve(true);
        const timer = setTimeout(() => {
          reject(new Error(`timeout waiting for log line ${regex}`));
        }, timeoutMs);
        const checker = (b) => {
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
        await new Promise((r) => {
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

  // Wait for the listen line, then a successful health check.
  await handle.waitForLogLine(/listening on/, { timeoutMs: 5000 });
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      const res = await fetch(`${handle.url}/v1/health/`);
      if (res.ok) return handle;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  await handle.stop();
  throw new Error(`shim did not become healthy within 5s\nlog:\n${log}`);
}
