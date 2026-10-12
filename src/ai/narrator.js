/**
 * AI-First Narrator with Procedural Template Fallback for Chatacombs.
 * Orchestrates calls to AiClient with prompts, automatically falling back
 * to NarrationTemplates on timeout, network failure, or missing AI configuration.
 */

import { AiClient } from './client.js';
import { NarrationTemplates, formatChatMessages } from './templates.js';
import {
  buildDungeonMasterSystemPrompt,
  buildRoomEntryPrompt,
  buildMonsterIntroPrompt,
  buildCombatRecapPrompt,
  buildMomentPrompt
} from './prompts.js';
import { getSoul } from './soul.js';

export class Narrator {
  /**
   * @param {object} [options={}]
   * @param {AiClient} [options.aiClient]
   * @param {NarrationTemplates} [options.templates]
   * @param {string} [options.botName='Bones']
   * @param {string} [options.theme='classic fantasy']
   * @param {string} [options.soul] Extra context for the AI (defaults to soul.md)
   * @param {boolean} [options.fallbackToTemplates=true] When false, a failed or unconfigured AI call yields no lines
   */
  constructor(options = {}) {
    this.aiClient = options.aiClient || new AiClient();
    this.templates = options.templates || new NarrationTemplates();
    this.botName = options.botName || process.env.BOT_NAME || 'Bones';
    this.theme = options.theme || 'classic fantasy';
    this.soul = options.soul ?? getSoul();
    this.fallbackToTemplates = options.fallbackToTemplates ?? true;
  }

  setTheme(theme) {
    if (theme) this.theme = theme;
  }

  setBotName(botName) {
    if (botName) this.botName = botName;
  }

  /**
   * Attempts AI generation with system prompt and user prompt.
   * If AI fails or times out, returns fallbackFn result.
   * Never throws and always returns Array<string> (at most 2 messages, or none when
   * template fallback is turned off).
   *
   * @param {string} userPrompt
   * @param {() => Array<string>} fallbackFn
   * @returns {Promise<Array<string>>}
   */
  async _narrateWithFallback(userPrompt, fallbackFn) {
    const fallback = () => (this.fallbackToTemplates ? fallbackFn() : []);
    if (!this.aiClient.isConfigured) {
      return fallback();
    }

    const systemPrompt = buildDungeonMasterSystemPrompt({
      botName: this.botName,
      theme: this.theme,
      soul: this.soul
    });

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const result = await this.aiClient.generateCompletion(messages);
    if (result.ok && result.text) {
      // Split AI text by newlines into at most 2 messages
      const rawLines = result.text.split(/\n+/).map(l => l.trim()).filter(Boolean);
      return formatChatMessages(rawLines);
    }

    return fallback();
  }

  /**
   * Narrates room entry.
   * @param {object} room 
   * @param {object} [context={}]
   * @returns {Promise<Array<string>>}
   */
  async narrateRoom(room, context = {}) {
    const prompt = buildRoomEntryPrompt(room, context);
    return this._narrateWithFallback(
      prompt,
      () => this.templates.describeRoom(room, context)
    );
  }

  /**
   * Narrates monster appearance.
   * @param {object} monster 
   * @param {object} [roomContext={}]
   * @returns {Promise<Array<string>>}
   */
  async narrateMonsterIntro(monster, roomContext = {}) {
    const prompt = buildMonsterIntroPrompt(monster, roomContext);
    return this._narrateWithFallback(
      prompt,
      () => this.templates.describeMonsterIntro(monster, roomContext)
    );
  }

  /**
   * Narrates combat round recap.
   * @param {object} params 
   * @returns {Promise<Array<string>>}
   */
  async narrateCombatRecap(params) {
    const prompt = buildCombatRecapPrompt(params);
    return this._narrateWithFallback(
      prompt,
      () => this.templates.describeCombatRecap(params)
    );
  }

  /**
   * Narrates generic game moments.
   * @param {string} momentType 
   * @param {object} details 
   * @returns {Promise<Array<string>>}
   */
  async narrateMoment(momentType, details = {}) {
    const prompt = buildMomentPrompt(momentType, details);
    return this._narrateWithFallback(
      prompt,
      () => this.templates.describeMoment(momentType, details)
    );
  }
}
