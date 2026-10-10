# Chatacombs: Implementation Plan & Architectural Blueprint

**Date:** October 10, 2026  
**Author:** Frank Boucher & Antigravity  
**Repository:** `chatacombs`  
**Target Client:** `CloudBot` (`CeeBee`) and any streamer running a chat bot + OBS  

---

## 1. Project Vision & Architecture

**Chatacombs** is an autonomous, chat-driven dungeon crawler experience designed to run in a streamer's Twitch chat while they stream. Every active chatter automatically becomes a member of the adventuring party. The game acts as a self-governing Dungeon Master communicating through the streamer's chat bot.

### Core Architectural Principles
1. **Code Owns the Truth, AI Narrates:**  
   Deterministic code strictly governs rooms, exits, combat rolls, monster HP, viewer inventory, XP, and party mortality. The AI (any OpenAI-compatible endpoint) solely provides creative flair: dynamic room naming, atmospheric descriptions, monster flavor, and in-character responses to `@Bot` questions.
2. **Standalone & Self-Hosted:**  
   Chatacombs is packaged as a standalone Docker container with its own internal SQLite database. Streamers run their own instance (zero hosting costs for the project maintainer) configured via environment variables.
3. **Pluggable Bot Adapter:**  
   Chatacombs has no direct dependency on Twitch credentials. Any chat bot (CloudBot, custom bot, etc.) simply forwards chat messages via HTTP POST and listens to an outgoing Server-Sent Events (SSE) stream.
4. **Paced & Stream-Safe:**  
   Chat narration is throttled server-side (1.5–2s interval between multi-part messages) so connecting bots never violate Twitch rate limits or flood chat. Turn timers pause during chat lulls so viewers never wipe while the streamer is speaking.

---

## 2. Key Decisions from Design & `/grill-me` Review

| Domain | Decision |
|---|---|
| **Deployment Model** | Standalone single-tenant Docker container with a persistent SQLite database mounted at `/data`. |
| **Inactivity & Combat Pacing** | Combat rounds and exit votes **pause** if chat is inactive. Monsters do not attack idle parties during stream lulls. CB nudges chat at most once every 10 minutes. |
| **Mechanics vs. AI Role** | Deterministic `!` commands (`!explore`, `!go`, `!attack`, `!defend`, `!item`, `!heal`, `!hero`, `!theme`, `!vote`) drive all game mechanics. `@CeeBee` mentions are strictly for in-character lore/flavor Q&A with a per-viewer cooldown. |
| **Party Economy & Rewards** | Any chatter who spoke in the last 15 minutes is in the party. When a room or monster is cleared, XP and gold are **split equally across all active party members** to maximize stream inclusion and cooperation. |
| **AI Requirements** | An OpenAI-compatible chat completions endpoint is **required** (`AI_URL`, `AI_KEY`, `AI_MODEL`). If individual requests time out or fail, the engine falls back to concise procedural templates. |
| **Tech Stack** | **Node.js (v20+) with native ES Modules (`"type": "module"`)**, Express 4, SQLite (`better-sqlite3`), and Node's built-in test runner (`node:test`). |
| **Phasing Strategy** | **Phase 1:** Build, test, and package Chatacombs core service and simulator in this repo. <br>**Phase 2:** Implement CloudBot adapter in `D:\dev\github\fboucher\CloudBot` (branch off `dev`). |

---

## 3. OBS Browser Source Overlay (`/overlay/{channel}`)

The overlay is a self-contained, lightweight web page designed to be added directly into OBS as a Browser Source (1920x1080 canvas, transparent background).

### 3.1 Visual Aesthetic: 16-Bit Retro Pixel RPG
- Pixel font styling, 16-bit badges, crisp SVG pixel hearts/HP meters, and themed monster silhouettes/sprites.
- Zero external CDN or heavy image dependencies; all sprites, styling, and icons are bundled locally in the container.

### 3.2 Default State: 3-Section Bottom Ribbon
During normal dungeon traversal and combat, the overlay displays a stylish, non-intrusive bottom ribbon docked at the bottom of the stream canvas:

