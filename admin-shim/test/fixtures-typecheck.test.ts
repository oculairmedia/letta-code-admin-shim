/**
 * Type-assertion test for letta-code's raw stream-json fixtures.
 *
 * Loads every `.jsonl` under `test/fixtures/stream-traces/`, parses each line,
 * and asserts the discriminator is recognized by `LettaStreamFrame` (and for
 * `stream_event`, that the inner `message_type` is recognized too).
 *
 * The typed binding below ties parsed frames to the public union.
 * `tsc --noEmit` actually verifies the body during `npm run typecheck`, so a
 * future maintainer who introduces a new frame variant in a fixture without
 * extending `lib/types/letta-stream.ts` will see the test fail at both
 * type-check time and runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { LettaStreamFrame } from "../lib/types/letta-stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures", "stream-traces");

const TOP_LEVEL_TYPES: ReadonlySet<string> = new Set([
  "system",
  "queue_item_enqueued",
  "queue_batch_dequeued",
  "queue_cleared",
  "stream_event",
  "auto_approval",
  "result",
]);

const INNER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "assistant_message",
  "reasoning_message",
  "approval_request_message",
  "tool_call_message",
  "tool_return_message",
  "usage_statistics",
  "stop_reason",
  "ping",
]);

test("fixture frames match LettaStreamFrame discriminators", () => {
  const files = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".jsonl"));
  assert.ok(files.length > 0, "expected fixture files in stream-traces/");

  let frameCount = 0;
  for (const file of files) {
    const path = join(FIXTURE_DIR, file);
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      const raw: unknown = JSON.parse(lines[i]);
      // Bind via a typed alias so tsc verifies the asserted shape during
      // `npm run typecheck`.
      const frame = raw as LettaStreamFrame;
      frameCount++;

      assert.ok(
        typeof frame.type === "string",
        `${file} line ${i + 1}: frame missing \`type\` discriminator`,
      );
      assert.ok(
        TOP_LEVEL_TYPES.has(frame.type),
        `${file} line ${i + 1}: unknown top-level type "${frame.type}" — extend LettaStreamFrame`,
      );

      if (frame.type === "stream_event") {
        const ev = frame.event;
        assert.ok(ev && typeof ev === "object", `${file} line ${i + 1}: stream_event.event missing`);
        assert.ok(
          typeof ev.message_type === "string",
          `${file} line ${i + 1}: stream_event.event missing \`message_type\``,
        );
        assert.ok(
          INNER_MESSAGE_TYPES.has(ev.message_type),
          `${file} line ${i + 1}: unknown inner message_type "${ev.message_type}" — extend LettaInnerEvent`,
        );
      }
    }
  }
  assert.ok(frameCount > 0, "expected at least one parsed frame");
});
