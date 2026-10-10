import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Client modules in dependency order. They are ES modules so tests can import them,
// and get flattened into one classic script for the single-file page.
const SCRIPT_FILES = ['audio.js', 'overlay.js'];

let cachedPage = null;

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
 * @returns {string}
 */
export function buildOverlayPage() {
  const read = name => readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

  const html = read('overlay.html');
  const css = read('overlay.css');
  const js = bundleScripts(SCRIPT_FILES.map(read)).replace(/<\/script/gi, '<\\/script');

  return html
    .replace('/*__OVERLAY_CSS__*/', () => css)
    .replace('/*__OVERLAY_JS__*/', () => js);
}

/**
 * Returns the overlay page, built once per process.
 * @returns {string}
 */
export function renderOverlayPage() {
  if (!cachedPage) cachedPage = buildOverlayPage();
  return cachedPage;
}
