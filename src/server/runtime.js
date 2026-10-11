import { EventEmitter } from 'node:events';
import { Engine } from '../engine/engine.js';
import { MessagePacer } from './pacer.js';
import { buildOverlayView } from './overlayView.js';

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
    this.overlayClients = new Set(); // Overlay SSE Response objects (game events + overlay_state)
    this._overlayStateScheduled = false;

    this.engineOptions = options.engineOptions || {};

    // Initialize Engine
    this.engine = new Engine({
      channel: this.channel,
      db: this.db,
      clock: this.clock,
      rng: this.rng,
      botName: this.botName,
      ...this.engineOptions
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
   * Registers an overlay SSE connection. Overlays only receive game moments plus an
   * `overlay_state` snapshot, sent on connect so every (re)connect re-syncs the ribbon.
   * @param {import('express').Response} res
   */
  addOverlayClient(res) {
    this.overlayClients.add(res);

    res.write(`: connected to overlay for channel ${this.channel}\n\n`);
    res.write(this._formatOverlayState());

    res.on('close', () => {
      this.overlayClients.delete(res);
    });
  }

  /**
   * Returns the overlay snapshot for this channel.
   * @returns {object}
   */
  getOverlayState() {
    return buildOverlayView(this.engine.getState(), this.engine.getActiveParty());
  }

  /**
   * @returns {string} SSE frame carrying the current overlay snapshot
   */
  _formatOverlayState() {
    return `event: overlay_state\ndata: ${JSON.stringify(this.getOverlayState())}\n\n`;
  }

  /**
   * Writes a payload to every client in a set, dropping broken connections.
   * @param {Set<import('express').Response>} clients
   * @param {string} payload
   */
  _writeAll(clients, payload) {
    for (const client of clients) {
      try {
        client.write(payload);
      } catch (err) {
        clients.delete(client);
      }
    }
  }

  /**
   * Queues one overlay_state frame after the current batch of game events,
   * so a burst of combat events produces a single snapshot.
   */
  _scheduleOverlayState() {
    if (this._overlayStateScheduled || this.overlayClients.size === 0) return;
    this._overlayStateScheduled = true;
    setImmediate(() => {
      this._overlayStateScheduled = false;
      if (this.overlayClients.size === 0) return;
      this._writeAll(this.overlayClients, this._formatOverlayState());
    });
  }

  /**
   * Broadcasts an SSE comment (e.g. heartbeat ping).
   * @param {string} comment
   */
  _broadcastComment(comment) {
    const payload = `: ${comment}\n\n`;
    this._writeAll(this.clients, payload);
    this._writeAll(this.overlayClients, payload);
  }

  /**
   * Broadcasts a fully formatted SSE event to all connected clients.
   * @param {object} event 
   */
  _broadcastRaw(event) {
    const eventName = event.kind === 'say' ? 'say' : (event.type || 'game');
    const dataStr = JSON.stringify(event);
    const payload = `event: ${eventName}\ndata: ${dataStr}\n\n`;

    this._writeAll(this.clients, payload);

    // Overlays get game moments only; any emitted line may follow a state change
    // (vote opened, round started), so a fresh snapshot follows either way.
    if (event.kind === 'game') {
      this._writeAll(this.overlayClients, payload);
    }
    this._scheduleOverlayState();

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
    // Chatters join the party and votes change tallies without emitting events
    this._scheduleOverlayState();
  }

  /**
   * Ticks the runtime and engine clock, resolving any expired timers.
   * Pushes any emitted events into the pacer.
   * @param {number} [currentTime]
   * @returns {Array<object>}
   */
  tick(currentTime = this.clock()) {
    const events = this.engine.tick(currentTime);
    if (events && events.length > 0) {
      for (const ev of events) {
        this.pacer.push(ev);
      }
    }
    this._scheduleOverlayState();
    return events;
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
    for (const client of this.overlayClients) {
      try {
        client.end();
      } catch (_) {}
    }
    this.overlayClients.clear();
  }
}
