import fs from "fs";

let content = fs.readFileSync("admin-shim/test/ambient-stream.test.ts", "utf-8");
content = content.replace(
  `  t.after(() => shim.stop());

  // Wait for the server to be ready and populate a worker by fetching detail`,
  `  t.after(() => shim.stop());

  seedAgent(shim.stateDir, { id: "agent-1", name: "test-agent" });
  seedConversation(shim.stateDir, "agent-1", { id: "conv-1" });

  // Wait for the server to be ready and populate a worker by fetching detail`
);

fs.writeFileSync("admin-shim/test/ambient-stream.test.ts", content);
