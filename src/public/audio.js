/**
 * Chatacombs overlay 8-bit SFX synth.
 * Every sound is generated from code with the Web Audio API (square, triangle and
 * LFSR noise voices). No audio files are ever fetched. Muted unless `?audio=1`.
 */

/**
 * Frequency of a note `semitones` away from A4 (440 Hz).
 * @param {number} semitones
 * @returns {number}
 */
export function noteFreq(semitones) {
  return 440 * Math.pow(2, semitones / 12);
}

// Semitone offsets from A4 for the notes the recipes use
const C5 = 3, E5 = 7, G5 = 10, C6 = 15, E6 = 19, G6 = 22, A3 = -12, C4 = -9, E4 = -5, G4 = -2;

/**
 * SFX recipes: lists of voices scheduled relative to the moment the sound starts.
 * wave: 'square' | 'triangle' | 'noise'; at/dur in seconds; freq/to in Hz; vol 0..1.
 */
export const SFX = {
  dice: [
    { wave: 'noise', at: 0, dur: 0.05, vol: 0.25 },
    { wave: 'noise', at: 0.08, dur: 0.05, vol: 0.2 },
    { wave: 'noise', at: 0.16, dur: 0.05, vol: 0.15 },
    { wave: 'square', at: 0.24, dur: 0.08, freq: noteFreq(E5), vol: 0.2 }
  ],
  hit: [
    { wave: 'noise', at: 0, dur: 0.05, vol: 0.2 },
    { wave: 'noise', at: 0.08, dur: 0.05, vol: 0.15 },
    { wave: 'square', at: 0.16, dur: 0.12, freq: 880, to: 110, vol: 0.3 },
    { wave: 'noise', at: 0.16, dur: 0.1, vol: 0.3 }
  ],
  miss: [
    { wave: 'noise', at: 0, dur: 0.05, vol: 0.2 },
    { wave: 'noise', at: 0.08, dur: 0.05, vol: 0.15 },
    { wave: 'square', at: 0.16, dur: 0.15, freq: 330, to: 220, vol: 0.15 }
  ],
  heal: [
    { wave: 'triangle', at: 0, dur: 0.08, freq: noteFreq(C5), vol: 0.3 },
    { wave: 'triangle', at: 0.08, dur: 0.08, freq: noteFreq(E5), vol: 0.3 },
    { wave: 'triangle', at: 0.16, dur: 0.08, freq: noteFreq(G5), vol: 0.3 },
    { wave: 'square', at: 0.24, dur: 0.2, freq: noteFreq(C6), vol: 0.2 }
  ],
  coin: [
    { wave: 'square', at: 0, dur: 0.07, freq: noteFreq(E6 - 5), vol: 0.2 },
    { wave: 'square', at: 0.07, dur: 0.3, freq: noteFreq(E6), vol: 0.2 }
  ],
  ko: [
    { wave: 'square', at: 0, dur: 0.15, freq: noteFreq(E4), vol: 0.25 },
    { wave: 'square', at: 0.15, dur: 0.15, freq: noteFreq(C4), vol: 0.25 },
    { wave: 'square', at: 0.3, dur: 0.35, freq: noteFreq(A3), to: noteFreq(A3 - 12), vol: 0.25 }
  ],
  slain: [
    { wave: 'noise', at: 0, dur: 0.2, vol: 0.3 },
    { wave: 'square', at: 0.1, dur: 0.1, freq: noteFreq(G5), vol: 0.2 },
    { wave: 'square', at: 0.2, dur: 0.25, freq: noteFreq(C6), vol: 0.2 }
  ],
  siren: [
    { wave: 'square', at: 0, dur: 0.45, freq: 220, to: 660, vol: 0.25 },
    { wave: 'square', at: 0.45, dur: 0.45, freq: 660, to: 220, vol: 0.25 },
    { wave: 'square', at: 0.9, dur: 0.45, freq: 220, to: 660, vol: 0.25 },
    { wave: 'square', at: 1.35, dur: 0.45, freq: 660, to: 220, vol: 0.25 },
    { wave: 'noise', at: 0, dur: 0.6, vol: 0.2 }
  ],
  fanfare: [
    { wave: 'square', at: 0, dur: 0.12, freq: noteFreq(C5), vol: 0.25 },
    { wave: 'square', at: 0.12, dur: 0.12, freq: noteFreq(C5), vol: 0.25 },
    { wave: 'square', at: 0.24, dur: 0.12, freq: noteFreq(C5), vol: 0.25 },
    { wave: 'square', at: 0.36, dur: 0.36, freq: noteFreq(G5), vol: 0.25 },
    { wave: 'square', at: 0.72, dur: 0.18, freq: noteFreq(E5), vol: 0.25 },
    { wave: 'square', at: 0.9, dur: 0.6, freq: noteFreq(C6), vol: 0.25 },
    { wave: 'triangle', at: 0.9, dur: 0.6, freq: noteFreq(G4), vol: 0.3 },
    { wave: 'square', at: 0.9, dur: 0.6, freq: noteFreq(G6 - 12), vol: 0.12 }
  ],
  boom: [
    { wave: 'noise', at: 0, dur: 0.9, vol: 0.45 },
    { wave: 'square', at: 0, dur: 0.9, freq: 160, to: 30, vol: 0.35 },
    { wave: 'triangle', at: 0.2, dur: 0.8, freq: 80, to: 20, vol: 0.4 }
  ]
};

