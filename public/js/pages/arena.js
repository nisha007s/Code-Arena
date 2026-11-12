// Arena: private room lobby, live match and results.
// The server is authoritative. The page renders the latest room snapshot,
// discards stale ones by revision, and computes the timer from the server deadline.
import { io } from '/socket.io/socket.io.esm.min.js';
import { api, getSession, requestId, ApiError } from '../api.js';
import { h, initHeader, watchJudge, announce, toast, copyText, errorMessage } from '../ui.js';
import { Workspace } from '../workspace.js';

initHeader();
const judgeState = watchJudge(document.getElementById('judge-banner'));
const $ = (id) => document.getElementById(id);
const startEl = $('arena-start'), roomEl = $('arena-room'), loadingEl = $('arena-loading');
const lobbyEl = $('lobby'), resultsEl = $('results'), headerEl = $('match-header'), wsHost = $('arena-workspace');
const connBanner = $('conn-banner');

const STATUS_TEXT = { ready: 'Ready', not_ready: 'Not ready', solving: 'Solving', judging: 'Judging', solved: 'Solved', finished: 'Done' };
let guest = null;
let code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
let snap = null;        // latest snapshot
let clockOffset = 0;    // serverTime − Date.now()
let workspace = null;   // created per round
let workspaceRound = null;
let socket = null;
let lastAnnounced = '';
let warnedMinute = false;

// ---------- start screen ----------

function showStart(message) {
  code = '';
  history.replaceState(null, '', '/arena.html');
  loadingEl.hidden = true;
  roomEl.hidden = true;
  startEl.hidden = false;
  if (message) $('join-error').textContent = message;
  api('/api/rooms/current').then(({ room }) => {
    const box = $('current-room');
    box.replaceChildren(room ? h('div', { class: 'card row mt-4', role: 'status' },
      h('span', {}, `You are still in room `, h('strong', {}, room.code), '.'),
      h('a', { class: 'btn btn-primary', href: `/arena.html?room=${room.code}` }, 'Return to room')) : '');
  }).catch(() => {});
}

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('create-error').textContent = '';
  try {
    const { room } = await api('/api/rooms', { method: 'POST', body: { difficulty: $('room-difficulty').value } });
    enterRoom(room.code);
  } catch (err) {
    $('create-error').textContent = errorMessage(err);
  }
});

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('join-code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(value)) {
    $('join-error').textContent = 'Enter the six-character room code.';
    $('join-code').focus();
    return;
  }
  enterRoom(value);
});

async function enterRoom(roomCode) {
  try {
    const { room } = await api(`/api/rooms/${roomCode}/join`, { method: 'POST', body: {} });
    if (snap && snap.code !== room.code) { workspace?.destroy(); workspace = null; workspaceRound = null; snap = null; }
    code = room.code;
    history.replaceState(null, '', `/arena.html?room=${code}`);
    startEl.hidden = true;
    loadingEl.hidden = true;
    roomEl.hidden = false;
    apply(room, true);
    connect();
  } catch (err) {
    const msg = err instanceof ApiError && err.code === 'room_full' ? 'That room already has two players.'
      : err instanceof ApiError && err.code === 'room_not_found' ? 'No room with that code. Check the code or ask your friend for a new invite.'
        : errorMessage(err);
    showStart(msg);
    $('join-code').value = roomCode;
  }
}

// ---------- realtime ----------

function subscribe() {
  if (!code) return;
  socket.emit('room:subscribe', { code }, (res) => {
    if (res?.ok) apply(res.snapshot, true);
    else if (res?.error?.code === 'room_not_found' || res?.error?.code === 'not_member') showStart(res.error.message);
  });
}

function connect() {
  if (socket) { if (socket.connected) subscribe(); return; }
  socket = io({ transports: ['websocket', 'polling'] });
  socket.on('connect', () => { connBanner.hidden = true; subscribe(); });
  socket.on('disconnect', () => { connBanner.hidden = false; renderHeader(); });
  socket.on('connect_error', () => { connBanner.hidden = false; });
  socket.on('room:update', (s) => { if (s.code === code) apply(s, false); });
  socket.on('room:closed', ({ code: c, message }) => {
    if (c !== code) return;
    toast(message || 'The room was closed.');
    announce(message || 'The room was closed.');
    workspace?.destroy();
    workspace = null;
    showStart(message);
  });
  socket.on('submission:update', (job) => workspace?.updateJob(job));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket.connected) {
      socket.emit('room:snapshot', { code }, (res) => res?.ok && apply(res.snapshot, true));
    }
  });
}

