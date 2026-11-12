// Reference: hash set of values seen so far. O(n).
export function solve(input) {
  const tok = input.split(/\s+/).filter(Boolean).map(Number);
  const [n, target] = tok;
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const a = tok[2 + i];
    if (seen.has(target - a)) return 'YES\n';
    seen.add(a);
  }
  return 'NO\n';
}
