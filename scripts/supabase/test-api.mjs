// Acceptance tests for the Supabase backend: auth, RLS/authorization, Realtime RLS, judge
// (browser path), battles, timers, the void rule, disconnects, lobby grace, history/progress.
//
//   SUPABASE_SERVICE_ROLE_KEY=... [CA_SESSIONS=sessions.json] node scripts/supabase/test-api.mjs
// The service key is only used for the test-only clock helpers and to probe service functions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../../public/js/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const URL_ = CONFIG.supabaseUrl, ANON = CONFIG.supabaseAnonKey;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE) { console.error('Set SUPABASE_SERVICE_ROLE_KEY (never commit it).'); process.exit(2); }
const SESSIONS = process.env.CA_SESSIONS;
const sessions = SESSIONS && fs.existsSync(SESSIONS) ? JSON.parse(fs.readFileSync(SESSIONS, 'utf8')) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, passes = 0;
const check = (ok, what, info = '') => { console.log(`  ${ok ? '✓' : '✗'}  ${what}${info ? '  — ' + info : ''}`); ok ? passes++ : failures++; return ok; };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const ref = (id, lang) => {
  const dir = fs.readdirSync(path.join(root, 'problem-bank', 'problems')).find((d) => d.endsWith(id) && JSON.parse(fs.readFileSync(path.join(root, 'problem-bank', 'problems', d, 'problem.json'), 'utf8')).id === id);
  const p = path.join(root, 'problem-bank', 'problems', dir);
  return lang === 'python' ? fs.readFileSync(path.join(p, 'reference.py'), 'utf8')
    : fs.readFileSync(path.join(p, 'reference.js'), 'utf8').replace('export function solve', 'function solve') + "\nprocess.stdout.write(solve(require('fs').readFileSync(0, 'utf8')));\n";
};
const rid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

async function http(method, url, { token, key = ANON, body, headers = {} } = {}) {
  const res = await fetch(url, { method, headers: { apikey: key, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const rpc = (token, name, args = {}) => http('POST', `${URL_}/rest/v1/rpc/${name}`, { token, body: args });
const service = (name, args = {}) => http('POST', `${URL_}/rest/v1/rpc/${name}`, { key: SERVICE, token: SERVICE, body: args });

async function user(name) {
  if (sessions[name]) {
    const r = await http('POST', `${URL_}/auth/v1/token?grant_type=refresh_token`, { body: { refresh_token: sessions[name] } });
    if (r.status === 200) { sessions[name] = r.data.refresh_token; return { name, token: r.data.access_token, id: r.data.user.id }; }
  }
  const r = await http('POST', `${URL_}/auth/v1/signup`, { body: {} });
  if (r.status !== 200) throw new Error(`anonymous sign-in failed for ${name}: ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  sessions[name] = r.data.refresh_token;
  return { name, token: r.data.access_token, id: r.data.user.id, fresh: true, anonymous: r.data.user.is_anonymous };
}
const judge = (u, body) => http('POST', `${URL_}/functions/v1/judge`, { token: u?.token, body });
async function waitJob(u, id, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await http('GET', `${URL_}/rest/v1/submissions?id=eq.${id}&select=status,verdict,result,user_id`, { token: u.token });
    if (r.data?.[0]?.status === 'done') return r.data[0];
    await sleep(700);
  }
  return null;
}
async function submit(u, body) {
  const r = await judge(u, { requestId: rid(), ...body, sourceB64: b64(body.source), source: undefined, ...(body.customInput != null ? { customInputB64: b64(body.customInput), customInput: undefined } : {}) });
  if (r.status !== 202 && r.status !== 200) return { http: r.status, error: r.data?.error };
  return { http: r.status, job: r.data.job, done: await waitJob(u, r.data.job.id) };
}
const snap = async (u, code, heartbeat = true) => (await rpc(u.token, 'ca_room_snapshot', { room_code: code, heartbeat })).data?.snapshot;

// Realtime: does this user receive UPDATE notifications for a room? (phoenix channel protocol)
function listenRoom(u, code) {
  const events = [];
  const ws = new WebSocket(`${URL_.replace('https', 'wss')}/realtime/v1/websocket?apikey=${ANON}&vsn=1.0.0`);
  const ready = new Promise((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ topic: `realtime:test-${code}-${u.name}`, event: 'phx_join', ref: '1', payload: { config: { postgres_changes: [{ event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${code}` }] }, access_token: u.token } }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.event === 'postgres_changes') events.push(msg.payload?.data?.record?.revision);
      // Change delivery is live once Realtime reports the Postgres subscription.
      if (msg.event === 'system' && msg.payload?.status === 'ok' && /postgres/i.test(msg.payload?.extension || msg.payload?.message || '')) resolve(true);
      if (msg.event === 'system' && msg.payload?.status === 'error') resolve(false);
    };
    setTimeout(() => resolve(false), 20000);
  });
  const hb = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'hb' })); }, 20000);
  return { events, ready, close: () => { clearInterval(hb); ws.close(); } };
}

