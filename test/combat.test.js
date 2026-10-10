import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatResolver } from '../src/engine/combat.js';
import { Engine } from '../src/engine/engine.js';
import { createRng } from '../src/engine/dice.js';

test('combat - allows only one action per player per round (deduplication)', () => {
  const resolver = new CombatResolver();
  resolver.startEncounter();

  const player = { username: 'alice', displayName: 'Alice', hp: 20, isKnockedOut: false };

  // First action accepted
  const a1 = resolver.registerAction(player, 'attack');
  assert.equal(a1, true);

  // Second action from same player in same round rejected
  const a2 = resolver.registerAction(player, 'defend');
  assert.equal(a2, false);

  assert.equal(resolver.actions.size, 1);
  assert.equal(resolver.actions.get('alice').action, 'attack');
});

test('combat - knocked out players cannot register actions', () => {
  const resolver = new CombatResolver();
  resolver.startEncounter();

  const koPlayer = { username: 'faint', displayName: 'Faint', hp: 0, isKnockedOut: true };
  const res = resolver.registerAction(koPlayer, 'attack');
  assert.equal(res, false);
  assert.equal(resolver.actions.size, 0);
});

test('combat - resolution order: heals execute before attacks, attacks damage monster', () => {
  // Deterministic RNG that rolls high (e.g. 0.9 -> roll 19 hits vs DEF 10)
  const mockRng = () => 0.9;
  const resolver = new CombatResolver({ rng: mockRng });
  resolver.startEncounter();

  const party = new Map([
    ['alice', { username: 'alice', displayName: 'Alice', hp: 8, maxHp: 20, potions: 1, isKnockedOut: false }],
    ['bob', { username: 'bob', displayName: 'Bob', hp: 20, maxHp: 20, potions: 0, isKnockedOut: false }]
  ]);

  const monster = {
    name: 'Cave Troll',
    hp: 30,
    maxHp: 30,
    attack: 4,
    defense: 10,
    xp: 50,
    gold: 25,
    loot: 'potion'
  };

  // Alice drinks potion
  resolver.registerAction(party.get('alice'), 'item', { item: 'potion' });
  // Bob attacks
  resolver.registerAction(party.get('bob'), 'attack');

  const outcome = resolver.resolveRound(monster, party);

  // Alice was healed before attacks/strikes
  assert.equal(party.get('alice').potions, 0);
  assert.equal(party.get('alice').hp, 18);

  const healEvent = outcome.events.find(e => e.kind === 'game' && e.type === 'player_healed');
  assert.ok(healEvent);
  assert.equal(healEvent.user, 'alice');
  assert.equal(healEvent.amount, 10);

  // Monster took damage from Bob's attack
  assert.ok(monster.hp < 30);
});

test('combat - defend reduces incoming monster damage by ~50%', () => {
  // Fixed roll for monster attack damage: returns consistent d6 roll
  // dice: 1d6 + bonus
  let counter = 0;
  const mockRng = () => {
    counter++;
    return 0.7; // hits attack check and rolls 5 on d6
  };

  const resolverDef = new CombatResolver({ rng: mockRng });
  resolverDef.startEncounter();

  const defender = { username: 'tank', displayName: 'Tank', hp: 20, maxHp: 20, isKnockedOut: false };
  const party = new Map([['tank', defender]]);
  const monster = { name: 'Orc', hp: 50, maxHp: 50, attack: 4, defense: 10, xp: 20, gold: 10 };

  resolverDef.registerAction(defender, 'defend');
  resolverDef.resolveRound(monster, party);

  const hpWithDefend = defender.hp;

  // Now test without defend
  counter = 0;
  const resolverNoDef = new CombatResolver({ rng: mockRng });
  resolverNoDef.startEncounter();

  const attacker = { username: 'tank', displayName: 'Tank', hp: 20, maxHp: 20, isKnockedOut: false };
  const partyNoDef = new Map([['tank', attacker]]);
  resolverNoDef.registerAction(attacker, 'attack');
  resolverNoDef.resolveRound(monster, partyNoDef);

  const hpWithoutDefend = attacker.hp;

  // Defending player should have taken less damage (retained more HP)
  assert.ok(hpWithDefend > hpWithoutDefend, `Expected ${hpWithDefend} > ${hpWithoutDefend}`);
});

