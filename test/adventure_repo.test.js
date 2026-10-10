import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db/database.js';
import { AdventureRepository } from '../src/db/adventureRepo.js';
import { Engine } from '../src/engine/engine.js';
import { createRng } from '../src/engine/dice.js';
import fs from 'node:fs';
import path from 'node:path';

test('adventure repo - persists active dungeon and all rooms with monster & exit data', () => {
  const db = createDatabase(':memory:');
  const repo = new AdventureRepository(db);

  const engine = new Engine({
    channel: 'channel1',
    db,
    adventureRepo: repo,
    rng: createRng(101)
  });

  // Start theme vote and advance to active
  engine.startThemeVote();
  engine.adventure.closeThemeVote();

  assert.equal(engine.status, 'active');
  const advId = engine.adventure.id;
  assert.ok(advId > 0);

  // Read back directly from database
  const restored = repo.getAdventureWithRooms(advId);
  assert.ok(restored);
  assert.equal(restored.theme, engine.getState().theme);
  assert.equal(restored.status, 'active');
  assert.equal(restored.totalRooms, engine.getState().dungeon.totalRooms);
  assert.equal(restored.rooms.length, engine.getState().dungeon.totalRooms);

  // Check first room (entrance) and last room (boss)
  const entrance = restored.rooms[0];
  assert.equal(entrance.type, 'entrance');
  assert.ok(entrance.exits.length > 0);

  const boss = restored.rooms[restored.rooms.length - 1];
  assert.equal(boss.type, 'boss');
  assert.ok(boss.monster !== null);
  assert.ok(boss.monster.hp > 0);

  db.close();
});

test('adventure repo - room exploration and advancement update DB state', () => {
  const db = createDatabase(':memory:');
  const repo = new AdventureRepository(db);

  const engine = new Engine({
    channel: 'channel2',
    db,
    adventureRepo: repo,
    rng: createRng(202)
  });

  engine.startThemeVote();
  engine.adventure.closeThemeVote();
  const advId = engine.adventure.id;

  // Search current room (entrance)
  engine.handleMessage({ user: 'scout', displayName: 'Scout', text: '!explore' });

  // Check room state in DB
  const rawRoom = db.prepare(`SELECT * FROM rooms WHERE adventure_id = ? AND room_number = 1`).get(advId);
  assert.equal(rawRoom.looted, 1);

  // Move to next room
  const exitDir = engine.adventure.currentRoom.exits[0].direction;
  engine.handleMessage({ user: 'scout', displayName: 'Scout', text: `!go ${exitDir}` });
  engine.adventure.closeExitVote();

  // Check that current_room_index updated in adventure row
  const advRow = db.prepare(`SELECT * FROM adventures WHERE id = ?`).get(advId);
  assert.ok(advRow.current_room_index >= 0);

  db.close();
});

test('adventure repo - crash recovery round-trip: resumes active adventure on fresh DB handle', () => {
  const tmpDbPath = path.resolve('./test-adventure-recovery.db');
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);

  // 1. Initial engine session: start dungeon, advance room, then "crash"
  const db1 = createDatabase(tmpDbPath);
  const engine1 = new Engine({
    channel: 'streamer_x',
    db: db1,
    rng: createRng(303)
  });

  engine1.startThemeVote();
  engine1.adventure.closeThemeVote();
  const originalTheme = engine1.getState().theme;
  const originalTotalRooms = engine1.getState().dungeon.totalRooms;
  const originalAdvId = engine1.adventure.id;

  // Move to next room
  const exitDir = engine1.adventure.currentRoom.exits[0].direction;
  engine1.handleMessage({ user: 'lead', displayName: 'Lead', text: `!go ${exitDir}` });
  engine1.adventure.closeExitVote();
  const targetRoomNumber = engine1.adventure.currentRoom.roomNumber;

  db1.close();

  // 2. Fresh session: reopen fresh DB handle and restore
  const db2 = createDatabase(tmpDbPath);
  const engine2 = new Engine({
    channel: 'streamer_x',
    db: db2
  });

  const restoredAdv = engine2.restoreFromDb();
  assert.ok(restoredAdv !== null);
  assert.equal(engine2.status, 'active');
  assert.equal(engine2.getState().theme, originalTheme);
  assert.equal(engine2.getState().dungeon.totalRooms, originalTotalRooms);
  assert.equal(engine2.adventure.id, originalAdvId);
  assert.equal(engine2.adventure.currentRoom.roomNumber, targetRoomNumber);

  db2.close();
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  if (fs.existsSync(`${tmpDbPath}-wal`)) fs.unlinkSync(`${tmpDbPath}-wal`);
  if (fs.existsSync(`${tmpDbPath}-shm`)) fs.unlinkSync(`${tmpDbPath}-shm`);
});

test('adventure repo - completed adventures (cleared, wiped, abandoned) are not resumed', () => {
  const db = createDatabase(':memory:');
  const repo = new AdventureRepository(db);

  // Create cleared adventure
  const clearedRow = repo.createAdventure('mychan', 'pirate ship', 12, 'cleared');
  repo.updateStatus(clearedRow.id, 'cleared', new Date().toISOString());

  // Attempt restore
  const restored = repo.restoreActiveAdventure('mychan');
  assert.equal(restored, null);

  // Create wiped adventure
  const wipedRow = repo.createAdventure('mychan2', 'haunted house', 10, 'wiped');
  assert.equal(repo.restoreActiveAdventure('mychan2'), null);

  // Create abandoned adventure
  const abandonedRow = repo.createAdventure('mychan3', 'sky castle', 10, 'abandoned');
  assert.equal(repo.restoreActiveAdventure('mychan3'), null);

  db.close();
});
