import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine/engine.js';
import { CombatResolver } from '../src/engine/combat.js';
import { createRng } from '../src/engine/dice.js';

test('endings - boss defeat ends adventure with dungeon_cleared and cleared status', () => {
  let fakeTime = 1000;
  // High roll: hits and defeats boss
  const mockRng = () => 0.99;
  const engine = new Engine({
    rng: mockRng,
    clock: () => fakeTime,
    voteDurationMs: 60000
  });

  engine.startThemeVote();
  engine.adventure.closeThemeVote();
  assert.equal(engine.status, 'active');

  const hero = engine.trackChatter('hero', 'Hero');
  hero.hp = 20;

  // Set current room to final boss room
  const bossRoom = engine.adventure.dungeon.rooms[engine.adventure.dungeon.rooms.length - 1];
  engine.adventure.currentRoom = bossRoom;
  bossRoom.monster.hp = 2; // frail boss for one-hit defeat

  engine.adventure.combat = new CombatResolver({
    rng: engine.rng,
    clock: () => fakeTime,
    roundDurationMs: 60000
  });
  engine.adventure.combat.startEncounter();

  // Hero attacks
  engine.handleMessage({ user: 'hero', displayName: 'Hero', text: '!attack' });

  // Fast forward active round
  fakeTime += 60001;
  const tickEvents = engine.tick(fakeTime);

  // Status must be cleared
  assert.equal(engine.status, 'cleared');

  const clearEvent = tickEvents.find(e => e.kind === 'game' && e.type === 'dungeon_cleared');
  assert.ok(clearEvent);
  assert.equal(clearEvent.theme, engine.getState().theme);
  assert.ok(clearEvent.snapshot);
  assert.equal(clearEvent.snapshot.status, 'cleared');
  assert.ok(clearEvent.snapshot.monstersSlain >= 1);

  const snapshot = engine.getOutcomeSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.status, 'cleared');
  assert.equal(snapshot.partyStatus[0].username, 'hero');
});

test('endings - party wipe ends adventure with party_wiped and wiped status', () => {
  let fakeTime = 1000;
  // High roll: monster hits and knocks out hero
  const mockRng = () => 0.95;
  const engine = new Engine({
    rng: mockRng,
    clock: () => fakeTime,
    voteDurationMs: 60000
  });

  engine.startThemeVote();
  engine.adventure.closeThemeVote();

  const frail = engine.trackChatter('frail', 'Frail');
  frail.hp = 1;

  const monsterRoom = engine.adventure.dungeon.rooms[1];
  monsterRoom.type = 'monster';
  monsterRoom.monster = {
    name: 'Gargoyle',
    hp: 100,
    maxHp: 100,
    attack: 8,
    defense: 25,
    xp: 50,
    gold: 25
  };
  engine.adventure.currentRoom = monsterRoom;

  engine.adventure.combat = new CombatResolver({
    rng: engine.rng,
    clock: () => fakeTime,
    roundDurationMs: 60000
  });
  engine.adventure.combat.startEncounter();

  engine.handleMessage({ user: 'frail', displayName: 'Frail', text: '!attack' });

  fakeTime += 60001;
  const tickEvents = engine.tick(fakeTime);

  // Status must be wiped
  assert.equal(engine.status, 'wiped');

  const wipeEvent = tickEvents.find(e => e.kind === 'game' && e.type === 'party_wiped');
  assert.ok(wipeEvent);
  assert.equal(wipeEvent.snapshot.status, 'wiped');
  assert.equal(wipeEvent.snapshot.partyStatus[0].isKnockedOut, true);

  const snapshot = engine.getOutcomeSnapshot();
  assert.equal(snapshot.status, 'wiped');
});

test('endings - idle timeout (60 quiet minutes) closes adventure as abandoned without victory/defeat banners', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    clock: () => fakeTime,
    inactivityThresholdMs: 15000,
    abandonTimeoutMs: 3600000 // 60 minutes
  });

  engine.startThemeVote();
  engine.adventure.closeThemeVote();
  assert.equal(engine.status, 'active');

  // Chat goes quiet for 60+ minutes
  fakeTime += 3600001;
  const events = engine.tick(fakeTime);

  assert.equal(engine.status, 'abandoned');

  // Must NOT emit dungeon_cleared or party_wiped
  const clearEvent = events.find(e => e.kind === 'game' && e.type === 'dungeon_cleared');
  const wipeEvent = events.find(e => e.kind === 'game' && e.type === 'party_wiped');
  assert.equal(clearEvent, undefined);
  assert.equal(wipeEvent, undefined);

  // Must emit adventure_ended with reason
  const endedEvent = events.find(e => e.kind === 'game' && e.type === 'adventure_ended');
  assert.ok(endedEvent);
  assert.equal(endedEvent.status, 'abandoned');
  assert.equal(endedEvent.reason, 'idle_timeout');
  assert.equal(endedEvent.snapshot.status, 'abandoned');
});

test('endings - explicit abandonAdventure closes run with stream_ended reason', () => {
  let fakeTime = 1000;
  const engine = new Engine({ clock: () => fakeTime });

  engine.startThemeVote();
  engine.adventure.closeThemeVote();
  assert.equal(engine.status, 'active');

  const events = engine.abandonAdventure('stream_ended');

  assert.equal(engine.status, 'abandoned');
  const endedEvent = events.find(e => e.kind === 'game' && e.type === 'adventure_ended');
  assert.ok(endedEvent);
  assert.equal(endedEvent.reason, 'stream_ended');
  assert.equal(engine.getOutcomeSnapshot().status, 'abandoned');
});
