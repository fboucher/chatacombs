import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Narrator } from '../src/ai/narrator.js';
import { AiClient } from '../src/ai/client.js';
import {
  buildDungeonMasterSystemPrompt,
  buildRoomEntryPrompt,
  buildMonsterIntroPrompt,
  buildCombatRecapPrompt
} from '../src/ai/prompts.js';

test('prompts - system prompt enforces brevity, no-invent, and theme constraints', () => {
  const prompt = buildDungeonMasterSystemPrompt({ botName: 'CeeBee', theme: 'sky castle' });
  assert.match(prompt, /You are CeeBee/);
  assert.match(prompt, /"sky castle"/);
  assert.match(prompt, /CODE OWNS THE TRUTH, AI ONLY NARRATES/);
  assert.match(prompt, /NEVER invent new exits/);
  assert.match(prompt, /at most 2 short Twitch chat messages/);
});

test('prompts - room prompt supplies verified structured facts', () => {
  const room = {
    roomNumber: 3,
    name: 'Breeze Walkway',
    type: 'empty',
    exits: [{ direction: 'north' }, { direction: 'west' }],
    monster: null
  };
  const prompt = buildRoomEntryPrompt(room, { totalRooms: 10 });
  assert.match(prompt, /Room 3\/10: "Breeze Walkway"/);
  assert.match(prompt, /Verified Exits: north, west/);
  assert.match(prompt, /No monsters/);
});

test('narrator - chooses AI output on successful completion', async () => {
  const mockClient = new AiClient({
    url: 'https://mock.api/v1',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'The castle clouds part revealing glittering marble steps.\nExits lead north and west.'
            }
          }
        ]
      })
    })
  });

  const narrator = new Narrator({
    aiClient: mockClient,
    theme: 'sky castle',
    botName: 'CeeBee'
  });

  const room = {
    roomNumber: 2,
    name: 'Cloud Terrace',
    type: 'entrance',
    exits: [{ direction: 'north' }]
  };

  const lines = await narrator.narrateRoom(room, { totalRooms: 10 });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /glittering marble steps/);
  assert.match(lines[1], /Exits lead north and west/);
});

test('narrator - falls back seamlessly to procedural template on AI timeout / failure', async () => {
  const mockFailingClient = new AiClient({
    url: 'https://mock.api/v1',
    fetchFn: async () => {
      const timeoutErr = new Error('aborted');
      timeoutErr.name = 'AbortError';
      throw timeoutErr;
    }
  });

  const narrator = new Narrator({
    aiClient: mockFailingClient,
    theme: 'pirate ship',
    botName: 'CeeBee'
  });

  const room = {
    roomNumber: 5,
    name: 'Captain Quarters',
    type: 'treasure',
    exits: [{ direction: 'east' }]
  };

  const lines = await narrator.narrateRoom(room, { totalRooms: 12 });
  assert.ok(lines.length >= 1 && lines.length <= 2);
  // Verify it came from procedural template
  assert.match(lines[0], /Room 5\/12: Captain Quarters/);
  assert.match(lines[0], /glint of treasure/);
  assert.match(lines[1], /Exits: east/);
});

test('narrator - unconfigured AI client returns templates instantly without error', async () => {
  const unconfiguredClient = new AiClient({ url: '' });
  const narrator = new Narrator({ aiClient: unconfiguredClient });

  const monster = {
    name: 'Swamp Beast',
    hp: 45,
    maxHp: 45,
    attack: 6,
    defense: 10
  };

  const intro = await narrator.narrateMonsterIntro(monster, { type: 'monster' });
  assert.ok(intro.length >= 1 && intro.length <= 2);
  assert.match(intro[0], /MONSTER SIGHTING! Swamp Beast/);
  assert.match(intro[0], /45\/45 HP/);
});

test('narrator - combat recap falls back cleanly on HTTP error', async () => {
  const mockHttpErrorClient = new AiClient({
    url: 'https://mock.api/v1',
    fetchFn: async () => ({
      ok: false,
      status: 500
    })
  });

  const narrator = new Narrator({ aiClient: mockHttpErrorClient });

  const recap = await narrator.narrateCombatRecap({
    round: 1,
    monster: { name: 'Skeleton', hp: 15, maxHp: 20 },
    events: [],
    monsterDefeated: false
  });

  assert.match(recap[0], /Round 1 Resolved/);
  assert.match(recap[1], /Skeleton stands at 15\/20 HP/);
});
