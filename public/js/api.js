// API client. Pages call api('/api/...') and get the same JSON shapes from either backend:
//   * local    — the original Express server (fetch, same-origin cookie session)
//   * supabase — Supabase Auth (anonymous guest), Postgres RPCs (row-level security) and the
//                judge Edge Function. Errors become ApiError { status, code, message } in both.
import { CONFIG } from './config.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const isSupabase = CONFIG.backend === 'supabase';

export async function api(path, opts = {}) {
  if (isSupabase) return supabaseApi(path, opts);
  try {
    return await rawApi(path, opts);
  } catch (e) {
    // First visit: other requests can race ahead of GET /api/session. Establish
    // the (single, shared) session, then retry once.
    if (e.code === 'no_session' && path !== '/api/session') {
      await getSession();
      return rawApi(path, opts);
    }
    throw e;
  }
}

async function rawApi(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the Code Arena server. Check your connection.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code || 'http_' + res.status, err?.message || `Request failed (${res.status}).`);
  }
  return data;
}

let sessionPromise = null;
export function getSession(force = false) {
  if (!sessionPromise || force) {
    sessionPromise = isSupabase ? supabaseApi('/api/session') : rawApi('/api/session');
    sessionPromise.catch(() => { sessionPromise = null; }); // allow a retry after a network error
  }
  return sessionPromise;
}

// Random request id. crypto.getRandomValues works on plain-HTTP LAN pages too.
export function requestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Judge readiness for the banner. */
export async function judgeHealth() {
  if (isSupabase) return { ready: true, driver: 'wasm', languages: { python: { ready: true }, javascript: { ready: true } } };
  return fetch('/api/judge/health', { credentials: 'same-origin' }).then((r) => r.json());
}

// ---------------------------------------------------------------- Supabase backend

let clientPromise = null;
/** The shared supabase-js client (vendored UMD build, loaded on first use). */
export function supabaseClient() {
  if (!clientPromise) {
    clientPromise = new Promise((resolve, reject) => {
      if (window.supabase?.createClient) return resolve(window.supabase);
      const s = document.createElement('script');
      s.src = '/vendor/supabase.js';
      s.onload = () => resolve(window.supabase);
      s.onerror = () => reject(new ApiError(0, 'network', 'Cannot load Code Arena. Check your connection.'));
      document.head.append(s);
    }).then((lib) => lib.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'code-arena.auth' },
    }));
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

let authPromise = null;
/** Ensure there is a guest session (anonymous sign-in on first visit); returns the client. */
async function authed() {
  const sb = await supabaseClient();
  if (!authPromise) {
    authPromise = (async () => {
      const { data } = await sb.auth.getSession();
      if (data.session) return;
      const { error } = await sb.auth.signInAnonymously();
      if (error) {
        throw error.status === 429
          ? new ApiError(429, 'rate_limited', 'Too many new guests from this network right now. Wait a few minutes and reload.')
          : new ApiError(error.status || 0, 'no_session', 'Could not start a guest session. Reload the page to try again.');
      }
    })();
    authPromise.catch(() => { authPromise = null; });
  }
  await authPromise;
  return sb;
}

const toApiError = (error) => {
  if (!error) return new ApiError(500, 'server_error', 'Something went wrong on the server.');
  if (error instanceof ApiError) return error;
  if (error.hint && /^[a-z_]+$/.test(error.hint)) return new ApiError(Number(error.details) || 400, error.hint, error.message);
  if (error.code === 'PGRST301' || /JWT/i.test(error.message || '')) return new ApiError(401, 'no_session', 'Your session expired. Reload the page.');
  if (/fetch|network/i.test(error.message || '')) return new ApiError(0, 'network', 'Cannot reach the Code Arena server. Check your connection.');
  return new ApiError(500, 'server_error', 'Something went wrong on the server.');
};

export async function rpc(name, args = {}) {
  const sb = await authed();
  const { data, error } = await sb.rpc(name, args);
  if (error) throw toApiError(error);
  return data;
}

const b64 = (s) => { const u = new TextEncoder().encode(s); let out = ''; for (let i = 0; i < u.length; i += 8192) out += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(out); };

