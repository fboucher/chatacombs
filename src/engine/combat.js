/**
 * Turn-based Combat Round Resolver for Chatacombs.
 * Governs combat in monster and boss rooms.
 */

import { checkDC, rollDamage } from './dice.js';
import { createSayEvent, createGameEvent } from './events.js';

export class CombatResolver {
  /**
   * @param {object} [options={}]
   * @param {() => number} [options.rng=Math.random]
   * @param {() => number} [options.clock=() => Date.now()]
   * @param {number} [options.roundDurationMs=60000]
   */
  constructor(options = {}) {
    this.rng = options.rng || Math.random;
    this.clock = options.clock || (() => Date.now());
    this.roundDurationMs = options.roundDurationMs ?? 60000;

    this.round = 1;
    this.roundOpenedAt = this.clock();
    this.lastTickAt = this.clock();
    this.elapsedMs = 0;
    this.actions = new Map(); // username -> { action, user, displayName, target, item }
    this.isFinished = false;
  }

  /**
   * Resets for a new combat encounter.
   */
  startEncounter() {
    this.round = 1;
    this.roundOpenedAt = this.clock();
    this.lastTickAt = this.clock();
    this.elapsedMs = 0;
    this.actions.clear();
    this.isFinished = false;

    return [
      createSayEvent(
        `⚔️ Combat begins! Round 1 (1 min): Choose your action with !attack, !defend, !item <name>, or !heal @name!`
      )
    ];
  }

  /**
   * Registers a player action for the current round.
   * Duplicate actions from the same player in the same round are ignored.
   * @param {object} player 
   * @param {string} actionType 'attack' | 'defend' | 'item' | 'heal'
   * @param {object} [details={}]
   * @returns {boolean} Whether action was accepted
   */
  registerAction(player, actionType, details = {}) {
    if (this.isFinished) return false;
    if (!player || player.isKnockedOut || player.hp <= 0) return false;

    const username = player.username.toLowerCase();
    // One action per player per round
    if (this.actions.has(username)) {
      return false;
    }

    this.actions.set(username, {
      user: username,
      displayName: player.displayName,
      action: actionType,
      ...details
    });

    return true;
  }

