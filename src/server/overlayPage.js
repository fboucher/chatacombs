import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Client modules in dependency order. They are ES modules so tests can import them,
// and get flattened into one classic script for the single-file page.
const SCRIPT_FILES = ['audio.js', 'overlay.js'];

const BOT_IMAGES = {
  __BOT_IMG_SKELETON__: 'bots/chatacombs-bot-skeleton.png',
  __BOT_IMG_MUMMY__: 'bots/chatacombs-bot-mummy.png'
};

const cachedPages = new Map();

/**
 * Escapes text for an HTML text node or attribute.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Turns the client ES modules into one self-contained script.
 * Imports must be single-line; exports become plain declarations in a shared scope.
 * @param {string[]} sources
 * @returns {string}
 */
export function bundleScripts(sources) {
  const body = sources
    .map(src => src
      .replace(/^import\s[^\n]*;[ \t]*$/gm, '')
      .replace(/^export\s+(?=(async\s+)?function\b|const\b|let\b|class\b)/gm, ''))
    .join('\n');

  return `(function () {\n'use strict';\n${body}\nif (typeof window !== 'undefined') startOverlay(window);\n})();`;
}

/**
 * Builds the single self-contained overlay HTML (inline CSS + JS, no external URLs).
 * Bot pictures are inlined as data URIs and the bot's name is baked into the page.
 * @param {object} [options={}]
 * @param {string} [options.botName] Shown as `@<botName>` under the bot picture
 * @returns {string}
 */
export function buildOverlayPage(options = {}) {
  const botName = options.botName || process.env.BOT_NAME || 'CB';
  const read = name => readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
  const dataUri = name => `data:image/png;base64,${readFileSync(path.join(PUBLIC_DIR, name)).toString('base64')}`;

  const html = read('overlay.html');
  const css = read('overlay.css');
  const js = bundleScripts(SCRIPT_FILES.map(read)).replace(/<\/script/gi, '<\\/script');

  let page = html
    .replace('/*__OVERLAY_CSS__*/', () => css)
    .replace('/*__OVERLAY_JS__*/', () => js)
    .replace('__BOT_NAME__', () => escapeHtml(botName));
  for (const [placeholder, file] of Object.entries(BOT_IMAGES)) {
    page = page.replace(placeholder, () => dataUri(file));
  }
  return page;
}

/**
 * Returns the overlay page, built once per process (and bot name).
 * @param {object} [options={}]
 * @param {string} [options.botName]
 * @returns {string}
 */
export function renderOverlayPage(options = {}) {
  const botName = options.botName || process.env.BOT_NAME || 'CB';
  if (!cachedPages.has(botName)) cachedPages.set(botName, buildOverlayPage({ botName }));
  return cachedPages.get(botName);
}
