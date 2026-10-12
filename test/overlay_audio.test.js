import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SFX,
  noteFreq,
  sfxForEvent,
  lfsrNoise,
  voiceEnvelope,
  createSfxPlayer
} from '../src/public/audio.js';

// Records every Web Audio call a sound makes
function createFakeAudioContext(log) {
  const param = (name) => ({
    value: 0,
    setValueAtTime: (v, t) => log.push([name, 'set', v, t]),
    linearRampToValueAtTime: (v, t) => log.push([name, 'linear', v, t]),
    exponentialRampToValueAtTime: (v, t) => log.push([name, 'exp', v, t])
  });
  const node = (kind) => ({
    kind,
    connect: () => {},
    start: (t) => log.push([kind, 'start', t]),
    stop: (t) => log.push([kind, 'stop', t])
  });
  return {
    currentTime: 10,
    sampleRate: 8000,
    state: 'running',
    destination: {},
    createGain: () => ({ ...node('gain'), gain: param('gain') }),
    createOscillator: () => {
      const osc = { ...node('osc'), frequency: param('freq') };
      Object.defineProperty(osc, 'type', { set: (v) => log.push(['osc', 'type', v]) });
      return osc;
    },
    createBufferSource: () => ({ ...node('noise') }),
    createBuffer: (channels, length) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }
  };
}

test('noteFreq - A4 is 440 Hz and octaves double', () => {
  assert.equal(noteFreq(0), 440);
  assert.equal(noteFreq(12), 880);
  assert.equal(noteFreq(-12), 220);
});

test('SFX recipes - every voice is a valid, finite square/triangle/noise voice', () => {
  for (const name of ['dice', 'hit', 'miss', 'heal', 'coin', 'ko', 'slain', 'siren', 'fanfare', 'boom']) {
    assert.ok(SFX[name]?.length > 0, name);
    for (const v of SFX[name]) {
      assert.ok(['square', 'triangle', 'noise'].includes(v.wave), `${name}: ${v.wave}`);
      assert.ok(v.at >= 0 && v.dur > 0 && v.vol > 0 && v.vol <= 1, name);
      if (v.wave !== 'noise') assert.ok(Number.isFinite(v.freq) && v.freq > 0, name);
      if (v.to !== undefined) assert.ok(v.to > 0, `${name}: exponential ramps need > 0`);
    }
  }
});

test('sfxForEvent - maps the overlay events to sounds', () => {
  assert.equal(sfxForEvent('dice_roll', { roll: 5 }), 'dice');
  assert.equal(sfxForEvent('dice_roll', { success: true }), 'hit');
  assert.equal(sfxForEvent('dice_roll', { success: false }), 'miss');
  assert.equal(sfxForEvent('boss_appears'), 'siren');
  assert.equal(sfxForEvent('dungeon_cleared'), 'fanfare');
  assert.equal(sfxForEvent('party_wiped'), 'boom');
  assert.equal(sfxForEvent('player_healed'), 'heal');
  assert.equal(sfxForEvent('room_entered'), null);
});

test('lfsrNoise - deterministic +/-1 samples with both signs', () => {
  const a = lfsrNoise(2000, 7);
  const b = lfsrNoise(2000, 7);
  assert.deepEqual(a, b);
  assert.ok(a.every(s => s === 1 || s === -1));
  const ones = a.filter(s => s === 1).length;
  assert.ok(ones > 600 && ones < 1400);
});

test('voiceEnvelope - rises to volume and returns to silence inside the voice', () => {
  const env = voiceEnvelope({ at: 0.5, dur: 0.2, vol: 0.3 }, 10);
  assert.equal(env[0].value, 0);
  assert.equal(env[0].time, 10.5);
  assert.equal(env[1].value, 0.3);
  assert.equal(env.at(-1).value, 0);
  assert.ok(Math.abs(env.at(-1).time - 10.7) < 1e-9);
  for (let i = 1; i < env.length; i++) assert.ok(env[i].time >= env[i - 1].time);
});

test('player - muted by default: never creates an AudioContext', () => {
  let created = 0;
  const player = createSfxPlayer({ createContext: () => { created++; return null; }, defer: fn => fn() });
  assert.equal(player.enabled, false);
  assert.equal(player.playEvent('boss_appears'), false);
  player.unlock();
  assert.equal(created, 0);
});

test('player - ?audio=1 plays synthesized voices, deferred off the render path', () => {
  const log = [];
  const deferred = [];
  let created = 0;
  const player = createSfxPlayer({
    enabled: true,
    createContext: () => { created++; return createFakeAudioContext(log); },
    defer: fn => deferred.push(fn)
  });

  assert.equal(player.playEvent('dice_roll', { success: true }), true);
  // Nothing touched the audio graph yet: the event handler returned immediately
  assert.equal(created, 0);
  assert.equal(log.length, 0);

  deferred.shift()();
  assert.equal(created, 1);
  const starts = log.filter(e => e[1] === 'start');
  assert.equal(starts.length, SFX.hit.length);
  assert.ok(log.some(e => e[0] === 'osc' && e[1] === 'type' && e[2] === 'square'));
  assert.ok(log.some(e => e[0] === 'noise' && e[1] === 'start'));

  // Context is reused across sounds
  player.play('fanfare');
  deferred.shift()();
  assert.equal(created, 1);
  assert.equal(player.playEvent('room_entered'), false);
});

test('player - audio failures are swallowed', () => {
  const player = createSfxPlayer({
    enabled: true,
    createContext: () => { throw new Error('no audio device'); },
    defer: fn => fn()
  });
  assert.doesNotThrow(() => player.play('boom'));
});

test('audio module - fetches nothing', () => {
  const src = readFileSync(new URL('../src/public/audio.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /fetch\(|new Audio\(|\.(mp3|wav|ogg)\b|https?:\/\//);
});
