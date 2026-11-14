// Unmeasured warm-up run in each fresh JavaScript runner worker (see runner-core.ts):
// exercises the QuickJS paths typical solutions use, so lazy WebAssembly compilation never
// counts against a student's time.
const t = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const seen = new Set();
const pos = new Map();
t.forEach((x, i) => { seen.add(x); pos.set(x, i); });
const sorted = [...t].sort((a, b) => a - b);
const heap = [];
for (const x of t) {
  heap.push([x, 0]);
  let i = heap.length - 1;
  while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
}
const head = new Int32Array(1000).fill(-1);
const dist = new Float64Array(1000).fill(Infinity);
const stack = [];
for (let i = 0; i < t.length; i++) { while (stack.length && t[stack[stack.length - 1]] < t[i]) stack.pop(); stack.push(i); }
const counts = {};
let word = '';
for (const x of t.slice(0, 600)) { const ch = String.fromCharCode(97 + (((x % 26) + 26) % 26)); counts[ch] = (counts[ch] || 0) + 1; word += ch; }
const out = sorted.slice(0, 2000).map(String);
console.log(sorted.reduce((a, b) => a + b, 0), seen.size, head[0], dist[0], stack.length, word.slice(0, 10), Object.keys(counts).length);
process.stdout.write(out.join(' ') + '\n');
