/**
 * Deterministic A2UI splitter fuzz coverage (lcp-uo5.10).
 *
 * Runs 10,000 seeded cases in <5s locally without external dependencies.
 * Override A2UI_FUZZ_SEED to replay a failure; assertion messages include
 * the seed and generated input.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { A2uiStreamSplitter, validateA2uiMessage } from "../lib/a2ui-stream-splitter.js";

const OPEN = "<a2ui-json>";
const CLOSE = "</a2ui-json>";
const CASES = 10_000;

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ExpectedBlock {
  raw: string;
  malformed: boolean;
}

interface ExpectedParse {
  text: string;
  blocks: ExpectedBlock[];
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function int(rand: () => number, max: number): number {
  return Math.floor(rand() * max);
}

function text(rand: () => number): string {
  const alphabet = " abcdefghijklmnopqrstuvwxyz0123456789{}[]:,.-_/<>\n";
  const len = int(rand, 40);
  let out = "";
  for (let i = 0; i < len; i += 1) out += alphabet[int(rand, alphabet.length)]!;
  return out.replaceAll(OPEN, "<a2ui json>").replaceAll(CLOSE, "</a2ui json>");
}

function validJson(rand: () => number): string {
  const id = `s-${int(rand, 1_000_000)}`;
  if (int(rand, 2) === 0) {
    return JSON.stringify({ version: "v0.9", createSurface: { surfaceId: id, catalogId: "basic" } });
  }
  return JSON.stringify({
    version: "v0.9",
    updateComponents: {
      surfaceId: id,
      components: [{ id: "root", component: "Text" }],
    },
  });
}

function malformedJson(rand: () => number): string {
  const choices = ["{", "[1,", "not-json", "{\"version\":\"v0.9\"", "true"];
  return choices[int(rand, choices.length)]!;
}

function buildInput(seed: number): string {
  const rand = lcg(seed);
  const segments = 1 + int(rand, 24);
  let out = "";
  for (let i = 0; i < segments; i += 1) {
    const kind = int(rand, 7);
    if (kind <= 2) out += text(rand);
    else if (kind <= 4) out += `${OPEN}${validJson(rand)}${CLOSE}`;
    else if (kind === 5) out += `${OPEN}${malformedJson(rand)}${CLOSE}`;
    else out += OPEN.slice(0, 1 + int(rand, OPEN.length - 1));
  }
  if (int(rand, 8) === 0) out += `${OPEN}${validJson(rand)}`;
  return out;
}

function expectedParse(input: string): ExpectedParse {
  let cursor = 0;
  let textOut = "";
  const blocks: ExpectedBlock[] = [];
  while (cursor < input.length) {
    const openIdx = input.indexOf(OPEN, cursor);
    if (openIdx < 0) {
      textOut += input.slice(cursor);
      break;
    }
    textOut += input.slice(cursor, openIdx);
    const contentStart = openIdx + OPEN.length;
    const closeIdx = input.indexOf(CLOSE, contentStart);
    if (closeIdx < 0) break;
    const raw = input.slice(contentStart, closeIdx);
    let malformed = false;
    try { JSON.parse(raw); } catch { malformed = true; }
    blocks.push({ raw, malformed });
    cursor = closeIdx + CLOSE.length;
  }
  return { text: textOut, blocks };
}

function chunkInput(input: string, seed: number): string[] {
  const rand = lcg(seed ^ 0x9e3779b9);
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const size = 1 + int(rand, 100);
    chunks.push(input.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}

function runCase(input: string, seed: number): void {
  const sp = new A2uiStreamSplitter({ validate: validateA2uiMessage });
  let textOut = "";
  const rawOut: string[] = [];
  const malformedFlags: boolean[] = [];
  for (const chunk of chunkInput(input, seed)) {
    const out = sp.feed(chunk);
    textOut += out.text;
    for (const frame of out.frames) {
      rawOut.push(frame.raw);
      malformedFlags.push(frame.parseError !== null && frame.ok === false);
    }
  }
  textOut += sp.flush().text;

  const expected = expectedParse(input);
  assert.equal(textOut, expected.text, `text mismatch seed=${seed} input=${JSON.stringify(input)}`);
  assert.deepEqual(rawOut, expected.blocks.map((b) => b.raw), `raw mismatch seed=${seed} input=${JSON.stringify(input)}`);
  expected.blocks.forEach((block, i) => {
    if (block.malformed) {
      assert.equal(malformedFlags[i], true, `malformed JSON not surfaced seed=${seed} raw=${JSON.stringify(block.raw)} input=${JSON.stringify(input)}`);
    }
  });
}

test("a2ui-splitter fuzz: randomized adversarial streams preserve parser invariants", () => {
  const baseSeed = Number.parseInt(process.env["A2UI_FUZZ_SEED"] ?? "424242", 10);
  for (let i = 0; i < CASES; i += 1) {
    const seed = (baseSeed + i) >>> 0;
    runCase(buildInput(seed), seed);
  }
});

test("a2ui-splitter fuzz: captured adversarial fixture remains stable", () => {
  const fixture = readFileSync(join(__dirname, "fixtures", "a2ui-adversarial", "real-model-mixed-tags.txt"), "utf8");
  runCase(fixture, 0xdecafbad);
});
