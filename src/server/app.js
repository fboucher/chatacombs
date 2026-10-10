import express from 'express';
import { requireApiKey, requireOverlayKey } from './auth.js';
import { ChannelRuntime } from './runtime.js';
import { renderOverlayPage } from './overlayPage.js';

/**
 * Creates the Chatacombs Express application.
 * @param {object} [options={}]
 * @param {string} [options.apiKey]
 * @param {string} [options.overlayKey]
 * @param {import('better-sqlite3').Database} [options.db]
 * @param {Map<string, ChannelRuntime>} [options.runtimes]
 * @param {() => number} [options.clock]
 * @param {() => number} [options.rng]
 * @param {number} [options.pacerIntervalMs]
 * @returns {import('express').Express}
 */
export function createApp(options = {}) {
  const app = express();

  const apiKey = options.apiKey || process.env.API_KEY;
  const overlayKey = options.overlayKey || process.env.OVERLAY_KEY;
  const db = options.db || null;
  const runtimes = options.runtimes || new Map();
  const clock = options.clock;
  const rng = options.rng;
  const pacerIntervalMs = options.pacerIntervalMs;

  app.locals.runtimes = runtimes;

  // Middleware: JSON parser
  app.use(express.json());

  // Middleware: CORS headers
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  /**
   * Helper to get or create ChannelRuntime
   * @param {string} channel
   * @returns {ChannelRuntime}
   */
  function getRuntime(channel) {
    const key = channel.toLowerCase();
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = new ChannelRuntime({
        channel: key,
        db,
        clock,
        rng,
        pacerIntervalMs
      });
      runtimes.set(key, runtime);
    }
    return runtime;
  }

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'chatacombs' });
  });

  // REST API: POST /api/v1/channels/:channel/messages
  app.post('/api/v1/channels/:channel/messages', requireApiKey(apiKey), (req, res) => {
    const channel = req.params.channel;
    const body = req.body;

    if (!body || typeof body.text !== 'string' || !body.user) {
      return res.status(400).json({ error: 'Invalid message payload. Required fields: user, text' });
    }

    const runtime = getRuntime(channel);

    // Process asynchronously, reply 202 Accepted immediately
    runtime.handleMessage({
      user: body.user,
      displayName: body.displayName || body.user,
      text: body.text,
      isBroadcaster: Boolean(body.isBroadcaster)
    }).catch(err => {
      console.error(`Error processing message in ${channel}:`, err);
    });

    res.status(202).json({ status: 'accepted' });
  });

  // REST API: POST /api/v1/channels/:channel/stream
  app.post('/api/v1/channels/:channel/stream', requireApiKey(apiKey), (req, res) => {
    const channel = req.params.channel;
    const body = req.body;

    if (!body || (body.state !== 'started' && body.state !== 'ended')) {
      return res.status(400).json({ error: 'Invalid stream state. Expected: "started" or "ended"' });
    }

    const runtime = getRuntime(channel);
    const result = runtime.setStreamState(body.state);

    res.json({ status: 'ok', state: body.state, ...result });
  });

  // REST API: GET /api/v1/channels/:channel/state
  app.get('/api/v1/channels/:channel/state', requireApiKey(apiKey), (req, res) => {
    const channel = req.params.channel;
    const runtime = getRuntime(channel);
    const state = runtime.getState();

    res.json(state);
  });

  // SSE Stream: GET /api/v1/channels/:channel/events (Bot auth via Bearer token)
  app.get('/api/v1/channels/:channel/events', requireApiKey(apiKey), (req, res) => {
    const channel = req.params.channel;
    const runtime = getRuntime(channel);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    runtime.addClient(res);
  });

  // Overlay Web / Shell: GET /overlay/:channel (Query key auth: ?key=<OVERLAY_KEY>)
  app.get('/overlay/:channel', requireOverlayKey(overlayKey), (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderOverlayPage());
  });

  // Overlay State Snapshot: GET /overlay/:channel/state (Query key auth: ?key=<OVERLAY_KEY>)
  app.get('/overlay/:channel/state', requireOverlayKey(overlayKey), (req, res) => {
    const channel = req.params.channel;
    const runtime = getRuntime(channel);

    res.json(runtime.getOverlayState());
  });

  // Overlay SSE Stream: GET /overlay/:channel/events (Query key auth: ?key=<OVERLAY_KEY>)
  app.get('/overlay/:channel/events', requireOverlayKey(overlayKey), (req, res) => {
    const channel = req.params.channel;
    const runtime = getRuntime(channel);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    runtime.addOverlayClient(res);
  });

  // Central error handler
  app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
  });

  return app;
}
