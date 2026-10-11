/**
 * Standard event constructors for Chatacombs engine.
 * Emits two kinds of events:
 * - 'say': message string to be posted by the chatbot into Twitch chat
 * - 'game': structured game moment event for OBS overlays and effects
 */

/**
 * Creates a chat 'say' event.
 * Twitch chat messages are a single line, and a line break makes bots drop or
 * cut the message, so any line breaks are folded into spaces.
 * @param {string} text 
 * @returns {{ kind: 'say', text: string }}
 */
export function createSayEvent(text) {
  return {
    kind: 'say',
    text: String(text).replace(/\s*[\r\n]+\s*/g, ' ')
  };
}

/**
 * Creates a structured 'game' moment event.
 * @param {string} type e.g. 'dice_roll', 'room_entered', 'adventure_started', etc.
 * @param {object} payload 
 * @returns {{ kind: 'game', type: string, [key: string]: any }}
 */
export function createGameEvent(type, payload = {}) {
  return {
    kind: 'game',
    type,
    ...payload
  };
}
