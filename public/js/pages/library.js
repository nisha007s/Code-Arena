import { api } from '../api.js';
import { h, icon, initHeader, watchJudge, difficultyBadge, tagList, errorMessage, meter } from '../ui.js';

const practiceUrl = (id) => `/practice.html?id=${encodeURIComponent(id)}`;

export function renderRecs(host, data) {
  if (!data.items.length) {
    host.replaceChildren(h('div', { class: 'card empty' }, h('span', { class: 'icon-tile' }, icon('trophy')), h('p', {}, data.explanation || 'No suggestions right now.')));
    return;
  }
  host.replaceChildren(h('div', { class: 'recs' }, data.items.map((it) => h('div', { class: 'card card-hover rec-card' },
    h('div', { class: 'rec-top' }, h('span', { class: 'rec-num' }, `#${String(it.problem.number).padStart(3, '0')}`), difficultyBadge(it.problem.difficulty)),
    h('a', { class: 'rec-title', href: practiceUrl(it.problem.id) }, it.problem.title),
    tagList(it.problem.tags),
    h('p', { class: 'rec-reason' }, icon('compass'), h('span', {}, it.reason)),
    h('span', { class: 'rec-cta', 'aria-hidden': 'true' }, 'Solve now', icon('arrowRight', 'icon icon-sm'))))));
  // Whole card is clickable; the title link stays the keyboard/screen-reader target.
  host.querySelectorAll('.rec-card').forEach((card) => card.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    card.querySelector('a.rec-title').click();
  }));
}

const isLibraryPage = location.pathname.startsWith('/problems');
if (isLibraryPage) {
  initHeader();
  watchJudge(document.getElementById('judge-banner'));
  const listEl = document.getElementById('list');
  const countEl = document.getElementById('count');
  const q = document.getElementById('q');
  const diff = document.getElementById('difficulty');
  const topic = document.getElementById('topic');
  const form = document.getElementById('filters');
  const seg = document.getElementById('diff-seg');
  let problems = [];
  let recommended = new Set();

  // Segmented difficulty pills drive the (visually hidden) select, which stays the source of truth.
  const segButtons = [['', 'All'], ['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']].map(([value, label]) =>
    h('button', { type: 'button', 'data-value': value, 'aria-pressed': 'false', onclick: () => { diff.value = value; render(); } }, label));
  seg.replaceChildren(...segButtons);
  const syncSeg = () => segButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === diff.value)));

  const params = new URLSearchParams(location.search);
  q.value = params.get('q') || '';
  diff.value = params.get('difficulty') || '';

  const statusCell = (p) => p.solved
    ? h('span', { class: 'status-dot solved', title: 'Solved' }, icon('check'))
    : h('span', { class: `status-dot${p.attempted ? ' attempted' : ''}`, title: p.attempted ? 'Attempted' : 'Not started' });

  const render = () => {
    syncSeg();
    const text = q.value.trim().toLowerCase();
    const shown = problems.filter((p) =>
      (!diff.value || p.difficulty === diff.value) &&
      (!topic.value || p.tags.includes(topic.value)) &&
      (!text || p.title.toLowerCase().includes(text) || p.tags.some((t) => t.replace(/-/g, ' ').includes(text))));
    countEl.textContent = `Showing ${shown.length} of ${problems.length} problems`;
    if (!shown.length) {
      listEl.replaceChildren(h('div', { class: 'card empty' },
        h('span', { class: 'icon-tile' }, icon('search')),
        h('p', {}, 'No problems match these filters.'),
        h('button', { class: 'btn', type: 'button', onclick: () => { form.reset(); setTimeout(() => { render(); q.focus(); }, 0); } }, icon('refresh'), 'Clear filters')));
      return;
    }
    const tbody = h('tbody', {}, shown.map((p) => h('tr', { 'data-href': practiceUrl(p.id) },
      h('td', { class: 'col-status' }, statusCell(p)),
      h('td', { class: 'col-num' }, String(p.number).padStart(3, '0')),
      h('td', {}, h('div', { class: 'title-cell' },
        h('a', { class: 'title-link', href: practiceUrl(p.id) }, p.title),
        recommended.has(p.id) ? h('span', { class: 'rec-flag' }, icon('compass'), 'Recommended') : null)),
      h('td', { class: 'col-tags' }, tagList(p.tags)),
      h('td', {}, difficultyBadge(p.difficulty)),
      h('td', { class: 'col-diff-text' }, p.solved ? h('span', { class: 'status-solved' }, 'Solved') : p.attempted ? h('span', { class: 'status-attempted' }, 'Attempted') : h('span', { class: 'status-new' }, 'Not started')))));
    tbody.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const row = e.target.closest('tr[data-href]');
      if (row) location.href = row.dataset.href;
    });
    listEl.replaceChildren(h('div', { class: 'card table-card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'problem-table' },
      h('caption', { class: 'visually-hidden' }, 'Problems'),
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', class: 'col-status' }, h('span', { class: 'visually-hidden' }, 'Solved')),
        h('th', { scope: 'col', class: 'col-num' }, '#'),
        h('th', { scope: 'col' }, 'Problem'),
        h('th', { scope: 'col', class: 'col-tags' }, 'Topics'),
        h('th', { scope: 'col' }, 'Difficulty'),
        h('th', { scope: 'col', class: 'col-diff-text' }, 'Status'))),
      tbody))));
  };

  const renderSummary = () => {
    const box = document.getElementById('diff-summary');
    box.replaceChildren(...['easy', 'medium', 'hard'].map((d) => {
      const all = problems.filter((p) => p.difficulty === d);
      const solved = all.filter((p) => p.solved).length;
      return h('div', { class: `diff-chip ${d}` },
        h('div', { class: 'row' }, h('span', { class: `diff-${d}`, text: d[0].toUpperCase() + d.slice(1) }), h('span', { class: 'muted' }, `${solved}/${all.length}`)),
        meter(all.length ? (solved / all.length) * 100 : 0, `${d}: ${solved} of ${all.length} solved`));
    }));
  };

  // Load problems and recommendations together so the "Recommended" flags appear with the list.
  const [problemsRes, recsRes] = await Promise.allSettled([api('/api/problems'), api('/api/recommendations')]);
  if (recsRes.status === 'fulfilled') {
    const recs = recsRes.value;
    recommended = new Set(recs.items.map((it) => it.problem.id));
    document.getElementById('recs-explain').textContent = recs.explanation || '';
    renderRecs(document.getElementById('recs'), recs);
  } else {
    document.getElementById('recs').replaceChildren(h('p', { class: 'muted' }, errorMessage(recsRes.reason)));
  }
  if (problemsRes.status === 'fulfilled') {
    problems = problemsRes.value.problems;
    const topics = [...new Set(problems.flatMap((p) => p.tags))].sort();
    topic.append(...topics.map((t) => h('option', { value: t }, t.replace(/-/g, ' '))));
    topic.value = params.get('topic') || '';
    renderSummary();
    render();
  } else {
    listEl.replaceChildren(h('div', { class: 'card empty', role: 'alert' }, h('span', { class: 'icon-tile' }, icon('alert')), h('p', {}, errorMessage(problemsRes.reason))));
  }
  for (const el of [q, diff, topic]) el.addEventListener('input', render);
  diff.addEventListener('change', render);
  form.addEventListener('reset', () => setTimeout(render, 0));
  form.addEventListener('submit', (e) => e.preventDefault());
}
