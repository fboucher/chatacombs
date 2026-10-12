import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SQL Schema definition from PLAN.md.
 */
export const SCHEMA_SQL = `
-- Player persistent stats across adventures
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  gold INTEGER NOT NULL DEFAULT 0,
  adventures_joined INTEGER NOT NULL DEFAULT 0,
  monsters_slain INTEGER NOT NULL DEFAULT 0,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel, username)
);

-- Adventures record
CREATE TABLE IF NOT EXISTS adventures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  theme TEXT NOT NULL,
  status TEXT NOT NULL, -- 'voting', 'active', 'cleared', 'wiped', 'abandoned'
  total_rooms INTEGER NOT NULL,
  current_room_index INTEGER NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME
);

-- Dungeon rooms generated per adventure
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adventure_id INTEGER NOT NULL REFERENCES adventures(id),
  room_number INTEGER NOT NULL,
  room_type TEXT NOT NULL, -- 'entrance', 'empty', 'trap', 'treasure', 'monster', 'boss'
  name TEXT NOT NULL,
  description TEXT,
  monster_data TEXT, -- JSON: { name, hp, maxHp, attack, defense, loot }
  exits TEXT NOT NULL, -- JSON array: ["north", "east", "trapdoor"]
  cleared INTEGER NOT NULL DEFAULT 0,
  looted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(adventure_id, room_number)
);

-- Active party runtime memory (persisted for crash recovery)
CREATE TABLE IF NOT EXISTS party_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adventure_id INTEGER NOT NULL REFERENCES adventures(id),
  username TEXT NOT NULL,
  hp INTEGER NOT NULL DEFAULT 20,
  max_hp INTEGER NOT NULL DEFAULT 20,
  is_knocked_out INTEGER NOT NULL DEFAULT 0,
  potions INTEGER NOT NULL DEFAULT 1,
  last_action_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(adventure_id, username)
);

-- Indices for fast querying
CREATE INDEX IF NOT EXISTS idx_players_channel_username ON players(channel, username);
CREATE INDEX IF NOT EXISTS idx_adventures_channel_status ON adventures(channel, status);
CREATE INDEX IF NOT EXISTS idx_rooms_adventure_number ON rooms(adventure_id, room_number);
CREATE INDEX IF NOT EXISTS idx_party_adventure_username ON party_members(adventure_id, username);
CREATE INDEX IF NOT EXISTS idx_party_last_action ON party_members(adventure_id, last_action_at);
`;

/**
 * Runs idempotent database migrations.
 * @param {Database.Database} db 
 */
export function runMigrations(db) {
  db.exec(SCHEMA_SQL);
}

/**
 * Initializes and returns a SQLite database connection.
 * @param {string|null} [dbPath=null] Path to sqlite database file or ':memory:'
 * @param {object} [options={}]
 * @returns {Database.Database}
 */
export function createDatabase(dbPath = null, options = {}) {
  const targetPath = dbPath || process.env.DATABASE_PATH || (
    process.env.NODE_ENV === 'production' ? '/data/chatacombs.db' : './data/chatacombs.db'
  );

  const isMemory = targetPath === ':memory:';

  if (!isMemory) {
    const dir = path.dirname(path.resolve(targetPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(targetPath, options);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Enable WAL mode for persistent files
  if (!isMemory) {
    db.pragma('journal_mode = WAL');
  }

  // Run schema migrations
  runMigrations(db);

  return db;
}
