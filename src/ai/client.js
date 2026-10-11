/**
 * Thin, foolproof AI Client for OpenAI-compatible chat completions.
 * Enforces a strict timeout via AbortController and resolves cleanly
 * to an explicit fallback signal on any failure or missing configuration.
 * Failures are logged (at most once a minute per kind) so a misconfigured
 * endpoint doesn't silently turn into template text.
 */

export const DEFAULT_TIMEOUT_MS = 10000;
export const FAILURE_LOG_INTERVAL_MS = 60000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Reads a positive integer from an environment value.
 * @param {string|undefined} value
 * @returns {number|null}
 */
function positiveInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class AiClient {
  /**
   * @param {object} [options={}]
   * @param {string} [options.url] OpenAI-compatible endpoint URL (e.g. process.env.AI_URL)
   * @param {string} [options.key] API Key (e.g. process.env.AI_KEY)
   * @param {string} [options.model] Model name (e.g. process.env.AI_MODEL)
   * @param {number} [options.timeoutMs=10000] (or process.env.AI_TIMEOUT_MS)
   * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
   * @param {{ warn: Function }} [options.logger=console]
   */
  constructor(options = {}) {
    this.url = options.url || process.env.AI_URL || null;
    this.key = options.key || process.env.AI_KEY || null;
    this.model = options.model || process.env.AI_MODEL || null;
    this.timeoutMs = options.timeoutMs ?? positiveInt(process.env.AI_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.logger = options.logger || console;
    this._lastFailureLogAt = new Map(); // error kind -> time last logged
  }

  /**
   * One-line summary of the AI setup for the startup log.
   * @returns {string}
   */
  describe() {
    if (!this.isConfigured) return 'off (AI_URL not set, using built-in text)';
    return `on (${this.model || 'default model'} at ${this.endpoint}, ${this.timeoutMs}ms timeout)`;
  }

  /**
   * Whether AI_URL points at the machine Chatacombs runs on, which inside a
   * container is the container itself rather than the host.
   * @returns {boolean}
   */
  get pointsAtLocalhost() {
    try {
      return LOCAL_HOSTS.has(new URL(this.endpoint).hostname);
    } catch {
      return false;
    }
  }

  /**
   * Logs why a completion fell back to templates, at most once a minute per kind.
   * @param {string} error
   */
  _logFailure(error) {
    const kind = error.startsWith('HTTP_') ? error : error.split(':')[0];
    const now = Date.now();
    const last = this._lastFailureLogAt.get(kind);
    if (last !== undefined && now - last < FAILURE_LOG_INTERVAL_MS) return;
    this._lastFailureLogAt.set(kind, now);

    let hint = '';
    if (error === 'TIMEOUT') {
      hint = ` Raise AI_TIMEOUT_MS (now ${this.timeoutMs}) if the model is slow.`;
    } else if (!error.startsWith('HTTP_') && error !== 'EMPTY_OR_INVALID_COMPLETION' && this.pointsAtLocalhost) {
      hint = ' If Chatacombs runs in Docker, localhost is the container itself: point AI_URL at host.docker.internal instead.';
    }
    this.logger.warn(`[ai] ${this.endpoint} failed (${error}), using built-in text.${hint}`);
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
        return this._fail(`HTTP_${res.status}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;

      if (typeof content !== 'string' || !content.trim()) {
        return this._fail('EMPTY_OR_INVALID_COMPLETION');
      }

      return {
        ok: true,
        text: content.trim(),
        fallback: false
      };
    } catch (err) {
      clearTimeout(timeout);
      const isAbort = err.name === 'AbortError' || controller.signal.aborted;
      const cause = err.cause?.code || err.cause?.message;
      const message = err.message || 'NETWORK_ERROR';
      return this._fail(isAbort ? 'TIMEOUT' : (cause ? `${message}: ${cause}` : message));
    }
  }

  /**
   * Logs and returns the fallback signal for a failed completion.
   * @param {string} error
   * @returns {{ ok: false, fallback: true, error: string }}
   */
  _fail(error) {
    this._logFailure(error);
    return { ok: false, fallback: true, error };
  }
}
