// Guest sessions. The browser holds a random secret in an HttpOnly cookie; the
// database stores only its SHA-256 hash. Display names and room codes are never
// used to identify anyone.
import crypto from 'node:crypto';

export const COOKIE_NAME = 'ca_session';
const ONE_YEAR = 365 * 24 * 3600;
const NAME_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

export class Sessions {
  constructor({ q, clock = Date, secure = false }) {
    this.q = q;
    this.clock = clock;
    this.secure = secure;
  }

  fromCookieHeader(header) {
    const token = parseCookies(header)[COOKIE_NAME];
    if (!token || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
    const row = this.q.guestByToken.get(hash(token));
    return row ? { id: row.id, name: row.display_name } : null;
  }

  create() {
    const token = crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    const suffix = Array.from({ length: 4 }, () => NAME_ALPHABET[crypto.randomInt(NAME_ALPHABET.length)]).join('');
    const name = `Guest ${suffix}`;
    const now = this.clock.now();
    this.q.insertGuest.run(id, hash(token), name, now, now);
    return { guest: { id, name }, token };
  }

  cookieFor(token, secureRequest) {
    const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${ONE_YEAR}`];
    if (this.secure || secureRequest) parts.push('Secure');
    return parts.join('; ');
  }

  // Express middleware: attach req.guest. Only GET /api/session may create a guest
  // (create: true); other routes answer 401 so parallel first-visit requests cannot
  // each mint a different guest and race on the cookie.
  middleware({ create = false } = {}) {
    return (req, res, next) => {
      let guest = this.fromCookieHeader(req.headers.cookie);
      if (!guest && !create) {
        res.status(401).json({ error: { code: 'no_session', message: 'No guest session yet. Reload the page.' } });
        return;
      }
      if (!guest) {
        const created = this.create();
        guest = created.guest;
        res.setHeader('Set-Cookie', this.cookieFor(created.token, req.secure));
      } else {
        this.q.touchGuest.run(this.clock.now(), guest.id);
      }
      req.guest = guest;
      next();
    };
  }

  rename(guestId, name) {
    this.q.renameGuest.run(name, guestId);
  }
}
