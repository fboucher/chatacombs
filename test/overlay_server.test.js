import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { buildOverlayPage, bundleScripts, listBotImages, resolveBotImage } from '../src/server/overlayPage.js';
import { buildOverlayView } from '../src/server/overlayView.js';

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

/**
 * Opens an SSE stream and collects parsed frames.
 */
async function openStream(url, headers = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const frames = [];
  const waiters = [];
  let buffer = '';

  (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frame = { event: null, data: null };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) frame.event = line.slice(7);
            if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
          }
          if (frame.event) {
            frames.push(frame);
            for (const w of [...waiters]) w();
          }
        }
      }
    } catch (_) {
      // aborted
    }
  })();

  function waitFor(predicate, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = frames.find(predicate);
        if (found) {
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(check), 1);
        reject(new Error('Timed out waiting for SSE frame'));
      }, timeoutMs);
      waiters.push(check);
      check();
    });
  }

  return { res, frames, waitFor, close: () => controller.abort() };
}

function post(server, path, body) {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body)
  });
}

test('overlay page - single self-contained HTML with no external requests', async () => {
  const app = createApp({ apiKey: API_KEY, overlayKey: OVERLAY_KEY });
  const server = await startTestServer(app);

  try {
    assert.equal((await fetch(`${server.url}/overlay/chan`)).status, 401);
    assert.equal((await fetch(`${server.url}/overlay/chan?key=nope`)).status, 401);

    const res = await fetch(`${server.url}/overlay/chan?key=${OVERLAY_KEY}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();

    // Everything inline: no URLs, no linked/sourced assets, no leftover placeholders
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /<link\b/i);
    assert.doesNotMatch(html, /\ssrc=/i);
    assert.doesNotMatch(html, /url\(/i);
    assert.doesNotMatch(html, /@import/i);
    assert.doesNotMatch(html, /__OVERLAY_(CSS|JS)__/);

    // The default bot picture is inlined as a PNG data URI, labelled with the bot name
    assert.match(html, /data-picture="data:image\/png;base64,iVBOR/);
    assert.match(html, /id="bot-name" class="bot-name">@[^<]+</);
    assert.doesNotMatch(html, /__BOT_(NAME|IMG)__/);

    // The 3 ribbon sections, bot card, takeover and toast layers are present
    for (const id of ['bot-card', 'bot-img', 'ribbon', 'room-number', 'theme-badge', 'progress-dots', 'encounter', 'enc-hp-fill', 'party-count', 'ko-count', 'timer', 'takeover', 'toasts']) {
      assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }

    // Inline script parses and has no module syntax left
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(script));
    assert.doesNotMatch(script, /^\s*(import|export)\s/m);
  } finally {
    await server.close();
  }
});

test('overlay page - ?bot= picks any chatacombs-bot-<name> picture, skeleton otherwise', async () => {
  const images = listBotImages();
  for (const name of ['skeleton', 'mummy', 'cyberpunk', 'pirate', 'retro']) {
    assert.equal(images.get(name), `chatacombs-bot-${name}.png`, name);
  }
  const picture = html => html.match(/data-picture="([^"]+)"/)[1];
  const skeleton = picture(buildOverlayPage({ bot: 'skeleton' }));
  assert.notEqual(picture(buildOverlayPage({ bot: 'Pirate' })), skeleton);
  assert.equal(picture(buildOverlayPage({ bot: 'nope' })), skeleton);
  assert.equal(picture(buildOverlayPage({ bot: '../../index' })), skeleton);
  assert.equal(picture(buildOverlayPage({})), skeleton);

  // A dropped-in file is picked up by its name; PNG wins over the SVG source
  const dir = mkdtempSync(path.join(tmpdir(), 'bots-'));
  for (const file of ['chatacombs-bot-ninja.svg', 'chatacombs-bot-ninja.png', 'chatacombs-bot-robot.webp', 'notes.txt', 'bot-x.png']) {
    writeFileSync(path.join(dir, file), '');
  }
  const custom = listBotImages(dir);
  assert.deepEqual([...custom.entries()].sort(), [['ninja', 'chatacombs-bot-ninja.png'], ['robot', 'chatacombs-bot-robot.webp']]);
  assert.deepEqual(resolveBotImage('ROBOT', custom), { name: 'robot', file: 'chatacombs-bot-robot.webp' });
  assert.equal(resolveBotImage('ghost', custom), null);
});

test('overlay page - bot label follows BOT_NAME and is escaped', () => {
  assert.match(buildOverlayPage({ botName: 'Bones' }), /class="bot-name">@Bones</);
  assert.match(buildOverlayPage({ botName: '<b>x</b>' }), /class="bot-name">@&lt;b&gt;x&lt;\/b&gt;</);
});

test('bundleScripts - strips module syntax and auto-starts in a browser', () => {
  const out = bundleScripts([
    "export function a() { return 1; }\nexport const B = 2;",
    "import { a } from './a.js';\nexport function startOverlay() { return a() + B; }"
  ]);
  assert.doesNotMatch(out, /\bimport\b|\bexport\b/);
  assert.match(out, /startOverlay\(window\)/);
  assert.doesNotThrow(() => new Function(out)());
});

test('overlay page - built page matches what the server serves', async () => {
  const app = createApp({ apiKey: API_KEY, overlayKey: OVERLAY_KEY });
  const server = await startTestServer(app);
  try {
    const html = await (await fetch(`${server.url}/overlay/x?key=${OVERLAY_KEY}`)).text();
    assert.equal(html, buildOverlayPage());
  } finally {
    await server.close();
  }
});

test('overlay state - idle channel returns an empty, JSON-safe snapshot', async () => {
  const app = createApp({ apiKey: API_KEY, overlayKey: OVERLAY_KEY });
  const server = await startTestServer(app);
  try {
    const view = await (await fetch(`${server.url}/overlay/quiet/state?key=${OVERLAY_KEY}`)).json();
    assert.equal(view.status, 'idle');
    assert.equal(view.theme, null);
    assert.equal(view.currentRoom, null);
    assert.equal(view.encounter, null);
    assert.equal(view.timer, null);
    assert.deepEqual(view.party, []);
    assert.equal(view.partyCount, 0);
    assert.equal(view.koCount, 0);
    assert.deepEqual(view.progress, { roomNumber: 0, totalRooms: 0 });
  } finally {
    await server.close();
  }
});

test('overlay stream - snapshot on connect, live game events and re-synced state through an adventure start', async () => {
  let now = 1_000_000;
  const app = createApp({
    apiKey: API_KEY,
    overlayKey: OVERLAY_KEY,
    clock: () => now,
    rng: () => 0.42,
    pacerIntervalMs: 5
  });
  const server = await startTestServer(app);

  const overlay = await openStream(`${server.url}/overlay/live/events?key=${OVERLAY_KEY}`);
  const bot = await openStream(`${server.url}/api/v1/channels/live/events`, { Authorization: `Bearer ${API_KEY}` });

  try {
    assert.equal(overlay.res.status, 200);

    // Connect -> immediate snapshot
    const first = await overlay.waitFor(f => f.event === 'overlay_state');
    assert.equal(first.data.status, 'idle');

    // Stream start -> theme vote timer appears in a fresh snapshot
    await post(server, '/api/v1/channels/live/stream', { state: 'started' });
    const voting = await overlay.waitFor(f => f.event === 'overlay_state' && f.data.status === 'voting');
    assert.equal(voting.data.timer.kind, 'theme_vote');
    assert.equal(voting.data.timer.remainingMs, 60000);
    assert.equal(voting.data.timer.tallies.length, 3);

    // Chatters vote -> party and tallies update
    await post(server, '/api/v1/channels/live/messages', { user: 'alice', text: '!vote 1' });
    await post(server, '/api/v1/channels/live/messages', { user: 'bob', text: '!vote 1' });
    const voted = await overlay.waitFor(f => f.event === 'overlay_state' && f.data.partyCount === 2);
    assert.equal(voted.data.timer.tallies[0].votes, 2);

    // Vote window elapses -> adventure starts
    now += 61_000;
    await post(server, '/api/v1/channels/live/messages', { user: 'alice', text: 'let us go' });

    const started = await overlay.waitFor(f => f.event === 'adventure_started');
    assert.ok(started.data.totalRooms > 0);
    const entered = await overlay.waitFor(f => f.event === 'room_entered');
    assert.equal(entered.data.roomNumber, 1);

    const active = await overlay.waitFor(f => f.event === 'overlay_state' && f.data.status === 'active');
    assert.equal(active.data.progress.roomNumber, 1);
    assert.equal(active.data.progress.totalRooms, started.data.totalRooms);
    assert.equal(active.data.theme, started.data.theme);

    // Overlays never receive chat lines; bots never receive overlay snapshots
    assert.ok(overlay.frames.every(f => f.event !== 'say'));
    await bot.waitFor(f => f.event === 'adventure_started');
    assert.ok(bot.frames.every(f => f.event !== 'overlay_state'));

    // Cold boot snapshot matches the live one and leaks no future rooms
    const view = await (await fetch(`${server.url}/overlay/live/state?key=${OVERLAY_KEY}`)).json();
    assert.equal(view.status, 'active');
    assert.equal(view.progress.roomNumber, 1);
    assert.equal(view.partyCount, 2);
    assert.ok(!('dungeon' in view));
    assert.ok(!JSON.stringify(view).includes('"rooms"'));

    // Reconnect -> a new snapshot re-syncs immediately
    overlay.close();
    const again = await openStream(`${server.url}/overlay/live/events?key=${OVERLAY_KEY}`);
    const resync = await again.waitFor(f => f.event === 'overlay_state');
    assert.equal(resync.data.status, 'active');
    assert.equal(resync.data.progress.roomNumber, 1);
    again.close();
  } finally {
    overlay.close();
    bot.close();
    for (const runtime of app.locals.runtimes.values()) runtime.destroy();
    await server.close();
  }
});

test('buildOverlayView - encounter, KO count and combat timer', () => {
  const party = [
    { username: 'a', displayName: 'A', hp: 20, maxHp: 20, isKnockedOut: false },
    { username: 'b', displayName: 'B', hp: 0, maxHp: 20, isKnockedOut: true }
  ];
  const view = buildOverlayView({
    status: 'active',
    theme: 'haunted manor',
    currentRoom: {
      roomNumber: 5,
      type: 'boss',
      name: 'Throne',
      cleared: false,
      exploration: { searched: false },
      monster: { name: 'Lich King', hp: 40, maxHp: 90, defense: 15 }
    },
    dungeon: { totalRooms: 5, rooms: [] },
    themeVote: null,
    exitVote: null,
    combat: { round: 3, roundDurationMs: 60000, elapsedMs: 15000 },
    outcomeSnapshot: null
  }, party);

  assert.deepEqual(view.encounter, { name: 'Lich King', hp: 40, maxHp: 90, isBoss: true, defeated: false });
  assert.equal(view.partyCount, 2);
  assert.equal(view.koCount, 1);
  assert.deepEqual(view.timer, { kind: 'combat_round', label: 'Round 3', remainingMs: 45000, durationMs: 60000 });
  assert.deepEqual(view.progress, { roomNumber: 5, totalRooms: 5 });
});

test('buildOverlayView - exit vote tallies follow vote order', () => {
  const view = buildOverlayView({
    status: 'active',
    theme: 't',
    currentRoom: { roomNumber: 2, type: 'empty', name: 'Hall', exploration: { searched: true } },
    dungeon: { totalRooms: 6 },
    exitVote: {
      durationMs: 60000,
      elapsedMs: 50000,
      votes: new Map([['a', 'east'], ['b', 'west'], ['c', 'east']]),
      voteOrder: ['east', 'west']
    }
  }, []);

  assert.equal(view.timer.kind, 'exit_vote');
  assert.equal(view.timer.remainingMs, 10000);
  assert.deepEqual(view.timer.tallies, [{ choice: 'east', votes: 2 }, { choice: 'west', votes: 1 }]);
  assert.equal(view.encounter, null);
  assert.equal(view.currentRoom.searched, true);
});
