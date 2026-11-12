import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken(); int n = (int) in.nval;
        in.nextToken(); long target = (long) in.nval;
        HashSet<Long> seen = new HashSet<>(n * 2);
        boolean found = false;
        for (int i = 0; i < n; i++) {
            in.nextToken();
            long a = (long) in.nval;
            if (seen.contains(target - a)) { found = true; break; }
            seen.add(a);
        }
        System.out.println(found ? "YES" : "NO");
    }
}
