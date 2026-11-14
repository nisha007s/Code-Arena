// judge: the only public entry point for running code.
//
// Browser mode (Authorization: Bearer <user access token>):
//   1. verifies the token with Supabase Auth, 2. admits the Run/Submit through
//   public.ca_submission_create (rate limit, one pending job, battle rules, quota guard),
//   3. replies 202 with the job, 4. judges in the background and stores a privacy-safe
//   result with public.ca_submission_finish. The browser polls its own submission row (RLS).
// Admin test mode (x-admin-key): runs the same pipeline without storing anything and
//   returns diagnostics (used by the acceptance tests in scripts/supabase/).
//
// Classification of runner replies (no retry for anything student code can cause):
//   200 + x-ca-runner + verdict  -> final student result
//   546 WORKER_RESOURCE_LIMIT    -> final "TLE: time or memory limit exceeded". Lanes guarantee
//                                   one request per runner worker, so a 546 is the request's own.
//   anything else                -> infrastructure: one retry, then Judge Unavailable (JU).
import META from './meta.json' with { type: 'json' };

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
type Lim = { javascript: number; python: number };
type Meta = { problems: Record<string, { pyKind: 'pya' | 'pyb'; examples: { label: string; input: string; expected: string }[]; hiddenCount: number; limits: Lim }> };
const meta = META as Meta;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const RUNNER_KEY = Deno.env.get('RUNNER_KEY') || '';
const ADMIN_KEY = Deno.env.get('JUDGE_ADMIN_KEY') || '';
const ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean);
const STALL_MS = 8000, LANE_WAIT_MS = 30000, JOB_BUDGET_MS = 75000, MAX_CALLS = 20;

