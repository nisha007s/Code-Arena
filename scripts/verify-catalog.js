// Verifies the problem bank without Docker:
//  1. every problem has the required public/hidden case counts and private fields,
//  2. the JS reference passes every public example and hidden fixture,
//  3. the independent Python reference passes every case (run as a real process),
//  4. fixture checksums match problem-bank/fixtures.lock.json.
//
//   npm run check:catalog            (uses `python3`, or `python` on Windows)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadProblemBank, ensureFixtures, problemsRoot } from '../server/problems.js';
import { compareOutput } from '../server/judge/compare.js';

ensureFixtures();
const bank = loadProblemBank();
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const lock = JSON.parse(fs.readFileSync(path.join(problemsRoot, '..', 'fixtures.lock.json'), 'utf8'));
let failures = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };

if (bank.list.length !== 12) fail(`expected 12 problems, found ${bank.list.length}`);
for (const p of bank.list) {
  console.log(`${String(p.number).padStart(2)} ${p.title}`);
  const publicCases = p.tests.filter((t) => t.visibility === 'public');
  const hiddenCases = p.tests.filter((t) => t.visibility === 'hidden');
  if (publicCases.length < 2) fail(`${p.id}: needs at least 2 public examples`);
  if (hiddenCases.length < 4) fail(`${p.id}: needs at least 4 hidden cases`);
  if (!p.private?.complexity) fail(`${p.id}: missing private complexity guidance`);

  const { solve } = await import(pathToFileURL(path.join(p.dir, 'reference.js')).href);
  let pyMax = 0;
  for (const t of p.tests) {
    const input = bank.readInput(t), expected = bank.readExpected(t);
    if (compareOutput(solve(input), expected) !== true) fail(`${p.id} ${t.label}: JS reference mismatch`);
    const started = Date.now();
    const res = spawnSync(python, ['-I', path.join(p.dir, 'reference.py')], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    pyMax = Math.max(pyMax, Date.now() - started);
    if (res.error) { fail(`${p.id}: cannot run ${python}: ${res.error.message}`); break; }
    if (res.status !== 0) fail(`${p.id} ${t.label}: Python reference exited ${res.status}: ${res.stderr.slice(0, 200)}`);
    else if (compareOutput(res.stdout, expected) !== true) fail(`${p.id} ${t.label}: Python reference disagrees`);
  }
  for (const t of hiddenCases) {
    for (const ext of ['.in', '.out']) {
      const rel = path.relative(problemsRoot, t.base + ext).split(path.sep).join('/');
      const sha = crypto.createHash('sha256').update(fs.readFileSync(t.base + ext)).digest('hex');
      if (lock[rel] !== sha) fail(`${rel}: checksum differs from fixtures.lock.json`);
    }
  }
  console.log(`   ${publicCases.length} public + ${hiddenCases.length} hidden ok · slowest Python case ${pyMax} ms`);
}
if (failures) { console.error(`\n${failures} catalog check(s) failed`); process.exit(1); }
console.log('\nCatalog verified: all reference solutions pass every fixture.');
