// Real-judge smoke test (needs Docker images from `npm run judge:build`).
//
//   npm run judge:smoke
//
// 1. A correct Target Pair solution in all five languages must be Accepted.
// 2. Wrong answer, syntax error, compile error, crash, infinite loop, huge output
//    and (Docker only) a memory hog must get the right verdicts.
// 3. A program that echoes stdin must never leak hidden-test output.
// 4. No judge containers may be left running afterwards.
// Prints compile and per-case timings so limits can be tuned (README "Limits").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeJudge } from './judge-harness.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'solutions');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const { judge, bank, driver, safeResult } = await makeJudge();
const status = judge.status();
console.log(`Judge driver: ${status.driver} — ${status.message}`);
const problem = bank.get('target-pair');
const only = process.argv.slice(2);

const cases = [
  ['python', 'correct', read('target-pair.py'), 'AC'],
  ['javascript', 'correct', read('target-pair.js'), 'AC'],
  ['java', 'correct', read('Main.java'), 'AC'],
  ['cpp', 'correct', read('target-pair.cpp'), 'AC'],
  ['csharp', 'correct', read('Main.cs'), 'AC'],
  ['python', 'wrong answer', 'print("YES")\n', 'WA'],
  ['python', 'syntax error', 'def main(:\n    pass\n', 'CE'],
  ['javascript', 'syntax error', 'const x = ;\n', 'CE'],
  ['cpp', 'compile error', 'int main() { return undefined_name; }\n', 'CE'],
  ['java', 'compile error', 'public class Main { public static void main(String[] a) { int x = "s"; } }\n', 'CE'],
  ['csharp', 'compile error', 'public static class Program { public static void Main() { int x = "s"; } }\n', 'CE'],
  ['python', 'crash', 'raise RuntimeError("boom")\n', 'RE'],
  ['cpp', 'crash (segfault)', '#include <cstdio>\nint main(){ int* p = nullptr; *p = 1; printf("%d", *p); }\n', 'RE'],
  ['python', 'infinite loop', 'while True:\n    pass\n', 'TLE'],
  ['javascript', 'infinite loop', 'for (;;) {}\n', 'TLE'],
  ['java', 'infinite loop', 'public class Main { public static void main(String[] a) { long x = 0; while (true) { x++; } } }\n', 'TLE'],
  ['cpp', 'infinite loop', 'int main() { volatile long x = 0; for (;;) { x++; } }\n', 'TLE'],
  ['csharp', 'infinite loop', 'public static class Program { public static void Main() { long x = 0; while (true) { x++; } } }\n', 'TLE'],
  ['python', 'kills itself (SIGKILL, quick)', 'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n', 'RE'],
  ['python', 'excessive output', 'import sys\nwhile True:\n    sys.stdout.write("x" * 65536)\n', 'OLE'],
  ...(driver.name === 'docker' ? [['python', 'memory hog', 'x = []\nwhile True:\n    x.append(bytearray(10**7))\n', 'MLE']] : []),
  // Passes both public examples, then echoes stdin, so the first hidden case sees an echo.
  ['python', 'echo stdin (privacy check)', 'import sys\ns = sys.stdin.read()\nif s.startswith("5 9"):\n    print("YES")\nelif s.startswith("4 100"):\n    print("NO")\nelse:\n    sys.stdout.write(s)\n', 'WA'],
];

let failures = 0, skipped = 0;
for (const [language, name, source, expected] of cases) {
  if (only.length && !only.includes(language)) continue;
  if (status.languages?.[language] && !status.languages[language].ready) {
    console.log(`  -  ${language.padEnd(10)} ${name.padEnd(28)} SKIPPED (${status.languages[language].message || 'not available'})`);
    skipped++;
    continue;
  }
  const started = Date.now();
  const raw = await judge.enqueue({ problem, language, source, mode: 'submit' });
  const safe = safeResult(raw);
  const ok = raw.verdict === expected;
  if (!ok) failures++;
  const maxCase = Math.max(0, ...raw.cases.map((c) => c.timeMs));
  console.log(`  ${ok ? '✓' : '✗'}  ${language.padEnd(10)} ${name.padEnd(28)} ${raw.verdict.padEnd(4)} (expected ${expected}) · compile ${raw.compile?.timeMs ?? '-'} ms · slowest case ${maxCase} ms · total ${Date.now() - started} ms`);
  if (!ok && raw.compile?.output) console.log('      ' + raw.compile.output.split('\n').slice(0, 6).join('\n      '));
  if (!ok && raw.message) console.log('      ' + raw.message, raw.infra || '');
  if (name.startsWith('echo')) {
    const hiddenInputs = problem.tests.filter((t) => t.visibility === 'hidden').map((t) => bank.readInput(t).slice(0, 40));
    const text = JSON.stringify(safe);
    const leaked = hiddenInputs.some((inp) => text.includes(JSON.stringify(inp).slice(1, -1)));
    const hiddenEntries = safe.cases.filter((c) => c.visibility === 'hidden').length;
    console.log(`  ${leaked || hiddenEntries ? '✗' : '✓'}  hidden-case stdout withheld from the client result`);
    if (leaked || hiddenEntries) failures++;
  }
}

const left = await driver.listJudgeContainers();
console.log(`  ${left.length ? '✗' : '✓'}  judge containers left behind: ${left.length}`);
if (left.length) failures++;
await judge.stop();
console.log(failures ? `\n${failures} smoke check(s) FAILED` : `\nAll smoke checks passed${skipped ? ` (${skipped} skipped)` : ''}.`);
process.exit(failures ? 1 : 0);
