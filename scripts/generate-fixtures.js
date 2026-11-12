// Generates the hidden test fixtures for every problem, deterministically.
//
//   npm run fixtures
//
// Small edge cases carry a hand-written expected output; the script checks the
// JS reference agrees before writing anything. Large cases (which penalise
// quadratic solutions) take their expected output from the JS reference and are
// cross-checked later by the independent Python references (npm run check:catalog).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'problem-bank', 'problems');

// Small deterministic PRNG (mulberry32) so fixtures are identical on every run.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = int(0, i); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  return { next, int, shuffle };
}
const letters = 'abcdefghijklmnopqrstuvwxyz';
const line = (arr) => arr.join(' ');

const cases = {
  'target-pair': () => {
    const r = rng(101);
    const evens = Array.from({ length: 200000 }, () => 2 * r.int(-500000000, 500000000));
    const mult4 = Array.from({ length: 199998 }, () => 4 * r.int(-250000000, 249999999));
    const a = 4 * 12345 + 1, b = 4 * -6789 + 2; // the only pair with sum ≡ 3 (mod 4)
    return [
      { name: 'duplicate values needed', input: '4 10\n5 3 5 1\n', expected: 'YES' },
      { name: 'one index cannot be used twice', input: '3 8\n4 1 2\n', expected: 'NO' },
      { name: 'negative values', input: '5 -7\n-10 3 8 -2 5\n', expected: 'YES' },
      { name: 'smallest n', input: '2 0\n0 0\n', expected: 'YES' },
      { name: 'large no match (even values, odd target)', input: `200000 999999999\n${line(evens)}\n` },
      { name: 'large match only at the end', input: `200000 ${a + b}\n${line(mult4)} ${a} ${b}\n` },
    ];
  },
  'bracket-check': () => {
    const r = rng(202);
    const pairs = ['()', '[]', '{}'];
    const stack = [];
    let s = '';
    while (s.length + stack.length < 200000) {
      if (stack.length && (r.next() < 0.5 || s.length + stack.length >= 199998)) s += stack.pop();
      else { const p = pairs[r.int(0, 2)]; s += p[0]; stack.push(p[1]); }
    }
    while (stack.length) s += stack.pop();
    const broken = s.slice(0, -1) + (s.endsWith(')') ? ']' : ')');
    return [
      { name: 'crossed brackets', input: '([)]\n', expected: 'NO' },
      { name: 'leading closer', input: ']()\n', expected: 'NO' },
      { name: 'leftover opener', input: '(()\n', expected: 'NO' },
      { name: 'single character', input: '{\n', expected: 'NO' },
      { name: 'deep nesting', input: '('.repeat(100000) + ')'.repeat(100000) + '\n', expected: 'YES' },
      { name: 'large random balanced', input: s + '\n', expected: 'YES' },
      { name: 'large broken at the end', input: broken + '\n', expected: 'NO' },
    ];
  },
  'first-occurrence': () => {
    const r = rng(303);
    const arr = Array.from({ length: 200000 }, () => r.int(-1000, 1000) * 1000000).sort((x, y) => x - y);
    return [
      { name: 'all equal', input: '5 7\n7 7 7 7 7\n', expected: '0' },
      { name: 'missing between elements', input: '4 5\n1 3 7 9\n', expected: '-1' },
      { name: 'singleton', input: '1 -3\n-3\n', expected: '0' },
      { name: 'last position', input: '6 10\n1 2 3 4 5 10\n', expected: '5' },
      { name: 'smaller than everything', input: '3 -1000000000\n-999999999 0 1000000000\n', expected: '-1' },
      { name: 'large with duplicates', input: `200000 ${arr[123456]}\n${line(arr)}\n` },
      { name: 'large missing', input: `200000 1\n${line(arr)}\n`, expected: '-1' },
    ];
  },
  'longest-streak': () => {
    const r = rng(404);
    const bits = Array.from({ length: 200000 }, () => (r.next() < 0.7 ? 1 : 0));
    for (let i = 150000; i < 150040; i++) bits[i] = 1;
    return [
      { name: 'all zeros', input: '4\n0 0 0 0\n', expected: '0' },
      { name: 'all ones', input: '6\n1 1 1 1 1 1\n', expected: '6' },
      { name: 'one element', input: '1\n1\n', expected: '1' },
      { name: 'longest run at the end', input: '8\n1 1 0 1 0 1 1 1\n', expected: '3' },
      { name: 'large random', input: `200000\n${line(bits)}\n` },
    ];
  },
  'maximum-segment-sum': () => {
    const r = rng(505);
    const vals = Array.from({ length: 200000 }, () => r.int(-1000000000, 1000000000));
    return [
      { name: 'all negative', input: '4\n-8 -3 -6 -2\n', expected: '-2' },
      { name: 'singleton', input: '1\n-5\n', expected: '-5' },
      { name: 'zero is the best', input: '5\n-1 0 -2 0 -3\n', expected: '0' },
      { name: 'exceeds 32-bit', input: '4\n1000000000 1000000000 -1 1000000000\n', expected: '2999999999' },
      { name: 'large all maximal', input: `200000\n${line(new Array(200000).fill(1000000000))}\n`, expected: '200000000000000' },
      { name: 'large random', input: `200000\n${line(vals)}\n` },
    ];
  },
  'unique-window': () => {
    const r = rng(606);
    const rand = Array.from({ length: 200000 }, () => letters[r.int(0, 25)]).join('');
    return [
      { name: 'all the same letter', input: 'aaaa\n', expected: '1' },
      { name: 'all 26 letters', input: letters + '\n', expected: '26' },
      { name: 'abba (left edge never moves back)', input: 'abba\n', expected: '2' },
      { name: 'single letter', input: 'z\n', expected: '1' },
      { name: 'long repeated pattern', input: 'abcdefghij'.repeat(20000) + '\n', expected: '10' },
      { name: 'large random', input: rand + '\n' },
    ];
  },
  'merge-maintenance-slots': () => {
    const r = rng(707);
    const disjoint = r.shuffle(Array.from({ length: 100000 }, (_, i) => {
      const l = -1000000000 + i * 20000;
      return `${l} ${l + 9999}`;
    }));
    const mixed = Array.from({ length: 100000 }, () => {
      const l = r.int(-1000000000, 999000000);
      return `${l} ${l + r.int(0, 30000)}`;
    });
    return [
      { name: 'nested intervals', input: '3\n1 10\n2 3\n4 8\n', expected: '1\n1 10' },
      { name: 'identical intervals', input: '3\n4 6\n4 6\n4 6\n', expected: '1\n4 6' },
      { name: 'adjacent disjoint stay separate', input: '4\n3 3\n1 1\n4 4\n2 2\n', expected: '4\n1 1\n2 2\n3 3\n4 4' },
      { name: 'negative endpoints', input: '4\n-5 -3\n-3 0\n-10 -8\n2 4\n', expected: '3\n-10 -8\n-5 0\n2 4' },
      { name: 'large disjoint (100000 output lines)', input: `100000\n${disjoint.join('\n')}\n` },
      { name: 'large random overlap', input: `100000\n${mixed.join('\n')}\n` },
    ];
  },
  'minimum-coins': () => {
    const r = rng(808);
    const set = new Set();
    while (set.size < 30) set.add(r.int(37, 2500));
    return [
      { name: 'amount zero', input: '2 0\n3 7\n', expected: '0' },
      { name: 'unreachable', input: '2 7\n4 6\n', expected: '-1' },
      { name: 'greedy counterexample', input: '3 30\n1 10 25\n', expected: '3' },
      { name: 'large amount, two coins', input: '2 10000\n1 9999\n', expected: '2' },
      { name: 'large amount unreachable', input: '1 10000\n7\n', expected: '-1' },
      { name: 'large amount, 30 coins', input: `30 9973\n${line([...set])}\n` },
    ];
  },
  'island-count': () => {
    const r = rng(909);
    const R = 400, C = 400;
    const full = Array.from({ length: R }, () => '1'.repeat(C));
    const snake = Array.from({ length: R }, (_, i) => {
      if (i % 2 === 0) return '1'.repeat(C);
      return i % 4 === 1 ? '0'.repeat(C - 1) + '1' : '1' + '0'.repeat(C - 1);
    });
    const random = Array.from({ length: R }, () => Array.from({ length: C }, () => (r.next() < 0.45 ? '1' : '0')).join(''));
    return [
      { name: 'diagonal contact only', input: '3 3\n101\n010\n101\n', expected: '5' },
      { name: 'all water', input: '2 3\n000\n000\n', expected: '0' },
      { name: 'one cell', input: '1 1\n1\n', expected: '1' },
      { name: 'large fully connected', input: `${R} ${C}\n${full.join('\n')}\n`, expected: '1' },
      { name: 'large serpentine path', input: `${R} ${C}\n${snake.join('\n')}\n`, expected: '1' },
      { name: 'large random', input: `${R} ${C}\n${random.join('\n')}\n` },
    ];
  },
  'next-warmer-day': () => {
    const r = rng(1010);
    const n = 200000;
    const delayed = Array.from({ length: n }, (_, i) => (i === n - 1 ? 1000000000 : -i));
    const random = Array.from({ length: n }, () => r.int(-50, 50));
    return [
      { name: 'equal values', input: '4\n5 5 5 5\n', expected: '0 0 0 0' },
      { name: 'descending values', input: '5\n9 7 5 3 1\n', expected: '0 0 0 0 0' },
      { name: 'increasing values', input: '5\n-3 -2 -1 0 1\n', expected: '1 1 1 1 0' },
      { name: 'single day', input: '1\n-4\n', expected: '0' },
      { name: 'long delayed match', input: `${n}\n${line(delayed)}\n` },
      { name: 'large random', input: `${n}\n${line(random)}\n` },
    ];
  },
  'cheapest-route': () => {
    const r = rng(1111);
    const n = 100000;
    const chain = Array.from({ length: n - 1 }, (_, i) => `${i + 1} ${i + 2} 1000000000`);
    const edges = [];
    for (let i = 0; i < 200000; i++) edges.push(`${r.int(1, n)} ${r.int(1, n)} ${r.int(0, 1000000)}`);
    return [
      { name: 'unreachable', input: '3 1 1 3\n1 2 5\n', expected: '-1' },
      { name: 'source equals target', input: '2 1 2 2\n1 2 7\n', expected: '0' },
      { name: 'parallel and zero-weight edges', input: '3 4 1 3\n1 2 5\n1 2 0\n2 3 0\n2 2 3\n', expected: '0' },
      { name: 'directed edge cannot be reversed', input: '2 1 2 1\n1 2 4\n', expected: '-1' },
      { name: 'no edges', input: '1 0 1 1\n', expected: '0' },
      { name: 'long chain needs 64-bit', input: `${n} ${n - 1} 1 ${n}\n${chain.join('\n')}\n`, expected: '99999000000000' },
      { name: 'large random graph', input: `${n} 200000 1 ${n}\n${edges.join('\n')}\n` },
    ];
  },
  'minimum-cover-window': () => {
    const r = rng(1212);
    const S = Array.from({ length: 200000 }, () => letters[r.int(0, 25)]).join('');
    return [
      { name: 'repeated target letters', input: 'baacab\naab\n', expected: 'baa' },
      { name: 'impossible', input: 'aa\naaa\n', expected: '-1' },
      { name: 'equal-length tie picks earliest', input: 'abxba\nab\n', expected: 'ab' },
      { name: 'answer spans all of S', input: 'abcdef\nfedcba\n', expected: 'abcdef' },
      { name: 'T longer than S', input: 'abc\nabcd\n', expected: '-1' },
      { name: 'large quadratic trap', input: 'a'.repeat(199999) + 'b\nab\n', expected: 'ab' },
      { name: 'large random cover of all letters', input: `${S}\nzyxwvutsrqponmlkjihgfedcbaqq\n` },
    ];
  },
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tokens = (s) => s.split(/\s+/).filter(Boolean);
const sameTokens = (a, b) => { const x = tokens(a), y = tokens(b); return x.length === y.length && x.every((t, i) => t === y[i]); };

let failures = 0;
const lock = {};
const checkOnly = process.argv.includes('--check');
for (const dir of fs.readdirSync(root).sort()) {
  const meta = JSON.parse(fs.readFileSync(path.join(root, dir, 'problem.json'), 'utf8'));
  const { solve } = await import(pathToFileURL(path.join(root, dir, 'reference.js')).href);
  for (const ex of meta.examples) {
    if (!sameTokens(solve(ex.input), ex.output)) { console.error(`✗ ${meta.id}: public example mismatch`); failures++; }
  }
  const list = cases[meta.id]();
  const testDir = path.join(root, dir, 'tests');
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });
  const index = [];
  list.forEach((c, i) => {
    const out = solve(c.input);
    if (c.expected !== undefined && !sameTokens(out, c.expected)) {
      console.error(`✗ ${meta.id} / ${c.name}: reference gave ${out.slice(0, 60)} expected ${c.expected}`);
      failures++;
    }
    const base = `hidden-${String(i + 1).padStart(2, '0')}`;
    fs.writeFileSync(path.join(testDir, base + '.in'), c.input);
    fs.writeFileSync(path.join(testDir, base + '.out'), out);
    lock[`${dir}/tests/${base}.in`] = sha256(c.input);
    lock[`${dir}/tests/${base}.out`] = sha256(out);
    index.push({ file: base, name: c.name, handChecked: c.expected !== undefined });
  });
  fs.writeFileSync(path.join(testDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`✓ ${meta.id}: ${meta.examples.length} public, ${list.length} hidden`);
}
if (failures) { console.error(`${failures} fixture check(s) failed`); process.exit(1); }

// The lock file is committed; the large fixtures themselves are regenerated on install.
const lockPath = path.join(root, '..', 'fixtures.lock.json');
const lockText = JSON.stringify(lock, null, 2) + '\n';
if (checkOnly) {
  const committed = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : '';
  if (committed !== lockText) { console.error('Generated fixtures differ from fixtures.lock.json'); process.exit(1); }
  console.log('Fixtures match fixtures.lock.json');
} else {
  fs.writeFileSync(lockPath, lockText);
}
