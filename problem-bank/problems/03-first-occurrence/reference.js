// Reference: lower-bound binary search. O(log n) after reading the input.
export function solve(input) {
  const tok = input.split(/\s+/).filter(Boolean).map(Number);
  const [n, x] = tok;
  let lo = 0, hi = n; // find the first index with a[i] >= x
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (tok[2 + mid] < x) lo = mid + 1; else hi = mid;
  }
  return (lo < n && tok[2 + lo] === x ? lo : -1) + '\n';
}
