// Reference: iterative flood fill with an explicit stack. O(r * c).
export function solve(input) {
  const tok = input.split(/\s+/).filter(Boolean);
  const r = Number(tok[0]), c = Number(tok[1]);
  const grid = new Uint8Array(r * c);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) grid[i * c + j] = tok[2 + i].charCodeAt(j) === 49 ? 1 : 0;
  let count = 0;
  const stack = [];
  for (let start = 0; start < r * c; start++) {
    if (!grid[start]) continue;
    count++;
    grid[start] = 0;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const i = Math.floor(p / c), j = p % c;
      if (i > 0 && grid[p - c]) { grid[p - c] = 0; stack.push(p - c); }
      if (i < r - 1 && grid[p + c]) { grid[p + c] = 0; stack.push(p + c); }
      if (j > 0 && grid[p - 1]) { grid[p - 1] = 0; stack.push(p - 1); }
      if (j < c - 1 && grid[p + 1]) { grid[p + 1] = 0; stack.push(p + 1); }
    }
  }
  return count + '\n';
}
