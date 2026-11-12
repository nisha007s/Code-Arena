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
  const work = bank.list.map(async (p) => {
    const res = await executeJob({ driver, scratchDir: config.scratchDir, language, source: starterFor(p, language), mode: 'run', cases: [], limits: config.judge, signal: new AbortController().signal });
    return [p, res];
  });
  for (const [p, res] of await Promise.all(work)) {
    if (res.verdict === 'AC') ok++;
    else { failed++; console.log(`  ✗  ${language} / ${p.id}: ${res.compile?.output?.slice(0, 300)}`); }
  }
  console.log(`  ✓  ${language}: ${bank.list.length} starters checked`);
}
await judge.stop();
console.log(`\nStarters compiled: ${ok}, failed: ${failed}, skipped: ${skipped} (of ${bank.list.length * LANGUAGE_IDS.length})`);
process.exit(failed ? 1 : 0);
