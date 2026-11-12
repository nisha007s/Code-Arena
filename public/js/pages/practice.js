import { api, getSession } from '../api.js';
import { h, initHeader, watchJudge, errorMessage } from '../ui.js';
import { Workspace } from '../workspace.js';

initHeader();
const judgeState = watchJudge(document.getElementById('judge-banner'));
const host = document.getElementById('workspace');
const id = new URLSearchParams(location.search).get('id');

try {
  if (!id) throw new Error('No problem selected.');
  const [{ guest }, { problem }] = await Promise.all([getSession(), api(`/api/problems/${encodeURIComponent(id)}`)]);
  document.title = `${problem.title} · Code Arena`;
  new Workspace(host, { problem, guestId: guest.id, scope: 'practice', judgeState });
} catch (e) {
  host.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'card empty', role: 'alert' },
    h('p', {}, errorMessage(e)), h('a', { class: 'btn', href: '/problems.html' }, 'Back to the problem library'))));
}
