import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Client modules in dependency order. They are ES modules so tests can import them,
// and get flattened into one classic script for the single-file page.
const SCRIPT_FILES = ['audio.js', 'overlay.js'];

// Any `bots/chatacombs-bot-<name>.<ext>` file can be picked with `?bot=<name>`
const BOTS_DIR = path.join(PUBLIC_DIR, 'bots');
const BOT_FILE_PATTERN = /^chatacombs-bot-([a-z0-9_-]+)\.(png|webp|gif|jpe?g|svg)$/;
const BOT_MIME_TYPES = { png: 'image/png', webp: 'image/webp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };
// When a name has several files, the first extension listed wins (the .svg files are sources for the .png ones)
const BOT_EXT_ORDER = ['png', 'webp', 'gif', 'jpg', 'jpeg', 'svg'];
export const DEFAULT_BOT = 'skeleton';

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
 * Lists the bot pictures available in `src/public/bots`, by name.
 * @param {string} [dir]
 * @returns {Map<string, string>} name -> file name
 */
export function listBotImages(dir = BOTS_DIR) {
  const found = new Map();
  let files = [];
  try {
    files = readdirSync(dir);
  } catch (_) {
    return found;
  }
  for (const file of files) {
    const match = BOT_FILE_PATTERN.exec(file.toLowerCase());
    if (!match) continue;
    const [, name, ext] = match;
    const current = found.get(name);
    if (!current || BOT_EXT_ORDER.indexOf(ext) < BOT_EXT_ORDER.indexOf(current.split('.').pop())) {
      found.set(name, file);
    }
  }
  return found;
}

/**
 * Picks the bot picture for a `?bot=` value, falling back to the skeleton.
 * @param {string} [requested]
 * @param {Map<string, string>} [images]
 * @returns {{ name: string, file: string } | null}
 */
export function resolveBotImage(requested, images = listBotImages()) {
  const name = String(requested || '').trim().toLowerCase();
  if (images.has(name)) return { name, file: images.get(name) };
  if (images.has(DEFAULT_BOT)) return { name: DEFAULT_BOT, file: images.get(DEFAULT_BOT) };
  return null;
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
 * The chosen bot picture is inlined as a data URI and the bot's name is baked into the page.
 * @param {object} [options={}]
 * @param {string} [options.botName] Shown as `@<botName>` under the bot picture
 * @param {string} [options.bot] Bot picture name (`chatacombs-bot-<name>.png`), skeleton when unknown
 * @returns {string}
 */
export function buildOverlayPage(options = {}) {
  const botName = options.botName || process.env.BOT_NAME || 'Bones';
  const read = name => readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
  const botImage = resolveBotImage(options.bot);
  let botSrc = '';
  if (botImage) {
    const ext = botImage.file.split('.').pop().toLowerCase();
    botSrc = `data:${BOT_MIME_TYPES[ext]};base64,${readFileSync(path.join(BOTS_DIR, botImage.file)).toString('base64')}`;
  }

  const html = read('overlay.html');
  const css = read('overlay.css');
  const js = bundleScripts(SCRIPT_FILES.map(read)).replace(/<\/script/gi, '<\\/script');

  const page = html
    .replace('/*__OVERLAY_CSS__*/', () => css)
    .replace('/*__OVERLAY_JS__*/', () => js)
    .replace('__BOT_NAME__', () => escapeHtml(botName))
    .replace('__BOT_IMG__', () => botSrc);
  return page;
}

/**
 * Returns the overlay page, built once per process for each bot name and picture.
 * @param {object} [options={}]
 * @param {string} [options.botName]
 * @param {string} [options.bot] Bot picture name from `?bot=`
 * @returns {string}
 */
export function renderOverlayPage(options = {}) {
  const botName = options.botName || process.env.BOT_NAME || 'Bones';
  const bot = resolveBotImage(options.bot)?.name || '';
  const cacheKey = `${botName}\n${bot}`;
  if (!cachedPages.has(cacheKey)) cachedPages.set(cacheKey, buildOverlayPage({ botName, bot }));
  return cachedPages.get(cacheKey);
}