```
+---------------------------------------------------------------------------------------------------------------+
| [ ROOM & THEME ]                | [ ENCOUNTER / COMBAT ]              | [ PARTY & LIVE TIMER ]                 |
| Floor 4/12: The Sunken Crypt   | 👾 Slime King (HP: ██████░░ 42/60)   | ⚔️ Party: 9 Active | 💀 1 KO           |
| Theme: Haunted Manor           | Round 2 / Action Window Active       | ⏱️ Vote: 🚪 East (5) 🚪 West (2) [0:35] |
+---------------------------------------------------------------------------------------------------------------+
```

1. **Left Section (Dungeon Progress):** Current room number, total rooms (e.g. `Room 4/12`), room name/archetype, and active theme.
2. **Center Section (Encounter Status):**
   - In exploration: Current room state (e.g., "Exploring...", "Chests looted", "Exit discovered").
   - In combat: Monster pixel sprite/portrait, monster name, animated visual HP bar with numeric hit points, and current combat phase.
3. **Right Section (Party & Turn Timer):**
   - Active party size and knocked-out (KO) player count.
   - Animated circular or bar countdown for active vote windows (theme vote, exit vote, or combat round action timer).

### 3.3 Dynamic Moments & Full-Screen Takeovers
The overlay connects to the SSE event stream (`/api/v1/channels/{channel}/events?key=...`) and reacts to game moments:

- **Full-Screen Takeovers (Milestones):**
  - `boss_appears`: Screen dim, thunder flash vignette, "WARNING: BOSS ENCOUNTER" pixel banner.
  - `party_wiped`: Crimson screen vignette with "PARTY DEFEATED" fade-in.
  - `dungeon_cleared`: Victory fanfare banner with gold coin confetti and clear-time statistics.
- **Floating Toast Alerts (Minor Events):**
  - `player_healed`: Green floating `+HP` potion banner with target player name.
  - `dice_roll`: 3D/pixel d20 roll animation showing result and modifier.
  - `rare_loot`: Sparkle banner displaying the discovered item.
  - `player_knocked_out`: Skull toast alert for the fallen viewer.

### 3.4 Audio SFX (`?audio=1`)
- Built-in Web Audio API 8-bit sound generator (square/noise wave synth for d20 rolls, potion glug, sword slash, victory fanfare, and defeat boom).
- **Default:** Muted for safety. Enabled by adding `&audio=1` to the OBS URL.

### 3.5 URL Query Parameters
Streamers configure their overlay via OBS Browser Source URL:
- `key`: Required read-only overlay secret token.
- `audio`: `1` or `0` (default `0`). Enables retro sound effects.
- `theme`: `retro` (default pixel RPG) or `dark` (glassmorphic dark mode).
- `scale`: Zoom scaling from `0.8` to `1.2` (adjusts ribbon size for 720p, 1080p, or 1440p scenes).

---

## 4. System Architecture & Components

```
                +---------------------------------------+
                | Twitch Chat (Viewers & Streamer)      |
                +---------------------------------------+
                        |                      ^
               chat in  |                      | ComfyJS.Say
                        v                      |
                +---------------------------------------+
                | Chat Bot (e.g. CeeBee / CloudBot)     |
                +---------------------------------------+
                    | POST messages        ^ GET /events (SSE)
                    v                      |
+-----------------------------------------------------------------------+
| Chatacombs Engine (Docker Container)                                  |
|                                                                       |
|  +---------------------+  +------------------+  +------------------+  |
|  | Express REST API    |  | SSE Broadcaster  |  | Message Pacer    |  |
|  | /messages, /stream  |  | /events, /state  |  | Rate limit / Say |  |
|  +---------------------+  +------------------+  +------------------+  |
|            |                       ^                      ^           |
|            v                       |                      |           |
|  +-----------------------------------------------------------------+  |
|  | Dungeon Engine (State Machine, Dice Rolls, Turn Timers)         |  |
|  +-----------------------------------------------------------------+  |
|            |                                              |           |
|            v                                              v           |
|  +---------------------+                        +------------------+  |
|  | SQLite Storage      |                        | AI Narrator      |  |
|  | (better-sqlite3)    |                        | OpenAI Endpoint  |  |
|  +---------------------+                        +------------------+  |
+-----------------------------------------------------------------------+
            |
            | GET /overlay/{channel} (SSE stream + HUD)
            v
+---------------------------------------+
| OBS Studio (Browser Source)           |
+---------------------------------------+
```

---

## 5. Data Models & Database Schema

