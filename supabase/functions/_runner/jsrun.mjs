// QuickJS (WebAssembly) runner shared by the Node harness and the Deno Edge Function.
// The guest program sees only: its stdin string, console.log/error, process.stdout.write
// and require('fs').readFileSync(0). Nothing from the host (Deno, env, fetch) is exposed.
import { shouldInterruptAfterDeadline, newQuickJSWASMModule } from 'npm:quickjs-emscripten@0.31.0';

const PRELUDE = (limit) => `
"use strict";
(() => {
  const STDIN = globalThis.__stdin; delete globalThis.__stdin;
  let out = [], size = 0, err = [], esize = 0;
  const LIMIT = ${limit};
  const fmt = (a) => a.map((x) => typeof x === 'string' ? x : (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x))).join(' ');
  const write = (s) => { s = String(s); if (size >= LIMIT) throw new Error('__OUTPUT_LIMIT__'); out.push(s); size += s.length; return true; };
  const ewrite = (s) => { s = String(s); if (esize < 16384) { err.push(s); esize += s.length; } return true; };
  globalThis.console = { log: (...a) => write(fmt(a) + '\\n'), error: (...a) => ewrite(fmt(a) + '\\n'), warn: (...a) => ewrite(fmt(a) + '\\n') };
  globalThis.process = { stdout: { write }, stderr: { write: ewrite }, argv: [], env: {}, exit: (c) => { throw { __exit: c | 0 }; } };
  const fs = { readFileSync: (fd) => { if (fd === 0 || fd === '/dev/stdin') return STDIN; throw new Error('File access is not available'); } };
  globalThis.require = (m) => { if (m === 'fs' || m === 'node:fs') return fs; throw new Error("Module '" + m + "' is not available"); };
  globalThis.__collect = () => [out.join(''), err.join(''), size >= LIMIT];
})();
`;

// A fresh WebAssembly instance per run, so a runtime that crashed (e.g. at its memory
// limit) can never affect the next submission.
export function makeJS() {
  return async function run(source, stdin, { timeMs = 4000, memoryMb = 64, outputLimit = 64 * 1024 } = {}) {
    const QuickJS = await newQuickJSWASMModule();
    const rt = QuickJS.newRuntime();
    rt.setMemoryLimit(memoryMb * 1024 * 1024);
    rt.setMaxStackSize(1024 * 1024);
    const t0 = performance.now();
    rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeMs));
    const ctx = rt.newContext();
    const phases = {};
    let verdict = 'OK', error = null, stdout = '', stderr = '', truncated = false;
    try {
      const h = ctx.newString(stdin); ctx.setProp(ctx.global, '__stdin', h); h.dispose();
      ctx.unwrapResult(ctx.evalCode(PRELUDE(outputLimit), 'prelude.js')).dispose();
      const r = ctx.evalCode(source, 'main.js');
      phases.eval = Math.round(performance.now() - t0);
      if (r.error) {
        const e = ctx.dump(r.error); r.error.dispose();
        const msg = typeof e === 'object' && e ? (e.message || JSON.stringify(e)) : String(e);
        if (e && typeof e === 'object' && '__exit' in e) { if (e.__exit) verdict = 'RE'; }
        else if (/interrupted/i.test(msg)) verdict = 'TLE';
        else if (/out of memory/i.test(msg)) verdict = 'MLE';
        else if (/__OUTPUT_LIMIT__/.test(msg)) verdict = 'OLE';
        else if (/stack overflow/i.test(msg)) { verdict = 'RE'; }
        else verdict = 'RE';
        error = msg;
      } else r.value.dispose();
      // Collect output (works even after an error; give it a fresh small budget).
      phases.classified = Math.round(performance.now() - t0);
      rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 1000));
      const c = ctx.evalCode('__collect()');
      if (!c.error) { [stdout, stderr, truncated] = ctx.dump(c.value); c.value.dispose(); } else c.error.dispose();
    } catch (e) {
      verdict = /out of memory/i.test(String(e)) ? 'MLE' : 'RE'; error = String(e?.message || e);
      phases.collected = Math.round(performance.now() - t0);
    } finally {
      try { ctx.dispose(); rt.dispose(); } catch { /* a runtime that hit its memory limit may refuse to free cleanly */ }
    }
    phases.disposed = Math.round(performance.now() - t0);
    return { verdict, error, phases, ms: performance.now() - t0, stdout, stderr, truncated };
  };
}
