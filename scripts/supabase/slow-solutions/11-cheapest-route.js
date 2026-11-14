// Slow: Dijkstra without a heap (linear scan for the next vertex), O(n^2 + m).
const t = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const [n, m, s, tt] = t; const adj = Array.from({ length: n + 1 }, () => []);
for (let e = 0; e < m; e++) adj[t[4 + 3 * e]].push([t[5 + 3 * e], t[6 + 3 * e]]);
const dist = new Array(n + 1).fill(Infinity), done = new Array(n + 1).fill(false); dist[s] = 0;
for (let k = 0; k < n; k++) {
  let u = -1; for (let v = 1; v <= n; v++) if (!done[v] && (u < 0 || dist[v] < dist[u])) u = v;
  if (u < 0 || dist[u] === Infinity) break; done[u] = true;
  for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) dist[v] = dist[u] + w;
}
console.log(dist[tt] === Infinity ? -1 : dist[tt]);
