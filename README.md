# Code Arena 

A coding practice site and real-time 1v1 arena for a BTech web development + AI/ML class project.

- **Problem library**: 12 original problems, each with a statement, 2 public examples and 5–7 hidden tests.
  Search, difficulty and topic filters, and solved status.
- **Practice workspace**: write code in Python 3, JavaScript (Node.js), Java 21, C++17 or C# (.NET 10).
  Run it against the examples or your own stdin, then submit against the hidden tests and get a real verdict.
- **Play a Friend**: a private room with an invite link and a six-character code. Both players click
  Ready, the host starts a 10-minute round, and the earliest accepted submission wins.
- **History**: your own submissions and match results.
- **Explainable recommender**: TF-IDF content similarity plus hand-written ranking rules. It suggests
  up to three unsolved problems and says why each one was chosen.

Stack: semantic HTML, plain CSS and vanilla ES modules in the browser, with no framework, no build step
and no CDN. The server is Node.js, Express and Socket.IO on one HTTP server, with SQLite through
`node:sqlite`. A Docker judge runs each test case in a fresh, locked-down container.

---

## 1. What was verified, and how

| Flow | Status | How it was checked |
|---|---|---|
| Unit and integration tests (rooms, judge, recommender, catalog, HTTP and sockets) | ✅ 49/49 pass | `npm test` on Windows 11, Node 22.14 |
| 12 reference solutions against every public and hidden fixture | ✅ | `npm run check:catalog`: JS references plus **independent** Python references run as real processes, with fixture checksums |
| Reference solutions against brute force on 1,400 random small inputs | ✅ | `tests/catalog.test.js` |
| Docker images build (all five) | ✅ | `npm run judge:build` on Docker Desktop 29.9.3 (WSL 2). Exact versions are in `docker/versions.json` |
| Docker smoke: a correct solution is Accepted in **all five languages, including C#**; WA; CE in Python/JS/C++/Java/C#; RE (exception, segfault, self-SIGKILL); TLE in all five languages; OLE; MLE; echo-privacy; no containers left | ✅ 24/24 | `npm run judge:smoke` |
| All 60 starter templates compile or parse | ✅ 60/60 | `npm run check:starters` (Docker) |
| Python and JS reference solutions for all 12 problems, including the large hidden tests | ✅ 24/24 Accepted, slowest at 49% of its limit | `npm run check:references` (Docker) |
| Sandbox: non-root user, no capabilities, no-new-privileges, seccomp, read-only root, /src and /build read-only, tmpfs size limit, no network or DNS, loopback only, no Docker socket, only the job’s mounts, memory/PID/CPU limits, fork bomb stopped, memory hog OOM-killed, loop and sleep killed, output capped, no files carried between tests, `docker inspect` HostConfig matches, no containers left | ✅ 36/36 | `npm run judge:sandbox` |
| Docker stop/restart recovery and orphan clean-up | ✅ | A planted labelled container was removed at start-up. With Docker Desktop stopped: judge health 503 “Docker is not running”, app health 200, a submit returns **Judge Unavailable**. After `docker desktop start`, the judge was ready within about 3 s with no app restart and the next submit was Accepted. 0 containers left |
| Two-browser match in real Chrome, using the **Docker judge** | ✅ 32/32 | `npm run e2e` (puppeteer-core, two isolated browser contexts): create, copy, join, third player refused, ready, start, same problem, refresh mid-round keeps seat and draft, WA then AC in Python vs JavaScript, earlier submission wins, Submit locks, coarse status, results agree, rematch resets readiness and rotates the problem, history, no console or CSP errors |
| Desktop and 390 px phone layout, keyboard (Tab indent, Esc then Tab leaves the editor, Ctrl+Enter / Ctrl+Shift+Enter), language switching | ✅ | Same e2e script plus screenshots in `test-artifacts/` |
| Judge unavailable → clear UI error | ✅ | Docker driver on a host with no Docker: `/api/judge/health` returns 503 “Docker is not installed or not on PATH”, the banner appears, and a Run returns **Judge Unavailable** after one retry |
| Restart: progress and history survive; an interrupted round becomes void | ✅ | Started a round, killed the server, restarted, then checked `/api/session`, `/api/rooms/:code` and `/api/history` |
| LAN mode binding and origin checks | ✅ partially | `npm run start:lan` on this PC, reached through its own LAN IP (rooms, invite path, socket handshake 200; foreign origin 403). **Not** tested with a second laptop. |
| Two laptops over real Wi-Fi | ⬜ not done | Needs a second machine. Follow section 4 before the class demo. |

