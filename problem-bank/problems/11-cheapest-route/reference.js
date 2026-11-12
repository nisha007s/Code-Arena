// Reference: Dijkstra with a binary heap and lazy deletion. O((n + m) log n).
// Costs stay below 2^53, so Number is exact.
export function solve(input) {
  const tok = input.split(/\s+/).filter(Boolean).map(Number);
  const [n, m, s, t] = tok;
  const head = new Int32Array(n + 1).fill(-1);
  const next = new Int32Array(m), to = new Int32Array(m), w = new Float64Array(m);
  for (let e = 0; e < m; e++) {
    const u = tok[4 + 3 * e];
    to[e] = tok[5 + 3 * e];
    w[e] = tok[6 + 3 * e];
    next[e] = head[u];
    head[u] = e;
  }
  const dist = new Float64Array(n + 1).fill(Infinity);
  dist[s] = 0;
  const heap = [[0, s]];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let k = i;
        if (l < heap.length && heap[l][0] < heap[k][0]) k = l;
        if (r < heap.length && heap[r][0] < heap[k][0]) k = r;
        if (k === i) break;
        [heap[k], heap[i]] = [heap[i], heap[k]];
        i = k;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    if (u === t) break;
    for (let e = head[u]; e !== -1; e = next[e]) {
      const nd = d + w[e];
      if (nd < dist[to[e]]) { dist[to[e]] = nd; push([nd, to[e]]); }
    }
  }
  return (dist[t] === Infinity ? -1 : dist[t]) + '\n';
}
