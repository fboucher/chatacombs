#!/usr/bin/env node
/**
 * Chatacombs Interactive CLI Simulator
 * Allows developers and agents to play a live Chatacombs session end-to-end
 * directly in the terminal without requiring Twitch or OBS.
 *
 * Usage:
 *   node tools/simulator.js [--url http://localhost:8080] [--channel default] [--key dev-secret-key]
 * Or piped/scripted:
 *   echo -e "/start\nalice: !vote 1\n/state\n/exit" | node tools/simulator.js
 */

import readline from 'node:readline';

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m'
};

export class Simulator {
  constructor(options = {}) {
    this.apiUrl = (options.url || process.env.API_URL || 'http://localhost:8080').replace(/\/+$/, '');
    this.channel = options.channel || process.env.CHANNEL || 'default';
    this.apiKey = options.key || process.env.API_KEY || 'dev-secret-key';
    this.defaultUser = options.defaultUser || 'hero';
    this.abortController = null;
    this.connected = false;
    this.output = options.output || console.log;
    this.error = options.error || console.error;
    this.eventsReceived = [];
  }

  log(msg) {
    this.output(msg);
  }

  formatGameEvent(event) {
    const type = event.type || 'unknown';
    switch (type) {
      case 'dice_roll':
        return `${c.yellow}🎲 [DICE]${c.reset} @${event.displayName || event.user} rolled ${c.bold}${event.roll}${c.reset}`;
      case 'adventure_started':
        return `${c.magenta}${c.bold}🏰 [ADVENTURE STARTED]${c.reset} Theme: "${event.theme}" (${event.totalRooms} rooms)`;
      case 'room_entered':
        return `${c.blue}🚪 [ROOM ${event.roomNumber}]${c.reset} ${c.bold}${event.roomName}${c.reset} (${event.roomType}) | Exits: ${(event.exits || []).join(', ')}`;
      case 'combat_round_started':
        return `${c.red}⚔️ [COMBAT]${c.reset} Round ${event.round} against ${c.bold}${event.monster?.name || 'monster'}${c.reset} (HP: ${event.monster?.hp}/${event.monster?.maxHp})`;
      case 'combat_round_resolved':
        return `${c.red}💥 [COMBAT ROUND ${event.round} RESOLVED]${c.reset} Monster HP: ${event.monster?.hp}/${event.monster?.maxHp}`;
      case 'monster_defeated':
        return `${c.green}${c.bold}🎉 [MONSTER DEFEATED]${c.reset} Defeated ${event.monster?.name}! Shared Loot: ${event.loot?.gold || 0}g, ${event.loot?.xp || 0} XP`;
      case 'player_knocked_out':
        return `${c.red}${c.bold}💀 [KNOCKED OUT]${c.reset} @${event.displayName || event.user} has been knocked out!`;
      case 'player_healed':
        return `${c.green}💚 [HEALED]${c.reset} @${event.target} healed for +${event.amount} HP by @${event.user} (HP: ${event.hp}/${event.maxHp})`;
      case 'player_level_up':
        return `${c.yellow}${c.bold}⭐ [LEVEL UP]${c.reset} @${event.displayName || event.user} reached Level ${event.level}!`;
      case 'rewards_distributed':
        return `${c.green}💰 [REWARDS]${c.reset} ${event.totalXp} XP & ${event.totalGold}g divided among ${event.recipientCount} heroes`;
      case 'dungeon_cleared':
        return `${c.green}${c.bold}🏆 [DUNGEON CLEARED]${c.reset} Victory! The dungeon has been conquered!`;
      case 'party_wiped':
        return `${c.red}${c.bold}💀 [PARTY WIPED]${c.reset} All party members fell in battle.`;
      case 'adventure_ended':
        return `${c.yellow}🛑 [ADVENTURE ENDED]${c.reset} Status: ${event.status} (${event.reason})`;
      default:
        return `${c.yellow}⚡ [GAME:${type}]${c.reset} ${c.gray}${JSON.stringify(event)}${c.reset}`;
    }
  }

