const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const [n, target] = data;
const seen = new Set();
let found = false;
for (let i = 0; i < n && !found; i++) {
  const a = data[2 + i];
  if (seen.has(target - a)) found = true;
  seen.add(a);
}
console.log(found ? 'YES' : 'NO');
