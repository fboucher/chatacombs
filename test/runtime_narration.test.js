import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRuntime } from '../src/server/runtime.js';
import { Narrator } from '../src/ai/narrator.js';
import { AiClient } from '../src/ai/client.js';
import { CombatResolver } from '../src/engine/combat.js';
import { createRng } from '../src/engine/dice.js';

/**
 * Runtime whose narrator talks to a fake OpenAI-compatible endpoint.
 * `reply(prompt)` returns the completion text, or null for an HTTP error.
 */
function makeRuntime(t, { reply = () => 'The torches gutter as you step inside.', configured = true } = {}) {
  const prompts = [];
  const aiClient = new AiClient({
    url: configured ? 'https://mock.ai/v1' : '',
    fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body);
      const prompt = body.messages[1].content;
      prompts.push(prompt);
      const text = reply(prompt);
      if (text === null) return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) };
    }
  });
  const narrator = new Narrator({ aiClient, botName: 'Bones', fallbackToTemplates: false });
  const runtime = new ChannelRuntime({
    channel: 'narration',
    clock: () => 1_000_000,
    rng: createRng(3),
    pacerIntervalMs: 0,
    tickIntervalMs: 0,
    narrator
  });
  t.after(() => runtime.destroy());

  const said = [];
  runtime.bus.on('event', ev => { if (ev.kind === 'say') said.push(ev.text); });
  return { runtime, said, prompts };
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

test('runtime narration - room entry gets one AI line after the template facts line', async (t) => {
  const { runtime, said, prompts } = makeRuntime(t, {
    reply: () => 'Dust swirls through the old gate.\nSomething skitters in the dark.'
  });
  runtime.setStreamState('started');
  runtime.engine.adventure.closeThemeVote();
  runtime._dispatch([{ kind: 'game', type: 'room_entered' }]);
  await settle();

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Narrate the party entering Room 1\//);
  // Only the first AI line is used, so each moment adds one chat line
  assert.equal(said.filter(text => text === 'Dust swirls through the old gate.').length, 1);
  assert.ok(!said.includes('Something skitters in the dark.'));
});

test('runtime narration - adventure start narrates the entrance after the deterministic lines', async (t) => {
  const { runtime, said } = makeRuntime(t);
  runtime.setStreamState('started');
  await runtime.handleMessage({ user: 'alice', displayName: 'Alice', text: '!vote 1' });
  runtime.engine.adventure.themeVote.elapsedMs = 60_000;
  await runtime.handleMessage({ user: 'alice', displayName: 'Alice', text: 'hi' });
  await settle();

  const entered = said.findIndex(text => text.startsWith('🚪 Entered'));
  const narrated = said.indexOf('The torches gutter as you step inside.');
  assert.ok(entered >= 0, 'facts line still sent');
  assert.ok(narrated > entered, 'narration follows the facts line');
});

test('runtime narration - monster room narrates the monster, fight end gets a recap', async (t) => {
  const { runtime, said, prompts } = makeRuntime(t, {
    reply: prompt => (prompt.includes('combat encounter') ? 'A goblin snarls!' : 'The goblin falls.')
  });
  runtime.setStreamState('started');
  const adventure = runtime.engine.adventure;
  adventure.closeThemeVote();
  adventure.currentRoom = {
    id: 99,
    roomNumber: 2,
    type: 'monster',
    name: 'Goblin Den',
    exits: [{ direction: 'north', targetRoomId: 1 }],
    monster: { name: 'Goblin', hp: 1, maxHp: 10, attack: 1, defense: 1, xp: 10, gold: 5 },
    exploration: { searched: false }
  };
  await settle();
  prompts.length = 0;
  said.length = 0;

  runtime._dispatch([{ kind: 'game', type: 'room_entered' }]);
  await settle();
  assert.match(prompts[0], /Creature: Goblin/);
  assert.ok(said.includes('A goblin snarls!'));

  adventure.combat = new CombatResolver({ rng: () => 0.99, clock: () => 1_000_000, roundDurationMs: 60_000 });
  adventure.combat.startEncounter();
  await runtime.handleMessage({ user: 'alice', displayName: 'Alice', text: '!attack' });
  adventure.combat.elapsedMs = 60_000;
  runtime.tick(1_000_000);
  await settle();

  assert.ok(said.some(text => text.includes('has been vanquished')), 'facts line still sent');
  assert.match(prompts.at(-1), /Narrate how the fight ended/);
  assert.match(prompts.at(-1), /Monster Goblin defeated/);
  assert.equal(said.at(-1), 'The goblin falls.');
});

test('runtime narration - combat rounds and votes are not narrated', async (t) => {
  const { runtime, prompts } = makeRuntime(t);
  runtime._dispatch([
    { kind: 'say', text: '⏳ Round 2 begins!' },
    { kind: 'game', type: 'dice_roll', roll: 12 }
  ]);
  await settle();
  assert.equal(prompts.length, 0);
});

test('runtime narration - no AI configured or AI failure adds nothing', async (t) => {
  for (const options of [{ configured: false }, { reply: () => null }]) {
    const { runtime, said } = makeRuntime(t, options);
    runtime.setStreamState('started');
    runtime.engine.adventure.closeThemeVote();
    const before = said.length;
    runtime._dispatch([{ kind: 'game', type: 'room_entered' }]);
    await settle();
    assert.equal(said.length, before);
  }
});
