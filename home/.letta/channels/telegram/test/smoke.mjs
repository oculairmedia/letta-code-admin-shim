/**
 * Standalone smoke test for the Telegram channel plugin.
 *
 * Exercises the adapter without bringing up letta-code itself:
 *   - imports the plugin and creates the adapter
 *   - sends a plain text message
 *   - sends a markdown message (auto-converted to MarkdownV2)
 *   - tails getUpdates long enough for someone to post and verify inbound
 *
 *   LETTA_HOME=~/.letta node ~/.letta/channels/telegram/test/smoke.mjs <chatId> [waitSeconds]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const channelDir = resolve(here, "..");

const account = JSON.parse(readFileSync(resolve(channelDir, "accounts.json"), "utf8"))
  .accounts.find((a) => a.channel === "telegram");
if (!account) {
  console.error("No telegram account in accounts.json");
  process.exit(2);
}

const [, , chatId, waitSecondsArg] = process.argv;
if (!chatId) {
  console.error("usage: smoke.mjs <chatId> [waitSeconds]");
  process.exit(2);
}
const waitSeconds = Number(waitSecondsArg ?? 20);

const { channelPlugin } = await import(new URL("../plugin.mjs", import.meta.url).href);
const adapter = await channelPlugin.createAdapter(account, { log: (m) => console.log(`[host] ${m}`) });

adapter.onMessage = async (msg) => {
  console.log(
    `[inbound] ${msg.senderName} (${msg.senderId}) in ${msg.chatId}` +
      (msg.threadId ? ` topic ${msg.threadId}` : "") +
      `: ${JSON.stringify(msg.text).slice(0, 200)}`,
  );
};

console.log(`Starting adapter ${adapter.id}…`);
await adapter.start();

const plain = await adapter.sendMessage({ chatId, text: `[smoke] plain text at ${new Date().toISOString()}` });
console.log(`✓ plain sent: ${plain.messageId}`);

const md = await adapter.sendMessage({
  chatId,
  markdown: true,
  text: "*Markdown smoke* — **bold**, `inline code`, a [link](https://letta.com), and 1 + 1 = 2.",
});
console.log(`✓ markdown→MarkdownV2 sent: ${md.messageId}`);

console.log(`Tailing getUpdates for ${waitSeconds}s — post a message to ${chatId}…`);
await new Promise((r) => setTimeout(r, waitSeconds * 1000));

await adapter.stop();
console.log("Done.");
process.exit(0);
