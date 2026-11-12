#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    long long n, target;
    cin >> n >> target;
    unordered_set<long long> seen;
    seen.reserve(n * 2);
    bool found = false;
    for (long long i = 0; i < n; i++) {
        long long a;
        cin >> a;
        if (!found && seen.count(target - a)) found = true;
        seen.insert(a);
    }
    cout << (found ? "YES" : "NO") << "\n";
    return 0;
}
