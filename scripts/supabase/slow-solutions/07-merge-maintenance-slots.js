// Slow: insert each booking into an unsorted list, merging by scanning, O(n^2).
const t = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = t[0]; let list = [];
for (let i = 0; i < n; i++) {
  let l = t[1 + 2 * i], r = t[2 + 2 * i], changed = true;
  while (changed) { changed = false; const keep = []; for (const [a, b] of list) { if (a <= r && l <= b) { l = Math.min(l, a); r = Math.max(r, b); changed = true; } else keep.push([a, b]); } list = keep; }
  list.push([l, r]);
}
list.sort((x, y) => x[0] - y[0]);
console.log(list.length + '\n' + list.map(([a, b]) => a + ' ' + b).join('\n'));
