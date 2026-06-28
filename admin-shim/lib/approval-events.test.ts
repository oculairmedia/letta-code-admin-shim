import { test } from "node:test";
import assert from "node:assert/strict";
import {
  subscribeApprovalEvents,
  broadcastApprovalEvent,
  __clearApprovalEventSubscribers,
  ApprovalEvent,
} from "./approval-events.js";

const sampleEvent: ApprovalEvent = {
  run_id: "run-123",
  tool_call_id: "call-456",
  status: "approved",
  decided_by: "user-789",
  at: "2023-10-27T10:00:00Z",
};

test("a subscribed listener receives a broadcast ApprovalEvent", () => {
  __clearApprovalEventSubscribers();
  let received: ApprovalEvent | null = null;
  subscribeApprovalEvents((event) => {
    received = event;
  });
  broadcastApprovalEvent(sampleEvent);
  assert.deepEqual(received, sampleEvent);
});

test("the unsubscribe fn removes the listener so it stops receiving", () => {
  __clearApprovalEventSubscribers();
  let count = 0;
  const unsubscribe = subscribeApprovalEvents(() => {
    count++;
  });
  broadcastApprovalEvent(sampleEvent);
  assert.equal(count, 1);
  
  unsubscribe();
  broadcastApprovalEvent(sampleEvent);
  assert.equal(count, 1); // Should not receive a second time
});

test("multiple listeners all receive the same broadcast", () => {
  __clearApprovalEventSubscribers();
  let received1: ApprovalEvent | null = null;
  let received2: ApprovalEvent | null = null;
  
  subscribeApprovalEvents((event) => {
    received1 = event;
  });
  subscribeApprovalEvents((event) => {
    received2 = event;
  });
  
  broadcastApprovalEvent(sampleEvent);
  assert.deepEqual(received1, sampleEvent);
  assert.deepEqual(received2, sampleEvent);
});

test("listener isolation — one listener throwing does NOT prevent others from receiving", () => {
  __clearApprovalEventSubscribers();
  
  // To avoid spamming stderr during tests, we can temporarily suppress console.error
  // or just let it log. The instructions do not mention suppressing console.error,
  // but it's good practice. I'll just let it print to follow the exact behavior.
  
  let received: ApprovalEvent | null = null;
  
  subscribeApprovalEvents(() => {
    throw new Error("Test error - this should be caught and logged");
  });
  
  subscribeApprovalEvents((event) => {
    received = event;
  });
  
  // Ensure broadcast does not throw
  broadcastApprovalEvent(sampleEvent);
  assert.deepEqual(received, sampleEvent);
});

test("after the clear helper, no listener receives subsequent broadcasts", () => {
  __clearApprovalEventSubscribers();
  let count = 0;
  subscribeApprovalEvents(() => {
    count++;
  });
  
  __clearApprovalEventSubscribers();
  broadcastApprovalEvent(sampleEvent);
  
  assert.equal(count, 0);
});
