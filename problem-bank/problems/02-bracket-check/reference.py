# Independent reference: stack of expected closing brackets.
import sys


def main():
    s = sys.stdin.readline().strip()
    close = {'(': ')', '[': ']', '{': '}'}
    need = []
    for ch in s:
        if ch in close:
            need.append(close[ch])
        elif not need or need.pop() != ch:
            print("NO")
            return
    print("NO" if need else "YES")


main()
