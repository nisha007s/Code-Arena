# Independent reference: for each left edge, advance the right edge (both only move forward).
import sys


def main():
    data = sys.stdin.read().split()
    S, T = data[0], data[1]
    need = [0] * 26
    for ch in T:
        need[ord(ch) - 97] += 1
    have = [0] * 26
    deficit = sum(1 for k in need if k > 0)
    best = None
    r = 0
    n = len(S)
    for l in range(n):
        while r < n and deficit > 0:
            k = ord(S[r]) - 97
            have[k] += 1
            if have[k] == need[k]:
                deficit -= 1
            r += 1
        if deficit > 0:
            break
        if best is None or r - l < best[1] - best[0]:
            best = (l, r)
        k = ord(S[l]) - 97
        if have[k] == need[k]:
            deficit += 1
        have[k] -= 1
    print(S[best[0]:best[1]] if best else -1)


main()
