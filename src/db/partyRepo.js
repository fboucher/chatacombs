/**
 * Party Repository for Chatacombs.
 * Manages runtime party members in the `party_members` table per adventure,
 * with 15-minute sliding window active party detection and state persistence.
 */

export const INACTIVITY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export class PartyRepository {
  /**
   * @param {import('better-sqlite3').Database} db 
   */
  constructor(db) {
    this.db = db;

    this.stmtUpsertMember = this.db.prepare(`
      INSERT INTO party_members (adventure_id, username, hp, max_hp, is_knocked_out, potions, last_action_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(adventure_id, username) DO UPDATE SET
        last_action_at = excluded.last_action_at
      RETURNING *
    `);

    this.stmtUpdateMemberStats = this.db.prepare(`
      UPDATE party_members
      SET hp = ?, max_hp = ?, is_knocked_out = ?, potions = ?
      WHERE adventure_id = ? AND username = ?
    `);

    this.stmtGetMember = this.db.prepare(`
      SELECT * FROM party_members
      WHERE adventure_id = ? AND username = ?
    `);

    this.stmtGetMembersByAdventure = this.db.prepare(`
      SELECT * FROM party_members
      WHERE adventure_id = ?
      ORDER BY id ASC
    `);

    this.stmtGetActiveMembers = this.db.prepare(`
      SELECT * FROM party_members
      WHERE adventure_id = ? AND last_action_at >= ?
      ORDER BY id ASC
    `);

    this.stmtUpdateAllStats = this.db.prepare(`
      UPDATE party_members
      SET hp = ?, max_hp = ?, is_knocked_out = ?, potions = ?
      WHERE adventure_id = ?
    `);
  }

  /**
   * Upserts a chatter into the party for a specific adventure.
   * If member exists, updates their last_action_at timestamp.
   * @param {number} adventureId 
   * @param {string} username 
   * @param {object} [stats] Initial stats if new row
   * @param {string|number} [actionTime]
   * @returns {object} The party_member row
   */
  upsertMember(adventureId, username, { hp = 20, maxHp = 20, isKnockedOut = 0, potions = 1 } = {}, actionTime = new Date().toISOString()) {
    const userNorm = username.toLowerCase();
    const timeIso = typeof actionTime === 'number' ? new Date(actionTime).toISOString() : actionTime;

    return this.stmtUpsertMember.get(
      adventureId,
      userNorm,
      hp,
      maxHp,
      isKnockedOut ? 1 : 0,
      potions,
      timeIso
    );
  }

  /**
   * Updates state (hp, max_hp, is_knocked_out, potions) for a party member.
   * @param {number} adventureId 
   * @param {string} username 
   * @param {object} stats 
   */
  updateMemberState(adventureId, username, { hp, maxHp, isKnockedOut, potions }) {
    const userNorm = username.toLowerCase();
    const current = this.stmtGetMember.get(adventureId, userNorm);
    if (!current) return;

    this.stmtUpdateMemberStats.run(
      hp !== undefined ? hp : current.hp,
      maxHp !== undefined ? maxHp : current.max_hp,
      isKnockedOut !== undefined ? (isKnockedOut ? 1 : 0) : current.is_knocked_out,
      potions !== undefined ? potions : current.potions,
      adventureId,
      userNorm
    );
  }

  /**
   * Retrieves a single member for an adventure.
   * @param {number} adventureId 
   * @param {string} username 
   * @returns {object|null}
   */
  getMember(adventureId, username) {
    return this.stmtGetMember.get(adventureId, username.toLowerCase()) || null;
  }

  /**
   * Retrieves all members recorded for an adventure.
   * @param {number} adventureId 
   * @returns {Array<object>}
   */
  getAllMembers(adventureId) {
    return this.stmtGetMembersByAdventure.all(adventureId);
  }

  /**
   * Retrieves active members whose last_action_at is within the cutoff window.
   * @param {number} adventureId 
   * @param {number|string} [now] Current timestamp (ms or ISO string)
   * @param {number} [windowMs=900000] Window in ms (default 15 minutes)
   * @returns {Array<object>}
   */
  getActiveMembers(adventureId, now = Date.now(), windowMs = INACTIVITY_WINDOW_MS) {
    const nowMs = typeof now === 'string' ? new Date(now).getTime() : now;
    const cutoffIso = new Date(nowMs - windowMs).toISOString();

    return this.stmtGetActiveMembers.all(adventureId, cutoffIso);
  }
}
