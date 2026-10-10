import { EventEmitter } from 'node:events';
import { Engine } from '../engine/engine.js';
import { MessagePacer } from './pacer.js';

export const HEARTBEAT_INTERVAL_MS = 15000; // 15 seconds

/**
 * Per-channel runtime managing the active adventure engine instance,
 * message intake, pacing, and SSE client streams.
 */
export class ChannelRuntime {
  /**
   * @param {object} options
   * @param {string} options.channel
   * @param {import('better-sqlite3').Database} [options.db]
   * @param {() => number} [options.clock=() => Date.now()]
   * @param {() => number} [options.rng=Math.random]
   * @param {string} [options.botName='CB']
   * @param {number} [options.pacerIntervalMs=1800]
   */
  constructor(options = {}) {
    this.channel = (options.channel || 'default').toLowerCase();
    this.db = options.db || null;
    this.clock = options.clock || (() => Date.now());
    this.rng = options.rng || Math.random;
    this.botName = options.botName || process.env.BOT_NAME || 'CB';
    this.pacerIntervalMs = options.pacerIntervalMs ?? 1800;

    this.bus = new EventEmitter();
    this.clients = new Set(); // SSE Response objects

    // Initialize Engine
    this.engine = new Engine({
      channel: this.channel,
      db: this.db,
      clock: this.clock,
      rng: this.rng,
      botName: this.botName
    });

    // Attempt crash recovery on boot
    this.engine.restoreFromDb();

    // Setup Message Pacer
    this.pacer = new MessagePacer({
      intervalMs: this.pacerIntervalMs,
      clock: this.clock,
      emitFn: (event) => this._broadcastRaw(event)
    });

    // 15-second SSE heartbeat interval
    this.heartbeatTimer = setInterval(() => {
      this._broadcastComment('keep-alive ping');
    }, HEARTBEAT_INTERVAL_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /**
   * Registers an SSE client HTTP response connection.
   * @param {import('express').Response} res 
   */
  addClient(res) {
    this.clients.add(res);

    // Initial greeting comment
    res.write(`: connected to channel ${this.channel}\n\n`);

    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  /**
   * Broadcasts an SSE comment (e.g. heartbeat ping).
   * @param {string} comment
   */
  _broadcastComment(comment) {
    const payload = `: ${comment}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch (err) {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Broadcasts a fully formatted SSE event to all connected clients.
   * @param {object} event 
   */
  _broadcastRaw(event) {
    const eventName = event.kind === 'say' ? 'say' : (event.type || 'game');
    const dataStr = JSON.stringify(event);
    const payload = `event: ${eventName}\ndata: ${dataStr}\n\n`;

    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch (err) {
        this.clients.delete(client);
      }
    }

    this.bus.emit('event', event);
  }

  /**
   * Handles incoming chat message from bot.
   * Processes through engine and enqueues emitted events into pacer.
   * @param {object} message
   * @returns {Promise<void>}
   */
  async handleMessage(message) {
    const res = await this.engine.handleMessageAsync(message);
    if (res.events && res.events.length > 0) {
      for (const ev of res.events) {
        this.pacer.push(ev);
      }
    }
  }

  /**
   * Stream lifecycle: starts or ends an adventure.
   * @param {'started'|'ended'} state 
   * @returns {{ changed: boolean, status: string }}
   */
  setStreamState(state) {
    const currentStatus = this.engine.status;

    if (state === 'started') {
      if (currentStatus === 'idle') {
        const events = this.engine.startThemeVote();
        for (const ev of events) {
          this.pacer.push(ev);
        }
        return { changed: true, status: this.engine.status };
      }
      return { changed: false, status: currentStatus };
    }

    if (state === 'ended') {
      if (currentStatus !== 'idle' && currentStatus !== 'cleared' && currentStatus !== 'wiped' && currentStatus !== 'abandoned') {
        const events = this.engine.abandonAdventure('stream_ended');
        for (const ev of events) {
          this.pacer.push(ev);
        }
        return { changed: true, status: this.engine.status };
      }
      return { changed: false, status: currentStatus };
    }

    return { changed: false, status: currentStatus };
  }

  /**
   * Returns current state snapshot.
   * @returns {object}
   */
  getState() {
    return this.engine.getState();
  }

  /**
   * Shuts down runtime, timers, and client connections.
   */
  destroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pacer.clear();
    for (const client of this.clients) {
      try {
        client.end();
      } catch (_) {}
    }
    this.clients.clear();
  }
}
