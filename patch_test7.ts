import fs from "fs";

let content = fs.readFileSync("admin-shim/test/ambient-stream.test.ts", "utf-8");
content = content.replace(
  `  const detailRes = await fetch(\`\${shim.url}/v1/conversations/conv-default-agent-1\`);
  assert.equal(detailRes.status, 200);

  // Trigger a worker to load
  await fetch(\`\${shim.url}/v1/agents/agent-1/messages\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], stream: false })
  });`,
  `  // Trigger a worker to load
  await fetch(\`\${shim.url}/v1/agents/agent-1/messages\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], stream: false })
  });`
);
fs.writeFileSync("admin-shim/test/ambient-stream.test.ts", content);
