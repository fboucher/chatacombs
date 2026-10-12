import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSoul, describeSoul, MAX_SOUL_CHARS } from '../src/ai/soul.js';
import { buildDungeonMasterSystemPrompt } from '../src/ai/prompts.js';
import { ChatQnaHandler } from '../src/ai/chatQna.js';

const dir = mkdtempSync(path.join(tmpdir(), 'soul-'));

test('soul - missing, empty, unreadable or comment-only files are ignored without throwing', () => {
  assert.equal(readSoul(path.join(dir, 'nope.md')).status, 'missing');
  assert.match(describeSoul(readSoul(path.join(dir, 'nope.md'))), /soul_sample\.md/);

  writeFileSync(path.join(dir, 'empty.md'), '  \n<!-- only notes for the streamer -->\n');
  assert.deepEqual({ ...readSoul(path.join(dir, 'empty.md')), path: '' }, { text: '', path: '', status: 'empty' });

  // e.g. Docker created a folder where the file was expected
  mkdirSync(path.join(dir, 'folder.md'));
  const folder = readSoul(path.join(dir, 'folder.md'));
  assert.equal(folder.status, 'error');
  assert.equal(folder.text, '');
});

test('soul - text is loaded without HTML comments and capped', () => {
  writeFileSync(path.join(dir, 'soul.md'), '﻿<!-- hint -->\n# Who you are\nA cheerful skeleton.\n');
  const soul = readSoul(path.join(dir, 'soul.md'));
  assert.equal(soul.status, 'loaded');
  assert.equal(soul.text, '# Who you are\nA cheerful skeleton.');

  writeFileSync(path.join(dir, 'long.md'), 'x'.repeat(MAX_SOUL_CHARS + 10));
  const long = readSoul(path.join(dir, 'long.md'));
  assert.equal(long.text.length, MAX_SOUL_CHARS);
  assert.match(describeSoul(long), /cut to the first/);
});

test('soul - the sample in the repo loads', () => {
  const sample = readSoul('soul_sample.md');
  assert.equal(sample.status, 'loaded');
  assert.doesNotMatch(sample.text, /<!--/);
});

test('soul - appended to the system prompt after the rules, absent when empty', () => {
  const without = buildDungeonMasterSystemPrompt({ botName: 'Bones', theme: 'crypt' });
  assert.doesNotMatch(without, /STREAMER'S NOTES/);

  const withSoul = buildDungeonMasterSystemPrompt({ botName: 'Bones', theme: 'crypt', soul: 'Loves puns.' });
  assert.ok(withSoul.startsWith(without));
  assert.ok(withSoul.indexOf('CRITICAL RULES') < withSoul.indexOf('Loves puns.'));
});

test('soul - chat Q&A sends the soul to the AI', async () => {
  let sent = null;
  const aiClient = { isConfigured: true, generateCompletion: async messages => { sent = messages; return { ok: true, text: 'Hi!' }; } };
  const qna = new ChatQnaHandler({ aiClient, botName: 'Bones', soul: 'Calls chat my little lanterns.' });
  await qna.handleMessage({ user: 'amy', displayName: 'Amy', text: '@Bones hi', room: null });
  assert.match(sent[0].content, /my little lanterns/);
});
