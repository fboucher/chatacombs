import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, runMigrations } from '../src/db/database.js';

test('database - boots in-memory and creates all schema tables and indices', () => {
  const db = createDatabase(':memory:');

  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all().map(r => r.name);

  assert.deepEqual(tables, ['adventures', 'party_members', 'players', 'rooms']);

  db.close();
});

test('database - players table schema matches PLAN.md specifications', () => {
  const db = createDatabase(':memory:');

  const columns = db.prepare(`PRAGMA table_info(players)`).all();
  const colNames = columns.map(c => c.name);

  assert.ok(colNames.includes('id'));
  assert.ok(colNames.includes('channel'));
  assert.ok(colNames.includes('username'));
  assert.ok(colNames.includes('display_name'));
  assert.ok(colNames.includes('xp'));
  assert.ok(colNames.includes('level'));
  assert.ok(colNames.includes('gold'));
  assert.ok(colNames.includes('adventures_joined'));
  assert.ok(colNames.includes('monsters_slain'));
  assert.ok(colNames.includes('last_seen_at'));
  assert.ok(colNames.includes('created_at'));

  // Test unique constraint on (channel, username)
  db.prepare(`
    INSERT INTO players (channel, username, display_name) VALUES ('twitch', 'alice', 'Alice')
  `).run();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO players (channel, username, display_name) VALUES ('twitch', 'alice', 'Alice2')
    `).run();
  }, /UNIQUE constraint failed/);

  db.close();
});

test('database - adventures and rooms foreign key relations and room unique constraint', () => {
  const db = createDatabase(':memory:');

  // Insert adventure
  const advRes = db.prepare(`
    INSERT INTO adventures (channel, theme, status, total_rooms) VALUES ('mychan', 'classic fantasy', 'active', 10)
  `).run();
  const advId = advRes.lastInsertRowid;

  // Insert room
  db.prepare(`
    INSERT INTO rooms (adventure_id, room_number, room_type, name, exits)
    VALUES (?, 1, 'entrance', 'Entryway', '["north"]')
  `).run(advId);

  // Duplicate (adventure_id, room_number) must fail
  assert.throws(() => {
    db.prepare(`
      INSERT INTO rooms (adventure_id, room_number, room_type, name, exits)
      VALUES (?, 1, 'treasure', 'Vault', '["south"]')
    `).run(advId);
  }, /UNIQUE constraint failed/);

  // Foreign key failure when inserting room with invalid adventure_id
  assert.throws(() => {
    db.prepare(`
      INSERT INTO rooms (adventure_id, room_number, room_type, name, exits)
      VALUES (9999, 2, 'empty', 'Void', '["north"]')
    `).run();
  }, /FOREIGN KEY constraint failed/);

  db.close();
});

test('database - party_members uniqueness on (adventure_id, username)', () => {
  const db = createDatabase(':memory:');

  const advRes = db.prepare(`
    INSERT INTO adventures (channel, theme, status, total_rooms) VALUES ('chan', 'haunted house', 'active', 12)
  `).run();
  const advId = advRes.lastInsertRowid;

  db.prepare(`
    INSERT INTO party_members (adventure_id, username, hp, max_hp) VALUES (?, 'bob', 20, 20)
  `).run(advId);

  assert.throws(() => {
    db.prepare(`
      INSERT INTO party_members (adventure_id, username, hp, max_hp) VALUES (?, 'bob', 15, 20)
    `).run(advId);
  }, /UNIQUE constraint failed/);

  db.close();
});

test('database - migrations are idempotent when called repeatedly', () => {
  const db = createDatabase(':memory:');
  // Re-run migrations
  assert.doesNotThrow(() => {
    runMigrations(db);
    runMigrations(db);
  });
  db.close();
});
