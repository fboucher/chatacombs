import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine/engine.js';
import { CombatResolver } from '../src/engine/combat.js';
import { createRng } from '../src/engine/dice.js';

test('pacing - theme vote pauses during inactivity lull and does not resolve while chat is quiet', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    clock: () => fakeTime,
    voteDurationMs: 60000, // 60s vote
    inactivityThresholdMs: 10000, // 10s idle threshold
    nudgeIntervalMs: 600000 // 10 min
  });

  engine.startThemeVote();
  assert.equal(engine.status, 'voting');

  // Let 10s elapse with chat active (first 10 seconds of vote)
  fakeTime += 5000;
  engine.handleMessage({ user: 'alice', displayName: 'Alice', text: '!vote 1' });
  fakeTime += 5000;
  engine.handleMessage({ user: 'alice', displayName: 'Alice', text: '!vote 1' });

  // Now chat goes completely quiet for 1 hour (3,600,000 ms)
  fakeTime += 3600000;
  const lullEvents = engine.tick(fakeTime);

  // Status must STILL be 'voting' - timers paused during idle lull!
  assert.equal(engine.status, 'voting');
  assert.equal(engine.getState().theme, null);

  // Filter out any quiet nudges, ensure no adventure_started occurred
  const advStarted = lullEvents.find(e => e.kind === 'game' && e.type === 'adventure_started');
  assert.equal(advStarted, undefined);

  // Messages arrive from chat resuming activity every 8s (below 10s threshold)
  // Need ~50s of active chat to complete the 60s window
  for (let step = 0; step < 7; step++) {
    fakeTime += 8000;
    engine.handleMessage({ user: 'bob', displayName: 'Bob', text: '!vote 1' });
  }

  // Now the vote successfully resolves!
  assert.equal(engine.status, 'active');
  assert.equal(engine.getState().theme, 'classic fantasy');
});

test('pacing - monsters never counter-attack an idle party during stream lulls', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    rng: createRng(123),
    clock: () => fakeTime,
    voteDurationMs: 60000,
    inactivityThresholdMs: 15000
  });

  // Start adventure and close theme vote directly
  engine.startThemeVote();
  engine.adventure.closeThemeVote();
  assert.equal(engine.status, 'active');

  // Set up combat room with a monster
  const hero = engine.trackChatter('steve', 'Steve');
  hero.hp = 20;

  engine.adventure.currentRoom = {
    id: 4,
    roomNumber: 4,
    type: 'monster',
    name: 'Goblin Den',
    exits: [{ direction: 'north', targetRoomId: 5 }],
    monster: {
      name: 'Goblin Sentry',
      hp: 20,
      maxHp: 20,
      attack: 5,
      defense: 10,
      xp: 30,
      gold: 15
    },
    exploration: { searched: false, hasLoot: false, loot: null, hasTrap: false, trap: null, secretExit: null }
  };

  engine.adventure.combat = new CombatResolver({
    rng: engine.rng,
    clock: () => fakeTime,
    roundDurationMs: 60000
  });
  engine.adventure.combat.startEncounter();

  // Chat goes quiet for 2 hours (streamer went to get lunch or talking)
  fakeTime += 7200000;
  const lullEvents = engine.tick(fakeTime);

  // Monster never attacked!
  assert.equal(hero.hp, 20);
  assert.equal(hero.isKnockedOut, false);
  const dmgEvent = lullEvents.find(e => e.kind === 'game' && e.type === 'player_knocked_out');
  assert.equal(dmgEvent, undefined);
  assert.equal(engine.status, 'active');
});

test('pacing - quiet-chat nudging triggers at most once every 10 minutes of quiet', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    clock: () => fakeTime,
    inactivityThresholdMs: 10000, // 10s idle
    nudgeIntervalMs: 600000 // 10 minutes (600,000 ms)
  });

  engine.startThemeVote();

  // After 5 minutes (300,000 ms) - no nudge yet
  fakeTime += 300000;
  const events5m = engine.tick(fakeTime);
  const nudge5m = events5m.find(e => e.kind === 'say' && e.text.includes('dungeon awaits your vote'));
  assert.equal(nudge5m, undefined);

  // After 10 minutes total (600,000 ms) - nudge fires!
  fakeTime += 300000;
  const events10m = engine.tick(fakeTime);
  const nudge10m = events10m.find(e => e.kind === 'say' && e.text.includes('dungeon awaits your vote'));
  assert.ok(nudge10m);

  // At 15 minutes - no second nudge yet
  fakeTime += 300000;
  const events15m = engine.tick(fakeTime);
  const nudge15m = events15m.find(e => e.kind === 'say' && e.text.includes('dungeon awaits your vote'));
  assert.equal(nudge15m, undefined);

  // At 20 minutes (another 10 min elapsed) - second nudge fires
  fakeTime += 300000;
  const events20m = engine.tick(fakeTime);
  const nudge20m = events20m.find(e => e.kind === 'say' && e.text.includes('dungeon awaits your vote'));
  assert.ok(nudge20m);
});