> ⚠️ **The local test driver is not a sandbox.** It runs submitted code directly on your computer and
> exists only so the pipeline can be tested without Docker. It refuses to start unless you set
> `CODE_ARENA_ALLOW_UNSANDBOXED=1`, and it only runs on `127.0.0.1`. The UI shows a yellow banner while
> it is active. Use the Docker judge for anything real.

---

## 2. Requirements and versions

| Component | Version |
|---|---|
| Node.js | **24 LTS** recommended. Works on ≥ 22.13, where `node:sqlite` needs no flag. Verified on 22.14.0. |
| npm | Comes with Node. Install exactly from `package-lock.json` with `npm ci`. |
| Docker | Docker Desktop (Windows/macOS) or Docker Engine (Linux) on the host that runs the app. Friends only need a browser. |
| Judge images (`npm run judge:build`) | `python:3.13-slim-bookworm` → CPython 3.13 · `node:24-bookworm-slim` → Node.js 24 · `eclipse-temurin:21-jdk-noble` → Java 21 · `gcc:14-bookworm` → GCC 14 (`-std=c++17 -O2`) · `mcr.microsoft.com/dotnet/sdk:10.0` → .NET 10 SDK |

`npm run judge:build` writes the **exact** runtime versions it finds inside each image to
`docker/versions.json`. Verified build: Python 3.13.18 · Node.js v24.22.3 · OpenJDK 21.0.13 · g++ 14.3.0 ·
.NET SDK 10.0.404.

Verified host platform: **Windows 11 Home (x64), Docker Desktop 29.9.3 with the WSL 2 engine (12 CPUs,
8 GB RAM for Docker), Node.js 22.14** for the app. Not yet verified: Linux or macOS hosts, and Node 24 for
the app itself.

**Disk space:** the five images take about **4.4 GB** (`gcc` 2 GB, `dotnet` 1.3 GB, `java` 0.7 GB,
`node` 0.3 GB, `python` 0.2 GB). The first build downloads roughly 1.5–2 GB. Check free space first,
and allow about 8 GB. Docker Desktop’s disk image does not shrink by itself after you delete images.

---

## 3. Setup (fresh start)

```bash
git clone <your repo> code-arena && cd code-arena
npm ci                      # installs from the lockfile and regenerates hidden fixtures (checksum-verified)
npm run judge:build         # builds the 5 judge images, records versions (first run downloads ~2 GB)
npm run judge:smoke         # real 5-language smoke test through Docker
npm start                   # http://127.0.0.1:3000
```

Then check:

- `http://127.0.0.1:3000/api/health` → `{"ok":true,…}` (app)
- `http://127.0.0.1:3000/api/judge/health` → `"ready": true` (judge; HTTP 503 while it isn’t ready)

The database (`data/code-arena.sqlite`) is created automatically. Judge scratch folders go under your
OS temp directory and are deleted after each job. Both are kept out of git. To change settings, copy
`config.example.json` to `config.json`. Safe defaults apply without it.

**Docker recovery check:** stop Docker Desktop while the app runs. Within about 10 s every page shows
“Judge unavailable”, and a Run returns *Judge Unavailable* with your code still saved. Start Docker
again and the banner clears on the next health check, with no app restart needed.

