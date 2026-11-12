// Test doubles: a fake clock and a scriptable fake judge driver.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProblemBank, ensureFixtures } from '../server/problems.js';
import { defaults } from '../server/config.js';

ensureFixtures();
export const bank = loadProblemBank();
const references = new Map();
for (const p of bank.list) references.set(p.id, (await import(pathToFileURL(path.join(p.dir, 'reference.js')).href)).solve);

export function testConfig(overrides = {}) {
  const merge = (a, b) => {
    const o = { ...a };
    for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
    return o;
  };
  return merge({ ...defaults, host: '127.0.0.1', port: 0, scratchDir: fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ca-test-')) }, overrides);
}

/** Manual clock: time only moves when advance() is called. */
export class FakeClock {
  constructor(start = 1_700_000_000_000) { this.t = start; this.timers = []; this.nextId = 1; }
  now() { return this.t; }
  setTimeout(fn, ms) { const id = this.nextId++; this.timers.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(id) { this.timers = this.timers.filter((x) => x.id !== id); }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

/**
 * Fake driver. The submitted source contains directives:
 *   #correct <problem-id>   print the reference answer
 *   #wrong                  print a wrong answer
 *   #echo                   print stdin back
 *   #crash / #tle           runtime error / time limit
 *   #compile-error          fail the compile step
 *   #infra                  Docker-style infrastructure failure
 *   #gate=<name>            wait until driver.release(name) before running
 */
export class FakeDriver {
  constructor() { this.name = 'fake'; this.gates = new Map(); this.runs = 0; }
  gate(name) {
    if (!this.gates.has(name)) { let release; const p = new Promise((r) => { release = r; }); this.gates.set(name, { p, release }); }
    return this.gates.get(name);
  }
  release(name) { this.gate(name).release(); }
  async checkReady() { return { ready: true, message: 'fake judge', languages: Object.fromEntries(['python', 'javascript', 'java', 'cpp', 'csharp'].map((l) => [l, { ready: true }])) }; }
  async cleanupOrphans() { return 0; }
  async shutdown() {}
  async listJudgeContainers() { return []; }
  async runContainer({ phase, srcDir, stdin }) {
    const file = fs.readdirSync(srcDir)[0];
    const src = fs.readFileSync(path.join(srcDir, file), 'utf8');
    const res = { exitCode: 0, stdout: '', stderr: '', timedOut: false, outputExceeded: false, oomKilled: false, durationMs: 5 };
    const gate = src.match(/#gate=(\w+)/);
    if (gate && phase === 'compile') await this.gate(gate[1]).p;
    if (src.includes('#infra')) return { ...res, infraError: 'fake docker failure' };
    if (phase === 'compile') return src.includes('#compile-error') ? { ...res, exitCode: 1, stderr: 'main.py: syntax error' } : res;
    this.runs++;
    if (src.includes('#tle')) return { ...res, timedOut: true, exitCode: 124 };
    if (src.includes('#crash')) return { ...res, exitCode: 1, stderr: 'Traceback: boom' };
    if (src.includes('#echo')) return { ...res, stdout: stdin };
    if (src.includes('#wrong')) return { ...res, stdout: 'WRONG\n' };
    const m = src.match(/#correct ([\w-]+)/);
    if (m) return { ...res, stdout: references.get(m[1])(stdin) };
    return { ...res, stdout: '' };
  }
}

export const until = async (fn, ms = 3000, every = 10) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, every));
  }
};
