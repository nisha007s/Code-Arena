import sys


def main():
    data = sys.stdin.read().split()
    n, target = int(data[0]), int(data[1])
    seen = set()
    for i in range(n):
        a = int(data[2 + i])
        if target - a in seen:
            print("YES")
            return
        seen.add(a)
    print("NO")


main()