function command(event, payload = {}) {
  return new Promise((resolve) => {
    if (!socket?.connected) { toast('Not connected yet. Try again in a moment.', 'error'); resolve(null); return; }
    socket.timeout(8000).emit(event, { code, requestId: requestId(), ...payload }, (err, res) => {
      if (err) { toast('The server did not answer. Check your connection.', 'error'); resolve(null); return; }
      if (!res.ok) { toast(res.error.message, 'error'); announce(res.error.message); }
      resolve(res);
    });
  });
}

// ---------- rendering ----------

function apply(s, force) {
  if (!force && snap && s.revision <= snap.revision && s.round?.id === snap.round?.id) return; // stale
  const prev = snap;
  snap = s;
  clockOffset = s.serverTime - Date.now();
  renderHeader();
  if (s.phase === 'lobby') renderLobby();
  else lobbyEl.hidden = true;
  if (s.phase === 'active' || s.phase === 'judging' || s.phase === 'finished') renderRound();
  else { resultsEl.hidden = true; wsHost.hidden = true; }
  announceChanges(prev, s);
}

function me() { return snap.players.find((p) => p && p.isYou); }
function opponent() { return snap.players.find((p) => p && !p.isYou); }

function announceChanges(prev, s) {
  let msg = '';
  const opp = s.players.find((p) => p && !p.isYou);
  const prevOpp = prev?.players.find((p) => p && !p.isYou);
  if (prev && prev.phase !== s.phase) {
    if (s.phase === 'active') msg = `Round ${s.round.number} started: ${s.round.problem.title}. Ten minutes on the clock.`;
    if (s.phase === 'judging') msg = 'Time is up. Waiting for the last submissions to be judged.';
    if (s.phase === 'finished') msg = resultHeadline(s.result);
    if (s.phase === 'lobby') msg = 'Back in the lobby for a rematch. Click Ready when you are set.';
  } else if (opp && prevOpp) {
    if (!prevOpp.connected && opp.connected) msg = `${opp.name} reconnected.`;
    else if (prevOpp.connected && !opp.connected) msg = `${opp.name} disconnected.`;
    else if (opp.status !== prevOpp.status && s.phase !== 'lobby') msg = `${opp.name}: ${STATUS_TEXT[opp.status]}.`;
    else if (opp.ready !== prevOpp.ready && s.phase === 'lobby') msg = `${opp.name} is ${opp.ready ? 'ready' : 'not ready'}.`;
  } else if (opp && !prevOpp && prev) {
    msg = `${opp.name} joined the room.`;
  }
  if (msg && msg !== lastAnnounced) { lastAnnounced = msg; announce(msg); }
}

function playerChip(p) {
  if (!p) return h('div', { class: 'player muted' }, 'Waiting for opponent…');
  const online = p.connected || (p.isYou && socket?.connected);
  return h('div', { class: 'player' },
    h('span', { class: 'player-name' }, p.name, p.isYou ? ' (you)' : ''),
    h('span', { class: `conn ${online ? 'conn-on' : 'conn-off'}` }, online ? 'Online' : 'Offline'),
    h('span', { class: `pstatus pstatus-${p.status}` }, STATUS_TEXT[p.status] || p.status));
}

const timerEl = h('span', { class: 'timer', role: 'timer', 'aria-label': 'Time remaining' }, '10:00');
function renderHeader() {
  if (!snap) return;
  const [a, b] = snap.players;
  const parts = [playerChip(a), h('span', { class: 'vs', 'aria-hidden': 'true' }, 'vs'), playerChip(b), h('span', { class: 'header-spacer' })];
  if (snap.round && snap.phase !== 'lobby') parts.push(h('span', { class: 'muted' }, `Round ${snap.round.number}`), timerEl);
  parts.push(h('span', { class: 'muted' }, 'Room ', h('strong', {}, snap.code)));
  headerEl.replaceChildren(...parts);
  tick();
}

