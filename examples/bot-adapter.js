// Chatacombs minimal bot adapter: chat lines in, `say` lines out. Node 18+, no dependencies.
// Configure with the same names as docker-compose.yml / .env:
//   CHATACOMBS_URL (default http://localhost:8080), API_KEY, CHANNEL
const BASE = (process.env.CHATACOMBS_URL || 'http://localhost:8080').replace(/\/+$/, '');
const API_KEY = process.env.API_KEY || 'change-me-bot-secret';
const CHANNEL = process.env.CHANNEL || 'mychannel';
const api = `${BASE}/api/v1/channels/${encodeURIComponent(CHANNEL)}`;
const auth = { Authorization: `Bearer ${API_KEY}` };

// 1. Swap for your bot's real chat call (tmi.js client.say, ComfyJS.Say, ...)
const sayInChat = (text) => console.log(`[bot] ${text}`);

// 2. Swap for your bot's effects. Naming the moment is enough to start.
const EFFECTS = { boss_appears: 'thunderstorm', dungeon_cleared: 'tada', player_healed: 'potions', party_wiped: 'gloom' };

// 3. Call from your bot's chat handler for EVERY message (unknown commands are ignored).
export const forwardChat = (user, text, { displayName = user, isBroadcaster = false } = {}) =>
  fetch(`${api}/messages`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, displayName, text, isBroadcaster })
  });

// 4. Call when the stream goes live ('started') and when it ends ('ended').
export const setStream = (state) =>
  fetch(`${api}/stream`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) });

// 5. Listen to the SSE stream forever, reconnecting if it drops.
export async function listen() {
  for (;;) {
    try {
      const res = await fetch(`${api}/events`, { headers: auth });
      if (!res.ok) throw new Error(`events: HTTP ${res.status}`);
      let buf = '';
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buf += chunk.replace(/\r/g, '');
        for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
          const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue; // ": keep-alive" comments
          const event = JSON.parse(data);
          if (event.kind === 'say') sayInChat(event.text);
          else if (EFFECTS[event.type]) console.log(`[effect] ${EFFECTS[event.type]} (${event.type})`);
        }
      }
    } catch (err) {
      console.error(`[adapter] ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---- Demo only: type chat as "user: text" in the terminal; /start and /end toggle the stream ----
if (process.argv[1]?.endsWith('bot-adapter.js')) {
  listen();
  const { createInterface } = await import('node:readline');
  console.log(`Adapter on ${api}. Type "/start", then chat like "alice: !vote 1".`);
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === '/start' || line === '/end') await setStream(line === '/start' ? 'started' : 'ended');
    else if (line.includes(':')) await forwardChat(line.split(':')[0].trim(), line.slice(line.indexOf(':') + 1).trim());
  }
}
