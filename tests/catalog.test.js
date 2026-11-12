// Problem bank structure, public allowlist, and brute-force cross-checks of the
// reference solutions on random small inputs (independent edge-case review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bank } from './helpers.js';
import { compareOutput } from '../server/judge/compare.js';
import { LANGUAGE_IDS } from '../server/judge/languages.js';

const ref = async (id) => (await import(pathToFileURL(path.join(bank.get(id).dir, 'reference.js')).href)).solve;

test('exactly 12 problems with unique ids, numbers and enough cases', () => {
  assert.equal(bank.list.length, 12);
  assert.equal(new Set(bank.list.map((p) => p.id)).size, 12);
  assert.deepEqual(bank.list.map((p) => p.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (const p of bank.list) {
    assert.ok(['easy', 'medium', 'hard'].includes(p.difficulty));
    assert.ok(p.tests.filter((t) => t.visibility === 'public').length >= 2, p.id);
    assert.ok(p.tests.filter((t) => t.visibility === 'hidden').length >= 4, p.id);
    assert.ok(p.private.complexity, p.id);
  }
});

test('public problem objects use the explicit allowlist and leak nothing private', () => {
  const allowed = ['constraints', 'difficulty', 'examples', 'id', 'inputFormat', 'number', 'outputFormat', 'starters', 'statement', 'tags', 'title'];
  for (const p of bank.list) {
    const pub = bank.publicDetail(p);
    assert.deepEqual(Object.keys(pub).sort(), allowed);
    const text = JSON.stringify(pub);
    assert.ok(!text.includes(p.private.complexity));
    assert.ok(!text.includes('hidden-0'));
    for (const t of p.tests.filter((x) => x.visibility === 'hidden')) {
      const out = bank.readExpected(t).trim();
      if (out.length > 12) assert.ok(!text.includes(out.slice(0, 60)), `${p.id}: hidden output appears in public view`);
    }
  }
});

test('60 starter templates state the input format and mark the student area', () => {
  let n = 0;
  for (const p of bank.list) {
    const { starters } = bank.publicDetail(p);
    for (const lang of LANGUAGE_IDS) {
      assert.match(starters[lang], /Input format:/);
      assert.match(starters[lang], /Write your solution below/);
      assert.ok(starters[lang].includes(p.starter.input[0]));
      n++;
    }
  }
  assert.equal(n, 60);
});

test('token comparison: whitespace and line endings are ignored, extra output is not', () => {
  assert.equal(compareOutput('2\r\n1 7\n9 10\n', '2\n1 7\n9 10'), true);
  assert.equal(compareOutput('  YES  ', 'YES\n'), true);
  assert.equal(compareOutput('YES\nYES', 'YES'), false);
  assert.equal(compareOutput('yes', 'YES'), false);
  assert.equal(compareOutput('', ''), true);
});

// --- brute force vs reference on random small inputs ---
let s = 42;
const rnd = (lo, hi) => { s = (s * 1103515245 + 12345) % 2147483648; return lo + (s % (hi - lo + 1)); };
const arr = (n, lo, hi) => Array.from({ length: n }, () => rnd(lo, hi));

const brute = {
  'target-pair': (n, t, a) => { for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (a[i] + a[j] === t) return 'YES'; return 'NO'; },
  'maximum-segment-sum': (a) => { let b = -Infinity; for (let i = 0; i < a.length; i++) { let x = 0; for (let j = i; j < a.length; j++) { x += a[j]; b = Math.max(b, x); } } return String(b); },
  'unique-window': (str) => { let b = 0; for (let i = 0; i < str.length; i++) for (let j = i; j < str.length; j++) { const w = str.slice(i, j + 1); if (new Set(w).size === w.length) b = Math.max(b, w.length); } return String(b); },
  'next-warmer-day': (t) => t.map((x, i) => { for (let j = i + 1; j < t.length; j++) if (t[j] > x) return j - i; return 0; }).join(' '),
  'minimum-cover-window': (S, T) => {
    const need = {}; for (const c of T) need[c] = (need[c] || 0) + 1;
    for (let len = T.length; len <= S.length; len++) for (let i = 0; i + len <= S.length; i++) {
      const have = {}; for (const c of S.slice(i, i + len)) have[c] = (have[c] || 0) + 1;
      if (Object.keys(need).every((c) => (have[c] || 0) >= need[c])) return S.slice(i, i + len);
    }
    return '-1';
  },
  'merge-maintenance-slots': (iv) => {
    // Merge any two overlapping closed intervals until nothing changes (touching ones stay apart).
    let list = iv.map((x) => [...x]);
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]];
        if (a[0] <= b[1] && b[0] <= a[1]) { list[i] = [Math.min(a[0], b[0]), Math.max(a[1], b[1])]; list.splice(j, 1); changed = true; break outer; }
      }
    }
    list.sort((a, b) => a[0] - b[0]);
    return [list.length, ...list.map((x) => x.join(' '))].join('\n');
  },
  'minimum-coins': (coins, amount) => {
    let best = Infinity;
    const go = (left, used, k) => { if (used >= best) return; if (left === 0) { best = used; return; } if (k < 0) return; for (let c = Math.floor(left / coins[k]); c >= 0; c--) go(left - c * coins[k], used + c, k - 1); };
    go(amount, 0, coins.length - 1);
    return String(best === Infinity ? -1 : best);
  },
};

test('reference solutions agree with brute force on 1,400 random small inputs', async () => {
  const letters = 'abcd';
  for (let k = 0; k < 200; k++) {
    const n = rnd(2, 8), a = arr(n, -6, 6), t = rnd(-8, 8);
    assert.ok(compareOutput((await ref('target-pair'))(`${n} ${t}\n${a.join(' ')}\n`), brute['target-pair'](n, t, a)));
    const b = arr(rnd(1, 8), -9, 9);
    assert.ok(compareOutput((await ref('maximum-segment-sum'))(`${b.length}\n${b.join(' ')}\n`), brute['maximum-segment-sum'](b)));
    const str = Array.from({ length: rnd(1, 10) }, () => letters[rnd(0, 3)]).join('');
    assert.ok(compareOutput((await ref('unique-window'))(str + '\n'), brute['unique-window'](str)));
    const temps = arr(rnd(1, 9), 0, 5);
    assert.ok(compareOutput((await ref('next-warmer-day'))(`${temps.length}\n${temps.join(' ')}\n`), brute['next-warmer-day'](temps)));
    const S = Array.from({ length: rnd(1, 9) }, () => letters[rnd(0, 3)]).join('');
    const T = Array.from({ length: rnd(1, 3) }, () => letters[rnd(0, 3)]).join('');
    assert.equal((await ref('minimum-cover-window'))(`${S}\n${T}\n`).trim(), brute['minimum-cover-window'](S, T), `${S} / ${T}`);
    const iv = Array.from({ length: rnd(1, 6) }, () => { const l = rnd(-5, 5); return [l, l + rnd(0, 3)]; });
    const ivIn = `${iv.length}\n${iv.map((x) => x.join(' ')).join('\n')}\n`;
    assert.ok(compareOutput((await ref('merge-maintenance-slots'))(ivIn), brute['merge-maintenance-slots'](iv)), ivIn);
    const coins = [...new Set(arr(rnd(1, 4), 1, 9))].sort((x, y) => x - y), amount = rnd(0, 30);
    assert.ok(compareOutput((await ref('minimum-coins'))(`${coins.length} ${amount}\n${coins.join(' ')}\n`), brute['minimum-coins'](coins, amount)));
  }
});
