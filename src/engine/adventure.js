/**
 * Adventure State Machine for Chatacombs.
 * Governs the lifecycle of an adventure:
 * 'idle' -> 'voting' -> 'active' -> ('cleared' | 'wiped' | 'abandoned')
 */

import { generateDungeon } from './generator.js';
import { createSayEvent, createGameEvent } from './events.js';
import { CombatResolver } from './combat.js';

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
 * Adventure manager handling theme votes, room progression, and combat.
 */
export class Adventure {
  /**
   * @param {object} [options={}]
   * @param {() => number} [options.rng=Math.random]
   * @param {() => number} [options.clock=() => Date.now()]
   * @param {number} [options.voteDurationMs=60000] 1-minute vote duration
   * @param {number} [options.inactivityThresholdMs=120000] 2-minute inactivity threshold to pause timers
   * @param {number} [options.nudgeIntervalMs=600000] 10-minute nudge interval for quiet chat
   */
  constructor(options = {}) {
    this.rng = options.rng || Math.random;
    this.clock = options.clock || (() => Date.now());
    this.voteDurationMs = options.voteDurationMs ?? 60000;
    this.inactivityThresholdMs = options.inactivityThresholdMs ?? 120000;
    this.nudgeIntervalMs = options.nudgeIntervalMs ?? 600000;

    this.status = 'idle'; // 'idle' | 'voting' | 'active' | 'cleared' | 'wiped' | 'abandoned'
    this.theme = null;
    this.dungeon = null;
    this.currentRoom = null;
    this.themeVote = null;
    this.exitVote = null;
    this.combat = null;

    this.lastMessageAt = this.clock();
    this.lastNudgeAt = this.clock();
  }

