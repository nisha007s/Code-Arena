# Slow: Dijkstra without a heap (linear scan for the next vertex), O(n^2 + m).
import sys
d = list(map(int, sys.stdin.buffer.read().split())); n, m, s, t = d[:4]
adj = [[] for _ in range(n + 1)]
for e in range(m):
    adj[d[4 + 3 * e]].append((d[5 + 3 * e], d[6 + 3 * e]))
INF = float('inf'); dist = [INF] * (n + 1); done = [False] * (n + 1); dist[s] = 0
for _ in range(n):
    u = -1
    for v in range(1, n + 1):
        if not done[v] and (u < 0 or dist[v] < dist[u]): u = v
    if u < 0 or dist[u] == INF: break
    done[u] = True
    for v, w in adj[u]:
        if dist[u] + w < dist[v]: dist[v] = dist[u] + w
print(-1 if dist[t] == INF else dist[t])
