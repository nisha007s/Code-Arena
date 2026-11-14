// Slow: restart a count from every position, O(n * run length).
const t = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean);
const n = Number(t[0]); let best = 0;
for (let i = 1; i <= n; i++) { let c = 0; while (i + c <= n && t[i + c] === '1') c++; if (c > best) best = c; }
console.log(best);