---

## 4. Running a demo

### Two players on one laptop

Open the site in two **separate browser profiles**, or a normal window plus a private window. Each
profile has its own guest cookie and so counts as a different player. Two tabs in the same profile
are the same player.

### Two laptops on the same Wi-Fi (LAN mode)

```bash
npm run start:lan           # binds 0.0.0.0 and prints e.g. http://192.168.0.25:3000
```

1. On the host laptop, open the printed **network** URL (not 127.0.0.1). Invite links are built from
   the address you opened, so they will contain the LAN IP.
2. Create a room and send the link or the six-character code to your friend.
3. If the friend’s laptop cannot connect:
   - Allow Node.js through the host firewall. On Windows the prompt appears on first launch; tick
     **Private networks**. Or run
     `netsh advfirewall firewall add rule name="Code Arena" dir=in action=allow protocol=TCP localport=3000`.
   - Make sure both laptops are on the same network and not on a guest network.
   - Turn off **client/AP isolation** on the router or hotspot. Many campus and public Wi-Fi networks
     block laptop-to-laptop traffic; a phone hotspot usually works.
   - Test from the friend’s laptop: open `http://<host-ip>:3000/api/health`.

Only use LAN mode on a trusted network with people you know. The judge is designed for a class demo, not
for strangers on the internet (see section 9).

### Two-minute class demo

1. **(20 s)** Home page → *Browse Problems*. Show the filters and the “Recommended for you” cards with
   their reasons.
2. **(30 s)** Open **Target Pair**. Paste the Python solution below, click **Run** (examples pass), then
   **Submit** (“Hidden tests passed”). Back in the library it shows ✓ Solved and the recommendations
   change.
3. **(50 s)** *Play a Friend* → *Create private room* → copy the link into the second browser profile →
   both click **Ready** → host clicks **Start**. Player 2 submits the JavaScript solution, player 1 a
   wrong one. Show “Solved” appearing in the opponent’s header without any code being shown.
4. **(20 s)** Results: winner and reason. Click **Rematch**: readiness resets and a new problem is picked.

Sample input for Target Pair:

```
5 9
2 7 11 -3 4
```

Expected output: `YES`.

**Python 3**

```python
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
```

**JavaScript (Node.js)**

```javascript
const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const [n, target] = data;
const seen = new Set();
let found = false;
for (let i = 0; i < n && !found; i++) {
  const a = data[2 + i];
  if (seen.has(target - a)) found = true;
  seen.add(a);
}
console.log(found ? 'YES' : 'NO');
```

Java, C++ and C# versions are in [scripts/solutions/](scripts/solutions/).

---

## 5. Match rules

1. A room has two seats. A third player is refused. Room codes use 31 easy-to-read characters
   (no `0/O`, `1/I/L`) and are checked against existing codes.
2. Both players click **Ready**. Only the host can start, and only while both players are connected and
   ready. The server picks one problem from the chosen pool and reveals it to both players at the start,
   with the same deadline: **10 minutes** (`match.durationMs`).
3. Phases: `lobby → active → judging → finished`. The server stores the start time and deadline and sends
   its own time with every snapshot. The browser computes the timer from that and re-syncs after a
   reconnect or when the tab becomes visible.
4. **The earliest server-received submission that earns Accepted wins.** Each submission gets a server
   receipt time and a monotonic sequence number. The order in which judging finishes never matters.
5. You can have one pending Submit at a time. After your first Accepted, your Submit button locks.
6. If both players are Accepted, the round finishes early. Otherwise it closes at the deadline. Work that
   was received before the deadline is still judged during a **settling window** of up to 100 s
   (`match.settleMs`), and the round finishes as soon as all of it is resolved.
