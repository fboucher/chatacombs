/**
 * Player repository and progression system for Chatacombs.
 * Persists viewer stats across runs.
 */

/**
 * Deterministic and monotonic XP-to-Level curve.
 * Level 1: 0-99 XP
 * Level 2: 100-249 XP
 * Level 3: 250-449 XP
 * Level 4: 450-699 XP
 * ...
 * @param {number} xp Cumulative XP
 * @returns {number} Level (minimum 1)
 */
export function calculateLevel(xp) {
  if (!xp || xp < 100) return 1;
  let level = 1;
  let needed = 100;
  let step = 150;
  while (xp >= needed) {
    level++;
    needed += step;
    step += 50;
  }
  return level;
}

export class PlayerRepository {
  /**
   * @param {import('better-sqlite3').Database} db 
   */
  constructor(db) {
    this.db = db;
    this._prepareStatements();
  }

  _prepareStatements() {
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO players (channel, username, display_name, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(channel, username) DO UPDATE SET
        display_name = excluded.display_name,
        last_seen_at = excluded.last_seen_at
      RETURNING *
    `);

    this.stmtGet = this.db.prepare(`
      SELECT * FROM players WHERE channel = ? AND username = ?
    `);

    this.stmtUpdateRewards = this.db.prepare(`
      UPDATE players
      SET xp = ?, level = ?, gold = ?, monsters_slain = ?, adventures_joined = ?, last_seen_at = ?
      WHERE channel = ? AND username = ?
      RETURNING *
    `);
  }

  /**
   * Upserts a player on chatter activity without wiping progression.
   * @param {string} channel 
   * @param {string} user 
   * @param {string} displayName 
   * @param {string} [now]
   * @returns {object} Player database record
   */
  upsertPlayer(channel, user, displayName, now = new Date().toISOString()) {
    const normChannel = channel.toLowerCase();
    const normUser = user.toLowerCase();
    return this.stmtUpsert.get(normChannel, normUser, displayName || user, now);
  }

  /**
   * Retrieves player record.
   * @param {string} channel 
   * @param {string} user 
   * @returns {object|null}
   */
  getPlayer(channel, user) {
    const normChannel = channel.toLowerCase();
    const normUser = user.toLowerCase();
    return this.stmtGet.get(normChannel, normUser) || null;
  }

  /**
   * Adds rewards (XP, gold, slain monsters, joined adventures) and computes new level.
   * @param {string} channel 
   * @param {string} user 
   * @param {object} rewards
   * @param {number} [rewards.xp=0]
   * @param {number} [rewards.gold=0]
   * @param {number} [rewards.monstersSlain=0]
   * @param {number} [rewards.adventuresJoined=0]
   * @param {string} [now]
   * @returns {object} Updated player record
   */
  addRewards(channel, user, { xp = 0, gold = 0, monstersSlain = 0, adventuresJoined = 0 } = {}, now = new Date().toISOString()) {
    const normChannel = channel.toLowerCase();
    const normUser = user.toLowerCase();
    const current = this.getPlayer(normChannel, normUser);
    if (!current) {
      throw new Error(`Player ${user} not found in channel ${channel}`);
    }

    const newXp = Math.max(0, current.xp + xp);
    const newLevel = calculateLevel(newXp);
    const newGold = Math.max(0, current.gold + gold);
    const newSlain = current.monsters_slain + monstersSlain;
    const newJoined = current.adventures_joined + adventuresJoined;

    return this.stmtUpdateRewards.get(
      newXp,
      newLevel,
      newGold,
      newSlain,
      newJoined,
      now,
      normChannel,
      normUser
    );
  }
}
