# Slow but correct: check every pair, O(n^2).
import sys
d = list(map(int, sys.stdin.buffer.read().split())); n, target = d[0], d[1]; a = d[2:2 + n]
print('YES' if any(a[i] + a[j] == target for i in range(n) for j in range(i + 1, n)) else 'NO')
