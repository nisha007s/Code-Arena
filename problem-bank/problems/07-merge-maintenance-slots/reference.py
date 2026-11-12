# Independent reference: sort the pairs, then merge into a result list.
import sys


def main():
    d = sys.stdin.buffer.read().split()
    n = int(d[0])
    iv = sorted((int(d[1 + 2 * i]), int(d[2 + 2 * i])) for i in range(n))
    merged = []
    for l, r in iv:
        if merged and l <= merged[-1][1]:
            if r > merged[-1][1]:
                merged[-1][1] = r
        else:
            merged.append([l, r])
    out = [str(len(merged))] + ["%d %d" % (l, r) for l, r in merged]
    sys.stdout.write("\n".join(out) + "\n")


main()