7. One Accepted beats none. **No Accepted is a draw.**
8. **Void rule:** if a submission received in time could not be judged (Judge Unavailable after a retry,
   or still unjudged when the settling window ends), and it *could* have changed the result, the round
   is **void** with no winner. For example: there is no winner yet, or the unjudged submission came from
   the other player and was received before the winner’s. The result screen explains this.
9. Reconnecting players reclaim their seat through their guest cookie. Presence is counted per tab, so
   closing one of two tabs does not disconnect you. The clock keeps running while a player is away.
   In a lobby (before the start), a seat whose player has been gone for 2 minutes is freed
   (`match.lobbyGraceMs`). If the host is gone that long, the room expires.
10. If the server restarts mid-round, that round is recorded as **void**. Completed history is kept,
    and open rooms come back so players can reclaim their seats.
11. Your opponent sees your presence, readiness and a coarse status (Solving, Judging or Solved).
    Your code, drafts, custom input, test results and error output are visible only to you.

---

## 6. The judge

### Languages and limits

| Language | File | Compile / check | Run | Compile limit | Run limit per test | Memory |
|---|---|---|---|---|---|---|
| Python 3 | `main.py` | `compile()` syntax check | `python3 -I -B /src/main.py` | 10 s | 4 s | 256 MB |
| JavaScript | `main.js` | `node --check` | `node /src/main.js` | 10 s | 3 s | 384 MB |
| Java 21 | `Main.java` | `javac -d /build` | `java -Xss64m -Xmx384m -XX:+UseSerialGC -cp /build Main` | 20 s | 4 s | 512 MB |
| C++17 | `main.cpp` | `g++ -std=c++17 -O2` | `/build/main` | 20 s | 2 s | 256 MB |
| C# (.NET 10) | `Main.cs` | offline `dotnet build --no-restore` of the checked-in `docker/dotnet/Main.csproj` | `dotnet /build/Main.dll` | 30 s | 4 s | 512 MB |

Each job writes the source to a fresh folder, compiles once, then runs **every test case in a fresh
container**. Programs read stdin and write stdout. Output is compared as whitespace-separated tokens:
line endings and surrounding whitespace don’t matter, but any extra or missing token is a mismatch.
Each test’s stdout cap is at least twice its valid answer (≥ 64 KB), which leaves room for the
interval and temperature problems. stderr is capped at 64 KB, and custom-run stdout at 64 KB.

**Measured timings (Docker Desktop on the verified host above).** Times include about 0.7 s of
container start-up per test. The inner time limit starts only when the program starts, so start-up is
not charged to the student.

| | Python | JavaScript | Java | C++ | C# |
|---|---|---|---|---|---|
| Compile / syntax check | 0.6–1.0 s | 0.6–1.4 s | 2.1–3.5 s | 0.7–4.1 s | 4.1–5.6 s |
| Slowest test, Target Pair (n = 200 000) | 2.0 s | 1.0 s | 1.2 s | 0.8 s | 1.7 s |
| Slowest reference test, all 12 problems | 1.9 s (Cheapest Route) | 1.5 s (Cheapest Route) | – | – | – |
| Whole Submit (compile + 8 tests) | ~10 s | ~10 s | ~12 s | ~12 s | ~14 s |

The slowest correct solution used 49% of its time limit, so the limits leave room on slower laptops.

**Settlement:** battle jobs have two dedicated run slots (`judge.battleSlots`) beyond the practice
concurrency, so they never wait behind practice work. Each job is hard-capped at 90 s, covering
compile, all tests and one infrastructure retry (`judge.jobTimeoutMs`). The settling window (100 s) is
longer than that cap, so two submissions arriving right at the deadline can always finish. Battle
submissions also have a reserved queue allowance.

**Capacity:** practice work beyond `maxQueue` (16) waiting jobs is rejected with *queue full*. Each guest
can run code 12 times per minute. Every job is aborted after 90 s.

### Sandbox controls

Every container is started with argument arrays (never a shell string) and these settings:

