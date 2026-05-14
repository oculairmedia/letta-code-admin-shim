/**
 * Endpoint-by-endpoint diff between the vanilla Python Letta server and the
 * shim. For each endpoint we hit both, compare shapes (key sets, types,
 * value categories), and surface differences.
 *
 * Usage: node diff-vanilla.mjs
 */

const VANILLA = "http://192.168.50.90:8289";
const VANILLA_KEY = "lettaSecurePass123";
const SHIM = "http://localhost:8291";

async function fetchJson(base, path, { method = "GET", body, key } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text: text.slice(0, 500) };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

function categorize(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "array[0]" : `array[${value.length}]`;
  return typeof value;
}

function summarizeShape(obj, depth = 0) {
  if (obj === null) return "null";
  if (typeof obj !== "object") return typeof obj;
  if (Array.isArray(obj)) {
    return `array[${obj.length}]${obj.length ? " of " + summarizeShape(obj[0], depth + 1) : ""}`;
  }
  if (depth > 2) return "{...}";
  const keys = Object.keys(obj).slice(0, 30);
  const summary = {};
  for (const k of keys) summary[k] = categorize(obj[k]);
  return summary;
}

function compareKeys(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return null;
  const sample = (x) => (Array.isArray(x) ? (x[0] ?? {}) : x);
  const sa = sample(a), sb = sample(b);
  if (typeof sa !== "object" || typeof sb !== "object" || sa === null || sb === null) return null;
  const ak = new Set(Object.keys(sa));
  const bk = new Set(Object.keys(sb));
  const onlyA = [...ak].filter((k) => !bk.has(k));
  const onlyB = [...bk].filter((k) => !ak.has(k));
  return { vanilla_only: onlyA, shim_only: onlyB, common: [...ak].filter((k) => bk.has(k)) };
}

// Discover Meridian's vanilla-side and shim-side agent ids so we can probe
// detail/messages endpoints on both.
async function discoverAgentIds() {
  const vAgents = await fetchJson(VANILLA, "/v1/agents?name=Meridian&limit=1", { key: VANILLA_KEY });
  const sAgents = await fetchJson(SHIM, "/v1/agents?name=Meridian&limit=1");
  const vId = Array.isArray(vAgents.json) ? vAgents.json[0]?.id : null;
  const sId = Array.isArray(sAgents.json) ? sAgents.json[0]?.id : null;
  const vConvs = vId
    ? await fetchJson(VANILLA, `/v1/conversations?agent_id=${vId}&limit=1`, { key: VANILLA_KEY })
    : null;
  const sConvs = sId
    ? await fetchJson(SHIM, `/v1/conversations?agent_id=${sId}&limit=1`)
    : null;
  const vConv = vConvs?.json?.[0]?.id;
  const sConv = sConvs?.json?.[0]?.id;
  return { vId, sId, vConv, sConv };
}

const ids = await discoverAgentIds();
console.log(`Meridian: vanilla=${ids.vId} / shim=${ids.sId}`);
console.log(`conv:     vanilla=${ids.vConv} / shim=${ids.sConv}\n`);

const cases = [
  { name: "/v1/health/", path: "/v1/health/" },
  { name: "/v1/agents?limit=2", path: "/v1/agents?limit=2" },
  { name: "/v1/agents/count", path: "/v1/agents/count" },
  { name: "/v1/agents/{id}", vPath: `/v1/agents/${ids.vId}`, sPath: `/v1/agents/${ids.sId}` },
  { name: "/v1/agents/{id}/context", vPath: `/v1/agents/${ids.vId}/context`, sPath: `/v1/agents/${ids.sId}/context` },
  { name: "/v1/agents/{id}/core-memory/blocks", vPath: `/v1/agents/${ids.vId}/core-memory/blocks`, sPath: `/v1/agents/${ids.sId}/core-memory/blocks` },
  { name: "/v1/conversations?agent_id (limit=3)", vPath: `/v1/conversations?agent_id=${ids.vId}&limit=3`, sPath: `/v1/conversations?agent_id=${ids.sId}&limit=3` },
  { name: "/v1/conversations/{id}", vPath: `/v1/conversations/${ids.vConv}`, sPath: `/v1/conversations/${ids.sConv}` },
  { name: "/v1/conversations/{id}/messages?limit=3", vPath: `/v1/conversations/${ids.vConv}/messages?limit=3`, sPath: `/v1/conversations/${ids.sConv}/messages?limit=3` },
  { name: "/v1/models", path: "/v1/models" },
  { name: "/v1/tools", path: "/v1/tools" },
  { name: "/v1/providers", path: "/v1/providers" },
  { name: "/v1/blocks", path: "/v1/blocks?limit=2" },
];

console.log("Endpoint                                       | Vanilla | Shim    | Notes");
console.log("-----------------------------------------------+---------+---------+------");
for (const c of cases) {
  const vPath = c.vPath ?? c.path;
  const sPath = c.sPath ?? c.path;
  if (!vPath || !sPath) {
    console.log(`${c.name.padEnd(46)} | skipped (missing id)`);
    continue;
  }
  const v = await fetchJson(VANILLA, vPath, { key: VANILLA_KEY });
  const s = await fetchJson(SHIM, sPath, { key: "anything" });
  const vs = v.status;
  const ss = s.status;
  const flag = vs === ss ? "✓" : "✗";
  let notes = "";
  const k = compareKeys(v.json, s.json);
  if (k && (k.vanilla_only.length || k.shim_only.length)) {
    if (k.vanilla_only.length) notes += `vanilla+:${k.vanilla_only.slice(0, 5).join(",")} `;
    if (k.shim_only.length) notes += `shim+:${k.shim_only.slice(0, 5).join(",")}`;
  } else if (Array.isArray(v.json) && Array.isArray(s.json) && v.json.length !== s.json.length) {
    notes = `len:${v.json.length} vs ${s.json.length}`;
  }
  console.log(
    `${c.name.padEnd(46)} | ${String(vs).padEnd(7)} | ${String(ss).padEnd(7)} | ${flag} ${notes}`,
  );
}
