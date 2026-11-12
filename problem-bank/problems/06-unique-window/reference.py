# Independent reference: window kept as a set, shrinking from the left.
import sys


def main():
    s = sys.stdin.readline().strip()
    inside = set()
    left = 0
    best = 0
    for ch in s:
        while ch in inside:
            inside.discard(s[left])
            left += 1
        inside.add(ch)
        best = max(best, len(inside))
    print(best)


main()
