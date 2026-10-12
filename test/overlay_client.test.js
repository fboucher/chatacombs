import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOverlay,
  connectStream,
  parseConfig,
  channelFromPath,
  formatCountdown,
  formatDuration,
  pickSprite,
  spriteToBoxShadow,
  SPRITES,
  TAKEOVER_DURATIONS_MS,
  TOAST_DURATION_MS,
  MAX_TOASTS,
  DIE_DURATION_MS,
  MAX_DICE,
  OVERLAY_EVENT_TYPES
} from '../src/public/overlay.js';

// --- Minimal DOM stub: just the surface the overlay touches ---------------------

class StubElement {
  constructor(tag, id = null) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.attributes = {};
    this._classes = new Set();
    const props = {};
    this.style = Object.assign(props, {
      setProperty: (name, value) => { props[name] = value; }
    });
    const classes = this._classes;
    this.classList = {
      add: (...names) => names.forEach(n => classes.add(n)),
      remove: (...names) => names.forEach(n => classes.delete(n)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: name => classes.has(name)
    };
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes.clear();
    String(value).split(/\s+/).filter(Boolean).forEach(c => this._classes.add(c));
  }

  get firstChild() {
    return this.children[0] || null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  get allText() {
    return [this.textContent, ...this.children.map(c => c.allText)].join(' ');
  }
}

function createStubDocument() {
  const byId = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new StubElement('div', id));
      return byId.get(id);
    },
    createElement(tag) {
      return new StubElement(tag);
    }
  };
}

// Manual timers so tests control time exactly
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms, every: null });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    setInterval(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms, every: ms });
      return id;
    },
    clearInterval(id) { pending.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let nextIdKey = null;
        let next = null;
        for (const [id, t] of pending) {
          if (t.at <= end && (!next || t.at < next.at)) { next = t; nextIdKey = id; }
        }
        if (!next) break;
        now = next.at;
        if (next.every) next.at += next.every; else pending.delete(nextIdKey);
        next.fn();
      }
      now = end;
    },
    get count() { return pending.size; }
  };
}

function setup(config, random) {
  const doc = createStubDocument();
  const timers = createFakeTimers();
  const sounds = [];
  const overlay = createOverlay({
    document: doc,
    config: config || { audio: false, theme: 'retro', scale: 1 },
    now: timers.now,
    timers,
    audio: { playEvent: (type) => { sounds.push(type); return true; } },
    random
  });
  const $ = id => doc.getElementById(id);
  return { doc, timers, overlay, $, sounds };
}

const idleView = {
  status: 'idle', theme: null, currentRoom: null,
  progress: { roomNumber: 0, totalRooms: 0 },
  encounter: null, party: [], partyCount: 0, koCount: 0, timer: null, outcome: null
};

function activeView(overrides = {}) {
  return {
    status: 'active',
    theme: 'haunted manor',
    currentRoom: { roomNumber: 3, type: 'monster', name: 'Chamber 3', cleared: false, searched: false },
    progress: { roomNumber: 3, totalRooms: 6 },
    encounter: { name: 'Slime King', hp: 42, maxHp: 60, isBoss: false, defeated: false },
    party: [],
    partyCount: 9,
    koCount: 1,
    timer: { kind: 'combat_round', label: 'Round 2', remainingMs: 35000, durationMs: 60000 },
    outcome: null,
    ...overrides
  };
}

// --- Config / helpers ----------------------------------------------------------

test('parseConfig - defaults, theme, clamped scale and audio flag', () => {
  assert.deepEqual(parseConfig(''), { key: '', audio: false, theme: 'retro', scale: 1, cam: 'right', bot: 'skeleton' });
  assert.deepEqual(
    parseConfig('?key=abc&audio=1&theme=dark&scale=1.1&cam=left&bot=mummy'),
    { key: 'abc', audio: true, theme: 'dark', scale: 1.1, cam: 'left', bot: 'mummy' }
  );
  assert.equal(parseConfig('?cam=middle').cam, 'right');
  assert.equal(parseConfig('?bot=robot').bot, 'skeleton');
  assert.equal(parseConfig('?scale=5').scale, 1.2);
  assert.equal(parseConfig('?scale=0.1').scale, 0.8);
  assert.equal(parseConfig('?scale=nope').scale, 1);
  assert.equal(parseConfig('?theme=neon').theme, 'retro');
  assert.equal(parseConfig('?audio=0').audio, false);
});

