// Wires every service together on one HTTP server. Used by server/index.js and by tests.
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { projectRoot } from './config.js';
import { openDatabase } from './db.js';
import { loadProblemBank, ensureFixtures } from './problems.js';
import { Sessions } from './sessions.js';
import { Judge, createDriver } from './judge/index.js';
import { JobService } from './jobs.js';
import { RoomService } from './rooms.js';
import { buildIndex } from './recommender.js';
import { apiRouter, errorHandler } from './http.js';
import { attachSockets } from './sockets.js';
import { securityHeaders } from './security.js';

const quietLog = { info: () => {}, warn: () => {}, error: () => {} };
const consoleLog = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

/**
 * @param {object} config  from loadConfig()
 * @param {object} [deps]  test seams: { clock, driver, dbFile, log, random }
 */
export function createApp(config, deps = {}) {
  const log = deps.log || (deps.quiet ? quietLog : consoleLog);
  const clock = deps.clock || { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
  ensureFixtures();
  const bank = loadProblemBank();
  const { q, tx, close: closeDb } = openDatabase(deps.dbFile || path.join(config.dataDir, 'code-arena.sqlite'));
  const sessions = new Sessions({ q, clock, secure: config.secureCookies });
  const instanceId = crypto.randomBytes(3).toString('hex');
  const driver = deps.driver || createDriver(config, instanceId, log);
  const judge = new Judge({ config, driver, bank, log });

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);
  const httpServer = http.createServer(app);

  let realtime = null;
  const jobs = new JobService({ q, judge, bank, clock, log, notify: (guestId, job) => realtime?.notifyGuest(guestId, job) });
  const rooms = new RoomService({
    q, tx, bank, jobs, config, clock, log, random: deps.random,
    onChange: (room) => realtime?.emitRoom(room),
    onClosed: (room, msg) => realtime?.emitClosed(room, msg),
  });
  realtime = attachSockets({ httpServer, config, sessions, rooms, clock, log });
  const recIndex = buildIndex(bank.recommenderDocs());

  app.use(securityHeaders(config.secureCookies));
  app.use('/api', apiRouter({ config, clock, q, bank, sessions, judge, jobs, rooms, recIndex }));
  app.use(express.static(path.join(projectRoot, 'public'), { extensions: ['html'], index: 'index.html' }));
  app.use(errorHandler(log));

  let sweeper = null;
  return {
    app, httpServer, io: realtime.io, services: { q, bank, sessions, judge, jobs, rooms, driver },
    async start() {
      const voidedJobs = jobs.recoverInterrupted();
      rooms.recover();
      if (voidedJobs) log.info(`recovered ${voidedJobs} interrupted job(s) as Judge Unavailable`);
      await judge.start();
      sweeper = setInterval(() => rooms.sweep(), 15000);
      sweeper.unref();
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, resolve);
      });
      return httpServer.address();
    },
    async stop() {
      clearInterval(sweeper);
      realtime.io.close();
      await judge.stop();
      httpServer.closeAllConnections?.();
      await new Promise((r) => httpServer.close(() => r()));
      closeDb();
    },
  };
}
