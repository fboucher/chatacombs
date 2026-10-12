/**
 * Server-Side Message Pacer for Chatacombs.
 * Paces outgoing chat narration (`say` events) at a configurable interval (default 1.8s)
 * in strict FIFO order, preventing Twitch bot rate-limiting.
 * Immediate game moments (`game` events) bypass the queue and emit instantly to overlays.
 */

export const DEFAULT_PACER_INTERVAL_MS = 1800; // 1.8 seconds

export class MessagePacer {
  /**
   * @param {object} [options={}]
   * @param {number} [options.intervalMs=1800]
   * @param {() => number} [options.clock=() => Date.now()]
   * @param {(event: object) => void} [options.emitFn] Callback to emit paced/instant events
   */
  constructor(options = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_PACER_INTERVAL_MS;
    this.clock = options.clock || (() => Date.now());
    this.emitFn = options.emitFn || (() => {});

    this.queue = []; // Array of { event, id }
    this.lastSentAt = -Infinity;
    this.timer = null;
    this.nextId = 1;
  }

  /**
   * Enqueues an outgoing event.
   * If it's a `game` event, it is dispatched immediately.
   * If it's a `say` event, it is added to the FIFO pacing queue.
   * @param {object} event 
   */
  push(event) {
    if (!event) return;

    if (event.kind !== 'say') {
      // Non-chat event: dispatch immediately
      this.emitFn(event);
      return;
    }

    // `say` event: enqueue in FIFO order
    this.queue.push({
      id: this.nextId++,
      event
    });

    this._drain();
  }

  /**
   * Internal drain loop.
   * @param {boolean} [force=false] If true, ignores timer delay (for test stepping)
   */
  _drain(force = false) {
    if (this.queue.length === 0) return;
    if (this.timer && !force) return;

    if (force && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const now = this.clock();
    const timeSinceLast = now - this.lastSentAt;

    if (force || timeSinceLast >= this.intervalMs) {
      // Send immediately
      const item = this.queue.shift();
      this.lastSentAt = now;
      this.emitFn(item.event);

      // If more items remain, schedule next delivery
      if (this.queue.length > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this._drain();
        }, this.intervalMs);
        if (this.timer?.unref) this.timer.unref();
      }
    } else {
      // Need to wait remaining interval
      const waitMs = this.intervalMs - timeSinceLast;
      this.timer = setTimeout(() => {
        this.timer = null;
        this._drain();
      }, waitMs);
      if (this.timer?.unref) this.timer.unref();
    }
  }

  /**
   * Forces stepping the pacer forward (useful for fast-forwarding fake clocks).
   */
  step() {
    this._drain(true);
  }

  /**
   * Flushes and cancels any scheduled timer.
   */
  clear() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
  }
}
