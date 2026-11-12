# Independent reference: breadth-first search over amounts (each step adds one coin).
import sys
from collections import deque


def main():
    d = sys.stdin.read().split()
    n, amount = int(d[0]), int(d[1])
    coins = [int(x) for x in d[2:2 + n]]
    dist = [-1] * (amount + 1)
    dist[0] = 0
    q = deque([0])
    while q:
        v = q.popleft()
        for c in coins:
            w = v + c
            if w <= amount and dist[w] == -1:
                dist[w] = dist[v] + 1
                q.append(w)
    print(dist[amount])


main()