| Control | Setting | Verified? |
|---|---|---|
| No network | `--network none` | ✅ verified (`npm run judge:sandbox`) |
| Non-root user | `--user 10001:10001` (also the image default) | ✅ verified |
| Read-only root filesystem | `--read-only` | ✅ verified |
| Bounded writable temp space | `--tmpfs /tmp:rw,nosuid,nodev,size=32m` (512m for compiling) | ✅ verified |
| Capabilities dropped | `--cap-drop ALL` | ✅ verified |
| No privilege escalation | `--security-opt no-new-privileges` | ✅ verified |
| Default seccomp profile | Docker default (not disabled) | ✅ verified |
| CPU, memory, PIDs | `--cpus 1`, `--memory` = `--memory-swap`, `--pids-limit` | ✅ verified |
| File size / open files | `--ulimit fsize=64MB`, `--ulimit nofile=256` | ✅ verified |
| Wall clock | inner `timeout -s KILL` (✅ verified: loops and sleeps are killed at the limit), plus an outer watchdog that runs `docker kill` if the daemon itself hangs (not exercised) | ✅ inner · ⬜ watchdog |
| Output caps | stdout/stderr byte caps; on overflow the container is killed | ✅ verified |
| Mounts | only this job’s `src` (read-only) and `build` (writable while compiling, read-only while running). Never the Docker socket, project, database, secrets or home directory. | ✅ verified |
| Clean-up | every container is labelled `code-arena.judge=1`, removed with `docker rm -f` after each run (and after a timeout, overflow or abort), and orphans are removed at start-up and whenever the judge becomes ready | ✅ verified |

Run the app on a dedicated or throwaway VM where possible.

### Judge troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Banner “Docker is not installed or not on PATH” | Docker missing, or the shell can’t find `docker` | Install Docker Desktop / Engine and reopen the terminal. Check with `docker version`. |
| Banner “Docker is not running” | Daemon stopped | Start Docker Desktop. The judge recovers within about 10 s. |
| “Image … is missing. Run npm run judge:build” | Images not built, or deleted | `npm run judge:build` (or `npm run judge:build -- python` for one language) |
| Every submission is *Judge Unavailable* | Docker error, e.g. bind mounts refused | Docker Desktop → Settings → Resources → File sharing must include your temp folder. Check `/api/judge/health`. |
| First C# submission is slow | .NET start-up and compile take several seconds | Expected. The compile limit is 30 s. |
| Java/C# *Time Limit Exceeded* on large tests on a slow laptop | JVM/.NET start-up plus a slow CPU | Raise `runMs` in `server/judge/languages.js` after measuring with `npm run judge:smoke`. |
| *Queue full* | More than 16 practice jobs waiting | Wait a few seconds. Raise `judge.maxQueue` or `judge.concurrency` on a stronger host. |
| Friend cannot open the invite | LAN firewall or client isolation | See section 4. |
| Linux: compile output can’t be written | The container user can’t write the bind mount | The judge sets the build folder to mode 0777. Keep scratch on a local disk (`scratchDir` in config). |

---

## 7. Recommender (the AI/ML part)

A small, **content-based** recommender in plain JavaScript ([server/recommender.js](server/recommender.js)).
It is local and deterministic: no external AI, no training, no accuracy claims, and no predictions about
ability. Its inputs are public problem titles and tags plus your own verdict history. It never looks at
source code or hidden tests.

**Part 1: TF-IDF similarity** (standard information retrieval)

- Each problem’s “document” is its title words (weight 1 each) plus its tags (weight 2 each).
- Smoothed IDF: `idf(t) = ln((1 + N) / (1 + df(t))) + 1`, with N = 12 problems.
- Vector `v_d[t] = tf(t,d) · idf(t)`, L2-normalised. Similarity is the cosine `P · v_d`.

**Part 2: hand-written ranking rules**

