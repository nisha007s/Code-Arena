// Slow: scan forward from every day, O(n^2).
const t = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = t[0]; const ans = new Array(n).fill(0);
for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (t[1 + j] > t[1 + i]) { ans[i] = j - i; break; }
console.log(ans.join(' '));
