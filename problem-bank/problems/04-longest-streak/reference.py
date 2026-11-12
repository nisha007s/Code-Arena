# Independent reference: join the digits and split on zeros.
import sys


def main():
    d = sys.stdin.read().split()
    n = int(d[0])
    s = "".join(d[1:1 + n])
    print(max(len(run) for run in s.split("0")))


main()
