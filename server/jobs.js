// Job service: records a Run or Submit, sends it to the judge, stores the
// privacy-safe result and notifies the author. Used for practice and battles.
import crypto from 'node:crypto';
import { VERDICTS } from './judge/runner.js';
import { QueueError } from './judge/index.js';
import { errors } from './errors.js';

// Strip everything the browser must not see. Hidden cases keep only pass/fail.
export function safeResult(raw) {
  const hidden = raw.cases.filter((c) => c.visibility === 'hidden');
  const failedHidden = hidden.find((c) => c.verdict !== 'AC');
  return {
    compile: raw.compile ? { ok: raw.compile.ok, output: raw.compile.output || '' } : null,
    cases: raw.cases.filter((c) => c.visibility !== 'hidden'),
    hidden: hidden.length ? (failedHidden ? { passed: false, verdict: failedHidden.verdict } : { passed: true }) : null,
    message: raw.message || null,
  };
}

export class JobService {
  constructor({ q, judge, bank, clock = Date, notify = () => {}, log = console }) {
    Object.assign(this, { q, judge, bank, clock, notify, log });
    this.seq = q.maxSeq.get().m;
    this.listeners = new Set(); // called with the row when a job finishes
  }

  nextSeq() { return ++this.seq; }

  findExisting(guestId, requestId) {
    return this.q.submissionByRequest.get(guestId, requestId) || null;
  }

  get(id) { return this.q.submissionById.get(id) || null; }

  onFinished(fn) { this.listeners.add(fn); }

  /**
   * Insert the record, then admit it to the judge queue. If the queue refuses,
   * the record is removed and the error is thrown, so nothing half-exists.
   */
  start({ guestId, requestId, mode, kind, problem, language, source, customInput = null, roomCode = null, roundId = null, receivedAt, seq = this.nextSeq() }) {
    const id = crypto.randomUUID();
    this.q.insertSubmission.run(id, guestId, requestId, mode, kind, problem.id, language, roomCode, roundId, source, seq, receivedAt);
    let promise;
    try {
      promise = this.judge.enqueue({
        problem, language, source, mode, customInput, battle: kind === 'battle',
        onStart: () => {
          this.q.setSubmissionStatus.run('judging', id);
          const row = this.get(id);
          if (row) this.notify(guestId, this.toClient(row));
        },
      });
    } catch (e) {
      this.q.deleteSubmission.run(id);
      if (e instanceof QueueError) {
        throw e.code === 'queue_full' ? errors.unavailable(e.message, 'queue_full') : errors.badRequest(e.message, e.code);
      }
      throw e;
    }
    promise
      .catch((e) => {
        this.log.error?.(`judge: job ${id} failed unexpectedly: ${e.message}`);
        return { verdict: 'JU', compile: null, cases: [], message: 'The judge hit an unexpected error.' };
      })
      .then((raw) => this.#finish(id, raw));
    return this.get(id);
  }

  #finish(id, raw) {
    const safe = safeResult(raw);
    this.q.finishSubmission.run(raw.verdict, JSON.stringify(safe), this.clock.now(), id);
    const row = this.get(id);
    this.notify(row.guest_id, this.toClient(row));
    for (const fn of this.listeners) {
      try { fn(row); } catch (e) { this.log.error?.(`job listener failed: ${e.message}`); }
    }
  }

  // Jobs that were queued or running when the server stopped become Judge Unavailable.
  recoverInterrupted() {
    const rows = this.q.unfinishedSubmissions.all();
    const result = JSON.stringify({ compile: null, cases: [], hidden: null, message: 'The server restarted before this job finished. Please submit again.' });
    for (const r of rows) this.q.finishSubmission.run('JU', result, this.clock.now(), r.id);
    return rows.length;
  }

  toClient(row) {
    const result = row.result_json ? JSON.parse(row.result_json) : null;
    return {
      id: row.id,
      requestId: row.request_id,
      mode: row.mode,
      kind: row.kind,
      problemId: row.problem_id,
      language: row.language,
      roomCode: row.room_code,
      roundId: row.round_id,
      status: row.status,
      verdict: row.verdict,
      verdictLabel: row.verdict ? (row.verdict === 'OK' ? 'Finished' : VERDICTS[row.verdict]) : null,
      receivedAt: row.received_at,
      finishedAt: row.finished_at,
      result,
    };
  }
}
