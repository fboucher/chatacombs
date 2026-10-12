import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRng,
  rollDie,
  rollD20,
  rollD6,
  rollD20WithAdvantage,
  checkDC,
  rollDamage
} from '../src/engine/dice.js';
import { Engine, processMessage } from '../src/engine/engine.js';

test('dice - deterministic PRNG reproduces identical sequences', () => {
  const rng1 = createRng(42);
  const rng2 = createRng(42);

  const seq1 = Array.from({ length: 5 }, () => rng1());
  const seq2 = Array.from({ length: 5 }, () => rng2());

  assert.deepEqual(seq1, seq2);
});

test('dice - rollDie returns values within [1, sides]', () => {
  const rng = createRng(100);
  for (let i = 0; i < 100; i++) {
    const val = rollDie(12, rng);
    assert.ok(val >= 1 && val <= 12, `Value ${val} out of bounds`);
  }
});

test('dice - rollD20 and rollD6 basic bounds', () => {
  const rng = createRng(200);
  for (let i = 0; i < 50; i++) {
    const d20 = rollD20(rng);
    const d6 = rollD6(rng);
    assert.ok(d20 >= 1 && d20 <= 20);
    assert.ok(d6 >= 1 && d6 <= 6);
  }
});

test('dice - rollD20WithAdvantage selects max for advantage and min for disadvantage', () => {
  // Mock rng returning alternating values: 0.1 (roll=3) then 0.8 (roll=17)
  let count = 0;
  const mockRng = () => {
    count++;
    return count % 2 === 1 ? 0.1 : 0.8;
  };

  const adv = rollD20WithAdvantage(1, mockRng);
  assert.equal(adv.roll, 17);
  assert.deepEqual(adv.rolls, [3, 17]);
  assert.equal(adv.advantage, 1);

  count = 0;
  const dis = rollD20WithAdvantage(-1, mockRng);
  assert.equal(dis.roll, 3);
  assert.deepEqual(dis.rolls, [3, 17]);
  assert.equal(dis.advantage, -1);

  count = 0;
  const normal = rollD20WithAdvantage(0, mockRng);
  assert.equal(normal.roll, 3);
  assert.deepEqual(normal.rolls, [3]);
  assert.equal(normal.advantage, 0);
});

test('dice - checkDC resolves success, modifiers, crits and fumbles', () => {
  // Roll = 10, bonus = 4 -> total 14 vs DC 14 (success)
  const rng10 = () => 0.45; // floor(0.45 * 20) + 1 = 10
  const res1 = checkDC(14, 4, 0, rng10);
  assert.equal(res1.roll, 10);
  assert.equal(res1.total, 14);
  assert.equal(res1.success, true);
  assert.equal(res1.isCrit, false);
  assert.equal(res1.isFumble, false);

  // Roll = 20 -> Critical success regardless of DC
  const rng20 = () => 0.99; // 20
  const resCrit = checkDC(30, 0, 0, rng20);
  assert.equal(resCrit.roll, 20);
  assert.equal(resCrit.success, true);
  assert.equal(resCrit.isCrit, true);

  // Roll = 1 -> Critical fumble
  const rng1 = () => 0.01; // 1
  const resFumble = checkDC(5, 10, 0, rng1);
  assert.equal(resFumble.roll, 1);
  assert.equal(resFumble.success, false);
  assert.equal(resFumble.isFumble, true);
});

test('dice - rollDamage sums dice and applies bonus', () => {
  // Mock dice rolling 3 and 4 -> sum 7 + 2 bonus = 9
  let call = 0;
  const mockRng = () => (++call === 1 ? 0.35 : 0.55); // 1d6: floor(0.35*6)+1 = 3, floor(0.55*6)+1 = 4
  const dmg = rollDamage(2, 6, 2, mockRng);
  assert.deepEqual(dmg.rolls, [3, 4]);
  assert.equal(dmg.sum, 7);
  assert.equal(dmg.bonus, 2);
  assert.equal(dmg.total, 9);
});

test('engine harness - tracks chatter in party on regular messages without emitting events', () => {
  let fakeTime = 1000;
  const engine = new Engine({ clock: () => fakeTime });

  const result = engine.handleMessage({
    user: 'ViewerKid',
    displayName: 'ViewerKid',
    text: 'Hello streamer!'
  });

  assert.equal(result.events.length, 0);
  assert.ok(engine.state.party.has('viewerkid'));
  const partyMember = engine.state.party.get('viewerkid');
  assert.equal(partyMember.displayName, 'ViewerKid');
  assert.equal(partyMember.lastSeenAt, 1000);
});

test('engine harness - unknown commands are safely ignored', () => {
  const engine = new Engine();
  const result = engine.handleMessage({
    user: 'alice',
    displayName: 'Alice',
    text: '!unknownCommand'
  });
  assert.equal(result.events.length, 0);
});

test('engine harness - test dice command emits say and game moments deterministically', () => {
  // Controlled RNG yielding roll of 15
  const mockRng = () => 0.72; // floor(0.72*20)+1 = 15
  const engine = new Engine({ rng: mockRng });

  const result = engine.handleMessage({
    user: 'bob',
    displayName: 'BobTheGamer',
    text: '!roll-test'
  });

  assert.equal(result.events.length, 2);

  const sayEvent = result.events.find(e => e.kind === 'say');
  assert.ok(sayEvent);
  assert.match(sayEvent.text, /@BobTheGamer rolled a 15/);

  const gameEvent = result.events.find(e => e.kind === 'game');
  assert.ok(gameEvent);
  assert.equal(gameEvent.type, 'dice_roll');
  assert.equal(gameEvent.user, 'bob');
  assert.equal(gameEvent.roll, 15);
});

test('engine harness - processMessage helper works identically', () => {
  const mockRng = () => 0.45; // roll = 10
  const result = processMessage({ rng: mockRng }, {
    user: 'charlie',
    displayName: 'Charlie',
    text: '!dice-test'
  });

  assert.equal(result.events.length, 2);
  assert.equal(result.events[1].roll, 10);
});

test('createSayEvent - folds line breaks so every message is one Twitch line', async () => {
  const { createSayEvent } = await import('../src/engine/events.js');
  assert.equal(createSayEvent('Pick one:\n1: a | 2: b').text, 'Pick one: 1: a | 2: b');
  assert.equal(createSayEvent('a\r\n\r\n  b').text, 'a b');
});
