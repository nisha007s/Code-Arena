// Judge service: readiness, queueing, retries and turning a problem into cases.
import fs from 'node:fs';
import { JudgeQueue, QueueError } from './queue.js';
import { executeJob, JudgeInfraError } from './runner.js';
import { DockerDriver } from './docker-driver.js';
import { LocalDriver } from './local-driver.js';
import { LANGUAGES } from './languages.js';

export { QueueError, JudgeInfraError };

export function createDriver(config, instanceId, log) {
  if (config.judge.driver === 'local') return new LocalDriver({ log });
  return new DockerDriver({ binary: config.judge.dockerBinary, instanceId, log });
}

export const PRIORITY = { battle: 0, submit: 1, run: 2 };

export class Judge {
  constructor({ config, driver, bank, log = console }) {
    this.config = config;
    this.driver = driver;
    this.bank = bank;
    this.log = log;
    this.queue = new JudgeQueue(config.judge);
    this.readiness = { ready: false, message: 'Checking the judge…', languages: {}, checkedAt: 0 };
    this.timer = null;
  }

  async start() {
    fs.mkdirSync(this.config.scratchDir, { recursive: true });
    try { await this.driver.cleanupOrphans(); } catch { /* docker may be down; readiness reports it */ }
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => {}), 10000);
    this.timer.unref?.();
  }

  async stop() {
    clearInterval(this.timer);
    await this.driver.shutdown?.();
  }

  async refresh() {
    const status = await this.driver.checkReady();
    const wasReady = this.readiness.ready;
    this.readiness = { ...status, driver: this.driver.name, checkedAt: Date.now() };
    if (status.ready && !wasReady) {
      this.log.info?.(`judge: ready (${this.driver.name})`);
      this.driver.cleanupOrphans().catch(() => {});
    }
    if (!status.ready && wasReady) this.log.warn?.(`judge: unavailable — ${status.message}`);
    return this.readiness;
  }

  status() {
    return { ...this.readiness, queue: this.queue.stats() };
  }

  buildCases(problem, mode, customInput) {
    if (customInput !== null && customInput !== undefined) {
      return [{ visibility: 'custom', label: 'Custom input', input: customInput, stdoutCap: this.config.judge.customStdoutBytes }];
    }
    const tests = problem.tests.filter((t) => mode === 'submit' || t.visibility === 'public');
    return tests.map((t) => ({
      visibility: t.visibility,
      label: t.visibility === 'public' ? t.label : 'Hidden test',
      input: this.bank.readInput(t),
      expected: this.bank.readExpected(t),
      stdoutCap: this.bank.stdoutCapFor(t),
    }));
  }

  /**
   * Queue and run one job. Resolves with the (privacy-safe) result. Infra
   * failures are retried, then resolve as verdict JU. Queue admission errors throw.
   */
  enqueue({ problem, language, source, mode, customInput = null, battle = false, onStart }) {
    if (!LANGUAGES[language]) throw new QueueError('invalid_language', 'Unknown language.');
    const priority = battle ? PRIORITY.battle : PRIORITY[mode];
    const task = async (signal) => {
      const cases = this.buildCases(problem, mode, customInput);
      let lastError;
      for (let attempt = 0; attempt <= this.config.judge.infraRetries; attempt++) {
        if (signal.aborted) break;
        try {
          return await executeJob({ driver: this.driver, scratchDir: this.config.scratchDir, language, source, mode, cases, limits: this.config.judge, signal });
        } catch (e) {
          if (!(e instanceof JudgeInfraError)) throw e;
          lastError = e;
          this.log.warn?.(`judge: infrastructure error (attempt ${attempt + 1}): ${e.message}`);
        }
      }
      this.refresh().catch(() => {});
      return { verdict: 'JU', compile: null, cases: [], message: signal.aborted ? 'The judge took too long and the job was stopped.' : 'The judge is unavailable right now. ' + (this.readiness.ready ? '' : this.readiness.message) , infra: lastError?.message };
    };
    return this.queue.push({ priority, battle, task, onStart });
  }
}
