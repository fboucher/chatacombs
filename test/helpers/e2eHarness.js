import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createApp } from '../../src/server/app.js';
import { createDatabase, runMigrations } from '../../src/db/database.js';
import { createRng } from '../../src/engine/dice.js';

export class EventCollector {
  constructor() {
    this.events = [];
    this.bus = new EventEmitter();
  }

  push(event) {
    this.events.push(event);
    this.bus.emit('event', event);
    if (event.kind === 'say') {
      this.bus.emit('say', event);
    } else if (event.type) {
      this.bus.emit(`game:${event.type}`, event);
    }
  }

  get gameEvents() {
    return this.events.filter(e => e.kind !== 'say');
  }

  get sayEvents() {
    return this.events.filter(e => e.kind === 'say');
  }

  findEvent(predicateOrType) {
    if (typeof predicateOrType === 'string') {
      return this.events.find(e => e.type === predicateOrType || (predicateOrType === 'say' && e.kind === 'say'));
    }
    return this.events.find(predicateOrType);
  }

  waitForEvent(predicateOrType, timeoutMs = 2000) {
    const existing = this.findEvent(predicateOrType);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for event: ${typeof predicateOrType === 'string' ? predicateOrType : 'predicate'}`));
      }, timeoutMs);

      const onEvent = (event) => {
        let match = false;
        if (typeof predicateOrType === 'string') {
          match = event.type === predicateOrType || (predicateOrType === 'say' && event.kind === 'say');
        } else {
          match = Boolean(predicateOrType(event));
        }

        if (match) {
          cleanup();
          resolve(event);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.bus.off('event', onEvent);
      };

      this.bus.on('event', onEvent);
    });
  }
}

export async function createTestHarness(options = {}) {
  let mockTime = options.initialTime || 1000000;
  const clock = () => mockTime;
  const rng = options.rng || (options.seed ? createRng(options.seed) : Math.random);

  const db = options.db || createDatabase(':memory:');
  runMigrations(db);

  const apiKey = options.apiKey || 'test-api-key';
  const overlayKey = options.overlayKey || 'test-overlay-key';
  const pacerIntervalMs = options.pacerIntervalMs ?? 0; // Immediate for fast deterministic tests
  const channel = (options.channel || 'test').toLowerCase();

  const app = createApp({
    apiKey,
    overlayKey,
    db,
    clock,
    rng,
    pacerIntervalMs,
    engineOptions: options.engineOptions || {}
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;

  const activeSseConnections = [];

  const harness = {
    server,
    serverUrl,
    apiKey,
    overlayKey,
    channel,
    db,
    clock,
    rng,

    get currentTime() {
      return mockTime;
    },

    advanceTime(ms) {
      mockTime += ms;
      return mockTime;
    },

    tick(targetChannel = channel, deltaMs = 0) {
      if (deltaMs > 0) {
        mockTime += deltaMs;
      }
      const runtime = app.locals.runtimes.get(targetChannel.toLowerCase());
      if (runtime) {
        return runtime.tick(mockTime);
      }
      return [];
    },

    getRuntime(targetChannel = channel) {
      return app.locals.runtimes.get(targetChannel.toLowerCase());
    },

    async postMessage(targetChannel, { user, text, displayName, isBroadcaster = false }) {
      const ch = (targetChannel || channel).toLowerCase();
      const res = await fetch(`${serverUrl}/api/v1/channels/${ch}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          user,
          displayName: displayName || user,
          text,
          isBroadcaster
        })
      });
      return res;
    },

    async setStreamState(targetChannel, state) {
      const ch = (targetChannel || channel).toLowerCase();
      const res = await fetch(`${serverUrl}/api/v1/channels/${ch}/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ state })
      });
      return await res.json();
    },

    async getState(targetChannel) {
      const ch = (targetChannel || channel).toLowerCase();
      const res = await fetch(`${serverUrl}/api/v1/channels/${ch}/state`, {
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      });
      return await res.json();
    },

    async connectSse(targetChannel) {
      const ch = (targetChannel || channel).toLowerCase();
      const collector = new EventCollector();
      const controller = new AbortController();
      activeSseConnections.push(controller);

      const response = await fetch(`${serverUrl}/api/v1/channels/${ch}/events`, {
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`SSE stream failed: HTTP ${response.status}`);
      }

      // Read stream asynchronously in background
      (async () => {
        try {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            let currentData = '';
            for (const line of lines) {
              if (line.startsWith('data:')) {
                currentData = line.slice(5).trim();
              } else if (line.trim() === '' && currentData) {
                try {
                  const parsed = JSON.parse(currentData);
                  collector.push(parsed);
                } catch (_) {}
                currentData = '';
              }
            }
          }
        } catch (err) {
          if (err.name !== 'AbortError') {
            // Stream closed or error
          }
        }
      })();

      return {
        collector,
        close: () => controller.abort()
      };
    },

    async close() {
      for (const ctrl of activeSseConnections) {
        try { ctrl.abort(); } catch (_) {}
      }

      for (const runtime of app.locals.runtimes.values()) {
        try { runtime.destroy(); } catch (_) {}
      }

      await new Promise((resolve) => server.close(resolve));
      try { db.close(); } catch (_) {}
    }
  };

  return harness;
}
