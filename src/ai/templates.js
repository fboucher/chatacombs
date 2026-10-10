/**
 * Procedural Narration Templates for Chatacombs.
 * Converts structured game events and room states into concise, factual
 * chat text fitting within 2 Twitch messages (<500 characters each).
 * 100% deterministic, offline, and zero-AI required.
 */

export const MAX_TWITCH_MSG_LEN = 480;

/**
 * Truncates and formats text into at most 2 Twitch chat messages (array of 1-2 strings).
 * @param {string|Array<string>} textOrParts 
 * @returns {Array<string>}
 */
export function formatChatMessages(textOrParts) {
  const parts = Array.isArray(textOrParts) ? textOrParts : [textOrParts];
  const lines = parts.filter(p => typeof p === 'string' && p.trim().length > 0);

  const result = [];
  for (const line of lines) {
    if (result.length >= 2) break;
    const clean = line.trim();
    if (clean.length <= MAX_TWITCH_MSG_LEN) {
      result.push(clean);
    } else {
      // Split or truncate to fit
      result.push(clean.slice(0, MAX_TWITCH_MSG_LEN));
      if (result.length < 2 && clean.length > MAX_TWITCH_MSG_LEN) {
        result.push(clean.slice(MAX_TWITCH_MSG_LEN, MAX_TWITCH_MSG_LEN * 2));
      }
    }
  }

  return result.slice(0, 2);
}

/**
 * Procedural narration templates generator.
 */
export class NarrationTemplates {
  /**
   * Generates room entry description from structured room data.
   * @param {object} room
   * @param {object} [dungeonContext={}]
   * @returns {Array<string>} 1-2 chat messages
   */
  describeRoom(room, dungeonContext = {}) {
    if (!room) return formatChatMessages('🚪 You step into the damp dungeon halls.');

    const totalRooms = dungeonContext.totalRooms || 10;
    const roomNum = room.roomNumber || room.id || 1;
    const exits = (room.exits || []).map(e => typeof e === 'string' ? e : e.direction).join(', ');
    const exitText = exits ? `Exits: ${exits}.` : 'No obvious exits.';

    let typeDesc = 'The air is still and shadows stretch across ancient stone.';
    if (room.type === 'entrance') {
      typeDesc = `The expedition enters ${room.name}. Cool air drafts from the surface behind you.`;
    } else if (room.type === 'treasure') {
      typeDesc = `Gilded carvings adorn the walls of ${room.name}. A glint of treasure catches the torchlight!`;
    } else if (room.type === 'trap') {
      typeDesc = `Uneven flagstones and suspicious tripwires line ${room.name}. Tread carefully!`;
    } else if (room.type === 'monster') {
      const monsterName = room.monster?.name || 'A hostile beast';
      const hp = room.monster?.hp || 20;
      typeDesc = `Growls echo in ${room.name}! ${monsterName} lurks in the darkness (${hp} HP).`;
    } else if (room.type === 'boss') {
      const bossName = room.monster?.name || 'The Dungeon Lord';
      const hp = room.monster?.hp || 100;
      typeDesc = `A suffocating dread grips ${room.name}! Boss ${bossName} looms before you (${hp} HP)!`;
    } else if (room.type === 'empty') {
      typeDesc = `Dust settles in the quiet corridors of ${room.name}. Only echoes keep you company.`;
    }

    const line1 = `🚪 Room ${roomNum}/${totalRooms}: ${room.name}. ${typeDesc}`;
    const line2 = exitText;
    return formatChatMessages([line1, line2]);
  }

  /**
   * Generates monster intro from monster stats.
   * @param {object} monster
   * @param {object} [roomContext={}]
   * @returns {Array<string>} 1-2 chat messages
   */
  describeMonsterIntro(monster, roomContext = {}) {
    if (!monster) return formatChatMessages('⚔️ A hostile presence approaches!');

    const isBoss = roomContext.type === 'boss';
    const prefix = isBoss ? '⚡ BOSS ENCOUNTER!' : '⚔️ MONSTER SIGHTING!';
    const intent = monster.attack > 10 ? 'radiates deadly fury' : 'bites and claws with feral speed';

    const line1 = `${prefix} ${monster.name} emerges with ${monster.hp}/${monster.maxHp} HP and DEF ${monster.defense}!`;
    const line2 = `It ${intent} (ATK ${monster.attack}). Party, choose your combat actions: !attack, !defend, !item, or !heal!`;
    return formatChatMessages([line1, line2]);
  }

