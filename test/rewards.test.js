import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, runMigrations } from '../src/db/database.js';
import { PlayerRepository } from '../src/db/playerRepo.js';
import { PartyRepository } from '../src/db/partyRepo.js';
import { Adventure } from '../src/engine/adventure.js';
import { Engine } from '../src/engine/engine.js';
import { createRng } from '../src/engine/dice.js';

test('shared rewards - divides gold and XP equally with deterministic integer remainder distribution', () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  const playerRepo = new PlayerRepository(db);
  const now = 1000000;

  // Setup 3 players in DB
  playerRepo.upsertPlayer('testchannel', 'alice', 'Alice');
  playerRepo.upsertPlayer('testchannel', 'bob', 'Bob');
  playerRepo.upsertPlayer('testchannel', 'charlie', 'Charlie');

  const party = new Map([
    ['alice', { username: 'alice', displayName: 'Alice', hp: 20, maxHp: 20, isKnockedOut: false, lastSeenAt: now }],
    ['bob', { username: 'bob', displayName: 'Bob', hp: 20, maxHp: 20, isKnockedOut: false, lastSeenAt: now }],
    ['charlie', { username: 'charlie', displayName: 'Charlie', hp: 20, maxHp: 20, isKnockedOut: false, lastSeenAt: now }]
  ]);

  const adv = new Adventure({
    channel: 'testchannel',
    clock: () => now,
    playerRepo
  });

  // Distribute 100 XP and 50 gold among 3 players
  // 100 / 3 = 33 r 1 -> Alice gets 34, Bob gets 33, Charlie gets 33
  // 50 / 3 = 16 r 2 -> Alice gets 17, Bob gets 17, Charlie gets 16
  const events = adv.distributeRewards({ xp: 100, gold: 50, monstersSlain: 1 }, party, now);

  assert.ok(events.length >= 2);
  const sayEvent = events.find(e => e.kind === 'say' && e.text.includes('Rewards shared!'));
  assert.ok(sayEvent);
  assert.match(sayEvent.text, /100 XP and 50 gold split among 3 active heroes/);

  const pAlice = playerRepo.getPlayer('testchannel', 'alice');
  const pBob = playerRepo.getPlayer('testchannel', 'bob');
  const pCharlie = playerRepo.getPlayer('testchannel', 'charlie');

  assert.equal(pAlice.xp, 34);
  assert.equal(pAlice.gold, 17);
  assert.equal(pAlice.monsters_slain, 1);

  assert.equal(pBob.xp, 33);
  assert.equal(pBob.gold, 17);
  assert.equal(pBob.monsters_slain, 1);

  assert.equal(pCharlie.xp, 33);
  assert.equal(pCharlie.gold, 16);
  assert.equal(pCharlie.monsters_slain, 1);
});

test('shared rewards - inactive (outside 15m) viewers get nothing; active KO members get share', () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  const playerRepo = new PlayerRepository(db);
  const now = 1000000;

  playerRepo.upsertPlayer('testchannel', 'active_hero', 'ActiveHero');
  playerRepo.upsertPlayer('testchannel', 'ko_hero', 'KoHero');
  playerRepo.upsertPlayer('testchannel', 'inactive_lurker', 'InactiveLurker');

  const party = new Map([
    // Active player (spoke 1m ago)
    ['active_hero', { username: 'active_hero', displayName: 'ActiveHero', hp: 20, maxHp: 20, isKnockedOut: false, lastSeenAt: now - 60000 }],
    // Active KO player (spoke 5m ago, but knocked out)
    ['ko_hero', { username: 'ko_hero', displayName: 'KoHero', hp: 0, maxHp: 20, isKnockedOut: true, lastSeenAt: now - 300000 }],
    // Inactive player (spoke 20m ago)
    ['inactive_lurker', { username: 'inactive_lurker', displayName: 'InactiveLurker', hp: 20, maxHp: 20, isKnockedOut: false, lastSeenAt: now - 20 * 60 * 1000 }]
  ]);

  const adv = new Adventure({
    channel: 'testchannel',
    clock: () => now,
    playerRepo
  });

  // Distribute 60 XP and 40 gold -> split only across 2 active members (30 XP, 20 gold each)
  adv.distributeRewards({ xp: 60, gold: 40, monstersSlain: 1 }, party, now);

  const pActive = playerRepo.getPlayer('testchannel', 'active_hero');
  const pKo = playerRepo.getPlayer('testchannel', 'ko_hero');
  const pInactive = playerRepo.getPlayer('testchannel', 'inactive_lurker');

  assert.equal(pActive.xp, 30);
  assert.equal(pActive.gold, 20);
  assert.equal(pActive.monsters_slain, 1);

  assert.equal(pKo.xp, 30);
  assert.equal(pKo.gold, 20);
  assert.equal(pKo.monsters_slain, 1);

  assert.equal(pInactive.xp, 0);
  assert.equal(pInactive.gold, 0);
  assert.equal(pInactive.monsters_slain, 0);
});

