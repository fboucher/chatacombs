import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine/engine.js';
import { Adventure, BUILTIN_THEMES } from '../src/engine/adventure.js';
import { createRng } from '../src/engine/dice.js';

test('theme vote - opens with 3 choices: classic fantasy + 2 random slots', () => {
  const adv = new Adventure({ rng: createRng(123) });
  const events = adv.openThemeVote();

  assert.equal(adv.status, 'voting');
  assert.equal(adv.themeVote.choices.length, 3);
  assert.equal(adv.themeVote.choices[0], 'classic fantasy');
  assert.ok(BUILTIN_THEMES.includes(adv.themeVote.choices[1]));
  assert.ok(BUILTIN_THEMES.includes(adv.themeVote.choices[2]));

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'say');
  assert.match(events[0].text, /!vote <1-3>/);
});

test('theme vote - handles !theme suggestions replacing slot 2 and 3 only', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    rng: createRng(42),
    clock: () => fakeTime
  });

  engine.startThemeVote();

  // First suggestion replaces slot 2
  const res1 = engine.handleMessage({
    user: 'alice',
    displayName: 'Alice',
    text: '!theme Cyberpunk Neon City'
  });
  assert.equal(res1.events.length, 1);
  assert.match(res1.events[0].text, /Theme #2 updated to "Cyberpunk Neon City" suggested by @Alice/);
  assert.equal(engine.getState().themeVote.choices[1], 'Cyberpunk Neon City');

  // Second suggestion replaces slot 3
  const res2 = engine.handleMessage({
    user: 'bob',
    displayName: 'Bob',
    text: '!theme Haunted Space Station'
  });
  assert.equal(res2.events.length, 1);
  assert.match(res2.events[0].text, /Theme #3 updated to "Haunted Space Station" suggested by @Bob/);
  assert.equal(engine.getState().themeVote.choices[2], 'Haunted Space Station');

  // Third suggestion is ignored (max 2 custom suggestions)
  const res3 = engine.handleMessage({
    user: 'charlie',
    displayName: 'Charlie',
    text: '!theme Underwater Ruins'
  });
  assert.equal(res3.events.length, 0);
  assert.equal(engine.getState().themeVote.choices[1], 'Cyberpunk Neon City');
  assert.equal(engine.getState().themeVote.choices[2], 'Haunted Space Station');
});

test('theme vote - zero votes defaults to classic fantasy on timer expiry', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    clock: () => fakeTime,
    voteDurationMs: 60000,
    rng: createRng(77)
  });

  engine.startThemeVote();
  assert.equal(engine.status, 'voting');

  // Advance time past 60s
  fakeTime += 60001;
  const events = engine.tick(fakeTime);

  assert.equal(engine.status, 'active');
  assert.equal(engine.getState().theme, 'classic fantasy');

  // Verify events emitted
  const advStarted = events.find(e => e.kind === 'game' && e.type === 'adventure_started');
  assert.ok(advStarted);
  assert.equal(advStarted.theme, 'classic fantasy');
  assert.ok(advStarted.totalRooms >= 10);

  const roomEntered = events.find(e => e.kind === 'game' && e.type === 'room_entered');
  assert.ok(roomEntered);
  assert.equal(roomEntered.roomNumber, 1);
  assert.equal(roomEntered.roomType, 'entrance');
});

test('theme vote - plurality wins and ties favor earlier slot', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    clock: () => fakeTime,
    voteDurationMs: 60000,
    rng: createRng(99)
  });

  engine.startThemeVote();
  const choices = engine.getState().themeVote.choices;

  // Alice and Bob vote for slot 2
  engine.handleMessage({ user: 'alice', displayName: 'Alice', text: '!vote 2' });
  engine.handleMessage({ user: 'bob', displayName: 'Bob', text: '!vote 2' });

  // Charlie votes for slot 1
  engine.handleMessage({ user: 'charlie', displayName: 'Charlie', text: '!vote 1' });

  // Fast forward past duration
  fakeTime += 60001;
  engine.tick(fakeTime);

  assert.equal(engine.status, 'active');
  assert.equal(engine.getState().theme, choices[1]);
});

test('theme vote - tie between slot 1 and slot 2 favors slot 1 (first registered)', () => {
  let fakeTime = 1000;
  const engine = new Engine({
    clock: () => fakeTime,
    voteDurationMs: 60000,
    rng: createRng(99)
  });

  engine.startThemeVote();
  const choices = engine.getState().themeVote.choices;

  engine.handleMessage({ user: 'alice', displayName: 'Alice', text: '!vote 1' });
  engine.handleMessage({ user: 'bob', displayName: 'Bob', text: '!vote 2' });

  fakeTime += 60001;
  engine.tick(fakeTime);

  assert.equal(engine.status, 'active');
  assert.equal(engine.getState().theme, choices[0]); // slot 1
});
