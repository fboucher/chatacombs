import { rollD20 } from './dice.js';
import { createSayEvent, createGameEvent } from './events.js';
import { Adventure } from './adventure.js';
import { PlayerRepository } from '../db/playerRepo.js';
import { AdventureRepository } from '../db/adventureRepo.js';
import { PartyRepository, INACTIVITY_WINDOW_MS } from '../db/partyRepo.js';

/**
 * Chatacombs Core Engine.
 * Pure code engine: deterministic, testable, and offline.
 */
export class Engine {
  /**
   * @param {object} [options={}]
   * @param {() => number} [options.rng=Math.random]
   * @param {() => number} [options.clock=() => Date.now()]
   * @param {number} [options.voteDurationMs=60000]
   * @param {number} [options.inactivityThresholdMs=120000]
   * @param {number} [options.nudgeIntervalMs=600000]
   * @param {string} [options.channel='default']
   * @param {import('better-sqlite3').Database} [options.db]
   * @param {PlayerRepository} [options.playerRepo]
   * @param {AdventureRepository} [options.adventureRepo]
   * @param {PartyRepository} [options.partyRepo]
   * @param {object} [options.initialState={}]
   */
  constructor(options = {}) {
    this.rng = options.rng || Math.random;
    this.clock = options.clock || (() => Date.now());
    this.voteDurationMs = options.voteDurationMs ?? 60000;
    this.inactivityThresholdMs = options.inactivityThresholdMs ?? 120000;
    this.nudgeIntervalMs = options.nudgeIntervalMs ?? 600000;
    this.channel = (options.channel || 'default').toLowerCase();

    this.db = options.db || null;
    this.playerRepo = options.playerRepo || (this.db ? new PlayerRepository(this.db) : null);
    this.adventureRepo = options.adventureRepo || (this.db ? new AdventureRepository(this.db) : null);
    this.partyRepo = options.partyRepo || (this.db ? new PartyRepository(this.db) : null);

    this.adventure = new Adventure({
      rng: this.rng,
      clock: this.clock,
      voteDurationMs: this.voteDurationMs,
      inactivityThresholdMs: this.inactivityThresholdMs,
      nudgeIntervalMs: this.nudgeIntervalMs,
      channel: this.channel,
      adventureRepo: this.adventureRepo,
      partyRepo: this.partyRepo,
      playerRepo: this.playerRepo
    });

    this.state = {
      party: new Map(), // username -> { displayName, lastSeenAt, hp, maxHp, isKnockedOut, ... }
      ...options.initialState
    };
  }

  get status() {
    return this.adventure.status;
  }

  /**
   * Opens theme voting for a new adventure.
   * @returns {Array<object>} Events emitted
   */
  startThemeVote() {
    return this.adventure.openThemeVote();
  }

  /**
   * Restores an active or voting adventure from SQLite for crash recovery.
   * Returns restored adventure instance or null if none active.
   * @returns {Adventure|null}
   */
  restoreFromDb() {
    if (!this.adventureRepo) return null;
    const restored = this.adventureRepo.restoreActiveAdventure(this.channel);
    if (!restored) return null;

    this.adventure = new Adventure({
      rng: this.rng,
      clock: this.clock,
      voteDurationMs: this.voteDurationMs,
      inactivityThresholdMs: this.inactivityThresholdMs,
      nudgeIntervalMs: this.nudgeIntervalMs,
      channel: this.channel,
      adventureRepo: this.adventureRepo,
      partyRepo: this.partyRepo,
      playerRepo: this.playerRepo,
      id: restored.id,
      theme: restored.theme,
      status: restored.status,
      dungeon: {
        theme: restored.theme,
        totalRooms: restored.totalRooms,
        rooms: restored.rooms
      },
      currentRoom: restored.rooms[restored.currentRoomIndex] || restored.rooms[0]
    });

    // Restore party members from database if partyRepo is present
    if (this.partyRepo && restored.id) {
      const dbMembers = this.partyRepo.getAllMembers(restored.id);
      for (const m of dbMembers) {
        const lastSeenMs = new Date(m.last_action_at).getTime();
        this.state.party.set(m.username, {
          username: m.username,
          displayName: m.username, // Will update when they speak again
          hp: m.hp,
          maxHp: m.max_hp,
          isKnockedOut: Boolean(m.is_knocked_out),
          potions: m.potions,
          lastSeenAt: lastSeenMs
        });
      }
    }

    return this.adventure;
  }

  /**
   * Advances the engine clock and resolves any expired timers.
   * @param {number} [currentTime]
   * @returns {Array<object>} Events emitted
   */
  tick(currentTime = this.clock()) {
    return this.adventure.tick(currentTime, this.state.party);
  }

  /**
   * Explicitly abandons or ends the active adventure (e.g. stream ended).
   * @param {string} [reason='stream_ended']
   * @returns {Array<object>} Events emitted
   */
  abandonAdventure(reason = 'stream_ended') {
    return this.adventure.abandonAdventure(reason, this.state.party);
  }

  /**
   * Returns outcome snapshot if adventure has concluded.
   * @returns {object|null}
   */
  getOutcomeSnapshot() {
    return this.adventure.outcomeSnapshot;
  }

  /**
   * Returns the list of active party members within the 15-minute sliding window.
   * @param {number} [now]
   * @param {number} [windowMs=900000]
   * @returns {Array<object>}
   */
  getActiveParty(now = this.clock(), windowMs = INACTIVITY_WINDOW_MS) {
    const cutoff = now - windowMs;
    const active = [];
    for (const member of this.state.party.values()) {
      if (member.lastSeenAt >= cutoff) {
        active.push(member);
      }
    }
    return active;
  }