  printEvent(event) {
    if (event.kind === 'say') {
      this.log(`${c.cyan}${c.bold}💬 [SAY]${c.reset} ${c.cyan}${event.text}${c.reset}`);
    } else {
      this.log(this.formatGameEvent(event));
    }
  }

  async connectSse() {
    this.abortController = new AbortController();
    const url = `${this.apiUrl}/api/v1/channels/${this.channel}/events`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        },
        signal: this.abortController.signal
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed with HTTP ${response.status} ${response.statusText}`);
      }

      this.connected = true;
      this.log(`${c.green}✓ Connected to event stream for channel: ${c.bold}${this.channel}${c.reset}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep partial line

            let currentEvent = 'message';
            let currentData = '';

            for (const line of lines) {
              if (line.startsWith(':')) {
                // Heartbeat / comment
                continue;
              }
              if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                currentData = line.slice(5).trim();
              } else if (line.trim() === '') {
                if (currentData) {
                  try {
                    const parsed = JSON.parse(currentData);
                    this.eventsReceived.push(parsed);
                    this.printEvent(parsed);
                  } catch (_) {}
                  currentEvent = 'message';
                  currentData = '';
                }
              }
            }
          }
        } catch (err) {
          if (err.name !== 'AbortError') {
            this.log(`${c.red}⚠️ Event stream read error: ${err.message}${c.reset}`);
          }
        }
      })();
    } catch (err) {
      if (err.name === 'AbortError') return;
      this.log(`${c.red}⚠️ Event stream disconnected: ${err.message}${c.reset}`);
      this.connected = false;
    }
  }

  async sendMessage(user, text) {
    const url = `${this.apiUrl}/api/v1/channels/${this.channel}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          user,
          displayName: user,
          text
        })
      });

      if (!res.ok) {
        const errBody = await res.text();
        this.log(`${c.red}Failed to send message: HTTP ${res.status} - ${errBody}${c.reset}`);
      }
    } catch (err) {
      this.log(`${c.red}Network error posting message: ${err.message}${c.reset}`);
    }
  }

  async setStreamState(state) {
    const url = `${this.apiUrl}/api/v1/channels/${this.channel}/stream`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ state })
      });

      const body = await res.json();
      this.log(`${c.yellow}📡 Stream lifecycle '${state}': status=${body.status}, changed=${body.changed}${c.reset}`);
    } catch (err) {
      this.log(`${c.red}Error setting stream state: ${err.message}${c.reset}`);
    }
  }

  async printState() {
    const url = `${this.apiUrl}/api/v1/channels/${this.channel}/state`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        }
      });
      if (!res.ok) {
        this.log(`${c.red}Failed to fetch state: HTTP ${res.status}${c.reset}`);
        return;
      }
      const state = await res.json();
      this.log(`\n${c.bold}--- Current Game State ---${c.reset}`);
      this.log(JSON.stringify(state, null, 2));
      this.log(`${c.bold}--------------------------${c.reset}\n`);
    } catch (err) {
      this.log(`${c.red}Error fetching state: ${err.message}${c.reset}`);
    }
  }

  async handleInput(rawLine) {
    const line = rawLine.trim();
    if (!line) return;

    if (line === '/help') {
      this.printHelp();
      return;
    }

    if (line === '/start' || line === '/stream start') {
      await this.setStreamState('started');
      return;
    }

    if (line === '/end' || line === '/stream end') {
      await this.setStreamState('ended');
      return;
    }

    if (line === '/state') {
      await this.printState();
      return;
    }

    if (line.startsWith('/user ')) {
      const newUser = line.slice(6).trim();
      if (newUser) {
        this.defaultUser = newUser;
        this.log(`${c.green}Default user set to: ${c.bold}${this.defaultUser}${c.reset}`);
      }
      return;
    }

    if (line.startsWith('/lull') || line.startsWith('/quiet')) {
      const parts = line.split(/\s+/);
      const seconds = parseInt(parts[1] || '5', 10);
      this.log(`${c.yellow}⏳ Simulating quiet lull for ${seconds}s (no chat messages)...${c.reset}`);
      await new Promise(r => setTimeout(r, seconds * 1000));
      this.log(`${c.yellow}✓ Lull period finished.${c.reset}`);
      return;
    }

    // Parse 'user: message' vs standalone message
    let user = this.defaultUser;
    let text = line;

    const colonIdx = line.indexOf(':');
    if (colonIdx > 0 && !line.startsWith('!')) {
      const potentialUser = line.slice(0, colonIdx).trim();
      // If no spaces in potentialUser, treat as username
      if (!/\s/.test(potentialUser)) {
        user = potentialUser;
        text = line.slice(colonIdx + 1).trim();
      }
    }

    await this.sendMessage(user, text);
  }

  printBanner() {
    this.log(`\n${c.bold}${c.magenta}======================================================${c.reset}`);
    this.log(`${c.bold}${c.magenta}   🏰 CHATACOMBS INTERACTIVE TERMINAL SIMULATOR 🏰    ${c.reset}`);
    this.log(`${c.bold}${c.magenta}======================================================${c.reset}`);
    this.log(`API URL: ${c.cyan}${this.apiUrl}${c.reset} | Channel: ${c.cyan}${this.channel}${c.reset} | User: ${c.cyan}${this.defaultUser}${c.reset}`);
    this.log(`Type ${c.bold}/help${c.reset} for command assistance or ${c.bold}/start${c.reset} to begin an adventure.\n`);
  }

  printHelp() {
    this.log(`\n${c.bold}Available Commands:${c.reset}`);
    this.log(`  ${c.cyan}/start${c.reset}            - Start adventure stream (opens theme vote)`);
    this.log(`  ${c.cyan}/end${c.reset}              - End adventure stream`);
    this.log(`  ${c.cyan}/state${c.reset}            - Inspect current game state snapshot`);
    this.log(`  ${c.cyan}/lull [sec]${c.reset}       - Simulate quiet stream lull (default 5s)`);
    this.log(`  ${c.cyan}/user <name>${c.reset}      - Change default chatter username`);
    this.log(`  ${c.cyan}/help${c.reset}             - Show this help`);
    this.log(`  ${c.cyan}/quit, /exit${c.reset}      - Exit simulator\n`);
    this.log(`${c.bold}Chat Syntax Examples:${c.reset}`);
    this.log(`  ${c.yellow}alice: !vote 1${c.reset}    - User 'alice' votes for theme slot 1`);
    this.log(`  ${c.yellow}bob: !explore${c.reset}     - User 'bob' explores current room`);
    this.log(`  ${c.yellow}charlie: !go north${c.reset}- User 'charlie' votes to move north`);
    this.log(`  ${c.yellow}alice: !attack${c.reset}    - User 'alice' attacks current monster`);
    this.log(`  ${c.yellow}!hero${c.reset}             - Sends '!hero' from default user (${this.defaultUser})\n`);
  }

  close() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.connected = false;
  }
}

// CLI entry point
function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' || args[i] === '-u') options.url = args[++i];
    else if (args[i] === '--channel' || args[i] === '-c') options.channel = args[++i];
    else if (args[i] === '--key' || args[i] === '-k') options.key = args[++i];
    else if (args[i] === '--user') options.defaultUser = args[++i];
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sim = new Simulator(options);

  sim.printBanner();

  // Start background SSE listener
  sim.connectSse();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY
  });

  const promptUser = () => {
    if (process.stdin.isTTY) {
      rl.setPrompt(`${sim.defaultUser}> `);
      rl.prompt();
    }
  };

  promptUser();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '/quit' || trimmed === '/exit') {
      break;
    }

    try {
      await sim.handleInput(line);
    } catch (err) {
      sim.error(`${c.red}Error: ${err.message}${c.reset}`);
    }

    promptUser();
  }

  sim.log(`\n${c.gray}Exiting simulator. Farewell, adventurer!${c.reset}`);
  sim.close();
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch(err => {
    console.error('Simulator crashed:', err);
    process.exit(1);
  });
}