function jobFromRow(s) {
  const LABELS = { AC: 'Accepted', WA: 'Wrong Answer', CE: 'Compile/Syntax Error', RE: 'Runtime Error', TLE: 'Time Limit Exceeded', OLE: 'Output Limit Exceeded', MLE: 'Memory Limit Exceeded', JU: 'Judge Unavailable', OK: 'Finished' };
  const ms = (t) => (t ? Date.parse(t) : null);
  return { id: s.id, requestId: s.request_id, mode: s.mode, kind: s.kind, problemId: s.problem_id, language: s.language, roomCode: s.room_code, roundId: s.round_id,
    status: s.status, verdict: s.verdict, verdictLabel: s.verdict ? LABELS[s.verdict] : null, receivedAt: ms(s.received_at), finishedAt: ms(s.finished_at), result: s.result };
}

let docsCache = null;
async function supabaseApi(path, { method = 'GET', body } = {}) {
  const [route] = path.split('?');
  let m;
  if (route === '/api/session' && method === 'GET') return rpc('ca_session');
  if (route === '/api/session' && method === 'POST') return rpc('ca_rename', { display_name: body?.displayName ?? '' });
  if (route === '/api/problems') return rpc('ca_problems');
  if ((m = route.match(/^\/api\/problems\/([^/]+)$/))) return rpc('ca_problem', { problem_id: decodeURIComponent(m[1]) });
  if (route === '/api/recommendations') {
    const { buildIndex, recommend } = await import('./recommender.js');
    if (!docsCache) docsCache = (await rpc('ca_problems')).problems.map((p) => ({ id: p.id, number: p.number, title: p.title, difficulty: p.difficulty, tags: p.tags, primaryTopic: p.primaryTopic }));
    return recommend(buildIndex(docsCache), await rpc('ca_attempts'));
  }
  if (route === '/api/rooms/current') return rpc('ca_room_current');
  if (route === '/api/rooms' && method === 'POST') return rpc('ca_room_create', { difficulty: body?.difficulty || 'mixed' });
  if ((m = route.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/join$/))) return rpc('ca_room_join', { room_code: m[1] });
  if ((m = route.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/leave$/))) return rpc('ca_room_leave', { room_code: m[1] });
  if ((m = route.match(/^\/api\/rooms\/([A-Za-z0-9]{6})$/))) return { room: (await rpc('ca_room_snapshot', { room_code: m[1], heartbeat: false })).snapshot };
  if (route === '/api/history') return rpc('ca_history');
  if ((m = route.match(/^\/api\/submissions\/([0-9a-f-]{36})$/))) {
    const sb = await authed();
    const { data, error } = await sb.from('submissions').select('id,request_id,mode,kind,problem_id,language,room_code,round_id,status,verdict,received_at,finished_at,result').eq('id', m[1]).maybeSingle();
    if (error) throw toApiError(error);
    if (!data) throw new ApiError(404, 'submission_not_found', 'Submission not found.');
    return { job: jobFromRow(data) };
  }
  if (route === '/api/submissions' && method === 'POST') {
    const sb = await authed();
    const { data } = await sb.auth.getSession();
    const payload = { requestId: body.requestId, mode: body.mode, language: body.language, problemId: body.problemId, sourceB64: b64(body.source ?? ''),
      ...(body.customInput != null ? { customInputB64: b64(body.customInput) } : {}), ...(body.roomCode ? { roomCode: body.roomCode, roundId: body.roundId } : {}) };
    let res;
    try {
      res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/judge`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token}`, apikey: CONFIG.supabaseAnonKey }, body: JSON.stringify(payload) });
    } catch { throw new ApiError(0, 'network', 'Cannot reach the judge. Check your connection.'); }
    let out = null; try { out = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new ApiError(res.status, out?.error?.code || 'http_' + res.status, out?.error?.message || (res.status === 546 ? 'The judge is busy. Try again in a moment.' : `Request failed (${res.status}).`));
    return out;
  }
  throw new ApiError(404, 'no_route', 'No such API route.');
}
