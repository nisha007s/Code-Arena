// Slow: try every segment with prefix sums, O(n^2).
const t = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = t[0]; let best = -Infinity;
for (let i = 0; i < n; i++) { let s = 0; for (let j = i; j < n; j++) { s += t[1 + j]; if (s > best) best = s; } }
console.log(String(best));
