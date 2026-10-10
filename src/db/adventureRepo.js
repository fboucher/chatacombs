/**
 * Adventure Repository for Chatacombs.
 * Persists active dungeon state, rooms, and enables crash recovery on boot.
 */

export class AdventureRepository {
  /**
   * @param {import('better-sqlite3').Database} db 
   */
  constructor(db) {
    this.db = db;
    this._prepareStatements();
  }

  _prepareStatements() {
    this.stmtInsertAdventure = this.db.prepare(`
      INSERT INTO adventures (channel, theme, status, total_rooms, current_room_index, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    this.stmtUpdateAdventure = this.db.prepare(`
      UPDATE adventures
      SET theme = ?, status = ?, total_rooms = ?, current_room_index = ?, ended_at = ?
      WHERE id = ?
      RETURNING *
    `);

    this.stmtUpdateStatus = this.db.prepare(`
      UPDATE adventures
      SET status = ?, ended_at = ?
      WHERE id = ?
      RETURNING *
    `);

    this.stmtUpdateCurrentRoomIndex = this.db.prepare(`
      UPDATE adventures
      SET current_room_index = ?
      WHERE id = ?
    `);

    this.stmtInsertRoom = this.db.prepare(`
      INSERT INTO rooms (adventure_id, room_number, room_type, name, description, monster_data, exits, cleared, looted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(adventure_id, room_number) DO UPDATE SET
        room_type = excluded.room_type,
        name = excluded.name,
        description = excluded.description,
        monster_data = excluded.monster_data,
        exits = excluded.exits,
        cleared = excluded.cleared,
        looted = excluded.looted
    `);

    this.stmtUpdateRoom = this.db.prepare(`
      UPDATE rooms
      SET cleared = ?, looted = ?, monster_data = ?
      WHERE adventure_id = ? AND room_number = ?
    `);

    this.stmtGetLatest = this.db.prepare(`
      SELECT * FROM adventures
      WHERE channel = ?
      ORDER BY id DESC
      LIMIT 1
    `);

    this.stmtGetAdventureById = this.db.prepare(`
      SELECT * FROM adventures WHERE id = ?
    `);

    this.stmtGetRooms = this.db.prepare(`
      SELECT * FROM rooms
      WHERE adventure_id = ?
      ORDER BY room_number ASC
    `);
  }

  /**
   * Creates a new adventure record.
   * @param {string} channel 
   * @param {string} theme 
   * @param {number} totalRooms 
   * @param {string} [status='voting']
   * @param {string} [startedAt]
   * @returns {object}
   */
  createAdventure(channel, theme, totalRooms, status = 'voting', startedAt = new Date().toISOString()) {
    const normChannel = channel.toLowerCase();
    return this.stmtInsertAdventure.get(normChannel, theme, status, totalRooms, 0, startedAt);
  }

  /**
   * Updates an existing adventure row.
   * @param {number} adventureId 
   * @param {object} updates 
   * @returns {object}
   */
  updateAdventure(adventureId, { theme, status, totalRooms, currentRoomIndex = 0, endedAt = null }) {
    return this.stmtUpdateAdventure.get(theme, status, totalRooms, currentRoomIndex, endedAt, adventureId);
  }

  /**
   * Updates only adventure status and optional endedAt.
   * @param {number} adventureId 
   * @param {string} status 'voting' | 'active' | 'cleared' | 'wiped' | 'abandoned'
   * @param {string|null} [endedAt=null]
   * @returns {object}
   */
  updateStatus(adventureId, status, endedAt = null) {
    return this.stmtUpdateStatus.get(status, endedAt, adventureId);
  }

  /**
   * Updates the current room index.
   * @param {number} adventureId 
   * @param {number} roomIndex 
   */
  updateCurrentRoomIndex(adventureId, roomIndex) {
    this.stmtUpdateCurrentRoomIndex.run(roomIndex, adventureId);
  }

  /**
   * Batch persists room structures for an adventure.
   * @param {number} adventureId 
   * @param {Array<object>} rooms 
   */
  saveRooms(adventureId, rooms) {
    const insertMany = this.db.transaction((roomList) => {
      for (const r of roomList) {
        const monsterJson = r.monster ? JSON.stringify(r.monster) : null;
        const exitsJson = JSON.stringify(r.exits || []);
        this.stmtInsertRoom.run(
          adventureId,
          r.roomNumber || r.id,
          r.type,
          r.name || `Chamber ${r.roomNumber || r.id}`,
          r.description || null,
          monsterJson,
          exitsJson,
          r.cleared ? 1 : 0,
          r.exploration?.searched ? 1 : 0
        );
      }
    });

    insertMany(rooms);
  }

  /**
   * Updates state of a specific room (cleared, looted, monster state).
   * @param {number} adventureId 
   * @param {number} roomNumber 
   * @param {object} details 
   */
  updateRoomState(adventureId, roomNumber, { cleared = 0, looted = 0, monster = null } = {}) {
    const monsterJson = monster ? JSON.stringify(monster) : null;
    this.stmtUpdateRoom.run(cleared ? 1 : 0, looted ? 1 : 0, monsterJson, adventureId, roomNumber);
  }

  /**
   * Retrieves an adventure and its fully reconstructed room graph.
   * @param {number} adventureId 
   * @returns {object|null}
   */
  getAdventureWithRooms(adventureId) {
    const adv = this.stmtGetAdventureById.get(adventureId);
    if (!adv) return null;

    const rawRooms = this.stmtGetRooms.all(adventureId);
    const rooms = rawRooms.map(r => ({
      id: r.room_number,
      roomNumber: r.room_number,
      type: r.room_type,
      name: r.name,
      description: r.description,
      cleared: Boolean(r.cleared),
      monster: r.monster_data ? JSON.parse(r.monster_data) : null,
      exits: r.exits ? JSON.parse(r.exits) : [],
      exploration: {
        searched: Boolean(r.looted),
        hasLoot: false,
        loot: null,
        hasTrap: false,
        trap: null,
        secretExit: null
      }
    }));

    return {
      id: adv.id,
      channel: adv.channel,
      theme: adv.theme,
      status: adv.status,
      totalRooms: adv.total_rooms,
      currentRoomIndex: adv.current_room_index,
      startedAt: adv.started_at,
      endedAt: adv.ended_at,
      rooms
    };
  }

  /**
   * Restores an interrupted active or voting adventure for crash recovery.
   * If latest adventure is cleared, wiped, or abandoned, returns null.
   * @param {string} channel 
   * @returns {object|null}
   */
  restoreActiveAdventure(channel) {
    const normChannel = channel.toLowerCase();
    const latest = this.stmtGetLatest.get(normChannel);
    if (!latest) return null;

    // Only restore if in voting or active status
    if (latest.status !== 'voting' && latest.status !== 'active') {
      return null;
    }

    return this.getAdventureWithRooms(latest.id);
  }
}
