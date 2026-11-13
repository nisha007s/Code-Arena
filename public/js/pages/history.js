import { api } from '../api.js';
import { h, icon, initHeader, verdictEl, formatDateTime, errorMessage, LANGUAGE_NAMES } from '../ui.js';

initHeader();
const OUTCOME = { won: 'Won', lost: 'Lost', draw: 'Draw', void: 'Void' };
const OUTCOME_ICON = { won: 'trophy', lost: 'x', draw: 'minus', void: 'alert' };
const STATUS = { solved: 'Solved', not_solved: 'Not solved', unjudged: 'Not judged' };
const matchesEl = document.getElementById('matches');
const subsEl = document.getElementById('subs');

const problemLink = (id, title) => h('a', { href: `/practice.html?id=${encodeURIComponent(id)}` }, title);
const table = (caption, head, rows) => h('div', { class: 'card table-card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'history-table' },
  h('caption', { class: 'visually-hidden' }, caption),
  h('thead', {}, h('tr', {}, head.map(([t, cls]) => h('th', { scope: 'col', class: cls || null }, t)))),
  h('tbody', {}, rows))));
const empty = (iconName, text, href, label) => h('div', { class: 'card empty' }, h('span', { class: 'icon-tile' }, icon(iconName)), h('p', {}, text), h('a', { class: 'btn btn-primary', href }, label));

try {
  const { submissions, matches } = await api('/api/history');
  document.getElementById('matches-count').textContent = matches.length ? `${matches.length} finished` : '';
  document.getElementById('subs-count').textContent = submissions.length ? `${submissions.length} shown` : '';
  matchesEl.replaceChildren(matches.length
    ? table('Match results', [['Result'], ['Problem'], ['Opponent'], ['You', 'col-hide-sm'], ['Finished', 'col-hide-sm']], matches.map((m) => h('tr', {},
      h('td', {}, h('span', { class: `outcome outcome-${m.outcome}`, title: m.reason || '' }, icon(OUTCOME_ICON[m.outcome] || 'info', 'icon icon-sm'), OUTCOME[m.outcome] || m.outcome)),
      h('td', {}, problemLink(m.problemId, m.problemTitle), h('div', { class: 'faint' }, `Room ${m.roomCode} · round ${m.roundNumber}`)),
      h('td', {}, m.opponentName),
      h('td', { class: 'col-hide-sm' }, STATUS[m.myStatus] || '—'),
      h('td', { class: 'col-hide-sm nowrap muted' }, formatDateTime(m.finishedAt)))))
    : empty('arena', 'No matches yet. Challenge a friend to your first 1v1 round.', '/arena.html', 'Play a friend'));
  subsEl.replaceChildren(submissions.length
    ? table('Your submissions', [['Verdict'], ['Problem'], ['Language'], ['Mode', 'col-hide-sm'], ['Submitted', 'col-hide-sm']], submissions.map((s) => h('tr', {},
      h('td', {}, s.status === 'done' ? verdictEl(s.verdict, null, true) : h('span', { class: 'verdict v-pending verdict-pill' }, 'Judging')),
      h('td', {}, problemLink(s.problemId, s.problemTitle)),
      h('td', {}, h('span', { class: 'lang-pill' }, LANGUAGE_NAMES[s.language] || s.language)),
      h('td', { class: 'col-hide-sm' }, s.kind === 'battle' ? h('span', { class: 'badge badge-accent' }, icon('arena'), `Match ${s.roomCode}`) : h('span', { class: 'mode-pill' }, 'Practice')),
      h('td', { class: 'col-hide-sm nowrap muted' }, formatDateTime(s.receivedAt)))))
    : empty('code', 'No submissions yet. Pick a problem and press Submit.', '/problems.html', 'Browse problems'));
} catch (e) {
  matchesEl.replaceChildren(h('div', { class: 'card empty', role: 'alert' }, h('span', { class: 'icon-tile' }, icon('alert')), h('p', {}, errorMessage(e))));
  subsEl.replaceChildren();
}
