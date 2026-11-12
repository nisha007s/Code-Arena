# Independent reference: bisect_left from the standard library.
import sys
from bisect import bisect_left


def main():
    d = sys.stdin.buffer.read().split()
    n, x = int(d[0]), int(d[1])
    a = [int(v) for v in d[2:2 + n]]
    i = bisect_left(a, x)
    print(i if i < n and a[i] == x else -1)


main()
