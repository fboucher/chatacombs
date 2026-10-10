import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDungeon, canReach } from '../src/engine/generator.js';
import { createRng } from '../src/engine/dice.js';

test('generator - produces between 10 and 15 rooms by default', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const dungeon = generateDungeon({ rng: createRng(seed) });
    assert.ok(dungeon.totalRooms >= 10 && dungeon.totalRooms <= 15, `Total rooms ${dungeon.totalRooms} out of 10..15 range`);
    assert.equal(dungeon.rooms.length, dungeon.totalRooms);
  }
});

test('generator - respects explicit roomCount within 10..15', () => {
  const d12 = generateDungeon({ roomCount: 12, rng: createRng(55) });
  assert.equal(d12.totalRooms, 12);
  assert.equal(d12.rooms.length, 12);
});

test('generator - room 1 is entrance and room N is boss', () => {
  const dungeon = generateDungeon({ rng: createRng(101) });
  const entrance = dungeon.rooms[0];
  const boss = dungeon.rooms[dungeon.rooms.length - 1];

  assert.equal(entrance.id, 1);
  assert.equal(entrance.type, 'entrance');
  assert.equal(entrance.depth, 0);

  assert.equal(boss.id, dungeon.totalRooms);
  assert.equal(boss.type, 'boss');
  assert.ok(boss.depth > 0);
  assert.ok(boss.monster !== null);

  // Exactly one entrance and one boss
  const entranceCount = dungeon.rooms.filter(r => r.type === 'entrance').length;
  const bossCount = dungeon.rooms.filter(r => r.type === 'boss').length;
  assert.equal(entranceCount, 1);
  assert.equal(bossCount, 1);
});

test('generator - boss is reachable from entrance and from every non-boss room', () => {
  for (let seed = 10; seed <= 30; seed++) {
    const dungeon = generateDungeon({ rng: createRng(seed) });

    // Entrance reaches boss
    assert.ok(
      canReach(dungeon.rooms, dungeon.entranceId, dungeon.bossId),
      `Boss not reachable from entrance in seed ${seed}`
    );

    // Every non-boss room can eventually reach the boss
    for (const room of dungeon.rooms) {
      if (room.id !== dungeon.bossId) {
        assert.ok(
          canReach(dungeon.rooms, room.id, dungeon.bossId),
          `Room ${room.id} cannot reach boss in seed ${seed}`
        );
      }
    }
  }
});

test('generator - exit sanity: unique directions per room and valid target room IDs', () => {
  const dungeon = generateDungeon({ rng: createRng(42) });
  const roomIds = new Set(dungeon.rooms.map(r => r.id));

  for (const room of dungeon.rooms) {
    if (room.type !== 'boss') {
      assert.ok(room.exits.length > 0, `Non-boss room ${room.id} has no exits`);
    }

    const dirSet = new Set();
    for (const exit of room.exits) {
      assert.ok(!dirSet.has(exit.direction), `Room ${room.id} has duplicate exit direction '${exit.direction}'`);
      dirSet.add(exit.direction);
      assert.ok(roomIds.has(exit.targetRoomId), `Exit target ${exit.targetRoomId} does not exist in dungeon`);
      assert.notEqual(exit.targetRoomId, room.id, `Exit leads back to itself in room ${room.id}`);
    }
  }
});

test('generator - monster stats scale with depth', () => {
  const dungeon = generateDungeon({ roomCount: 14, rng: createRng(77) });
  const monsterRooms = dungeon.rooms.filter(r => r.type === 'monster').sort((a, b) => a.depth - b.depth);

  assert.ok(monsterRooms.length >= 1, 'Should have at least one monster room');
  const bossRoom = dungeon.rooms.find(r => r.type === 'boss');

  const shallowMonster = monsterRooms[0];
  const deepMonster = monsterRooms[monsterRooms.length - 1];

  // Deep monster should have higher or equal HP than shallow
  assert.ok(deepMonster.monster.hp >= shallowMonster.monster.hp);

  // Boss should have substantially higher HP than regular monsters
  assert.ok(bossRoom.monster.hp > deepMonster.monster.hp);
  assert.ok(bossRoom.monster.xp > deepMonster.monster.xp);
});

test('generator - room diversity: intermediate rooms contain monster, treasure, trap, empty', () => {
  const dungeon = generateDungeon({ rng: createRng(12345) });
  const types = new Set(dungeon.rooms.map(r => r.type));

  assert.ok(types.has('entrance'));
  assert.ok(types.has('boss'));
  assert.ok(types.has('monster'));
  assert.ok(types.has('treasure'));
  assert.ok(types.has('trap'));
  assert.ok(types.has('empty'));
});

test('generator - theme specific monsters are populated', () => {
  const legacyDungeon = generateDungeon({ theme: 'legacy codebase', rng: createRng(99) });
  const monsters = legacyDungeon.rooms.filter(r => r.monster).map(r => r.monster.name);
  assert.ok(monsters.length > 0);
  // Check that either minion or boss matches legacy theme roster
  const legacyNames = ['Spaghetti Routine', 'Merge Conflict', 'Memory Leak', 'Uncaught NullPointer', 'Unpinned Dependency', 'The Monolithic Technical Debt', 'The Ancient Production Outage', 'The Unrefactored Legacy Core'];
  const hasLegacyName = monsters.some(m => legacyNames.includes(m));
  assert.ok(hasLegacyName, `Expected legacy monster names, got: ${monsters.join(', ')}`);
});

test('generator - deterministic generation with fixed seed', () => {
  const d1 = generateDungeon({ theme: 'haunted house', roomCount: 12, rng: createRng(500) });
  const d2 = generateDungeon({ theme: 'haunted house', roomCount: 12, rng: createRng(500) });

  assert.deepEqual(d1, d2);
});
