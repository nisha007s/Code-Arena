// Tiny fetch wrapper for the JSON API. Errors become ApiError { status, code, message }.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, opts = {}) {
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
    sessionPromise = rawApi('/api/session');
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
