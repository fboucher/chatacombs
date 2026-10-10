import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine/engine.js';
import { createRng } from '../src/engine/dice.js';

test('room traversal - explore treasure room grants loot and prevents duplicate search', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    rng: createRng(123),
    clock: () => fakeTime,
    voteDurationMs: 60000
  });

  // Start adventure and auto-advance to active
  engine.startThemeVote();
  fakeTime += 60001;
  engine.tick(fakeTime);

  // Manually configure current room as a treasure room for testing
  engine.adventure.currentRoom = {
    id: 5,
    roomNumber: 5,
    type: 'treasure',
    name: 'Glittering Vault',
    exits: [{ direction: 'north', targetRoomId: 6 }],
    monster: null,
    exploration: {
      searched: false,
      hasLoot: true,
      loot: { gold: 50, item: 'potion' },
      hasTrap: false,
      trap: null,
      secretExit: null
    }
  };

  const res1 = engine.handleMessage({
    user: 'alice',
    displayName: 'Alice',
    text: '!explore'
  });

  assert.equal(res1.events.length, 2);
  const say = res1.events.find(e => e.kind === 'say');
  assert.match(say.text, /50 gold and found a potion/);
  const lootEvent = res1.events.find(e => e.kind === 'game' && e.type === 'rare_loot');
  assert.ok(lootEvent);
  assert.equal(lootEvent.gold, 50);
  assert.equal(lootEvent.item, 'potion');

  // Second explore in same room informs party that chamber is already searched
  const res2 = engine.handleMessage({
    user: 'bob',
    displayName: 'Bob',
    text: '!explore'
  });
  assert.equal(res2.events.length, 1);
  assert.match(res2.events[0].text, /already been searched/);
});

test('room traversal - explore trap room triggers damage and knockout on save failure', () => {
  let fakeTime = 1000;
  // Use RNG that rolls low on d20 (e.g. 0.05 -> roll = 2)
  const mockRng = () => 0.05;
  const engine = new Engine({
    rng: mockRng,
    clock: () => fakeTime
  });

  engine.startThemeVote();
  fakeTime += 60001;
  engine.tick(fakeTime);

  // Set up low HP party member
  const player = engine.trackChatter('victim', 'Victim');
  player.hp = 5;

  engine.adventure.currentRoom = {
    id: 7,
    roomNumber: 7,
    type: 'trap',
    name: 'Chamber of Spikes',
    exits: [{ direction: 'east', targetRoomId: 8 }],
    monster: null,
    exploration: {
      searched: false,
      hasLoot: false,
      loot: null,
      hasTrap: true,
      trap: { name: 'Spiked Pit', dc: 15, damage: 10 },
      secretExit: null
    }
  };

  const res = engine.handleMessage({
    user: 'victim',
    displayName: 'Victim',
    text: '!explore'
  });

  assert.equal(player.hp, 0);
  assert.equal(player.isKnockedOut, true);
  const koEvent = res.events.find(e => e.kind === 'game' && e.type === 'player_knocked_out');
  assert.ok(koEvent);
  assert.equal(koEvent.user, 'victim');
});

test('room traversal - !go opens 1-minute vote and resolves majority', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    rng: createRng(999),
    clock: () => fakeTime,
    voteDurationMs: 60000
  });

  engine.startThemeVote();
  fakeTime += 60001;
  engine.tick(fakeTime);

  // Set up room with 2 exits
  const room1 = engine.adventure.currentRoom;
  const targetIdNorth = room1.exits[0].targetRoomId;
  room1.exits = [
    { direction: 'north', targetRoomId: targetIdNorth },
    { direction: 'east', targetRoomId: engine.adventure.dungeon.rooms[2].id }
  ];

  // Alice votes north (opens vote)
  const res1 = engine.handleMessage({ user: 'alice', displayName: 'Alice', text: '!go north' });
  assert.equal(res1.events.length, 1);
  assert.match(res1.events[0].text, /Exit vote open/);
  assert.ok(engine.getState().exitVote !== null);

  // Bob votes east
  engine.handleMessage({ user: 'bob', displayName: 'Bob', text: '!go east' });
  // Charlie votes east
  engine.handleMessage({ user: 'charlie', displayName: 'Charlie', text: '!go east' });

  // Advance clock past 60s
  fakeTime += 60001;
  const tickEvents = engine.tick(fakeTime);

  // Majority (east: 2 vs north: 1) wins
  const roomEntered = tickEvents.find(e => e.kind === 'game' && e.type === 'room_entered');
  assert.ok(roomEntered);
  assert.equal(engine.getState().currentRoom.id, room1.exits[1].targetRoomId);
  assert.equal(engine.getState().exitVote, null);
});

test('room traversal - ties in exit vote go to the first exit voted for', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    rng: createRng(888),
    clock: () => fakeTime,
    voteDurationMs: 60000
  });

  engine.startThemeVote();
  fakeTime += 60001;
  engine.tick(fakeTime);

  const room = engine.adventure.currentRoom;
  room.exits = [
    { direction: 'north', targetRoomId: engine.adventure.dungeon.rooms[1].id },
    { direction: 'west', targetRoomId: engine.adventure.dungeon.rooms[2].id }
  ];

  // Alice votes north first
  engine.handleMessage({ user: 'alice', displayName: 'Alice', text: '!go north' });
  // Bob votes west (now tied 1 - 1)
  engine.handleMessage({ user: 'bob', displayName: 'Bob', text: '!go west' });

  fakeTime += 60001;
  const tickEvents = engine.tick(fakeTime);

  // North was voted first, so north wins the tie
  const sayMove = tickEvents.find(e => e.kind === 'say' && e.text.includes('moves north'));
  assert.ok(sayMove);
  assert.equal(engine.getState().currentRoom.id, room.exits[0].targetRoomId);
});

test('room traversal - room change revives knocked-out players at low HP', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    rng: createRng(777),
    clock: () => fakeTime,
    voteDurationMs: 60000
  });

  engine.startThemeVote();
  fakeTime += 60001;
  engine.tick(fakeTime);

  // KO a player
  const player = engine.trackChatter('faintguy', 'FaintGuy');
  player.hp = 0;
  player.isKnockedOut = true;

  const room = engine.adventure.currentRoom;
  const exitDir = room.exits[0].direction;

  engine.handleMessage({ user: 'alice', displayName: 'Alice', text: `!go ${exitDir}` });
  fakeTime += 60001;
  engine.tick(fakeTime);

  // Player should be revived at low HP (5 HP)
  assert.equal(player.isKnockedOut, false);
  assert.equal(player.hp, 5);
});
