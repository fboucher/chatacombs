/**
 * Prompt builder and system prompt templates for Chatacombs AI narration.
 * Enforces hard rules:
 * - Code owns the truth, AI narrates.
 * - At most 2 Twitch chat messages (<480 chars each).
 * - Never invent non-existent exits, never alter HP, never decide dice/combat outcomes.
 */

/**
 * Creates the Dungeon Master system prompt.
 * @param {object} [options={}]
 * @param {string} [options.botName='CB'] Name of the bot / narrator
 * @param {string} [options.theme='classic fantasy'] Active dungeon theme
 * @returns {string}
 */
export function buildDungeonMasterSystemPrompt({ botName = 'CB', theme = 'classic fantasy' } = {}) {
  return [
    `You are ${botName}, the witty and immersive Dungeon Master for Chatacombs, a chat-driven Twitch RPG.`,
    `Current Dungeon Theme: "${theme}".`,
    ``,
    `CRITICAL RULES:`,
    `1. CODE OWNS THE TRUTH, AI ONLY NARRATES: All facts, HP, dice rolls, loot, exits, and outcomes are determined solely by the engine. You must NEVER invent new exits, never alter HP numbers, and never decide or change the outcome of an action.`,
    `2. BREVITY: Output at most 2 short Twitch chat messages separated by a newline. Keep each message punchy and under 400 characters.`,
    `3. TONE: Energetic, atmospheric, and tailored to the theme "${theme}". Speak directly to the chat/party. Use 1-2 thematic emojis max.`,
    `4. NO META JARGON: Stay in character. Do not mention "as an AI", JSON, or technical mechanics.`
  ].join('\n');
}

/**
 * Builds user prompt for room entry narration.
 * @param {object} room
 * @param {object} [context={}]
 * @returns {string}
 */
export function buildRoomEntryPrompt(room, context = {}) {
  const roomNum = room.roomNumber || room.id || 1;
  const totalRooms = context.totalRooms || 10;
  const exits = (room.exits || []).map(e => typeof e === 'string' ? e : e.direction).join(', ') || 'none';
  const monsterInfo = room.monster ? `Monster present: ${room.monster.name} (${room.monster.hp} HP).` : 'No monsters.';
  const typeInfo = room.type || 'empty';

  return [
    `Narrate the party entering Room ${roomNum}/${totalRooms}: "${room.name}".`,
    `Room Type: ${typeInfo}.`,
    `Verified Exits: ${exits}.`,
    `${monsterInfo}`,
    `Describe the chamber in 1-2 Twitch chat lines. State the exits accurately.`
  ].join('\n');
}

/**
 * Builds user prompt for monster sighting / encounter opening.
 * @param {object} monster
 * @param {object} [roomContext={}]
 * @returns {string}
 */
export function buildMonsterIntroPrompt(monster, roomContext = {}) {
  const isBoss = roomContext.type === 'boss';
  return [
    `The party faces a combat encounter!`,
    `Creature: ${monster.name} (${isBoss ? 'FINAL BOSS' : 'Monster'}).`,
    `Stats: HP ${monster.hp}/${monster.maxHp}, Attack ${monster.attack}, Defense ${monster.defense}.`,
    `Narrate its appearance and summon the chat to battle with !attack, !defend, or !heal in 1-2 short lines.`
  ].join('\n');
}

/**
 * Builds user prompt for combat round resolution.
 * @param {object} params
 * @returns {string}
 */
export function buildCombatRecapPrompt({ round = 1, monster, events = [], monsterDefeated = false, partyWiped = false } = {}) {
  let outcome = 'Round continues.';
  if (monsterDefeated) {
    outcome = `Monster ${monster?.name} defeated! Rewards: ${monster?.xp || 0} XP, ${monster?.gold || 0} gold.`;
  } else if (partyWiped) {
    outcome = 'Entire party wiped out!';
  }

  const eventsSummary = events
    .filter(e => e.kind === 'game')
    .map(e => `${e.type}: ${JSON.stringify(e)}`)
    .slice(0, 5)
    .join('; ');

  return [
    `Narrate Round ${round} combat resolution.`,
    `Target: ${monster?.name} (${monster?.hp}/${monster?.maxHp} HP remaining).`,
    `Outcome: ${outcome}`,
    `Key Actions: ${eventsSummary || 'Trading blows.'}`,
    `Recap the clash in 1-2 punchy Twitch chat lines.`
  ].join('\n');
}

/**
 * Builds user prompt for key game moments.
 * @param {string} momentType
 * @param {object} details
 * @returns {string}
 */
export function buildMomentPrompt(momentType, details = {}) {
  return [
    `Narrate the following game moment in 1-2 lines:`,
    `Moment: ${momentType}`,
    `Facts: ${JSON.stringify(details)}`
  ].join('\n');
}

/**
 * Builds user prompt for in-character @Bot Q&A or flavor actions.
 * @param {object} params
 * @param {string} params.user Viewer username
 * @param {string} params.displayName Viewer display name
 * @param {string} params.question Viewer text directed to bot
 * @param {object} params.room Current room facts
 * @param {object} [params.dungeonContext={}]
 * @returns {string}
 */
export function buildChatQnaPrompt({ user, displayName, question, room, dungeonContext = {} }) {
  const roomName = room?.name || 'the dungeon';
  const roomType = room?.type || 'empty';
  const exits = (room?.exits || []).map(e => typeof e === 'string' ? e : e.direction).join(', ') || 'none';
  const monster = room?.monster ? `${room.monster.name} (${room.monster.hp} HP)` : 'none';

  return [
    `Viewer @${displayName || user} asks or acts: "${question}".`,
    `Current Room State:`,
    `- Room: ${roomName} (${roomType})`,
    `- Verified Exits: ${exits}`,
    `- Monster: ${monster}`,
    ``,
    `Respond in character as the Dungeon Master in 1-2 Twitch chat lines.`,
    `Rules: Address @${displayName || user}. Do NOT invent exits or change game mechanics. If they perform a flavor action (e.g. "I kick the chest"), describe what happens purely as atmospheric flavor without changing actual items, HP or game state.`
  ].join('\n');
}
