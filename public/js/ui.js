// Shared UI helpers. All user-provided strings are inserted as text nodes.
import { api, getSession } from './api.js';

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

export function verdictEl(code, label) {
  return h('span', { class: `verdict v-${code || 'pending'}` }, label || VERDICTS[code] || code || 'Pending');
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
  const t = h('div', { class: `toast ${kind === 'error' ? 'toast-error' : ''}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  region.append(t);
  setTimeout(() => t.remove(), 5000);
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

/** Header: guest name + rename dialog, and the judge-status banner. */
export async function initHeader() {
  const chip = document.getElementById('guest-chip');
  try {
    const { guest } = await getSession();
    if (chip) renderChip(chip, guest);
  } catch (e) {
    if (chip) chip.textContent = 'Offline';
    toast(errorMessage(e), 'error');
  }
}

function renderChip(chip, guest) {
  chip.replaceChildren(
    h('span', {}, 'Playing as ', h('strong', { id: 'guest-name' }, guest.name)),
    h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => openRename(chip, guest) }, 'Change name'),
  );
}

function openRename(chip, guest) {
  const input = h('input', { type: 'text', id: 'rename-input', maxlength: 24, value: guest.name, autocomplete: 'nickname', required: true });
  const err = h('p', { class: 'field-error', id: 'rename-error', 'aria-live': 'polite' });
  input.setAttribute('aria-describedby', 'rename-error');
  const form = h('form', { method: 'dialog', class: 'stack' },
    h('h2', {}, 'Your display name'),
    h('p', { class: 'muted' }, 'Shown to your opponent. It is not a login: your browser keeps a private guest cookie.'),
    h('div', { class: 'field' }, h('label', { for: 'rename-input' }, 'Display name'), input, err),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel')),
  );
  const dlg = h('dialog', { 'aria-labelledby': 'rename-title' }, form);
  form.firstChild.id = 'rename-title';
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
      state = await fetch('/api/judge/health', { credentials: 'same-origin' }).then((r) => r.json());
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
