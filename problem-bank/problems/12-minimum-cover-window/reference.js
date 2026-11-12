// Reference: two pointers with letter counts and a "missing" counter. O(|S| + |T|).
export function solve(input) {
  const [S = '', T = ''] = input.split(/\s+/).filter(Boolean);
  const need = new Int32Array(26);
  for (let i = 0; i < T.length; i++) need[T.charCodeAt(i) - 97]++;
  let missing = T.length, left = 0, bestLen = Infinity, bestStart = 0;
  for (let right = 0; right < S.length; right++) {
    const c = S.charCodeAt(right) - 97;
    if (need[c] > 0) missing--;
    need[c]--;
    if (missing > 0) continue;
    while (need[S.charCodeAt(left) - 97] < 0) { need[S.charCodeAt(left) - 97]++; left++; }
    // Strictly shorter only: earlier windows win ties, which gives the earliest start.
    if (right - left + 1 < bestLen) { bestLen = right - left + 1; bestStart = left; }
  }
  return (bestLen === Infinity ? '-1' : S.slice(bestStart, bestStart + bestLen)) + '\n';
}
