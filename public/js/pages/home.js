import { api, getSession } from '../api.js';
import { h, initHeader, watchJudge, errorMessage } from '../ui.js';
import { renderRecs } from './library.js';

initHeader();
watchJudge(document.getElementById('judge-banner'));

const progressEl = document.getElementById('progress');
try {
  const { progress } = await getSession();
  const pct = Math.round((progress.solvedCount / progress.total) * 100);
  const fill = h('span');
  fill.style.width = `${pct}%`; // CSSOM property (allowed by the CSP, unlike style attributes)
  progressEl.replaceChildren(
    h('p', {}, h('span', { class: 'stat' }, `${progress.solvedCount}`), h('span', { class: 'muted' }, ` / ${progress.total} problems solved`)),
    h('div', { class: 'progress-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': progress.total, 'aria-valuenow': progress.solvedCount, 'aria-label': 'Problems solved' }, fill),
    h('p', { class: 'muted mt-4' }, progress.attemptedCount ? `You have attempted ${progress.attemptedCount} problem${progress.attemptedCount === 1 ? '' : 's'}.` : 'No submissions yet. Pick a problem to get started.'),
    h('a', { href: '/history.html' }, 'View your history'),
  );
} catch (e) {
  progressEl.replaceChildren(h('p', { class: 'muted' }, errorMessage(e)));
}

try {
  renderRecs(document.getElementById('recs'), await api('/api/recommendations'));
} catch (e) {
  document.getElementById('recs').replaceChildren(h('p', { class: 'muted' }, errorMessage(e)));
}
