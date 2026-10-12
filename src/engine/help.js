/**
 * "Soft" help command: viewers ask the bot for help in plain words
 * ("Bones how do I play?", "@Bones help", "Bones ?") instead of a `!` command.
 * One answer per channel per cooldown, so a chat full of "Bones help" gets a single reply.
 */

import { createSayEvent } from './events.js';

export const DEFAULT_HELP_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_HELP_URL = 'https://github.com/fboucher/chatacombs/blob/main/docs/players.md';

// What may follow the bot's name, once trailing punctuation is gone
const HELP_PHRASES = [
  /^(help|docs?|documentation|guide|manual|rules|commands?)$/,
  /^(how|what) (do|can|should) (i|we) (play|do)( this)?$/,
  /^how (does )?(this|it|the game) work$/,
  /^how to play$/,
  /^what are (the |your )?commands?$/,
  /^(list|show)( me)? (the )?commands?$/
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class HelpCommand {
  /**
   * @param {object} [options={}]
   * @param {string} [options.botName='Bones']
   * @param {string} [options.helpUrl] Link to the players guide (HELP_URL)
   * @param {number} [options.cooldownMs=300000]
   * @param {() => number} [options.clock=() => Date.now()]
   */
  constructor(options = {}) {
    this.botName = options.botName || process.env.BOT_NAME || 'Bones';
    this.helpUrl = options.helpUrl || process.env.HELP_URL || DEFAULT_HELP_URL;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_HELP_COOLDOWN_MS;
    this.clock = options.clock || (() => Date.now());
    this.lastAnsweredAt = null;
  }

  /**
   * True when the message is the bot's name followed by a help question.
   * @param {string} text
   * @returns {boolean}
   */
  matches(text) {
    if (!text || typeof text !== 'string') return false;
    const prefix = new RegExp(`^@?${escapeRegExp(this.botName.toLowerCase())}\\b[\\s,:;!-]*`);
    const lower = text.trim().toLowerCase().replace(/\s+/g, ' ');
    const match = prefix.exec(lower);
    if (!match) return false;

    const rest = lower.slice(match[0].length).trim();
    if (/^\?+$/.test(rest)) return true;
    const words = rest.replace(/[?!.,]+$/, '').trim();
    return HELP_PHRASES.some(phrase => phrase.test(words));
  }

  /**
   * Returns the help line, or nothing while the channel-wide cooldown runs.
   * @param {number} [now]
   * @returns {Array<object>} say events
   */
  handle(now = this.clock()) {
    if (this.lastAnsweredAt !== null && now - this.lastAnsweredAt < this.cooldownMs) return [];
    this.lastAnsweredAt = now;
    return [createSayEvent(this.helpText())];
  }

  /**
   * One chat line: Twitch chat can't post newlines.
   * @returns {string}
   */
  helpText() {
    return `📜 How to play: just chat to join the party. In a room: !explore, !go <exit>. In a fight: !attack, !defend, !item potion, !heal @name. !hero shows your stats, @${this.botName} <question> asks me anything. Full guide: ${this.helpUrl}`;
  }
}
