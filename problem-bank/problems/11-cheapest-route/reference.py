# Independent reference: Dijkstra with heapq over adjacency lists.
import sys
import heapq


def main():
    d = sys.stdin.buffer.read().split()
    n, m, s, t = int(d[0]), int(d[1]), int(d[2]), int(d[3])
    adj = [[] for _ in range(n + 1)]
    for e in range(m):
        u, v, w = int(d[4 + 3 * e]), int(d[5 + 3 * e]), int(d[6 + 3 * e])
        adj[u].append((v, w))
    INF = float("inf")
    dist = [INF] * (n + 1)
    dist[s] = 0
    pq = [(0, s)]
    while pq:
        du, u = heapq.heappop(pq)
        if du != dist[u]:
            continue
        for v, w in adj[u]:
            nd = du + w
            if nd < dist[v]:
                dist[v] = nd
                heapq.heappush(pq, (nd, v))
    print(dist[t] if dist[t] != INF else -1)


main()
