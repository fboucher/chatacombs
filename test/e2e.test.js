import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness } from './helpers/e2eHarness.js';
import { calculateLevel } from '../src/db/playerRepo.js';

test('e2e tracer - service boots in test mode and drives stream start to entrance room (#38)', async () => {
  const harness = await createTestHarness({
    channel: 'tracerchannel',
    seed: 12345,
    pacerIntervalMs: 0
  });

  const { collector, close: closeSse } = await harness.connectSse('tracerchannel');

  try {
    // 1. Post stream start
    const streamStartRes = await harness.setStreamState('tracerchannel', 'started');
    assert.equal(streamStartRes.status, 'voting');
    assert.equal(streamStartRes.changed, true);

    // 2. Simulated viewers cast votes
    await harness.postMessage('tracerchannel', { user: 'alice', text: '!vote 1' });
    await harness.postMessage('tracerchannel', { user: 'bob', text: '!vote 1' });
    await harness.postMessage('tracerchannel', { user: 'charlie', text: '!vote 2' });

    // 3. Fast-forward clock past voteDurationMs (60s)
    harness.tick('tracerchannel', 61000);

    // 4. Assert SSE stream events arrive
    const advStarted = await collector.waitForEvent('adventure_started', 3000);
    assert.ok(advStarted);
    assert.equal(advStarted.theme, 'classic fantasy');
    assert.ok(advStarted.totalRooms >= 10);

    const roomEntered = await collector.waitForEvent('room_entered', 3000);
    assert.ok(roomEntered);
    assert.equal(roomEntered.roomNumber, 1);
    assert.equal(roomEntered.roomType, 'entrance');
    assert.ok(roomEntered.exits.length > 0);

    // 5. Assert SQLite persisted records
    const advRow = harness.db.prepare('SELECT * FROM adventures WHERE channel = ?').get('tracerchannel');
    assert.ok(advRow, 'Adventure row should exist in database');
    assert.equal(advRow.status, 'active');
    assert.equal(advRow.theme, 'classic fantasy');

    const entranceRoomRow = harness.db.prepare(
      'SELECT * FROM rooms WHERE adventure_id = ? AND room_number = 1'
    ).get(advRow.id);
    assert.ok(entranceRoomRow, 'Entrance room should be saved in database');
    assert.equal(entranceRoomRow.room_type, 'entrance');

    // 6. Assert state snapshot matches
    const state = await harness.getState('tracerchannel');
    assert.equal(state.status, 'active');
    assert.equal(state.currentRoom.roomNumber, 1);
    assert.equal(state.currentRoom.type, 'entrance');
  } finally {
    closeSse();
    await harness.close();
  }
});

