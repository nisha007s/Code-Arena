// Shared UI helpers. All user-provided strings are inserted as text nodes.
import { api, getSession, judgeHealth } from './api.js';
import { icon } from './icons.js';

export { icon };

/** h('div', { class: 'x', onclick: fn }, 'text', child) — builds elements safely. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Text with `inline code` spans, rendered without innerHTML. */
export function richText(str) {
  const frag = document.createDocumentFragment();
  String(str).split(/(`[^`]+`)/).forEach((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) frag.append(h('code', {}, part.slice(1, -1)));
    else if (part) frag.append(document.createTextNode(part));
  });
  return frag;
}

export const VERDICTS = {
  AC: 'Accepted', WA: 'Wrong Answer', CE: 'Compile/Syntax Error', RE: 'Runtime Error',
  TLE: 'Time Limit Exceeded', OLE: 'Output Limit Exceeded', MLE: 'Memory Limit Exceeded',
  JU: 'Judge Unavailable', OK: 'Finished',
};

export const LANGUAGE_NAMES = { python: 'Python 3', javascript: 'JavaScript', java: 'Java 21', cpp: 'C++17', csharp: 'C#' };

export function verdictEl(code, label, pill = false) {
  return h('span', { class: `verdict v-${code || 'pending'}${pill ? ' verdict-pill' : ''}` }, label || VERDICTS[code] || code || 'Pending');
}

export function difficultyBadge(d) {
  return h('span', { class: `badge diff-${d}` }, d[0].toUpperCase() + d.slice(1));
}

export function tagList(tags) {
  return h('span', { class: 'tags' }, tags.map((t) => h('span', { class: 'tag' }, t.replace(/-/g, ' '))));
}

export function formatDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Initials avatar with a stable hue derived from the name. */
export function avatar(name = '?', cls = 'avatar') {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const el = h('span', { class: cls, 'aria-hidden': 'true' }, initials);
  el.style.setProperty('--hue', String(hash % 360)); // CSSOM property: allowed by the CSP
  return el;
}

// Polite live region shared by the page (verdicts, lobby changes). Not used for timer ticks.
export function announce(message) {
  const region = document.getElementById('live-region');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = message; }, 50);
}

export function toast(message, kind = 'info') {
  let region = document.querySelector('.toast-region');
  if (!region) { region = h('div', { class: 'toast-region' }); document.body.append(region); }
  const t = h('div', { class: `toast ${kind === 'error' ? 'toast-error' : ''}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'alert' : 'check'), h('span', {}, message));
  region.append(t);
  setTimeout(() => { t.classList.add('toast-leave'); setTimeout(() => t.remove(), 220); }, 4800);
}

/** Copy text; falls back to execCommand for plain-HTTP LAN pages. Returns true on success. */
export async function copyText(text, fallbackInput) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    if (fallbackInput) {
      fallbackInput.focus();
      fallbackInput.select();
      return document.execCommand('copy');
    }
  } catch { /* ignore */ }
  return false;
}

export function errorMessage(e) {
  return e?.message || 'Something went wrong.';
}

export function setWidth(el, pct) {
  el.style.width = `${Math.max(0, Math.min(100, pct))}%`; // CSSOM property (allowed by the CSP)
  return el;
}

export function meter(pct, label) {
  return h('div', { class: 'meter', role: 'img', 'aria-label': label }, setWidth(h('span'), pct));
}

// ---------- theme ----------
const THEME_KEY = 'code-arena.theme';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyTheme(theme, animate) {
  const root = document.documentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate && !reduce) {
    root.classList.add('theme-transition');
    setTimeout(() => root.classList.remove('theme-transition'), 380);
  }
  root.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.setAttribute('aria-checked', String(theme === 'dark'));
    btn.setAttribute('aria-label', theme === 'dark' ? 'Dark theme (switch to light)' : 'Light theme (switch to dark)');
    btn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  }
}

export function initTheme() {
  applyTheme(currentTheme(), false);
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked: still switch for this page */ }
    applyTheme(next, true);
  });
  // Follow the OS setting until the user picks a theme.
  window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', (e) => {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
    if (!saved) applyTheme(e.matches ? 'light' : 'dark', true);
  });
}

// ---------- header ----------
/** Header: theme switch, progress pill and guest chip (with rename dialog). */
export async function initHeader() {
  initTheme();
  const chip = document.getElementById('guest-chip');
  try {
    const { guest, progress } = await getSession();
    if (chip) renderChip(chip, guest);
    renderProgressPill(progress);
  } catch (e) {
    if (chip) chip.replaceChildren(h('span', { class: 'muted' }, 'Offline'));
    toast(errorMessage(e), 'error');
  }
}

function renderProgressPill(progress) {
  const pill = document.getElementById('progress-pill');
  if (!pill || !progress) return;
  document.getElementById('progress-count').textContent = `${progress.solvedCount}/${progress.total}`;
  document.getElementById('progress-ring').style.setProperty('--p', String(Math.round((progress.solvedCount / progress.total) * 100)));
  pill.setAttribute('aria-label', `Progress: ${progress.solvedCount} of ${progress.total} problems solved`);
  pill.hidden = false;
}

