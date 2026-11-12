// Reference: bottom-up DP over amounts. O(n * amount).
export function solve(input) {
  const tok = input.split(/\s+/).filter(Boolean).map(Number);
  const [n, amount] = tok;
  const coins = tok.slice(2, 2 + n);
  const INF = 1e9;
  const best = new Array(amount + 1).fill(INF);
  best[0] = 0;
  for (let v = 1; v <= amount; v++) {
    for (const c of coins) if (c <= v && best[v - c] + 1 < best[v]) best[v] = best[v - c] + 1;
  }
  return (best[amount] >= INF ? -1 : best[amount]) + '\n';
}
