// End-to-end over real HTTP + Socket.IO (fake judge driver, temp database).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { io as ioClient } from 'socket.io-client';
import { createApp } from '../server/app.js';
import { testConfig, FakeDriver, until, bank } from './helpers.js';

let server, base, driver;
const dataDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ca-api-'));

before(async () => {
  driver = new FakeDriver();
  server = createApp(testConfig({ match: { durationMs: 4000, settleMs: 2000 } }), { driver, quiet: true, dbFile: path.join(dataDir, 'db.sqlite') });
  const addr = await server.start();
  base = `http://127.0.0.1:${addr.port}`;
});
after(async () => { await server.stop(); });

class Browser {
  constructor() { this.cookie = ''; }
  async call(p, { method = 'GET', body, origin = base, headers = {} } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) { this.cookie = set.split(';')[0]; this.setCookie = set; }
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  }
  socket() {
    return new Promise((resolve, reject) => {
      const s = ioClient(base, { transports: ['websocket'], extraHeaders: { cookie: this.cookie, origin: base }, forceNew: true });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }
}
const emit = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
let n = 0;
const rid = () => `req-${Date.now()}-${++n}`;
async function waitJob(b, id) {
  return until(async () => { const { body } = await b.call(`/api/submissions/${id}`); return body.job.status === 'done' && body.job; });
}

test('guest session cookie is random, HttpOnly and SameSite', async () => {
  const b = new Browser();
  const { body } = await b.call('/api/session');
  assert.match(b.setCookie, /HttpOnly/);
  assert.match(b.setCookie, /SameSite=Lax/);
  assert.match(b.cookie, /^ca_session=[A-Za-z0-9_-]{43}$/);
  assert.ok(body.guest.name.startsWith('Guest '));
  const again = await b.call('/api/session');
  assert.equal(again.body.guest.id, body.guest.id);
});

test('only GET /api/session creates a guest; parallel first requests cannot race the cookie', async () => {
  const b = new Browser();
  const [problems, health] = await Promise.all([b.call('/api/problems'), b.call('/api/judge/health')]);
  assert.equal(problems.status, 401);
  assert.equal(problems.body.error.code, 'no_session');
  assert.equal(health.status, 200);
  assert.equal(b.cookie, '', 'no cookie was issued by other routes');
  const s = await b.call('/api/session');
  assert.equal((await b.call('/api/session')).body.guest.id, s.body.guest.id);
});

test('health endpoints report app and judge separately', async () => {
  const b = new Browser();
  assert.equal((await b.call('/api/health')).body.ok, true);
  const j = await b.call('/api/judge/health');
  assert.equal(j.status, 200);
  assert.equal(j.body.ready, true);
});

test('browser mutations must be same-origin', async () => {
  const b = new Browser();
  await b.call('/api/session');
  assert.equal((await b.call('/api/rooms', { method: 'POST', body: {}, origin: 'http://evil.example' })).status, 403);
  const none = await b.call('/api/rooms', { method: 'POST', body: {}, origin: null });
  assert.equal(none.status, 403);
  assert.equal(none.body.error.code, 'bad_origin');
  await assert.rejects(new Promise((resolve, reject) => {
    const s = ioClient(base, { transports: ['websocket'], extraHeaders: { cookie: b.cookie, origin: 'http://evil.example' }, forceNew: true, reconnection: false });
    s.on('connect', () => { s.close(); resolve(); });
    s.on('connect_error', (e) => { s.close(); reject(e); });
  }));
});

test('validation: names, oversized source, bad JSON', async () => {
  const b = new Browser();
  await b.call('/api/session');
  assert.equal((await b.call('/api/session', { method: 'POST', body: { displayName: '<script>' } })).status, 400);
  assert.equal((await b.call('/api/session', { method: 'POST', body: { displayName: 'x'.repeat(30) } })).status, 400);
  assert.equal((await b.call('/api/session', { method: 'POST', body: { displayName: 'Ada L.' } })).body.guest.name, 'Ada L.');
  const big = await b.call('/api/submissions', { method: 'POST', body: { requestId: rid(), problemId: 'target-pair', language: 'python', mode: 'run', source: 'x'.repeat(70000) } });
  assert.equal(big.status, 400);
  assert.equal(big.body.error.code, 'too_large');
  const bad = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie: b.cookie }, body: '{nope' });
  assert.equal(bad.status, 400);
  const lang = await b.call('/api/submissions', { method: 'POST', body: { requestId: rid(), problemId: 'target-pair', language: 'ruby', mode: 'run', source: 'x' } });
  assert.equal(lang.body.error.code, 'invalid_language');
});

