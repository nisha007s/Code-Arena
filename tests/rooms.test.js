// RoomService with an injected clock and a scriptable judge.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { Judge } from '../server/judge/index.js';
import { JobService } from '../server/jobs.js';
import { RoomService } from '../server/rooms.js';
import { bank, testConfig, FakeClock, FakeDriver, until } from './helpers.js';

function setup({ durationMs = 60000, settleMs = 5000 } = {}) {
  const config = testConfig({ match: { durationMs, settleMs, lobbyGraceMs: 30000 }, judge: { infraRetries: 1 } });
  const clock = new FakeClock();
  const { q, tx, db } = openDatabase(':memory:');
  const driver = new FakeDriver();
  const judge = new Judge({ config, driver, bank, log: {} });
  const jobs = new JobService({ q, judge, bank, clock, log: {} });
  let seed = 0;
  const rooms = new RoomService({ q, tx, bank, jobs, config, clock, log: {}, random: () => ((seed = (seed * 9301 + 49297) % 233280) / 233280) });
  const guest = (name) => {
    const id = 'g-' + name;
    q.insertGuest.run(id, 'hash-' + name, name, clock.now(), clock.now());
    return { id, name };
  };
  return { config, clock, q, db, driver, jobs, rooms, guest };
}

let rid = 0;
const req = () => `request-${++rid}-xxxx`;

function startedRoom(env) {
  const { rooms, guest } = env;
  const alice = guest('Alice'), bob = guest('Bob');
  const room = rooms.create(alice, { difficulty: 'easy' });
  rooms.join(bob, room.code);
  rooms.connect(alice, room.code);
  rooms.connect(bob, room.code);
  rooms.setReady(alice, room.code, true);
  rooms.setReady(bob, room.code, true);
  rooms.start(alice, room.code, req());
  return { alice, bob, room, problem: room.round.problemId };
}

const submit = (env, who, room, source, language = 'python') =>
  env.rooms.submit(who, { code: room.code, roundId: room.round.id, language, source, requestId: req() }, env.clock.now());