test('shared rewards - level up event is emitted when reward crosses monotonic threshold', () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  const playerRepo = new PlayerRepository(db);
  const now = 1000000;

  // Starts with 80 XP (Level 1)
  playerRepo.upsertPlayer('testchannel', 'grinder', 'Grinder');
  playerRepo.addRewards('testchannel', 'grinder', { xp: 80 });

  const party = new Map([
    ['grinder', { username: 'grinder', displayName: 'Grinder', hp: 20, maxHp: 20, isKnockedOut: false, lastSeenAt: now }]
  ]);

  const adv = new Adventure({
    channel: 'testchannel',
    clock: () => now,
    playerRepo
  });

  // Grant 30 XP -> total 110 XP -> crosses 100 XP -> Level 2
  const events = adv.distributeRewards({ xp: 30, gold: 10 }, party, now);

  const lvlUpEvent = events.find(e => e.kind === 'game' && e.type === 'player_level_up');
  assert.ok(lvlUpEvent);
  assert.equal(lvlUpEvent.level, 2);
  assert.equal(lvlUpEvent.xp, 110);

  const p = playerRepo.getPlayer('testchannel', 'grinder');
  assert.equal(p.level, 2);
  assert.equal(p.xp, 110);
});

test('shared rewards - monster defeat in combat integration distributes rewards and persists across reopen', async () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  let mockTime = 1000000;
  const engine = new Engine({
    db,
    channel: 'bosschannel',
    clock: () => mockTime,
    rng: createRng(777)
  });

  engine.startThemeVote();
  mockTime += 61000;
  engine.handleMessage({ user: 'warrior1', displayName: 'WarriorOne', text: '!vote 1' });
  engine.handleMessage({ user: 'warrior2', displayName: 'WarriorTwo', text: '!vote 1' });

  // Fast forward room to a monster room
  engine.adventure.currentRoom = {
    id: 3,
    roomNumber: 3,
    type: 'monster',
    name: 'Goblin Nest',
    exits: [{ direction: 'north', targetRoomId: 4 }],
    monster: {
      name: 'Goblin Chief',
      hp: 10,
      maxHp: 10,
      attack: 2,
      defense: 5,
      xp: 80,
      gold: 50,
      loot: 'potion'
    },
    exploration: { searched: false, hasLoot: false, loot: null }
  };

  // Start combat
  const { CombatResolver } = await import('../src/engine/combat.js');
  engine.adventure.combat = new CombatResolver({
    clock: () => mockTime,
    rng: () => 0.99 // High rolls
  });

  // Both warriors attack
  engine.handleMessage({ user: 'warrior1', displayName: 'WarriorOne', text: '!attack' });
  engine.handleMessage({ user: 'warrior2', displayName: 'WarriorTwo', text: '!attack' });

  // Advance time past combat round
  mockTime += 61000;
  const roundEvents = engine.tick(mockTime);

  const defeatEvent = roundEvents.find(e => e.kind === 'game' && e.type === 'monster_defeated');
  assert.ok(defeatEvent);
  assert.equal(defeatEvent.monster, 'Goblin Chief');

  // Verify rewards distributed in DB
  const playerRepo = new PlayerRepository(db);
  const w1 = playerRepo.getPlayer('bosschannel', 'warrior1');
  const w2 = playerRepo.getPlayer('bosschannel', 'warrior2');

  // 80 XP / 2 = 40 each, 50 gold / 2 = 25 each
  assert.equal(w1.xp, 40);
  assert.equal(w1.gold, 25);
  assert.equal(w1.monsters_slain, 1);

  assert.equal(w2.xp, 40);
  assert.equal(w2.gold, 25);
  assert.equal(w2.monsters_slain, 1);
});
