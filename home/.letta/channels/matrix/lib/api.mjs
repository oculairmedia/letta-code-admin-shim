/**
 * Thin Matrix Client-Server v3 API wrapper over node's built-in fetch.
 *
 * Zero dependencies. Returns parsed JSON or throws a structured error.
 */

function joinUrl(base, path) {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}${path.startsWith("/") ? path : `/${path}`}`;
}

export function createMatrixClient({ homeserverUrl, accessToken }) {
  if (!homeserverUrl) throw new Error("matrix: homeserverUrl is required");
  if (!accessToken) throw new Error("matrix: accessToken is required");

  const auth = { Authorization: `Bearer ${accessToken}` };

  async function request(method, path, { body, signal, query, raw, headers: extra } = {}) {
    const url = new URL(joinUrl(homeserverUrl, path));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    const headers = { ...auth, ...(extra ?? {}) };
    let payload;
    if (body !== undefined) {
      if (body instanceof Uint8Array || body instanceof ArrayBuffer || typeof body === "string") {
        payload = body;
      } else {
        headers["Content-Type"] ??= "application/json";
        payload = JSON.stringify(body);
      }
    }
    const response = await fetch(url, { method, headers, body: payload, signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "<no body>");
      const err = new Error(`matrix ${method} ${path} ${response.status}: ${text.slice(0, 240)}`);
      err.status = response.status;
      throw err;
    }
    if (raw) return response;
    if (response.status === 204) return null;
    const ct = response.headers.get("content-type") || "";
    if (ct.includes("application/json")) return response.json();
    return response.text();
  }

  return {
    homeserverUrl,
    accessToken,

    whoami: () => request("GET", "/_matrix/client/v3/account/whoami"),

    sync: ({ since, timeoutMs, signal }) =>
      request("GET", "/_matrix/client/v3/sync", {
        signal,
        query: {
          since,
          timeout: timeoutMs,
          filter: JSON.stringify({
            room: {
              timeline: { limit: 50, types: ["m.room.message", "m.room.redaction"] },
              state: { types: ["m.room.member", "m.room.name"], lazy_load_members: true },
              ephemeral: { limit: 0, types: [] },
              account_data: { limit: 0, types: [] },
            },
            presence: { types: [] },
            account_data: { types: [] },
          }),
        },
      }),

    sendEvent: ({ roomId, type = "m.room.message", txnId, body }) =>
      request(
        "PUT",
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`,
        { body },
      ),

    redactEvent: ({ roomId, eventId, txnId, reason }) =>
      request(
        "PUT",
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`,
        { body: reason ? { reason } : {} },
      ),

    setTyping: ({ roomId, userId, typing, timeoutMs }) =>
      request(
        "PUT",
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
        { body: { typing, ...(typing ? { timeout: timeoutMs ?? 5000 } : {}) } },
      ),

    setReadMarker: ({ roomId, eventId }) =>
      request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`, {
        body: { "m.fully_read": eventId, "m.read": eventId },
      }),

    joinRoom: ({ roomIdOrAlias }) =>
      request("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`, { body: {} }),

    getRoomName: async ({ roomId }) => {
      try {
        const state = await request(
          "GET",
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
        );
        return state?.name ?? null;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },

    // Authenticated media download (v1.11+). Falls back to legacy unauthenticated path.
    downloadMedia: async ({ mxcUri, signal }) => {
      const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcUri || "");
      if (!match) throw new Error(`invalid mxc uri: ${mxcUri}`);
      const [, server, mediaId] = match;
      const authedPath = `/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;
      try {
        const response = await request("GET", authedPath, { signal, raw: true });
        const buf = Buffer.from(await response.arrayBuffer());
        return { buf, contentType: response.headers.get("content-type") || "application/octet-stream" };
      } catch (err) {
        if (err.status !== 404 && err.status !== 401 && err.status !== 405) throw err;
        const legacyPath = `/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;
        const response = await request("GET", legacyPath, { signal, raw: true });
        const buf = Buffer.from(await response.arrayBuffer());
        return { buf, contentType: response.headers.get("content-type") || "application/octet-stream" };
      }
    },
  };
}
