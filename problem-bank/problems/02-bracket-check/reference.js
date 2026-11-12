// Reference: explicit stack. O(n).
export function solve(input) {
  const s = input.trim();
  const match = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (stack.pop() !== match[ch]) return 'NO\n';
  }
  return stack.length === 0 ? 'YES\n' : 'NO\n';
}
