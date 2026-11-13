// Arena: private room lobby, live match and results.
// The server is authoritative. The page renders the latest room snapshot,
// discards stale ones by revision, and computes the timer from the server deadline.
import { io } from '/socket.io/socket.io.esm.min.js';
import { api, getSession, requestId, ApiError } from '../api.js';
import { h, icon, avatar, initHeader, watchJudge, announce, toast, copyText, errorMessage, difficultyBadge, setWidth } from '../ui.js';
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
    box.replaceChildren(room ? h('div', { class: 'notice', role: 'status' },
      icon('info'), h('span', {}, 'You are still in room ', h('strong', { class: 'mono' }, room.code), '.'), h('span', { class: 'spacer' }),
      h('a', { class: 'btn btn-primary btn-small', href: `/arena.html?room=${room.code}` }, 'Return to room', icon('arrowRight'))) : '');
    if (room) box.classList.add('mt-2');
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

const isOnline = (p) => p.connected || (p.isYou && socket?.connected);
const connEl = (p) => h('span', { class: `conn ${isOnline(p) ? 'conn-on' : 'conn-off'}` }, isOnline(p) ? 'Online' : 'Offline');

// Scoreboard: player — clock — player
function playerChip(p, side) {
  if (!p) return h('div', { class: `player-empty ${side === 'right' ? 'player-right' : ''}` }, h('span', { class: 'avatar' }, '?'), 'Waiting for opponent…');
  return h('div', { class: `player ${side === 'right' ? 'player-right' : ''}` },
    avatar(p.name),
    h('div', { class: 'player-info' },
      h('span', { class: 'player-name' }, p.name, p.isYou ? h('span', { class: 'you' }, '(you)') : null),
      h('span', { class: 'player-meta' }, connEl(p), h('span', { class: `pstatus pstatus-${p.status}` }, STATUS_TEXT[p.status] || p.status))));
}

const timerEl = h('span', { class: 'timer', role: 'timer', 'aria-label': 'Time remaining' }, '10:00');
const trackFill = h('span');
const trackEl = h('div', { class: 'time-track', 'aria-hidden': 'true' }, trackFill);
function renderHeader() {
  if (!snap) return;
  const [a, b] = snap.players;
  const inRound = snap.round && snap.phase !== 'lobby';
  const center = h('div', { class: 'match-center' },
    h('div', { class: 'match-meta' }, inRound ? `Round ${snap.round.number}` : 'Lobby', h('span', { 'aria-hidden': 'true' }, '·'), 'Room ', h('strong', {}, snap.code)),
    inRound ? timerEl : h('span', { class: 'vs-mark' }, 'VS'),
    inRound ? trackEl : null,
    inRound && snap.round.problem ? h('span', { class: 'match-problem' }, snap.round.problem.title) : null);
  headerEl.replaceChildren(playerChip(a, 'left'), center, playerChip(b, 'right'));
  tick();
}

function tick() {
  if (!snap?.round || snap.phase === 'lobby') return;
  const now = Date.now() + clockOffset;
  const left = snap.phase === 'active' ? Math.max(0, snap.round.deadline - now) : 0;
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  timerEl.textContent = snap.phase === 'finished' ? 'Finished' : snap.phase === 'judging' ? 'Judging…' : `${m}:${String(s).padStart(2, '0')}`;
  const low = snap.phase === 'active' && left < 60000;
  timerEl.classList.toggle('timer-low', low);
  trackEl.classList.toggle('low', low);
  setWidth(trackFill, snap.phase === 'active' ? (left / snap.round.durationMs) * 100 : 0);
  if (snap.phase === 'active' && left < 60000 && left > 0 && !warnedMinute) { warnedMinute = true; announce('One minute left.'); }
  if (snap.phase === 'active' && left === 0) workspace?.setSubmitLock('Time is up.');
}
setInterval(tick, 250);

