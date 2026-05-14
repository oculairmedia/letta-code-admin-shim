/**
 * Standalone smoke test for the Matrix channel plugin (v2).
 *
 * Exercises the v2 adapter without bringing up letta-code itself:
 *   - imports the plugin and creates the adapter
 *   - sends a plain text message
 *   - sends a markdown message (auto-converted to HTML formatted_body)
 *   - sends a threaded reply
 *   - reacts to the just-sent message with an emoji
 *   - edits one of the sent messages
 *   - tails /sync long enough for someone to post and verify inbound parsing
 *
 *   node ~/.letta/channels/matrix/test/smoke.mjs <roomId> [waitSeconds]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const channelDir = resolve(here, "..");

const accountsPath = resolve(channelDir, "accounts.json");
const accountsRaw = JSON.parse(readFileSync(accountsPath, "utf8"));
const account = accountsRaw.accounts.find((a) => a.channel === "matrix");
if (!account) {
  console.error("No matrix account in accounts.json");
  process.exit(2);
}

const [, , roomId, waitSecondsArg] = process.argv;
if (!roomId) {
  console.error("usage: smoke.mjs <roomId> [waitSeconds]");
  process.exit(2);
}
const waitSeconds = Number(waitSecondsArg ?? 20);

const pluginUrl = new URL("../plugin.mjs", import.meta.url);
const { channelPlugin } = await import(pluginUrl.href);

const adapter = await channelPlugin.createAdapter(account);

const inboundLog = [];
adapter.onMessage = async (msg) => {
  const tag = msg.attachments?.length ? ` (+${msg.attachments.length} att)` : "";
  const reply = msg.threadContext?.starter?.messageId ? ` ↩ ${msg.threadContext.starter.messageId}` : "";
  const mention = msg.isMention ? " @mention" : "";
  console.log(
    `[inbound]${mention}${reply}${tag} ${msg.senderId} ${msg.messageId}: ${JSON.stringify(msg.text).slice(0, 200)}`,
  );
  if (msg.attachments?.length) {
    for (const att of msg.attachments) {
      console.log(`  • ${att.kind} ${att.mimeType} ${att.sizeBytes}B → ${att.localPath}` + (att.imageDataBase64 ? " [b64-embedded]" : ""));
    }
  }
  inboundLog.push(msg);
};

console.log(`Starting adapter ${adapter.id}…`);
await adapter.start();

const plainResult = await adapter.sendMessage({
  channel: "matrix",
  chatId: roomId,
  text: `[smoke v2] plain text sent at ${new Date().toISOString()}`,
});
console.log(`✓ plain text sent: ${plainResult.messageId}`);

const mdResult = await adapter.sendMessage({
  channel: "matrix",
  chatId: roomId,
  text:
    "## Markdown smoke\n\n" +
    "This message exercises **bold**, *italic*, `inline code`, [a link](https://letta.com), " +
    "and a fenced block:\n\n" +
    "```ts\nconst hi = 'world';\nconsole.log(hi);\n```\n\n" +
    "- bullet one\n- bullet two with `code`\n\n" +
    "1. first\n2. second\n",
});
console.log(`✓ markdown→html sent: ${mdResult.messageId}`);

const reactResult = await adapter._sendReaction(roomId, mdResult.messageId, "👍");
console.log(`✓ reaction sent: ${reactResult.messageId}`);

const editResult = await adapter._editMessage(
  roomId,
  plainResult.messageId,
  "[smoke v2] **edited** — m.replace working",
);
console.log(`✓ edit sent: ${editResult.messageId}`);

const replyResult = await adapter.sendMessage({
  channel: "matrix",
  chatId: roomId,
  text: "↩ reply to the markdown message",
  replyToMessageId: mdResult.messageId,
});
console.log(`✓ reply sent: ${replyResult.messageId}`);

console.log(`Tailing /sync for ${waitSeconds}s — post a message (try replying, attaching an image, mentioning @lettabot)…`);
await new Promise((r) => setTimeout(r, waitSeconds * 1000));

await adapter.stop();
console.log(`Done. Inbound events captured: ${inboundLog.length}`);
process.exit(0);
