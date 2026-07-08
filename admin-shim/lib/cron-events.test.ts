import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  subscribeCronEvents,
  broadcastCronEvent,
  __clearCronEventSubscribers,
  CronEvent,
} from "./cron-events.js";

const testEvent: CronEvent = {
  reason: "scheduler_write",
  tasks_active: 5,
  at: new Date().toISOString(),
};

beforeEach(() => {
  __clearCronEventSubscribers();
});

test("subscribed listener receives broadcast CronEvent", () => {
  let receivedEvent: CronEvent | null = null;
  subscribeCronEvents((event) => {
    receivedEvent = event;
  });

  broadcastCronEvent(testEvent);

  assert.deepEqual(receivedEvent, testEvent);
});

test("unsubscribe function removes listener", () => {
  let receivedEvent: CronEvent | null = null;
  const unsubscribe = subscribeCronEvents((event) => {
    receivedEvent = event;
  });

  unsubscribe();
  broadcastCronEvent(testEvent);

  assert.equal(receivedEvent, null);
});

test("multiple listeners receive broadcast CronEvent", () => {
  let receivedEvent1: CronEvent | null = null;
  let receivedEvent2: CronEvent | null = null;

  subscribeCronEvents((event) => {
    receivedEvent1 = event;
  });
  subscribeCronEvents((event) => {
    receivedEvent2 = event;
  });

  broadcastCronEvent(testEvent);

  assert.deepEqual(receivedEvent1, testEvent);
  assert.deepEqual(receivedEvent2, testEvent);
});

test("listener isolation - throwing listener does not prevent others from receiving", () => {
  let receivedEvent2: CronEvent | null = null;

  subscribeCronEvents(() => {
    throw new Error("I am a bad listener");
  });

  subscribeCronEvents((event) => {
    receivedEvent2 = event;
  });

  broadcastCronEvent(testEvent);

  assert.deepEqual(receivedEvent2, testEvent);
});

test("__clearCronEventSubscribers removes all listeners", () => {
  let receivedEvent: CronEvent | null = null;
  subscribeCronEvents((event) => {
    receivedEvent = event;
  });

  __clearCronEventSubscribers();
  broadcastCronEvent(testEvent);

  assert.equal(receivedEvent, null);
});
