/**
 * Thin, foolproof AI Client for OpenAI-compatible chat completions.
 * Enforces a strict 4-second timeout via AbortController and resolves cleanly
 * to an explicit fallback signal on any failure or missing configuration.
 */

export const DEFAULT_TIMEOUT_MS = 4000;

export class AiClient {
  /**
   * @param {object} [options={}]
   * @param {string} [options.url] OpenAI-compatible endpoint URL (e.g. process.env.AI_URL)
   * @param {string} [options.key] API Key (e.g. process.env.AI_KEY)
   * @param {string} [options.model] Model name (e.g. process.env.AI_MODEL)
   * @param {number} [options.timeoutMs=4000]
   * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
   */
  constructor(options = {}) {
    this.url = options.url || process.env.AI_URL || null;
    this.key = options.key || process.env.AI_KEY || null;
    this.model = options.model || process.env.AI_MODEL || null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  /**
   * Whether the AI client has valid configuration to attempt network calls.
   * @returns {boolean}
   */
  get isConfigured() {
    return Boolean(this.url && typeof this.url === 'string' && this.url.trim().length > 0);
  }

  /**
   * Formats chat completions endpoint URL.
   * Strips trailing slash and ensures /chat/completions suffix if not present.
   * @returns {string}
   */
  get endpoint() {
    if (!this.url) return '';
    const trimmed = this.url.trim().replace(/\/+$/, '');
    if (trimmed.endsWith('/chat/completions')) {
      return trimmed;
    }
    return `${trimmed}/chat/completions`;
  }

  /**
   * Sends chat completion messages to the OpenAI-compatible endpoint.
   * Always resolves to { ok: true, text: string } or { ok: false, fallback: true, error: string }.
   * Never throws into game or caller code.
   *
   * @param {Array<{ role: string, content: string }>} messages
   * @param {object} [extraOptions={}]
   * @returns {Promise<{ ok: boolean, text?: string, fallback: boolean, error?: string }>}
   */
  async generateCompletion(messages, extraOptions = {}) {
    if (!this.isConfigured || !Array.isArray(messages) || messages.length === 0) {
      return { ok: false, fallback: true, error: 'AI_NOT_CONFIGURED' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const headers = {
        'Content-Type': 'application/json'
      };
      if (this.key) {
        headers['Authorization'] = `Bearer ${this.key}`;
      }

      const body = {
        model: this.model || 'default-model',
        messages,
        temperature: extraOptions.temperature ?? 0.7,
        max_tokens: extraOptions.maxTokens ?? 150
      };

      const res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) {
        return {
          ok: false,
          fallback: true,
          error: `HTTP_${res.status}`
        };
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;

      if (typeof content !== 'string' || !content.trim()) {
        return {
          ok: false,
          fallback: true,
          error: 'EMPTY_OR_INVALID_COMPLETION'
        };
      }

      return {
        ok: true,
        text: content.trim(),
        fallback: false
      };
    } catch (err) {
      clearTimeout(timeout);
      const isAbort = err.name === 'AbortError' || controller.signal.aborted;
      return {
        ok: false,
        fallback: true,
        error: isAbort ? 'TIMEOUT' : (err.message || 'NETWORK_ERROR')
      };
    }
  }
}
