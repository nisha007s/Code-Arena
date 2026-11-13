// Progress: summaries calculated from this guest's real submissions, matches and solved problems.
import { api } from '../api.js';
import { h, icon, initHeader, errorMessage, loadStats, statCards, verdictEl, setWidth, meter, VERDICTS, LANGUAGE_NAMES } from '../ui.js';

initHeader();
const $ = (id) => document.getElementById(id);
const VERDICT_ORDER = ['AC', 'WA', 'TLE', 'RE', 'CE', 'OLE', 'MLE', 'JU'];
const none = (text) => h('p', { class: 'muted' }, text);

try {
  const [stats, { problems }] = await Promise.all([loadStats(), api('/api/problems')]);
  $('stats').replaceChildren(...statCards(stats));

  // Verdict distribution (Submits only)
  const done = stats.history.submissions.filter((s) => s.status === 'done');
  const counts = VERDICT_ORDER.map((v) => [v, done.filter((s) => s.verdict === v).length]).filter(([, n]) => n > 0);
  $('verdicts').replaceChildren(...(done.length ? [
    h('div', { class: 'stack-bar', role: 'img', 'aria-label': counts.map(([v, n]) => `${VERDICTS[v]} ${n}`).join(', ') },
      counts.map(([v, n]) => setWidth(h('span', { class: `v-${v}`, title: `${VERDICTS[v]}: ${n}` }), (n / done.length) * 100))),
    h('div', { class: 'legend' }, counts.map(([v, n]) => h('span', {}, verdictEl(v), h('span', { class: 'count' }, n)))),
    h('p', { class: 'muted mt-4' }, `${done.length} judged submission${done.length === 1 ? '' : 's'}.`),
  ] : [none('No submissions yet. Your verdict breakdown will appear here.')]));

  // Solved by difficulty
  $('difficulty').replaceChildren(h('div', { class: 'diff-bars' }, ['easy', 'medium', 'hard'].map((d) => {
    const all = problems.filter((p) => p.difficulty === d);
    const solved = all.filter((p) => p.solved).length;
    return h('div', { class: `diff-bar-row ${d}` }, h('span', { class: `badge diff-${d}` }, d[0].toUpperCase() + d.slice(1)),
      meter(all.length ? (solved / all.length) * 100 : 0, `${d}: ${solved} of ${all.length}`), h('span', { class: 'num' }, `${solved}/${all.length}`));
  })));

  // Languages used
  const byLang = Object.entries(done.reduce((acc, s) => ({ ...acc, [s.language]: (acc[s.language] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
  const maxLang = Math.max(1, ...byLang.map(([, n]) => n));
  $('langs').replaceChildren(byLang.length
    ? h('div', { class: 'bar-list' }, byLang.map(([lang, n]) => h('div', { class: 'bar-row' }, h('span', {}, LANGUAGE_NAMES[lang] || lang), meter((n / maxLang) * 100, `${lang}: ${n}`), h('span', { class: 'num' }, n))))
    : none('No submissions yet.'));

  // Solved problems
  const solved = problems.filter((p) => p.solved);
  $('solved').replaceChildren(solved.length
    ? h('div', { class: 'solved-list' }, solved.map((p) => h('a', { class: 'solved-chip', href: `/practice.html?id=${encodeURIComponent(p.id)}` }, icon('check'), p.title)))
    : h('div', {}, none('Nothing solved yet.'), h('a', { class: 'btn btn-primary mt-2', href: '/problems.html' }, 'Browse problems', icon('arrowRight'))));
} catch (e) {
  $('stats').replaceChildren(h('div', { class: 'card empty', role: 'alert' }, h('span', { class: 'icon-tile' }, icon('alert')), h('p', {}, errorMessage(e))));
}
