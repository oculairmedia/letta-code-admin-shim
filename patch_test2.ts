import fs from "fs";

let content = fs.readFileSync("admin-shim/test/ambient-stream.test.ts", "utf-8");
content = content.replace(
  `seedConversation(shim.stateDir, { id: "conv-1", agentId: "agent-1" });`,
  `seedConversation(shim.stateDir, "agent-1", { id: "conv-1" });`
);

fs.writeFileSync("admin-shim/test/ambient-stream.test.ts", content);
