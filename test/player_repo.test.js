import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db/database.js';
import { PlayerRepository, calculateLevel } from '../src/db/playerRepo.js';
import { Engine } from '../src/engine/engine.js';
import fs from 'node:fs';
import path from 'node:path';

test('level curve - strictly monotonic and handles exact thresholds', () => {
  assert.equal(calculateLevel(0), 1);
  assert.equal(calculateLevel(99), 1);
  assert.equal(calculateLevel(100), 2);
  assert.equal(calculateLevel(249), 2);
  assert.equal(calculateLevel(250), 3);
  assert.equal(calculateLevel(449), 3);
  assert.equal(calculateLevel(450), 4);
  assert.equal(calculateLevel(699), 4);
  assert.equal(calculateLevel(700), 5);

  // Monotonic check across 0..5000 XP
  let prevLevel = 1;
  for (let xp = 0; xp <= 3000; xp += 25) {
    const lvl = calculateLevel(xp);
    assert.ok(lvl >= prevLevel, `Level decreased at XP ${xp}: ${lvl} < ${prevLevel}`);
    prevLevel = lvl;
  }
});

test('player repo - upserts chattering user without resetting accumulated progression', () => {
  const db = createDatabase(':memory:');
  const repo = new PlayerRepository(db);

  // First chat
  const p1 = repo.upsertPlayer('twitch', 'alice', 'Alice');
  assert.equal(p1.username, 'alice');
  assert.equal(p1.xp, 0);
  assert.equal(p1.level, 1);
  assert.equal(p1.gold, 0);

  // Give Alice some XP and gold
  repo.addRewards('twitch', 'alice', { xp: 150, gold: 50 });
  const updated = repo.getPlayer('twitch', 'alice');
  assert.equal(updated.xp, 150);
  assert.equal(updated.level, 2);
  assert.equal(updated.gold, 50);

  // Alice chats again later -> must NOT wipe progression
  const rechat = repo.upsertPlayer('twitch', 'alice', 'AliceTheGreat');
  assert.equal(rechat.display_name, 'AliceTheGreat');
  assert.equal(rechat.xp, 150);
  assert.equal(rechat.level, 2);
  assert.equal(rechat.gold, 50);

  db.close();
});

test('player repo - !hero returns persisted stats combined with live adventure HP', () => {
  const db = createDatabase(':memory:');
  const repo = new PlayerRepository(db);

  // Pre-seed player in DB
  repo.upsertPlayer('mychannel', 'gandalf', 'Gandalf');
  repo.addRewards('mychannel', 'gandalf', { xp: 300, gold: 80 });

  const engine = new Engine({
    channel: 'mychannel',
    db
  });

  // Track chatter and adjust live HP in current adventure
  const member = engine.trackChatter('gandalf', 'Gandalf');
  member.hp = 14;
  member.potions = 2;

  const res = engine.handleMessage({
    user: 'gandalf',
    displayName: 'Gandalf',
    text: '!hero'
  });

  assert.equal(res.events.length, 2);
  const say = res.events.find(e => e.kind === 'say');
  assert.match(say.text, /@Gandalf \(Lvl 3\) \| HP: 14\/20 \| Gold: 80 \| XP: 300 \| Potions: 2/);

  const heroEvent = res.events.find(e => e.kind === 'game' && e.type === 'hero_stats');
  assert.ok(heroEvent);
  assert.equal(heroEvent.level, 3);
  assert.equal(heroEvent.xp, 300);
  assert.equal(heroEvent.gold, 80);
  assert.equal(heroEvent.hp, 14);

  db.close();
});

test('player repo - persists progression across disk reopen (simulating restart)', () => {
  const tmpDbPath = path.resolve('./test-player-restart.db');
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);

  // Open first DB handle and write progression
  const db1 = createDatabase(tmpDbPath);
  const repo1 = new PlayerRepository(db1);
  repo1.upsertPlayer('streamer', 'veteran', 'Veteran');
  repo1.addRewards('streamer', 'veteran', { xp: 500, gold: 120, monstersSlain: 3 });
  db1.close();

  // Re-open with a brand new DB handle
  const db2 = createDatabase(tmpDbPath);
  const repo2 = new PlayerRepository(db2);
  const restored = repo2.getPlayer('streamer', 'veteran');

  assert.ok(restored);
  assert.equal(restored.username, 'veteran');
  assert.equal(restored.xp, 500);
  assert.equal(restored.level, 4); // 500 XP is Level 4
  assert.equal(restored.gold, 120);
  assert.equal(restored.monsters_slain, 3);

  db2.close();
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  // Clean up WAL/SHM files if created
  if (fs.existsSync(`${tmpDbPath}-wal`)) fs.unlinkSync(`${tmpDbPath}-wal`);
  if (fs.existsSync(`${tmpDbPath}-shm`)) fs.unlinkSync(`${tmpDbPath}-shm`);
});
