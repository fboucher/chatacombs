/**
 * Chatacombs OBS overlay client.
 * Renders the bottom ribbon, milestone takeovers and toasts from the overlay snapshot
 * (`overlay_state`) and live game events. It only displays what the server sends:
 * the engine owns every fact. All DOM writes are small and targeted (textContent,
 * classes, a style property), so the page stays idle between events.
 */
import { createSfxPlayer } from './audio.js';

export const TAKEOVER_DURATIONS_MS = {
  boss_appears: 4500,
  party_wiped: 5000,
  dungeon_cleared: 7000
};
export const MAX_QUEUED_TAKEOVERS = 3;
export const TOAST_DURATION_MS = 4000;
export const MAX_TOASTS = 5;
export const DIE_DURATION_MS = 2200;
export const MAX_DICE = 8;
export const TIMER_TICK_MS = 250;
export const RECONNECT_DELAY_MS = 3000;

// Game events the overlay listens for on the SSE stream
export const OVERLAY_EVENT_TYPES = [
  'adventure_started', 'room_entered', 'dice_roll', 'player_healed', 'rare_loot',
  'boss_appears', 'monster_defeated', 'player_knocked_out', 'party_wiped',
  'dungeon_cleared', 'adventure_ended'
];

/**
 * Parses the OBS Browser Source URL options.
 * @param {string} search location.search
 * @returns {{ key: string, audio: boolean, theme: 'retro'|'dark', scale: number, cam: 'left'|'right', bot: 'skeleton'|'mummy' }}
 */
export function parseConfig(search) {
  const params = new URLSearchParams(search || '');
  const audioParam = (params.get('audio') || '').toLowerCase();
  let scale = parseFloat(params.get('scale'));
  if (!Number.isFinite(scale)) scale = 1;
  scale = Math.min(1.2, Math.max(0.8, scale));

  return {
    key: params.get('key') || '',
    audio: audioParam === '1' || audioParam === 'true',
    theme: params.get('theme') === 'dark' ? 'dark' : 'retro',
    scale,
    // Bottom corner kept free for the webcam; the bot sits at the opposite end
    cam: (params.get('cam') || '').toLowerCase() === 'left' ? 'left' : 'right',
    bot: (params.get('bot') || '').toLowerCase() === 'mummy' ? 'mummy' : 'skeleton'
  };
}

/**
 * Extracts the channel from `/overlay/:channel`.
 * @param {string} pathname
 * @returns {string}
 */
