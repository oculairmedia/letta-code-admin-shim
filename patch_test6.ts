import fs from "fs";

let content = fs.readFileSync("admin-shim/test/ambient-stream.test.ts", "utf-8");
content = content.replace(
  `  seedConversation(shim.stateDir, "agent-1", { id: "conv-1" });

  // Wait for the server to be ready and populate a worker by fetching detail
  const detailRes = await fetch(\`\${shim.url}/v1/conversations/conv-default-agent-1\`);`,
  `  // Letta default conversation is implicitly available for agent-1

  // Wait for the server to be ready and populate a worker by fetching detail
  const detailRes = await fetch(\`\${shim.url}/v1/conversations/conv-default-agent-1\`);`
);
fs.writeFileSync("admin-shim/test/ambient-stream.test.ts", content);