test('channelFromPath / formatting helpers', () => {
  assert.equal(channelFromPath('/overlay/frank_b'), 'frank_b');
  assert.equal(channelFromPath('/overlay/a%20b/'), 'a b');
  assert.equal(formatCountdown(35000), '0:35');
  assert.equal(formatCountdown(61001), '1:02');
  assert.equal(formatCountdown(-5), '0:00');
  assert.equal(formatDuration(723000), '12m 03s');
});

test('sprites - all grids are 12x12 and render to box-shadows', () => {
  for (const [name, rows] of Object.entries(SPRITES)) {
    assert.equal(rows.length, 12, name);
    for (const row of rows) assert.equal(row.length, 12, `${name}: ${row}`);
  }
  assert.equal(pickSprite('Gelatinous Ooze'), 'slime');
  assert.equal(pickSprite('Skeleton Archer'), 'skull');
  assert.equal(pickSprite('Ancient Red Wyrm', true), 'dragon');
  assert.equal(pickSprite('Mysterious Thing', true), 'dragon');
  assert.equal(pickSprite('Mysterious Thing'), 'imp');
  assert.equal(spriteToBoxShadow(['1.', '.2'], { 1: '#000', 2: '#fff' }, 5), '5px 5px 0 #000,10px 10px 0 #fff');
});

// --- Shell / cold boot (#31) ---------------------------------------------------

test('config - webcam corner and bot picture are applied', () => {
  for (const [config, camClass, picture] of [
    [{ audio: false, theme: 'retro', scale: 1 }, 'cam-right', 'SKEL'],
    [{ audio: false, theme: 'retro', scale: 1, cam: 'left', bot: 'mummy' }, 'cam-left', 'MUMMY']
  ]) {
    const doc = createStubDocument();
    doc.getElementById('bot-img').setAttribute('data-skeleton', 'SKEL');
    doc.getElementById('bot-img').setAttribute('data-mummy', 'MUMMY');
    createOverlay({ document: doc, config, audio: { playEvent: () => false } });
    assert.ok(doc.getElementById('overlay').classList.contains(camClass));
    assert.equal(doc.getElementById('bot-img').getAttribute('src'), picture);
  }
});

test('config - dark theme and scale are applied to the root', () => {
  const { $ } = setup({ audio: false, theme: 'dark', scale: 0.9 });
  assert.ok($('overlay').classList.contains('theme-dark'));
  assert.equal($('overlay').style['--scale'], '0.9');
});

test('cold boot - idle snapshot renders a clean empty ribbon', () => {
  const { overlay, $ } = setup();
  overlay.applySnapshot(idleView);
  assert.ok($('ribbon').classList.contains('is-idle'));
  assert.equal($('room-number').textContent, '-');
  assert.equal($('theme-badge').textContent, 'No adventure');
  assert.equal($('progress-dots').children.length, 0);
  assert.ok(!$('encounter').classList.contains('has-monster'));
  assert.equal($('party-count').textContent, '0');
  assert.ok(!$('timer').classList.contains('is-active'));
});

test('cold boot - active snapshot fills all three sections', () => {
  const { overlay, $ } = setup();
  overlay.applySnapshot(activeView());

  assert.ok(!$('ribbon').classList.contains('is-idle'));
  assert.equal($('room-number').textContent, '3');
  assert.equal($('room-total').textContent, '6');
  assert.equal($('theme-badge').textContent, 'haunted manor');
  const dots = $('progress-dots').children;
  assert.equal(dots.length, 6);
  assert.ok(dots[0].classList.contains('is-done'));
  assert.ok(dots[2].classList.contains('is-current'));
  assert.ok(dots[5].classList.contains('is-boss'));

  assert.equal($('enc-name').textContent, 'Slime King');
  assert.equal($('enc-hp-text').textContent, '42/60');
  assert.equal($('enc-hp-fill').style.width, '70%');
  assert.notEqual($('enc-sprite').style.boxShadow, 'none');
  assert.match($('enc-status').textContent, /^Fight!/);

  assert.equal($('party-count').textContent, '9');
  assert.equal($('ko-count').textContent, '1');
  assert.ok($('ko-indicator').classList.contains('has-ko'));
  assert.equal($('timer-label').textContent, 'Round 2');
  assert.equal($('timer-text').textContent, '0:35');
});

// --- Live ribbon (#32) ---------------------------------------------------------

