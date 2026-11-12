using System;
using System.Collections.Generic;

public static class Program
{
    public static void Main()
    {
        string[] data = Console.In.ReadToEnd().Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
        int n = int.Parse(data[0]);
        long target = long.Parse(data[1]);
        var seen = new HashSet<long>();
        bool found = false;
        for (int i = 0; i < n && !found; i++)
        {
            long a = long.Parse(data[2 + i]);
            if (seen.Contains(target - a)) found = true;
            seen.Add(a);
        }
        Console.WriteLine(found ? "YES" : "NO");
    }
}
