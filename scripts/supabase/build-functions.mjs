// Builds everything the Supabase judge needs (all outputs are git-ignored):
//   1. Python runtime: pinned CPython 3.15.2 WASI build -> debug sections stripped ->
//      memory capped at 128 MiB -> loops metered with a clock check (sched_yield) -> gzip.
//   2. Resized hidden fixtures (scripts/supabase/make-fixture-generator.cjs).
//   3. Lane functions run-js-{1..3}, run-pya-{1..3}, run-pyb-{1..3}, each bundling its tests,
//      and supabase/functions/judge/meta.json (public examples, counts, time limits).
//
//   node scripts/supabase/build-functions.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tools = path.join(root, 'scripts', 'supabase');
const build = path.join(root, 'supabase', '.build');
const functions = path.join(root, 'supabase', 'functions');
fs.mkdirSync(build, { recursive: true });
const node = (args) => execFileSync(process.execPath, args, { stdio: 'inherit' });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ---------------------------------------------------------------- 1. Python runtime
const CPYTHON = {
  url: 'https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.15.2/python-3.15.2-wasi_sdk-33.zip',
  sha256: 'b8a63559c56760bbdc310dedb74fd69d10bcbafae26b705bea0ad353ad256888',
};
const rt = path.join(build, 'python');
const zip = path.join(rt, 'python.zip');
fs.mkdirSync(rt, { recursive: true });
if (!fs.existsSync(zip) || sha(zip) !== CPYTHON.sha256) {
  console.log('Downloading CPython WASI build…');
  const res = await fetch(CPYTHON.url);
  if (!res.ok) throw new Error('download failed: ' + res.status);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  if (sha(zip) !== CPYTHON.sha256) throw new Error('CPython download checksum mismatch');
}
const x = path.join(rt, 'x');
if (!fs.existsSync(path.join(x, 'python.wasm'))) {
  fs.mkdirSync(x, { recursive: true });
  node([path.join(tools, 'wasm', 'unzip.mjs'), zip, x]);
}
const stripped = path.join(rt, 'python-stripped.wasm');
const capped = path.join(rt, 'python-capped.wasm');
const metered = path.join(rt, 'python-metered.wasm');
node([path.join(tools, 'wasm', 'strip-custom-sections.mjs'), path.join(x, 'python.wasm'), stripped]);
node([path.join(tools, 'wasm', 'cap-memory.mjs'), stripped, capped, '2048']); // 2048 × 64 KiB = 128 MiB
// sched_yield is the clock-check hook: find its function index among the imports.
const tickIndex = (() => {
  const b = fs.readFileSync(capped); let p = 8;
  const u = () => { let r = 0, s = 0, v; do { v = b[p++]; r |= (v & 0x7f) << s; s += 7; } while (v & 0x80); return r >>> 0; };
  while (p < b.length) {
    const id = b[p++], size = u(), body = p;
    if (id === 2) {
      let fi = 0; const n = u();
      for (let i = 0; i < n; i++) {
        const l1 = u(); p += l1; const l2 = u(); const name = b.subarray(p, p + l2).toString(); p += l2; const k = b[p++];
        if (k === 0) { u(); if (name === 'sched_yield') return fi; fi++; }
        else if (k === 1) { p++; const fl = b[p++]; u(); if (fl & 1) u(); }
        else if (k === 2) { const fl = b[p++]; u(); if (fl & 1) u(); }
        else if (k === 3) p += 2;
      }
    }
    p = body + size;
  }
  throw new Error('sched_yield import not found');
})();
execFileSync(process.execPath, [path.join(tools, 'wasm', 'meter.mjs'), capped, metered], { stdio: 'inherit', env: { ...process.env, TICK_FUNC: String(tickIndex) } });
const stdlib = path.join(rt, 'stdlib.pack');
const libList = path.join(rt, 'stdlib.list');
fs.writeFileSync(libList, fs.readFileSync(path.join(tools, 'wasm', 'stdlib.list'), 'utf8'));
node([path.join(tools, 'wasm', 'make-stdlib-pack.mjs'), x, stdlib, libList]);
const pyGz = zlib.gzipSync(fs.readFileSync(metered), { level: 9 });
const libGz = zlib.gzipSync(fs.readFileSync(stdlib), { level: 9 });

// ---------------------------------------------------------------- 2. fixtures
const fxDir = path.join(build, 'fixtures-gen');
node([path.join(tools, 'make-fixture-generator.cjs'), root, fxDir]);
node([path.join(fxDir, 'gen-small.mjs'), path.join(root, 'problem-bank', 'problems')]);
const fixtures = path.join(fxDir, 'fixtures');