Database path: `/data/chatacombs.db` (or `./data/chatacombs.db` in local development).

```sql
-- Player persistent stats across adventures
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  gold INTEGER NOT NULL DEFAULT 0,
  adventures_joined INTEGER NOT NULL DEFAULT 0,
  monsters_slain INTEGER NOT NULL DEFAULT 0,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel, username)
);

-- Adventures record
CREATE TABLE IF NOT EXISTS adventures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  theme TEXT NOT NULL,
  status TEXT NOT NULL, -- 'voting', 'active', 'cleared', 'wiped', 'abandoned'
  total_rooms INTEGER NOT NULL,
  current_room_index INTEGER NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME
);

-- Dungeon rooms generated per adventure
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adventure_id INTEGER NOT NULL REFERENCES adventures(id),
  room_number INTEGER NOT NULL,
  room_type TEXT NOT NULL, -- 'entrance', 'empty', 'trap', 'treasure', 'monster', 'boss'
  name TEXT NOT NULL,
  description TEXT,
  monster_data TEXT, -- JSON: { name, hp, maxHp, attack, defense, loot }
  exits TEXT NOT NULL, -- JSON array: ["north", "east", "trapdoor"]
  cleared INTEGER NOT NULL DEFAULT 0,
  looted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(adventure_id, room_number)
);

-- Active party runtime memory (persisted for crash recovery)
CREATE TABLE IF NOT EXISTS party_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adventure_id INTEGER NOT NULL REFERENCES adventures(id),
  username TEXT NOT NULL,
  hp INTEGER NOT NULL DEFAULT 20,
  max_hp INTEGER NOT NULL DEFAULT 20,
  is_knocked_out INTEGER NOT NULL DEFAULT 0,
  potions INTEGER NOT NULL DEFAULT 1,
  last_action_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(adventure_id, username)
);
```

---

## 6. HTTP & SSE API Specifications

Base path: `/api/v1`  
All `/api/v1` routes require `Authorization: Bearer <API_KEY>`.

### 6.1 `POST /api/v1/channels/:channel/messages`
**Request Body:**
```json
{
  "user": "viewerkid",
  "displayName": "ViewerKid",
  "text": "!attack",
  "isBroadcaster": false
}
```
**Response:** `202 Accepted` immediately.

### 6.2 `POST /api/v1/channels/:channel/stream`
**Request Body:**
```json
{
  "state": "started" // or "ended"
}
```
**Response:** `200 OK` (starts new adventure if idle, or concludes active adventure on end).

### 6.3 `GET /api/v1/channels/:channel/events`
Server-Sent Events endpoint with two primary event types:
1. `event: say`:
   ```json
   {
     "text": "⚔️ The party attacks! @ViewerKid rolls a 16 and strikes the Goblin for 6 DMG!"
   }
   ```
2. `event: game`:
   ```json
   {
     "type": "dice_roll",
     "user": "viewerkid",
     "roll": 16,
     "dc": 10,
     "success": true
   }
   ```

### 6.4 `GET /api/v1/channels/:channel/state`
Returns the complete JSON snapshot of the active dungeon, room, party HP, and current vote/turn state (used by overlay for cold boots).

### 6.5 `GET /overlay/:channel?key=<OVERLAY_KEY>`
Renders the standalone HTML5 OBS overlay with inline CSS, SVG assets, and SSE client logic.

---

## 7. Step-by-Step Implementation Roadmap

### Phase 1: Engine Core & Mechanics (No Network/AI Required) — [Issue #1](https://github.com/fboucher/chatacombs/issues/1)
- [ ] Initialize `package.json` with `"type": "module"`, scripts (`test`, `start`, `dev`).
- [ ] Build `src/engine/dice.js`: Pure d20, d6, damage calculation and advantage functions.
- [ ] Build `src/engine/generator.js`: Procedural dungeon generator (10–15 rooms, branching graph, monster scaling, boss at final room, loot tables).
- [ ] Build `src/engine/combat.js`: Turn-based round resolver (1-minute window, player action aggregation, dice resolution, monster counter-attack, KO handling).
- [ ] Build `src/engine/adventure.js`: Core state machine (Theme voting -> Room entry -> Exploration/Combat -> Exit vote -> Next room -> Cleared/Wiped).
- [ ] Write comprehensive unit tests in `test/engine.test.js` using `node:test`.

