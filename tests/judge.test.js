import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JudgeQueue } from '../server/judge/queue.js';
import { executeJob } from '../server/judge/runner.js';
import { Judge } from '../server/judge/index.js';
import { safeResult } from '../server/jobs.js';
import { bank, testConfig, FakeDriver } from './helpers.js';

test('queue: battle work runs before practice, and the queue rejects excess', async () => {
  const q = new JudgeQueue({ concurrency: 1, maxQueue: 2, battleReserve: 1, battleSlots: 0 });
  const order = [];
  let releaseFirst;
  const first = q.push({ priority: 2, task: () => new Promise((r) => { releaseFirst = r; }) });
  const p1 = q.push({ priority: 2, task: async () => order.push('run') });
  const p2 = q.push({ priority: 1, task: async () => order.push('submit') });
  assert.throws(() => q.push({ priority: 2, task: async () => {} }), { code: 'queue_full' });
  const p3 = q.push({ priority: 0, battle: true, task: async () => order.push('battle') }); // uses the reserve
  assert.throws(() => q.push({ priority: 0, battle: true, task: async () => {} }), { code: 'queue_full' });
  await new Promise((r) => setImmediate(r)); // the first task starts on a microtask
  releaseFirst();
  await Promise.all([first, p1, p2, p3]);
  assert.deepEqual(order, ['battle', 'submit', 'run']);
});

test('queue: battle jobs use dedicated slots and never wait behind practice work', async () => {
  const q = new JudgeQueue({ concurrency: 1, maxQueue: 5, battleSlots: 2 });
  const releases = [];
  const block = () => new Promise((r) => releases.push(r));
  const practice = [q.push({ priority: 2, task: block }), q.push({ priority: 2, task: block })];
  const started = [];
  const b1 = q.push({ priority: 0, battle: true, task: async () => started.push('b1') });
  const b2 = q.push({ priority: 0, battle: true, task: async () => started.push('b2') });
  await Promise.all([b1, b2]);
  assert.deepEqual(started, ['b1', 'b2'], 'both battle jobs ran while practice held the normal slot');
  assert.equal(q.stats().waiting, 1, 'the second practice job still waits for the normal slot');
  await new Promise((r) => setImmediate(r));
  releases.forEach((r) => r());
  await new Promise((r) => setImmediate(r));
  releases.forEach((r) => r());
  await Promise.all(practice);
});

test('runner: hidden cases keep only a verdict; public cases show diagnostics', async () => {
  const config = testConfig();
  const problem = bank.get('target-pair');
  const judge = new Judge({ config, driver: new FakeDriver(), bank, log: {} });
  // Passes the examples, then echoes stdin on hidden cases.
  const raw = await executeJob({
    driver: { runContainer: async (o) => {
      if (o.phase === 'compile') return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
      const answer = o.stdin.startsWith('5 9') ? 'YES' : o.stdin.startsWith('4 100') ? 'NO' : o.stdin;
      return { exitCode: 0, stdout: answer, stderr: 'debug: ' + o.stdin.slice(0, 20), durationMs: 1 };
    } },
    scratchDir: config.scratchDir, language: 'python', source: 'x', mode: 'submit',
    cases: judge.buildCases(problem, 'submit', null), limits: config.judge, signal: new AbortController().signal,
  });
  assert.equal(raw.verdict, 'WA');
  const hidden = raw.cases.filter((c) => c.visibility === 'hidden');
  assert.equal(hidden.length, 1, 'stops at the first failing required test');
  assert.deepEqual(Object.keys(hidden[0]).sort(), ['timeMs', 'verdict', 'visibility']);
  const safe = safeResult(raw);
  assert.equal(safe.cases.length, 2);
  assert.deepEqual(safe.hidden, { passed: false, verdict: 'WA' });
  const hiddenInput = bank.readInput(problem.tests.find((t) => t.visibility === 'hidden'));
  assert.ok(!JSON.stringify(safe).includes(hiddenInput.trim().slice(0, 20)));
});

test('runner: compile errors stop before running, and job folders are removed', async () => {
  const config = testConfig();
  const driver = new FakeDriver();
  const before = fs.readdirSync(config.scratchDir).length;
  const raw = await executeJob({ driver, scratchDir: config.scratchDir, language: 'python', source: '#compile-error', mode: 'submit', cases: [{ visibility: 'public', label: 'Example 1', input: '1', expected: '1', stdoutCap: 100 }], limits: config.judge, signal: new AbortController().signal });
  assert.equal(raw.verdict, 'CE');
  assert.equal(driver.runs, 0);
  assert.match(raw.compile.output, /syntax error/);
  assert.equal(fs.readdirSync(config.scratchDir).length, before);
});

test('judge: infrastructure failures are retried, then reported as Judge Unavailable', async () => {
  const config = testConfig({ judge: { infraRetries: 1 } });
  let calls = 0;
  const driver = new FakeDriver();
  const orig = driver.runContainer.bind(driver);
  driver.runContainer = (o) => { calls++; return orig(o); };
  const judge = new Judge({ config, driver, bank, log: {} });
  const res = await judge.enqueue({ problem: bank.get('target-pair'), language: 'python', source: '#infra', mode: 'submit' });
  assert.equal(res.verdict, 'JU');
  assert.equal(calls, 2);
});

test('judge: custom input runs once with no expected answer', async () => {
  const config = testConfig();
  const judge = new Judge({ config, driver: new FakeDriver(), bank, log: {} });
  const res = await judge.enqueue({ problem: bank.get('target-pair'), language: 'python', source: '#echo', mode: 'run', customInput: 'hello stdin' });
  assert.equal(res.cases.length, 1);
  assert.equal(res.cases[0].visibility, 'custom');
  assert.equal(res.cases[0].stdout, 'hello stdin');
  assert.equal(res.cases[0].expected, undefined);
});

test('stdout caps fit the largest valid answers', () => {
  for (const id of ['merge-maintenance-slots', 'next-warmer-day']) {
    const p = bank.get(id);
    for (const t of p.tests) assert.ok(bank.stdoutCapFor(t) >= Buffer.byteLength(bank.readExpected(t)) * 2);
  }
});
