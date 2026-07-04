/**
 * Thin Telegram Bot API wrapper over node's built-in fetch.
 *
 * Zero dependencies. Every method POSTs a JSON body to
 * `<apiBaseUrl>/bot<token>/<method>` and returns the unwrapped `result`
 * field, or throws a structured error carrying the Telegram
 * `error_code` / `description`.
 *
 * `apiBaseUrl` defaults to Telegram's public endpoint but is overridable so
 * the plugin can target a local Bot API server (or a test stub).
 */

const DEFAULT_API_BASE = "https://api.telegram.org";

function joinUrl(base, path) {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}${path.startsWith("/") ? path : `/${path}`}`;
}

export function createTelegramClient({ botToken, apiBaseUrl }) {
  if (!botToken) throw new Error("telegram: botToken is required");
  const base = apiBaseUrl && String(apiBaseUrl).length > 0 ? String(apiBaseUrl) : DEFAULT_API_BASE;

  async function call(method, params, { signal } = {}) {
    const url = joinUrl(base, `/bot${botToken}/${method}`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params ?? {}),
      signal,
    });
    let json;
    const text = await response.text();
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      const err = new Error(`telegram ${method}: non-JSON response (${response.status})`);
      err.status = response.status;
      throw err;
    }
    if (!response.ok || json.ok !== true) {
      const err = new Error(
        `telegram ${method} failed (${json.error_code ?? response.status}): ${
          json.description ?? "unknown error"
        }`,
      );
      err.status = json.error_code ?? response.status;
      err.retryAfter = json?.parameters?.retry_after ?? null;
      throw err;
    }
    return json.result;
  }

  return {
    apiBaseUrl: base,

    getMe: ({ signal } = {}) => call("getMe", {}, { signal }),

    getUpdates: ({ offset, timeoutSec, allowedUpdates, signal } = {}) =>
      call(
        "getUpdates",
        {
          ...(offset !== undefined && offset !== null ? { offset } : {}),
          timeout: timeoutSec ?? 0,
          ...(Array.isArray(allowedUpdates) ? { allowed_updates: allowedUpdates } : {}),
        },
        { signal },
      ),

    sendMessage: ({ chatId, text, parseMode, messageThreadId, replyToMessageId, signal } = {}) =>
      call(
        "sendMessage",
        {
          chat_id: chatId,
          text,
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(messageThreadId !== undefined && messageThreadId !== null
            ? { message_thread_id: messageThreadId }
            : {}),
          ...(replyToMessageId !== undefined && replyToMessageId !== null
            ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
            : {}),
        },
        { signal },
      ),

    sendChatAction: ({ chatId, action = "typing", messageThreadId, signal } = {}) =>
      call(
        "sendChatAction",
        {
          chat_id: chatId,
          action,
          ...(messageThreadId !== undefined && messageThreadId !== null
            ? { message_thread_id: messageThreadId }
            : {}),
        },
        { signal },
      ),
  };
}
