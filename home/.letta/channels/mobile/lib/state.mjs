/**
 * Phase 1 device state — file-backed, one JSON file per device.
 *
 * Schema:
 *   state/devices/<device_id>.json
 *     {
 *       device_id: string,
 *       first_seen_at: ISO date,
 *       last_seen_at: ISO date,
 *       client_version: string,
 *       token_hash: string  // SHA-256 of the accepted token, for audit
 *     }
 *
 * Phase 2 will add cursor, pairings, push-registration files alongside.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function stateRoot() {
  const root = process.env.LETTA_HOME || join(homedir(), ".letta");
  return join(root, "channels", "mobile", "state");
}

function devicePath(deviceId) {
  return join(stateRoot(), "devices", `${deviceId}.json`);
}

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

export function readDevice(deviceId) {
  const path = devicePath(deviceId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function recordDeviceConnect({ deviceId, token, clientVersion }) {
  const existing = readDevice(deviceId);
  const now = new Date().toISOString();
  const record = {
    device_id: deviceId,
    first_seen_at: existing?.first_seen_at ?? now,
    last_seen_at: now,
    client_version: clientVersion ?? existing?.client_version ?? null,
    token_hash: hashToken(token),
  };
  const path = devicePath(deviceId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return record;
}