test('live - adventure_started and room_entered update progress with targeted changes', () => {
  const { overlay, $ } = setup();
  overlay.applySnapshot(idleView);

  overlay.handleEvent('adventure_started', { theme: 'sunken crypt', totalRooms: 5 });
  assert.equal($('theme-badge').textContent, 'sunken crypt');
  assert.equal($('progress-dots').children.length, 5);
  assert.ok(!$('ribbon').classList.contains('is-idle'));

  overlay.handleEvent('room_entered', { roomNumber: 1, roomType: 'entrance', roomName: 'Entrance Hall', exits: ['north'] });
  const dotsAfterFirst = $('progress-dots').children.slice();
  assert.equal($('room-number').textContent, '1');
  assert.equal($('room-name').textContent, 'Entrance Hall');

  overlay.handleEvent('room_entered', { roomNumber: 2, roomType: 'empty', roomName: 'Chamber 2', exits: [] });
  // Same dot nodes reused, only classes flipped
  assert.deepEqual($('progress-dots').children, dotsAfterFirst);
  assert.ok(dotsAfterFirst[0].classList.contains('is-done'));
  assert.ok(dotsAfterFirst[1].classList.contains('is-current'));
  assert.equal($('enc-status').textContent, 'Exploring...');
});

test('live - KO events bump the indicator; next snapshot is authoritative', () => {
  const { overlay, $ } = setup();
  overlay.applySnapshot(activeView({ koCount: 0 }));
  assert.ok(!$('ko-indicator').classList.contains('has-ko'));

  overlay.handleEvent('player_knocked_out', { user: 'bob', displayName: 'Bob', monster: 'Slime King' });
  assert.equal($('ko-count').textContent, '1');
  assert.ok($('ko-indicator').classList.contains('has-ko'));

  overlay.applySnapshot(activeView({ partyCount: 8, koCount: 2 }));
  assert.equal($('ko-count').textContent, '2');
  assert.equal($('party-count').textContent, '8');
});

test('resync - re-applying a snapshot after reconnect leaves no stale or duplicated UI', () => {
  const { overlay, $ } = setup();
  overlay.applySnapshot(activeView());
  overlay.handleEvent('room_entered', { roomNumber: 4, roomType: 'empty', roomName: 'Stale' });

  overlay.applySnapshot(activeView({ progress: { roomNumber: 5, totalRooms: 6 }, currentRoom: { roomNumber: 5, type: 'empty', name: 'Chamber 5', searched: true }, encounter: null }));
  overlay.applySnapshot(activeView({ progress: { roomNumber: 5, totalRooms: 6 }, currentRoom: { roomNumber: 5, type: 'empty', name: 'Chamber 5', searched: true }, encounter: null }));

  assert.equal($('progress-dots').children.length, 6);
  assert.equal($('room-number').textContent, '5');
  assert.equal($('room-name').textContent, 'Chamber 5');
  assert.ok(!$('encounter').classList.contains('has-monster'));
  assert.equal($('enc-status').textContent, 'Room searched. Pick an exit!');
});

test('connectStream - listens to snapshots + game events and reconnects after a hard close', () => {
  const timers = createFakeTimers();
  const sources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.readyState = 1;
      this.closed = false;
      sources.push(this);
    }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    close() { this.closed = true; this.readyState = 2; }
    emit(type, data) { this.listeners[type]({ data: JSON.stringify(data) }); }
  }

  const seen = [];
  const overlay = {
    applySnapshot: v => seen.push(['snapshot', v.status]),
    handleEvent: (type, d) => seen.push([type, d.roomNumber])
  };
  const conn = connectStream({ url: '/overlay/c/events?key=k', EventSourceCtor: FakeEventSource, overlay, timers });

  assert.equal(sources.length, 1);
  for (const type of OVERLAY_EVENT_TYPES) assert.ok(sources[0].listeners[type], type);
  sources[0].emit('overlay_state', { status: 'active' });
  sources[0].emit('room_entered', { roomNumber: 2 });
  assert.deepEqual(seen, [['snapshot', 'active'], ['room_entered', 2]]);

  // Transient error: the browser retries by itself
  sources[0].readyState = 0;
  sources[0].onerror();
  timers.advance(10000);
  assert.equal(sources.length, 1);

  // Hard close: we open a new connection after a delay
  sources[0].readyState = 2;
  sources[0].onerror();
  timers.advance(10000);
  assert.equal(sources.length, 2);
  assert.equal(sources[1].url, '/overlay/c/events?key=k');

  conn.close();
  assert.ok(sources[1].closed);
});

// --- Encounter + countdown (#33) -----------------------------------------------