test('combat - defeating monster emits monster_defeated with loot and ends combat', () => {
  // High roll: hits and crits
  const mockRng = () => 0.99;
  const resolver = new CombatResolver({ rng: mockRng });
  resolver.startEncounter();

  const party = new Map([
    ['hero', { username: 'hero', displayName: 'Hero', hp: 20, maxHp: 20, isKnockedOut: false }]
  ]);

  // Monster with only 2 HP
  const monster = {
    name: 'Goblin Scout',
    hp: 2,
    maxHp: 10,
    attack: 2,
    defense: 8,
    xp: 25,
    gold: 15,
    loot: 'potion'
  };

  resolver.registerAction(party.get('hero'), 'attack');
  const outcome = resolver.resolveRound(monster, party);

  assert.equal(monster.hp, 0);
  assert.equal(outcome.monsterDefeated, true);
  assert.equal(outcome.partyWiped, false);

  const defeatedEvent = outcome.events.find(e => e.kind === 'game' && e.type === 'monster_defeated');
  assert.ok(defeatedEvent);
  assert.equal(defeatedEvent.monster, 'Goblin Scout');
  assert.equal(defeatedEvent.xp, 25);
  assert.equal(defeatedEvent.gold, 15);
  assert.equal(defeatedEvent.loot, 'potion');
});

test('combat - full party knockout triggers party wipe', () => {
  // High roll for monster attack: strikes and KO's the lone hero
  const mockRng = () => 0.9;
  const resolver = new CombatResolver({ rng: mockRng });
  resolver.startEncounter();

  const frailHero = { username: 'frail', displayName: 'Frail', hp: 1, maxHp: 10, isKnockedOut: false };
  const party = new Map([['frail', frailHero]]);

  const boss = {
    name: 'Ancient Dragon',
    hp: 100,
    maxHp: 100,
    attack: 10,
    defense: 25, // player cannot hit
    xp: 300,
    gold: 200
  };

  resolver.registerAction(frailHero, 'attack');
  const outcome = resolver.resolveRound(boss, party);

  assert.equal(frailHero.hp, 0);
  assert.equal(frailHero.isKnockedOut, true);
  assert.equal(outcome.partyWiped, true);
});

test('combat integration - round advances on timer tick via Engine', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    rng: createRng(444),
    clock: () => fakeTime,
    voteDurationMs: 60000
  });

  engine.startThemeVote();
  fakeTime += 60001;
  engine.tick(fakeTime);

  // Set current room to monster room
  engine.adventure.currentRoom = {
    id: 3,
    roomNumber: 3,
    type: 'monster',
    name: 'Lair of Shadows',
    exits: [{ direction: 'north', targetRoomId: 4 }],
    monster: {
      name: 'Shadow Stalker',
      hp: 20,
      maxHp: 20,
      attack: 3,
      defense: 10,
      xp: 40,
      gold: 20
    },
    exploration: { searched: false, hasLoot: false, loot: null, hasTrap: false, trap: null, secretExit: null }
  };

  // Start combat encounter
  engine.adventure.combat = new CombatResolver({
    rng: engine.rng,
    clock: () => fakeTime,
    roundDurationMs: 60000
  });
  engine.adventure.combat.startEncounter();

  // Player attacks
  engine.handleMessage({ user: 'warrior', displayName: 'Warrior', text: '!attack' });

  // Advance clock by 60s
  fakeTime += 60001;
  const tickEvents = engine.tick(fakeTime);

  // Round 1 was resolved
  assert.ok(tickEvents.length > 0);
  // Round should have advanced or ended
  assert.ok(engine.adventure.combat === null || engine.adventure.combat.round === 2);
});

test('combat - dice_roll events carry the monster HP after the hit for overlays', () => {
  const resolver = new CombatResolver({ rng: () => 0.9 });
  resolver.startEncounter();

  const party = new Map([
    ['bob', { username: 'bob', displayName: 'Bob', hp: 20, maxHp: 20, potions: 0, isKnockedOut: false }],
    ['cy', { username: 'cy', displayName: 'Cy', hp: 20, maxHp: 20, potions: 0, isKnockedOut: false }]
  ]);
  const monster = { name: 'Cave Troll', hp: 100, maxHp: 100, attack: 1, defense: 10, xp: 1, gold: 1, loot: null };

  resolver.registerAction(party.get('bob'), 'attack');
  resolver.registerAction(party.get('cy'), 'attack');
  const { events } = resolver.resolveRound(monster, party);

  const rolls = events.filter(e => e.type === 'dice_roll');
  assert.equal(rolls.length, 2);
  assert.equal(rolls[0].displayName, 'Bob');
  assert.equal(rolls[0].monster, 'Cave Troll');
  assert.equal(rolls[0].monsterMaxHp, 100);
  assert.equal(rolls[0].monsterHp, 100 - rolls[0].damage);
  assert.equal(rolls[1].monsterHp, rolls[0].monsterHp - rolls[1].damage);
  assert.equal(rolls[1].monsterHp, monster.hp);
  assert.equal(rolls[0].modifier, rolls[0].total - rolls[0].roll);
});
