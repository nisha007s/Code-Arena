// Reference: sort by left endpoint, then merge closed intervals. O(n log n).
export function solve(input) {
  const tok = input.split(/\s+/).filter(Boolean).map(Number);
  const n = tok[0];
  const iv = [];
  for (let i = 0; i < n; i++) iv.push([tok[1 + 2 * i], tok[2 + 2 * i]]);
  iv.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  let [l, r] = iv[0];
  for (let i = 1; i < n; i++) {
    const [a, b] = iv[i];
    if (a <= r) { if (b > r) r = b; }
    else { out.push(l + ' ' + r); l = a; r = b; }
  }
  out.push(l + ' ' + r);
  return out.length + '\n' + out.join('\n') + '\n';
}
