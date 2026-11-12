// JSON HTTP API. Every route reads req.guest (set by the session middleware).
// Errors are returned as { error: { code, message } }.
import express from 'express';
import { errors, AppError } from './errors.js';
import { cleanDisplayName, requireString, requireRequestId, RateLimiter, sameOriginMiddleware } from './security.js';
import { LANGUAGES, publicLanguages } from './judge/languages.js';
import { recommend } from './recommender.js';

export function apiRouter({ config, clock, q, bank, sessions, judge, jobs, rooms, recIndex }) {
  const r = express.Router();
  const joinLimiter = new RateLimiter({ limit: config.limits.joinsPerMinute, clock });
  const execLimiter = new RateLimiter({ limit: config.limits.executionsPerMinute, clock });

  r.use(express.json({ limit: config.limits.jsonBody }));
  r.use(sameOriginMiddleware(config.trustProxy));
  r.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  const progressFor = (guestId) => {
    const solved = q.solvedForGuest.all(guestId).map((x) => x.problem_id);
    const attempted = new Set(q.attemptsForGuest.all(guestId).map((x) => x.problem_id));
    return { solved, solvedCount: solved.length, attemptedCount: attempted.size, total: bank.list.length };
  };

  // ---- health ----
  r.get('/health', (_req, res) => res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) }));
  r.get('/judge/health', (_req, res) => {
    const s = judge.status();
    res.status(s.ready ? 200 : 503).json({
      ready: s.ready, driver: s.driver, unsandboxed: Boolean(s.unsandboxed), message: s.message, dockerVersion: s.dockerVersion || null,
      checkedAt: s.checkedAt, queue: s.queue,
      languages: Object.fromEntries(Object.entries(s.languages || {}).map(([id, l]) => [id, { ready: l.ready, message: l.message || null }])),
    });
  });

  // ---- session (the only route that creates a guest) ----
  r.get('/session', sessions.middleware({ create: true }), (req, res) => res.json({ guest: req.guest, progress: progressFor(req.guest.id) }));
  r.use(sessions.middleware());
  r.post('/session', (req, res) => {
    const name = cleanDisplayName(req.body?.displayName, config.limits.displayName);
    sessions.rename(req.guest.id, name);
    rooms.renameGuest(req.guest.id, name);
    res.json({ guest: { id: req.guest.id, name } });
  });

  // ---- catalog ----
  r.get('/languages', (_req, res) => res.json({ languages: publicLanguages() }));
  r.get('/problems', (req, res) => {
    const solved = new Set(progressFor(req.guest.id).solved);
    const attempted = new Set(q.attemptsForGuest.all(req.guest.id).map((x) => x.problem_id));
    res.json({
      problems: bank.list.map((p) => ({ ...bank.publicSummary(p), solved: solved.has(p.id), attempted: attempted.has(p.id) })),
    });
  });
  r.get('/problems/:id', (req, res) => {
    const p = bank.get(req.params.id);
    if (!p) throw errors.notFound('Problem not found.', 'problem_not_found');
    res.json({ problem: bank.publicDetail(p) });
  });
  r.get('/recommendations', (req, res) => {
    res.json(recommend(recIndex, q.attemptsForGuest.all(req.guest.id)));
  });

  // ---- rooms ----
  const limitJoin = (req) => {
    if (!joinLimiter.take('g:' + req.guest.id) || !joinLimiter.take('ip:' + req.socket.remoteAddress)) {
      throw errors.tooMany('Too many room requests. Wait a moment and try again.');
    }
  };
  const roomCode = (v) => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9]{6}$/.test(v)) throw errors.badRequest('Room codes have six letters or digits.', 'invalid_code');
    return v.toUpperCase();
  };
  r.post('/rooms', (req, res) => {
    limitJoin(req);
    const room = rooms.create(req.guest, { difficulty: req.body?.difficulty || 'mixed' });
    res.status(201).json({ room: rooms.snapshotFor(room, req.guest.id) });
  });
  r.get('/rooms/current', (req, res) => {
    const room = rooms.activeRoomFor(req.guest.id);
    res.json({ room: room ? rooms.snapshotFor(room, req.guest.id) : null });
  });
  r.post('/rooms/:code/join', (req, res) => {
    limitJoin(req);
    const room = rooms.join(req.guest, roomCode(req.params.code));
    res.json({ room: rooms.snapshotFor(room, req.guest.id) });
  });
  r.get('/rooms/:code', (req, res) => {
    const room = rooms.rooms.get(roomCode(req.params.code));
    if (!room) throw errors.notFound('That room does not exist or has expired.', 'room_not_found');
    const snap = rooms.snapshotFor(room, req.guest.id);
    if (snap.you.seat < 0) throw errors.forbidden('You are not a player in this room.', 'not_member');
    res.json({ room: snap });
  });
  r.post('/rooms/:code/leave', (req, res) => {
    rooms.leave(req.guest, roomCode(req.params.code));
    res.json({ ok: true });
  });

  // ---- submissions (Run and Submit, practice and battle) ----
  r.post('/submissions', (req, res) => {
    const receivedAt = clock.now(); // server receipt time, captured first
    const b = req.body || {};
    const requestId = requireRequestId(b.requestId);
    if (b.mode !== 'run' && b.mode !== 'submit') throw errors.badRequest('mode must be run or submit.');
    if (!LANGUAGES[b.language]) throw errors.badRequest('Unknown language.', 'invalid_language');
    const source = requireString(b.source, 'Source code', { maxBytes: config.limits.sourceBytes });
    if (!source.trim()) throw errors.badRequest('Write some code before running it.', 'empty_source');
    let customInput = null;
    if (b.customInput !== undefined && b.customInput !== null) {
      if (b.mode !== 'run') throw errors.badRequest('Custom input is only used with Run.');
      customInput = requireString(b.customInput, 'Custom input', { maxBytes: config.limits.customInputBytes });
    }
    const existing = jobs.findExisting(req.guest.id, requestId);
    if (existing) return res.json({ job: jobs.toClient(existing), duplicate: true });

    if (b.roomCode && b.mode === 'submit') {
      const row = rooms.submit(req.guest, { code: roomCode(b.roomCode), roundId: String(b.roundId || ''), language: b.language, source, requestId }, receivedAt);
      return res.status(202).json({ job: jobs.toClient(row) });
    }
    const problem = bank.get(b.problemId);
    if (!problem) throw errors.notFound('Problem not found.', 'problem_not_found');
    if (!execLimiter.take(req.guest.id)) throw errors.tooMany('You are running code very quickly. Wait a few seconds and try again.');
    const row = jobs.start({ guestId: req.guest.id, requestId, mode: b.mode, kind: 'practice', problem, language: b.language, source, customInput, receivedAt });
    res.status(202).json({ job: jobs.toClient(row) });
  });
  r.get('/submissions/:id', (req, res) => {
    const row = jobs.get(String(req.params.id));
    // Same response for "missing" and "someone else's", so ids cannot be probed.
    if (!row || row.guest_id !== req.guest.id) throw errors.notFound('Submission not found.', 'submission_not_found');
    res.json({ job: jobs.toClient(row) });
  });

  // ---- history ----
  r.get('/history', (req, res) => {
    const title = (id) => bank.get(id)?.title || id;
    const submissions = q.historyForGuest.all(req.guest.id, 200).map((s) => ({
      id: s.id, problemId: s.problem_id, problemTitle: title(s.problem_id), language: s.language, kind: s.kind,
      roomCode: s.room_code, status: s.status, verdict: s.verdict, receivedAt: s.received_at, finishedAt: s.finished_at,
    }));
    const matches = q.matchesForGuest.all(req.guest.id, 100).map((m) => {
      const result = m.result_json ? JSON.parse(m.result_json) : {};
      const mine = result.players?.find((p) => p.seat === m.my_seat);
      let outcome = m.outcome;
      if (outcome === 'win') outcome = m.winner_guest_id === req.guest.id ? 'won' : 'lost';
      return {
        roundId: m.id, roomCode: m.room_code, roundNumber: m.number, problemId: m.problem_id, problemTitle: title(m.problem_id),
        opponentName: m.opponent_name || '—', outcome, myStatus: mine?.status || null, reason: m.reason, startedAt: m.started_at, finishedAt: m.finished_at,
      };
    });
    res.json({ submissions, matches });
  });

  r.use((_req, _res, next) => next(errors.notFound('No such API route.', 'no_route')));
  return r;
}

export function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request is too large.' } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON.' } });
    log.error?.(`http: unexpected error: ${err.message}`);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on the server.' } });
  };
}
