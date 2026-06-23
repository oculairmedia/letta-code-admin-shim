import fs from "fs";

let content = fs.readFileSync("admin-shim/test/ambient-stream.test.ts", "utf-8");
content = content.replace(
  "fixture: \"single-agent\",",
  ""
);
content = content.replace(
  "import { startShim } from \"./helpers/shim.js\";",
  `import { startShim } from "./helpers/shim.js";
import { seedAgent, seedConversation } from "./helpers/fixtures.js";`
);
content = content.replace(
  `  const shim = await startShim({

    env: { `,
  `  const shim = await startShim({
    env: { `
);
content = content.replace(
  "t.after(() => shim.stop());",
  `t.after(() => shim.stop());

  seedAgent(shim.stateDir, { id: "agent-1", name: "test-agent" });
  seedConversation(shim.stateDir, { id: "conv-1", agentId: "agent-1" });`
);

fs.writeFileSync("admin-shim/test/ambient-stream.test.ts", content);
