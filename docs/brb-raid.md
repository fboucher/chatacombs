# BRB Raid: design notes

A living reference for turning Chatacombs into a game chat plays while the streamer is away. Edit it freely: when an idea is turned down, move it to [Turned down](#turned-down) with a one-line reason instead of deleting it, so we remember why.

Status: **brainstorm**. Nothing here is built yet. A clickable mockup lives in [`docs/brb-raid/mockup.html`](brb-raid/mockup.html) (open it in a browser, no server needed).

## Why

Viewers tried the always-on overlay and said it asked for too much attention. During a stream they either watch what the streamer shares, or keep the stream on a second monitor as background and only look up now and then. A game that needs constant attention competes with the streamer.

BRB moments are different: for 2 to 5 minutes the screen has nothing else to show and chat is idle. That is when the game should run, owning the **full screen**, and disappear when the streamer is back.

## The loop

1. **BRB starts.** CloudBot sends a `brb` stream event. The full-screen raid scene fades in. Bones posts one line in chat: how to join.
2. **Join phase (about 20s).** Viewers type `!join` (random class) or `!join <class>`. Each joiner appears on the grid as their own hero, with name, class, level and HP.
3. **Encounters.** Turn-based fights on a small 2D grid (see below), one encounter after another until time runs out.
4. **Streamer is back.** CloudBot sends a `back` event (or the break timer ends). The current fight wraps up, a recap card shows (MVP, damage, loot, XP, level-ups), then the scene fades out. Bones posts a one-line recap in chat.

Outside BRB, nothing is on screen (at most a tiny "last raid" badge, optional).

## Heroes and classes

`!join` assigns a random class; `!join knight` (etc.) picks one. A hero keeps its level, XP and gold between raids (already stored in the player DB); HP and class abilities reset each raid.

| Class | Role | Basic attack | Skill (`!skill`) |
| --- | --- | --- | --- |
| Knight | Tank | Melee, adjacent only | **Taunt**: monsters target the knight next monster turn; takes reduced damage |
| Rogue | Damage, loot | Melee, adjacent only; crit on high roll | **Backstab**: big damage if the target is not facing them / already hit this turn. Better `!search` / `!loot` |
| Mage | Area damage | Ranged, any distance | **Fireball**: hits a 3x3 area. Low HP |
| Cleric | Support | Ranged, weak | **Heal** the lowest-HP hero in range, or **revive** a downed one |

Open: should skills have a cooldown (e.g. once every 3 turns) or just cost the turn?

## Turns

The game is turn-based, XCOM-style: a heroes' turn, then a monsters' turn.

### Heroes' turn

- About **one third of the party** (rounded up, minimum 1) can act per turn. With 6 heroes, 2 actions; with 12, 4.
- Slots go to the **first players to type a valid command**. Each command is that player's whole action.
- The turn has a **timer (about 15s)**. When slots fill or time runs out, the turn ends.
- A hero who acted is **exhausted** for the next heroes' turn, so the same fast typers don't play every turn.
- Late commands show "too slow!" on the overlay, not in chat.

### Monsters' turn

- Monsters (or the boss) take **several actions**, about 5s total on screen.
- Some attacks hit **one hero**, some a **row**, some a **3x3 area**, some **all heroes**.
- **Telegraphed intent**: before the heroes' turn, each monster shows what it will do next (e.g. "Fire Breath on row 2", "Crush the Knight"). This is the strategy hook: heroes decide to taunt, heal, move out or burst it down.

### Pacing

15s heroes + ~5s monsters is about 20s a round, so a 3 minute break is about 8 rounds: roughly one group fight and a boss, or two group fights.

## The grid

- **8 columns (A-H) by 4 rows (1-4).** Heroes start on the left (columns A-B), monsters on the right (G-H).
- One unit per cell. Several heroes in a crowded party can share a cell if needed (open question).
- **Movement**: `!move C2` (exact cell) or `!move fwd` / `back` / `up` / `down` (one step). Moving costs the turn. Open: allow move up to 2 cells?
- **Range** matters: Knight and Rogue must be adjacent to attack; Mage and Cleric reach anywhere. Area attacks punish clumping.

## Monsters and encounters

- **3 of 4 encounters are a group** of smaller monsters; **1 of 4 is a single boss**.
- Each monster gets a **number tag** over its head (1, 2, 3...), so attacks are `!atk 2`. Numbers avoid confusion with the grid's column letters.
- `!atk` with no target hits the nearest monster in range, so a lazy command never fails.
- **Dynamic scaling** from party size and average level:
  - Group size: about 1 monster per 2 heroes, minimum 2, maximum what fits on the right side of the grid.
  - Monster HP and damage scale with the party's average level.
  - Boss HP scales per hero, so 3 viewers or 30 both get a real fight.
- The boss is a big sprite (2x2 cells?) with a single tag and a stronger telegraphed move every few turns.

## Commands

All single-word or two-word, one line (Twitch chat can't post multi-line messages):

| Command | Effect |
| --- | --- |
| `!join [class]` | Join the raid (random class if none) |
| `!atk [n]` | Basic attack on monster `n` (nearest if omitted) |
| `!skill [n or cell]` | Class skill |
| `!move <cell or dir>` | Move to a cell or one step |
| `!search` / `!loot` | Look for items / grab loot in the room (Rogue is better at it) |
| `!item` | Use a potion |

Open: should a non-command chat line from a joined player count as a free basic attack (lurker-friendly), or does that clash with the "one third of the party" slots?

## Feedback: screen, not chat

The bot can't answer every action in chat (rate limits, and chat would become a wall of text). So:

- Results appear **on screen**: damage numbers over targets, the d20 roll, "found 12 gold", "too slow!".
- Bones posts **only big moments** in chat: raid open, boss arrives, party wiped, final recap. Every chat message is one line.

## Loot

Open question: personal (whoever grabs it keeps it) or shared by the party? Current lean: XP shared by everyone who took part, gold personal to who looted it.

## What we can reuse from today's Chatacombs

| Today | Reuse for BRB raid |
| --- | --- |
| `src/engine/generator.js` | Encounter/room generation, themes |
| `src/engine/combat.js`, `dice.js` | d20 rolls, damage; needs targeting and areas |
| `src/engine/adventure.js` | Replace the 60s vote rounds with the timed turn loop |
| `src/db/playerRepo.js` | Level, XP, gold already persist per player |
| `src/server/runtime.js` `setStreamState` | Add `brb` / `back` next to `started` / `ended` |
| `src/server/pacer.js` | Still paces the few chat lines Bones posts |
| `src/public/overlay.*` | Needs a new full-screen scene; keep themes (retro/dark) |
| AI narrator, `soul.md` | Short flavour lines for the big moments only |
| CloudBot dungeon adapter | Must send `brb` / `back`; already forwards every chat line |

## Open questions

- Grid size with a big party (20+ joiners): bigger grid, shared cells, or cap the raid size?
- Skill cooldowns vs turn cost.
- Loot: personal or shared.
- What happens when the whole party is down: raid lost, or revive and retry?
- Should hero class persist per viewer (last pick remembered)?
- Does the always-on overlay stay as an option, or is the raid the only mode?

## Turned down

| Idea | Why |
| --- | --- |
| Always-on overlay as the main mode | Viewer feedback: asks for too much attention during the stream |
| Real-time action points (refill every few seconds) | Turn-based is easier to follow on stream and gives a beat for strategy |
| Front/back rows only (no grid) | Frank prefers a simple 2D grid |
| 60s vote rounds from the current game | Far too slow for a 2-5 minute break |