test('practice: run, submit, duplicate request, and privacy of hidden tests', async () => {
  const b = new Browser();
  await b.call('/api/session');
  const runRes = await b.call('/api/submissions', { method: 'POST', body: { requestId: rid(), problemId: 'target-pair', language: 'python', mode: 'run', source: '#correct target-pair' } });
  assert.equal(runRes.status, 202);
  const run = await waitJob(b, runRes.body.job.id);
  assert.equal(run.verdict, 'AC');
  assert.equal(run.result.cases.length, 2);
  assert.equal(run.result.hidden, null);

  const id = rid();
  const echo = { requestId: id, problemId: 'target-pair', language: 'python', mode: 'submit', source: '#echo' };
  const first = await b.call('/api/submissions', { method: 'POST', body: echo });
  const dup = await b.call('/api/submissions', { method: 'POST', body: echo });
  assert.equal(dup.body.job.id, first.body.job.id);
  const job = await waitJob(b, first.body.job.id);
  assert.equal(job.verdict, 'WA');
  // Echo fails on example 1, so craft one that passes examples and echoes hidden input.
  const passExamplesThenEcho = await b.call('/api/submissions', { method: 'POST', body: { ...echo, requestId: rid(), source: '#correct target-pair' } });
  const ok = await waitJob(b, passExamplesThenEcho.body.job.id);
  assert.equal(ok.verdict, 'AC');
  assert.deepEqual(ok.result.hidden, { passed: true });
  assert.ok(ok.result.cases.every((c) => c.visibility === 'public'));

  // Another guest cannot read this job.
  const other = new Browser();
  await other.call('/api/session');
  const peek = await other.call(`/api/submissions/${job.id}`);
  assert.equal(peek.status, 404);
  // Progress and history reflect the accepted submission.
  const session = await b.call('/api/session');
  assert.deepEqual(session.body.progress.solved, ['target-pair']);
  const hist = await b.call('/api/history');
  assert.equal(hist.body.submissions.length, 2, "history lists Submits only; the duplicate is one job");
  assert.ok(!JSON.stringify(hist.body).includes('#correct'), 'history does not resend source');
});

test('no hidden fixtures, references or private notes are reachable over HTTP', async () => {
  const b = new Browser();
  for (const p of ['/problem-bank/problems/01-target-pair/reference.js', '/problem-bank/problems/01-target-pair/tests/hidden-01.in', '/server/rooms.js', '/package.json', '/data/code-arena.sqlite']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
  }
  await b.call('/api/session');
  const detail = await b.call('/api/problems/target-pair');
  const text = JSON.stringify(detail.body);
  assert.ok(!text.includes('complexity'));
  assert.ok(!text.includes('hidden'));
  const hiddenInput = bank.readInput(bank.get('target-pair').tests.find((t) => t.visibility === 'hidden'));
  assert.ok(!text.includes(hiddenInput.trim()));
});