function renderChip(chip, guest) {
  chip.replaceChildren(h('button', {
    class: 'user-btn', type: 'button', title: 'Change your display name',
    'aria-label': `Playing as ${guest.name}. Change name`, onclick: () => openRename(chip, guest),
  }, avatar(guest.name), h('span', { class: 'name', id: 'guest-name' }, guest.name), icon('pencil')));
}

function openRename(chip, guest) {
  const input = h('input', { type: 'text', id: 'rename-input', maxlength: 24, value: guest.name, autocomplete: 'nickname', required: true });
  const err = h('p', { class: 'field-error', id: 'rename-error', 'aria-live': 'polite' });
  input.setAttribute('aria-describedby', 'rename-error');
  const form = h('form', { method: 'dialog', class: 'stack' },
    h('h2', { id: 'rename-title' }, 'Your display name'),
    h('p', { class: 'muted' }, 'Shown to your opponent. It is not a login: your browser keeps a private guest cookie.'),
    h('div', { class: 'field' }, h('label', { for: 'rename-input' }, 'Display name'), input, err),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), 'Save'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel')),
  );
  const dlg = h('dialog', { 'aria-labelledby': 'rename-title' }, form);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const { guest: updated } = await api('/api/session', { method: 'POST', body: { displayName: input.value } });
      guest.name = updated.name;
      await getSession(true);
      renderChip(chip, updated);
      dlg.close();
      toast('Name updated.');
    } catch (e) {
      err.textContent = errorMessage(e);
      input.focus();
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  input.select();
}

/** Shows a banner when the judge is unavailable; re-checks every 10 s. Returns a getter for readiness. */
export function watchJudge(bannerEl) {
  let state = { ready: true };
  const check = async () => {
    try {
      state = await judgeHealth();
    } catch {
      state = { ready: false, message: 'Cannot reach the server.' };
    }
    if (!bannerEl) return;
    if (!state.ready) {
      bannerEl.className = 'banner banner-error';
      bannerEl.replaceChildren(h('strong', {}, 'Judge unavailable. '), state.message || 'Code cannot be run right now.', ' Your code is saved; try again when the judge recovers.');
      bannerEl.hidden = false;
    } else if (state.unsandboxed) {
      bannerEl.className = 'banner banner-warn';
      bannerEl.replaceChildren(h('strong', {}, 'Test judge: '), 'code runs without a sandbox on this computer. Use the Docker judge for real matches.');
      bannerEl.hidden = false;
    } else {
      bannerEl.hidden = true;
    }
  };
  check();
  setInterval(check, 10000);
  return () => state;
}

/** Real statistics for this guest, computed from /api/session and /api/history. */
export async function loadStats() {
  const [{ progress }, history] = await Promise.all([getSession(), api('/api/history')]);
  const subs = history.submissions.filter((s) => s.status === 'done');
  const accepted = subs.filter((s) => s.verdict === 'AC').length;
  const m = history.matches;
  const count = (o) => m.filter((x) => x.outcome === o).length;
  return {
    progress,
    history,
    submissions: subs.length,
    accepted,
    acceptance: subs.length ? Math.round((accepted / subs.length) * 100) : null,
    matches: m.length,
    won: count('won'), lost: count('lost'), draw: count('draw'), void: count('void'),
    languages: [...new Set(subs.map((s) => s.language))],
  };
}

export function statCard({ iconName, label, value, unit, sub, pct }) {
  return h('div', { class: 'card stat-card' },
    h('div', { class: 'stat-label' }, icon(iconName), label),
    h('div', { class: 'stat-value' }, value, unit ? h('small', {}, unit) : null),
    pct !== undefined && pct !== null ? meter(pct, `${label}: ${pct}%`) : null,
    h('div', { class: 'stat-sub' }, sub));
}

export function statCards(s) {
  const p = s.progress;
  return [
    statCard({ iconName: 'check', label: 'Problems solved', value: String(p.solvedCount), unit: `/ ${p.total}`, pct: Math.round((p.solvedCount / p.total) * 100), sub: p.attemptedCount ? `${p.attemptedCount} attempted` : 'Nothing attempted yet' }),
    statCard({ iconName: 'target', label: 'Success rate', value: s.acceptance === null ? '—' : String(s.acceptance), unit: s.acceptance === null ? '' : '%', sub: s.submissions ? `${s.accepted} accepted of ${s.submissions} submissions` : 'No submissions yet' }),
    statCard({ iconName: 'arena', label: 'Matches played', value: String(s.matches), sub: s.matches ? `${s.won} won · ${s.lost} lost · ${s.draw} draw${s.void ? ` · ${s.void} void` : ''}` : 'No matches yet' }),
    statCard({ iconName: 'code', label: 'Languages used', value: String(s.languages.length), unit: '/ 5', sub: s.languages.length ? s.languages.map((l) => LANGUAGE_NAMES[l] || l).join(', ') : 'Try any of five languages' }),
  ];
}