describe('lobby', () => {
  test('codes use six readable characters and a third player cannot join', () => {
    const env = setup();
    const a = env.guest('A'), b = env.guest('B'), c = env.guest('C');
    const room = env.rooms.create(a);
    assert.match(room.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    env.rooms.join(b, room.code);
    assert.throws(() => env.rooms.join(c, room.code), { code: 'room_full' });
    assert.equal(env.rooms.join(b, room.code), room, 'rejoining reclaims the seat');
  });

  test('only the host can start, and only when both are connected and ready', () => {
    const env = setup();
    const a = env.guest('A'), b = env.guest('B');
    const room = env.rooms.create(a);
    env.rooms.connect(a, room.code);
    assert.throws(() => env.rooms.start(a, room.code), { code: 'waiting_for_player' });
    env.rooms.join(b, room.code);
    env.rooms.setReady(a, room.code, true);
    env.rooms.setReady(b, room.code, true);
    assert.throws(() => env.rooms.start(a, room.code), { code: 'player_disconnected' });
    env.rooms.connect(b, room.code);
    assert.throws(() => env.rooms.start(b, room.code), { code: 'not_host' });
    env.rooms.setReady(b, room.code, false);
    assert.throws(() => env.rooms.start(a, room.code), { code: 'not_ready' });
    env.rooms.setReady(b, room.code, true);
    env.rooms.start(a, room.code);
    assert.equal(room.phase, 'active');
  });

  test('duplicate start with the same requestId returns the original result', () => {
    const env = setup();
    const a = env.guest('A'), b = env.guest('B');
    const room = env.rooms.create(a);
    env.rooms.join(b, room.code);
    env.rooms.connect(a, room.code); env.rooms.connect(b, room.code);
    env.rooms.setReady(a, room.code, true); env.rooms.setReady(b, room.code, true);
    const first = env.rooms.start(a, room.code, 'start-request-1');
    const again = env.rooms.start(a, room.code, 'start-request-1');
    assert.deepEqual(again, first);
    assert.throws(() => env.rooms.start(a, room.code, 'start-request-2'), { code: 'wrong_phase' });
  });

  test('problem stays hidden in the lobby; both players get the same problem and deadline', () => {
    const env = setup();
    const a = env.guest('A'), b = env.guest('B');
    const room = env.rooms.create(a);
    env.rooms.join(b, room.code);
    assert.equal(env.rooms.snapshotFor(room, a.id).round, null);
    env.rooms.connect(a, room.code); env.rooms.connect(b, room.code);
    env.rooms.setReady(a, room.code, true); env.rooms.setReady(b, room.code, true);
    env.rooms.start(a, room.code);
    const sa = env.rooms.snapshotFor(room, a.id), sb = env.rooms.snapshotFor(room, b.id);
    assert.equal(sa.round.problem.id, sb.round.problem.id);
    assert.equal(sa.round.deadline, sb.round.deadline);
    assert.equal(sa.round.deadline - sa.round.startedAt, 60000);
    assert.equal(sa.serverTime, env.clock.now());
  });

  test('presence is tracked across tabs; closing one of two tabs keeps the guest online', () => {
    const env = setup();
    const a = env.guest('A');
    const room = env.rooms.create(a);
    env.rooms.connect(a, room.code);
    env.rooms.connect(a, room.code);
    env.rooms.disconnect(a.id, room.code);
    assert.equal(env.rooms.isConnected(room, a.id), true);
    env.rooms.disconnect(a.id, room.code);
    assert.equal(env.rooms.isConnected(room, a.id), false);
  });

  test('abandoned lobby seats are reclaimed after the grace period; abandoned host closes the room', () => {
    const env = setup();
    const a = env.guest('A'), b = env.guest('B');
    const room = env.rooms.create(a);
    env.rooms.connect(a, room.code);
    env.rooms.join(b, room.code); // b never connects
    env.clock.advance(29000); env.rooms.sweep();
    assert.ok(room.seats[1], 'still inside the grace period');
    env.clock.advance(2000); env.rooms.sweep();
    assert.equal(room.seats[1], null);
    env.rooms.disconnect(a.id, room.code);
    env.clock.advance(31000); env.rooms.sweep();
    assert.equal(env.rooms.rooms.has(room.code), false);
  });
});

describe('battle rules', () => {
  test('earliest received Accepted wins even when its judging finishes last', async () => {
    const env = setup();
    const { alice, bob, room, problem } = startedRoom(env);
    const ja = submit(env, alice, room, `#gate=a #correct ${problem}`);
    env.clock.advance(1000);
    const jb = submit(env, bob, room, `#gate=b #correct ${problem}`, 'java');
    assert.ok(jb.seq > ja.seq);
    env.driver.release('b'); // Bob is judged first
    await until(() => env.jobs.get(jb.id).status === 'done');
    assert.equal(room.phase, 'active', 'Alice is still pending, so no winner yet');
    env.driver.release('a');
    await until(() => room.phase === 'finished');
    assert.equal(room.result.outcome, 'win');
    assert.equal(room.result.winnerName, 'Alice');
    assert.match(room.result.reason, /earlier accepted/);
  });

  test('duplicate submit retries return the original job', () => {
    const env = setup();
    const { alice, room, problem } = startedRoom(env);
    const body = { code: room.code, roundId: room.round.id, language: 'python', source: `#gate=x #correct ${problem}`, requestId: 'same-request-id' };
    const first = env.rooms.submit(alice, body, env.clock.now());
    const second = env.rooms.submit(alice, body, env.clock.now());
    assert.equal(second.id, first.id);
  });

  test('one pending submission per player, and submissions lock after Accepted', async () => {
    const env = setup();
    const { alice, room, problem } = startedRoom(env);
    const j1 = submit(env, alice, room, '#gate=w #wrong');
    assert.throws(() => submit(env, alice, room, '#wrong'), { code: 'pending_submission' });
    env.driver.release('w');
    await until(() => env.jobs.get(j1.id).status === 'done');
    assert.equal(env.jobs.get(j1.id).verdict, 'WA');
    const j2 = submit(env, alice, room, `#correct ${problem}`);
    await until(() => env.jobs.get(j2.id).status === 'done');
    assert.throws(() => submit(env, alice, room, `#correct ${problem}`), { code: 'already_solved' });
    assert.equal(env.rooms.snapshotFor(room, alice.id).players[0].status, 'solved');
  });

  test('submissions after the deadline are rejected; one Accepted beats none', async () => {
    const env = setup();
    const { alice, bob, room, problem } = startedRoom(env);
    const ja = submit(env, alice, room, `#correct ${problem}`);
    await until(() => env.jobs.get(ja.id).status === 'done');
    env.clock.advance(60000);
    assert.throws(() => submit(env, bob, room, `#correct ${problem}`), { code: 'round_closed' });
    assert.equal(room.phase, 'finished');
    assert.equal(room.result.outcome, 'win');
    assert.equal(room.result.winnerName, 'Alice');
  });

  test('work pending at the deadline is settled before finishing', async () => {
    const env = setup();
    const { bob, room, problem } = startedRoom(env);
    submit(env, bob, room, `#gate=late #correct ${problem}`);
    env.clock.advance(60000);
    assert.equal(room.phase, 'judging');
    assert.ok(env.rooms.snapshotFor(room, bob.id).round.settleDeadline);
    env.driver.release('late');
    await until(() => room.phase === 'finished');
    assert.equal(room.result.winnerName, 'Bob');
  });

  test('no Accepted at the deadline is a draw', () => {
    const env = setup();
    const { room } = startedRoom(env);
    env.clock.advance(60000);
    assert.equal(room.result.outcome, 'draw');
  });

  test('a timely submission that cannot be judged voids the round', async () => {
    const env = setup();
    const { alice, room } = startedRoom(env);
    const j = submit(env, alice, room, '#infra');
    await until(() => env.jobs.get(j.id).status === 'done');
    assert.equal(env.jobs.get(j.id).verdict, 'JU');
    env.clock.advance(60000);
    assert.equal(room.result.outcome, 'void');
    assert.equal(room.result.winnerSeat, null);
  });

  test('a judge failure that cannot change the result does not void it', async () => {
    const env = setup();
    const { alice, bob, room, problem } = startedRoom(env);
    const ja = submit(env, alice, room, `#correct ${problem}`);
    await until(() => env.jobs.get(ja.id).status === 'done');
    const jb = submit(env, bob, room, '#infra'); // received after Alice's Accepted
    await until(() => env.jobs.get(jb.id).status === 'done');
    env.clock.advance(60000);
    assert.equal(room.result.outcome, 'win');
    assert.equal(room.result.winnerName, 'Alice');
  });

  test('work still pending when the settle window closes voids the round', () => {
    const env = setup();
    const { alice, room } = startedRoom(env);
    submit(env, alice, room, '#gate=never #wrong');
    env.clock.advance(60000);
    assert.equal(room.phase, 'judging');
    env.clock.advance(5000);
    assert.equal(room.phase, 'finished');
    assert.equal(room.result.outcome, 'void');
  });

  test('rematch resets readiness, rotates the problem and ignores the old round', async () => {
    const env = setup();
    const { alice, bob, room } = startedRoom(env);
    const oldRound = room.round.id, oldProblem = room.round.problemId;
    const late = submit(env, bob, room, '#gate=old #correct ' + oldProblem);
    env.clock.advance(60000 + 5000); // deadline + settle → void (pending)
    assert.equal(room.phase, 'finished');
    assert.throws(() => env.rooms.rematch(bob, room.code), { code: 'not_host' });
    env.rooms.rematch(alice, room.code);
    assert.equal(room.phase, 'lobby');
    assert.deepEqual(room.seats.map((s) => s.ready), [false, false]);
    env.rooms.setReady(alice, room.code, true); env.rooms.setReady(bob, room.code, true);
    env.rooms.start(alice, room.code);
    assert.notEqual(room.round.id, oldRound);
    assert.notEqual(room.round.problemId, oldProblem);
    env.driver.release('old');
    await until(() => env.jobs.get(late.id).status === 'done');
    assert.equal(room.phase, 'active', 'an old-round result cannot touch the new round');
    assert.equal(env.rooms.snapshotFor(room, bob.id).players[1].status, 'solving');
  });

  test('opponents never see each other\'s submissions', async () => {
    const env = setup();
    const { alice, bob, room, problem } = startedRoom(env);
    const j = submit(env, alice, room, `#correct ${problem} SECRET_SOURCE`);
    await until(() => env.jobs.get(j.id).status === 'done');
    const forBob = JSON.stringify(env.rooms.snapshotFor(room, bob.id));
    assert.ok(!forBob.includes('SECRET_SOURCE'));
    assert.equal(env.rooms.snapshotFor(room, bob.id).mySubmissions.length, 0);
    assert.equal(env.rooms.snapshotFor(room, alice.id).mySubmissions.length, 1);
  });

  test('final round status is persisted exactly once', async () => {
    const env = setup();
    const { alice, room, problem } = startedRoom(env);
    const ja = submit(env, alice, room, `#correct ${problem}`);
    await until(() => env.jobs.get(ja.id).status === 'done');
    env.clock.advance(60000);
    const row = env.db.prepare('SELECT * FROM rounds WHERE id = ?').get(room.round.id);
    assert.equal(row.status, 'finished');
    assert.equal(row.outcome, 'win');
    const again = env.q.finishRound.run('draw', null, 'x', '{}', 0, room.round.id);
    assert.equal(again.changes, 0);
  });

  test('after a restart interrupted rounds are void and rooms can be reclaimed', () => {
    const env = setup();
    const { alice, room } = startedRoom(env);
    const fresh = new RoomService({ q: env.q, tx: (f) => f(), bank, jobs: env.jobs, config: env.config, clock: env.clock, log: {} });
    fresh.recover();
    const back = fresh.rooms.get(room.code);
    assert.ok(back);
    assert.equal(back.phase, 'finished');
    assert.equal(back.result.outcome, 'void');
    assert.match(back.result.reason, /restarted/);
    fresh.connect(alice, room.code);
    assert.equal(fresh.isConnected(back, alice.id), true);
  });
});

describe('decide()', () => {
  const j = (guestId, seq, verdict, done = true) => ({ guestId, seat: guestId === 'a' ? 0 : 1, seq, verdict, done });
  test('lowest sequence among Accepted wins', () => {
    assert.equal(RoomService.decide([j('b', 2, 'AC'), j('a', 1, 'AC')]).winner.guestId, 'a');
  });
  test('no Accepted is a draw; unjudged work voids', () => {
    assert.equal(RoomService.decide([j('a', 1, 'WA')]).outcome, 'draw');
    assert.equal(RoomService.decide([j('a', 1, 'JU')]).outcome, 'void');
    assert.equal(RoomService.decide([j('a', 1, null, false)]).outcome, 'void');
  });
  test('an earlier unjudged submission by the other player voids a win', () => {
    assert.equal(RoomService.decide([j('b', 1, 'JU'), j('a', 2, 'AC')]).outcome, 'void');
    assert.equal(RoomService.decide([j('a', 1, 'AC'), j('b', 2, 'JU')]).outcome, 'win');
    assert.equal(RoomService.decide([j('a', 1, 'JU'), j('a', 2, 'AC')]).outcome, 'win');
  });
});
