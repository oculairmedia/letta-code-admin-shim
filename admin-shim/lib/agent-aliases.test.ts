import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentIdAlias, AGENT_ID_ALIASES } from "./agent-aliases.js";

test("resolveAgentIdAlias", async (t) => {
  await t.test("(1) exists(agentId)=true -> returns agentId immediately", () => {
    const existsStub = (id: string) => id === "agent-1";
    assert.equal(resolveAgentIdAlias("agent-1", existsStub), "agent-1");
  });

  await t.test("(2) a known alias chain where the first id does not exist but its alias target does", () => {
    const firstId = "agent-migrated-eeb0dbb6d6117617453ba793";
    const targetId = AGENT_ID_ALIASES[firstId];
    
    const existsStub = (id: string) => id === targetId;
    assert.equal(resolveAgentIdAlias(firstId, existsStub), targetId);
  });

  await t.test("(3) a multi-hop chain (a->b->c) where only c exists", () => {
    const a = "agent-migrated-77d0a4b78ede9f8d9e1b279b";
    const b = "agent-597b5756-2915-4560-ba6b-91005f085166";
    const c = "agent-local-ffa3a92b-f5d6-45e1-8866-f3c965a92133";
    
    assert.equal(AGENT_ID_ALIASES[a], b);
    assert.equal(AGENT_ID_ALIASES[b], c);
    
    const existsStub = (id: string) => id === c;
    assert.equal(resolveAgentIdAlias(a, existsStub), c);
  });

  await t.test("(4) no alias and not exists -> returns the original agentId", () => {
    const existsStub = (id: string) => false;
    assert.equal(resolveAgentIdAlias("agent-unknown", existsStub), "agent-unknown");
  });

  await t.test("(5) a cycle in aliases must not infinite-loop and returns the original agentId", () => {
    AGENT_ID_ALIASES["agent-cycle-1"] = "agent-cycle-2";
    AGENT_ID_ALIASES["agent-cycle-2"] = "agent-cycle-3";
    AGENT_ID_ALIASES["agent-cycle-3"] = "agent-cycle-1";
    
    try {
      const existsStub = (id: string) => false;
      assert.equal(resolveAgentIdAlias("agent-cycle-1", existsStub), "agent-cycle-1");
    } finally {
      delete AGENT_ID_ALIASES["agent-cycle-1"];
      delete AGENT_ID_ALIASES["agent-cycle-2"];
      delete AGENT_ID_ALIASES["agent-cycle-3"];
    }
  });
});
