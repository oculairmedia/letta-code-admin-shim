import fs from "fs";

let content = fs.readFileSync("admin-shim/test/ambient-stream.test.ts", "utf-8");
content = content.replace(
  `const res = await fetch(\`\${shim.url}/v1/conversations/conv-1/stream\``,
  `const res = await fetch(\`\${shim.url}/v1/conversations/conv-default-agent-1/stream\``
);
content = content.replace(
  `const detailRes = await fetch(\`\${shim.url}/v1/conversations/conv-1\`);`,
  `const detailRes = await fetch(\`\${shim.url}/v1/conversations/conv-default-agent-1\`);`
);

fs.writeFileSync("admin-shim/test/ambient-stream.test.ts", content);
