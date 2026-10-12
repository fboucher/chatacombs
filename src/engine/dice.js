/**
 * Dice and probability helpers for Chatacombs.
 * Pure functions supporting deterministic/seedable RNG.
 */

/**
 * Creates a deterministic seedable pseudo-random number generator (Mulberry32).
 * Returns a function that produces numbers in [0, 1).
 * @param {number} seed 
 * @returns {() => number}
 */
export function createRng(seed = 123456789) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Roll a die with N sides.
 * @param {number} sides 
 * @param {() => number} [rng=Math.random]
 * @returns {number} Integer between 1 and sides inclusive
 */
export function rollDie(sides, rng = Math.random) {
  if (sides < 1) throw new Error("Die must have at least 1 side");
  return Math.floor(rng() * sides) + 1;
}

/**
 * Roll a single 20-sided die (d20).
 * @param {() => number} [rng=Math.random]
 * @returns {number}
 */
export function rollD20(rng = Math.random) {
  return rollDie(20, rng);
}

/**
 * Roll a single 6-sided die (d6).
 * @param {() => number} [rng=Math.random]
 * @returns {number}
 */
export function rollD6(rng = Math.random) {
  return rollDie(6, rng);
}

/**
 * Roll a d20 with optional advantage or disadvantage.
 * @param {number} [advantage=0] >0 for advantage, <0 for disadvantage, 0 for normal
 * @param {() => number} [rng=Math.random]
 * @returns {{ roll: number, rolls: number[], advantage: number }}
 */
export function rollD20WithAdvantage(advantage = 0, rng = Math.random) {
  if (advantage > 0) {
    const r1 = rollD20(rng);
    const r2 = rollD20(rng);
    return {
      roll: Math.max(r1, r2),
      rolls: [r1, r2],
      advantage: 1
    };
  }
  if (advantage < 0) {
    const r1 = rollD20(rng);
    const r2 = rollD20(rng);
    return {
      roll: Math.min(r1, r2),
      rolls: [r1, r2],
      advantage: -1
    };
  }
  const r = rollD20(rng);
  return {
    roll: r,
    rolls: [r],
    advantage: 0
  };
}

/**
 * Check a d20 roll against a Difficulty Class (DC).
 * @param {number} dc Target DC to beat or match
 * @param {number} [bonus=0] Modifier added to roll
 * @param {number} [advantage=0] >0 advantage, <0 disadvantage
 * @param {() => number} [rng=Math.random]
 * @returns {{ roll: number, rolls: number[], bonus: number, total: number, dc: number, success: boolean, isCrit: boolean, isFumble: boolean }}
 */
export function checkDC(dc, bonus = 0, advantage = 0, rng = Math.random) {
  const { roll, rolls } = rollD20WithAdvantage(advantage, rng);
  const total = roll + bonus;
  const isCrit = roll === 20;
  const isFumble = roll === 1;
  const success = isCrit ? true : (isFumble ? false : total >= dc);
  return {
    roll,
    rolls,
    bonus,
    total,
    dc,
    success,
    isCrit,
    isFumble
  };
}

/**
 * Roll damage: sum(count * dSides) + bonus.
 * @param {number} count Number of dice
 * @param {number} sides Number of sides per die
 * @param {number} [bonus=0] Added modifier
 * @param {() => number} [rng=Math.random]
 * @returns {{ rolls: number[], sum: number, bonus: number, total: number }}
 */
export function rollDamage(count, sides, bonus = 0, rng = Math.random) {
  const rolls = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const r = rollDie(sides, rng);
    rolls.push(r);
    sum += r;
  }
  const total = Math.max(0, sum + bonus);
  return {
    rolls,
    sum,
    bonus,
    total
  };
}
