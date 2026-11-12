// Shared setup for the judge scripts: builds a Judge with the configured driver
// (Docker by default; JUDGE_DRIVER=local + CODE_ARENA_ALLOW_UNSANDBOXED=1 for the
// unsandboxed host test driver).
import { loadConfig } from '../server/config.js';
import { loadProblemBank, ensureFixtures } from '../server/problems.js';
import { Judge, createDriver } from '../server/judge/index.js';
import { safeResult } from '../server/jobs.js';

export async function makeJudge(overrides = {}) {
  const config = loadConfig({ overrides: { judge: { concurrency: 2, maxQueue: 500, battleReserve: 0, ...overrides } } });
  ensureFixtures();
  const bank = loadProblemBank();
  const log = { info: () => {}, warn: (m) => console.warn('  ' + m), error: (m) => console.error('  ' + m) };
  const driver = createDriver(config, 'smoke', log);
  const judge = new Judge({ config, driver, bank, log });
  await judge.start();
  return { config, bank, driver, judge, safeResult };
}