test('encounter - dice_roll animates HP to the event value; monster_defeated empties it', () => {
  const { overlay, $, timers } = setup();
  overlay.applySnapshot(activeView());

  overlay.handleEvent('dice_roll', { user: 'alice', roll: 15, total: 15, modifier: 0, dc: 12, success: true, damage: 6, monster: 'Slime King', monsterHp: 36, monsterMaxHp: 60 });
  assert.equal($('enc-hp-text').textContent, '36/60');
  assert.equal($('enc-hp-fill').style.width, '60%');
  assert.ok($('enc-flash').classList.contains('is-hit'));
  timers.advance(500);
  assert.ok(!$('enc-flash').classList.contains('is-hit'));

  overlay.handleEvent('dice_roll', { user: 'bob', roll: 3, total: 3, dc: 12, success: false, monsterHp: 36, monsterMaxHp: 60 });
  assert.ok($('enc-flash').classList.contains('is-miss'));
  assert.equal($('enc-hp-text').textContent, '36/60');

  overlay.handleEvent('dice_roll', { user: 'alice', roll: 20, total: 20, dc: 12, success: true, isCrit: true, monsterHp: 10, monsterMaxHp: 60 });
  assert.ok($('enc-hp-fill').classList.contains('is-low'));
  assert.ok($('enc-flash').classList.contains('is-crit'));

  overlay.handleEvent('monster_defeated', { monster: 'Slime King', hp: 0, maxHp: 60, xp: 25, gold: 10 });
  assert.equal($('enc-hp-text').textContent, '0/60');
  assert.equal($('enc-hp-fill').style.width, '0%');
  assert.ok($('encounter').classList.contains('is-defeated'));
});

test('encounter - boss_appears shows the boss card from the event payload', () => {
  const { overlay, $ } = setup();
  overlay.applySnapshot(activeView({ encounter: null }));
  overlay.handleEvent('boss_appears', { monster: 'Lich King', hp: 95, maxHp: 95 });
  assert.equal($('enc-name').textContent, 'Lich King');
  assert.equal($('enc-hp-text').textContent, '95/95');
  assert.ok($('encounter').classList.contains('is-boss'));
});

test('countdown - animates while a window is open and hides when none is', () => {
  const { overlay, $, timers } = setup();
  overlay.applySnapshot(activeView({
    encounter: null,
    timer: { kind: 'exit_vote', label: 'Exit vote', remainingMs: 12000, durationMs: 60000, tallies: [{ choice: 'east', votes: 5 }, { choice: 'west', votes: 2 }] }
  }));

  assert.ok($('timer').classList.contains('is-active'));
  assert.equal($('timer-text').textContent, '0:12');
  assert.equal($('timer-fill').style.width, '20%');
  assert.equal($('timer-tallies').textContent, 'east (5)  west (2)');

  timers.advance(3000);
  assert.equal($('timer-text').textContent, '0:09');
  assert.ok($('timer').classList.contains('is-urgent'));

  // Runs out: stops ticking on its own
  timers.advance(20000);
  assert.equal($('timer-text').textContent, '0:00');
  assert.equal(timers.count, 0);

  overlay.applySnapshot(activeView({ encounter: null, timer: null }));
  assert.ok(!$('timer').classList.contains('is-active'));
});

test('countdown - a new snapshot replaces the running interval instead of stacking', () => {
  const { overlay, timers } = setup();
  overlay.applySnapshot(activeView());
  overlay.applySnapshot(activeView());
  overlay.applySnapshot(activeView());
  assert.equal(timers.count, 1);
});

// --- Takeovers (#34) -----------------------------------------------------------