### Phase 2: Persistence & Party Management — [Issue #2](https://github.com/fboucher/chatacombs/issues/2)
- [ ] Build `src/db/database.js`: SQLite wrapper using `better-sqlite3` with automated schema migrations.
- [ ] Build `src/db/playerRepo.js`: Upsert players, grant shared XP/gold, level-up calculations, player lookup (`!hero`).
- [ ] Build `src/db/adventureRepo.js`: Save dungeon state, room clearance, and party snapshot.
- [ ] Write database unit tests in `test/db.test.js`.

### Phase 3: AI Narration & Template Fallback — [Issue #3](https://github.com/fboucher/chatacombs/issues/3)
- [ ] Build `src/ai/client.js`: OpenAI-compatible fetch client with strict timeouts (4s max) and abort signals.
- [ ] Build `src/ai/prompts.js`: System prompt instructing AI to act as DM, keep descriptions under 2 Twitch messages, and never alter game facts.
- [ ] Build `src/ai/templates.js`: Instant procedural fallback templates for room descriptions, combat recaps, and monster introductions if AI call times out.
- [ ] Build `src/ai/chatQna.js`: In-character `@Bot` query handler with rate limiting (30s cooldown per user).

### Phase 4: Express API, SSE Broadcaster & Rate-Limited Say Queue — [Issue #4](https://github.com/fboucher/chatacombs/issues/4)
- [ ] Build `src/server/sse.js`: Multi-client Server-Sent Events manager with heartbeat/ping.
- [ ] Build `src/server/pacer.js`: Message queue that throttles outgoing `say` events at 1.8s intervals so Twitch bots never flood or drop lines.
- [ ] Build `src/server/routes.js`: Express router for `/messages`, `/stream`, `/events`, `/state`.
- [ ] Build `src/server/auth.js`: Bearer token validation for API calls and query token validation for overlay.

### Phase 5: Built-in OBS Overlay (`/overlay/:channel`) — [Issue #5](https://github.com/fboucher/chatacombs/issues/5)
- [ ] Build `src/public/overlay.html`: Responsive 1920x1080 canvas.
- [ ] Build `src/public/overlay.css`: Retro pixel typography, 3-section bottom ribbon, health bars, and animations.
- [ ] Build `src/public/overlay.js`: SSE subscriber, initial state fetch, timer countdowns, and floating toast managers.
- [ ] Build `src/public/audio.js`: Synthesized Web Audio 8-bit sound effects toggled by `?audio=1`.
- [ ] Build full-screen modal overlays for `boss_appears`, `dungeon_cleared`, and `party_wiped`.

### Phase 6: CLI Simulator & End-to-End Test Suite — [Issue #6](https://github.com/fboucher/chatacombs/issues/6)
- [ ] Build `tools/simulator.js`: Interactive terminal script simulating Twitch chatters (`viewer1: !attack`, `viewer2: !heal viewer1`, `viewer3: !explore`) with simulated bot responses in console.
- [ ] Build `test/integration.test.js`: Full simulated game run from theme vote to boss kill via HTTP API and SSE.

### Phase 7: Dockerization & Documentation — [Issue #7](https://github.com/fboucher/chatacombs/issues/7)
- [ ] Build `Dockerfile` (Node 20 Alpine, multi-stage build, SQLite `/data` mount).
- [ ] Build `docker-compose.yml` for zero-effort local testing.
- [ ] Update `README.md` with complete installation and streamer connection guide.

### Phase 8: CloudBot Client Adapter (`CeeBee`) — [Issue #8](https://github.com/fboucher/chatacombs/issues/8)
- [ ] Switch to `D:\dev\github\fboucher\CloudBot` on a new branch `feature/chatacombs` off `dev`.
- [ ] In CloudBot `src/index.js` (or chat event handler), forward chat messages to Chatacombs `POST /api/v1/channels/:channel/messages`.
- [ ] Connect CloudBot to Chatacombs SSE stream (`/api/v1/channels/:channel/events`) and relay `say` events via `ComfyJS.Say`.
- [ ] Map Chatacombs `game` events to CloudBot's existing visual effects (Potions, Tada, Thunderstorm, Sunshine).
- [ ] Add Dungeon toggle & credentials in CloudBot admin dashboard.
