# Slow: restart a count from every position, O(n * run length).
import sys
t = sys.stdin.buffer.read().split(); n = int(t[0]); best = 0
for i in range(1, n + 1):
    c = 0
    while i + c <= n and t[i + c] == b'1':
        c += 1
    best = max(best, c)
print(best)
