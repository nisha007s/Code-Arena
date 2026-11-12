# Independent reference: scan from the right, jumping along known answers.
import sys


def main():
    d = sys.stdin.buffer.read().split()
    n = int(d[0])
    t = [int(x) for x in d[1:1 + n]]
    ans = [0] * n
    for i in range(n - 2, -1, -1):
        j = i + 1
        while j < n and t[j] <= t[i]:
            j = j + ans[j] if ans[j] else n
        ans[i] = j - i if j < n else 0
    sys.stdout.write(" ".join(map(str, ans)) + "\n")


main()
