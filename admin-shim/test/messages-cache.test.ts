/**
 * lcp-h5ns / lcp-e5hb: caching + parse-robustness for the message read path.
 *
 * listMessages is the hottest read endpoint (mobile polls it constantly).
 * These tests assert:
 *   - repeated reads of an UNCHANGED file return identical results (cache hit),
 *   - an APPEND is reflected on the next read (size changes -> cache miss),
 *   - an in-place REWRITE (the healer's atomic temp+rename) is reflected,
 *   - a truncated final line (crash mid-append) is tolerated: the complete
 *     records still surface instead of the whole file read failing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listMessages, _internals } from "../lib/store.js";

const CONV = "conv-cache-test";
const AGENT = "agent-cache-test";

function flat(id: string, role: string, text: string) {
  return { id, role, content: [{ type: "text", text }] };
}

function setup(): { path: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lcp-h5ns-"));
  const prev = process.env["LETTA_LOCAL_BACKEND_DIR"];
  process.env["LETTA_LOCAL_BACKEND_DIR"] = dir;
  const key = `conversation:${CONV}`;
  const convDir = join(dir, "conversations", _internals.b64url(key));
  mkdirSync(convDir, { recursive: true });
  return {
    path: join(convDir, "messages.jsonl"),
    restore: () => {
      if (prev !== undefined) process.env["LETTA_LOCAL_BACKEND_DIR"] = prev;
      else delete process.env["LETTA_LOCAL_BACKEND_DIR"];
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function write(path: string, records: unknown[]) {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("repeated reads of an unchanged file return identical content", async () => {
  const { path, restore } = setup();
  try {
    write(path, [flat("m1", "user", "a"), flat("m2", "assistant", "b")]);
    const first = await listMessages(CONV, AGENT, {});
    const second = await listMessages(CONV, AGENT, {});
    assert.deepEqual(first.map((m) => m.id), ["m1", "m2"]);
    assert.deepEqual(second.map((m) => m.id), ["m1", "m2"]);
    // Returned arrays must be independent copies (cache not mutable by caller).
    assert.notEqual(first, second);
    first.length = 0;
    const third = await listMessages(CONV, AGENT, {});
    assert.deepEqual(third.map((m) => m.id), ["m1", "m2"], "mutating a result must not corrupt the cache");
  } finally {
    restore();
  }
});

test("an append is reflected on the next read", async () => {
  const { path, restore } = setup();
  try {
    write(path, [flat("m1", "user", "a")]);
    assert.deepEqual((await listMessages(CONV, AGENT, {})).map((m) => m.id), ["m1"]);
    appendFileSync(path, JSON.stringify(flat("m2", "assistant", "b")) + "\n");
    assert.deepEqual(
      (await listMessages(CONV, AGENT, {})).map((m) => m.id),
      ["m1", "m2"],
      "append (size change) must invalidate the cache",
    );
  } finally {
    restore();
  }
});

test("an in-place rewrite (heal) is reflected on the next read", async () => {
  const { path, restore } = setup();
  try {
    write(path, [flat("m1", "user", "a"), flat("m2", "assistant", "b"), flat("m3", "user", "c")]);
    assert.equal((await listMessages(CONV, AGENT, {})).length, 3);
    // Healer rewrites the whole file with a smaller record set.
    write(path, [flat("m1", "user", "a")]);
    assert.deepEqual(
      (await listMessages(CONV, AGENT, {})).map((m) => m.id),
      ["m1"],
      "shrinking rewrite must invalidate the cache",
    );
  } finally {
    restore();
  }
});

test("a truncated final line is tolerated; complete records still surface", async () => {
  const { path, restore } = setup();
  try {
    const good = [flat("m1", "user", "a"), flat("m2", "assistant", "b")];
    // Append a partial/corrupt trailing line as a crash-mid-append would.
    writeFileSync(path, good.map((r) => JSON.stringify(r)).join("\n") + "\n" + '{"id":"m3","role":"user","cont');
    const items = await listMessages(CONV, AGENT, {});
    assert.deepEqual(
      items.map((m) => m.id),
      ["m1", "m2"],
      "the two complete records must survive a truncated final line",
    );
  } finally {
    restore();
  }
});
