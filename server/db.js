// SQLite persistence with node:sqlite and prepared statements only.
// The schema is created automatically on startup.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS guests (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,     -- sha256 of the cookie secret, never the secret itself
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  code             TEXT PRIMARY KEY,
  host_guest_id    TEXT NOT NULL REFERENCES guests(id),
  difficulty       TEXT NOT NULL,
  status           TEXT NOT NULL,          -- open | closed
  last_problem_id  TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_participants (
  room_code  TEXT NOT NULL REFERENCES rooms(code),
  seat       INTEGER NOT NULL,             -- 0 = host, 1 = guest
  guest_id   TEXT NOT NULL REFERENCES guests(id),
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (room_code, seat)
);

CREATE TABLE IF NOT EXISTS rounds (
  id               TEXT PRIMARY KEY,
  room_code        TEXT NOT NULL REFERENCES rooms(code),
  number           INTEGER NOT NULL,
  problem_id       TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  deadline         INTEGER NOT NULL,
  status           TEXT NOT NULL,          -- active | judging | finished
  outcome          TEXT,                   -- win | draw | void
  winner_guest_id  TEXT,
  reason           TEXT,
  result_json      TEXT,
  finished_at      INTEGER
);

CREATE TABLE IF NOT EXISTS round_players (
  round_id      TEXT NOT NULL REFERENCES rounds(id),
  seat          INTEGER NOT NULL,
  guest_id      TEXT NOT NULL REFERENCES guests(id),
  display_name  TEXT NOT NULL,
  PRIMARY KEY (round_id, seat)
);

CREATE TABLE IF NOT EXISTS submissions (
  id           TEXT PRIMARY KEY,
  guest_id     TEXT NOT NULL REFERENCES guests(id),
  request_id   TEXT NOT NULL,
  mode         TEXT NOT NULL,              -- run | submit
  kind         TEXT NOT NULL,              -- practice | battle
  problem_id   TEXT NOT NULL,
  language     TEXT NOT NULL,
  room_code    TEXT,
  round_id     TEXT,
  source       TEXT NOT NULL,
  status       TEXT NOT NULL,              -- queued | judging | done
  verdict      TEXT,
  seq          INTEGER NOT NULL,           -- monotonic server sequence (tie-breaker)
  received_at  INTEGER NOT NULL,
  finished_at  INTEGER,
  result_json  TEXT,                       -- privacy-safe result only
  UNIQUE (guest_id, request_id)
);
CREATE INDEX IF NOT EXISTS submissions_guest ON submissions (guest_id, received_at);
CREATE INDEX IF NOT EXISTS submissions_round ON submissions (round_id);
`;

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const s = (sql) => db.prepare(sql);
  const q = {
    insertGuest: s('INSERT INTO guests (id, token_hash, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'),
    guestByToken: s('SELECT * FROM guests WHERE token_hash = ?'),
    guestById: s('SELECT * FROM guests WHERE id = ?'),
    touchGuest: s('UPDATE guests SET last_seen_at = ? WHERE id = ?'),
    renameGuest: s('UPDATE guests SET display_name = ? WHERE id = ?'),

    insertRoom: s('INSERT INTO rooms (code, host_guest_id, difficulty, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    roomExists: s('SELECT 1 AS x FROM rooms WHERE code = ?'),
    updateRoom: s('UPDATE rooms SET status = ?, last_problem_id = ?, updated_at = ? WHERE code = ?'),
    openRooms: s("SELECT * FROM rooms WHERE status = 'open' AND updated_at > ?"),
    closeStaleRooms: s("UPDATE rooms SET status = 'closed' WHERE status = 'open' AND updated_at <= ?"),
    insertSeat: s('INSERT OR REPLACE INTO room_participants (room_code, seat, guest_id, joined_at) VALUES (?, ?, ?, ?)'),
    deleteSeat: s('DELETE FROM room_participants WHERE room_code = ? AND seat = ?'),
    seatsForRoom: s('SELECT * FROM room_participants WHERE room_code = ? ORDER BY seat'),

    insertRound: s("INSERT INTO rounds (id, room_code, number, problem_id, started_at, deadline, status) VALUES (?, ?, ?, ?, ?, ?, 'active')"),
    setRoundStatus: s('UPDATE rounds SET status = ? WHERE id = ? AND status != ?'),
    finishRound: s("UPDATE rounds SET status = 'finished', outcome = ?, winner_guest_id = ?, reason = ?, result_json = ?, finished_at = ? WHERE id = ? AND status != 'finished'"),
    latestRound: s('SELECT * FROM rounds WHERE room_code = ? ORDER BY number DESC LIMIT 1'),
    interruptedRounds: s("SELECT * FROM rounds WHERE status IN ('active', 'judging')"),

    insertSubmission: s(`INSERT INTO submissions (id, guest_id, request_id, mode, kind, problem_id, language, room_code, round_id, source, status, seq, received_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`),
    submissionByRequest: s('SELECT * FROM submissions WHERE guest_id = ? AND request_id = ?'),
    submissionById: s('SELECT * FROM submissions WHERE id = ?'),
    deleteSubmission: s('DELETE FROM submissions WHERE id = ?'),
    setSubmissionStatus: s('UPDATE submissions SET status = ? WHERE id = ?'),
    finishSubmission: s("UPDATE submissions SET status = 'done', verdict = ?, result_json = ?, finished_at = ? WHERE id = ?"),
    unfinishedSubmissions: s("SELECT id FROM submissions WHERE status != 'done'"),
    submissionsForRound: s('SELECT * FROM submissions WHERE round_id = ? ORDER BY seq'),
    maxSeq: s('SELECT COALESCE(MAX(seq), 0) AS m FROM submissions'),
    historyForGuest: s(`SELECT id, mode, kind, problem_id, language, room_code, round_id, status, verdict, received_at, finished_at
                        FROM submissions WHERE guest_id = ? AND mode = 'submit' ORDER BY received_at DESC, seq DESC LIMIT ?`),
    attemptsForGuest: s(`SELECT problem_id, verdict, received_at, seq FROM submissions
                         WHERE guest_id = ? AND mode = 'submit' AND status = 'done' ORDER BY seq`),
    solvedForGuest: s("SELECT DISTINCT problem_id FROM submissions WHERE guest_id = ? AND mode = 'submit' AND verdict = 'AC'"),
    insertRoundPlayer: s('INSERT INTO round_players (round_id, seat, guest_id, display_name) VALUES (?, ?, ?, ?)'),
    roundPlayers: s('SELECT * FROM round_players WHERE round_id = ? ORDER BY seat'),
    matchesForGuest: s(`SELECT r.id, r.room_code, r.number, r.problem_id, r.outcome, r.winner_guest_id, r.reason, r.result_json, r.started_at, r.finished_at,
                               me.seat AS my_seat, opp.display_name AS opponent_name
                        FROM rounds r
                        JOIN round_players me ON me.round_id = r.id AND me.guest_id = ?
                        LEFT JOIN round_players opp ON opp.round_id = r.id AND opp.seat != me.seat
                        WHERE r.status = 'finished'
                        ORDER BY r.finished_at DESC LIMIT ?`),
  };

  // Run fn inside a transaction (BEGIN IMMEDIATE … COMMIT / ROLLBACK).
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  return { db, q, tx, close: () => db.close() };
}
