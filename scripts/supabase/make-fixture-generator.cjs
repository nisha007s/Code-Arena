// Builds a resized copy of scripts/generate-fixtures.js (which stays untouched) for the
// WebAssembly judge: only the 7 heavy problems shrink. Usage: node make-fixture-generator.cjs <repoRoot> <outDir>
// The generated script writes fixtures to <outDir>/fixtures and never touches problem-bank/ or fixtures.lock.json.
const fs = require('fs');
const path = require('path');
const src = path.join(process.argv[2], 'scripts', 'generate-fixtures.js');
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });
let s = fs.readFileSync(src, 'utf8');
const NL = String.raw`\n`;
const sect = (id) => { const a = s.indexOf(`'${id}': () => {`); const b = s.indexOf('\n  },\n', a); if (a < 0 || b < 0) throw new Error('section ' + id); return [a, b]; };
const edit = (id, pairs) => {
  const [a, b] = sect(id); let t = s.slice(a, b);
  for (const [x, y] of pairs) { if (!t.includes(x)) throw new Error(`${id}: missing ${x}`); t = t.split(x).join(y); }
  s = s.slice(0, a) + t + s.slice(b);
};
edit('target-pair', [['length: 200000', 'length: 40000'], ['length: 199998', 'length: 39998'], ['`200000 999999999', '`40000 999999999'], ['`200000 ${a + b}', '`40000 ${a + b}']]);
edit('first-occurrence', [['length: 200000', 'length: 100000'], ['arr[123456]', 'arr[61728]'], ['`200000 ', '`100000 ']]);
edit('longest-streak', [['length: 200000', 'length: 150000'], ['i = 150000; i < 150040', 'i = 100000; i < 100040'], ['`200000' + NL, '`150000' + NL]]);
edit('maximum-segment-sum', [['length: 200000', 'length: 80000'], ['`200000' + NL, '`80000' + NL], ['new Array(200000)', 'new Array(80000)'], ["expected: '200000000000000'", "expected: '80000000000000'"]]);
edit('merge-maintenance-slots', [['length: 100000', 'length: 25000'], ['(100000 output lines)', '(25000 output lines)'], ['`100000' + NL, '`25000' + NL]]);
edit('next-warmer-day', [['const n = 200000;', 'const n = 80000;']]);
edit('cheapest-route', [['const n = 100000;', 'const n = 20000;'], ['i < 200000', 'i < 40000'], ['${n} 200000 1', '${n} 40000 1'], ["expected: '99999000000000'", "expected: '19999000000000'"]]);
const swap = (x, y) => { if (!s.includes(x)) throw new Error('missing ' + x); s = s.replace(x, y); };
swap("const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'problem-bank', 'problems');",
  "const root = process.argv[2]; // repository problems dir, read-only\nconst outRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');");
swap("const testDir = path.join(root, dir, 'tests');", "const testDir = path.join(outRoot, dir);");
const li = s.indexOf('// The lock file is committed');
s = s.slice(0, li) + "fs.writeFileSync(path.join(outRoot, 'fixtures.lock.json'), JSON.stringify(lock, null, 2) + '\\n');\n";
if (/problem-bank/.test(s)) throw new Error('output still points into the repository');
fs.writeFileSync(path.join(outDir, 'gen-small.mjs'), s);
console.log('gen-small.mjs written');