test('e2e full story - theme vote to boss clear with combat, knockout, heal and shared rewards (#39)', async () => {
  const harness = await createTestHarness({
    channel: 'storychannel',
    seed: 99999, // Deterministic seed
    pacerIntervalMs: 0
  });

  const { collector, close: closeSse } = await harness.connectSse('storychannel');

  try {
    // Phase 1: Stream Start & Theme Vote
    await harness.setStreamState('storychannel', 'started');

    // Simulated party casts votes
    await harness.postMessage('storychannel', { user: 'alice', text: '!vote 1' });
    await harness.postMessage('storychannel', { user: 'bob', text: '!vote 1' });
    await harness.postMessage('storychannel', { user: 'charlie', text: '!vote 1' });

    // Advance clock past 60s vote duration
    harness.tick('storychannel', 61000);

    const advStarted = await collector.waitForEvent('adventure_started', 3000);
    assert.ok(advStarted);

    let state = await harness.getState('storychannel');
    assert.equal(state.status, 'active');
    assert.equal(state.currentRoom.roomNumber, 1);

    // Explore entrance
    await harness.postMessage('storychannel', { user: 'alice', text: '!explore' });

    // Give party members sufficient potions for a full dungeon crawl
    const party = harness.getRuntime('storychannel').engine.state.party;
    const charlieMember = party.get('charlie');
    for (const member of party.values()) {
      member.potions = 15;
      member.hp = 20;
      member.maxHp = 20;
    }
    if (charlieMember) {
      charlieMember.hp = 1; // 1 HP so first monster strike knocks him out to demonstrate KO + heal
    }

    // Traverse through the dungeon room by room
    const visitedRoomIds = new Set([state.currentRoom.id]);
    let maxSteps = 40; // Safety guard against infinite loops
    let hadCombat = false;
    let hadKoAndHeal = false;

    while (state.status === 'active' && maxSteps-- > 0) {
      // If currently in combat encounter
      if (state.combat && state.currentRoom.monster) {
        hadCombat = true;

        // Check if any party member is KO'd or low HP
        const koMember = [...party.values()].find(m => m.isKnockedOut || m.hp <= 0);
        const lowHpMember = [...party.values()].find(m => !m.isKnockedOut && m.hp <= 10);
        const healTarget = koMember || lowHpMember;

        const livingMembers = [...party.values()].filter(m => !m.isKnockedOut && m.hp > 0);

        let healer = null;
        if (healTarget && livingMembers.length > 0) {
          healer = livingMembers.find(m => m.username !== healTarget.username && m.potions > 0) ||
                   (healTarget.potions > 0 ? healTarget : null);
        }

        for (const member of livingMembers) {
          if (healer && member.username === healer.username) {
            if (healTarget.username === member.username) {
              await harness.postMessage('storychannel', { user: member.username, text: '!item potion' });
            } else {
              await harness.postMessage('storychannel', { user: member.username, text: `!heal @${healTarget.username}` });
            }
            hadKoAndHeal = true;
            healer = null; // one heal per round
          } else {
            await harness.postMessage('storychannel', { user: member.username, text: '!attack' });
          }
        }

        // Advance round timer (60s)
        harness.tick('storychannel', 61000);
        state = await harness.getState('storychannel');
        continue;
      }

      // Check if adventure already completed (e.g. boss defeated)
      if (state.status !== 'active') {
        break;
      }

      // We are in a non-combat room or combat finished.
      // Explore room if not searched yet
      if (!state.currentRoom.exploration?.searched) {
        await harness.postMessage('storychannel', { user: 'alice', text: '!explore' });
      }

      // Pick an exit: prefer exit leading to unvisited room or towards boss
      const exits = state.currentRoom.exits;
      assert.ok(exits.length > 0, 'Room must have at least one exit');

      let chosenExit = exits.find(e => !visitedRoomIds.has(e.targetRoomId));
      if (!chosenExit) {
        chosenExit = exits[0]; // fallback
      }

      // All party members vote on exit to keep 15-minute sliding window active
      await harness.postMessage('storychannel', { user: 'alice', text: `!go ${chosenExit.direction}` });
      await harness.postMessage('storychannel', { user: 'bob', text: `!go ${chosenExit.direction}` });
      await harness.postMessage('storychannel', { user: 'charlie', text: `!go ${chosenExit.direction}` });

      // Advance clock past 60s exit vote duration
      harness.tick('storychannel', 61000);
      state = await harness.getState('storychannel');

      if (state.currentRoom) {
        visitedRoomIds.add(state.currentRoom.id);
      }
    }

    // Verify adventure cleared
    assert.equal(state.status, 'cleared', `Expected adventure to be cleared, was ${state.status}`);

    // Verify SSE events received
    const dungeonCleared = await collector.waitForEvent('dungeon_cleared', 3000);
    assert.ok(dungeonCleared);
    assert.ok(dungeonCleared.monstersSlain >= 1);
    assert.ok(hadCombat, 'Should have experienced combat encounters');
    assert.ok(hadKoAndHeal, 'Should have performed healing in combat');

    // Verify database rows
    const advRow = harness.db.prepare('SELECT * FROM adventures WHERE channel = ?').get('storychannel');
    assert.equal(advRow.status, 'cleared');

    // Verify player progression in SQLite
    const players = harness.db.prepare('SELECT * FROM players WHERE channel = ?').all('storychannel');
    assert.ok(players.length >= 3, 'All 3 active players should be persisted');

    for (const p of players) {
      assert.ok(p.gold > 0, `${p.username} should have earned shared gold`);
      assert.ok(p.xp > 0, `${p.username} should have earned shared XP`);
      assert.equal(p.adventures_joined, 1);
      assert.ok(p.monsters_slain > 0, `${p.username} should have credit for monsters slain`);
      assert.equal(p.level, calculateLevel(p.xp));
    }
  } finally {
    closeSse();
    await harness.close();
  }
});
