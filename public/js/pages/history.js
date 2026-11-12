import { api } from '../api.js';
import { h, initHeader, verdictEl, formatDateTime, errorMessage } from '../ui.js';

initHeader();
const LANG = { python: 'Python 3', javascript: 'JavaScript', java: 'Java 21', cpp: 'C++17', csharp: 'C#' };
const OUTCOME = { won: 'Won', lost: 'Lost', draw: 'Draw', void: 'Void' };
const STATUS = { solved: 'Solved', not_solved: 'Not solved', unjudged: 'Not judged' };
const matchesEl = document.getElementById('matches');
const subsEl = document.getElementById('subs');

const problemLink = (id, title) => h('a', { href: `/practice.html?id=${encodeURIComponent(id)}` }, title);
const table = (caption, head, rows) => h('div', { class: 'card table-wrap' }, h('table', { class: 'history-table' },
  h('caption', { class: 'visually-hidden' }, caption),
  h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col' }, t)))),
  h('tbody', {}, rows)));

try {
  const { submissions, matches } = await api('/api/history');
  matchesEl.replaceChildren(matches.length
    ? table('Match results', ['Finished', 'Problem', 'Opponent', 'Result', 'You'], matches.map((m) => h('tr', {},
      h('td', {}, formatDateTime(m.finishedAt)),
      h('td', {}, problemLink(m.problemId, m.problemTitle)),
      h('td', {}, m.opponentName),
      h('td', {}, h('span', { class: `outcome-${m.outcome}`, title: m.reason || '' }, OUTCOME[m.outcome] || m.outcome)),
      h('td', {}, STATUS[m.myStatus] || '—'))))
    : h('div', { class: 'card empty' }, h('p', {}, 'No matches yet.'), h('a', { class: 'btn', href: '/arena.html' }, 'Play a friend')));
  subsEl.replaceChildren(submissions.length
    ? table('Your submissions', ['Submitted', 'Problem', 'Language', 'Mode', 'Verdict'], submissions.map((s) => h('tr', {},
      h('td', {}, formatDateTime(s.receivedAt)),
      h('td', {}, problemLink(s.problemId, s.problemTitle)),
      h('td', {}, LANG[s.language] || s.language),
      h('td', {}, s.kind === 'battle' ? `Match ${s.roomCode}` : 'Practice'),
      h('td', {}, s.status === 'done' ? verdictEl(s.verdict) : h('span', { class: 'verdict v-pending' }, 'Judging')))))
    : h('div', { class: 'card empty' }, h('p', {}, 'No submissions yet.'), h('a', { class: 'btn', href: '/problems.html' }, 'Browse problems')));
} catch (e) {
  matchesEl.replaceChildren(h('p', { role: 'alert' }, errorMessage(e)));
  subsEl.replaceChildren();
}