  /**
   * Generates combat round recap from combat resolution result and action map.
   * @param {object} params
   * @param {number} params.round
   * @param {object} params.monster
   * @param {Array<object>} params.events
   * @param {boolean} params.monsterDefeated
   * @param {boolean} params.partyWiped
   * @returns {Array<string>} 1-2 chat messages
   */
  describeCombatRecap({ round = 1, monster, events = [], monsterDefeated = false, partyWiped = false } = {}) {
    if (monsterDefeated) {
      const monsterName = monster?.name || 'The foe';
      const xp = monster?.xp || 0;
      const gold = monster?.gold || 0;
      return formatChatMessages([
        `🎉 Round ${round} Victory: ${monsterName} is slain!`,
        `The chamber falls quiet. Rewards earned: ${xp} XP and ${gold} gold!`
      ]);
    }

    if (partyWiped) {
      return formatChatMessages([
        `☠️ Round ${round}: The party has been wiped out!`,
        `The final hero collapses in defeat as the dungeon claims your souls.`
      ]);
    }

    const monsterName = monster?.name || 'Monster';
    const hp = monster ? `${monster.hp}/${monster.maxHp}` : '?';

    // Highlight key actions from events
    const kos = events.filter(e => e.kind === 'game' && e.type === 'player_knocked_out');
    const heals = events.filter(e => e.kind === 'game' && e.type === 'player_healed');
    
    let subStatus = `${monsterName} stands at ${hp} HP.`;
    if (kos.length > 0) {
      const koNames = kos.map(k => `@${k.displayName || k.user}`).join(', ');
      subStatus += ` Knocked out: ${koNames}!`;
    } else if (heals.length > 0) {
      const healNames = heals.map(h => `@${h.target}`).join(', ');
      subStatus += ` Healed: ${healNames}.`;
    }

    const line1 = `⚔️ Round ${round} Resolved! The party and ${monsterName} trade blows in the chaos!`;
    const line2 = `${subStatus} Prepare actions for the next round!`;
    return formatChatMessages([line1, line2]);
  }

  /**
   * Generates procedural say text for generic game moments.
   * @param {string} momentType 
   * @param {object} details 
   * @returns {Array<string>}
   */
  describeMoment(momentType, details = {}) {
    switch (momentType) {
      case 'adventure_started':
        return formatChatMessages([
          `🏰 Adventure begins! The party delves into the theme: "${details.theme || 'Classic Fantasy'}".`,
          `Explore the dungeon's ${details.totalRooms || 10} chambers and vanquish the final boss!`
        ]);

      case 'rare_loot': {
        const itemText = details.item ? ` and claimed a ${details.item}` : '';
        return formatChatMessages(
          `💎 Rare Loot! @${details.user} recovered ${details.gold || 0} gold${itemText}!`
        );
      }

      case 'boss_appears':
        return formatChatMessages([
          `⚡ THE BOSS HAS AWOKEN! ${details.monster || 'The Overlord'} steps into the light!`,
          `HP: ${details.hp}/${details.maxHp}. Gather your strength, heroes!`
        ]);

      case 'monster_defeated':
        return formatChatMessages(
          `🎉 ${details.monster || 'The beast'} has been vanquished! (+${details.xp || 0} XP, +${details.gold || 0}g)`
        );

      case 'player_knocked_out':
        return formatChatMessages(
          `💀 @${details.displayName || details.user} has been knocked out by ${details.monster || details.reason || 'the dungeon'}!`
        );

      case 'player_healed':
        return formatChatMessages(
          `💖 @${details.user} healed @${details.target} for ${details.amount} HP!`
        );

      case 'party_wiped':
        return formatChatMessages(
          `☠️ Total party wipeout in room ${details.roomNumber || '?'}. Darkness consumes the expedition.`
        );

      case 'dungeon_cleared':
        return formatChatMessages([
          `🏆 DUNGEON CLEARED! The heroes conquered all ${details.totalRooms} rooms of "${details.theme}"!`,
          `Total monsters slain: ${details.monstersSlain || 0}. Glorious victory!`
        ]);

      default:
        return formatChatMessages(`⚔️ A fateful moment occurs: ${momentType}.`);
    }
  }
}
