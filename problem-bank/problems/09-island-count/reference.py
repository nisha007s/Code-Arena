# Independent reference: union-find over land cells.
import sys


def main():
    d = sys.stdin.read().split()
    r, c = int(d[0]), int(d[1])
    rows = d[2:2 + r]
    parent = list(range(r * c))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    islands = 0
    for i in range(r):
        row = rows[i]
        for j in range(c):
            if row[j] != '1':
                continue
            islands += 1
            p = i * c + j
            neighbours = []
            if i > 0 and rows[i - 1][j] == '1':
                neighbours.append(p - c)
            if j > 0 and row[j - 1] == '1':
                neighbours.append(p - 1)
            for q in neighbours:
                a, b = find(p), find(q)
                if a != b:
                    parent[a] = b
                    islands -= 1
    print(islands)


main()
