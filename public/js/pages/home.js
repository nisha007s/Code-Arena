import { api } from '../api.js';
import { h, initHeader, watchJudge, errorMessage, loadStats, statCards } from '../ui.js';
import { renderRecs } from './library.js';

initHeader();
watchJudge(document.getElementById('judge-banner'));

// Real statistics only: everything comes from this guest's own submissions and matches.
const statsEl = document.getElementById('stats');
try {
  statsEl.replaceChildren(...statCards(await loadStats()));
} catch (e) {
  statsEl.replaceChildren(h('p', { class: 'muted' }, errorMessage(e)));
}

try {
  const recs = await api('/api/recommendations');
  document.getElementById('recs-explain').textContent = recs.explanation || '';
  renderRecs(document.getElementById('recs'), recs);
} catch (e) {
  document.getElementById('recs').replaceChildren(h('p', { class: 'muted' }, errorMessage(e)));
}