test('takeovers - each milestone shows its own takeover and auto-dismisses', () => {
  const cases = [
    ['boss_appears', { monster: 'Lich King', hp: 95, maxHp: 95 }, 'WARNING: BOSS ENCOUNTER', 'Lich King'],
    ['party_wiped', { roomNumber: 4, theme: 'crypt', snapshot: {} }, 'PARTY DEFEATED', 'room 4'],
    ['dungeon_cleared', { theme: 'crypt', totalRooms: 6, durationMs: 723000, monstersSlain: 4, snapshot: {} }, 'DUNGEON CLEARED!', '12m 03s']
  ];

  for (const [type, data, title, detail] of cases) {
    const { overlay, $, timers } = setup();
    overlay.applySnapshot(activeView());
    overlay.handleEvent(type, data);

    const takeover = $('takeover');
    assert.ok(takeover.classList.contains('is-active'), type);
    assert.ok(takeover.classList.contains(`takeover-${type}`), type);
    assert.equal($('takeover-title').textContent, title);
    assert.ok($('takeover').allText.includes(detail) || `${$('takeover-sub').textContent} ${$('takeover-stats').textContent}`.includes(detail), `${type}: ${detail}`);
    if (type === 'dungeon_cleared') assert.equal($('takeover-fx').children.length, 24);

    timers.advance(TAKEOVER_DURATIONS_MS[type] - 1);
    assert.ok(takeover.classList.contains('is-active'), `${type} still up`);
    timers.advance(1);
    assert.ok(!takeover.classList.contains('is-active'), `${type} dismissed`);
    assert.equal($('takeover-fx').children.length, 0);

    // Ribbon keeps working right after
    overlay.handleEvent('room_entered', { roomNumber: 2, roomType: 'empty', roomName: 'After' });
    assert.equal($('room-name').textContent, 'After');
  }
});

test('takeovers - unrelated events never raise one', () => {
  const { overlay, $ } = setup();
  overlay.applySnapshot(activeView());
  for (const type of ['adventure_started', 'room_entered', 'dice_roll', 'player_healed', 'rare_loot', 'monster_defeated', 'player_knocked_out', 'adventure_ended', 'hero_stats']) {
    overlay.handleEvent(type, { roomNumber: 1, user: 'a', roll: 5 });
  }
  assert.ok(!$('takeover').classList.contains('is-active'));
});

test('takeovers - overlapping milestones queue instead of stacking', () => {
  const { overlay, $, timers } = setup();
  overlay.applySnapshot(activeView({ timer: null }));

  overlay.handleEvent('boss_appears', { monster: 'Lich', hp: 90, maxHp: 90 });
  overlay.handleEvent('boss_appears', { monster: 'Lich', hp: 90, maxHp: 90 }); // duplicate ignored
  overlay.handleEvent('dungeon_cleared', { theme: 't', totalRooms: 5, durationMs: 1000, monstersSlain: 2 });

  assert.ok($('takeover').classList.contains('takeover-boss_appears'));
  assert.ok(!$('takeover').classList.contains('takeover-dungeon_cleared'));

  timers.advance(TAKEOVER_DURATIONS_MS.boss_appears);
  assert.ok($('takeover').classList.contains('takeover-dungeon_cleared'));
  assert.ok(!$('takeover').classList.contains('takeover-boss_appears'));

  timers.advance(TAKEOVER_DURATIONS_MS.dungeon_cleared);
  assert.equal($('takeover').className, 'takeover');
  assert.equal(timers.count, 0);
});

// --- Toasts (#35) --------------------------------------------------------------

test('toasts - each minor event shows its toast with payload values', () => {
  const { overlay, $ } = setup();
  overlay.applySnapshot(activeView());

  overlay.handleEvent('player_healed', { user: 'alice', target: 'bob', amount: 10 });
  overlay.handleEvent('dice_roll', { user: 'carol', displayName: 'Carol', roll: 14, modifier: 2, total: 16, dc: 12, success: true });
  overlay.handleEvent('rare_loot', { user: 'dave', gold: 40, item: 'healing_potion' });
  overlay.handleEvent('player_knocked_out', { user: 'erin', displayName: 'Erin', monster: 'Slime' });

  const toasts = $('toasts').children;
  assert.equal(toasts.length, 4);
  assert.ok(toasts[0].classList.contains('toast-heal'));
  assert.match(toasts[0].allText, /bob \+10 HP \(by alice\)/);
  assert.ok(toasts[1].classList.contains('toast-dice'));
  assert.match(toasts[1].allText, /Carol rolled 14 \+ 2 = 16 vs DEF 12 HIT/);
  assert.ok(toasts[2].classList.contains('toast-loot'));
  assert.match(toasts[2].allText, /dave found healing potion \+ 40 gold!/);
  assert.ok(toasts[3].classList.contains('toast-ko'));
  assert.match(toasts[3].allText, /Erin was knocked out!/);
});

