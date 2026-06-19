import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  __clearAgentEventSubscribers,
  broadcastAgentEvent,
  subscribeAgentEvents,
} from "../lib/agent-events.js";

afterEach(() => {
  __clearAgentEventSubscribers();
});

describe("agent-events", () => {
  it("broadcasts agent_updated events to subscribers", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeAgentEvents((event) => received.push(event));

    broadcastAgentEvent({
      agent_id: "agent-test",
      reason: "updated",
      at: "2026-06-19T00:00:00.000Z",
      version: "2026-06-19T00:00:00.000Z",
    });

    assert.deepEqual(received, [
      {
        agent_id: "agent-test",
        reason: "updated",
        at: "2026-06-19T00:00:00.000Z",
        version: "2026-06-19T00:00:00.000Z",
      },
    ]);

    unsubscribe();
    broadcastAgentEvent({ agent_id: "agent-test", reason: "updated", at: "later" });
    assert.equal(received.length, 1);
  });

  it("clears agent_updated subscribers", () => {
    const received: unknown[] = [];
    subscribeAgentEvents((event) => received.push(event));

    __clearAgentEventSubscribers();
    broadcastAgentEvent({ agent_id: "agent-test", reason: "updated", at: "later" });

    assert.deepEqual(received, []);
  });
});
