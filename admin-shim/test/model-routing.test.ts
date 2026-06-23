import test from "node:test";
import assert from "node:assert/strict";

import { routeModel } from "../lib/model-routing.js";

test("routeModel: returns default model when no config provided", () => {
  assert.strictEqual(routeModel(), "gpt-4o");
});

test("routeModel: returns custom default model when provided", () => {
  assert.strictEqual(routeModel({ defaultModel: "claude-3-5-sonnet-20241022" }), "claude-3-5-sonnet-20241022");
});

test("routeModel: config override respects custom model choice over default", () => {
  assert.strictEqual(routeModel({ overrideModel: "gpt-4", defaultModel: "gpt-4o" }), "gpt-4");
});

test("routeModel: config override wins over job type routing", () => {
  assert.strictEqual(routeModel({ overrideModel: "gpt-4", jobType: "mechanical" }), "gpt-4");
  assert.strictEqual(routeModel({ overrideModel: "gpt-4", jobType: "test" }), "gpt-4");
  assert.strictEqual(routeModel({ overrideModel: "gpt-4", jobType: "high-risk" }), "gpt-4");
});

test("routeModel: mechanical jobs use lower-cost model", () => {
  assert.strictEqual(routeModel({ jobType: "mechanical" }), "gpt-4o-mini");
});

test("routeModel: test jobs use lower-cost model", () => {
  assert.strictEqual(routeModel({ jobType: "test" }), "gpt-4o-mini");
});

test("routeModel: high-risk jobs escalate to capable reasoning model", () => {
  assert.strictEqual(routeModel({ jobType: "high-risk" }), "o1-preview");
});

test("routeModel: standard jobs use default model", () => {
  assert.strictEqual(routeModel({ jobType: "standard" }), "gpt-4o");
  assert.strictEqual(routeModel({ jobType: "standard", defaultModel: "custom-base-model" }), "custom-base-model");
});
