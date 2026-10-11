# Chatacombs

A chat-driven dungeon crawler that runs in your Twitch chat on its own while you stream. Every active viewer is in the party, your existing chat bot acts as the dungeon master, and an OBS overlay shows the big moments on screen.

Chatacombs is a small standalone service (one Docker container). Your bot forwards chat to it and posts back whatever it says. The game logic, dice, HP and loot all live in the container, and player progress is stored in SQLite on a volume.

```
Twitch chat ──> your bot ──POST /messages──> Chatacombs ──SSE say/game──> your bot ──> Twitch chat
                                                  │
                                                  └──/overlay/{channel}──> OBS Browser Source
```

## Quick Start for Streamers

You need Docker. Pick one of the two paths below, then check that the service is up.

### Option A: `docker compose` (recommended)

```bash
git clone https://github.com/fboucher/chatacombs.git
cd chatacombs
cp .env.example .env        # then edit API_KEY and OVERLAY_KEY in .env
docker compose up -d --build
```

[`docker-compose.yml`](docker-compose.yml) publishes port 8080, stores the database on the named volume `dungeon-data`, and restarts the container after a reboot (`restart: unless-stopped`). Player levels, XP and gold survive `docker compose down` / `up`.

### Option B: plain `docker run`

```bash
docker build -t chatacombs .
docker run -d --name chatacombs --restart unless-stopped \
  -p 8080:8080 \
  -v dungeon-data:/data \
  -e API_KEY=change-me-bot-secret \
  -e OVERLAY_KEY=change-me-overlay-secret \
  chatacombs
```

### Check it is running

```bash
curl http://localhost:8080/health
# {"status":"ok","service":"chatacombs"}
```

`/health` needs no key, so you can point an uptime monitor at it. The image also has a Docker `HEALTHCHECK`, so `docker ps` shows `(healthy)` once it is up.

## OBS Browser Source setup

1. In OBS, add a **Browser** source.
2. Set the URL (replace the placeholders with your Twitch channel name and your `OVERLAY_KEY`):

   ```
   http://localhost:8080/overlay/{channel}?key={OVERLAY_KEY}
   ```

   With sound effects and the dark theme:

   ```
   http://localhost:8080/overlay/{channel}?key={OVERLAY_KEY}&audio=1&theme=dark
   ```

3. Set width **1920** and height **1080** and leave the background transparent. The overlay is a ribbon along the bottom plus full-screen moments (boss, victory, wipe).

| Parameter | Values | Default | What it does |
| --- | --- | --- | --- |
| `key` | your `OVERLAY_KEY` | (required) | Read-only overlay secret |
| `audio` | `1` / `0` | `0` | 8-bit sound effects. Off by default so nothing surprises you live. In OBS, tick **Control audio via OBS** to mix it. |
| `theme` | `retro` / `dark` | `retro` | Pixel RPG look or dark glass look |
| `scale` | `0.8` to `1.2` | `1` | Ribbon size: try `0.8` for a 720p scene, `1.2` for 1440p |

If Chatacombs runs on another machine, replace `localhost` with that machine's address.

## Connecting your bot

Any bot that can make HTTP calls can drive the game. Every `/api/v1` call needs the header `Authorization: Bearer <API_KEY>`. A complete working example in under 50 lines is in **[docs/adapter-example.md](docs/adapter-example.md)**.

1. **Forward every chat message** to `POST /api/v1/channels/{channel}/messages`:

   ```json
   { "user": "viewerkid", "displayName": "ViewerKid", "text": "!attack", "isBroadcaster": false }
   ```

   The service answers `202 Accepted` right away. Forward all chat: anything that is not a game command is ignored, and `@<BOT_NAME>` questions get an in-character answer.

2. **Subscribe to the event stream** at `GET /api/v1/channels/{channel}/events` (Server-Sent Events, same Bearer header). Each event's `data:` is JSON:
   - `"kind": "say"` events carry a `text` line. **Post it to chat as-is.** The service already paces these (about one every 1.8 s), so your bot never floods chat.
   - `"kind": "game"` events carry a `type` such as `dice_roll`, `boss_appears`, `monster_defeated`, `dungeon_cleared` or `party_wiped`. Map the ones you like to your bot's own effects, or ignore them.

   Lines starting with `:` are keep-alive pings every 15 s. Reconnect if the stream drops.

3. **Tell it when you go live and when you stop** with `POST /api/v1/channels/{channel}/stream` and `{ "state": "started" }` or `{ "state": "ended" }`. Starting opens a theme vote; ending wraps up the current adventure.

4. Optional: `GET /api/v1/channels/{channel}/state` returns a JSON snapshot of the dungeon, party and current vote.

The full API is described in [PLAN.md, section 6](PLAN.md#6-http--sse-api-specifications).

### Commands your viewers use

| Command | What it does |
| --- | --- |
| `!vote 2` | Vote for a theme by its number |
| `!theme <idea>` | Suggest a theme during the vote |
| `!explore` | Search the room for loot, traps or secrets |
| `!go <exit>` | Vote for an exit |
| `!attack` / `!defend` | Fight-round actions |
| `!item <name>` | Use an item, e.g. `!item potion` |
| `!heal @name` | Heal another player with one of your potions |
| `!hero` | Show your HP, level, XP and gold |
| `@CB <question>` | Ask the narrator anything (uses `BOT_NAME`) |

The game rules are in [chat-dungeon-crawler-design.md](chat-dungeon-crawler-design.md).

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `API_KEY` | Bearer token your bot sends on every `/api/v1` call. **Change it.** | `dev-secret-key` |
| `OVERLAY_KEY` | Read-only key for the OBS overlay URL (`?key=`). **Change it.** | `dev-overlay-key` |
| `AI_URL` | OpenAI-compatible endpoint for narration (e.g. `https://api.openai.com/v1`; `/chat/completions` is added if missing). Empty means built-in template text. | empty (templates) |
| `AI_KEY` | API key for `AI_URL`, sent as a Bearer token | empty |
| `AI_MODEL` | Model name sent to `AI_URL` | empty |
| `BOT_NAME` | Name viewers `@mention` to talk to the narrator | `CB` |
| `PORT` | Port the service listens on | `8080` |
| `DATABASE_PATH` | SQLite file location | `/data/chatacombs.db` in the container, `./data/chatacombs.db` when run with `npm start` |

The defaults for `API_KEY` and `OVERLAY_KEY` exist only so the service works out of the box for local testing. If the AI endpoint is slow or down, the game falls back to template text and keeps going.

## Running without Docker (development)

Requires Node.js 22 or newer.

```bash
npm install
npm start            # service on http://localhost:8080
npm test             # node --test suite
npm run simulate     # play in the terminal as fake chatters
```
