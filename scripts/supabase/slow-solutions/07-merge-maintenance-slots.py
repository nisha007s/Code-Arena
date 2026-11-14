# Slow: insert each booking into an unsorted list, merging by scanning, O(n^2).
import sys
d = list(map(int, sys.stdin.buffer.read().split())); n = d[0]; lst = []
for i in range(n):
    l, r = d[1 + 2 * i], d[2 + 2 * i]; changed = True
    while changed:
        changed = False; keep = []
        for a, b in lst:
            if a <= r and l <= b:
                l, r = min(l, a), max(r, b); changed = True
            else:
                keep.append((a, b))
        lst = keep
    lst.append((l, r))
lst.sort()
print(len(lst)); print('\n'.join(f'{a} {b}' for a, b in lst))