export function channelFromPath(pathname) {
  const match = /\/overlay\/([^/?#]+)/.exec(pathname || '');
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * @param {number} ms
 * @returns {string} M:SS
 */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * @param {number} ms
 * @returns {string} e.g. "12m 03s"
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

// --- Pixel sprites -------------------------------------------------------------
// 12x12 grids: '.' empty, '1' outline, '2' body, '3' highlight, '4' eyes.
export const SPRITES = {
  slime: [
    '............',
    '............',
    '....1111....',
    '...122221...',
    '..12232221..',
    '..12222221..',
    '.1224224221.',
    '.1222222221.',
    '.1222222221.',
    '122222222221',
    '122222222221',
    '.1111111111.'
  ],
  skull: [
    '...111111...',
    '..12222221..',
    '.1222222221.',
    '.1232222221.',
    '.1244224421.',
    '.1244224421.',
    '.1222112221.',
    '..12222221..',
    '...121121...',
    '...121121...',
    '....1111....',
    '............'
  ],
  beast: [
    '.11......11.',
    '.121....121.',
    '.12211112221',
    '.1222222221.',
    '122422224221',
    '122222222221',
    '.1222332221.',
    '..12111121..',
    '..1222222221',
    '.12212212221',
    '.121.1..121.',
    '.11..1...11.'
  ],
  ghost: [
    '....1111....',
    '...122221...',
    '..12222221..',
    '.1223222221.',
    '.1244224421.',
    '.1222222221.',
    '.1222112221.',
    '.1222222221.',
    '.1222222221.',
    '.1222222221.',
    '.1212121221.',
    '.11.1.1.11..'
  ],
  dragon: [
    '1..........1',
    '11.111111.11',
    '.1122222211.',
    '..12422421..',
    '..12222221..',
    '.1222112221.',
    '122223322221',
    '121222222121',
    '11.122221.11',
    '...121121...',
    '..121..121..',
    '..11....11..'
  ],
  imp: [
    '..1......1..',
    '..11....11..',
    '...111111...',
    '..12222221..',
    '..12422421..',
    '..12222221..',
    '...121121...',
    '..12222221..',
    '.1212222121.',
    '.11.1221.11.',
    '....1..1....',
    '...11..11...'
  ]
};

const SPRITE_KEYWORDS = [
  ['slime', ['slime', 'ooze', 'blob', 'jelly', 'pudding']],
  ['skull', ['skeleton', 'skull', 'bone', 'lich', 'undead', 'zombie', 'mummy']],
  ['ghost', ['ghost', 'spirit', 'wraith', 'phantom', 'specter', 'spectre', 'shade', 'banshee']],
  ['dragon', ['dragon', 'wyrm', 'drake', 'hydra', 'wyvern']],
  ['beast', ['wolf', 'rat', 'bat', 'spider', 'beast', 'bear', 'hound', 'boar', 'cat', 'serpent', 'snake', 'crab']]
];

export const SPRITE_PALETTES = [
  { 1: '#1a1c2c', 2: '#38b764', 3: '#a7f070', 4: '#f4f4f4' },
  { 1: '#1a1c2c', 2: '#b13e53', 3: '#ef7d57', 4: '#ffcd75' },
  { 1: '#1a1c2c', 2: '#3b5dc9', 3: '#41a6f6', 4: '#f4f4f4' },
  { 1: '#1a1c2c', 2: '#5d275d', 3: '#b13e53', 4: '#ffcd75' },
  { 1: '#1a1c2c', 2: '#94b0c2', 3: '#f4f4f4', 4: '#b13e53' }
];

/**
 * Small stable string hash.
 * @param {string} text
 * @returns {number}
 */
export function hashString(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

/**
 * Picks a sprite for a monster from its name; bosses default to the dragon.
 * @param {string} name
 * @param {boolean} [isBoss=false]
 * @returns {string} key into SPRITES
 */
export function pickSprite(name, isBoss = false) {
  const lower = String(name || '').toLowerCase();
  for (const [sprite, words] of SPRITE_KEYWORDS) {
    if (words.some(w => lower.includes(w))) return sprite;
  }
  return isBoss ? 'dragon' : 'imp';
}

/**
 * Renders a pixel grid as a CSS box-shadow so a single element draws the sprite.
 * @param {string[]} rows
 * @param {Record<string, string>} palette
 * @param {number} px pixel size
 * @returns {string}
 */
export function spriteToBoxShadow(rows, palette, px) {
  const shadows = [];
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      const color = palette[cell];
      if (color) shadows.push(`${(x + 1) * px}px ${(y + 1) * px}px 0 ${color}`);
    });
  });
  return shadows.join(',');
}

// --- Overlay controller --------------------------------------------------------

/**
 * Creates the overlay controller bound to the page's DOM.
 * @param {object} options
 * @param {Document} options.document
 * @param {{ audio: boolean, theme: string, scale: number }} [options.config]
 * @param {() => number} [options.now]
 * @param {{ setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function }} [options.timers]
 * @param {{ playEvent: (type: string, data?: object) => boolean }} [options.audio]
 * @param {() => number} [options.random] Picks where each die lands; only cosmetic
 */