- Profile `P = normalise( Σ recencyᵢ · struggleᵢ · v_pᵢ )` over your **5 most recent distinct attempted
  problems** (Submits only).
  - `recency` = 1, 0.85, 0.70, 0.55, 0.40, newest first.
  - `struggle` = 2 if that problem has a Wrong Answer or Time Limit Exceeded with no Accepted
    afterwards, otherwise 1.
- Target level = the recency-weighted average difficulty (easy 0, medium 1, hard 2). Add 0.5 if your
  latest attempt was Accepted, then clamp to [0, 2]. `fit = 1 − |level − target| / 2`.
- `score = 0.75 · similarity + 0.25 · fit`. Solved problems are excluded. Ties go to the lower problem
  number.
- **Cold start** (no attempts): the first Easy problems that each have a different primary topic.
- Reasons are built from the terms that contribute most to the similarity, plus the difficulty rule.

**Worked example** (real output from the code):

| State | #1 | #2 | #3 |
|---|---|---|---|
| New guest (cold start) | Target Pair: “Starter pick: an Easy hash map problem.” | Bracket Check: “…an Easy stack problem.” | First Occurrence: “…an Easy binary search problem.” |
| After a **Wrong Answer on Bracket Check** (target level Easy) | Next Warmer Day: score 0.368 = 0.75·0.323 + 0.25·0.5. “Practises stack, where Bracket Check is still unsolved after a wrong answer or timeout. Medium: a step up.” | Unique Window: 0.335 (shares *strings*) | Target Pair: 0.25 (similarity 0, but a perfect Easy fit) |
| After that same problem is then **Accepted** (target level → Medium) | Next Warmer Day: 0.430 = 0.75·0.323 + 0.25·0.75. “Shares stack with Bracket Check… Medium, close to your recent level.” | Unique Window: 0.398 | Minimum Cover Window: 0.265 |