// ---------------------------------------------------------------- 3. functions
const problems = fs.readdirSync(path.join(root, 'problem-bank', 'problems')).sort();
const limits = JSON.parse(fs.readFileSync(path.join(root, 'supabase', 'judge-limits.json'), 'utf8'));
// Keyed by the public problem id (e.g. 'target-pair'), which the app and database use.
const idOf = Object.fromEntries(problems.map((dir) => [dir, JSON.parse(fs.readFileSync(path.join(root, 'problem-bank', 'problems', dir, 'problem.json'), 'utf8')).id]));
const PYA = problems.slice(0, 6), PYB = problems.slice(6);
const meta = { problems: {} };
const tests = {};
for (const dir of problems) {
  const p = JSON.parse(fs.readFileSync(path.join(root, 'problem-bank', 'problems', dir, 'problem.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(fixtures, dir, 'index.json'), 'utf8'));
  const bundle = {
    public: p.examples.map((e) => ({ input: e.input, output: e.output })),
    hidden: index.map((h) => ({ input: fs.readFileSync(path.join(fixtures, dir, h.file + '.in'), 'utf8'), output: fs.readFileSync(path.join(fixtures, dir, h.file + '.out'), 'utf8') })),
  };
  tests[dir] = zlib.gzipSync(JSON.stringify(bundle), { level: 9 });
  meta.problems[idOf[dir]] = {
    pyKind: PYA.includes(dir) ? 'pya' : 'pyb',
    examples: bundle.public.map((e, i) => ({ label: `Example ${i + 1}`, input: e.input, expected: e.output })),
    hiddenCount: bundle.hidden.length,
    limits: limits[dir],
  };
}
fs.writeFileSync(path.join(functions, 'judge', 'meta.json'), JSON.stringify(meta, null, 1) + '\n');

const LANES = { js: 3, pya: 3, pyb: 3 };
// Unmeasured warm-up programs (typical solution shapes: parse, sets/maps, sort, heap, join).
const WARM = { python: fs.readFileSync(path.join(tools, "warmup.py"), "utf8"), javascript: fs.readFileSync(path.join(tools, "warmup.js"), "utf8") };
const configBlocks = [];
for (const [kind, count] of Object.entries(LANES)) {
  const list = kind === 'js' ? problems : kind === 'pya' ? PYA : PYB;
  for (let i = 1; i <= count; i++) {
    const name = `run-${kind}-${i}`;
    const d = path.join(functions, name);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(path.join(d, 'tests'), { recursive: true });
    const statics = [];
    for (const f of ['runner-core.ts', kind === 'js' ? 'jsrun.mjs' : 'pyrun.mjs', ...(kind === 'js' ? [] : ['verdict.mjs'])]) {
      fs.copyFileSync(path.join(functions, '_runner', f), path.join(d, f));
    }
    for (const dir of list) { fs.writeFileSync(path.join(d, 'tests', idOf[dir] + '.json.gz'), tests[dir]); statics.push(`./functions/${name}/tests/${idOf[dir]}.json.gz`); }
    if (kind === 'js') {
      fs.writeFileSync(path.join(d, 'index.ts'), `// ${name}: QuickJS-WASM runner lane (judge-only; generated by scripts/supabase/build-functions.mjs)
import { serveRunner } from './runner-core.ts';
import { makeJS } from './jsrun.mjs';
const js = makeJS();
serveRunner({ problems: ${JSON.stringify(list.map((d) => idOf[d]))}, warm: ${JSON.stringify(WARM.javascript)}, base: new URL('./', import.meta.url), exec: async () => async (src, stdin, o) => {
  const r = await js(src, stdin, { timeMs: o.timeMs, memoryMb: 64, outputLimit: o.outputLimit });
  return { verdict: r.verdict, ms: r.ms, stdout: r.stdout, stderr: r.stderr };
} });
`);
    } else {
      fs.writeFileSync(path.join(d, 'python.wasm.gz'), pyGz);
      fs.writeFileSync(path.join(d, 'stdlib.pack.gz'), libGz);
      statics.push(`./functions/${name}/python.wasm.gz`, `./functions/${name}/stdlib.pack.gz`);
      fs.writeFileSync(path.join(d, 'index.ts'), `// ${name}: CPython-WASI runner lane with in-sandbox time limit (judge-only; generated)
import { serveRunner } from './runner-core.ts';
import { makePython, unpack } from './pyrun.mjs';
import { pyVerdict } from './verdict.mjs';
const base = new URL('./', import.meta.url);
const gunzip = async (f: string) => new Uint8Array(await new Response(new Blob([await Deno.readFile(new URL(f, base))]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
let py: ReturnType<typeof makePython> | null = null;
async function load() {
  if (!py) py = makePython(new WebAssembly.Module(await gunzip('python.wasm.gz')), unpack(await gunzip('stdlib.pack.gz')));
  return py;
}
serveRunner({ problems: ${JSON.stringify(list.map((d) => idOf[d]))}, warm: ${JSON.stringify(WARM.python)}, base, exec: async () => { const run = await load(); return async (src, stdin, o) => {
  const r = run(src, stdin, { timeMs: o.timeMs, outputLimit: o.outputLimit });
  return { verdict: pyVerdict(r), ms: r.ms, stdout: r.stdout, stderr: r.stderr };
}; } });
`);
    }
    configBlocks.push(`[functions.${name}]\nverify_jwt = false\nstatic_files = ${JSON.stringify(statics)}\n`);
    const bytes = fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, f)).filter((f) => fs.statSync(f).isFile()).reduce((a, f) => a + fs.statSync(f).size, 0);
    if (bytes > 4.6 * 1024 * 1024) throw new Error(`${name} is ${(bytes / 1048576).toFixed(2)} MB; the server-side bundle limit is 5 MB`);
  }
}
// Managed block in supabase/config.toml
const cfgPath = path.join(root, 'supabase', 'config.toml');
let cfg = fs.readFileSync(cfgPath, 'utf8');
const BEGIN = '# >>> code-arena functions (generated by scripts/supabase/build-functions.mjs)', END = '# <<< code-arena functions';
cfg = cfg.includes(BEGIN) ? cfg.slice(0, cfg.indexOf(BEGIN)) + cfg.slice(cfg.indexOf(END) + END.length + 1) : cfg;
cfg = cfg.trimEnd() + `\n\n${BEGIN}\n[functions.judge]\nverify_jwt = false\n\n${configBlocks.join('\n')}${END}\n`;
fs.writeFileSync(cfgPath, cfg);
console.log(`Built judge meta + ${configBlocks.length} runner lanes (python.wasm.gz ${(pyGz.length / 1048576).toFixed(2)} MB).`);
