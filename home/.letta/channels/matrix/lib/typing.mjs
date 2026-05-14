/**
 * Typing indicators with heartbeat — race-safe version.
 *
 * Design:
 *   - Each room has a desired "intent": true (typing) or false (not typing).
 *   - A per-room worker chain serializes API calls: each new start/stop
 *     awaits the previous call before issuing its own setTyping(...). This
 *     guarantees that if you call start() (true) then stop() (false), the
 *     final server state is false even if there are multiple in-flight
 *     setTyping(true) calls.
 *   - A heartbeat refreshes typing=true every 4s while intent is true.
 *   - All `start`/`stop` calls are idempotent w.r.t. intent.
 */

const TYPING_HEARTBEAT_INTERVAL_MS = 4000;
const TYPING_TIMEOUT_MS = 5000;

export class TypingManager {
  constructor({ client, selfUserId, logger = console }) {
    this.client = client;
    this.selfUserId = selfUserId;
    this.logger = logger;
    this.rooms = new Map(); // roomId -> { intent, timer, chain }
  }

  _state(roomId) {
    let state = this.rooms.get(roomId);
    if (!state) {
      state = {
        intent: false,
        timer: null,
        chain: Promise.resolve(),
      };
      this.rooms.set(roomId, state);
    }
    return state;
  }

  _enqueue(state, fn) {
    state.chain = state.chain.then(fn, fn).catch(() => {});
    return state.chain;
  }

  async _setTyping(roomId, typing) {
    try {
      await this.client.setTyping({
        roomId,
        userId: this.selfUserId,
        typing,
        ...(typing ? { timeoutMs: TYPING_TIMEOUT_MS } : {}),
      });
    } catch (err) {
      this.logger.error?.(`[matrix:typing] setTyping(${typing}) ${roomId} failed: ${err.message}`);
    }
  }

  async start(roomId) {
    if (!roomId) return;
    const state = this._state(roomId);
    if (state.intent) return; // already typing — heartbeat handles refresh
    state.intent = true;
    this.logger.error?.(`[matrix:typing] start ${roomId}`);

    await this._enqueue(state, () => this._setTyping(roomId, true));

    if (state.intent && !state.timer) {
      state.timer = setInterval(() => {
        if (!state.intent) return;
        this._enqueue(state, () => this._setTyping(roomId, true));
      }, TYPING_HEARTBEAT_INTERVAL_MS);
      if (state.timer.unref) state.timer.unref();
    }
  }

  async stop(roomId) {
    if (!roomId) return;
    const state = this.rooms.get(roomId);
    if (!state || !state.intent) return;
    state.intent = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    this.logger.error?.(`[matrix:typing] stop ${roomId}`);
    // Queue the false write AFTER any pending (true) writes so we win the race.
    await this._enqueue(state, () => this._setTyping(roomId, false));
  }

  async stopAll() {
    const ids = [...this.rooms.keys()];
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }
}