test('toasts - auto-fade, cap the stack and leave takeovers alone', () => {
  const { overlay, $, timers } = setup();
  overlay.applySnapshot(activeView());
  overlay.handleEvent('boss_appears', { monster: 'Lich', hp: 90, maxHp: 90 });

  for (let i = 0; i < MAX_TOASTS + 2; i++) {
    overlay.handleEvent('player_healed', { user: `u${i}`, target: `u${i}`, amount: i });
  }
  assert.equal($('toasts').children.length, MAX_TOASTS);
  assert.match($('toasts').children[0].allText, /u2 /); // oldest two dropped
  assert.ok($('takeover').classList.contains('takeover-boss_appears'));

  timers.advance(TOAST_DURATION_MS);
  assert.equal($('toasts').children.length, 0);
  // Takeover's own lifecycle is unaffected
  assert.ok($('takeover').classList.contains('is-active'));
  timers.advance(TAKEOVER_DURATIONS_MS.boss_appears - TOAST_DURATION_MS);
  assert.ok(!$('takeover').classList.contains('is-active'));
});

test('toasts - a plain dice roll (no combat) still shows the roll', () => {
  const { overlay, $ } = setup();
  overlay.applySnapshot(idleView);
  overlay.handleEvent('dice_roll', { user: 'zed', displayName: 'Zed', roll: 7 });
  assert.match($('toasts').children[0].allText, /Zed rolled 7/);
  assert.ok(!$('encounter').classList.contains('has-monster'));
});

test('dice - every throw rolls its own d20 at its own spot, showing the engine roll', () => {
  const spots = [0.1, 0.55, 0.9];
  const { overlay, $, timers } = setup(undefined, () => spots.shift());
  overlay.applySnapshot(activeView());

  overlay.handleEvent('dice_roll', { user: 'a', roll: 15, total: 15, dc: 12, success: true });
  overlay.handleEvent('dice_roll', { user: 'b', roll: 3, total: 3, dc: 12, success: false });
  overlay.handleEvent('dice_roll', { user: 'c', roll: 20, total: 20, dc: 12, success: true, isCrit: true });

  const dice = $('dice').children;
  assert.equal(dice.length, 3);
  assert.deepEqual(dice.map(d => d.style['--x']), ['0.100', '0.550', '0.900']);
  assert.deepEqual(dice.map(d => d.allText.trim()), ['15', '3', '20']);
  assert.ok(dice[0].classList.contains('is-hit'));
  assert.ok(dice[1].classList.contains('is-miss'));
  assert.ok(dice[2].classList.contains('is-crit'));

  timers.advance(DIE_DURATION_MS);
  assert.equal($('dice').children.length, 0);
});

test('dice - a plain roll still rolls; spots stay in bounds; the tray is capped', () => {
  const { overlay, $ } = setup(undefined, () => 7);
  overlay.applySnapshot(idleView);
  overlay.handleEvent('dice_roll', { user: 'zed', roll: 7 });
  const die = $('dice').children[0];
  assert.equal(die.className, 'die');
  assert.equal(die.style['--x'], '1.000');

  overlay.handleEvent('dice_roll', { user: 'zed' }); // no roll value, no die
  assert.equal($('dice').children.length, 1);

  for (let i = 0; i < MAX_DICE + 3; i++) overlay.handleEvent('dice_roll', { user: 'u', roll: i + 1 });
  assert.equal($('dice').children.length, MAX_DICE);
  assert.equal($('dice').children[MAX_DICE - 1].allText.trim(), String(MAX_DICE + 3));
});

test('destroy - clears every pending timer', () => {
  const { overlay, timers } = setup();
  overlay.applySnapshot(activeView());
  overlay.handleEvent('boss_appears', { monster: 'Lich', hp: 90, maxHp: 90 });
  overlay.handleEvent('player_healed', { user: 'a', target: 'a', amount: 1 });
  overlay.handleEvent('dice_roll', { user: 'a', roll: 3, success: false, monsterHp: 90, monsterMaxHp: 90 });
  overlay.destroy();
  assert.equal(timers.count, 0);
});

test('audio hook - events are forwarded to the SFX player', () => {
  const { overlay, sounds } = setup();
  overlay.handleEvent('boss_appears', { monster: 'Lich', hp: 90, maxHp: 90 });
  overlay.handleEvent('dungeon_cleared', {});
  assert.deepEqual(sounds, ['boss_appears', 'dungeon_cleared']);
});

test('voting - badge and center text show the theme vote', () => {
  const { overlay, $ } = setup();
  overlay.applySnapshot({ ...idleView, status: 'voting', timer: { kind: 'theme_vote', label: 'Theme vote', remainingMs: 60000, durationMs: 60000, tallies: [] } });
  assert.equal($('theme-badge').textContent, 'Theme vote');
  assert.equal($('enc-status').textContent, 'Choose the next dungeon!');
  assert.ok(!$('ribbon').classList.contains('is-idle'));
});