try {
  console.log('Auth');
  const A = await user('alice'), B = await user('bob'), C = await user('carol');
  check(Boolean(A.token && B.token && C.token) && A.id !== B.id, 'three anonymous guests signed in with distinct ids', A.fresh ? `is_anonymous=${A.anonymous}` : 'sessions reused');
  const s1 = await rpc(A.token, 'ca_session'), s2 = await rpc(A.token, 'ca_session');
  check(s1.status === 200 && /^Guest-[A-Z0-9]{4}$|.+/.test(s1.data.guest.name) && s1.data.guest.id === s2.data.guest.id, 'ca_session creates one stable profile', s1.data?.guest?.name);
  await rpc(B.token, 'ca_session'); await rpc(C.token, 'ca_session');
  check((await rpc(null, 'ca_session')).status >= 400, 'ca_session without a token is refused');
  check((await rpc(A.token, 'ca_rename', { display_name: '' })).data?.hint === 'invalid_name', 'empty display name rejected');
  check((await rpc(A.token, 'ca_rename', { display_name: 'x'.repeat(25) })).data?.hint === 'invalid_name', '25-character display name rejected');
  const ren = await rpc(A.token, 'ca_rename', { display_name: '  Alice   Tester ' });
  check(ren.data?.guest?.name === 'Alice Tester', 'display name trimmed and saved', ren.data?.guest?.name);

  console.log('Row-level security and authorization');
  const pj = await submit(A, { mode: 'submit', language: 'python', problemId: 'target-pair', source: ref('target-pair', 'python') });
  check(pj.done?.verdict === 'AC', 'A: practice submission through the browser path is Accepted', `verdict ${pj.done?.verdict}`);
  check(pj.done && JSON.stringify(pj.done.result).length < 4000 && pj.done.result.hidden?.passed === true && !('input' in (pj.done.result.cases.find((c) => c.visibility === 'hidden') || {})), 'stored result keeps only pass/fail for hidden tests');
  const bRead = await http('GET', `${URL_}/rest/v1/submissions?id=eq.${pj.job.id}&select=id,source`, { token: B.token });
  check(Array.isArray(bRead.data) && bRead.data.length === 0, "B cannot read A's submission (or its source)");
  const bAll = await http('GET', `${URL_}/rest/v1/submissions?select=user_id`, { token: B.token });
  check(Array.isArray(bAll.data) && bAll.data.every((r) => r.user_id === B.id), 'B sees only their own submissions');
  const ins = await http('POST', `${URL_}/rest/v1/submissions`, { token: A.token, body: { user_id: A.id, request_id: rid(), mode: 'submit', kind: 'practice', problem_id: 'target-pair', language: 'python', source: 'x', status: 'done', verdict: 'AC' } });
  check(ins.status >= 400, 'A cannot insert a fake Accepted submission directly', `HTTP ${ins.status}`);
  const upd = await http('PATCH', `${URL_}/rest/v1/submissions?id=eq.${pj.job.id}`, { token: A.token, body: { verdict: 'WA' } });
  check(upd.status >= 400 || (Array.isArray(upd.data) && upd.data.length === 0), 'A cannot modify a submission directly', `HTTP ${upd.status}`);
  const prof = await http('GET', `${URL_}/rest/v1/profiles?select=id`, { token: A.token });
  check(Array.isArray(prof.data) && prof.data.length === 1 && prof.data[0].id === A.id, 'profiles: a guest sees only their own row');
  for (const t of ['room_seats', 'rounds', 'round_players', 'runner_lanes', 'usage_monthly', 'room_actions']) {
    const r = await http('GET', `${URL_}/rest/v1/${t}?select=*`, { token: A.token });
    check(r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0), `${t} is not readable by guests`, `HTTP ${r.status}`);
  }
  for (const [fn, args] of [['ca_submission_create', { uid: A.id, request_id: rid(), mode: 'submit', problem_id: 'target-pair', language: 'python', source_b64: b64('x') }],
    ['ca_submission_finish_b64', { submission_id: pj.job.id, verdict: 'AC', result_b64: b64('{}'), calls: 0 }], ['ca_lane_acquire', { lane_kind: 'js', holder: A.id, battle: true }],
    ['ca_maintenance', {}], ['ca_test_age_round', { round_id: A.id, seconds: 1 }], ['ca_finalize_round', { round_id: A.id, reason_key: 'x' }]]) {
    const r = await rpc(A.token, fn, args);
    check(r.status >= 400, `guest cannot call ${fn}`, `HTTP ${r.status}`);
  }

  console.log('Judge (browser path)');
  check((await judge(null, { requestId: rid(), mode: 'run', language: 'python', problemId: 'target-pair', sourceB64: b64('print(1)') })).status === 401, 'judge without a session -> 401');
  check((await judge({ token: 'not-a-token' }, { requestId: rid(), mode: 'run', language: 'python', problemId: 'target-pair', sourceB64: b64('print(1)') })).status === 401, 'judge with a forged token -> 401');
  check((await judge(A, { requestId: rid(), mode: 'run', language: 'python', problemId: 'target-pair', sourceB64: b64('#'.repeat(70000)) })).status === 413, 'source over 64 KB -> 413');
  check((await judge(A, { requestId: rid(), mode: 'run', language: 'java', problemId: 'target-pair', sourceB64: b64('x') })).status === 400, 'unsupported language rejected');
  const dupId = rid();
  const d1 = await judge(A, { requestId: dupId, mode: 'run', language: 'javascript', problemId: 'bracket-check', sourceB64: b64('while(true){}') });
  const d2 = await judge(A, { requestId: dupId, mode: 'run', language: 'javascript', problemId: 'bracket-check', sourceB64: b64('while(true){}') });
  check(d1.status === 202 && d2.status === 200 && d2.data.duplicate && d2.data.job.id === d1.data.job.id, 'a retried request id returns the original job');
  const pend = await judge(A, { requestId: rid(), mode: 'run', language: 'python', problemId: 'target-pair', sourceB64: b64('print(1)') });
  check(pend.status === 409 && pend.data?.error?.code === 'pending_submission', 'a second run while one is judging -> 409 pending_submission');
  const tle = await waitJob(A, d1.data.job.id);
  check(tle?.verdict === 'TLE', 'JavaScript infinite loop -> Time Limit Exceeded', tle?.verdict);
  const payload = "/etc/passwd <script>alert(1)</script> ' UNION SELECT * FROM users -- ../../ ${jndi:ldap://x}";
  const fw = await submit(B, { mode: 'submit', language: 'javascript', problemId: 'target-pair', source: `// ${payload}\n` + ref('target-pair', 'javascript') });
  check(fw.done?.verdict === 'AC', 'firewall: code containing attack-like text is judged normally (Accepted)', `HTTP ${fw.http} ${fw.done?.verdict || JSON.stringify(fw.error)}`);
  const ci = await submit(C, { mode: 'run', language: 'python', problemId: 'target-pair', source: 'print(input())', customInput: payload });
  check(ci.done?.result?.cases?.[0]?.stdout?.includes('/etc/passwd'), 'firewall: custom input with attack-like text round-trips');
  const mem = await submit(C, { mode: 'submit', language: 'python', problemId: 'bracket-check', source: 'a=[]\nwhile True: a.append(bytearray(10**7))' });
  check(mem.done?.verdict === 'MLE', 'Python memory bomb -> Memory Limit Exceeded', mem.done?.verdict);

  console.log('Rooms and authorization');
  for (const u of [A, B, C]) { const cur = (await rpc(u.token, 'ca_room_current')).data?.room; if (cur && cur.phase !== 'active' && cur.phase !== 'judging') await rpc(u.token, 'ca_room_leave', { room_code: cur.code }); }
  const created = await rpc(A.token, 'ca_room_create', { difficulty: 'easy' });
  const code = created.data?.room?.code;
  check(/^[A-HJ-NP-Z2-9]{6}$/.test(code || ''), 'A creates a room', code);
  const outsiderRow = await http('GET', `${URL_}/rest/v1/rooms?code=eq.${code}&select=code`, { token: B.token });
  check(Array.isArray(outsiderRow.data) && outsiderRow.data.length === 0, 'a non-member cannot read the room row');
  check((await rpc(B.token, 'ca_room_snapshot', { room_code: code })).data?.hint === 'not_member', 'a non-member cannot get a snapshot');
  check((await rpc(B.token, 'ca_room_join', { room_code: code })).status === 200, 'B joins with the code');
  check((await rpc(C.token, 'ca_room_join', { room_code: code })).data?.hint === 'room_full', 'C is refused: room full');
  check((await rpc(C.token, 'ca_room_ready', { room_code: code, ready: true })).data?.hint === 'not_member', 'C cannot change readiness in a room they are not in');
  check((await rpc(B.token, 'ca_room_start', { room_code: code })).data?.hint === 'not_host', 'B (not host) cannot start');
  check((await rpc(A.token, 'ca_room_start', { room_code: code })).data?.hint === 'not_ready', 'start requires both players ready');
  const lA = listenRoom(A, code), lC = listenRoom(C, code);
  const [okA, okC] = await Promise.all([lA.ready, lC.ready]);
  check(okA, 'Realtime: the member subscription is confirmed by the server');
  await rpc(A.token, 'ca_room_ready', { room_code: code, ready: true });
  await rpc(B.token, 'ca_room_ready', { room_code: code, ready: true });
  for (let i = 0; i < 20 && !lA.events.length; i++) await sleep(500);
  await sleep(1500);
  check(lA.events.length > 0, 'Realtime: a member receives room notifications', `${lA.events.length} events`);
  check(lC.events.length === 0, 'Realtime: an outsider subscribed to the same room receives nothing', `${lC.events.length} events`);
  lA.close(); lC.close();
  check((await snap(A, code)).round === null, 'the problem stays hidden in the lobby');
  const started = await rpc(A.token, 'ca_room_start', { room_code: code, request_id: rid() });
  const sA = await snap(A, code), sB = await snap(B, code);
  check(started.data?.ok && sA.phase === 'active' && sA.round.problem.id === sB.round.problem.id && sA.round.deadline - sA.round.startedAt === 600000, 'match starts: same problem for both, 10-minute deadline', sA.round?.problem?.id);
  const pid = sA.round.problem.id, roundId = sA.round.id;
  const cBattle = await judge(C, { requestId: rid(), mode: 'submit', language: 'python', roomCode: code, roundId, sourceB64: b64(ref(pid, 'python')) });
  check(cBattle.status === 403, 'an outsider cannot submit into the battle', `HTTP ${cBattle.status}`);

  console.log('Battle rules');
  const bWrong = await submit(B, { mode: 'submit', language: 'javascript', roomCode: code, roundId, source: 'console.log("nope")' });
  check(bWrong.done?.verdict === 'WA', 'B: wrong answer in the battle', bWrong.done?.verdict);
  const aRight = await submit(A, { mode: 'submit', language: 'python', roomCode: code, roundId, source: ref(pid, 'python') });
  check(aRight.done?.verdict === 'AC', 'A: Accepted in the battle', aRight.done?.verdict);
  const sB2 = await snap(B, code);
  check(sB2.players.find((p) => !p.isYou).status === 'solved' && sB2.mySubmissions.every((j) => j.id !== aRight.job.id) && !JSON.stringify(sB2).includes('heapq') && !JSON.stringify(sB2).includes('seen = set()'), "B sees A as 'solved' but never A's submission or code");
  const aAgain = await judge(A, { requestId: rid(), mode: 'submit', language: 'python', roomCode: code, roundId, sourceB64: b64(ref(pid, 'python')) });
  check(aAgain.data?.error?.code === 'already_solved', 'Submit locks after Accepted', aAgain.data?.error?.code);
  const bRight = await submit(B, { mode: 'submit', language: 'javascript', roomCode: code, roundId, source: ref(pid, 'javascript') });
  const fin = await snap(A, code);
  check(bRight.done?.verdict === 'AC' && fin.phase === 'finished' && fin.result.outcome === 'win' && fin.result.winnerSeat === 0, 'both solved -> round ends; the earlier Accepted (A) wins', `${fin.phase} ${fin.result?.outcome} seat ${fin.result?.winnerSeat}`);
  check((await rpc(B.token, 'ca_room_rematch', { room_code: code })).data?.hint === 'not_host', 'only the host can rematch');
  await rpc(A.token, 'ca_room_rematch', { room_code: code, request_id: rid() });
  const lob = await snap(A, code);
  check(lob.phase === 'lobby' && lob.players.every((p) => p && !p.ready), 'rematch returns to the lobby with readiness reset');

  console.log('Timers, settle window and the void rule');
  const go = async () => { await rpc(A.token, 'ca_room_ready', { room_code: code, ready: true }); await rpc(B.token, 'ca_room_ready', { room_code: code, ready: true }); await rpc(A.token, 'ca_room_start', { room_code: code }); return (await snap(A, code)).round; };
  let r2 = await go();
  check(r2.problem.id !== pid, 'the rematch picks a different problem', r2.problem.id);
  await service('ca_test_age_round', { round_id: r2.id, seconds: 601 });
  const afterDeadline = await snap(A, code);
  check(afterDeadline.phase === 'finished' && afterDeadline.result.outcome === 'draw' && /Time ran out/.test(afterDeadline.result.reason), 'deadline with no Accepted -> draw', afterDeadline.result?.reason);
  check((await judge(B, { requestId: rid(), mode: 'submit', language: 'python', roomCode: code, roundId: r2.id, sourceB64: b64('print(1)') })).data?.error?.code === 'round_closed', 'submissions after the deadline are refused');
  await rpc(A.token, 'ca_room_rematch', { room_code: code });
  const r3 = await go();
  // A timely submission that is still being judged at the deadline (created directly, never finished).
  const pendingJob = await service('ca_submission_create', { uid: B.id, request_id: rid(), mode: 'submit', problem_id: null, language: 'python', source_b64: b64('print(1)'), room_code: code, round_id: r3.id });
  check(pendingJob.status === 200, 'a pending battle submission exists at the deadline');
  await service('ca_test_age_round', { round_id: r3.id, seconds: 601 });
  const judging = await snap(A, code);
  check(judging.phase === 'judging' && judging.round.settleDeadline - judging.round.deadline === 180000, 'deadline with a pending job -> judging, 180 s settle window');
  await service('ca_test_age_round', { round_id: r3.id, seconds: 181 });
  const voided = await snap(A, code);
  check(voided.phase === 'finished' && voided.result.outcome === 'void', 'settle window closes with an unjudged timely job -> round void', voided.result?.outcome);
  await service('ca_submission_finish_b64', { submission_id: pendingJob.data.job.id, verdict: 'JU', result_b64: b64('{"cases":[],"hidden":null,"compile":null,"message":"test"}'), calls: 0 });

  console.log('Disconnects and lobby grace (cron)');
  await rpc(A.token, 'ca_room_rematch', { room_code: code });
  await service('ca_test_age_seat', { room_code: code, seat: 1, seconds: 40 });
  let seen = null;
  for (let i = 0; i < 12 && !seen; i++) { await sleep(2500); const s = await snap(A, code); if (s.players[1] && s.players[1].connected === false) seen = s; }
  check(Boolean(seen), 'pg_cron marks a silent player disconnected (heartbeat > 35 s)');
  check((await snap(B, code)).players[1].connected === true, 'the player reconnects on their next heartbeat');
  await service('ca_test_age_seat', { room_code: code, seat: 1, seconds: 130 });
  let freed = null;
  for (let i = 0; i < 12 && !freed; i++) { await sleep(2500); const s = await snap(A, code); if (!s.players[1]) freed = s; }
  check(Boolean(freed), 'lobby grace: a seat silent for 2 minutes is freed');
  await service('ca_test_age_seat', { room_code: code, seat: 0, seconds: 130 });
  let closed = null;
  for (let i = 0; i < 12 && !closed; i++) { await sleep(2500); const s = await snap(A, code, false); if (s?.phase === 'closed') closed = s; }
  check(Boolean(closed) && /host left/.test(closed.closedMessage || ''), 'lobby grace: the room closes when the host is gone', closed?.closedMessage);

  console.log('History and progress');
  const hist = (await rpc(A.token, 'ca_history')).data;
  check(hist.matches.some((m) => m.outcome === 'won') && hist.matches.some((m) => m.outcome === 'draw') && hist.matches.some((m) => m.outcome === 'void'), 'history lists the won, drawn and void matches', hist.matches.map((m) => m.outcome).join(','));
  check(hist.submissions.length >= 2 && hist.submissions.every((s) => !('source' in s)), 'history lists submissions without source code');
  const prog = (await rpc(A.token, 'ca_session')).data.progress;
  check(prog.solvedCount >= 1 && prog.solved.includes('target-pair') && prog.total === 12, 'progress counts solved problems', JSON.stringify(prog).slice(0, 90));
  const att = (await rpc(A.token, 'ca_attempts')).data;
  check(Array.isArray(att) && att.length >= 2 && att.every((a) => a.problem_id && a.verdict), 'recommender inputs: own verdict history only');
} catch (e) {
  failures++;
  console.error('  ✗  ' + (e.stack || e.message));
} finally {
  if (SESSIONS) fs.writeFileSync(SESSIONS, JSON.stringify(sessions));
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
