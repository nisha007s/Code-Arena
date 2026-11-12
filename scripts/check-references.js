// Submits the Python and JavaScript reference solutions for all 12 problems
// through the real judge, including the large hidden tests, to confirm the
// time and output limits are generous enough for correct, efficient code.
//
//   npm run check:references
import fs from 'node:fs';
import path from 'node:path';
import { makeJudge } from './judge-harness.js';
import { LANGUAGES } from '../server/judge/languages.js';

const { judge, bank } = await makeJudge();
console.log(`Judge driver: ${judge.status().driver}`);
const sources = (p) => ({
  python: fs.readFileSync(path.join(p.dir, 'reference.py'), 'utf8'),
  javascript: fs.readFileSync(path.join(p.dir, 'reference.js'), 'utf8').replace('export function solve', 'function solve')
    + "\nprocess.stdout.write(solve(require('fs').readFileSync(0, 'utf8')));\n",
});
let failures = 0;
for (const p of bank.list) {
  const jobs = Object.entries(sources(p)).map(async ([language, source]) => [language, await judge.enqueue({ problem: p, language, source, mode: 'submit' })]);
  for (const [language, r] of await Promise.all(jobs)) {
    const slowest = Math.max(0, ...r.cases.map((c) => c.timeMs));
    const limit = LANGUAGES[language].limits.runMs;
    const ok = r.verdict === 'AC';
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'}  ${p.id.padEnd(24)} ${language.padEnd(10)} ${r.verdict.padEnd(3)} slowest case ${slowest} ms (limit ${limit} ms, ${Math.round((slowest / limit) * 100)}%)`);
  }
}
await judge.stop();
console.log(failures ? `\n${failures} reference run(s) FAILED` : '\nAll reference solutions accepted by the real judge.');
process.exit(failures ? 1 : 0);
