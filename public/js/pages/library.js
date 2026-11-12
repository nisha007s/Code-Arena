import { api } from '../api.js';
import { h, initHeader, watchJudge, difficultyBadge, tagList, errorMessage } from '../ui.js';

export function renderRecs(host, data) {
  if (!data.items.length) {
    host.replaceChildren(h('p', { class: 'muted' }, data.explanation || 'No suggestions right now.'));
    return;
  }
  host.replaceChildren(h('div', { class: 'recs' }, data.items.map((it) => h('div', { class: 'card rec-card' },
    h('a', { class: 'rec-title', href: `/practice.html?id=${encodeURIComponent(it.problem.id)}` }, `${it.problem.number}. ${it.problem.title}`),
    h('div', { class: 'row' }, difficultyBadge(it.problem.difficulty), tagList(it.problem.tags)),
    h('p', { class: 'rec-reason' }, it.reason)))));
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
  let problems = [];

  const params = new URLSearchParams(location.search);
  q.value = params.get('q') || '';
  diff.value = params.get('difficulty') || '';

  const render = () => {
    const text = q.value.trim().toLowerCase();
    const shown = problems.filter((p) =>
      (!diff.value || p.difficulty === diff.value) &&
      (!topic.value || p.tags.includes(topic.value)) &&
      (!text || p.title.toLowerCase().includes(text) || p.tags.some((t) => t.replace(/-/g, ' ').includes(text))));
    countEl.textContent = `Showing ${shown.length} of ${problems.length} problems`;
    if (!shown.length) {
      listEl.replaceChildren(h('div', { class: 'card empty' },
        h('p', {}, 'No problems match these filters.'),
        h('button', { class: 'btn', type: 'button', onclick: () => { form.reset(); render(); q.focus(); } }, 'Clear filters')));
      return;
    }
    listEl.replaceChildren(h('div', { class: 'card table-wrap' }, h('table', { class: 'problem-table' },
      h('caption', { class: 'visually-hidden' }, 'Problems'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, '#'), h('th', { scope: 'col' }, 'Title'), h('th', { scope: 'col' }, 'Difficulty'), h('th', { scope: 'col', class: 'col-tags' }, 'Topics'), h('th', { scope: 'col' }, 'Status'))),
      h('tbody', {}, shown.map((p) => h('tr', {},
        h('td', { class: 'muted' }, p.number),
        h('td', {}, h('a', { href: `/practice.html?id=${encodeURIComponent(p.id)}` }, p.title)),
        h('td', {}, difficultyBadge(p.difficulty)),
        h('td', { class: 'col-tags' }, tagList(p.tags)),
        h('td', {}, p.solved ? h('span', { class: 'status-solved' }, '✓ Solved') : p.attempted ? h('span', { class: 'status-attempted' }, 'Attempted') : h('span', { class: 'muted' }, 'Not started'))))))));
  };

  try {
    ({ problems } = await api('/api/problems'));
    const topics = [...new Set(problems.flatMap((p) => p.tags))].sort();
    topic.append(...topics.map((t) => h('option', { value: t }, t.replace(/-/g, ' '))));
    topic.value = params.get('topic') || '';
    render();
  } catch (e) {
    listEl.replaceChildren(h('div', { class: 'card empty', role: 'alert' }, errorMessage(e)));
  }
  for (const el of [q, diff, topic]) el.addEventListener('input', render);
  form.addEventListener('reset', () => setTimeout(render, 0));
  form.addEventListener('submit', (e) => e.preventDefault());

  try {
    const recs = await api('/api/recommendations');
    document.getElementById('recs-explain').textContent = recs.explanation || '';
    renderRecs(document.getElementById('recs'), recs);
  } catch (e) {
    document.getElementById('recs').replaceChildren(h('p', { class: 'muted' }, errorMessage(e)));
  }
}
