# Independent reference: prefix sums with the running minimum prefix.
import sys


def main():
    d = sys.stdin.buffer.read().split()
    n = int(d[0])
    best = None
    prefix = 0
    min_prefix = 0
    for i in range(1, n + 1):
        prefix += int(d[i])
        cand = prefix - min_prefix
        if best is None or cand > best:
            best = cand
        if prefix < min_prefix:
            min_prefix = prefix
    print(best)


main()