  /**
   * Resolves the round according to design rules:
   * 1. Player attacks & heal/potion effects resolve first
   * 2. If monster is alive, monster counter-attacks a present living player
   * 3. Evaluate monster death or full party wipe
   * 
   * @param {object} monster 
   * @param {Map<string, object>} party 
   * @returns {{ events: Array<object>, monsterDefeated: boolean, partyWiped: boolean }}
   */
  resolveRound(monster, party) {
    const events = [];
    if (!monster || monster.hp <= 0) {
      this.isFinished = true;
      return { events, monsterDefeated: true, partyWiped: false };
    }

    // 1. Process Potions & Heals first
    for (const act of this.actions.values()) {
      if (act.action === 'item' && act.item === 'potion') {
        const actor = party.get(act.user);
        if (actor && actor.potions > 0 && !actor.isKnockedOut) {
          actor.potions--;
          const healAmount = Math.min(actor.maxHp - actor.hp, 10);
          actor.hp = Math.min(actor.maxHp, actor.hp + 10);
          events.push(createSayEvent(`🧪 @${actor.displayName} drank a potion and restored ${healAmount} HP! (${actor.hp}/${actor.maxHp})`));
          events.push(createGameEvent('player_healed', {
            user: actor.username,
            target: actor.username,
            amount: healAmount
          }));
        }
      } else if (act.action === 'heal' && act.target) {
        const actor = party.get(act.user);
        const targetMember = party.get(act.target.toLowerCase());
        if (actor && targetMember && actor.potions > 0 && !actor.isKnockedOut) {
          actor.potions--;
          const wasKo = targetMember.isKnockedOut || targetMember.hp <= 0;
          targetMember.isKnockedOut = false;
          const healAmount = Math.min(targetMember.maxHp - targetMember.hp, 10);
          targetMember.hp = Math.min(targetMember.maxHp, targetMember.hp + 10);

          events.push(createSayEvent(`💖 @${actor.displayName} used a potion to heal @${targetMember.displayName} for ${healAmount} HP!`));
          events.push(createGameEvent('player_healed', {
            user: actor.username,
            target: targetMember.username,
            amount: healAmount
          }));
        }
      }
    }

    // 2. Process Player Attacks
    for (const act of this.actions.values()) {
      if (act.action === 'attack') {
        const actor = party.get(act.user);
        if (!actor || actor.isKnockedOut || actor.hp <= 0) continue;

        // Roll d20 attack vs monster defense
        const atkCheck = checkDC(monster.defense, 0, 0, this.rng);
        events.push(createGameEvent('dice_roll', {
          user: actor.username,
          roll: atkCheck.roll,
          total: atkCheck.total,
          dc: monster.defense,
          success: atkCheck.success
        }));

        if (atkCheck.success) {
          const dmgBonus = atkCheck.isCrit ? 4 : 2;
          const dmgRoll = rollDamage(1, 6, dmgBonus, this.rng);
          const dmg = atkCheck.isCrit ? dmgRoll.total * 2 : dmgRoll.total;
          monster.hp = Math.max(0, monster.hp - dmg);

          const critText = atkCheck.isCrit ? ' CRITICAL HIT!' : '';
          events.push(createSayEvent(
            `⚔️ @${actor.displayName} rolled a ${atkCheck.roll}${critText} and dealt ${dmg} DMG to ${monster.name}! (${monster.hp}/${monster.maxHp} HP left)`
          ));

          // Check if monster dies mid-round
          if (monster.hp === 0) {
            this.isFinished = true;
            events.push(createSayEvent(`🎉 ${monster.name} has been vanquished!`));
            events.push(createGameEvent('monster_defeated', {
              monster: monster.name,
              xp: monster.xp,
              gold: monster.gold,
              loot: monster.loot
            }));
            return { events, monsterDefeated: true, partyWiped: false };
          }
        } else {
          events.push(createSayEvent(`💨 @${actor.displayName} rolled a ${atkCheck.roll} (vs DEF ${monster.defense}) and missed ${monster.name}!`));
        }
      }
    }

    // 3. Monster Strikes Back (if alive)
    if (monster.hp > 0) {
      const livingPlayers = [...party.values()].filter(p => !p.isKnockedOut && p.hp > 0);
      if (livingPlayers.length > 0) {
        // Pick a random living player to target
        const target = livingPlayers[Math.floor(this.rng() * livingPlayers.length)];
        const targetAct = this.actions.get(target.username);
        const isDefending = targetAct && targetAct.action === 'defend';

        // Monster attack check vs AC 10
        const mAtk = checkDC(10, monster.attack, 0, this.rng);
        if (mAtk.success) {
          const mDmgRoll = rollDamage(1, 6, Math.max(1, Math.floor(monster.attack * 0.7)), this.rng);
          let finalDmg = mDmgRoll.total;
          if (isDefending) {
            finalDmg = Math.max(1, Math.floor(finalDmg * 0.5));
          }

          target.hp = Math.max(0, target.hp - finalDmg);
          const defText = isDefending ? ' (reduced by !defend)' : '';
          events.push(createSayEvent(`💥 ${monster.name} strikes @${target.displayName} for ${finalDmg} DMG${defText}! (${target.hp}/${target.maxHp} HP)`));

          if (target.hp === 0) {
            target.isKnockedOut = true;
            events.push(createGameEvent('player_knocked_out', {
              user: target.username,
              displayName: target.displayName,
              monster: monster.name
            }));
            events.push(createSayEvent(`💀 @${target.displayName} was knocked out!`));
          }
        } else {
          events.push(createSayEvent(`🛡️ ${monster.name} swung at @${target.displayName} but missed!`));
        }
      }
    }

    // 4. Check for party wipe
    const partyMembers = [...party.values()];
    const partyWiped = partyMembers.length > 0 && partyMembers.every(p => p.isKnockedOut || p.hp <= 0);

    if (partyWiped) {
      this.isFinished = true;
      events.push(createSayEvent(`☠️ The entire party has fallen! The dungeon claims another group of heroes.`));
      return { events, monsterDefeated: false, partyWiped: true };
    }

    // Prepare next round
    this.round++;
    this.roundOpenedAt = this.clock();
    this.lastTickAt = this.clock();
    this.elapsedMs = 0;
    this.actions.clear();

    events.push(createSayEvent(`⏳ Round ${this.round} begins! Choose your action: !attack, !defend, !item, !heal @user (1 min)`));

    return { events, monsterDefeated: false, partyWiped: false };
  }
}