test('live match over sockets: invite, ready, start, earliest Accepted wins, rematch', async () => {
  const host = new Browser(), friend = new Browser(), third = new Browser();
  await host.call('/api/session'); await friend.call('/api/session'); await third.call('/api/session');
  const created = await host.call('/api/rooms', { method: 'POST', body: { difficulty: 'easy' } });
  assert.equal(created.status, 201);
  const code = created.body.room.code;
  assert.equal((await friend.call(`/api/rooms/${code}/join`, { method: 'POST', body: {} })).status, 200);
  const full = await third.call(`/api/rooms/${code}/join`, { method: 'POST', body: {} });
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'room_full');
  assert.equal((await third.call(`/api/rooms/${code}`)).status, 403);

  const sh = await host.socket(), sf = await friend.socket();
  // Host keeps two tabs open; closing one must not mark them offline.
  const sh2 = await host.socket();
  const updates = { host: [], friend: [] };
  sh.on('room:update', (s) => updates.host.push(s));
  sf.on('room:update', (s) => updates.friend.push(s));
  assert.equal((await emit(sh, 'room:subscribe', { code })).ok, true);
  assert.equal((await emit(sh2, 'room:subscribe', { code })).ok, true);
  assert.equal((await emit(sf, 'room:subscribe', { code })).ok, true);
  sh2.close();
  await new Promise((r) => setTimeout(r, 100));
  const snap = (await emit(sf, 'room:snapshot', { code })).snapshot;
  assert.equal(snap.players[0].connected, true, 'host still has one tab open');

  assert.equal((await emit(sh, 'room:start', { code, requestId: rid() })).error.code, 'not_ready');
  await emit(sh, 'room:ready', { code, ready: true, requestId: rid() });
  await emit(sf, 'room:ready', { code, ready: true, requestId: rid() });
  assert.equal((await emit(sf, 'room:start', { code, requestId: rid() })).error.code, 'not_host');
  const started = await emit(sh, 'room:start', { code, requestId: rid() });
  assert.equal(started.ok, true);

  const a = (await emit(sh, 'room:snapshot', { code })).snapshot;
  const b = (await emit(sf, 'room:snapshot', { code })).snapshot;
  assert.equal(a.phase, 'active');
  assert.equal(a.round.problem.id, b.round.problem.id);
  assert.equal(a.round.deadline, b.round.deadline);
  const problemId = a.round.problem.id;
  const roundId = a.round.id;

  // Host submits first (judged slowly), friend second (judged fast) in another language.
  const privateUpdates = [];
  sf.on('submission:update', (j) => privateUpdates.push(j));
  const hs = await host.call('/api/submissions', { method: 'POST', body: { requestId: rid(), mode: 'submit', roomCode: code, roundId, problemId, language: 'python', source: `#gate=host #correct ${problemId}` } });
  const fs1 = await friend.call('/api/submissions', { method: 'POST', body: { requestId: rid(), mode: 'submit', roomCode: code, roundId, problemId, language: 'javascript', source: `#gate=friend #correct ${problemId} FRIEND_SECRET` } });
  assert.equal(hs.status, 202); assert.equal(fs1.status, 202);
  const pending = await friend.call('/api/submissions', { method: 'POST', body: { requestId: rid(), mode: 'submit', roomCode: code, roundId, problemId, language: 'javascript', source: 'x' } });
  assert.equal(pending.body.error.code, 'pending_submission');
  driver.release('friend');
  await waitJob(friend, fs1.body.job.id);
  assert.ok(privateUpdates.some((j) => j.id === fs1.body.job.id && j.status === 'done'));
  driver.release('host');
  await waitJob(host, hs.body.job.id);
  const final = await until(async () => { const s = (await emit(sf, 'room:snapshot', { code })).snapshot; return s?.phase === "finished" && s; }, 3000, 250);
  assert.equal(final.result.outcome, 'win');
  assert.equal(final.result.winnerSeat, 0, 'the earlier-received host submission wins');
  // The host never received the friend's source or results.
  assert.ok(!JSON.stringify(updates.host).includes('FRIEND_SECRET'));
  const hostView = (await emit(sh, 'room:snapshot', { code })).snapshot;
  assert.ok(hostView.mySubmissions.every((j) => j.id !== fs1.body.job.id));
  assert.equal((await host.call(`/api/submissions/${fs1.body.job.id}`)).status, 404);

  // Submitting to a finished round is rejected; rematch resets readiness and rotates the problem.
  const late = await host.call('/api/submissions', { method: 'POST', body: { requestId: rid(), mode: 'submit', roomCode: code, roundId, problemId, language: 'python', source: 'x' } });
  assert.equal(late.status, 409);
  assert.equal((await emit(sh, 'room:rematch', { code, requestId: rid() })).ok, true);
  const lobby = (await emit(sf, 'room:snapshot', { code })).snapshot;
  assert.equal(lobby.phase, 'lobby');
  assert.ok(lobby.players.every((p) => !p.ready));
  await emit(sh, 'room:ready', { code, ready: true, requestId: rid() });
  await emit(sf, 'room:ready', { code, ready: true, requestId: rid() });
  await emit(sh, 'room:start', { code, requestId: rid() });
  const r2 = (await emit(sh, 'room:snapshot', { code })).snapshot;
  assert.notEqual(r2.round.problem.id, problemId);
  assert.ok(r2.revision > final.revision);

  // History shows the match for both players, from each one's point of view.
  const hh = (await host.call('/api/history')).body.matches[0];
  const fh = (await friend.call('/api/history')).body.matches[0];
  assert.equal(hh.outcome, 'won');
  assert.equal(fh.outcome, 'lost');

  // Disconnect / reconnect: the seat is reclaimed through the cookie.
  sf.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await emit(sh, 'room:snapshot', { code })).snapshot.players[1].connected, false);
  const sf2 = await friend.socket();
  const back = await emit(sf2, 'room:subscribe', { code });
  assert.equal(back.ok, true);
  assert.equal(back.snapshot.you.seat, 1);
  assert.equal(back.snapshot.round.id, r2.round.id);

  // The round then times out as a draw (4 s test duration).
  const drawn = await until(async () => { const s = (await emit(sh, 'room:snapshot', { code })).snapshot; return s?.phase === "finished" && s; }, 8000, 250);
  assert.equal(drawn.result.outcome, 'draw');
  sh.close(); sf2.close();
});
