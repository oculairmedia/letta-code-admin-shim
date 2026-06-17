import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  subscribeGoalEvents,
  broadcastGoalEvent,
  __clearGoalEventSubscribers,
  type GoalEvent,
} from "../lib/goal-events.js";

afterEach(() => __clearGoalEventSubscribers());

test("goal-events: subscriber receives broadcast events", () => {
  const seen: GoalEvent[] = [];
  const unsub = subscribeGoalEvents((e) => seen.push(e));
  broadcastGoalEvent({ agent_id: "agent-1", reason: "created", goals_active: 1, goal_id: "goal-x", at: "t0" });
  broadcastGoalEvent({ agent_id: "agent-1", reason: "progress", goals_active: 1, goal_id: "goal-x", at: "t1" });
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.reason, "created");
  assert.equal(seen[0]?.goal_id, "goal-x");
  assert.equal(seen[1]?.reason, "progress");
  unsub();
});

test("goal-events: unsubscribe stops delivery", () => {
  const seen: GoalEvent[] = [];
  const unsub = subscribeGoalEvents((e) => seen.push(e));
  unsub();
  broadcastGoalEvent({ agent_id: "a", reason: "deleted", goals_active: 0, at: "t" });
  assert.equal(seen.length, 0);
});

test("goal-events: a throwing listener does not break others or the publisher", () => {
  const seen: GoalEvent[] = [];
  subscribeGoalEvents(() => { throw new Error("boom"); });
  subscribeGoalEvents((e) => seen.push(e));
  assert.doesNotThrow(() =>
    broadcastGoalEvent({ agent_id: "a", reason: "updated", goals_active: 2, at: "t" }),
  );
  assert.equal(seen.length, 1);
});
