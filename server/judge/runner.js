// Runs one judge job: write the source to a fresh folder, compile (or
// syntax-check) once, then run each case in its own container.
//
// Privacy rule: for hidden cases only the verdict and time are kept. Their
// stdout/stderr are dropped right here, so they can never reach the browser.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LANGUAGES } from './languages.js';
import { compareOutput } from './compare.js';

export const VERDICTS = {
  AC: 'Accepted',
  WA: 'Wrong Answer',
  CE: 'Compile/Syntax Error',
  RE: 'Runtime Error',
  TLE: 'Time Limit Exceeded',
  OLE: 'Output Limit Exceeded',
  MLE: 'Memory Limit Exceeded',
  JU: 'Judge Unavailable',
};

export class JudgeInfraError extends Error {
  constructor(message) { super(message); this.code = 'judge_unavailable'; }
}

const trimText = (s, max) => (s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more characters truncated)` : s);

function caseVerdict(r) {
  if (r.timedOut) return 'TLE';
  if (r.outputExceeded) return 'OLE';
  if (r.oomKilled) return 'MLE';
  if (r.exitCode !== 0) return 'RE';
  return null; // compare output next
}

/**
 * @param {object} o
 * @param {'run'|'submit'} o.mode
 * @param {Array<{visibility:'public'|'hidden'|'custom', label:string, input:string, expected?:string, stdoutCap:number}>} o.cases
 */
export async function executeJob({ driver, scratchDir, language, source, mode, cases, limits, signal }) {
  const lang = LANGUAGES[language];
  const jobDir = path.join(scratchDir, 'job-' + crypto.randomBytes(8).toString('hex'));
  const srcDir = path.join(jobDir, 'src');
  const buildDir = path.join(jobDir, 'build');
  try {
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(buildDir, { recursive: true });
    fs.chmodSync(jobDir, 0o755);
    fs.chmodSync(srcDir, 0o755);
    fs.chmodSync(buildDir, 0o777); // the container's non-root user writes build output here
    fs.writeFileSync(path.join(srcDir, lang.fileName), source, { mode: 0o644 });

    const common = { language, srcDir, buildDir, signal, stderrCap: limits.stderrBytes };
    const comp = await driver.runContainer({ ...common, phase: 'compile', stdin: '', timeoutMs: lang.limits.compileMs, stdoutCap: limits.compileOutputBytes, stderrCap: limits.compileOutputBytes });
    if (comp.infraError) throw new JudgeInfraError(comp.infraError);
    const compileOutput = trimText((comp.stdout + comp.stderr).replaceAll(srcDir, '').trim(), 8000);
    if (comp.timedOut || comp.outputExceeded || comp.exitCode !== 0) {
      return {
        verdict: 'CE',
        compile: { ok: false, output: comp.timedOut ? 'Compilation timed out.' : compileOutput || `Compiler exited with code ${comp.exitCode}.`, timeMs: comp.durationMs },
        cases: [],
      };
    }

    const results = [];
    let verdict = 'AC';
    for (const c of cases) {
      const r = await driver.runContainer({ ...common, phase: 'run', stdin: c.input, timeoutMs: lang.limits.runMs, stdoutCap: c.stdoutCap });
      if (r.infraError) throw new JudgeInfraError(r.infraError);
      let v = caseVerdict(r);
      if (c.visibility === 'custom') {
        results.push({ visibility: 'custom', label: c.label, verdict: v || 'OK', stdout: trimText(r.stdout, 16000), stderr: trimText(r.stderr, 8000), exitCode: r.exitCode, timeMs: r.durationMs });
        if (v) verdict = v; else verdict = 'OK';
        continue;
      }
      if (!v) v = compareOutput(r.stdout, c.expected) ? 'AC' : 'WA';
      if (c.visibility === 'public') {
        results.push({ visibility: 'public', label: c.label, verdict: v, input: c.input, expected: c.expected, stdout: trimText(r.stdout, 8000), stderr: trimText(r.stderr, 4000), exitCode: r.exitCode, timeMs: r.durationMs });
      } else {
        results.push({ visibility: 'hidden', verdict: v, timeMs: r.durationMs }); // no output kept
      }
      if (v !== 'AC' && verdict === 'AC') verdict = v;
      if (v !== 'AC' && mode === 'submit') break; // stop at the first failing required test
    }
    return { verdict, compile: { ok: true, output: compileOutput, timeMs: comp.durationMs }, cases: results };
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}
