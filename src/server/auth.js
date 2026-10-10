import crypto from 'node:crypto';

/**
 * Constant-time string equality check to mitigate timing attacks.
 * @param {string} a 
 * @param {string} b 
 * @returns {boolean}
 */
export function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware requiring Bearer token matching apiKey.
 * @param {string} [apiKey] Expected API key (defaults to process.env.API_KEY)
 * @returns {import('express').RequestHandler}
 */
export function requireApiKey(apiKey = process.env.API_KEY) {
  return (req, res, next) => {
    const expected = apiKey || process.env.API_KEY;
    if (!expected) {
      return res.status(500).json({ error: 'Server API_KEY is not configured' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || typeof authHeader !== 'string') {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'Invalid Authorization header format. Expected Bearer <token>' });
    }

    const token = match[1].trim();
    if (!safeCompare(token, expected)) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    }

    next();
  };
}

/**
 * Express middleware requiring query parameter ?key= matching overlayKey (or Bearer token fallback).
 * @param {string} [overlayKey] Expected Overlay key (defaults to process.env.OVERLAY_KEY)
 * @returns {import('express').RequestHandler}
 */
export function requireOverlayKey(overlayKey = process.env.OVERLAY_KEY) {
  return (req, res, next) => {
    const expected = overlayKey || process.env.OVERLAY_KEY;
    if (!expected) {
      return res.status(500).json({ error: 'Server OVERLAY_KEY is not configured' });
    }

    // Check query param first (?key=...)
    const queryKey = req.query.key;
    if (typeof queryKey === 'string' && safeCompare(queryKey, expected)) {
      return next();
    }

    // Fallback: check Bearer token if query param is absent
    const authHeader = req.headers.authorization;
    if (authHeader && typeof authHeader === 'string') {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match && safeCompare(match[1].trim(), expected)) {
        return next();
      }
    }

    return res.status(401).json({ error: 'Unauthorized: Invalid overlay key' });
  };
}
