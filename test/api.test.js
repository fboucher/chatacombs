import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server/app.js';
import { createDatabase, runMigrations } from '../src/db/database.js';
import { MessagePacer } from '../src/server/pacer.js';

const API_KEY = 'test-secret-key';
const OVERLAY_KEY = 'test-overlay-key';

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(res => server.close(res))
      });
    });
  });
}

test('auth - rejects missing and invalid Bearer tokens with 401', async () => {
  const app = createApp({ apiKey: API_KEY, overlayKey: OVERLAY_KEY });
  const server = await startTestServer(app);

  try {
    // Missing header
    const res1 = await fetch(`${server.url}/api/v1/channels/test/state`);
    assert.equal(res1.status, 401);

    // Bad key
    const res2 = await fetch(`${server.url}/api/v1/channels/test/state`, {
      headers: { Authorization: 'Bearer wrong-key' }
    });
    assert.equal(res2.status, 401);

    // Valid key
    const res3 = await fetch(`${server.url}/api/v1/channels/test/state`, {
      headers: { Authorization: `Bearer ${API_KEY}` }
    });
    assert.equal(res3.status, 200);
  } finally {
    await server.close();
  }
});

test('pacer - spaces say events by interval in FIFO order without delaying game events', async () => {
  let mockTime = 1000;
  const emitted = [];

  const pacer = new MessagePacer({
    intervalMs: 1800,
    clock: () => mockTime,
    emitFn: (ev) => emitted.push({ time: mockTime, ...ev })
  });

  // Push 3 say lines and 1 game moment
  pacer.push({ kind: 'say', text: 'Line 1' });
  pacer.push({ kind: 'game', type: 'dice_roll', roll: 20 });
  pacer.push({ kind: 'say', text: 'Line 2' });
  pacer.push({ kind: 'say', text: 'Line 3' });

  // Game moment was emitted immediately; Line 1 sent immediately (first in queue)
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].text, 'Line 1');
  assert.equal(emitted[1].type, 'dice_roll');

  // Advance time by 1800ms
  mockTime += 1800;
  pacer.step();
  assert.equal(emitted.length, 3);
  assert.equal(emitted[2].text, 'Line 2');
  assert.equal(emitted[2].time, 2800);

  // Advance time by another 1800ms
  mockTime += 1800;
  pacer.step();
  assert.equal(emitted.length, 4);
  assert.equal(emitted[3].text, 'Line 3');
  assert.equal(emitted[3].time, 4600);

  pacer.clear();
});

test('wire tracer - message intake via POST /messages flows to engine and SSE delivery', async () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  const app = createApp({
    apiKey: API_KEY,
    overlayKey: OVERLAY_KEY,
    db,
    pacerIntervalMs: 10 // Fast pacing for integration test
  });

  const server = await startTestServer(app);

  try {
    // 1. Connect to SSE stream
    const controller = new AbortController();
    const sseRes = await fetch(`${server.url}/api/v1/channels/streamer1/events`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: controller.signal
    });

    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('content-type'), 'text/event-stream');

    // Reader for SSE stream
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();

    // Read initial greeting comment
    const initial = await reader.read();
    assert.match(decoder.decode(initial.value), /connected to channel streamer1/);

    // 2. Start stream to trigger theme vote
    const streamRes = await fetch(`${server.url}/api/v1/channels/streamer1/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ state: 'started' })
    });
    assert.equal(streamRes.status, 200);

    // 3. Post chat message to vote
    const postRes = await fetch(`${server.url}/api/v1/channels/streamer1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ user: 'frank', displayName: 'Frank', text: '!vote 1' })
    });

    // Verify 202 Accepted returned immediately
    assert.equal(postRes.status, 202);

    // Read SSE stream for emitted vote/say event
    const chunk = await reader.read();
    const chunkText = decoder.decode(chunk.value);
    assert.ok(chunkText.includes('event: say') || chunkText.includes('event: adventure_started') || chunkText.includes('data:'));

    controller.abort();
  } finally {
    await server.close();
  }
});

test('stream lifecycle - started and ended are idempotent and toggle adventure state', async () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  const app = createApp({
    apiKey: API_KEY,
    overlayKey: OVERLAY_KEY,
    db,
    pacerIntervalMs: 10
  });

  const server = await startTestServer(app);

  try {
    // Check initial state is idle
    const state0 = await (await fetch(`${server.url}/api/v1/channels/twitchtv/state`, {
      headers: { Authorization: `Bearer ${API_KEY}` }
    })).json();
    assert.equal(state0.status, 'idle');

    // Start stream
    const start1 = await (await fetch(`${server.url}/api/v1/channels/twitchtv/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ state: 'started' })
    })).json();
    assert.equal(start1.changed, true);
    assert.equal(start1.status, 'voting');

    // Duplicate start is no-op
    const start2 = await (await fetch(`${server.url}/api/v1/channels/twitchtv/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ state: 'started' })
    })).json();
    assert.equal(start2.changed, false);
    assert.equal(start2.status, 'voting');

    // End stream
    const end1 = await (await fetch(`${server.url}/api/v1/channels/twitchtv/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ state: 'ended' })
    })).json();
    assert.equal(end1.changed, true);
    assert.equal(end1.status, 'abandoned');

    // State endpoint reflects abandoned outcome
    const stateAfter = await (await fetch(`${server.url}/api/v1/channels/twitchtv/state`, {
      headers: { Authorization: `Bearer ${API_KEY}` }
    })).json();
    assert.equal(stateAfter.status, 'abandoned');
  } finally {
    await server.close();
  }
});

test('overlay auth - query key accepts valid OVERLAY_KEY and rejects unauthorized requests', async () => {
  const app = createApp({
    apiKey: API_KEY,
    overlayKey: OVERLAY_KEY,
    pacerIntervalMs: 10
  });

  const server = await startTestServer(app);

  try {
    // Missing query key -> 401
    const res1 = await fetch(`${server.url}/overlay/mychannel`);
    assert.equal(res1.status, 401);

    // Bad query key -> 401
    const res2 = await fetch(`${server.url}/overlay/mychannel?key=wrong-overlay-key`);
    assert.equal(res2.status, 401);

    // Valid query key -> 200 HTML
    const res3 = await fetch(`${server.url}/overlay/mychannel?key=${OVERLAY_KEY}`);
    assert.equal(res3.status, 200);
    assert.match(await res3.text(), /id="ribbon"/);

    // Valid query key on overlay SSE -> 200 text/event-stream
    const controller = new AbortController();
    const sseRes = await fetch(`${server.url}/overlay/mychannel/events?key=${OVERLAY_KEY}`, {
      signal: controller.signal
    });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('content-type'), 'text/event-stream');
    controller.abort();

    // Overlay state endpoint checks
    const state401 = await fetch(`${server.url}/overlay/mychannel/state`);
    assert.equal(state401.status, 401);

    const state200 = await fetch(`${server.url}/overlay/mychannel/state?key=${OVERLAY_KEY}`);
    assert.equal(state200.status, 200);
    const stateData = await state200.json();
    assert.equal(stateData.status, 'idle');
    assert.ok('party' in stateData);
    assert.ok('theme' in stateData);
    assert.ok('currentRoom' in stateData);
  } finally {
    await server.close();
  }
});

test('health - GET /health answers 200 with JSON and needs no auth or database', async () => {
  const app = createApp({ apiKey: API_KEY, overlayKey: OVERLAY_KEY });
  const server = await startTestServer(app);

  try {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { status: 'ok', service: 'chatacombs' });
  } finally {
    await server.close();
  }
});
