import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  subscribeGoalEvents,
  broadcastGoalEvent,
  __clearGoalEventSubscribers,
  GoalEvent,
} from "./goal-events.js";

const dummyEvent: GoalEvent = {
  reason: "client_mutation",
  at: new Date().toISOString(),
  status: {} as any,
};

test("goal-events pub/sub", async (t) => {
  beforeEach(() => {
    __clearGoalEventSubscribers();
  });

  await t.test("subscribed listener receives broadcast event", (t) => {
    let receivedEvent: GoalEvent | null = null;
    subscribeGoalEvents((event) => {
      receivedEvent = event;
    });

    broadcastGoalEvent(dummyEvent);
    assert.strictEqual(receivedEvent, dummyEvent);
  });

  await t.test("unsubscribed listener does not receive broadcast", (t) => {
    let receivedEvent: GoalEvent | null = null;
    const unsubscribe = subscribeGoalEvents((event) => {
      receivedEvent = event;
    });

    unsubscribe();
    broadcastGoalEvent(dummyEvent);
    assert.strictEqual(receivedEvent, null);
  });

  await t.test("multiple listeners receive broadcast", (t) => {
    let count1 = 0;
    let count2 = 0;
    subscribeGoalEvents(() => count1++);
    subscribeGoalEvents(() => count2++);

    broadcastGoalEvent(dummyEvent);
    assert.strictEqual(count1, 1);
    assert.strictEqual(count2, 1);
  });

  await t.test("listener isolation - throwing listener does not affect others", (t) => {
    let count = 0;
    subscribeGoalEvents(() => {
      throw new Error("test error");
    });
    subscribeGoalEvents(() => {
      count++;
    });

    // Should not throw, should just log and continue
    broadcastGoalEvent(dummyEvent);
    assert.strictEqual(count, 1);
  });

  await t.test("__clearGoalEventSubscribers removes all listeners", (t) => {
    let count = 0;
    subscribeGoalEvents(() => count++);
    subscribeGoalEvents(() => count++);

    __clearGoalEventSubscribers();
    broadcastGoalEvent(dummyEvent);
    
    assert.strictEqual(count, 0);
  });
});
