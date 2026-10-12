import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, runMigrations } from '../src/db/database.js';
import { PartyRepository, INACTIVITY_WINDOW_MS } from '../src/db/partyRepo.js';
import { Engine } from '../src/engine/engine.js';
import { createRng } from '../src/engine/dice.js';

test('party repo - upserts chattering user and updates last_action_at', () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  // Setup adventure row
  db.prepare(`
    INSERT INTO adventures (channel, theme, status, total_rooms, current_room_index)
    VALUES ('testchannel', 'classic fantasy', 'active', 10, 0)
  `).run();

  const partyRepo = new PartyRepository(db);
  const now = 1700000000000;

  const row1 = partyRepo.upsertMember(1, 'alice', { hp: 20, maxHp: 20, potions: 1 }, now);
  assert.equal(row1.username, 'alice');
  assert.equal(row1.hp, 20);
  assert.equal(row1.potions, 1);
  assert.equal(new Date(row1.last_action_at).getTime(), now);

  // Second upsert refreshes last_action_at but preserves stats
  partyRepo.updateMemberState(1, 'alice', { hp: 14, potions: 0 });
  const later = now + 60000;
  const row2 = partyRepo.upsertMember(1, 'alice', { hp: 20, potions: 1 }, later);
  assert.equal(row2.hp, 14); // Preserved
  assert.equal(row2.potions, 0); // Preserved
  assert.equal(new Date(row2.last_action_at).getTime(), later);
});

test('party repo - 15-minute sliding window active party detection', () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  db.prepare(`
    INSERT INTO adventures (channel, theme, status, total_rooms, current_room_index)
    VALUES ('testchannel', 'cyberpunk vault', 'active', 12, 0)
  `).run();

  const partyRepo = new PartyRepository(db);
  const baseTime = 1700000000000;

  // Alice: active (1 minute ago)
  partyRepo.upsertMember(1, 'alice', {}, baseTime - 60000);
  // Bob: active (14 minutes ago)
  partyRepo.upsertMember(1, 'bob', {}, baseTime - 14 * 60 * 1000);
  // Charlie: inactive (16 minutes ago)
  partyRepo.upsertMember(1, 'charlie', {}, baseTime - 16 * 60 * 1000);

  const activeMembers = partyRepo.getActiveMembers(1, baseTime);
  const activeNames = activeMembers.map(m => m.username);

  assert.deepEqual(activeNames, ['alice', 'bob']);
  assert.ok(!activeNames.includes('charlie'));
});

test('party repo - HP, KO state and potion counts round-trip on fresh DB handle', () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  db.prepare(`
    INSERT INTO adventures (channel, theme, status, total_rooms, current_room_index)
    VALUES ('testchannel', 'pirate ship', 'active', 10, 0)
  `).run();

  const partyRepo = new PartyRepository(db);
  const now = 1700000000000;

  partyRepo.upsertMember(1, 'frank', { hp: 5, maxHp: 20, isKnockedOut: 1, potions: 0 }, now);
  partyRepo.upsertMember(1, 'elena', { hp: 18, maxHp: 20, isKnockedOut: 0, potions: 2 }, now);

  // Verify retrieval
  const frank = partyRepo.getMember(1, 'frank');
  assert.equal(frank.hp, 5);
  assert.equal(frank.is_knocked_out, 1);
  assert.equal(frank.potions, 0);

  const elena = partyRepo.getMember(1, 'elena');
  assert.equal(elena.hp, 18);
  assert.equal(elena.is_knocked_out, 0);
  assert.equal(elena.potions, 2);
});

