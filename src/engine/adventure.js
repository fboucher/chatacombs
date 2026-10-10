/**
 * Adventure State Machine for Chatacombs.
 * Governs the lifecycle of an adventure:
 * 'idle' -> 'voting' -> 'active' -> ('cleared' | 'wiped' | 'abandoned')
 */

import { generateDungeon } from './generator.js';
import { createSayEvent, createGameEvent } from './events.js';

export const BUILTIN_THEMES = [
  'haunted house',
  'pirate ship',
  'legacy codebase',
  'sky castle',
  'cyberpunk vault',
  'steampunk clocktower',
  'abandoned space station',
  'underwater ruins'
];

/**
 * Adventure manager handling theme votes and room progression.
 */
export class Adventure {
  /**
   * @param {object} [options={}]
   * @param {() => number} [options.rng=Math.random]
   * @param {() => number} [options.clock=() => Date.now()]
   * @param {number} [options.voteDurationMs=60000] 1-minute vote duration
   */
  constructor(options = {}) {
    this.rng = options.rng || Math.random;
    this.clock = options.clock || (() => Date.now());
    this.voteDurationMs = options.voteDurationMs ?? 60000;

    this.status = 'idle'; // 'idle' | 'voting' | 'active' | 'cleared' | 'wiped' | 'abandoned'
    this.theme = null;
    this.dungeon = null;
    this.currentRoom = null;
    this.themeVote = null;
  }

  /**
   * Opens a new theme vote for an adventure.
   * @returns {Array<object>} Events emitted
   */
  openThemeVote() {
    this.status = 'voting';

    // Pick 2 random themes from BUILTIN_THEMES without duplicates
    const shuffled = [...BUILTIN_THEMES].sort(() => this.rng() - 0.5);
    const choices = ['classic fantasy', shuffled[0], shuffled[1]];

    this.themeVote = {
      choices,
      customSuggestions: 0,
      votes: new Map(), // username -> choiceIndex (0, 1, or 2)
      openedAt: this.clock(),
      durationMs: this.voteDurationMs,
      announced: true
    };

    const events = [
      createSayEvent(
        `🗳️ A new dungeon awaits! Vote for a theme with !vote <1-3> (1 min) or suggest one with !theme <idea>:\n` +
        `1: ${choices[0]} | 2: ${choices[1]} | 3: ${choices[2]}`
      )
    ];

    return events;
  }

  /**
   * Handles !theme <idea> suggestions.
   * The first two suggestions replace random slots (slots 2 and 3).
   * @param {string} user 
   * @param {string} displayName 
   * @param {string} idea 
   * @returns {Array<object>} Events emitted
   */
  handleThemeSuggestion(user, displayName, idea) {
    if (this.status !== 'voting' || !this.themeVote) return [];
    if (!idea || typeof idea !== 'string') return [];

    const trimmed = idea.trim();
    if (!trimmed) return [];

    if (this.themeVote.customSuggestions >= 2) {
      return []; // Max 2 custom suggestions accepted
    }

    // First suggestion replaces slot 2 (index 1), second replaces slot 3 (index 2)
    const slotIndex = this.themeVote.customSuggestions === 0 ? 1 : 2;
    this.themeVote.choices[slotIndex] = trimmed;
    this.themeVote.customSuggestions++;

    return [
      createSayEvent(
        `💡 Theme #${slotIndex + 1} updated to "${trimmed}" suggested by @${displayName || user}!`
      )
    ];
  }

  /**
   * Handles !vote <number> command.
   * @param {string} user 
   * @param {string|number} voteChoice 
   * @returns {Array<object>} Events emitted
   */
  handleVote(user, voteChoice) {
    if (this.status !== 'voting' || !this.themeVote) return [];
    const choiceNum = parseInt(voteChoice, 10);
    if (isNaN(choiceNum) || choiceNum < 1 || choiceNum > 3) return [];

    const choiceIndex = choiceNum - 1;
    this.themeVote.votes.set(user.toLowerCase(), choiceIndex);
    // Silent to prevent chat flooding (per design doc)
    return [];
  }

  /**
   * Closes the theme vote and transitions to 'active' dungeon.
   * @returns {Array<object>} Events emitted
   */
  closeThemeVote() {
    if (this.status !== 'voting' || !this.themeVote) return [];

    // Tally votes
    const counts = [0, 0, 0];
    for (const choiceIdx of this.themeVote.votes.values()) {
      if (counts[choiceIdx] !== undefined) {
        counts[choiceIdx]++;
      }
    }

    let winningIndex = 0;
    const totalVotes = counts[0] + counts[1] + counts[2];

    if (totalVotes === 0) {
      // No votes -> classic fantasy wins
      winningIndex = 0;
    } else {
      // Find plurality; in case of tie, first-registered wins
      let maxCount = -1;
      for (let i = 0; i < counts.length; i++) {
        if (counts[i] > maxCount) {
          maxCount = counts[i];
          winningIndex = i;
        }
      }
    }

    const winningTheme = this.themeVote.choices[winningIndex];
    this.theme = winningTheme;

    // Generate the dungeon
    this.dungeon = generateDungeon({
      theme: winningTheme,
      rng: this.rng
    });

    this.status = 'active';
    this.currentRoom = this.dungeon.rooms[0]; // Entrance room
    this.themeVote = null;

    const entrance = this.currentRoom;
    const exitDirections = entrance.exits.map(e => e.direction);

    const events = [
      createSayEvent(`🏰 The votes are in! We embark on an adventure in: "${winningTheme}"!`),
      createGameEvent('adventure_started', {
        theme: winningTheme,
        totalRooms: this.dungeon.totalRooms
      }),
      createSayEvent(
        `🚪 Entered ${entrance.name} (Room ${entrance.roomNumber}/${this.dungeon.totalRooms}). Exits: ${exitDirections.join(', ')}.`
      ),
      createGameEvent('room_entered', {
        roomNumber: entrance.roomNumber,
        roomType: entrance.type,
        roomName: entrance.name,
        exits: exitDirections
      })
    ];

    return events;
  }

  /**
   * Ticks time-based events (e.g. closing vote when timer expires).
   * @param {number} [currentTime]
   * @returns {Array<object>}
   */
  tick(currentTime = this.clock()) {
    if (this.status === 'voting' && this.themeVote) {
      if (currentTime >= this.themeVote.openedAt + this.themeVote.durationMs) {
        return this.closeThemeVote();
      }
    }
    return [];
  }
}
