// Compiles / syntax-checks all 60 starter templates (12 problems × 5 languages)
// with the real judge. A starter is not expected to pass any test.
//
//   npm run check:starters
import { makeJudge } from './judge-harness.js';
import { executeJob } from '../server/judge/runner.js';
import { LANGUAGE_IDS } from '../server/judge/languages.js';
import { starterFor } from '../server/starters.js';

const { judge, bank, driver, config } = await makeJudge();
const status = judge.status();
console.log(`Judge driver: ${status.driver}`);
let ok = 0, failed = 0, skipped = 0;
for (const language of LANGUAGE_IDS) {
  if (!status.languages?.[language]?.ready) {
    console.log(`  -  ${language}: SKIPPED (${status.languages?.[language]?.message || 'not available'})`);
    skipped += bank.list.length;
    continue;
  }
  // Compile at most 4 at a time: the real judge queue never runs 12 compiles at once,
  // and a burst like that can exceed compile time limits on a busy laptop.
  const results = [];
  const queue = [...bank.list];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const res = await executeJob({ driver, scratchDir: config.scratchDir, language, source: starterFor(p, language), mode: 'run', cases: [], limits: config.judge, signal: new AbortController().signal });
      results.push([p, res]);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  results.sort((a, b) => a[0].number - b[0].number);
  for (const [p, res] of results) {
    if (res.verdict === 'AC') ok++;
    else { failed++; console.log(`  ✗  ${language} / ${p.id}: ${res.compile?.output?.slice(0, 300)}`); }
  }
  console.log(`  ✓  ${language}: ${bank.list.length} starters checked`);
}
await judge.stop();
console.log(`\nStarters compiled: ${ok}, failed: ${failed}, skipped: ${skipped} (of ${bank.list.length * LANGUAGE_IDS.length})`);
process.exit(failed ? 1 : 0);