  /**
   * Records chatter activity to maintain active pacing.
   * @param {number} [currentTime]
   */
  recordActivity(currentTime = this.clock()) {
    this.lastMessageAt = currentTime;
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

    const now = this.clock();
    this.themeVote = {
      choices,
      customSuggestions: 0,
      votes: new Map(), // username -> choiceIndex (0, 1, or 2)
      openedAt: now,
      lastTickAt: now,
      elapsedMs: 0,
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
      winningIndex = 0;
    } else {
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
    this.exitVote = null;

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
   * Handles !explore command in the current room.
   * @param {string} user 
   * @param {string} displayName 
   * @param {Map<string, object>} [party] Active party map for trap resolution
   * @returns {Array<object>} Events emitted
   */
  handleExplore(user, displayName, party = null) {
    if (this.status !== 'active' || !this.currentRoom) return [];

    // In a room with an undefeated monster, cannot explore
    if ((this.currentRoom.type === 'monster' || this.currentRoom.type === 'boss') &&
        this.currentRoom.monster && this.currentRoom.monster.hp > 0) {
      return [
        createSayEvent(`⚔️ A ${this.currentRoom.monster.name} blocks your way! Defeat it before exploring!`)
      ];
    }

    const room = this.currentRoom;
    if (room.exploration.searched) {
      return [
        createSayEvent(`🔍 This chamber has already been searched by the party.`)
      ];
    }

    room.exploration.searched = true;
    const events = [];
    const name = displayName || user;

    if (room.type === 'treasure' && room.exploration.hasLoot && room.exploration.loot) {
      const loot = room.exploration.loot;
      const itemDesc = loot.item ? ` and found a ${loot.item}` : '';
      events.push(createSayEvent(`💎 @${name} searched the room and found a treasure chest with ${loot.gold} gold${itemDesc}!`));
      events.push(createGameEvent('rare_loot', {
        user: user.toLowerCase(),
        gold: loot.gold,
        item: loot.item
      }));
    } else if (room.type === 'trap' && room.exploration.hasTrap && room.exploration.trap) {
      const trap = room.exploration.trap;
      // Trap DC check
      const d20 = Math.floor(this.rng() * 20) + 1;
      if (d20 >= trap.dc) {
        events.push(createSayEvent(`🛡️ @${name} spotted the ${trap.name} trap (DC ${trap.dc}, rolled ${d20}) and disarmed it safely!`));
      } else {
        events.push(createSayEvent(`💥 @${name} triggered the ${trap.name} trap! The party takes ${trap.damage} damage!`));
        // Apply damage to active party
        if (party) {
          for (const member of party.values()) {
            if (!member.isKnockedOut) {
              member.hp = Math.max(0, member.hp - trap.damage);
              if (member.hp === 0) {
                member.isKnockedOut = true;
                events.push(createGameEvent('player_knocked_out', {
                  user: member.username,
                  displayName: member.displayName,
                  reason: trap.name
                }));
                events.push(createSayEvent(`💀 @${member.displayName} was knocked out by the trap!`));
              }
            }
          }
        }
      }
    } else if (room.type === 'empty' && room.exploration.hasLoot && room.exploration.loot) {
      const loot = room.exploration.loot;
      events.push(createSayEvent(`💰 @${name} searched the room and found a hidden pouch with ${loot.gold} gold!`));
      events.push(createGameEvent('rare_loot', {
        user: user.toLowerCase(),
        gold: loot.gold,
        item: null
      }));
    } else {
      events.push(createSayEvent(`🔍 @${name} searched carefully, but found nothing of interest in this room.`));
    }

    return events;
  }

  /**
   * Handles !go <direction> command to vote on room exits.
   * @param {string} user 
   * @param {string} displayName 
   * @param {string} direction 
   * @returns {Array<object>} Events emitted
   */
  handleGo(user, displayName, direction) {
    if (this.status !== 'active' || !this.currentRoom) return [];
    if (!direction || typeof direction !== 'string') return [];

    // Monster check
    if ((this.currentRoom.type === 'monster' || this.currentRoom.type === 'boss') &&
        this.currentRoom.monster && this.currentRoom.monster.hp > 0) {
      return [
        createSayEvent(`⚔️ A ${this.currentRoom.monster.name} blocks all exits! You must defeat it first!`)
      ];
    }

    const normDir = direction.trim().toLowerCase();
    const validExit = this.currentRoom.exits.find(e => e.direction.toLowerCase() === normDir);
    if (!validExit) {
      // Not a valid exit for current room
      return [];
    }

    const now = this.clock();

    // If no exit vote is currently open, open one
    if (!this.exitVote) {
      this.exitVote = {
        openedAt: now,
        lastTickAt: now,
        elapsedMs: 0,
        durationMs: this.voteDurationMs,
        votes: new Map(), // username -> direction
        voteOrder: [normDir] // order of first time each direction was voted for (for tie breaks)
      };
      this.exitVote.votes.set(user.toLowerCase(), normDir);

      return [
        createSayEvent(
          `🚪 @${displayName || user} voted to go "${validExit.direction}"! Exit vote open (1 min). Use !go <exit> to vote!`
        )
      ];
    }

    // Exit vote is already open: record vote
    this.exitVote.votes.set(user.toLowerCase(), normDir);
    if (!this.exitVote.voteOrder.includes(normDir)) {
      this.exitVote.voteOrder.push(normDir);
    }

    // Silent per design doc (only 1 message per vote window)
    return [];
  }

  /**
   * Closes the exit vote and advances to the next room.
   * @param {Map<string, object>} [party] Active party map to revive KO'd players
   * @returns {Array<object>} Events emitted
   */
  closeExitVote(party = null) {
    if (this.status !== 'active' || !this.exitVote || !this.currentRoom) return [];

    // Tally votes
    const tally = new Map();
    for (const dir of this.exitVote.votes.values()) {
      tally.set(dir, (tally.get(dir) || 0) + 1);
    }

    if (tally.size === 0) {
      this.exitVote = null;
      return [createSayEvent(`⏱️ The exit vote expired with no votes. Choose a path with !go <exit>!`)];
    }

    // Determine winner with majority, tie broken by first exit voted for (order in voteOrder)
    let winningDirection = this.exitVote.voteOrder[0];
    let maxVotes = -1;

    for (const dir of this.exitVote.voteOrder) {
      const count = tally.get(dir) || 0;
      if (count > maxVotes) {
        maxVotes = count;
        winningDirection = dir;
      }
    }

    const exit = this.currentRoom.exits.find(e => e.direction.toLowerCase() === winningDirection);
    this.exitVote = null;

    if (!exit) return [];

    const nextRoom = this.dungeon.rooms.find(r => r.id === exit.targetRoomId);
    if (!nextRoom) return [];

    this.currentRoom = nextRoom;

    // Revive knocked-out players on room change
    if (party) {
      for (const member of party.values()) {
        if (member.isKnockedOut || member.hp <= 0) {
          member.isKnockedOut = false;
          member.hp = Math.max(5, Math.floor(member.maxHp * 0.25)); // 5 HP or 25% max HP
        }
      }
    }

    const exitDirections = nextRoom.exits.map(e => e.direction);
    const events = [
      createSayEvent(
        `🚶 The party moves ${exit.direction} into ${nextRoom.name} (Room ${nextRoom.roomNumber}/${this.dungeon.totalRooms})!`
      ),
      createGameEvent('room_entered', {
        roomNumber: nextRoom.roomNumber,
        roomType: nextRoom.type,
        roomName: nextRoom.name,
        exits: exitDirections
      })
    ];

    if (nextRoom.type === 'boss' && nextRoom.monster) {
      events.push(createSayEvent(`⚡ A terrifying aura fills the room! The Boss ${nextRoom.monster.name} appears!`));
      events.push(createGameEvent('boss_appears', {
        monster: nextRoom.monster.name,
        hp: nextRoom.monster.hp,
        maxHp: nextRoom.monster.maxHp
      }));
      this.combat = new CombatResolver({
        rng: this.rng,
        clock: this.clock,
        roundDurationMs: this.voteDurationMs
      });
      events.push(...this.combat.startEncounter());
    } else if (nextRoom.type === 'monster' && nextRoom.monster) {
      events.push(createSayEvent(`⚔️ A ${nextRoom.monster.name} lurks in the shadows with ${nextRoom.monster.hp} HP!`));
      this.combat = new CombatResolver({
        rng: this.rng,
        clock: this.clock,
        roundDurationMs: this.voteDurationMs
      });
      events.push(...this.combat.startEncounter());
    }

    return events;
  }

  /**
   * Handles !attack command in combat.
   */
  handleAttack(user, party) {
    if (this.status !== 'active' || !this.combat || !this.currentRoom?.monster) return [];
    const player = party?.get(user.toLowerCase());
    if (!player) return [];
    this.combat.registerAction(player, 'attack');
    return [];
  }

  /**
   * Handles !defend command in combat.
   */
  handleDefend(user, party) {
    if (this.status !== 'active' || !this.combat || !this.currentRoom?.monster) return [];
    const player = party?.get(user.toLowerCase());
    if (!player) return [];
    this.combat.registerAction(player, 'defend');
    return [];
  }

  /**
   * Handles !item <name> command in combat or exploration.
   */
  handleItem(user, itemName, party) {
    if (!itemName || typeof itemName !== 'string') return [];
    const normItem = itemName.trim().toLowerCase();
    const player = party?.get(user.toLowerCase());
    if (!player) return [];

    if (this.combat) {
      this.combat.registerAction(player, 'item', { item: normItem });
      return [];
    }

    // Outside combat: instant potion use
    if (normItem === 'potion' && player.potions > 0 && !player.isKnockedOut) {
      player.potions--;
      const healAmount = Math.min(player.maxHp - player.hp, 10);
      player.hp = Math.min(player.maxHp, player.hp + 10);
      return [
        createSayEvent(`🧪 @${player.displayName} drank a potion and restored ${healAmount} HP! (${player.hp}/${player.maxHp})`),
        createGameEvent('player_healed', {
          user: player.username,
          target: player.username,
          amount: healAmount
        })
      ];
    }

    return [];
  }

  /**
   * Handles !heal @target command.
   */
  handleHeal(user, targetRaw, party) {
    if (!targetRaw || typeof targetRaw !== 'string') return [];
    const targetUser = targetRaw.replace(/^@/, '').trim().toLowerCase();
    const player = party?.get(user.toLowerCase());
    const targetMember = party?.get(targetUser);
    if (!player || !targetMember) return [];

    if (this.combat) {
      this.combat.registerAction(player, 'heal', { target: targetUser });
      return [];
    }

    // Outside combat: instant heal
    if (player.potions > 0 && !player.isKnockedOut) {
      player.potions--;
      targetMember.isKnockedOut = false;
      const healAmount = Math.min(targetMember.maxHp - targetMember.hp, 10);
      targetMember.hp = Math.min(targetMember.maxHp, targetMember.hp + 10);
      return [
        createSayEvent(`💖 @${player.displayName} healed @${targetMember.displayName} for ${healAmount} HP!`),
        createGameEvent('player_healed', {
          user: player.username,
          target: targetMember.username,
          amount: healAmount
        })
      ];
    }

    return [];
  }

  /**
   * Ticks time-based events (closing theme vote, exit vote, or combat round).
   * Pauses timers during chat inactivity lulls and sends occasional nudges.
   * @param {number} [currentTime]
   * @param {Map<string, object>} [party]
   * @returns {Array<object>}
   */
  tick(currentTime = this.clock(), party = null) {
    const events = [];
    const timeSinceMessage = currentTime - this.lastMessageAt;
    const isIdle = timeSinceMessage >= this.inactivityThresholdMs;

    // Quiet chat nudging: at most once every 10 minutes (nudgeIntervalMs)
    if (timeSinceMessage >= this.nudgeIntervalMs && (currentTime - this.lastNudgeAt) >= this.nudgeIntervalMs) {
      this.lastNudgeAt = currentTime;
      if (this.status === 'voting') {
        events.push(createSayEvent(`🗳️ The dungeon awaits your vote! Type !vote <1-3> or !theme <idea> to begin.`));
      } else if (this.status === 'active' && this.combat && this.currentRoom?.monster) {
        events.push(createSayEvent(`⚔️ The ${this.currentRoom.monster.name} glares across the chamber... Chat, rally the party with !attack, !defend, or !heal!`));
      } else if (this.status === 'active' && this.currentRoom) {
        events.push(createSayEvent(`🕯️ The torchlight flickers in the quiet halls... Type !explore or !go <exit> to continue the journey!`));
      }
    }

    // 1. Theme Vote Timer (pauses during idle lulls)
    if (this.status === 'voting' && this.themeVote) {
      const delta = currentTime - this.themeVote.lastTickAt;
      this.themeVote.lastTickAt = currentTime;

      if (!isIdle) {
        this.themeVote.elapsedMs += Math.max(0, delta);
        if (this.themeVote.elapsedMs >= this.themeVote.durationMs) {
          const voteEvents = this.closeThemeVote();
          events.push(...voteEvents);
          return events;
        }
      }
    }

    // 2. Combat Round Timer (pauses during idle lulls)
    if (this.status === 'active' && this.combat && this.currentRoom?.monster) {
      const delta = currentTime - this.combat.lastTickAt;
      this.combat.lastTickAt = currentTime;

      if (!isIdle) {
        this.combat.elapsedMs += Math.max(0, delta);
        if (this.combat.elapsedMs >= this.combat.roundDurationMs) {
          const result = this.combat.resolveRound(this.currentRoom.monster, party);
          if (result.monsterDefeated) {
            this.combat = null;
            this.currentRoom.cleared = true;
          } else if (result.partyWiped) {
            this.status = 'wiped';
            this.combat = null;
            result.events.push(createGameEvent('party_wiped', {
              roomNumber: this.currentRoom.roomNumber,
              theme: this.theme
            }));
          }
          events.push(...result.events);
          return events;
        }
      }
    }

    // 3. Exit Vote Timer (pauses during idle lulls)
    if (this.status === 'active' && this.exitVote) {
      const delta = currentTime - this.exitVote.lastTickAt;
      this.exitVote.lastTickAt = currentTime;

      if (!isIdle) {
        this.exitVote.elapsedMs += Math.max(0, delta);
        if (this.exitVote.elapsedMs >= this.exitVote.durationMs) {
          const exitEvents = this.closeExitVote(party);
          events.push(...exitEvents);
          return events;
        }
      }
    }

    return events;
  }
}
