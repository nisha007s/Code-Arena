# Unmeasured warm-up run in each fresh Python runner worker (see runner-core.ts):
# exercises the interpreter paths typical solutions use, so lazy WebAssembly compilation
# never counts against a student's time.
import sys, heapq, bisect, collections, itertools, functools, math, re

data = sys.stdin.read().split()
nums = list(map(int, data))
seen = set()
pos = {}
for i, x in enumerate(nums):
    seen.add(x)
    pos[x] = i
h = []
for i, x in enumerate(nums):
    heapq.heappush(h, (x, i))
out = []
while h:
    out.append(heapq.heappop(h)[0])
dq = collections.deque(nums)
dq.rotate(3)
grid = [[(i * j) % 7 for j in range(30)] for i in range(30)]
stack = [(0, 0)]
visited = {(0, 0)}
while stack:
    r, c = stack.pop()
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nr, nc = r + dr, c + dc
        if 0 <= nr < 30 and 0 <= nc < 30 and (nr, nc) not in visited and grid[nr][nc] != 3:
            visited.add((nr, nc))
            stack.append((nr, nc))
counts = collections.Counter(x % 26 for x in nums)
word = ''.join(chr(97 + (x % 26)) for x in nums[:600])
print(sum(sorted(nums)), len(seen), len(visited), bisect.bisect_left(out, 0), counts.most_common(1), word[:10])
print(' '.join(map(str, out[:2000])))
