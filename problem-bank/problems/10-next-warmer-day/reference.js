// Reference: monotonic stack of indices with decreasing temperatures. O(n).
export function solve(input) {
  const tok = input.split(/\s+/).filter(Boolean).map(Number);
  const n = tok[0];
  const t = tok.slice(1, 1 + n);
  const ans = new Array(n).fill(0);
  const stack = [];
  for (let i = 0; i < n; i++) {
    while (stack.length && t[stack[stack.length - 1]] < t[i]) {
      const j = stack.pop();
      ans[j] = i - j;
    }
    stack.push(i);
  }
  return ans.join(' ') + '\n';
}
