// Room realtime connection with the small Socket.IO surface the Arena page uses:
//   on(event, fn), emit(event, payload, ack), timeout(ms).emit(...), connected.
// local    -> the original Socket.IO client served by the Express backend.
// supabase -> Supabase Realtime (Postgres change notifications on the rooms row, filtered by
//             row-level security) + room RPCs. Each notification or heartbeat fetches this
//             player's own snapshot, so opponents never receive each other's code.
import { isSupabase, rpc, supabaseClient, ApiError } from './api.js';

export async function connectRoomSocket() {
  if (!isSupabase) {
    const { io } = await import('/socket.io/socket.io.esm.min.js');
    return io({ transports: ['websocket', 'polling'], tryAllTransports: true });
  }
  return new SupabaseRoomSocket();
}

const HEARTBEAT_MS = 10000;

class SupabaseRoomSocket {
  constructor() {
    this.handlers = new Map();
    this.connected = false;
    this.code = null;
    this.channel = null;
    this.lastRevision = -1;
    this.heartbeat = null;
    this.deadlineTimer = null;
    this.fetching = null;
    setTimeout(() => this.#open(), 0); // after the page has attached its handlers
  }

  on(event, fn) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(fn); return this; }
  #fire(event, ...args) { for (const fn of this.handlers.get(event) || []) { try { fn(...args); } catch (e) { console.error(e); } } }

  async #open() {
    try {
      await supabaseClient();
      this.connected = true;
      this.#fire('connect');
    } catch { this.#fire('connect_error'); }
  }

  timeout(ms) { return { emit: (event, payload, cb) => this.#command(event, payload, ms).then((res) => cb(null, res), (err) => cb(err)) }; }

  emit(event, payload, ack) {
    this.#command(event, payload, 15000).then((res) => ack?.(res), () => ack?.({ ok: false, error: { code: 'network', message: 'The server did not answer. Check your connection.' } }));
  }

  async #command(event, p = {}, ms = 15000) {
    const run = async () => {
      try {
        const code = p.code;
        switch (event) {
          case 'room:subscribe': {
            const snapshot = await this.#snapshot(code, true);
            await this.#subscribe(code);
            return { ok: true, snapshot };
          }
          case 'room:snapshot': return { ok: true, snapshot: await this.#snapshot(code, true) };
          case 'room:ready': return { ok: true, ...(await rpc('ca_room_ready', { room_code: code, ready: p.ready === true, request_id: p.requestId || null })) };
          case 'room:start': return { ok: true, ...(await rpc('ca_room_start', { room_code: code, request_id: p.requestId || null })) };
          case 'room:rematch': return { ok: true, ...(await rpc('ca_room_rematch', { room_code: code, request_id: p.requestId || null })) };
          case 'room:leave': { await rpc('ca_room_leave', { room_code: code }); this.#unsubscribe(); return { ok: true }; }
          default: return { ok: false, error: { code: 'bad_event', message: 'Unknown command.' } };
        }
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(500, 'server_error', 'Something went wrong on the server.');
        return { ok: false, error: { code: err.code, message: err.message } };
      } finally {
        if (event !== 'room:subscribe' && event !== 'room:snapshot' && event !== 'room:leave') this.#refresh(); // show the effect immediately
      }
    };
    return Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  }

  async #snapshot(code, heartbeat) {
    const { snapshot } = await rpc('ca_room_snapshot', { room_code: code, heartbeat });
    if (snapshot.phase === 'closed') {
      this.#unsubscribe();
      this.#fire('room:closed', { code: snapshot.code, message: snapshot.closedMessage || 'The room was closed.' });
      throw new ApiError(404, 'room_not_found', snapshot.closedMessage || 'The room was closed.');
    }
    this.#scheduleDeadline(snapshot);
    return snapshot;
  }

  // One snapshot fetch at a time; pushes updates to the page as 'room:update'.
  #refresh(heartbeat = false) {
    if (!this.code) return;
    if (this.fetching) { this.again = true; return; }
    const code = this.code;
    this.fetching = this.#snapshot(code, heartbeat)
      .then((s) => { if (s.code === this.code) this.#fire('room:update', s); if (!this.connected) { this.connected = true; this.#fire('connect'); } })
      .catch((e) => { if (e?.code === 'network' && this.connected) { this.connected = false; this.#fire('disconnect'); } else if (e?.code === 'not_member' || e?.code === 'room_not_found') this.#unsubscribe(); })
      .finally(() => { this.fetching = null; if (this.again) { this.again = false; this.#refresh(); } });
  }

  // Ask for a fresh snapshot just after the round deadline / settle deadline passes.
  #scheduleDeadline(s) {
    clearTimeout(this.deadlineTimer);
    const at = s.phase === 'active' ? s.round?.deadline : s.phase === 'judging' ? s.round?.settleDeadline : null;
    if (at) this.deadlineTimer = setTimeout(() => this.#refresh(true), Math.max(0, at - s.serverTime) + 1200);
  }

  async #subscribe(code) {
    if (this.code === code && this.channel) return;
    this.#unsubscribe();
    this.code = code;
    const sb = await supabaseClient();
    this.channel = sb.channel(`room-${code}-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${code}` }, () => this.#refresh())
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { if (!this.connected) { this.connected = true; this.#fire('connect'); } this.#refresh(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { /* heartbeat keeps the page in sync; Realtime retries on its own */ }
      });
    // Heartbeat: marks this player connected, advances the clock server-side and resyncs if a
    // notification was missed. Paused while the tab is hidden (the server then sees a disconnect).
    this.heartbeat = setInterval(() => { if (document.visibilityState === 'visible') this.#refresh(true); }, HEARTBEAT_MS);
  }

  #unsubscribe() {
    clearInterval(this.heartbeat); this.heartbeat = null;
    clearTimeout(this.deadlineTimer);
    const ch = this.channel;
    if (ch) { supabaseClient().then((sb) => sb.removeChannel(ch)).catch(() => {}); this.channel = null; }
    this.code = null;
  }
}
