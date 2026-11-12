// Reference: one pass with a current run and a best run. O(n).
export function solve(input) {
  const tok = input.split(/\s+/).filter(Boolean);
  const n = Number(tok[0]);
  let cur = 0, best = 0;
  for (let i = 1; i <= n; i++) {
    cur = tok[i] === '1' ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best + '\n';
}
