// Reference: Kadane's algorithm. O(n). Totals stay below 2^53, so Number is exact.
export function solve(input) {
  const tok = input.split(/\s+/).filter(Boolean).map(Number);
  const n = tok[0];
  let best = tok[1], here = tok[1];
  for (let i = 2; i <= n; i++) {
    const a = tok[i];
    here = Math.max(a, here + a);
    if (here > best) best = here;
  }
  return best + '\n';
}
