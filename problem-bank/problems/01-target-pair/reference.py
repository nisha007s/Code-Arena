# Independent reference: sort + two pointers. O(n log n).
import sys


def main():
    d = sys.stdin.buffer.read().split()
    n, t = int(d[0]), int(d[1])
    a = sorted(int(x) for x in d[2:2 + n])
    i, j = 0, n - 1
    while i < j:
        s = a[i] + a[j]
        if s == t:
            print("YES")
            return
        if s < t:
            i += 1
        else:
            j -= 1
    print("NO")


main()
