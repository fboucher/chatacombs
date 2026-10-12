/**
 * In-character @Bot Roleplay Q&A handler for Chatacombs.
 * Answers free-text questions and flavor actions addressed to the bot
 * with a 30-second per-viewer cooldown and procedural template fallback.
 */

import { AiClient } from './client.js';
import { formatChatMessages } from './templates.js';
import { getSoul } from './soul.js';
import { buildDungeonMasterSystemPrompt, buildChatQnaPrompt } from './prompts.js';

export const DEFAULT_QNA_COOLDOWN_MS = 30 * 1000; // 30 seconds

export class ChatQnaHandler {
  /**
   * @param {object} [options={}]
   * @param {AiClient} [options.aiClient]
   * @param {string} [options.botName='Bones']
   * @param {string} [options.theme='classic fantasy']
   * @param {string} [options.soul] Extra context for the AI (defaults to soul.md)
   * @param {number} [options.cooldownMs=30000]
   * @param {() => number} [options.clock=() => Date.now()]
   */
  constructor(options = {}) {
    this.aiClient = options.aiClient || new AiClient();
    this.botName = (options.botName || process.env.BOT_NAME || 'Bones').toLowerCase();
    this.theme = options.theme || 'classic fantasy';
    this.soul = options.soul ?? getSoul();
    this.cooldownMs = options.cooldownMs ?? DEFAULT_QNA_COOLDOWN_MS;
    this.clock = options.clock || (() => Date.now());

    // Map: username -> lastQuestionTimestampMs
    this.cooldowns = new Map();
  }

  setTheme(theme) {
    if (theme) this.theme = theme;
  }

  setBotName(botName) {
    if (botName) this.botName = botName.toLowerCase();
  }

  /**
   * Checks whether a message addresses the bot (e.g. "@Bones what is that?", "bones help").
   * @param {string} text
   * @returns {boolean}
   */
  isBotMentioned(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    const bot = this.botName;

    // Checks for @bot or word-boundary mention of bot
    const regex = new RegExp(`(@${bot}\\b|\\b${bot}\\b)`, 'i');
    return regex.test(lower);
  }

  /**
   * Checks whether a user is currently rate-limited.
   * @param {string} user
   * @param {number} [now]
   * @returns {{ onCooldown: boolean, remainingMs: number }}
   */
  checkCooldown(user, now = this.clock()) {
    const userNorm = user.toLowerCase();
    const lastAt = this.cooldowns.get(userNorm);
    if (!lastAt) {
      return { onCooldown: false, remainingMs: 0 };
    }
    const elapsed = now - lastAt;
    if (elapsed < this.cooldownMs) {
      return { onCooldown: true, remainingMs: this.cooldownMs - elapsed };
    }
    return { onCooldown: false, remainingMs: 0 };
  }

  /**
   * Generates procedural fallback answer when AI is unavailable or failing.
   * @param {object} params
   * @returns {Array<string>}
   */
  getFallbackResponse({ user, displayName, room, question }) {
    const name = displayName || user;
    const roomName = room?.name || 'these dark chambers';
    const exits = (room?.exits || []).map(e => typeof e === 'string' ? e : e.direction).join(', ');
    const exitText = exits ? `Exits remain: ${exits}.` : '';

    return formatChatMessages([
      `🕯️ @${name}, the echoes of ${roomName} swallow your words. Keep your blade ready! ${exitText}`
    ]);
  }

  /**
   * Generates cooldown notification line.
   * @param {object} params
   * @param {number} remainingMs
   * @returns {Array<string>}
   */
  getCooldownResponse({ user, displayName }, remainingMs) {
    const name = displayName || user;
    const secs = Math.ceil(remainingMs / 1000);
    return formatChatMessages([
      `⏳ Shh, @${name}! The Dungeon Master needs a breath (wait ${secs}s).`
    ]);
  }

  /**
   * Handles an incoming message addressed to the bot.
   * Enforces 30s cooldown and attempts AI answer with procedural fallback.
   * Returns Array<string> of 1-2 chat messages.
   *
   * @param {object} params
   * @param {string} params.user
   * @param {string} params.displayName
   * @param {string} params.text
   * @param {object} params.room
   * @param {object} [params.dungeonContext={}]
   * @returns {Promise<Array<string>>}
   */
  async handleMessage({ user, displayName, text, room, dungeonContext = {} }) {
    const now = this.clock();
    const userNorm = user.toLowerCase();

    // 1. Check cooldown
    const { onCooldown, remainingMs } = this.checkCooldown(userNorm, now);
    if (onCooldown) {
      return this.getCooldownResponse({ user, displayName }, remainingMs);
    }

    // 2. Set cooldown timestamp
    this.cooldowns.set(userNorm, now);

    // 3. Fallback if AI is unconfigured
    if (!this.aiClient.isConfigured) {
      return this.getFallbackResponse({ user, displayName, room, question: text });
    }

    // 4. Call AI with prompt
    const systemPrompt = buildDungeonMasterSystemPrompt({
      botName: this.botName,
      theme: this.theme,
      soul: this.soul
    });

    const userPrompt = buildChatQnaPrompt({
      user: userNorm,
      displayName: displayName || user,
      question: text,
      room,
      dungeonContext
    });

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const result = await this.aiClient.generateCompletion(messages);
    if (result.ok && result.text) {
      const lines = result.text.split(/\n+/).map(l => l.trim()).filter(Boolean);
      return formatChatMessages(lines);
    }

    return this.getFallbackResponse({ user, displayName, room, question: text });
  }
}