export function createOverlay(options) {
  const doc = options.document;
  const config = options.config || { audio: false, theme: 'retro', scale: 1, cam: 'right', bot: 'skeleton' };
  const now = options.now || (() => Date.now());
  const timers = options.timers || globalThis;
  const audio = options.audio || { playEvent: () => false };
  const random = options.random || Math.random;

  const el = id => doc.getElementById(id);
  const dom = {
    root: el('overlay'),
    ribbon: el('ribbon'),
    roomNumber: el('room-number'),
    roomTotal: el('room-total'),
    roomName: el('room-name'),
    themeBadge: el('theme-badge'),
    dots: el('progress-dots'),
    encounter: el('encounter'),
    encName: el('enc-name'),
    encSprite: el('enc-sprite'),
    encHpFill: el('enc-hp-fill'),
    encHpTrail: el('enc-hp-trail'),
    encHpText: el('enc-hp-text'),
    encStatus: el('enc-status'),
    encFlash: el('enc-flash'),
    partyCount: el('party-count'),
    koCount: el('ko-count'),
    koIndicator: el('ko-indicator'),
    timer: el('timer'),
    timerLabel: el('timer-label'),
    timerText: el('timer-text'),
    timerFill: el('timer-fill'),
    timerTallies: el('timer-tallies'),
    takeover: el('takeover'),
    takeoverTitle: el('takeover-title'),
    takeoverSub: el('takeover-sub'),
    takeoverStats: el('takeover-stats'),
    takeoverFx: el('takeover-fx'),
    toasts: el('toasts'),
    dice: el('dice'),
    botImg: el('bot-img')
  };

  const state = {
    view: null,
    totalRooms: 0,
    roomNumber: 0,
    encounterKey: null,
    hp: null,
    maxHp: null,
    timer: null, // { label, endsAt, durationMs }
    timerHandle: null,
    flashHandle: null,
    takeover: null, // { type, handle }
    takeoverQueue: [],
    toasts: [], // { node, handle }
    dice: [] // { node, handle }
  };

  dom.root.classList.add(`theme-${config.theme}`);
  dom.root.style.setProperty('--scale', String(config.scale));
  dom.root.classList.add(`cam-${config.cam || 'right'}`);
  if (dom.botImg) {
    const picture = dom.botImg.getAttribute(`data-${config.bot || 'skeleton'}`);
    if (picture) dom.botImg.setAttribute('src', picture);
  }

  // --- Left: progress ---
  function renderProgress(roomNumber, totalRooms, roomName, theme) {
    if (totalRooms !== state.totalRooms) {
      while (dom.dots.firstChild) dom.dots.removeChild(dom.dots.firstChild);
      for (let i = 1; i <= totalRooms; i++) {
        const dot = doc.createElement('span');
        dot.className = 'dot';
        dom.dots.appendChild(dot);
      }
      state.totalRooms = totalRooms;
    }
    state.roomNumber = roomNumber;

    const dots = dom.dots.children;
    for (let i = 0; i < dots.length; i++) {
      const n = i + 1;
      dots[i].classList.toggle('is-done', n < roomNumber);
      dots[i].classList.toggle('is-current', n === roomNumber);
      dots[i].classList.toggle('is-boss', n === totalRooms);
    }

    dom.roomNumber.textContent = roomNumber > 0 ? String(roomNumber) : '-';
    dom.roomTotal.textContent = totalRooms > 0 ? String(totalRooms) : '-';
    if (roomName !== undefined) dom.roomName.textContent = roomName || '';
    if (theme !== undefined) {
      dom.themeBadge.textContent = theme || 'No adventure';
      dom.themeBadge.classList.toggle('is-empty', !theme);
    }
  }

  // --- Center: encounter ---
  function setHp(hp, maxHp) {
    state.hp = hp;
    state.maxHp = maxHp;
    const pct = maxHp > 0 ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 0;
    dom.encHpFill.style.width = `${pct}%`;
    dom.encHpTrail.style.width = `${pct}%`;
    dom.encHpFill.classList.toggle('is-low', pct <= 25);
    dom.encHpText.textContent = `${hp}/${maxHp}`;
  }

  function renderEncounter(encounter, statusText) {
    if (!encounter) {
      state.encounterKey = null;
      dom.encounter.classList.remove('has-monster', 'is-boss', 'is-defeated');
      dom.encName.textContent = '';
      dom.encSprite.style.boxShadow = 'none';
      dom.encStatus.textContent = statusText || '';
      return;
    }

    const key = `${encounter.name}|${encounter.maxHp}`;
    if (key !== state.encounterKey) {
      state.encounterKey = key;
      const sprite = SPRITES[pickSprite(encounter.name, encounter.isBoss)];
      const palette = SPRITE_PALETTES[hashString(encounter.name) % SPRITE_PALETTES.length];
      dom.encSprite.style.boxShadow = spriteToBoxShadow(sprite, palette, encounter.isBoss ? 6 : 5);
    }

    dom.encounter.classList.add('has-monster');
    dom.encounter.classList.toggle('is-boss', Boolean(encounter.isBoss));
    dom.encounter.classList.toggle('is-defeated', Boolean(encounter.defeated));
    dom.encName.textContent = encounter.name;
    setHp(encounter.hp, encounter.maxHp);
    if (statusText !== undefined) dom.encStatus.textContent = statusText;
  }

  function flashCard(kind) {
    dom.encFlash.className = `enc-flash is-${kind}`;
    if (state.flashHandle) timers.clearTimeout(state.flashHandle);
    state.flashHandle = timers.setTimeout(() => {
      dom.encFlash.className = 'enc-flash';
      state.flashHandle = null;
    }, 450);
  }

  function statusText(view) {
    if (view.encounter && view.status === 'active') {
      if (view.encounter.defeated) return 'Defeated!';
      return view.encounter.isBoss ? 'Boss battle! !attack !defend !heal' : 'Fight! !attack !defend !heal';
    }
    if (view.status === 'voting') return 'Choose the next dungeon!';
    if (view.status === 'cleared') return 'Dungeon cleared!';
    if (view.status === 'wiped') return 'The party has fallen...';
    if (view.status === 'abandoned') return 'The adventure has ended.';
    if (view.status !== 'active' || !view.currentRoom) return '';
    if (view.currentRoom.searched) return 'Room searched. Pick an exit!';
    return 'Exploring...';
  }

  // --- Right: party + timer ---
  function renderParty(partyCount, koCount) {
    dom.partyCount.textContent = String(partyCount);
    dom.koCount.textContent = String(koCount);
    dom.koIndicator.classList.toggle('has-ko', koCount > 0);
  }

  function renderTimerFrame() {
    const timer = state.timer;
    if (!timer) return;
    const remaining = Math.max(0, timer.endsAt - now());
    dom.timerText.textContent = formatCountdown(remaining);
    const pct = timer.durationMs > 0 ? (remaining / timer.durationMs) * 100 : 0;
    dom.timerFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    dom.timer.classList.toggle('is-urgent', remaining <= 10000);
    if (remaining <= 0 && state.timerHandle) {
      timers.clearInterval(state.timerHandle);
      state.timerHandle = null;
    }
  }

  function renderTimer(timer) {
    if (state.timerHandle) {
      timers.clearInterval(state.timerHandle);
      state.timerHandle = null;
    }
    if (!timer) {
      state.timer = null;
      dom.timer.classList.remove('is-active', 'is-urgent');
      dom.timerTallies.textContent = '';
      return;
    }

    state.timer = { label: timer.label, endsAt: now() + timer.remainingMs, durationMs: timer.durationMs };
    dom.timer.classList.add('is-active');
    dom.timerLabel.textContent = timer.label;
    dom.timerTallies.textContent = (timer.tallies || [])
      .filter(t => t.votes > 0)
      .map(t => `${t.choice} (${t.votes})`)
      .join('  ');
    renderTimerFrame();
    if (timer.remainingMs > 0) {
      state.timerHandle = timers.setInterval(renderTimerFrame, TIMER_TICK_MS);
    }
  }

  // --- Snapshot ---
  function applySnapshot(view) {
    if (!view || typeof view !== 'object') return;
    state.view = view;

    const idle = view.status === 'idle' || !view.status;
    dom.ribbon.classList.toggle('is-idle', idle);

    const progress = view.progress || { roomNumber: 0, totalRooms: 0 };
    const badge = view.theme || (view.status === 'voting' ? 'Theme vote' : null);
    renderProgress(progress.roomNumber, progress.totalRooms, view.currentRoom ? view.currentRoom.name : '', badge);
    renderEncounter(view.encounter, statusText(view));
    renderParty(view.partyCount || 0, view.koCount || 0);
    renderTimer(view.timer);
  }

  // --- Takeovers ---
  function fillTakeover(type, data) {
    dom.takeoverStats.textContent = '';
    while (dom.takeoverFx.firstChild) dom.takeoverFx.removeChild(dom.takeoverFx.firstChild);

    if (type === 'boss_appears') {
      dom.takeoverTitle.textContent = 'WARNING: BOSS ENCOUNTER';
      dom.takeoverSub.textContent = data.monster ? `${data.monster} appears!` : '';
      if (data.maxHp) dom.takeoverStats.textContent = `HP ${data.hp ?? data.maxHp}/${data.maxHp}`;
    } else if (type === 'party_wiped') {
      dom.takeoverTitle.textContent = 'PARTY DEFEATED';
      dom.takeoverSub.textContent = data.roomNumber ? `Fallen in room ${data.roomNumber}` : '';
    } else if (type === 'dungeon_cleared') {
      dom.takeoverTitle.textContent = 'DUNGEON CLEARED!';
      dom.takeoverSub.textContent = data.theme || '';
      const parts = [];
      if (data.durationMs !== undefined) parts.push(`Time ${formatDuration(data.durationMs)}`);
      if (data.totalRooms !== undefined) parts.push(`Rooms ${data.totalRooms}`);
      if (data.monstersSlain !== undefined) parts.push(`Monsters slain ${data.monstersSlain}`);
      dom.takeoverStats.textContent = parts.join('  |  ');
      for (let i = 0; i < 24; i++) {
        const coin = doc.createElement('span');
        coin.className = 'coin';
        // Spread coins across the screen with staggered, varied falls
        coin.style.left = `${(i * 41 + 7) % 100}%`;
        coin.style.animationDelay = `${((i * 7) % 12) * 0.2}s`;
        coin.style.animationDuration = `${2 + (i % 5) * 0.3}s`;
        dom.takeoverFx.appendChild(coin);
      }
    }
  }

  function showTakeover(type, data) {
    state.takeover = {
      type,
      handle: timers.setTimeout(dismissTakeover, TAKEOVER_DURATIONS_MS[type])
    };
    fillTakeover(type, data || {});
    dom.takeover.className = `takeover is-active takeover-${type}`;
  }

  function dismissTakeover() {
    if (state.takeover) {
      timers.clearTimeout(state.takeover.handle);
      state.takeover = null;
    }
    dom.takeover.className = 'takeover';
    while (dom.takeoverFx.firstChild) dom.takeoverFx.removeChild(dom.takeoverFx.firstChild);

    const next = state.takeoverQueue.shift();
    if (next) showTakeover(next.type, next.data);
  }

  function queueTakeover(type, data) {
    if (!state.takeover) {
      showTakeover(type, data);
      return;
    }
    if (state.takeover.type === type || state.takeoverQueue.some(t => t.type === type)) return;
    if (state.takeoverQueue.length >= MAX_QUEUED_TAKEOVERS) state.takeoverQueue.shift();
    state.takeoverQueue.push({ type, data });
  }

  // --- Toasts ---
  function removeToast(entry) {
    timers.clearTimeout(entry.handle);
    const index = state.toasts.indexOf(entry);
    if (index !== -1) state.toasts.splice(index, 1);
    if (entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
  }

  function showToast(kind, icon, text) {
    if (state.toasts.length >= MAX_TOASTS) removeToast(state.toasts[0]);

    const node = doc.createElement('div');
    node.className = `toast toast-${kind}`;
    const iconNode = doc.createElement('span');
    iconNode.className = 'toast-icon';
    iconNode.textContent = icon;
    const textNode = doc.createElement('span');
    textNode.className = 'toast-text';
    textNode.textContent = text;
    node.appendChild(iconNode);
    node.appendChild(textNode);
    dom.toasts.appendChild(node);

    const entry = { node, handle: null };
    entry.handle = timers.setTimeout(() => removeToast(entry), TOAST_DURATION_MS);
    state.toasts.push(entry);
    return node;
  }

  // --- Dice: one d20 per throw, landing at a random spot along the ribbon ---
  // Static outline of a d20 seen face-on; the number is a separate text node.
  const D20_SVG = '<svg class="die-shape" viewBox="0 0 64 64" aria-hidden="true">' +
    '<polygon class="die-body" points="32,3 57,17.5 57,46.5 32,61 7,46.5 7,17.5"/>' +
    '<polygon class="die-face" points="32,14 49,43 15,43"/>' +
    '<path class="die-edge" d="M32,3 L32,14 M57,17.5 L49,43 M57,46.5 L49,43 M32,61 L49,43 M32,61 L15,43 M7,46.5 L15,43 M7,17.5 L15,43 M7,17.5 L32,14 M57,17.5 L32,14"/>' +
    '</svg>';

  function removeDie(entry) {
    timers.clearTimeout(entry.handle);
    const index = state.dice.indexOf(entry);
    if (index !== -1) state.dice.splice(index, 1);
    if (entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
  }

  function rollDie(data) {
    if (!dom.dice || !Number.isFinite(Number(data.roll))) return null;
    if (state.dice.length >= MAX_DICE) removeDie(state.dice[0]);

    const node = doc.createElement('div');
    let outcome = '';
    if (data.success === true) outcome = data.isCrit ? ' is-crit' : ' is-hit';
    if (data.success === false) outcome = ' is-miss';
    node.className = `die${outcome}`;
    // Overlap is fine: each throw gets its own spot, so stacked rolls stay visible
    const x = Math.min(1, Math.max(0, random()));
    node.style.setProperty('--x', x.toFixed(3));
    node.innerHTML = D20_SVG;
    const value = doc.createElement('span');
    value.className = 'die-value';
    value.textContent = String(data.roll);
    node.appendChild(value);
    dom.dice.appendChild(node);

    const entry = { node, handle: null };
    entry.handle = timers.setTimeout(() => removeDie(entry), DIE_DURATION_MS);
    state.dice.push(entry);
    return node;
  }

  function nameOf(data, field = 'user') {
    return data.displayName || data[field] || 'Someone';
  }

  function toastFor(type, data) {
    switch (type) {
      case 'player_healed': {
        const target = data.target || data.user || 'Someone';
        const by = data.user && data.target && data.user !== data.target ? ` (by ${data.user})` : '';
        return showToast('heal', '+HP', `${target} +${data.amount ?? 0} HP${by}`);
      }
      case 'dice_roll': {
        const mod = data.modifier ?? (data.total !== undefined ? data.total - data.roll : 0);
        let text = `${nameOf(data)} rolled ${data.roll}`;
        if (mod) text += ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)} = ${data.total}`;
        if (data.dc !== undefined) text += ` vs DEF ${data.dc}`;
        if (data.success === true) text += data.isCrit ? ' CRIT!' : ' HIT';
        if (data.success === false) text += ' MISS';
        return showToast('dice', 'd20', text);
      }
      case 'rare_loot': {
        const parts = [];
        if (data.item) parts.push(String(data.item).replace(/_/g, ' '));
        if (data.gold) parts.push(`${data.gold} gold`);
        return showToast('loot', '*', `${data.user || 'The party'} found ${parts.join(' + ') || 'treasure'}!`);
      }
      case 'player_knocked_out':
        return showToast('ko', 'KO', `${nameOf(data)} was knocked out!`);
      default:
        return null;
    }
  }

  // --- Live events ---
  function handleEvent(type, data = {}) {
    switch (type) {
      case 'adventure_started':
        dom.ribbon.classList.remove('is-idle');
        renderProgress(state.roomNumber, data.totalRooms || state.totalRooms, undefined, data.theme);
        break;
      case 'room_entered':
        renderProgress(data.roomNumber, state.totalRooms, data.roomName);
        if (data.roomType !== 'monster' && data.roomType !== 'boss') {
          renderEncounter(null, 'Exploring...');
        }
        break;
      case 'boss_appears':
        renderEncounter({ name: data.monster, hp: data.hp, maxHp: data.maxHp, isBoss: true, defeated: false }, 'Boss battle! !attack !defend !heal');
        queueTakeover(type, data);
        break;
      case 'dice_roll':
        if (data.monsterHp !== undefined && state.encounterKey) {
          setHp(data.monsterHp, data.monsterMaxHp ?? state.maxHp);
        }
        if (data.success !== undefined && state.encounterKey) {
          flashCard(data.success ? (data.isCrit ? 'crit' : 'hit') : 'miss');
        }
        rollDie(data);
        toastFor(type, data);
        break;
      case 'monster_defeated':
        if (state.encounterKey) {
          setHp(0, data.maxHp ?? state.maxHp);
          dom.encounter.classList.add('is-defeated');
          dom.encStatus.textContent = 'Defeated!';
        }
        break;
      case 'player_knocked_out': {
        // The next overlay_state carries the authoritative count
        const ko = parseInt(dom.koCount.textContent, 10) || 0;
        renderParty(parseInt(dom.partyCount.textContent, 10) || 0, ko + 1);
        toastFor(type, data);
        break;
      }
      case 'player_healed':
      case 'rare_loot':
        toastFor(type, data);
        break;
      case 'party_wiped':
      case 'dungeon_cleared':
        queueTakeover(type, data);
        break;
      default:
        break;
    }

    audio.playEvent(type, data);
  }

  return {
    applySnapshot,
    handleEvent,
    dismissTakeover,
    get state() {
      return state;
    },
    destroy() {
      if (state.timerHandle) timers.clearInterval(state.timerHandle);
      if (state.flashHandle) timers.clearTimeout(state.flashHandle);
      if (state.takeover) timers.clearTimeout(state.takeover.handle);
      for (const entry of [...state.toasts]) removeToast(entry);
      for (const entry of [...state.dice]) removeDie(entry);
      state.takeoverQueue = [];
    }
  };
}

/**
 * Opens the overlay's SSE stream. Native EventSource retries on network drops;
 * if the browser gives up (CLOSED), a fresh connection is opened after a delay.
 * Every (re)connect receives an `overlay_state` snapshot first, so the ribbon re-syncs.
 * @param {object} options
 * @param {string} options.url
 * @param {typeof EventSource} options.EventSourceCtor
 * @param {{ applySnapshot: Function, handleEvent: Function }} options.overlay
 * @param {{ setTimeout: Function }} [options.timers]
 * @returns {{ close: () => void }}
 */
export function connectStream(options) {
  const { url, EventSourceCtor, overlay } = options;
  const timers = options.timers || globalThis;
  let source = null;
  let closed = false;

  function parse(event) {
    try {
      return JSON.parse(event.data);
    } catch (_) {
      return null;
    }
  }

  function open() {
    source = new EventSourceCtor(url);
    source.addEventListener('overlay_state', event => {
      const view = parse(event);
      if (view) overlay.applySnapshot(view);
    });
    for (const type of OVERLAY_EVENT_TYPES) {
      source.addEventListener(type, event => {
        const data = parse(event);
        if (data) overlay.handleEvent(type, data);
      });
    }
    source.onerror = () => {
      if (closed || source.readyState !== 2) return; // 2 = CLOSED; otherwise the browser retries
      source.close();
      timers.setTimeout(() => {
        if (!closed) open();
      }, RECONNECT_DELAY_MS);
    };
  }

  open();
  return {
    close() {
      closed = true;
      if (source) source.close();
    }
  };
}

/**
 * Browser entry point: cold boot from the snapshot, then go live over SSE.
 * @param {Window} win
 */
export function startOverlay(win) {
  const config = parseConfig(win.location.search);
  const channel = channelFromPath(win.location.pathname);
  const base = `/overlay/${encodeURIComponent(channel)}`;
  const query = `?key=${encodeURIComponent(config.key)}`;

  const audio = createSfxPlayer({ enabled: config.audio });
  const overlay = createOverlay({ document: win.document, config, audio });
  if (config.audio) {
    win.addEventListener('pointerdown', () => audio.unlock(), { once: true });
  }

  win.fetch(`${base}/state${query}`)
    .then(res => (res.ok ? res.json() : null))
    .then(view => {
      // The stream's own snapshot is newer if it already arrived
      if (view && !overlay.state.view) overlay.applySnapshot(view);
    })
    .catch(() => {});

  connectStream({ url: `${base}/events${query}`, EventSourceCtor: win.EventSource, overlay });
  return overlay;
}
