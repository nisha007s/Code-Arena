// Configuration: safe defaults, optionally overridden by ./config.json (copy
// config.example.json) and a few environment variables / CLI flags.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const defaults = {
  host: '127.0.0.1',          // local only. `npm run start:lan` binds 0.0.0.0
  port: 3000,
  dataDir: 'data',            // SQLite database lives here (git-ignored)
  scratchDir: path.join(os.tmpdir(), 'code-arena-judge'), // per-job judge folders, deleted after each job
  secureCookies: false,       // set true when served over HTTPS
  trustProxy: false,
  match: {
    durationMs: 10 * 60 * 1000,  // 10-minute rounds
    settleMs: 100 * 1000,        // after the deadline, wait this long for timely jobs (> jobTimeoutMs)
    lobbyGraceMs: 2 * 60 * 1000, // disconnected lobby seats are reclaimed after this
    finishedRoomTtlMs: 30 * 60 * 1000,
  },
  limits: {
    displayName: 24,
    sourceBytes: 64 * 1024,
    customInputBytes: 64 * 1024,
    jsonBody: '200kb',
    socketPayloadBytes: 16 * 1024,
    joinsPerMinute: 20,
    executionsPerMinute: 12,
  },
  judge: {
    driver: 'docker',          // 'docker' (real sandbox). 'local' is test-only, see README.
    dockerBinary: 'docker',
    concurrency: 2,
    maxQueue: 16,              // practice work beyond this is rejected (queue_full)
    battleReserve: 6,          // extra queue slots kept for battle submissions
    battleSlots: 2,            // extra run slots only battle jobs may use, so they never wait behind practice
    jobTimeoutMs: 90 * 1000,   // hard cap on one job (compile + every case + retry)
    infraRetries: 1,           // retry once when Docker itself fails
    stderrBytes: 64 * 1024,
    customStdoutBytes: 64 * 1024,
    compileOutputBytes: 16 * 1024,
  },
};

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig({ argv = process.argv, env = process.env, overrides = {} } = {}) {
  let cfg = defaults;
  const file = path.join(projectRoot, env.CODE_ARENA_CONFIG || 'config.json');
  if (fs.existsSync(file)) cfg = merge(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  if (argv.includes('--lan')) cfg = merge(cfg, { host: '0.0.0.0' });
  if (env.HOST) cfg = merge(cfg, { host: env.HOST });
  if (env.PORT) cfg = merge(cfg, { port: Number(env.PORT) });
  if (env.JUDGE_DRIVER) cfg = merge(cfg, { judge: { driver: env.JUDGE_DRIVER } });
  if (env.MATCH_DURATION_MS) cfg = merge(cfg, { match: { durationMs: Number(env.MATCH_DURATION_MS) } });
  if (env.MATCH_SETTLE_MS) cfg = merge(cfg, { match: { settleMs: Number(env.MATCH_SETTLE_MS) } });
  if (env.CODE_ARENA_DATA) cfg = merge(cfg, { dataDir: env.CODE_ARENA_DATA, scratchDir: path.join(env.CODE_ARENA_DATA, 'judge-scratch') });
  cfg = merge(cfg, overrides);
  cfg.dataDir = path.resolve(projectRoot, cfg.dataDir);
  cfg.scratchDir = path.resolve(projectRoot, cfg.scratchDir);
  if (cfg.judge.driver === 'local') {
    // The local driver runs submitted code directly on this computer with no sandbox.
    if (env.CODE_ARENA_ALLOW_UNSANDBOXED !== '1') throw new Error('JUDGE_DRIVER=local requires CODE_ARENA_ALLOW_UNSANDBOXED=1 (test-only, unsandboxed).');
    if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') throw new Error('The unsandboxed local judge is only allowed on 127.0.0.1.');
  }
  return cfg;
}
