// Judge acceptance gates G1–G7 (runaway code, classification, access control and leak scan,
// concurrency isolation, fairness vs. original limits, firewall payloads, quota accounting).
//   JUDGE_ADMIN_KEY=... node scripts/supabase/test-judge-gates.mjs [all|G1,G4,...]
// Phase 1 gates G1–G7 against the live judge. Prints PASS/FAIL per check; writes gates.json.
import fs from 'node:fs';
import { judge, reference, PROBLEMS, b64, RUNNER_BASE, runnerKeyLength, ANON, FIXTURES, SLOW } from './judge-client.mjs';
import path from 'node:path';
const results = [];
const check = (gate, name, pass, info = '') => { results.push({ gate, name, pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${gate}  ${name}${info ? '  — ' + info : ''}`); };
const which = process.argv[2] || 'all';
const on = (g) => which === 'all' || which.split(',').includes(g);
const sub = (problemId, language, source, extra = {}) => judge({ problemId, language, mode: 'submit', sourceB64: b64(source), ...extra });
const neverAC = (r) => r.j?.verdict !== 'AC';

// ---------- G1: runaway code stops in-sandbox (HTTP 200, in-band verdict, no 546) ----------
if (on('G1')) {
  const py = {
    'infinite loop': 'while True: pass',
    'bigint power (C loop)': 'x = 7 ** (10 ** 8)\nprint(len(str(x)))',
    'regex backtracking': "import re\nprint(re.match(r'(a+)+$', 'a' * 40 + 'b'))",
    'stdin read loop': 'import sys\nwhile True:\n  sys.stdin.read()',
  };
  for (const [name, src] of Object.entries(py)) {
    const r = await sub('target-pair', 'python', src);
    const a = (r.j?.diagnostics?.attempts || []).filter((x) => !x.why?.startsWith('warm-up'));
    const t = r.j?.diagnostics?.perTest?.[0]?.timeMs;
    check('G1', `python ${name}`, r.status === 200 && r.j?.verdict === 'TLE' && a.length === 1 && a[0].status === 200, `verdict ${r.j?.verdict}, runner HTTP ${a.map((x) => x.status)}, stopped at ${t} ms (limit ${r.j?.diagnostics?.timeMs})`);
  }
  for (const [name, src] of Object.entries({ 'infinite loop': 'for(;;){}', 'busy recursion-free loop': 'let x=0;while(true){x=(x*31+7)%1000003}' })) {
    const r = await sub('target-pair', 'javascript', src);
    const a = (r.j?.diagnostics?.attempts || []).filter((x) => !x.why?.startsWith('warm-up'));
    check('G1', `javascript ${name}`, r.j?.verdict === 'TLE' && a.length === 1 && a[0].status === 200, `verdict ${r.j?.verdict}, runner HTTP ${a.map((x) => x.status)}`);
  }
  const mem = await sub('target-pair', 'python', 'a=[]\nwhile True: a.append(bytearray(10**7))');
  check('G1', 'python memory bomb -> MLE in-band', mem.j?.verdict === 'MLE' && (mem.j?.diagnostics?.attempts || []).filter((x) => !x.why?.startsWith('warm-up'))[0]?.status === 200, `verdict ${mem.j?.verdict}`);
}

// ---------- G2: classification; QuickJS memory bomb; fault injection; never AC ----------
if (on('G2')) {
  for (let i = 0; i < 3; i++) {
    const r = await sub('target-pair', 'javascript', 'const a=[];for(;;)a.push(new Array(1e6).fill(7));');
    const a = (r.j?.diagnostics?.attempts || []).filter((x) => !x.why?.startsWith('warm-up'));
    check('G2', `JS memory bomb #${i + 1}: not AC, no retry`, neverAC(r) && ['MLE', 'TLE'].includes(r.j?.verdict) && a.length === 1, `verdict ${r.j?.verdict}, runner HTTP ${a.map((x) => x.status)}, calls ${a.length}`);
  }
  for (const [lang, src] of [['python', 'print("NO")'], ['javascript', 'console.log("NO")']]) {
    const r = await sub('target-pair', lang, src);
    check('G2', `${lang} wrong answer -> WA, 1 call`, r.j?.verdict === 'WA' && (r.j?.diagnostics?.attempts || []).filter((x) => !x.why?.startsWith('warm-up')).length === 1, `verdict ${r.j?.verdict}, calls ${r.j?.diagnostics?.calls}`);
  }
  for (const fault of ['missing-function', 'wrong-key', 'stall']) {
    const r = await sub('target-pair', 'python', reference('01-target-pair', 'python'), { faults: { 'hidden-1': fault } });
    const a = (r.j?.diagnostics?.attempts || []).filter((x) => !x.why?.startsWith('warm-up'));
    const infra = a.filter((x) => x.cls === 'infra');
    check('G2', `fault ${fault} -> JU after exactly one retry, never AC`, r.j?.verdict === 'JU' && infra.length === 2 && neverAC(r), `verdict ${r.j?.verdict}, infra attempts ${infra.length} (${infra.map((x) => x.status + ':' + (x.why || '')).join(' | ').slice(0, 120)})`);
  }
  const rt = await sub('target-pair', 'python', 'raise SystemExit(3)');
  check('G2', 'runtime error -> RE, 1 call', rt.j?.verdict === 'RE' && (rt.j?.diagnostics?.attempts || []).filter((x) => !x.why?.startsWith('warm-up')).length === 1, `verdict ${rt.j?.verdict}`);
  const ole = await sub('target-pair', 'javascript', "for(;;)console.log('x'.repeat(1000))");
  check('G2', 'output flood -> OLE (not AC)', ole.j?.verdict === 'OLE', `verdict ${ole.j?.verdict}`);
}

// ---------- G3: runner access control and leak scan ----------
if (on('G3')) {
  const anon = ANON;
  for (const fn of ['run-js-1', 'run-js-3', 'run-pya-2', 'run-pyb-1', 'run-pyb-3']) {
    const body = JSON.stringify({ problemId: 'target-pair', test: 'hidden-1', sourceB64: b64('print(input())'), timeMs: 500 });
    const tries = {
      'no key': {}, 'wrong key': { 'x-runner-key': 'x'.repeat(runnerKeyLength) },
      'user/anon JWT': { authorization: 'Bearer ' + anon, apikey: anon },
    };
    for (const [label, headers] of Object.entries(tries)) {
      const res = await fetch(RUNNER_BASE + fn, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
      const text = await res.text();
      check('G3', `${fn} with ${label} -> 404, nothing echoed`, res.status === 404 && !res.headers.get('x-ca-runner') && text.length < 40, `HTTP ${res.status}, ${text.length} bytes`);
    }
  }
  const noAdmin = await judge({ problemId: 'target-pair', language: 'python', mode: 'submit', sourceB64: b64('print(1)') }, { key: null });
  check('G3', 'judge without admin key or session -> 401, no code run', noAdmin.status === 401, `HTTP ${noAdmin.status}`);
  const badAdmin = await judge({ problemId: 'target-pair', language: 'python', mode: 'submit', sourceB64: b64('print(1)') }, { key: 'y'.repeat(43) });
  check('G3', 'judge with a wrong admin key -> 404', badAdmin.status === 404, `HTTP ${badAdmin.status}`);
  // Leak scan: a program that echoes its input; hidden tests must return verdict only.
  for (const [lang, src] of [['python', 'import sys\nsys.stdout.write(sys.stdin.read())'], ['javascript', "process.stdout.write(require('fs').readFileSync(0,'utf8'))"]]) {
    for (const dir of ['01-target-pair', '11-cheapest-route']) {
      const r = await judge({ problemId: dir.slice(3), language: lang, mode: 'submit', sourceB64: b64(src) });
      const raw = JSON.stringify(r.j);
      const hidden = JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, 'index.json'), 'utf8'));
      const leaks = hidden.some((h) => { const inp = fs.readFileSync(path.join(FIXTURES, dir, h.file + '.in'), 'utf8'); return inp.trim().length > 12 && raw.includes(inp.trim().slice(0, 60).replace(/\n/g, '\\n')); });
      check('G3', `${lang} echo program on ${dir}: no hidden input in response`, !leaks && r.j?.verdict !== 'AC', `verdict ${r.j?.verdict}, response ${raw.length} bytes`);
    }
  }
}

