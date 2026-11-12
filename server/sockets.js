// Socket.IO: authorised room membership, lobby commands with acknowledgements,
// room snapshots and private submission notifications.
//
// Personal channel  guest:<id>  — every socket of one guest (several tabs) joins it.
// Snapshots are built per player, so opponents never receive each other's code,
// drafts, custom input, per-test results or diagnostics.
import { Server } from 'socket.io';
import { AppError } from './errors.js';
import { isSameOrigin, RateLimiter } from './security.js';

export function attachSockets({ httpServer, config, sessions, rooms, clock, log }) {
  const io = new Server(httpServer, {
    serveClient: true, // serves /socket.io/socket.io.esm.min.js from node_modules (no CDN)
    maxHttpBufferSize: config.limits.socketPayloadBytes,
    allowRequest: (req, cb) => cb(null, isSameOrigin(req, config.trustProxy)),
  });
  const limiter = new RateLimiter({ limit: 60, clock });

  io.use((socket, next) => {
    const guest = sessions.fromCookieHeader(socket.request.headers.cookie);
    if (!guest) return next(new Error('unauthorized'));
    socket.data.guest = guest;
    socket.data.rooms = new Set();
    socket.join(`guest:${guest.id}`);
    next();
  });

  const toError = (e) => (e instanceof AppError ? { code: e.code, message: e.message } : (log.error?.(`socket: ${e.message}`), { code: 'server_error', message: 'Something went wrong on the server.' }));
  const validCode = (p) => (p && typeof p === 'object' && typeof p.code === 'string' && /^[A-Za-z0-9]{6}$/.test(p.code) ? p.code.toUpperCase() : null);
  const validRequestId = (p) => (typeof p.requestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(p.requestId) ? p.requestId : undefined);

  io.on('connection', (socket) => {
    const guest = socket.data.guest;
    const handle = (event, fn) => socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!limiter.take(socket.id)) return reply({ ok: false, error: { code: 'rate_limited', message: 'Slow down a little.' } });
      const code = validCode(payload);
      if (!code) return reply({ ok: false, error: { code: 'invalid_code', message: 'Room codes have six letters or digits.' } });
      try { reply({ ok: true, ...fn(code, payload) }); } catch (e) { reply({ ok: false, error: toError(e) }); }
    });

    // Join the room's realtime channel and mark this tab present.
    handle('room:subscribe', (code) => {
      const room = socket.data.rooms.has(code) ? rooms.rooms.get(code) : rooms.connect(guest, code);
      if (!room) throw new AppError(404, 'room_not_found', 'That room does not exist or has expired.');
      socket.data.rooms.add(code);
      return { snapshot: rooms.snapshotFor(room, guest.id) };
    });
    // Re-sync (after a visibility change or a suspected gap) without changing presence.
    handle('room:snapshot', (code) => {
      const room = rooms.rooms.get(code);
      if (!room || !socket.data.rooms.has(code)) throw new AppError(403, 'not_member', 'Subscribe to the room first.');
      return { snapshot: rooms.snapshotFor(room, guest.id) };
    });
    handle('room:ready', (code, p) => rooms.setReady(guest, code, p.ready === true, validRequestId(p)));
    handle('room:start', (code, p) => rooms.start(guest, code, validRequestId(p)));
    handle('room:rematch', (code, p) => rooms.rematch(guest, code, validRequestId(p)));
    handle('room:leave', (code) => { rooms.leave(guest, code); socket.data.rooms.delete(code); return {}; });

    socket.on('disconnect', () => {
      for (const code of socket.data.rooms) rooms.disconnect(guest.id, code);
    });
  });

  return {
    io,
    emitRoom(room) {
      for (const s of room.seats) if (s) io.to(`guest:${s.guestId}`).emit('room:update', rooms.snapshotFor(room, s.guestId));
    },
    emitClosed(room, message) {
      for (const s of room.seats) if (s) io.to(`guest:${s.guestId}`).emit('room:closed', { code: room.code, message });
    },
    notifyGuest(guestId, job) {
      io.to(`guest:${guestId}`).emit('submission:update', job);
    },
  };
}
