// Slow: linear scan instead of binary search, O(n).
const t = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = t[0], x = t[1]; let ans = -1;
for (let i = 0; i < n; i++) if (t[2 + i] === x) { ans = i; break; }
console.log(ans);