function tick() {
  if (!snap?.round || snap.phase === 'lobby') return;
  const now = Date.now() + clockOffset;
  const left = snap.phase === 'active' ? Math.max(0, snap.round.deadline - now) : 0;
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  timerEl.textContent = snap.phase === 'finished' ? 'Finished' : snap.phase === 'judging' ? 'Judging…' : `${m}:${String(s).padStart(2, '0')}`;
  timerEl.classList.toggle('timer-low', snap.phase === 'active' && left < 60000);
  if (snap.phase === 'active' && left < 60000 && left > 0 && !warnedMinute) { warnedMinute = true; announce('One minute left.'); }
  if (snap.phase === 'active' && left === 0) workspace?.setSubmitLock('Time is up.');
}
setInterval(tick, 250);

function renderLobby() {
  lobbyEl.hidden = false;
  resultsEl.hidden = true;
  wsHost.hidden = true;
  warnedMinute = false;
  const inviteUrl = location.origin + snap.invitePath;
  const urlInput = h('input', { type: 'text', id: 'invite-url', readonly: true, value: inviteUrl, 'aria-label': 'Invite link', onfocus: (e) => e.target.select() });
  const copyBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    const ok = await copyText(inviteUrl, urlInput);
    if (ok) { toast('Invite link copied.'); announce('Invite link copied.'); }
    else { urlInput.focus(); urlInput.select(); toast('Copying is blocked here. The link is selected: press Ctrl+C (⌘+C) to copy it.', 'error'); }
  } }, 'Copy invite link');
  const you = me(), opp = opponent();
  const bothReady = snap.players.every((p) => p && p.ready && p.connected);
  let startHint = '';
  if (!opp) startHint = 'Waiting for your friend to join.';
  else if (!opp.connected) startHint = `${opp.name} is offline.`;
  else if (!bothReady) startHint = 'Both players must be ready.';

  lobbyEl.replaceChildren(
    h('section', { class: 'card stack', 'aria-labelledby': 'invite-title' },
      h('h2', { id: 'invite-title' }, 'Invite a friend'),
      h('p', { class: 'muted' }, 'Send this link, or tell your friend the room code. On a LAN, the link uses the address you opened this page with.'),
      h('div', { class: 'invite-row' }, urlInput, copyBtn),
      h('div', {}, h('span', { class: 'muted' }, 'Room code '), h('span', { class: 'room-code', 'aria-label': `Room code ${snap.code.split('').join(' ')}` }, snap.code)),
      h('p', { class: 'muted' }, `Problem pool: ${snap.difficulty === 'mixed' ? 'mixed difficulty' : snap.difficulty}. Rounds last 10 minutes.`)),
    h('section', { class: 'card stack', 'aria-labelledby': 'players-title' },
      h('h2', { id: 'players-title' }, 'Players'),
      h('ul', { class: 'seat-list' }, snap.players.map((p, i) => p
        ? h('li', { class: 'seat' }, h('strong', {}, p.name, p.isYou ? ' (you)' : ''), p.isHost ? h('span', { class: 'badge' }, 'Host') : null,
          h('span', { class: `conn ${p.connected ? 'conn-on' : 'conn-off'}` }, p.connected ? 'Online' : 'Offline'),
          h('span', { class: `pstatus pstatus-${p.ready ? 'ready' : 'not_ready'}` }, p.ready ? '✓ Ready' : 'Not ready'))
        : h('li', { class: 'seat seat-empty' }, i === 1 ? 'Empty seat — waiting for your friend' : 'Empty seat'))),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-large', type: 'button', 'aria-pressed': String(Boolean(you?.ready)), onclick: () => command('room:ready', { ready: !you.ready }) }, you?.ready ? '✓ Ready' : 'Ready'),
        snap.you.isHost
          ? h('button', { class: 'btn btn-primary btn-large', type: 'button', disabled: !bothReady || null, 'aria-describedby': 'start-hint', onclick: () => command('room:start') }, 'Start match')
          : h('span', { class: 'muted' }, bothReady ? 'Waiting for the host to start.' : ''),
        h('span', { class: 'muted', id: 'start-hint' }, snap.you.isHost ? startHint : ''),
        h('span', { class: 'header-spacer' }),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: leaveRoom }, snap.you.isHost ? 'Close room' : 'Leave room'))),
  );
}

