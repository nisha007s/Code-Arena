// Local drafts, keyed by guest + scope (practice or a match round) + problem + language.
// A missing draft returns null (so the starter is shown); an empty string is a
// real, preserved blank draft. Several tabs share drafts through localStorage.
const PREFIX = 'code-arena.v1';

const key = (guestId, scope, problemId, language) => `${PREFIX}|draft|${guestId}|${scope}|${problemId}|${language}`;
const langKey = (guestId, scope, problemId) => `${PREFIX}|lang|${guestId}|${scope}|${problemId}`;

function read(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function write(k, v) {
  try { localStorage.setItem(k, v); return true; } catch { return false; }
}

export const drafts = {
  key,
  load: (g, s, p, l) => read(key(g, s, p, l)),
  save: (g, s, p, l, value) => write(key(g, s, p, l), value),
  remove: (g, s, p, l) => { try { localStorage.removeItem(key(g, s, p, l)); } catch { /* ignore */ } },
  lastLanguage: (g, s, p) => read(langKey(g, s, p)),
  setLastLanguage: (g, s, p, l) => write(langKey(g, s, p), l),
};
