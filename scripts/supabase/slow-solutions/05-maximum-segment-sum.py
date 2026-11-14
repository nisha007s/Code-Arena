# Slow: try every segment, O(n^2).
import sys
d = list(map(int, sys.stdin.buffer.read().split())); n = d[0]; a = d[1:1 + n]; best = a[0]
for i in range(n):
    s = 0
    for j in range(i, n):
        s += a[j]
        if s > best: best = s
print(best)
