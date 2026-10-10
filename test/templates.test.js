import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NarrationTemplates, formatChatMessages, MAX_TWITCH_MSG_LEN } from '../src/ai/templates.js';

test('templates - formatChatMessages limits output to at most 2 messages under character limit', () => {
  const short = formatChatMessages(['First message', 'Second message', 'Third message dropped']);
  assert.equal(short.length, 2);
  assert.equal(short[0], 'First message');
  assert.equal(short[1], 'Second message');

  const massive = 'A'.repeat(1200);
  const formatted = formatChatMessages(massive);
  assert.equal(formatted.length, 2);
  assert.ok(formatted[0].length <= MAX_TWITCH_MSG_LEN);
  assert.ok(formatted[1].length <= MAX_TWITCH_MSG_LEN);
});

test('templates - describeRoom renders factual room descriptions from room state', () => {
  const templates = new NarrationTemplates();

  const entrance = {
    roomNumber: 1,
    type: 'entrance',
    name: 'Ancient Archway',
    exits: [{ direction: 'north', targetRoomId: 2 }, { direction: 'east', targetRoomId: 3 }]
  };
  const descEntrance = templates.describeRoom(entrance, { totalRooms: 12 });
  assert.ok(descEntrance.length >= 1 && descEntrance.length <= 2);
  assert.match(descEntrance[0], /Room 1\/12: Ancient Archway/);
  assert.match(descEntrance[1], /Exits: north, east/);

  const treasureRoom = {
    roomNumber: 4,
    type: 'treasure',
    name: 'Jeweled Crypt',
    exits: [{ direction: 'west', targetRoomId: 3 }]
  };
  const descTreasure = templates.describeRoom(treasureRoom, { totalRooms: 12 });
  assert.match(descTreasure[0], /glint of treasure/);

  const monsterRoom = {
    roomNumber: 7,
    type: 'monster',
    name: 'Bone Den',
    monster: { name: 'Skeleton Warrior', hp: 35 },
    exits: [{ direction: 'north', targetRoomId: 8 }]
  };
  const descMonster = templates.describeRoom(monsterRoom, { totalRooms: 12 });
  assert.match(descMonster[0], /Skeleton Warrior/);
  assert.match(descMonster[0], /35 HP/);
});

test('templates - describeMonsterIntro produces clear stats and action prompts', () => {
  const templates = new NarrationTemplates();

  const monster = {
    name: 'Shadow Stalker',
    hp: 40,
    maxHp: 40,
    attack: 8,
    defense: 12
  };

  const intro = templates.describeMonsterIntro(monster, { type: 'monster' });
  assert.ok(intro.length >= 1 && intro.length <= 2);
  assert.match(intro[0], /MONSTER SIGHTING! Shadow Stalker/);
  assert.match(intro[0], /40\/40 HP/);
  assert.match(intro[1], /!attack, !defend, !item, or !heal/);

  const boss = {
    name: 'Dungeon Dragon',
    hp: 120,
    maxHp: 120,
    attack: 16,
    defense: 15
  };
  const bossIntro = templates.describeMonsterIntro(boss, { type: 'boss' });
  assert.match(bossIntro[0], /BOSS ENCOUNTER! Dungeon Dragon/);
});

test('templates - describeCombatRecap formats round summary, victory, and wipe states', () => {
  const templates = new NarrationTemplates();

  // Active round with KO
  const recap = templates.describeCombatRecap({
    round: 2,
    monster: { name: 'Cave Troll', hp: 20, maxHp: 50 },
    events: [
      { kind: 'game', type: 'player_knocked_out', user: 'bob', displayName: 'Bob' }
    ]
  });
  assert.match(recap[0], /Round 2 Resolved/);
  assert.match(recap[1], /Knocked out: @Bob/);

  // Victory
  const victory = templates.describeCombatRecap({
    round: 3,
    monster: { name: 'Cave Troll', xp: 60, gold: 35 },
    monsterDefeated: true
  });
  assert.match(victory[0], /Round 3 Victory: Cave Troll is slain!/);
  assert.match(victory[1], /60 XP and 35 gold/);

  // Wipe
  const wipe = templates.describeCombatRecap({
    round: 4,
    partyWiped: true
  });
  assert.match(wipe[0], /The party has been wiped out!/);
});

test('templates - describeMoment produces sensible output for Phase 1 moments', () => {
  const templates = new NarrationTemplates();

  const start = templates.describeMoment('adventure_started', { theme: 'Pirate Ship', totalRooms: 10 });
  assert.match(start[0], /Pirate Ship/);

  const loot = templates.describeMoment('rare_loot', { user: 'frank', gold: 100, item: 'ancient key' });
  assert.match(loot[0], /@frank recovered 100 gold and claimed a ancient key/);

  const boss = templates.describeMoment('boss_appears', { monster: 'Necromancer King', hp: 90, maxHp: 90 });
  assert.match(boss[0], /Necromancer King/);

  const ko = templates.describeMoment('player_knocked_out', { displayName: 'Warrior1', monster: 'Fire Drake' });
  assert.match(ko[0], /@Warrior1 has been knocked out by Fire Drake/);

  const heal = templates.describeMoment('player_healed', { user: 'cleric', target: 'warrior', amount: 10 });
  assert.match(heal[0], /@cleric healed @warrior for 10 HP/);

  const clear = templates.describeMoment('dungeon_cleared', { totalRooms: 12, theme: 'Cyberpunk Vault', monstersSlain: 5 });
  assert.match(clear[0], /DUNGEON CLEARED/);
  assert.match(clear[1], /Total monsters slain: 5/);
});