  /**
   * Registers or updates a chatter in the active party.
   * Anyone who chatted in the last 15 minutes is automatically in the party.
   * @param {string} user 
   * @param {string} displayName 
   * @returns {object}
   */
  trackChatter(user, displayName) {
    const username = user.toLowerCase();
    const now = this.clock();
    let member = this.state.party.get(username);
    if (!member) {
      member = {
        username,
        displayName: displayName || user,
        hp: 20,
        maxHp: 20,
        isKnockedOut: false,
        potions: 1,
        lastSeenAt: now
      };
      this.state.party.set(username, member);
    } else {
      member.lastSeenAt = now;
      if (displayName) member.displayName = displayName;
    }

    if (this.playerRepo) {
      this.playerRepo.upsertPlayer(this.channel, username, displayName || user);
    }

    if (this.partyRepo && this.adventure.id) {
      this.partyRepo.upsertMember(this.adventure.id, username, {
        hp: member.hp,
        maxHp: member.maxHp,
        isKnockedOut: member.isKnockedOut,
        potions: member.potions
      }, now);
    }

    return member;
  }

  /**
   * Main message intake entry.
   * @param {{ user: string, displayName: string, text: string, isBroadcaster?: boolean }} message
   * @returns {{ events: Array<{ kind: 'say'|'game', [key: string]: any }>, state: object }}
   */
  handleMessage(message) {
    const events = [];
    if (!message || typeof message.text !== 'string' || !message.user) {
      return { events, state: this.getState() };
    }

    const trimmed = message.text.trim();
    if (!trimmed) {
      return { events, state: this.getState() };
    }

    const now = this.clock();
    this.adventure.recordActivity(now);

    // Check timer expiration prior to processing command
    const tickEvents = this.tick(now);
    events.push(...tickEvents);

    // Every chatter who posts is tracked in the party
    this.trackChatter(message.user, message.displayName);

    // Command dispatching
    if (trimmed.startsWith('!')) {
      const parts = trimmed.slice(1).split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      if (command === 'theme') {
        const idea = args.join(' ');
        const themeEvents = this.adventure.handleThemeSuggestion(message.user, message.displayName, idea);
        events.push(...themeEvents);
      } else if (command === 'vote') {
        const voteEvents = this.adventure.handleVote(message.user, args[0]);
        events.push(...voteEvents);
      } else if (command === 'explore') {
        const exploreEvents = this.adventure.handleExplore(message.user, message.displayName, this.state.party);
        events.push(...exploreEvents);
      } else if (command === 'go') {
        const goEvents = this.adventure.handleGo(message.user, message.displayName, args.join(' '));
        events.push(...goEvents);
      } else if (command === 'attack') {
        const atkEvents = this.adventure.handleAttack(message.user, this.state.party);
        events.push(...atkEvents);
      } else if (command === 'defend') {
        const defEvents = this.adventure.handleDefend(message.user, this.state.party);
        events.push(...defEvents);
      } else if (command === 'item') {
        const itemEvents = this.adventure.handleItem(message.user, args[0], this.state.party);
        events.push(...itemEvents);
      } else if (command === 'heal') {
        const healEvents = this.adventure.handleHeal(message.user, args[0], this.state.party);
        events.push(...healEvents);
      } else if (command === 'hero') {
        const userNorm = message.user.toLowerCase();
        const dbPlayer = this.playerRepo ? this.playerRepo.getPlayer(this.channel, userNorm) : null;
        const member = this.state.party.get(userNorm);

        const level = dbPlayer ? dbPlayer.level : 1;
        const xp = dbPlayer ? dbPlayer.xp : 0;
        const gold = dbPlayer ? dbPlayer.gold : 0;
        const hp = member ? member.hp : 20;
        const maxHp = member ? member.maxHp : 20;
        const potions = member ? member.potions : 1;
        const isKnockedOut = member ? Boolean(member.isKnockedOut || member.hp <= 0) : false;
        const koBadge = isKnockedOut ? ' [KO]' : '';

        events.push(createSayEvent(
          `🛡️ @${message.displayName || message.user} (Lvl ${level}) | HP: ${hp}/${maxHp}${koBadge} | Gold: ${gold} | XP: ${xp} | Potions: ${potions}`
        ));
        events.push(createGameEvent('hero_stats', {
          user: userNorm,
          displayName: message.displayName || message.user,
          level,
          xp,
          gold,
          hp,
          maxHp,
          potions,
          isKnockedOut
        }));
      } else if (command === 'roll-test' || command === 'dice-test') {
        const roll = rollD20(this.rng);
        events.push(createSayEvent(`🎲 @${message.displayName || message.user} rolled a ${roll}!`));
        events.push(createGameEvent('dice_roll', {
          user: message.user.toLowerCase(),
          displayName: message.displayName || message.user,
          roll
        }));
      }
    }

    return { events, state: this.getState() };
  }

  /**
   * Returns complete engine snapshot.
   * @returns {object}
   */
  getState() {
    return {
      status: this.adventure.status,
      theme: this.adventure.theme,
      currentRoom: this.adventure.currentRoom,
      dungeon: this.adventure.dungeon,
      themeVote: this.adventure.themeVote,
      exitVote: this.adventure.exitVote,
      combat: this.adventure.combat,
      outcomeSnapshot: this.adventure.outcomeSnapshot,
      party: this.state.party
    };
  }
}

/**
 * Functional entry helper for processing a message against a state.
 * @param {Engine|object} engineOrOptions
 * @param {object} message
 * @returns {{ events: Array<object>, state: object }}
 */
export function processMessage(engineOrOptions, message) {
  const engine = engineOrOptions instanceof Engine ? engineOrOptions : new Engine(engineOrOptions);
  return engine.handleMessage(message);
}