// ---------- G4: concurrency — malicious submissions must not affect others ----------
if (on('G4')) {
  for (let round = 1; round <= 3; round++) {
    const normal = [];
    for (let i = 0; i < 25; i++) {
      const dir = PROBLEMS[i % 12], lang = i % 2 ? 'javascript' : 'python';
      const wrong = i % 5 === 4; // some deliberate wrong answers so "correct verdict" isn't always AC
      const src = wrong ? (lang === 'python' ? 'print(-123456789)' : 'console.log(-123456789)') : reference(dir, lang);
      normal.push({ dir, lang, expect: wrong ? 'WA' : 'AC', p: sub(dir.slice(3), lang, src) });
    }
    const hostile = [
      ...Array.from({ length: 5 }, () => sub('merge-maintenance-slots', 'javascript', 'const a=[];for(;;)a.push(new Array(1e6).fill(7));')),
      ...Array.from({ length: 5 }, () => sub('merge-maintenance-slots', 'python', 'while True: pass')),
    ];
    const [n, hst] = await Promise.all([Promise.all(normal.map(async (x) => ({ ...x, r: await x.p }))), Promise.all(hostile)]);
    const bad = n.filter((x) => x.r.j?.verdict !== x.expect);
    const lat = n.map((x) => x.r.wallMs).sort((a, b) => a - b);
    check('G4', `round ${round}: 25 normal submissions correct alongside 10 hostile`, bad.length === 0,
      `${25 - bad.length}/25 correct; hostile verdicts ${hst.map((h) => h.j?.verdict).join(',')}; normal latency p50 ${lat[12]} ms, max ${lat.at(-1)} ms` + (bad.length ? `; WRONG: ${bad.map((x) => `${x.dir}/${x.lang} expected ${x.expect} got ${x.r.j?.verdict ?? 'HTTP' + x.r.status}`).join('; ')}` : ''));
  }
}

