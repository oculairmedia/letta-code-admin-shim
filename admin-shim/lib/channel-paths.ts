/**
 * Shared path resolution for the `~/.letta/channels/<id>/` directory tree.
 *
 * Both the generic channel host (lib/channel-registry.ts, lib/channel-config.ts)
 * and the mobile WS host (lib/mobile-channel-host.ts) resolve channel files
 * through this module so the shim and the letta CLI always agree on where
 * `channel.json`, `accounts.json`, and `routing.yaml` live.
 *
 * Resolution matches the bundled letta-code's getLettaDir():
 * `LETTA_HOME || join($HOME, ".letta")` — same recipe as lib/crons.ts, so a
 * test harness that overrides HOME redirects every channel file at once.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function lettaHome(): string {
  return process.env["LETTA_HOME"] || join(process.env["HOME"] || homedir(), ".letta");
}

export function channelsRoot(): string {
  return join(lettaHome(), "channels");
}

export function channelDir(channelId: string): string {
  return join(channelsRoot(), channelId);
}

export function channelAccountsPath(channelId: string): string {
  return join(channelDir(channelId), "accounts.json");
}

/** routing.yaml carries JSON content despite the extension (CLI compat — see channel-config.ts). */
export function channelRoutingPath(channelId: string): string {
  return join(channelDir(channelId), "routing.yaml");
}

export function channelManifestPath(channelId: string): string {
  return join(channelDir(channelId), "channel.json");
}

export function channelLogDir(channelId: string): string {
  return join(channelDir(channelId), "logs");
}