// Lobby: versus stage + invite + rules
function fighter(p, i) {
  if (!p) {
    return h('li', { class: 'fighter seat seat-empty empty' },
      h('span', { class: 'avatar' }, '?'),
      h('div', { class: 'fighter-name' }, i === 1 ? 'Empty seat' : 'Open seat'),
      h('div', { class: 'fighter-role' }, i === 1 ? 'Waiting for your friend to join' : 'Waiting for a player'));
  }
  return h('li', { class: `fighter seat${p.ready ? ' is-ready' : ''}` },
    avatar(p.name),
    h('div', { class: 'fighter-name' }, p.name, p.isYou ? h('span', { class: 'faint' }, '(you)') : null),
    h('div', { class: 'fighter-role' }, p.isHost ? 'Host' : 'Challenger'),
    h('div', { class: 'fighter-state' },
      connEl(p),
      h('span', { class: `pstatus pstatus-${p.ready ? 'ready' : 'not_ready'}` }, p.ready ? '✓ Ready' : 'Not ready')));
}

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
  } }, icon('copy'), 'Copy invite link');
  const you = me(), opp = opponent();
  const bothReady = snap.players.every((p) => p && p.ready && p.connected);
  let startHint = '';
  if (!opp) startHint = 'Waiting for your friend to join.';
  else if (!opp.connected) startHint = `${opp.name} is offline.`;
  else if (!bothReady) startHint = 'Both players must be ready.';
  const statusText = !opp ? 'Waiting for opponent' : bothReady ? (snap.you.isHost ? 'Both ready — start when you are' : 'Both ready — waiting for the host') : 'Waiting for both players to be ready';
  const pool = snap.difficulty === 'mixed' ? 'Mixed difficulty' : snap.difficulty[0].toUpperCase() + snap.difficulty.slice(1);

  lobbyEl.replaceChildren(
    h('div', { class: 'stage-head' },
      h('div', {}, h('span', { class: 'eyebrow' }, icon('arena', 'icon icon-sm'), 'Private room'), h('h1', {}, '1v1 ', h('span', { class: 'accent' }, 'Arena')), h('p', {}, 'Real-time competitive coding. Same problem, same clock.')),
      h('span', { class: 'badge badge-accent' }, icon('lock'), `Room ${snap.code}`)),
    h('section', { 'aria-labelledby': 'players-title' },
      h('h2', { id: 'players-title', class: 'visually-hidden' }, 'Players'),
      h('ul', { class: 'versus seat-list' },
        fighter(snap.players[0], 0),
        h('li', { class: 'vs-big', 'aria-hidden': 'true' }, 'VS'),
        fighter(snap.players[1], 1)),
      h('div', { class: 'countdown' },
        h('div', { class: 'label' }, 'Match status'),
        h('div', { class: 'value' }, statusText),
        h('div', { class: 'lobby-actions' },
          h('button', { class: 'btn btn-large', type: 'button', 'aria-pressed': String(Boolean(you?.ready)), onclick: () => command('room:ready', { ready: !you.ready }) }, you?.ready ? '✓ Ready' : 'Ready'),
          snap.you.isHost
            ? h('button', { class: 'btn btn-primary btn-large', type: 'button', disabled: !bothReady || null, 'aria-describedby': 'start-hint', onclick: () => command('room:start') }, icon('zap'), 'Start match')
            : null),
        h('p', { class: 'lobby-hint', id: 'start-hint' }, snap.you.isHost ? startHint : (bothReady ? 'The host starts the 10-minute round.' : '')))),
    h('div', { class: 'lobby-panels' },
      h('section', { class: 'card', 'aria-labelledby': 'invite-title' },
        h('div', { class: 'card-title' }, h('span', { class: 'icon-tile' }, icon('link')), h('h2', { id: 'invite-title' }, 'Invite a friend')),
        h('p', { class: 'muted' }, 'Send the link or read out the code. On a LAN the link uses the address you opened this page with.'),
        h('div', { class: 'room-code', 'aria-label': `Room code ${snap.code.split('').join(' ')}` }, snap.code.split('').map((ch) => h('span', { class: 'code-char', 'aria-hidden': 'true' }, ch))),
        h('div', { class: 'invite-row' }, urlInput, copyBtn)),
      h('section', { class: 'card', 'aria-labelledby': 'rules-title' },
        h('div', { class: 'card-title' }, h('span', { class: 'icon-tile' }, icon('flag')), h('h2', { id: 'rules-title' }, 'Match rules')),
        h('ul', { class: 'rules-list' },
          h('li', {}, icon('layers'), h('span', {}, `Problem pool: ${pool}. Both players get the same problem.`)),
          h('li', {}, icon('timer'), h('span', {}, '10-minute round. The clock keeps running if someone disconnects.')),
          h('li', {}, icon('trophy'), h('span', {}, 'The earliest received submission that passes every hidden test wins.')),
          h('li', {}, icon('lock'), h('span', {}, 'Your opponent sees only your status, never your code.'))),
        h('div', { class: 'lobby-foot' }, h('button', { class: 'btn btn-danger-ghost', type: 'button', onclick: leaveRoom }, icon('door'), snap.you.isHost ? 'Close room' : 'Leave room')))),
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
      problem: round.problem, guestId: guest.id, scope: `round:${round.id}`, judgeState, context: 'arena',
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
  const mine = me();
  const kind = r.outcome === 'win' ? (mine && r.winnerSeat === mine.seat ? 'win' : 'loss') : r.outcome;
  const iconName = { win: 'trophy', loss: 'flag', draw: 'minus', void: 'alert' }[kind];
  resultsEl.hidden = false;
  resultsEl.replaceChildren(h('section', { class: `card result-card ${kind}`, 'aria-labelledby': 'result-title' },
    h('div', { class: 'result-icon' }, icon(iconName)),
    h('h2', { id: 'result-title', tabindex: '-1' }, resultHeadline(r)),
    h('p', { class: 'reason' }, r.reason),
    r.problem ? h('div', { class: 'result-problem' }, icon('target', 'icon icon-sm'), h('a', { href: `/practice.html?id=${encodeURIComponent(r.problem.id)}` }, r.problem.title), difficultyBadge(r.problem.difficulty), h('span', {}, `Round ${r.roundNumber}`)) : null,
    h('ul', { class: 'result-players result-list' }, r.players.map((p) => h('li', { class: `result-player${p.seat === r.winnerSeat ? ' winner' : ''}` },
      avatar(p.name),
      h('div', { class: 'info' },
        h('span', { class: 'name' }, p.name, p.seat === r.winnerSeat ? icon('trophy') : null),
        h('span', { class: 'sub' }, `${statusText[p.status] || p.status} · ${p.submissions} submission${p.submissions === 1 ? '' : 's'}`))))),
    h('div', { class: 'result-actions' },
      snap.you.isHost
        ? h('button', { class: 'btn btn-primary btn-large', type: 'button', disabled: !opp || null, onclick: () => command('room:rematch') }, icon('refresh'), 'Rematch (new problem)')
        : h('span', { class: 'muted' }, 'Waiting for the host to start a rematch.'),
      h('a', { class: 'btn btn-large', href: '/problems.html' }, icon('problems'), 'Return to library'),
      h('button', { class: 'btn btn-ghost btn-large', type: 'button', onclick: leaveRoom }, snap.you.isHost ? 'Close room' : 'Leave room')),
    !opp ? h('p', { class: 'result-note' }, 'Your opponent left the room.') : null,
    h('p', { class: 'result-note' }, 'Your code from the round stays below. Opponents never see each other’s code.')));
}

// ---------- boot ----------
try {
  ({ guest } = await getSession());
  if (code) await enterRoom(code);
  else showStart();
} catch (e) {
  loadingEl.textContent = errorMessage(e);
}
