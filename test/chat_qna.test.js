import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatQnaHandler, DEFAULT_QNA_COOLDOWN_MS } from '../src/ai/chatQna.js';
import { AiClient } from '../src/ai/client.js';
import { Engine } from '../src/engine/engine.js';
import { createRng } from '../src/engine/dice.js';

test('chat qna - isBotMentioned detects bot name in multiple formats', () => {
  const handler = new ChatQnaHandler({ botName: 'CeeBee' });

  assert.equal(handler.isBotMentioned('@ceebee what is on the wall?'), true);
  assert.equal(handler.isBotMentioned('Hey @CeeBee look out!'), true);
  assert.equal(handler.isBotMentioned('ceebee where are we?'), true);
  assert.equal(handler.isBotMentioned('just talking in chat'), false);
  assert.equal(handler.isBotMentioned('!attack'), false);
});

test('chat qna - generates in-character response with room facts using AI client', async () => {
  let receivedMessages = null;
  const mockClient = new AiClient({
    url: 'https://mock.api/v1',
    fetchFn: async (url, options) => {
      receivedMessages = JSON.parse(options.body).messages;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '@alice The stone wall is carved with glowing runes of ancient warding.'
              }
            }
          ]
        })
      };
    }
  });

  const handler = new ChatQnaHandler({
    aiClient: mockClient,
    botName: 'CeeBee',
    theme: 'ancient ruins'
  });

  const room = {
    name: 'Rune Hall',
    type: 'empty',
    exits: [{ direction: 'north' }, { direction: 'east' }]
  };

  const lines = await handler.handleMessage({
    user: 'alice',
    displayName: 'Alice',
    text: '@CeeBee what is on the wall?',
    room
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /glowing runes of ancient warding/);

  // Verify room context was passed in prompt
  const userPrompt = receivedMessages.find(m => m.role === 'user').content;
  assert.match(userPrompt, /Rune Hall/);
  assert.match(userPrompt, /Verified Exits: north, east/);
  assert.match(userPrompt, /what is on the wall\?/);
});

test('chat qna - enforces 30-second per-viewer cooldown with template response and zero AI calls', async () => {
  let aiCallCount = 0;
  let mockTime = 1000000;

  const mockClient = new AiClient({
    url: 'https://mock.api/v1',
    fetchFn: async () => {
      aiCallCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'First answer.' } }]
        })
      };
    }
  });

  const handler = new ChatQnaHandler({
    aiClient: mockClient,
    botName: 'CB',
    clock: () => mockTime,
    cooldownMs: 30000
  });

  // First question succeeds
  const res1 = await handler.handleMessage({
    user: 'spammer',
    displayName: 'Spammer',
    text: '@CB look around',
    room: { name: 'Chamber 1' }
  });
  assert.equal(aiCallCount, 1);
  assert.equal(res1[0], 'First answer.');

  // Immediate second question 5 seconds later is rate-limited (no AI call)
  mockTime += 5000;
  const res2 = await handler.handleMessage({
    user: 'spammer',
    displayName: 'Spammer',
    text: '@CB what about now?',
    room: { name: 'Chamber 1' }
  });
  assert.equal(aiCallCount, 1); // No new AI call!
  assert.match(res2[0], /needs a breath \(wait 25s\)/);

  // Different user is NOT blocked by spammer's cooldown
  const resOther = await handler.handleMessage({
    user: 'other_user',
    displayName: 'OtherUser',
    text: '@CB hello',
    room: { name: 'Chamber 1' }
  });
  assert.equal(aiCallCount, 2);
  assert.equal(resOther[0], 'First answer.');

  // After 30s elapsed, spammer can ask again
  mockTime += 26000;
  const res3 = await handler.handleMessage({
    user: 'spammer',
    displayName: 'Spammer',
    text: '@CB ready now?',
    room: { name: 'Chamber 1' }
  });
  assert.equal(aiCallCount, 3);
});

test('chat qna - falls back to template answer on AI timeout or unconfigured client', async () => {
  const handler = new ChatQnaHandler({
    aiClient: new AiClient({ url: '' }), // unconfigured
    botName: 'CB'
  });

  const room = {
    name: 'Dusty Crypt',
    type: 'empty',
    exits: [{ direction: 'south' }]
  };

  const lines = await handler.handleMessage({
    user: 'bob',
    displayName: 'Bob',
    text: '@CB I kick the dusty tomb',
    room
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /@Bob, the echoes of Dusty Crypt swallow your words/);
  assert.match(lines[0], /Exits remain: south/);
});

test('chat qna - flavor actions never mutate engine state or trigger unauthorized game actions', async () => {
  let mockTime = 1000000;
  const engine = new Engine({
    clock: () => mockTime,
    rng: createRng(123),
    botName: 'CeeBee'
  });

  engine.startThemeVote();
  mockTime += 61000;
  engine.handleMessage({ user: 'player1', displayName: 'Player1', text: '!vote 1' });

  const initialRoom = engine.adventure.currentRoom;
  const initialHp = engine.state.party.get('player1').hp;

  // Player performs flavor action directed to bot
  const res = await engine.handleMessageAsync({
    user: 'player1',
    displayName: 'Player1',
    text: '@CeeBee I smash the wall and leave through the secret door!'
  });

  // Verify response was emitted
  assert.ok(res.events.length >= 1);
  const say = res.events.find(e => e.kind === 'say');
  assert.ok(say);
  assert.match(say.text, /Player1/);

  // Engine state remains unchanged (not navigated, HP unchanged)
  assert.equal(engine.adventure.currentRoom.id, initialRoom.id);
  assert.equal(engine.state.party.get('player1').hp, initialHp);
});
