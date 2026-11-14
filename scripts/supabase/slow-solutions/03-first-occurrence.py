# Slow: linear scan instead of binary search, O(n).
import sys
d = list(map(int, sys.stdin.buffer.read().split())); n, x = d[0], d[1]; a = d[2:2 + n]
ans = -1
for i in range(n):
    if a[i] == x:
        ans = i; break
print(ans)
