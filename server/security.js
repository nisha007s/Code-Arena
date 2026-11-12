// Small security helpers: same-origin checks, rate limiting, headers, validation.
import { errors } from './errors.js';

// Token bucket per key: `limit` actions per `windowMs`.
export class RateLimiter {
  constructor({ limit, windowMs = 60000, clock = Date }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.buckets = new Map();
  }
  take(key) {
    const now = this.clock.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.limit, at: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.limit, b.tokens + ((now - b.at) / this.windowMs) * this.limit);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    if (this.buckets.size > 10000) this.buckets.clear(); // crude bound for a demo server
    return true;
  }
}

export function expectedOrigin(req, trustProxy) {
  const proto = trustProxy && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0] : (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

// Browser mutations must come from this origin.
export function isSameOrigin(req, trustProxy) {
  const origin = req.headers.origin;
  if (origin) return origin === expectedOrigin(req, trustProxy);
  return req.headers['sec-fetch-site'] === 'same-origin';
}

export function sameOriginMiddleware(trustProxy) {
  return (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!isSameOrigin(req, trustProxy)) return next(errors.forbidden('Cross-origin request rejected.', 'bad_origin'));
    next();
  };
}

export function securityHeaders(secure) {
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  };
}

// Display names: 1–24 letters, digits, spaces and a few punctuation marks.
export function cleanDisplayName(value, max) {
  if (typeof value !== 'string') throw errors.badRequest('Display name must be text.');
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name) throw errors.badRequest('Display name cannot be empty.');
  if ([...name].length > max) throw errors.badRequest(`Display name can be at most ${max} characters.`);
  if (!/^[\p{L}\p{N} _.'-]+$/u.test(name)) throw errors.badRequest('Display name can use letters, numbers, spaces and _ . \' -');
  return name;
}

export function requireString(value, field, { maxBytes, allowEmpty = true } = {}) {
  if (typeof value !== 'string') throw errors.badRequest(`${field} must be a string.`);
  if (!allowEmpty && !value.length) throw errors.badRequest(`${field} cannot be empty.`);
  if (maxBytes && Buffer.byteLength(value, 'utf8') > maxBytes) throw errors.badRequest(`${field} is larger than ${Math.round(maxBytes / 1024)} KB.`, 'too_large');
  return value;
}

export function requireRequestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) throw errors.badRequest('requestId must be 8–64 letters, digits, _ or -.');
  return value;
}
