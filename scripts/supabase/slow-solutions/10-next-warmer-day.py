# Slow: scan forward from every day, O(n^2).
import sys
d = list(map(int, sys.stdin.buffer.read().split())); n = d[0]; t = d[1:1 + n]; ans = [0] * n
for i in range(n):
    for j in range(i + 1, n):
        if t[j] > t[i]:
            ans[i] = j - i; break
print(' '.join(map(str, ans)))