/**
 * Picks the SFX for a game event.
 * @param {string} type
 * @param {object} [data]
 * @returns {string|null}
 */
export function sfxForEvent(type, data = {}) {
  switch (type) {
    case 'dice_roll':
      if (data.success === true) return 'hit';
      if (data.success === false) return 'miss';
      return 'dice';
    case 'player_healed': return 'heal';
    case 'rare_loot': return 'coin';
    case 'player_knocked_out': return 'ko';
    case 'monster_defeated': return 'slain';
    case 'boss_appears': return 'siren';
    case 'dungeon_cleared': return 'fanfare';
    case 'party_wiped': return 'boom';
    default: return null;
  }
}

/**
 * 15-bit LFSR noise, like the NES noise channel. Deterministic for a given seed.
 * @param {number} length
 * @param {number} [seed=1]
 * @returns {Float32Array} samples of +/-1
 */
export function lfsrNoise(length, seed = 1) {
  const out = new Float32Array(length);
  let reg = (seed & 0x7fff) || 1;
  for (let i = 0; i < length; i++) {
    const bit = (reg ^ (reg >> 1)) & 1;
    reg = (reg >> 1) | (bit << 14);
    out[i] = (reg & 1) ? 1 : -1;
  }
  return out;
}

/**
 * Gain envelope for a voice: a short attack, a hold, then a release to silence.
 * @param {{ at: number, dur: number, vol: number }} voice
 * @param {number} startTime Context time the SFX starts at
 * @returns {Array<{ time: number, value: number }>}
 */
export function voiceEnvelope(voice, startTime) {
  const start = startTime + voice.at;
  const attack = Math.min(0.01, voice.dur / 4);
  const release = Math.min(0.05, voice.dur / 3);
  return [
    { time: start, value: 0 },
    { time: start + attack, value: voice.vol },
    { time: start + voice.dur - release, value: voice.vol },
    { time: start + voice.dur, value: 0 }
  ];
}

/**
 * Creates the SFX player. When disabled it never touches the Web Audio API.
 * Playback is deferred so it can never block event rendering.
 * @param {object} [options]
 * @param {boolean} [options.enabled=false]
 * @param {() => AudioContext} [options.createContext]
 * @param {(fn: () => void) => void} [options.defer]
 * @param {number} [options.masterVolume=0.5]
 * @returns {{ enabled: boolean, play: (name: string) => boolean, playEvent: (type: string, data?: object) => boolean, unlock: () => void }}
 */
export function createSfxPlayer(options = {}) {
  const enabled = Boolean(options.enabled);
  const createContext = options.createContext || (() => {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    return Ctor ? new Ctor() : null;
  });
  const defer = options.defer || (fn => setTimeout(fn, 0));
  const masterVolume = options.masterVolume ?? 0.5;

  let ctx = null;
  let master = null;
  let noiseBuffer = null;

  function ensureContext() {
    if (ctx) return ctx;
    ctx = createContext();
    if (!ctx) return null;
    master = ctx.createGain();
    master.gain.value = masterVolume;
    master.connect(ctx.destination);
    const samples = lfsrNoise(Math.floor(ctx.sampleRate));
    noiseBuffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    noiseBuffer.getChannelData(0).set(samples);
    return ctx;
  }

  function playVoice(voice, startTime) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, startTime);
    for (const point of voiceEnvelope(voice, startTime)) {
      gain.gain.linearRampToValueAtTime(point.value, point.time);
    }
    gain.connect(master);

    let source;
    if (voice.wave === 'noise') {
      source = ctx.createBufferSource();
      source.buffer = noiseBuffer;
      source.loop = true;
    } else {
      source = ctx.createOscillator();
      source.type = voice.wave;
      source.frequency.setValueAtTime(voice.freq, startTime + voice.at);
      if (voice.to) {
        source.frequency.exponentialRampToValueAtTime(voice.to, startTime + voice.at + voice.dur);
      }
    }
    source.connect(gain);
    source.start(startTime + voice.at);
    source.stop(startTime + voice.at + voice.dur + 0.02);
  }

  function play(name) {
    if (!enabled || !SFX[name]) return false;
    defer(() => {
      try {
        if (!ensureContext()) return;
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
        const startTime = ctx.currentTime + 0.01;
        for (const voice of SFX[name]) playVoice(voice, startTime);
      } catch (_) {
        // Audio is decoration; a failure must never affect the overlay
      }
    });
    return true;
  }

  return {
    enabled,
    play,
    playEvent(type, data) {
      const name = sfxForEvent(type, data);
      return name ? play(name) : false;
    },
    // Browsers may start the context suspended until a user gesture
    unlock() {
      if (!enabled) return;
      try {
        if (ensureContext() && ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      } catch (_) {}
    }
  };
}