const enc = new TextEncoder();
const b64decode = (x: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(x), (c) => c.charCodeAt(0)));
// Chunked: spreading a 64 KB array into String.fromCharCode can overflow the call stack.
const b64encode = (s: string) => { const u = enc.encode(s); let out = ''; for (let i = 0; i < u.length; i += 8192) out += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(out); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function eq(a: string | null, b: string) { if (!a || b.length < 32 || a.length !== b.length) return false; let d = 0; for (let i = 0; i < b.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

function originAllowed(origin: string | null) {
  if (!origin) return false;
  if (!ORIGINS.length) return true;
  return ORIGINS.some((o) => o === origin || (o.includes('*') && new RegExp('^' + o.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+') + '$').test(origin)));
}
function cors(req: Request): Record<string, string> {
  const o = req.headers.get('origin');
  return originAllowed(o) ? { 'access-control-allow-origin': o!, 'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info', 'access-control-allow-methods': 'POST, OPTIONS', 'vary': 'origin' } : {};
}
const reply = (req: Request, status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) } });
const fail = (req: Request, status: number, code: string, message: string) => reply(req, status, { error: { code, message } });

async function rpc(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) { const e = new Error(data?.message || `rpc ${name} failed`) as Error & { code?: string; status?: number }; e.code = data?.hint || 'server_error'; e.status = Number(data?.details) || 500; throw e; }
  return data;
}

// ---------------------------------------------------------------- the pipeline
type Attempt = { status: number; ms: number; cls: 'student' | 'resource' | 'infra'; lane?: string; why?: string };
type Job = { id: string; problemId: string; language: 'python' | 'javascript'; mode: 'run' | 'submit'; source: string; customInput: string | null; battle: boolean };

async function callLane(job: Job, test: string, timeMs: number, attempts: Attempt[], deadline: number, fault?: string) {
  const kind = job.language === 'javascript' ? 'js' : meta.problems[job.problemId].pyKind;
  const t0 = performance.now();
  let lane: string | null = null;
  while (!lane) {
    lane = await rpc('ca_lane_acquire', { lane_kind: kind, holder: job.id, battle: job.battle });
    if (!lane) {
      if (performance.now() - t0 > LANE_WAIT_MS || Date.now() > deadline) { attempts.push({ status: 0, ms: Math.round(performance.now() - t0), cls: 'infra', why: 'no free runner lane' }); return { kind: 'infra' as const }; }
      await sleep(120 + Math.random() * 120);
    }
  }
  const target = fault === 'missing-function' ? 'ca-no-such-function' : lane;
  const key = fault === 'wrong-key' ? 'x'.repeat(RUNNER_KEY.length) : RUNNER_KEY;
  const body = { problemId: job.problemId, test, sourceB64: b64encode(job.source), customInputB64: job.customInput != null ? b64encode(job.customInput) : undefined, timeMs, ...(fault === 'stall' ? { testStallMs: 12000 } : {}) };
  let s0 = performance.now();
  try {
    // A cold runner worker first replies { warming: true } without running the code (see
    // runner-core.ts); send the same test again while holding the lane, at most twice.
    let res: Response, text: string, warmups = 0;
    for (;;) {
      s0 = performance.now();
      res = await fetch(`${SUPABASE_URL}/functions/v1/${target}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-runner-key': key }, body: JSON.stringify({ ...body, skipWarm: warmups >= 2 }), signal: AbortSignal.timeout(STALL_MS) });
      text = await res.text();
      if (res.status === 200 && res.headers.get('x-ca-runner') === '1' && /^{"warming":true}$/.test(text)) { attempts.push({ status: 200, ms: Math.round(performance.now() - s0), cls: 'student', lane, why: 'warm-up (code not run)' }); warmups++; continue; }
      break;
    }
    const ms = Math.round(performance.now() - s0);
    if (res.status === 200 && res.headers.get('x-ca-runner') === '1') {
      try { const j = JSON.parse(text); if (typeof j.verdict === 'string') { attempts.push({ status: 200, ms, cls: 'student', lane }); return { kind: 'result' as const, j }; } } catch { /* malformed */ }
      attempts.push({ status: 200, ms, cls: 'infra', lane, why: 'malformed runner reply' }); return { kind: 'infra' as const };
    }
    if (res.status === 546 && /WORKER_RESOURCE_LIMIT/.test(text)) { attempts.push({ status: 546, ms, cls: 'resource', lane }); return { kind: 'resource' as const }; }
    attempts.push({ status: res.status, ms, cls: 'infra', lane, why: (res.headers.get('x-ca-runner') ? 'runner ' : 'platform ') + text.slice(0, 80) });
    return { kind: 'infra' as const };
  } catch (e) {
    attempts.push({ status: 0, ms: Math.round(performance.now() - s0), cls: 'infra', lane, why: String((e as Error)?.name || e) });
    return { kind: 'infra' as const };
  } finally {
    await rpc('ca_lane_release', { lane, holder: job.id }).catch(() => {});
  }
}

async function judgeJob(job: Job, opts: { timeMsOverride?: number; faults?: Record<string, string> } = {}) {
  const p = meta.problems[job.problemId];
  const timeMs = opts.timeMsOverride || p.limits[job.language];
  const deadline = Date.now() + JOB_BUDGET_MS;
  const tests = job.customInput != null ? ['custom']
    : [...p.examples.map((_, i) => `public-${i + 1}`), ...(job.mode === 'submit' ? Array.from({ length: p.hiddenCount }, (_, i) => `hidden-${i + 1}`) : [])];
  const attempts: Attempt[] = [];
  const perTest: { test: string; verdict: string; timeMs: number | null }[] = [];
  const cases: Record<string, unknown>[] = [];
  let verdict = job.customInput != null ? 'OK' : 'AC', hiddenFail: string | null = null, hiddenRan = false, message: string | null = null;
  for (const test of tests) {
    let r = await callLane(job, test, timeMs, attempts, deadline, opts.faults?.[test]);
    if (r.kind === 'infra' && attempts.length < MAX_CALLS && Date.now() < deadline) r = await callLane(job, test, timeMs, attempts, deadline, opts.faults?.[test]); // exactly one retry, infrastructure only
    if (r.kind === 'infra') { verdict = 'JU'; message = 'The judge is unavailable right now. Please try again in a moment.'; cases.length = 0; hiddenFail = null; hiddenRan = false; break; }
    const v: string = r.kind === 'result' ? r.j.verdict : 'TLE';
    if (r.kind === 'resource') message = 'Time or memory limit exceeded.';
    const t = r.kind === 'result' ? r.j.timeMs : null;
    perTest.push({ test, verdict: v, timeMs: t });
    if (test === 'custom') {
      cases.push({ visibility: 'custom', label: 'Custom input', verdict: v, stdout: r.kind === 'result' ? r.j.stdout : '', stderr: r.kind === 'result' ? r.j.stderr : '', exitCode: null, timeMs: t });
      verdict = v; break;
    }
    if (test.startsWith('public-')) {
      const ex = p.examples[Number(test.slice(7)) - 1];
      cases.push({ visibility: 'public', label: ex.label, verdict: v, input: ex.input, expected: ex.expected, stdout: r.kind === 'result' ? r.j.stdout : '', stderr: r.kind === 'result' ? r.j.stderr : '', exitCode: null, timeMs: t });
    } else { hiddenRan = true; if (v !== 'AC' && !hiddenFail) hiddenFail = v; }
    if (v !== 'AC' && verdict === 'AC') verdict = v;
    if (v !== 'AC' && job.mode === 'submit') break;
  }
  const result = { compile: null, cases, hidden: hiddenFail ? { passed: false, verdict: hiddenFail } : hiddenRan ? { passed: true } : null, message };
  return { verdict, result, attempts, perTest, timeMs };
}

// ---------------------------------------------------------------- HTTP
function parseBody(b: any) {
  if (!b || typeof b !== 'object') throw ['bad_request', 'Request body is not valid JSON.'];
  if (b.mode !== 'run' && b.mode !== 'submit') throw ['bad_request', 'mode must be run or submit.'];
  if (b.language !== 'python' && b.language !== 'javascript') throw ['invalid_language', 'Unknown language.'];
  if (typeof b.sourceB64 !== 'string' || b.sourceB64.length > 90000) throw ['too_large', 'Source code is too large (64 KB maximum).'];
  let source: string, customInput: string | null = null;
  try { source = b64decode(b.sourceB64); } catch { throw ['bad_request', 'Source code is not valid UTF-8.']; }
  if (enc.encode(source).length > 65536) throw ['too_large', 'Source code is too large (64 KB maximum).'];
  if (!source.trim()) throw ['empty_source', 'Write some code before running it.'];
  if (b.customInputB64 != null) {
    if (b.mode !== 'run') throw ['bad_request', 'Custom input is only used with Run.'];
    if (typeof b.customInputB64 !== 'string' || b.customInputB64.length > 90000) throw ['too_large', 'Custom input is too large (64 KB maximum).'];
    try { customInput = b64decode(b.customInputB64); } catch { throw ['bad_request', 'Custom input is not valid UTF-8.']; }
    if (enc.encode(customInput).length > 65536) throw ['too_large', 'Custom input is too large (64 KB maximum).'];
  }
  return { source, customInput };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return fail(req, 405, 'method_not_allowed', 'Use POST.');
  let b: any;
  try { b = await req.json(); } catch { return fail(req, 400, 'bad_json', 'Request body is not valid JSON.'); }
  let parsed: { source: string; customInput: string | null };
  try { parsed = parseBody(b); } catch (e) { const [code, msg] = e as [string, string]; return fail(req, code === 'too_large' ? 413 : 400, code, msg); }

  // ---- admin test mode (no storage; diagnostics) ----
  if (req.headers.get('x-admin-key') !== null) {
    if (!eq(req.headers.get('x-admin-key'), ADMIN_KEY)) return new Response('Not found', { status: 404 });
    if (!meta.problems[b.problemId]) return fail(req, 400, 'problem_not_found', 'Problem not found.');
    const job: Job = { id: crypto.randomUUID(), problemId: b.problemId, language: b.language, mode: b.mode, source: parsed.source, customInput: parsed.customInput, battle: Boolean(b.battle) };
    const out = await judgeJob(job, { timeMsOverride: Number(b.timeMsOverride) || undefined, faults: b.faults });
    return reply(req, 200, { verdict: out.verdict, ...out.result, diagnostics: { calls: out.attempts.length, attempts: out.attempts, perTest: out.perTest, timeMs: out.timeMs } });
  }

  // ---- browser mode ----
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return fail(req, 401, 'no_session', 'Sign in first.');
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${token}` } });
  if (!who.ok) return fail(req, 401, 'no_session', 'Your session expired. Reload the page.');
  const user = await who.json();
  if (typeof b.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(b.requestId)) return fail(req, 400, 'bad_request', 'Invalid request id.');
  if (b.roomCode != null && (typeof b.roomCode !== 'string' || !/^[A-Za-z0-9]{6}$/.test(b.roomCode))) return fail(req, 400, 'invalid_code', 'Room codes have six letters or digits.');
  const battle = b.mode === 'submit' && b.roomCode != null;
  if (!battle && !meta.problems[b.problemId]) return fail(req, 404, 'problem_not_found', 'Problem not found.');
  let admitted: { job: any; duplicate: boolean };
  try {
    admitted = await rpc('ca_submission_create', {
      uid: user.id, request_id: b.requestId, mode: b.mode, problem_id: battle ? null : b.problemId, language: b.language,
      source_b64: b64encode(parsed.source), custom_input_b64: parsed.customInput != null ? b64encode(parsed.customInput) : null, room_code: battle ? b.roomCode.toUpperCase() : null, round_id: battle ? String(b.roundId || '') || null : null,
    });
  } catch (e) {
    const err = e as Error & { code?: string; status?: number };
    return fail(req, err.status && err.status < 600 ? err.status : 500, err.code || 'server_error', err.status ? err.message : 'Something went wrong on the server.');
  }
  if (admitted.duplicate) return reply(req, 200, { job: admitted.job, duplicate: true });
  const row = admitted.job;
  const job: Job = { id: row.id, problemId: row.problemId, language: row.language, mode: row.mode, source: parsed.source, customInput: parsed.customInput, battle: row.kind === 'battle' };
  const work = (async () => {
    let out: { verdict: string; result: unknown; attempts: Attempt[] };
    try { out = await judgeJob(job); }
    catch { out = { verdict: 'JU', result: { compile: null, cases: [], hidden: null, message: 'The judge hit an unexpected error. Please try again.' }, attempts: [] }; }
    for (let i = 0; i < 3; i++) {
      try { await rpc('ca_submission_finish_b64', { submission_id: job.id, verdict: out.verdict, result_b64: b64encode(JSON.stringify(out.result)), calls: out.attempts.length }); break; }
      catch { await sleep(500 * (i + 1)); }
    }
  })();
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work); else work.catch(() => {});
  return reply(req, 202, { job: row });
});