// ---------- G5: fairness — slow solutions keep their original verdicts ----------
if (on('G5')) {
  const base = JSON.parse(fs.readFileSync(path.join(SLOW, 'baseline-original.json'), 'utf8'));
  for (const f of fs.readdirSync(SLOW).filter((f) => /\.(js|py)$/.test(f)).sort()) {
    const dir = f.replace(/\.(js|py)$/, ''), lang = f.endsWith('.js') ? 'javascript' : 'python';
    const r = await sub(dir.slice(3), lang, fs.readFileSync(path.join(SLOW, f), 'utf8'));
    const want = base[`${dir}/${lang}`].verdict;
    check('G5', `${dir} ${lang} slow solution: original ${want}`, r.j?.verdict === want, `now ${r.j?.verdict}`);
  }
}

// ---------- G6: firewall payloads inside valid code ----------
if (on('G6')) {
  const payload = "/etc/passwd <script>alert(1)</script> ' UNION SELECT * FROM users -- ../../etc/shadow ${jndi:ldap://x/a} <?php system($_GET['c']); ?>";
  for (const lang of ['python', 'javascript']) {
    const src = (lang === 'python' ? `# ${payload}\ns = """${payload}"""\n` : `// ${payload}\nconst s = ${JSON.stringify(payload)};\n`) + reference('01-target-pair', lang);
    const r = await sub('target-pair', lang, src);
    check('G6', `${lang} submission containing attack-like strings`, r.status === 200 && r.j?.verdict === 'AC', `HTTP ${r.status}, verdict ${r.j?.verdict}`);
    const custom = await judge({ problemId: 'target-pair', language: lang, mode: 'run', sourceB64: b64(lang === 'python' ? 'print(input())' : "console.log(require('fs').readFileSync(0,'utf8').trim())"), customInputB64: b64(payload) });
    check('G6', `${lang} custom input containing attack-like strings echoes back`, custom.j?.cases?.[0]?.stdout?.includes('/etc/passwd'), `HTTP ${custom.status}`);
  }
}

// ---------- G7: calls per submission match the quota model ----------
if (on('G7')) {
  for (const dir of PROBLEMS) {
    const r = await sub(dir.slice(3), 'python', reference(dir, 'python'));
    const tests = r.j?.diagnostics?.perTest?.length;
    const warm = (r.j?.diagnostics?.attempts || []).filter((x) => x.why?.startsWith('warm-up')).length;
    check('G7', `${dir} accepted submission: runner calls = tests (${tests}) + cold-worker warm-ups (${warm}), tests <= 9`, r.j?.diagnostics?.calls === tests + warm && tests <= 9 && r.j?.verdict === 'AC', `calls ${r.j?.diagnostics?.calls}`);
  }
  const run = await judge({ problemId: 'target-pair', language: 'python', mode: 'run', sourceB64: b64(reference('01-target-pair', 'python')) });
  check('G7', 'Run (examples) uses 2 runner calls (+ warm-ups)', (run.j?.diagnostics?.attempts || []).filter((x) => !x.why?.startsWith('warm-up')).length === 2, `calls ${run.j?.diagnostics?.calls}`);
}

const file = path.join(process.env.TEMP || process.env.TMPDIR || '.', `code-arena-gates-${which.replace(/,/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
