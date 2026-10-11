import { EventEmitter } from 'node:events';
import { Engine } from '../engine/engine.js';
import { MessagePacer } from './pacer.js';
import { buildOverlayView } from './overlayView.js';
import { Narrator } from '../ai/narrator.js';
import { createSayEvent } from '../engine/events.js';

export const HEARTBEAT_INTERVAL_MS = 15000; // 15 seconds
export const TICK_INTERVAL_MS = 1000; // vote and combat timers resolve on this clock

const ENDED_STATUSES = new Set(['cleared', 'wiped', 'abandoned']);

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
   * @param {number} [options.tickIntervalMs=1000] How often timers are checked; 0 disables the ticker
   * @param {Narrator} [options.narrator] AI narrator for key moments (defaults to one built from AI_URL)
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

    // Template lines already carry the facts, so narration is AI-only and adds nothing on failure
    this.narrator = options.narrator || new Narrator({ botName: this.botName, fallbackToTemplates: false });
    this._destroyed = false;

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

    // Votes and combat rounds close on their own when chat is quiet
    const tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS;
    this.tickTimer = null;
    if (tickIntervalMs > 0) {
      this.tickTimer = setInterval(() => this.tick(), tickIntervalMs);
      if (this.tickTimer.unref) this.tickTimer.unref();
    }
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
   * Sends engine events to the pacer, then asks the AI narrator for flavour
   * on the key moments among them.
   * @param {Array<object>} [events]
   */
  _dispatch(events) {
    if (!events || events.length === 0) return;
    for (const ev of events) {
      this.pacer.push(ev);
    }
    this._narrate(events);
  }

  /**
   * Narrates room entries, monster appearances and fight endings with the AI.
   * The deterministic template lines have already been queued; one narrated line
   * per moment follows them once the AI answers. Does nothing without AI_URL.
   * @param {Array<object>} events
   */
  _narrate(events) {
    if (!this.narrator?.aiClient?.isConfigured) return;

    const adventure = this.engine.adventure;
    const room = adventure.currentRoom;
    const totalRooms = adventure.dungeon?.totalRooms;
    this.narrator.setTheme(adventure.theme);

    for (const ev of events) {
      if (ev.kind !== 'game' || !room) continue;

      let pending = null;
      if (ev.type === 'room_entered') {
        // In a monster or boss room the creature is the moment worth narrating
        pending = room.monster && (room.type === 'monster' || room.type === 'boss')
          ? this.narrator.narrateMonsterIntro({ ...room.monster }, { type: room.type, name: room.name })
          : this.narrator.narrateRoom({ ...room }, { totalRooms });
      } else if (ev.type === 'monster_defeated' || ev.type === 'party_wiped') {
        const monster = room.monster ? { ...room.monster } : { name: ev.monster };
        pending = this.narrator.narrateCombatRecap({
          monster,
          events,
          monsterDefeated: ev.type === 'monster_defeated',
          partyWiped: ev.type === 'party_wiped'
        });
      }

      if (pending) {
        pending
          .then(lines => {
            if (this._destroyed || !lines || lines.length === 0) return;
            this.pacer.push(createSayEvent(lines[0]));
          })
          .catch(() => {});
      }
    }
  }

  /**
   * Handles incoming chat message from bot.
   * Processes through engine and enqueues emitted events into pacer.
   * @param {object} message
   * @returns {Promise<void>}
   */
  async handleMessage(message) {
    const res = await this.engine.handleMessageAsync(message);
    this._dispatch(res.events);
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
    this._dispatch(events);
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
      if (ENDED_STATUSES.has(currentStatus)) {
        // The last adventure is over: start a fresh one (level, XP and gold live in the DB)
        this.engine.resetAdventure();
      }
      if (this.engine.status === 'idle') {
        this._dispatch(this.engine.startThemeVote());
        return { changed: true, status: this.engine.status };
      }
      return { changed: false, status: currentStatus };
    }

    if (state === 'ended') {
      if (currentStatus !== 'idle' && !ENDED_STATUSES.has(currentStatus)) {
        this._dispatch(this.engine.abandonAdventure('stream_ended'));
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
    this._destroyed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
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
