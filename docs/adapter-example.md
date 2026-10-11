# Connect any bot to Chatacombs

A bot needs to do three things: forward chat in, post `say` lines out, and say when the stream starts and ends. The Node.js adapter below does all of it in under 40 lines of code (50 with comments), with no dependencies (Node 18+). A runnable copy with a small "type fake chat in the terminal" demo is in [`examples/bot-adapter.js`](../examples/bot-adapter.js).

## Configure

The adapter reads the same names as [`docker-compose.yml`](../docker-compose.yml) and `.env`:

| Variable | What to set | Default |
| --- | --- | --- |
| `CHATACOMBS_URL` | Where the container answers | `http://localhost:8080` |
| `API_KEY` | The same `API_KEY` the container was started with | `change-me-bot-secret` (the compose sample) |
| `CHANNEL` | Your Twitch channel name | `mychannel` |

## The adapter (Node.js)

```js
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
```

Plug it into your bot:

- Call `forwardChat(user, text)` from your chat handler for **every** message. Unknown commands are ignored, so there is no need to filter.
- Replace `sayInChat` with your bot's send call (`client.say(channel, text)` in tmi.js, `ComfyJS.Say(text)` in ComfyJS).
- Call `setStream('started')` when you go live and `setStream('ended')` when you stop.
- Call `listen()` once at startup.
- Map more `game` types in `EFFECTS` if your bot has effects: `adventure_started`, `room_entered`, `dice_roll`, `player_healed`, `rare_loot`, `boss_appears`, `monster_defeated`, `player_knocked_out`, `party_wiped`, `dungeon_cleared`.

## Try it without a bot

With the container running (see the [streamer guide](streamers.md#1-run-the-container)):

```bash
API_KEY=change-me-bot-secret CHANNEL=mychannel node examples/bot-adapter.js
```

Then type into the terminal as if you were chat:

```
/start
alice: !vote 1
bob: !theme haunted house
alice: !explore
bob: @CB what does this room smell like?
```

`[bot] ...` lines are what your bot would post to Twitch, and `[effect] ...` lines are the game moments it could react to. Open `http://localhost:8080/overlay/mychannel?key=<OVERLAY_KEY>` in a browser to watch the overlay at the same time. On Windows PowerShell set the variables first: `$env:API_KEY="change-me-bot-secret"; $env:CHANNEL="mychannel"; node examples/bot-adapter.js`.

## Python alternative

The same wire with only the standard library:

```python
import json, os, threading, urllib.request

BASE = os.environ.get("CHATACOMBS_URL", "http://localhost:8080").rstrip("/")
API = f"{BASE}/api/v1/channels/{os.environ.get('CHANNEL', 'mychannel')}"
AUTH = {"Authorization": f"Bearer {os.environ.get('API_KEY', 'change-me-bot-secret')}"}

def post(path, body):
    req = urllib.request.Request(f"{API}/{path}", json.dumps(body).encode(),
                                 {**AUTH, "Content-Type": "application/json"})
    urllib.request.urlopen(req).close()

def forward_chat(user, text):  # call for every chat message
    post("messages", {"user": user, "displayName": user, "text": text})

def set_stream(state):  # "started" or "ended"
    post("stream", {"state": state})

def listen(say):  # say(text) posts to your chat
    with urllib.request.urlopen(urllib.request.Request(f"{API}/events", headers=AUTH)) as res:
        for raw in res:
            line = raw.decode().strip()
            if line.startswith("data:"):
                event = json.loads(line[5:])
                if event.get("kind") == "say":
                    say(event["text"])

threading.Thread(target=listen, args=(print,), daemon=True).start()
```

Wrap `listen` in a retry loop for production so it reconnects when the stream drops.

## Webhook-only bots

Bots that can only send HTTP requests (Streamer.bot, Firebot, Mix It Up and similar) can still forward chat and stream start/end with a plain `POST` and the `Authorization: Bearer <API_KEY>` header, using the same JSON bodies as above. To post replies they also need something that reads the `/events` stream, so run the adapter above next to them and replace `sayInChat` with a call to your bot's "send message" webhook or API.
