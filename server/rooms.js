// RoomService owns every match transition:  lobby → active → judging → finished.
//
// HTTP routes and socket events both call into this one service, so the rules
// live in one place. Time comes from an injected clock and judging goes through
// the injected JobService, which keeps the logic testable with fake versions.
//
// Fairness rules (see README "Match rules"):
//  * The earliest server-received submission that earns Accepted wins
//    (ordered by the monotonic server sequence number, never by judge finish time).
//  * One pending Submit per player; Submit locks after a player's first Accepted.
//  * Both Accepted → finish early. Otherwise close at the deadline and wait up to
//    settleMs for timely jobs. One Accepted beats none; none is a draw.
//  * A timely submission that could change the result but could not be judged
//    (Judge Unavailable after retry, or still pending at the settle limit) voids the round.
import crypto from 'node:crypto';
import { errors } from './errors.js';
import { LANGUAGES } from './judge/languages.js';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const ROOM_DIFFICULTIES = ['mixed', 'easy', 'medium', 'hard'];

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

const REASONS = {
  both_solved: 'Both players solved it; the earlier accepted submission wins.',
  deadline: 'Time ran out.',
  settled: 'Time ran out and every timely submission has been judged.',
  settle_timeout: 'Time ran out and the settling window closed.',
  server_restart: 'The server restarted during the round.',
};

export class RoomService {
  constructor({ q, tx, bank, jobs, config, clock = realClock, random = Math.random, log = console, onChange = () => {}, onClosed = () => {} }) {
    Object.assign(this, { q, tx, bank, jobs, config, clock, random, log, onChange, onClosed });
    this.rooms = new Map();
    jobs.onFinished((row) => { if (row.kind === 'battle') this.onJobFinished(row); });
  }

  // ---------- lookup helpers ----------

