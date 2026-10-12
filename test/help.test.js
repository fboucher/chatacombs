import test from 'node:test';
import assert from 'node:assert/strict';
import { HelpCommand, DEFAULT_HELP_COOLDOWN_MS } from '../src/engine/help.js';
import { Engine } from '../src/engine/engine.js';

test('help - recognises plain-words help questions addressed to the bot', () => {
  const help = new HelpCommand({ botName: 'Bones' });
  for (const text of [
    'Bones how do I play?',
    'Bones what are the command?',
    'Bones what are the commands',
    'Bones Help',
    'bones help!',
    '@Bones help',
    'Bones, help',
    'Bones Doc',
    'Bones docs',
    'Bones ?',
    'Bones ???',
    'BONES   how to play'
  ]) {
    assert.ok(help.matches(text), text);
  }
  for (const text of [
    'help',
    'Bones',
    'Bones is that chest trapped?',
    'Bones help me kill this rat',
    'I need help Bones',
    'Bonesaw help',
    '!help'
  ]) {
    assert.ok(!help.matches(text), text);
  }
  assert.ok(new HelpCommand({ botName: 'C.B' }).matches('C.B help'));
  assert.ok(!new HelpCommand({ botName: 'C.B' }).matches('CxB help'));
});

test('help - one single-line answer per channel every 5 minutes, silent in between', () => {
  let now = 1000;
  const help = new HelpCommand({ botName: 'Bones', helpUrl: 'https://example.test/guide', clock: () => now });
  const first = help.handle();
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'say');
  assert.doesNotMatch(first[0].text, /\n/);
  assert.match(first[0].text, /!explore/);
  assert.match(first[0].text, /@Bones <question>/);
  assert.match(first[0].text, /https:\/\/example\.test\/guide$/);
  assert.ok(first[0].text.length < 480);

  now += DEFAULT_HELP_COOLDOWN_MS - 1;
  assert.deepEqual(help.handle(), []);
  now += 1;
  assert.equal(help.handle().length, 1);
});

test('help - engine answers before the AI Q&A and the Q&A still gets other questions', async () => {
  let now = 0;
  const asked = [];
  const chatQna = {
    isBotMentioned: text => /\bbones\b/i.test(text),
    handleMessage: async ({ text }) => { asked.push(text); return ['answer']; }
  };
  const engine = new Engine({ botName: 'Bones', clock: () => now, chatQna });

  const first = await engine.handleMessageAsync({ user: 'amy', displayName: 'Amy', text: 'Bones how do I play?' });
  assert.equal(first.events.filter(e => e.kind === 'say').length, 1);
  assert.match(first.events[0].text, /How to play/);

  now += 1000;
  const second = await engine.handleMessageAsync({ user: 'bob', displayName: 'Bob', text: 'Bones help' });
  assert.equal(second.events.filter(e => e.kind === 'say').length, 0);

  await engine.handleMessageAsync({ user: 'bob', displayName: 'Bob', text: 'Bones what is behind the door?' });
  assert.deepEqual(asked, ['Bones what is behind the door?']);
});
