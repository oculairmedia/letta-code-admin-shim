import { test } from "node:test";
import assert from "node:assert/strict";
import { startShim } from "./helpers/shim.js";
import zlib from "node:zlib";

test("GET /v1/health/ accepts gzip compression", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const res = await fetch(`${shim.url}/v1/health/`, {
    headers: {
      "Accept-Encoding": "gzip",
    },
  });

  const contentEncoding = res.headers.get("content-encoding");
  assert.equal(contentEncoding, "gzip");

  const buffer = await res.arrayBuffer();
  // node fetch auto-decompresses based on content-encoding, so buffer is already decompressed!
  const decompressed = Buffer.from(buffer);
  const body = JSON.parse(decompressed.toString("utf8"));
  assert.equal(body.status, "ok");
});

test("GET /v1/health/ accepts br compression", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const res = await fetch(`${shim.url}/v1/health/`, {
    headers: {
      "Accept-Encoding": "br",
    },
  });

  const contentEncoding = res.headers.get("content-encoding");
  assert.equal(contentEncoding, "br");

  const buffer = await res.arrayBuffer();
  // node fetch auto-decompresses based on content-encoding, so buffer is already decompressed!
  const decompressed = Buffer.from(buffer);
  const body = JSON.parse(decompressed.toString("utf8"));
  assert.equal(body.status, "ok");
});

test("GET /v1/health/ returns identity when no encoding accepted", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const res = await fetch(`${shim.url}/v1/health/`, {
    headers: {
      "Accept-Encoding": "identity",
    },
  });

  const contentEncoding = res.headers.get("content-encoding");
  assert.equal(contentEncoding, null);

  const body = await res.json();
  assert.equal(body.status, "ok");
});

test("SSE framing does not use compression if unsafe", async (t) => {
  const shim = await startShim();
  t.after(() => shim.stop());

  const res = await fetch(`${shim.url}/v1/conversations/conv-123/stream`, {
    method: "POST",
    headers: {
      "Accept-Encoding": "gzip",
    },
  });

  const contentEncoding = res.headers.get("content-encoding");
  assert.equal(contentEncoding, null); // Streaming should be uncompressed
});
