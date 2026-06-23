import fs from "fs";

let content = fs.readFileSync("admin-shim/server.ts", "utf-8");
content = content.replace(
  `  const ping = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(\`: ping\\n\\n\`);
      if (resolved) getAgentPool().touch(resolved.conversationId, resolved.agentId);
    } catch { /* socket closed */ }
  }, 25_000);`,
  `  const PING_MS = Number(process.env["SHIM_STREAM_PING_MS"] ?? 25_000);
  const ping = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(\`: ping\\n\\n\`);
      if (resolved) getAgentPool().touch(resolved.conversationId, resolved.agentId);
    } catch { /* socket closed */ }
  }, PING_MS);`
);

fs.writeFileSync("admin-shim/server.ts", content);