async function leaveRoom() {
  if (!window.confirm(snap.you.isHost ? 'Close this room for both players?' : 'Leave this room?')) return;
  const res = await command('room:leave');
  if (res?.ok) { workspace?.destroy(); workspace = null; showStart(); }
}

function resultHeadline(r) {
  if (!r) return '';
  if (r.outcome === 'void') return 'Round void — no winner.';
  if (r.outcome === 'draw') return 'Draw — nobody solved it in time.';
  const mine = snap.players.find((p) => p && p.isYou);
  return mine && r.winnerSeat === mine.seat ? 'You won!' : `${r.winnerName} won.`;
}

function renderRound() {
  const round = snap.round;
  wsHost.hidden = false;
  if (!workspace || workspaceRound !== round.id) {
    workspace?.destroy();
    workspaceRound = round.id;
    workspace = new Workspace(wsHost, {
      problem: round.problem, guestId: guest.id, scope: `round:${round.id}`, judgeState,
      submit: async ({ language, source, requestId: rid }) => (await api('/api/submissions', {
        method: 'POST',
        body: { requestId: rid, mode: 'submit', roomCode: code, roundId: round.id, problemId: round.problem.id, language, source },
      })).job,
    });
    // Restore the latest own submission after a refresh / reconnect.
    const last = snap.mySubmissions[snap.mySubmissions.length - 1];
    if (last) { workspace.activeJobId = last.id; workspace.updateJob(last); }
  }
  const mine = me();
  let lock = null;
  if (snap.phase === 'finished') lock = 'The round is over.';
  else if (snap.phase === 'judging') lock = 'Time is up.';
  else if (mine?.status === 'solved') lock = 'Solved! Submissions are locked for this round.';
  else if (mine?.status === 'judging') lock = 'Your submission is being judged.';
  workspace.setSubmitLock(lock);
  const pending = snap.mySubmissions.find((j) => j.status !== 'done');
  if (pending && workspace.activeJobId !== pending.id) { workspace.activeJobId = pending.id; workspace.updateJob(pending); }

  if (snap.phase === 'finished' && snap.result) renderResults();
  else resultsEl.hidden = true;
}

function renderResults() {
  const r = snap.result;
  const statusText = { solved: 'Solved', not_solved: 'Did not solve', unjudged: 'Not judged (judge failure)' };
  const opp = opponent();
  resultsEl.hidden = false;
  resultsEl.replaceChildren(h('section', { class: 'card stack', 'aria-labelledby': 'result-title' },
    h('h2', { id: 'result-title', tabindex: '-1' }, resultHeadline(r)),
    h('p', { class: 'muted' }, r.reason),
    r.problem ? h('p', {}, 'Problem: ', h('a', { href: `/practice.html?id=${encodeURIComponent(r.problem.id)}` }, r.problem.title), ` (${r.problem.difficulty}) · Round ${r.roundNumber}`) : null,
    h('ul', { class: 'result-list' }, r.players.map((p) => h('li', {},
      h('strong', {}, p.name), ` — ${statusText[p.status] || p.status}`, p.seat === r.winnerSeat ? ' 🏆' : '', h('span', { class: 'muted' }, ` · ${p.submissions} submission${p.submissions === 1 ? '' : 's'}`)))),
    h('div', { class: 'row' },
      snap.you.isHost
        ? h('button', { class: 'btn btn-primary', type: 'button', disabled: !opp || null, onclick: () => command('room:rematch') }, 'Rematch (new problem)')
        : h('span', { class: 'muted' }, 'Waiting for the host to start a rematch.'),
      !opp ? h('span', { class: 'muted' }, 'Your opponent left the room.') : null,
      h('a', { class: 'btn', href: '/problems.html' }, 'Return to library'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: leaveRoom }, snap.you.isHost ? 'Close room' : 'Leave room')),
    h('p', { class: 'muted' }, 'Your code from the round stays below. Opponents never see each other’s code.')));
}

// ---------- boot ----------
try {
  ({ guest } = await getSession());
  if (code) await enterRoom(code);
  else showStart();
} catch (e) {
  loadingEl.textContent = errorMessage(e);
}