Where the 0.323 comes from: `v(Bracket Check)` = {bracket .371, check .371, #stack .638, #strings .563}
and `v(Next Warmer Day)` = {next .295, warmer .295, day .295, #monotonic-stack .590, #stack .507, #arrays .365}.
Their only shared term is `#stack`, so the cosine is .638 × .507 ≈ 0.323.

The TF-IDF part decides *which topics are similar*. The weights, recency, struggle boost, level
targeting and cold-start rule are design choices written by hand.

---

## 8. Viva notes: how it fits together

```
Browser (HTML + CSS + ES modules)           Node.js server (one process, one port)
  pages/*.js ── fetch JSON ───────────────▶ Express  /api/*   (http.js)
  arena.js   ── Socket.IO ◀──────────────▶ Socket.IO          (sockets.js)
  localStorage drafts                         │
                                              ├─ RoomService   rooms.js   (all match rules, injected clock)
                                              ├─ JobService    jobs.js    (Run/Submit records, privacy filter)
                                              ├─ Judge         judge/*    (queue → runner → Docker driver)
                                              ├─ Recommender   recommender.js
                                              └─ SQLite        db.js      (guests, rooms, rounds, submissions)
                                                     Docker: one fresh container per test case
```

- **Browser.** Plain HTML pages, each loading one ES module. The editor is a `<textarea>` with a
  line-number gutter kept in sync on scroll. Drafts are saved per guest, problem, language and
  practice/round in `localStorage`, so refreshing, switching language or reconnecting never loses work.
  All user text is inserted with `textContent`/text nodes. The CSP blocks inline scripts and styles.
- **Realtime.** Socket.IO rooms. Each guest has a private channel, so opponents only ever receive
  snapshots built for them. Snapshots carry a `revision`, and old ones are ignored. Commands (ready,
  start, rematch) use acknowledgements and request ids, so a retried command is not applied twice.
- **Fairness.** The HTTP handler records the receipt time before doing anything else. The room service
  gives each accepted request a sequence number, and the winner is the lowest sequence number with
  Accepted. The final result is written once inside a transaction
  (`UPDATE … WHERE status != 'finished'`). Results from an old round are ignored.
- **Database.** SQLite through `node:sqlite` with prepared statements only. Tables: `guests` (stores the
  SHA-256 hash of the cookie secret, never the secret), `rooms`, `room_participants`, `rounds`,
  `round_players`, `submissions` (stores only the privacy-safe result).
- **Judge.** A priority queue (battle work first) feeds a runner that compiles once and runs each test in
  a fresh container, with no network, a non-root user, a read-only root and resource limits. Hidden-test
  output is thrown away inside the runner, so the browser can only learn pass/fail plus a generic verdict.
- **Recommender.** See section 7. TF-IDF and cosine similarity are the ML/IR part; the ranking rules
  are hand-written logic.

**Project layout**

```
public/                 browser files (the only folder served as static files)
  index.html problems.html practice.html arena.html history.html
  css/app.css  js/{api,ui,editor,drafts,workspace}.js  js/pages/*.js
server/                 app.js (wiring) · index.js (entry) · config.js · db.js · sessions.js · security.js
                        http.js · sockets.js · rooms.js · jobs.js · problems.js · starters.js · recommender.js
  judge/                languages.js · queue.js · runner.js · compare.js · docker-driver.js · local-driver.js
problem-bank/           server-only: problem.json, reference.js, reference.py, generated tests/
docker/                 one Dockerfile per runtime; dotnet/ has the checked-in offline project
scripts/                fixtures, catalog check, image build, smoke, starters, browser e2e, sample solutions
tests/                  node:test suites (fake clock + scriptable fake judge)
docs/api.md             exact routes, socket events, payloads, error codes, snapshot shape
```

---

## 9. Commands

| Command | What it does |
|---|---|
| `npm start` / `npm run start:lan` | Start on 127.0.0.1:3000 / on 0.0.0.0:3000 |
| `npm test` | All automated tests (fake judge, no Docker needed) |
| `npm run check:catalog` | 12 references (JS + independent Python) against every fixture, plus checksums |
| `npm run fixtures` | Regenerate hidden fixtures (deterministic) and `fixtures.lock.json` |
| `npm run judge:build` | Build or refresh the judge images and record versions |
| `npm run judge:smoke` | Real-judge smoke test: 5 languages, every verdict type, privacy and clean-up |
| `npm run judge:sandbox` | Probe the sandbox from inside real containers, check `docker inspect`, confirm clean-up |
| `npm run check:references` | Submit the Python and JS references for all 12 problems through the real judge |
| `npm run check:starters` | Compile or parse all 60 starter templates in the real judge |
| `npm run e2e` | Two-browser match in Chrome/Edge (set `CHROME_PATH` if needed) |
| `npm run check:integration` | smoke + sandbox + starters + e2e |
| `npm run screenshots` | Every page in dark and light themes, desktop and phone, after creating real activity (writes `test-artifacts/screens/`) |

To run the integration scripts without Docker, using the **unsandboxed** test driver:
`JUDGE_DRIVER=local CODE_ARENA_ALLOW_UNSANDBOXED=1 npm run judge:smoke` (in PowerShell:
`$env:JUDGE_DRIVER='local'; $env:CODE_ARENA_ALLOW_UNSANDBOXED='1'; npm run judge:smoke`). You need
local `python`, `node`, `javac`/`java` (JDK 21 or newer) and `g++` on PATH.
Shorter rounds for testing: `MATCH_DURATION_MS=60000 npm start`.

**Security scope.** This is a trusted class demo: guest sessions, a single server instance, and a Docker
judge on the presenting laptop. Do not expose it to the public internet. Letting unknown users run code
needs a separately hardened judge (for example gVisor or Firecracker), accounts, HTTPS, and an
isolated deployment. If you do serve it over HTTPS, set `"secureCookies": true`.