test('party engine integration - real chatter message joins party and persists to DB', () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  let mockTime = 1000000;
  const engine = new Engine({
    db,
    channel: 'streamer',
    clock: () => mockTime,
    rng: createRng(42)
  });

  // Start theme vote and advance to active dungeon
  engine.startThemeVote();
  mockTime += 61000;
  engine.handleMessage({ user: 'alice', displayName: 'AliceInChat', text: 'hello world' });

  // Engine is now active
  assert.equal(engine.status, 'active');
  assert.ok(engine.adventure.id);

  // Bob chats
  mockTime += 1000;
  engine.handleMessage({ user: 'bob', displayName: 'BobTwitch', text: 'good luck party!' });

  // Verify both are tracked in engine state and DB party_members
  const active = engine.getActiveParty(mockTime);
  assert.equal(active.length, 2);

  const partyRepo = new PartyRepository(db);
  const dbMembers = partyRepo.getAllMembers(engine.adventure.id);
  assert.equal(dbMembers.length, 2);
  assert.deepEqual(dbMembers.map(m => m.username).sort(), ['alice', 'bob']);

  // Advance time past 15 minutes for Alice, but keep Bob active
  mockTime += 16 * 60 * 1000;
  engine.handleMessage({ user: 'bob', displayName: 'BobTwitch', text: 'still here!' });

  const activeAfterLull = engine.getActiveParty(mockTime);
  assert.equal(activeAfterLull.length, 1);
  assert.equal(activeAfterLull[0].username, 'bob');
});

test('party combat targeting - monsters only target players active within 15-minute window', async () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  let mockTime = 1000000;
  const engine = new Engine({
    db,
    channel: 'targetchannel',
    clock: () => mockTime,
    rng: createRng(12345)
  });

  engine.startThemeVote();
  mockTime += 61000;
  engine.handleMessage({ user: 'activeplayer', displayName: 'ActivePlayer', text: '!vote 1' });

  // Simulate an old inactive player added 20 minutes ago
  engine.trackChatter('silentlurker', 'SilentLurker');
  engine.state.party.get('silentlurker').lastSeenAt = mockTime - 20 * 60 * 1000;

  // Verify getActiveParty only has activeplayer
  const activeMembers = engine.getActiveParty(mockTime);
  assert.equal(activeMembers.length, 1);
  assert.equal(activeMembers[0].username, 'activeplayer');

  // If combat round resolves with monster attack, silentlurker must never be target
  const monster = { name: 'Cave Goblin', hp: 50, maxHp: 50, attack: 15, defense: 5 };
  const combatResolver = engine.adventure.combat || new (class {})();

  // Run combat round resolution directly
  const { CombatResolver } = await import('../src/engine/combat.js');
  const resolver = new CombatResolver({
    clock: () => mockTime,
    rng: () => 0.99 // forces monster attack target index
  });

  const res = resolver.resolveRound(monster, engine.state.party, mockTime);
  // Silent lurker HP should still be full 20
  const lurker = engine.state.party.get('silentlurker');
  assert.equal(lurker.hp, 20);
});

test('party crash recovery - active party state restores from database handle', () => {
  const db = createDatabase(':memory:');
  runMigrations(db);

  let mockTime = 1000000;
  const engine1 = new Engine({
    db,
    channel: 'rebootchannel',
    clock: () => mockTime,
    rng: createRng(99)
  });

  engine1.startThemeVote();
  mockTime += 61000;
  engine1.handleMessage({ user: 'hero1', displayName: 'HeroOne', text: 'let us go' });
  engine1.handleMessage({ user: 'hero2', displayName: 'HeroTwo', text: 'ready' });

  // Alter stats
  const h1 = engine1.state.party.get('hero1');
  h1.hp = 8;
  h1.potions = 0;
  engine1.adventure.syncMember(h1);

  const advId = engine1.adventure.id;
  assert.ok(advId);

  // Create second Engine instance pointing to same DB
  const engine2 = new Engine({
    db,
    channel: 'rebootchannel',
    clock: () => mockTime,
    rng: createRng(99)
  });

  const restored = engine2.restoreFromDb();
  assert.ok(restored);
  assert.equal(restored.id, advId);

  // Verify party is restored in engine2 state
  const restoredH1 = engine2.state.party.get('hero1');
  assert.ok(restoredH1);
  assert.equal(restoredH1.hp, 8);
  assert.equal(restoredH1.potions, 0);

  const restoredH2 = engine2.state.party.get('hero2');
  assert.ok(restoredH2);
  assert.equal(restoredH2.hp, 20);
});