  #room(code) {
    const room = typeof code === 'string' ? this.rooms.get(code.toUpperCase()) : null;
    if (!room) throw errors.notFound('That room does not exist or has expired.', 'room_not_found');
    return room;
  }

  #seatOf(room, guestId) {
    return room.seats.findIndex((s) => s && s.guestId === guestId);
  }

  #member(code, guest) {
    const room = this.#room(code);
    const seat = this.#seatOf(room, guest.id);
    if (seat < 0) throw errors.forbidden('You are not a player in this room.', 'not_member');
    return { room, seat };
  }

  #changed(room) {
    room.revision++;
    room.updatedAt = this.clock.now();
    this.onChange(room);
  }

  // Idempotent commands: the same requestId returns the first result.
  #once(room, guestId, requestId, fn) {
    if (!requestId) return fn();
    const key = `${guestId}:${requestId}`;
    if (room.actions.has(key)) {
      const prev = room.actions.get(key);
      if (prev.error) throw prev.error;
      return prev.value;
    }
    try {
      const value = fn();
      room.actions.set(key, { value });
      return value;
    } catch (error) {
      room.actions.set(key, { error });
      throw error;
    } finally {
      if (room.actions.size > 200) room.actions.delete(room.actions.keys().next().value);
    }
  }

  #newCode() {
    for (let i = 0; i < 100; i++) {
      const code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
      if (!this.rooms.has(code) && !this.q.roomExists.get(code)) return code;
    }
    throw new Error('Could not allocate a room code');
  }

  #blankRoom(code, hostId, difficulty) {
    return {
      code, hostId, difficulty,
      phase: 'lobby',
      seats: [null, null],
      connections: new Map(),   // guestId → number of open sockets (tabs)
      disconnectedAt: new Map(), // guestId → time the last socket closed
      round: null,
      roundNumber: 0,
      roundJobs: new Map(),     // jobId → { guestId, seat, seq, done, verdict }
      lastProblemId: null,
      result: null,
      revision: 0,
      updatedAt: this.clock.now(),
      actions: new Map(),
      timers: { deadline: null, settle: null },
    };
  }

  // ---------- commands ----------

  create(guest, { difficulty = 'mixed' } = {}) {
    if (!ROOM_DIFFICULTIES.includes(difficulty)) throw errors.badRequest('Difficulty must be mixed, easy, medium or hard.');
    const existing = this.activeRoomFor(guest.id);
    if (existing && existing.phase !== 'finished') throw errors.conflict(`You are already in room ${existing.code}. Leave it first.`, 'already_in_room');
    if (existing) this.leave(guest, existing.code);
    const now = this.clock.now();
    const code = this.#newCode();
    const room = this.#blankRoom(code, guest.id, difficulty);
    room.seats[0] = { guestId: guest.id, name: guest.name, ready: false };
    room.disconnectedAt.set(guest.id, now);
    this.tx(() => {
      this.q.insertRoom.run(code, guest.id, difficulty, 'open', now, now);
      this.q.insertSeat.run(code, 0, guest.id, now);
    });
    this.rooms.set(code, room);
    this.#changed(room);
    return room;
  }

  join(guest, code) {
    const room = this.#room(code);
    if (this.#seatOf(room, guest.id) >= 0) return room; // reclaim own seat
    if (room.seats[1]) throw errors.conflict('This room already has two players.', 'room_full');
    if (room.phase !== 'lobby') throw errors.conflict('This match has already started.', 'match_in_progress');
    const other = this.activeRoomFor(guest.id);
    if (other && other.phase !== 'finished') throw errors.conflict(`You are already in room ${other.code}. Leave it first.`, 'already_in_room');
    if (other) this.leave(guest, other.code);
    const now = this.clock.now();
    room.seats[1] = { guestId: guest.id, name: guest.name, ready: false };
    room.disconnectedAt.set(guest.id, now);
    this.q.insertSeat.run(room.code, 1, guest.id, now);
    this.#changed(room);
    return room;
  }

  leave(guest, code) {
    const { room, seat } = this.#member(code, guest);
    if (room.phase === 'active' || room.phase === 'judging') throw errors.conflict('You cannot leave during a round. The clock keeps running if you disconnect.', 'round_in_progress');
    if (seat === 0) return this.#close(room, 'The host closed the room.');
    room.seats[1] = null;
    room.connections.delete(guest.id);
    room.disconnectedAt.delete(guest.id);
    if (room.seats[0]) room.seats[0].ready = false;
    if (room.phase === 'finished') { room.phase = 'lobby'; room.result = null; room.round = null; }
    this.q.deleteSeat.run(room.code, 1);
    this.#changed(room);
    return room;
  }

  setReady(guest, code, ready, requestId) {
    const { room, seat } = this.#member(code, guest);
    return this.#once(room, guest.id, requestId, () => {
      if (room.phase !== 'lobby') throw errors.conflict('Readiness can only change in the lobby.', 'wrong_phase');
      room.seats[seat].ready = Boolean(ready);
      this.#changed(room);
      return { ok: true };
    });
  }

  start(guest, code, requestId) {
    const { room, seat } = this.#member(code, guest);
    return this.#once(room, guest.id, requestId, () => {
      if (seat !== 0) throw errors.forbidden('Only the host can start the match.', 'not_host');
      if (room.phase !== 'lobby') throw errors.conflict('The match is not in the lobby.', 'wrong_phase');
      if (!room.seats[1]) throw errors.conflict('Wait for your friend to join.', 'waiting_for_player');
      for (const s of room.seats) {
        if (!this.isConnected(room, s.guestId)) throw errors.conflict(`${s.name} is not connected.`, 'player_disconnected');
        if (!s.ready) throw errors.conflict('Both players must be ready.', 'not_ready');
      }
      const problem = this.bank.pick(room.difficulty, room.lastProblemId, this.random);
      const now = this.clock.now();
      const durationMs = this.config.match.durationMs;
      const round = { id: crypto.randomUUID(), number: room.roundNumber + 1, problemId: problem.id, startedAt: now, deadline: now + durationMs, durationMs };
      this.tx(() => {
        this.q.insertRound.run(round.id, room.code, round.number, problem.id, now, round.deadline);
        room.seats.forEach((s, i) => this.q.insertRoundPlayer.run(round.id, i, s.guestId, s.name));
        this.q.updateRoom.run('open', problem.id, now, room.code);
      });
      room.roundNumber = round.number;
      room.round = round;
      room.roundJobs = new Map();
      room.result = null;
      room.phase = 'active';
      room.timers.deadline = this.clock.setTimeout(() => this.#closeRound(room.code, round.id), durationMs);
      this.#changed(room);
      return { ok: true, roundId: round.id };
    });
  }

  rematch(guest, code, requestId) {
    const { room, seat } = this.#member(code, guest);
    return this.#once(room, guest.id, requestId, () => {
      if (seat !== 0) throw errors.forbidden('Only the host can start a rematch.', 'not_host');
      if (room.phase !== 'finished') throw errors.conflict('The round has not finished.', 'wrong_phase');
      if (!room.seats[0] || !room.seats[1]) throw errors.conflict('A rematch needs both players in the room.', 'waiting_for_player');
      room.lastProblemId = room.round?.problemId || room.lastProblemId;
      room.round = null;
      room.result = null;
      room.roundJobs = new Map();
      room.phase = 'lobby';
      for (const s of room.seats) s.ready = false;
      this.#changed(room);
      return { ok: true };
    });
  }

  // ---------- presence ----------

  isConnected(room, guestId) {
    return (room.connections.get(guestId) || 0) > 0;
  }

  connect(guest, code) {
    const { room } = this.#member(code, guest);
    room.connections.set(guest.id, (room.connections.get(guest.id) || 0) + 1);
    room.disconnectedAt.delete(guest.id);
    this.#changed(room);
    return room;
  }

  disconnect(guestId, code) {
    const room = this.rooms.get(code);
    if (!room || !room.connections.has(guestId)) return;
    const left = room.connections.get(guestId) - 1;
    if (left > 0) { room.connections.set(guestId, left); return; } // another tab is still open
    room.connections.delete(guestId);
    room.disconnectedAt.set(guestId, this.clock.now());
    this.#changed(room);
  }

  renameGuest(guestId, name) {
    for (const room of this.rooms.values()) {
      const seat = this.#seatOf(room, guestId);
      if (seat >= 0) { room.seats[seat].name = name; this.#changed(room); }
    }
  }

  activeRoomFor(guestId) {
    for (const room of this.rooms.values()) if (this.#seatOf(room, guestId) >= 0) return room;
    return null;
  }

  // ---------- battle submissions ----------

  /**
   * Admit a battle submission. `receivedAt` is captured by the caller at the start
   * of handling the request, before any validation work.
   */
  submit(guest, { code, roundId, language, source, requestId }, receivedAt) {
    const { room, seat } = this.#member(code, guest);
    const existing = this.jobs.findExisting(guest.id, requestId);
    if (existing) return existing; // duplicate retry → original job
    const round = room.round;
    if (!round || round.id !== roundId) throw errors.conflict('That round is no longer active.', 'stale_round');
    if (room.phase !== 'active' || receivedAt >= round.deadline) throw errors.conflict('The round has closed; new submissions are not accepted.', 'round_closed');
    if (!LANGUAGES[language]) throw errors.badRequest('Unknown language.', 'invalid_language');
    const mine = [...room.roundJobs.values()].filter((j) => j.guestId === guest.id);
    if (mine.some((j) => j.verdict === 'AC')) throw errors.conflict('You already solved this round.', 'already_solved');
    if (mine.some((j) => !j.done)) throw errors.conflict('Your previous submission is still being judged.', 'pending_submission');
    const problem = this.bank.get(round.problemId);
    const seq = this.jobs.nextSeq(); // order of receipt decides ties, not judge completion
    // Job completion is always asynchronous, so the entry exists before any result arrives.
    const row = this.jobs.start({ guestId: guest.id, requestId, mode: 'submit', kind: 'battle', problem, language, source, roomCode: room.code, roundId: round.id, receivedAt, seq });
    room.roundJobs.set(row.id, { guestId: guest.id, seat, seq, done: false, verdict: null });
    this.#changed(room);
    return row;
  }

  onJobFinished(row) {
    const room = this.rooms.get(row.room_code);
    // Late results and old-round events never touch a finished round or a rematch.
    if (!room || !room.round || room.round.id !== row.round_id) return;
    if (room.phase !== 'active' && room.phase !== 'judging') return;
    const entry = room.roundJobs.get(row.id) || { guestId: row.guest_id, seat: this.#seatOf(room, row.guest_id), seq: row.seq };
    entry.done = true;
    entry.verdict = row.verdict;
    room.roundJobs.set(row.id, entry);
    this.#changed(room);
    const solvedSeats = new Set([...room.roundJobs.values()].filter((j) => j.verdict === 'AC').map((j) => j.guestId));
    if (room.phase === 'active' && solvedSeats.size === 2) return this.#finalize(room, 'both_solved');
    if (room.phase === 'judging' && ![...room.roundJobs.values()].some((j) => !j.done)) return this.#finalize(room, 'settled');
  }

  #closeRound(code, roundId) {
    const room = this.rooms.get(code);
    if (!room || room.round?.id !== roundId || room.phase !== 'active') return;
    room.timers.deadline = null;
    const pending = [...room.roundJobs.values()].some((j) => !j.done);
    if (!pending) return this.#finalize(room, 'deadline');
    room.phase = 'judging';
    room.round.settleDeadline = room.round.deadline + this.config.match.settleMs;
    const wait = Math.max(0, room.round.settleDeadline - this.clock.now());
    room.timers.settle = this.clock.setTimeout(() => {
      const r = this.rooms.get(code);
      if (r && r.round?.id === roundId && r.phase === 'judging') this.#finalize(r, 'settle_timeout');
    }, wait);
    this.#changed(room);
  }

  /** Decide the result of the current round. Pure function of the round's jobs. */
  static decide(jobs) {
    const accepted = jobs.filter((j) => j.verdict === 'AC').sort((a, b) => a.seq - b.seq);
    const winner = accepted[0] || null;
    const unjudged = jobs.filter((j) => !j.done || j.verdict === 'JU');
    const couldChange = unjudged.some((j) => !winner || (j.guestId !== winner.guestId && j.seq < winner.seq));
    if (couldChange) return { outcome: 'void', winner: null };
    return winner ? { outcome: 'win', winner } : { outcome: 'draw', winner: null };
  }

  #finalize(room, reasonKey) {
    if (room.phase === 'finished') return;
    const round = room.round;
    for (const k of ['deadline', 'settle']) if (room.timers[k]) { this.clock.clearTimeout(room.timers[k]); room.timers[k] = null; }
    const jobs = [...room.roundJobs.values()];
    const { outcome, winner } = RoomService.decide(jobs);
    const problem = this.bank.get(round.problemId);
    const now = this.clock.now();
    const players = room.seats.map((s, seat) => {
      if (!s) return null;
      const mine = jobs.filter((j) => j.guestId === s.guestId);
      const ac = mine.filter((j) => j.verdict === 'AC').sort((a, b) => a.seq - b.seq)[0];
      return {
        seat,
        name: s.name,
        submissions: mine.length,
        status: ac ? 'solved' : mine.some((j) => !j.done || j.verdict === 'JU') ? 'unjudged' : 'not_solved',
        solvedSeq: ac ? ac.seq : null,
      };
    }).filter(Boolean);
    const reason = outcome === 'void'
      ? 'A timely submission could not be judged and might have changed the result, so this round has no winner.'
      : REASONS[reasonKey];
    const result = {
      outcome,
      winnerSeat: winner ? winner.seat : null,
      winnerName: winner ? room.seats[winner.seat]?.name : null,
      reason,
      players,
      problem: { id: problem.id, title: problem.title, difficulty: problem.difficulty },
      roundNumber: round.number,
      finishedAt: now,
    };
    // Persist the final status exactly once; a second attempt changes no rows.
    const changed = this.tx(() => {
      const r = this.q.finishRound.run(outcome, winner ? winner.guestId : null, reason, JSON.stringify(result), now, round.id);
      this.q.updateRoom.run('open', round.problemId, now, room.code);
      return r.changes;
    });
    if (!changed) return;
    room.phase = 'finished';
    room.result = result;
    room.lastProblemId = round.problemId;
    this.#changed(room);
  }

  #close(room, message) {
    for (const k of ['deadline', 'settle']) if (room.timers[k]) this.clock.clearTimeout(room.timers[k]);
    room.phase = 'closed';
    this.q.updateRoom.run('closed', room.lastProblemId, this.clock.now(), room.code);
    this.rooms.delete(room.code);
    this.onClosed(room, message);
    return room;
  }

  // ---------- housekeeping ----------

  /** Expire abandoned lobby seats/rooms and idle finished rooms. Call periodically. */
  sweep() {
    const now = this.clock.now();
    const grace = this.config.match.lobbyGraceMs;
    for (const room of [...this.rooms.values()]) {
      if (room.phase === 'active' || room.phase === 'judging') continue;
      const gone = (s) => s && !this.isConnected(room, s.guestId) && now - (room.disconnectedAt.get(s.guestId) ?? now) >= grace;
      if (room.phase === 'lobby') {
        if (gone(room.seats[0])) { this.#close(room, 'The host left, so the room expired.'); continue; }
        if (gone(room.seats[1])) {
          room.connections.delete(room.seats[1].guestId);
          room.disconnectedAt.delete(room.seats[1].guestId);
          room.seats[1] = null;
          room.seats[0].ready = false;
          this.q.deleteSeat.run(room.code, 1);
          this.#changed(room);
        }
      } else if (room.phase === 'finished') {
        const anyone = room.seats.some((s) => s && this.isConnected(room, s.guestId));
        if (!anyone && now - room.updatedAt >= this.config.match.finishedRoomTtlMs) this.#close(room, 'The room expired.');
      }
    }
  }

  /**
   * After a restart: rounds that were running are voided (history is kept), and
   * recent open rooms come back so players can reclaim their seats.
   */
  recover() {
    const now = this.clock.now();
    for (const r of this.q.interruptedRounds.all()) {
      const problem = this.bank.get(r.problem_id);
      const players = this.q.roundPlayers.all(r.id).map((p) => ({ seat: p.seat, name: p.display_name, submissions: 0, status: 'unjudged', solvedSeq: null }));
      const result = {
        outcome: 'void', winnerSeat: null, winnerName: null, reason: REASONS.server_restart + ' Interrupted rounds are void.',
        players, problem: problem ? { id: problem.id, title: problem.title, difficulty: problem.difficulty } : null,
        roundNumber: r.number, finishedAt: now,
      };
      this.q.finishRound.run('void', null, result.reason, JSON.stringify(result), now, r.id);
    }
    const cutoff = now - 12 * 3600 * 1000;
    this.q.closeStaleRooms.run(cutoff);
    for (const row of this.q.openRooms.all(cutoff)) {
      const room = this.#blankRoom(row.code, row.host_guest_id, row.difficulty);
      for (const seatRow of this.q.seatsForRoom.all(row.code)) {
        const g = this.q.guestById.get(seatRow.guest_id);
        if (!g) continue;
        room.seats[seatRow.seat] = { guestId: g.id, name: g.display_name, ready: false };
        room.disconnectedAt.set(g.id, now);
      }
      if (!room.seats[0]) { this.q.updateRoom.run('closed', row.last_problem_id, now, row.code); continue; }
      room.lastProblemId = row.last_problem_id;
      const last = this.q.latestRound.get(row.code);
      if (last) {
        room.roundNumber = last.number;
        room.round = { id: last.id, number: last.number, problemId: last.problem_id, startedAt: last.started_at, deadline: last.deadline, durationMs: last.deadline - last.started_at };
        room.result = last.result_json ? JSON.parse(last.result_json) : null;
        room.phase = 'finished';
      }
      this.rooms.set(room.code, room);
    }
  }

  // ---------- snapshots ----------

  /** The authoritative room state as one player is allowed to see it. */
  snapshotFor(room, guestId) {
    const now = this.clock.now();
    const mySeat = this.#seatOf(room, guestId);
    const jobs = [...room.roundJobs.values()];
    const statusOf = (s) => {
      if (room.phase === 'lobby') return s.ready ? 'ready' : 'not_ready';
      const mine = jobs.filter((j) => j.guestId === s.guestId);
      if (mine.some((j) => j.verdict === 'AC')) return 'solved';
      if (mine.some((j) => !j.done)) return 'judging';
      return room.phase === 'finished' ? 'finished' : 'solving';
    };
    const showProblem = room.round && room.phase !== 'lobby';
    const problem = showProblem ? this.bank.get(room.round.problemId) : null;
    const myJobs = mySeat >= 0 && room.round
      ? this.q.submissionsForRound.all(room.round.id).filter((r) => r.guest_id === guestId).map((r) => this.jobs.toClient(r))
      : [];
    return {
      revision: room.revision,
      serverTime: now,
      code: room.code,
      phase: room.phase,
      difficulty: room.difficulty,
      invitePath: `/arena.html?room=${room.code}`,
      you: { seat: mySeat, isHost: mySeat === 0 },
      players: room.seats.map((s, seat) => s && {
        seat,
        name: s.name,
        isHost: seat === 0,
        isYou: seat === mySeat,
        connected: this.isConnected(room, s.guestId),
        ready: s.ready,
        status: statusOf(s),
      }),
      round: room.round && {
        id: room.round.id,
        number: room.round.number,
        startedAt: room.round.startedAt,
        deadline: room.round.deadline,
        settleDeadline: room.round.settleDeadline || null,
        durationMs: room.round.durationMs,
        problem: problem ? this.bank.publicDetail(problem) : null,
      },
      result: room.result,
      mySubmissions: myJobs,
    };
  }
}
