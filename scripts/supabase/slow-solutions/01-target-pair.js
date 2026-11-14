// Slow but correct: check every pair, O(n^2).
const t = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = t[0], target = t[1]; let ok = false;
for (let i = 0; i < n && !ok; i++) for (let j = i + 1; j < n; j++) if (t[2 + i] + t[2 + j] === target) { ok = true; break; }
console.log(ok ? 'YES' : 'NO');
