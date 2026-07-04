/**
 * Typing indicators via Telegram's sendChatAction, with a heartbeat.
 *
 * Telegram clears the "typing…" status ~5s after the last sendChatAction, so
 * we refresh every 4s while a turn is in flight. Per-chat intent is tracked
 * and calls are serialized on a per-chat chain so a late start() cannot
 * revive typing after a stop().
 *
 * A chat key is `chatId` optionally suffixed with the forum topic thread id
 * (`chatId:threadId`) so typing in a specific topic is scoped correctly.
 */

const TYPING_HEARTBEAT_INTERVAL_MS = 4000;

function keyOf(chatId, threadId) {
  return threadId != null && threadId !== "" ? `${chatId}:${threadId}` : `${chatId}`;
}

export class TypingManager {
  constructor({ client, logger = console } = {}) {
    this.client = client;
    this.logger = logger;
    this.chats = new Map(); // key -> { chatId, threadId, intent, timer, chain }
  }

  _state(chatId, threadId) {
    const key = keyOf(chatId, threadId);
    let state = this.chats.get(key);
    if (!state) {
      state = { chatId, threadId: threadId ?? null, intent: false, timer: null, chain: Promise.resolve() };
      this.chats.set(key, state);
    }
    return state;
  }

  _enqueue(state, fn) {
    state.chain = state.chain.then(fn, fn).catch(() => {});
    return state.chain;
  }

  async _send(state, action) {
    try {
      await this.client.sendChatAction({
        chatId: state.chatId,
        action,
        ...(state.threadId != null ? { messageThreadId: state.threadId } : {}),
      });
    } catch (err) {
      this.logger.error?.(`[telegram:typing] sendChatAction ${state.chatId} failed: ${err.message}`);
    }
  }

  async start(chatId, threadId) {
    if (chatId == null) return;
    const state = this._state(chatId, threadId);
    if (state.intent) return; // heartbeat already refreshing
    state.intent = true;
    await this._enqueue(state, () => this._send(state, "typing"));
    if (state.intent && !state.timer) {
      state.timer = setInterval(() => {
        if (!state.intent) return;
        this._enqueue(state, () => this._send(state, "typing"));
      }, TYPING_HEARTBEAT_INTERVAL_MS);
      if (state.timer.unref) state.timer.unref();
    }
  }

  async stop(chatId, threadId) {
    if (chatId == null) return;
    // A nullish threadId means "this chat" — stop the base key AND any
    // topic-scoped keys under it. The registry's `finished` lifecycle event
    // carries no threadId, so it must be able to release topic typing too.
    const targets =
      threadId != null && threadId !== ""
        ? [this.chats.get(keyOf(chatId, threadId))]
        : [...this.chats.values()].filter((s) => String(s.chatId) === String(chatId));
    await Promise.allSettled(
      targets.filter(Boolean).map(async (state) => {
        if (!state.intent) return;
        state.intent = false;
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
        // Telegram has no explicit "stopped typing" action; letting the last
        // sendChatAction lapse (~5s) is the intended clear. We just await the
        // pending chain so no revival is queued.
        await state.chain;
      }),
    );
  }

  async stopAll() {
    const keys = [...this.chats.values()].map((s) => [s.chatId, s.threadId]);
    await Promise.allSettled(keys.map(([c, t]) => this.stop(c, t)));
  }
}
