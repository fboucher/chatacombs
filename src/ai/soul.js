/**
 * The streamer's "soul" file: free-form notes (personality, running jokes, lore,
 * words to avoid) added to every AI prompt. Optional: a missing or unreadable file
 * just means no extra context. See soul_sample.md for an example.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_SOUL_FILE = 'soul.md';
// Small local models lose the rules under a long prompt, so keep the soul short
export const MAX_SOUL_CHARS = 4000;

let cached = null;

/**
 * Reads the soul file. Never throws.
 * @param {string} [file] Defaults to SOUL_PATH, else soul.md in the working directory
 * @returns {{ text: string, path: string, status: 'loaded'|'missing'|'empty'|'error', truncated?: boolean, error?: string }}
 */
export function readSoul(file = process.env.SOUL_PATH || DEFAULT_SOUL_FILE) {
  const fullPath = path.resolve(file);
  let raw;
  try {
    raw = readFileSync(fullPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { text: '', path: fullPath, status: 'missing' };
    return { text: '', path: fullPath, status: 'error', error: err.code || err.message };
  }

  // HTML comments are notes for the streamer, not for the model
  let text = raw.replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!text) return { text: '', path: fullPath, status: 'empty' };

  const truncated = text.length > MAX_SOUL_CHARS;
  if (truncated) text = text.slice(0, MAX_SOUL_CHARS);
  return { text, path: fullPath, status: 'loaded', truncated };
}

/**
 * The soul text shared by every prompt, read once per process.
 * @returns {string}
 */
export function getSoul() {
  if (cached === null) cached = readSoul().text;
  return cached;
}

/**
 * Startup log line describing what was (or wasn't) loaded.
 * @param {ReturnType<typeof readSoul>} [soul]
 * @returns {string}
 */
export function describeSoul(soul = readSoul()) {
  switch (soul.status) {
    case 'loaded':
      return `${soul.path} (${soul.text.length} characters${soul.truncated ? `, cut to the first ${MAX_SOUL_CHARS}` : ''})`;
    case 'empty':
      return `${soul.path} is empty, no extra context`;
    case 'error':
      return `could not read ${soul.path} (${soul.error}), no extra context`;
    default:
      return 'none (add a soul.md to give the AI extra context, see soul_sample.md)';
  }
}
