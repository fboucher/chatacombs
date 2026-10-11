import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRuntime } from '../src/server/runtime.js';
import { CombatResolver } from '../src/engine/combat.js';
import { createRng } from '../src/engine/dice.js';

/**
 * Runtime on a fake clock with a fast real ticker, so a timer that has run out
 * resolves without any further chat.
 */
function makeRuntime(t, extra = {}) {
  const clock = { now: 1_000_000 };
  const runtime = new ChannelRuntime({
    channel: 'timers',
    clock: () => clock.now,
    rng: createRng(7),
    pacerIntervalMs: 0,
    tickIntervalMs: 5,
    ...extra
  });
  t.after(() => runtime.destroy());
  return { runtime, clock };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('runtime timers - theme vote closes at 0:00 with no further chat', async (t) => {
  const { runtime, clock } = makeRuntime(t);
  runtime.setStreamState('started');
  await runtime.handleMessage({ user: 'alice', displayName: 'Alice', text: '!vote 2' });
  assert.equal(runtime.engine.status, 'voting');

  clock.now += 60_000;
  await waitFor(() => runtime.engine.status === 'active');
  assert.equal(runtime.engine.adventure.theme, runtime.engine.adventure.dungeon.theme);
});

test('runtime timers - exit vote closes at 0:00 with no further chat', async (t) => {
  const { runtime, clock } = makeRuntime(t);
  runtime.setStreamState('started');
  runtime.engine.adventure.closeThemeVote();
  const entrance = runtime.engine.adventure.currentRoom;
  const exit = entrance.exits[0];

  await runtime.handleMessage({ user: 'alice', displayName: 'Alice', text: `!go ${exit.direction}` });
  await runtime.handleMessage({ user: 'bob', displayName: 'Bob', text: `!go ${exit.direction}` });
  assert.ok(runtime.engine.adventure.exitVote);

  clock.now += 60_000;
  await waitFor(() => runtime.engine.adventure.currentRoom.id === exit.targetRoomId);
  assert.equal(runtime.engine.adventure.exitVote, null);
});

test('runtime timers - combat round resolves at 0:00 with no further chat', async (t) => {
  const { runtime, clock } = makeRuntime(t);
  runtime.setStreamState('started');
  const adventure = runtime.engine.adventure;
  adventure.closeThemeVote();

  adventure.currentRoom = {
    id: 99,
    roomNumber: 2,
    type: 'monster',
    name: 'Goblin Den',
    exits: [{ direction: 'north', targetRoomId: 1 }],
    monster: { name: 'Goblin', hp: 50, maxHp: 50, attack: 1, defense: 5, xp: 10, gold: 5 },
    exploration: { searched: false }
  };
  adventure.combat = new CombatResolver({ rng: runtime.rng, clock: () => clock.now, roundDurationMs: 60_000 });
  adventure.combat.startEncounter();

  await runtime.handleMessage({ user: 'alice', displayName: 'Alice', text: '!attack' });
  assert.equal(adventure.combat.round, 1);

  clock.now += 60_000;
  await waitFor(() => adventure.combat?.round === 2);
});

test('runtime timers - ticker stops when the runtime is destroyed', (t) => {
  const { runtime } = makeRuntime(t);
  assert.ok(runtime.tickTimer);
  runtime.destroy();
  assert.equal(runtime.tickTimer, null);
});

for (const ending of ['cleared', 'wiped', 'abandoned']) {
  test(`runtime stream start - opens a new theme vote after a ${ending} adventure`, async (t) => {
    const { runtime } = makeRuntime(t, { tickIntervalMs: 0 });
    runtime.setStreamState('started');
    runtime.engine.adventure.closeThemeVote();
    await runtime.handleMessage({ user: 'alice', displayName: 'Alice', text: 'hello' });

    const hero = runtime.engine.state.party.get('alice');
    hero.hp = 0;
    hero.isKnockedOut = true;
    hero.potions = 0;
    if (ending === 'abandoned') {
      runtime.setStreamState('ended');
    } else {
      runtime.engine.adventure.status = ending;
    }
    assert.equal(runtime.engine.status, ending);

    const said = [];
    runtime.bus.on('event', ev => { if (ev.kind === 'say') said.push(ev.text); });

    const res = runtime.setStreamState('started');
    assert.deepEqual(res, { changed: true, status: 'voting' });
    assert.ok(runtime.engine.adventure.themeVote);
    assert.equal(runtime.engine.adventure.theme, null);
    assert.ok(said.some(text => text.includes('A new dungeon awaits')));

    // Same party, fresh for the new adventure
    assert.equal(hero.hp, hero.maxHp);
    assert.equal(hero.isKnockedOut, false);
    assert.equal(hero.potions, 1);
  });
}

test('runtime stream start - does nothing while an adventure is running', (t) => {
  const { runtime } = makeRuntime(t, { tickIntervalMs: 0 });
  runtime.setStreamState('started');
  const adventure = runtime.engine.adventure;
  assert.deepEqual(runtime.setStreamState('started'), { changed: false, status: 'voting' });
  assert.equal(runtime.engine.adventure, adventure);
});
