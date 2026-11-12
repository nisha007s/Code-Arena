// Starter templates: one per problem and language (12 × 5 = 60), generated from
// each problem's input/output description. Every template compiles or parses,
// reads all of standard input as tokens, and marks where student logic goes.
// `npm run check:starters` compiles all 60 through the judge.

function header(problem, prefix) {
  const lines = [
    `Problem ${problem.number}: ${problem.title}`,
    'Input format:',
    ...problem.starter.input.map((l) => '  ' + l),
    `Output: ${problem.starter.output}`,
  ];
  return lines.map((l) => (prefix + ' ' + l).trimEnd()).join('\n');
}

const templates = {
  python: (p) => `${header(p, '#')}
import sys


def main():
    # Every whitespace-separated token from standard input, as strings.
    data = sys.stdin.read().split()

    # ==== Write your solution below ====

    answer = ""
    print(answer)


main()
`,
  javascript: (p) => `${header(p, '//')}
const data = require('fs').readFileSync(0, 'utf8').split(/\\s+/).filter(Boolean);
// data holds every whitespace-separated token from standard input, as strings.

// ==== Write your solution below ====

let answer = '';
console.log(String(answer));
`,
  java: (p) => `${header(p, '//')}
import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        // Every whitespace-separated token from standard input, as strings.
        String all = new String(System.in.readAllBytes()).trim();
        String[] data = all.isEmpty() ? new String[0] : all.split("\\\\s+");

        // ==== Write your solution below ====

        StringBuilder out = new StringBuilder();
        System.out.println(out);
    }
}
`,
  cpp: (p) => `${header(p, '//')}
#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    // Every whitespace-separated token from standard input, as strings.
    vector<string> data;
    string token;
    while (cin >> token) data.push_back(token);

    // ==== Write your solution below ====

    string answer;
    cout << answer << "\\n";
    return 0;
}
`,
  csharp: (p) => `${header(p, '//')}
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

public static class Program
{
    public static void Main()
    {
        // Every whitespace-separated token from standard input, as strings.
        string[] data = Console.In.ReadToEnd().Split((char[])null, StringSplitOptions.RemoveEmptyEntries);

        // ==== Write your solution below ====

        var output = new StringBuilder();
        Console.WriteLine(output.ToString());
    }
}
`,
};

export function starterFor(problem, language) {
  return templates[language](problem);
}
