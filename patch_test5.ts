import fs from "fs";

let content = fs.readFileSync("admin-shim/test/ambient-stream.test.ts", "utf-8");
content = content.replace(
  `  seedConversation(shim.stateDir, "agent-1", { id: "conv-1" });`,
  `  // Letta default conversation is implicitly available for agent-1`
);
fs.writeFileSync("admin-shim/test/ambient-stream.test.ts", content);
