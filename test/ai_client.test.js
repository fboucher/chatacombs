import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiClient } from '../src/ai/client.js';

test('ai client - missing config resolves cleanly to fallback without network call', async () => {
  let fetchCalled = false;
  const client = new AiClient({
    url: '',
    fetchFn: async () => {
      fetchCalled = true;
      return new Response('{}');
    }
  });

  assert.equal(client.isConfigured, false);
  const result = await client.generateCompletion([{ role: 'user', content: 'hello' }]);
  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.equal(result.error, 'AI_NOT_CONFIGURED');
});

test('ai client - success path hits endpoint with correct method, headers, and body', async () => {
  let interceptedUrl = null;
  let interceptedMethod = null;
  let interceptedHeaders = null;
  let interceptedBody = null;

  const mockFetch = async (url, options) => {
    interceptedUrl = url;
    interceptedMethod = options.method;
    interceptedHeaders = options.headers;
    interceptedBody = JSON.parse(options.body);

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'The stone doors grind open into a dark mossy chamber.'
            }
          }
        ]
      })
    };
  };

  const client = new AiClient({
    url: 'https://api.openai.com/v1',
    key: 'secret-token',
    model: 'gpt-4o-mini',
    fetchFn: mockFetch
  });

  assert.equal(client.isConfigured, true);
  assert.equal(client.endpoint, 'https://api.openai.com/v1/chat/completions');

  const messages = [{ role: 'system', content: 'You are DM' }, { role: 'user', content: 'describe room' }];
  const result = await client.generateCompletion(messages);

  assert.equal(interceptedUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(interceptedMethod, 'POST');
  assert.equal(interceptedHeaders['Authorization'], 'Bearer secret-token');
  assert.equal(interceptedHeaders['Content-Type'], 'application/json');
  assert.equal(interceptedBody.model, 'gpt-4o-mini');
  assert.deepEqual(interceptedBody.messages, messages);

  assert.equal(result.ok, true);
  assert.equal(result.fallback, false);
  assert.equal(result.text, 'The stone doors grind open into a dark mossy chamber.');
});

test('ai client - handles URL already ending with /chat/completions', async () => {
  const client = new AiClient({
    url: 'https://custom-ai.internal/v1/chat/completions/'
  });
  assert.equal(client.endpoint, 'https://custom-ai.internal/v1/chat/completions');
});

test('ai client - 4-second timeout aborts via AbortController and yields fallback signal', async () => {
  const mockFetch = (url, options) => {
    return new Promise((resolve, reject) => {
      // Listen to signal abort
      options.signal.addEventListener('abort', () => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        reject(abortErr);
      });
    });
  };

  const client = new AiClient({
    url: 'https://slow-api.example/v1',
    timeoutMs: 50, // Short timeout for test speed
    fetchFn: mockFetch
  });

  const result = await client.generateCompletion([{ role: 'user', content: 'fast please' }]);
  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.equal(result.error, 'TIMEOUT');
});

test('ai client - HTTP error status resolves to fallback without throwing', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'Service Unavailable' })
  });

  const client = new AiClient({
    url: 'https://failing-api.example/v1',
    fetchFn: mockFetch
  });

  const result = await client.generateCompletion([{ role: 'user', content: 'test' }]);
  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.equal(result.error, 'HTTP_503');
});

test('ai client - malformed response / invalid JSON resolves to fallback without throwing', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('Unexpected token in JSON');
    }
  });

  const client = new AiClient({
    url: 'https://corrupt-api.example/v1',
    fetchFn: mockFetch
  });

  const result = await client.generateCompletion([{ role: 'user', content: 'test' }]);
  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.match(result.error, /JSON/);
});
