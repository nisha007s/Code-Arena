// Reference: sliding window with the last-seen index per letter. O(n).
export function solve(input) {
  const s = input.trim();
  const last = new Array(26).fill(-1);
  let left = 0, best = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 97;
    if (last[c] >= left) left = last[c] + 1;
    last[c] = i;
    if (i - left + 1 > best) best = i - left + 1;
  }
  return best + '\n';
}
