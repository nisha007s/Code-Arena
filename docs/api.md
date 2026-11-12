# Code Arena — HTTP and realtime contract

All HTTP routes are under `/api`, take and return JSON, and send `Cache-Control: no-store`.
Errors always look like:

```json
{ "error": { "code": "room_full", "message": "This room already has two players." } }
```

## Identity and request rules

- `GET /api/session` is the **only** route that creates a guest. It sets the `ca_session` cookie
  (32 random bytes, `HttpOnly`, `SameSite=Lax`, `Path=/`, one year; plus `Secure` when
  `secureCookies` is on or the request is HTTPS). The database stores only its SHA-256 hash.
- Every other route except the two health checks needs that cookie, otherwise it returns `401 no_session`.
  The browser client calls `/api/session` once and retries.
- `POST` requests must come from the same origin: the `Origin` header must equal
  `http(s)://<Host header>`, or `Sec-Fetch-Site` must be `same-origin`. Otherwise you get `403 bad_origin`.
- The Socket.IO handshake applies the same origin check and requires a valid session cookie.
- Request bodies are limited to 200 KB, source code to 64 KB, custom stdin to 64 KB,
  display names to 24 characters, and socket payloads to 16 KB.
- Rate limits: room create/join 20 per minute per guest and per IP; practice Run/Submit
  12 per minute per guest; socket commands 60 per minute per socket.

## HTTP routes

| Method & path | Body | Success | Notes / error codes |
|---|---|---|---|
| `GET /api/health` | – | `200 { ok, uptimeSeconds }` | App liveness only. |
| `GET /api/judge/health` | – | `200`/`503 { ready, driver, unsandboxed, message, dockerVersion, checkedAt, queue, languages: { python: { ready, message }, … } }` | Judge readiness, separate from app health. Re-checked every 10 s. |
| `GET /api/session` | – | `{ guest: { id, name }, progress: { solved: [problemId], solvedCount, attemptedCount, total } }` | Creates a guest if needed. |
| `POST /api/session` | `{ displayName }` | `{ guest }` | `validation_error`. Letters, digits, space, `_ . ' -`, 1–24 characters. |
| `GET /api/languages` | – | `{ languages: [{ id, name, version }] }` | ids: `python`, `javascript`, `java`, `cpp`, `csharp`. |
| `GET /api/problems` | – | `{ problems: [{ id, number, title, difficulty, tags, solved, attempted }] }` | |
| `GET /api/problems/:id` | – | `{ problem }` (public detail, see below) | `problem_not_found` |
| `GET /api/recommendations` | – | `{ mode: cold_start\|personalized\|all_solved, explanation, items: [{ problem, score, similarity, difficultyFit, terms, reason }] }` | See README “Recommender”. |
| `POST /api/rooms` | `{ difficulty: mixed\|easy\|medium\|hard }` | `201 { room: Snapshot }` | `already_in_room`, `rate_limited` |
| `GET /api/rooms/current` | – | `{ room: Snapshot \| null }` | The caller’s open room, if any (used to return after a refresh). |
| `POST /api/rooms/:code/join` | `{}` | `{ room: Snapshot }` | Idempotent for a seated player (reclaims the seat). `room_not_found`, `room_full`, `match_in_progress`, `already_in_room`, `invalid_code` |
| `GET /api/rooms/:code` | – | `{ room: Snapshot }` | `not_member` (403) for non-players. |
| `POST /api/rooms/:code/leave` | `{}` | `{ ok: true }` | The host leaving closes the room. `round_in_progress` |
| `POST /api/submissions` | see below | `202 { job }` (or `200 { job, duplicate: true }`) | See below. |
| `GET /api/submissions/:id` | – | `{ job }` | Only the author. Anyone else gets `404 submission_not_found`. |
| `GET /api/history` | – | `{ submissions: [...], matches: [...] }` | Own Submits (no source) and finished matches. |

### `POST /api/submissions`

```json
{
  "requestId": "8–64 chars [A-Za-z0-9_-], unique per attempt",
  "mode": "run | submit",
  "language": "python | javascript | java | cpp | csharp",
  "source": "full program text",
  "problemId": "target-pair",
  "customInput": "optional, Run only",
  "roomCode": "battle Submit only",
  "roundId": "battle Submit only"
}
```

- **Practice Run** runs the public examples, or one custom stdin case (no expected answer).
- **Practice Submit** runs the public examples, then the hidden tests, stopping at the first failure.
- **Battle Submit** (`roomCode` + `roundId`) is admitted only after checking membership, room
  phase, round id, the deadline (using the server receipt time captured first), the language
  and queue admission. Runs inside the arena use the practice route.
- The same `requestId` from the same guest returns the original job.
- Error codes: `validation_error`, `too_large`, `empty_source`, `invalid_language`,
  `problem_not_found`, `rate_limited` (429), `queue_full` (503), `not_member`, `stale_round`,
  `round_closed`, `pending_submission`, `already_solved`.

### Job object (private to its author)

```json
{
  "id": "uuid", "requestId": "...", "mode": "submit", "kind": "practice | battle",
  "problemId": "target-pair", "language": "python", "roomCode": null, "roundId": null,
  "status": "queued | judging | done",
  "verdict": "AC | WA | CE | RE | TLE | OLE | MLE | JU | OK(custom run)",
  "verdictLabel": "Accepted", "receivedAt": 1700000000000, "finishedAt": 1700000001200,
  "result": {
    "compile": { "ok": true, "output": "" },
    "cases": [ { "visibility": "public", "label": "Example 1", "verdict": "AC", "input": "...", "expected": "...", "stdout": "...", "stderr": "", "exitCode": 0, "timeMs": 95 } ],
    "hidden": { "passed": false, "verdict": "WA" },
    "message": null
  }
}
```

Hidden tests are summarised as `{ passed }` or `{ passed: false, verdict }` only. Their inputs,
expected outputs, stdout, stderr, count and index are never sent. The judge discards hidden-case
output before the result leaves the runner.

### Public problem detail (explicit allowlist)

`id, number, title, difficulty, tags, statement[], inputFormat[], outputFormat[], constraints[],
examples[{ input, output, explanation }], starters{ python, javascript, java, cpp, csharp }`.

## Socket.IO

Connect to the same origin (`/socket.io/`). Every socket joins a private channel
`guest:<id>`, so several tabs of one guest all receive updates. Commands take an
acknowledgement callback that returns `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`.

| Client → server | Payload | Ack | Notes |
|---|---|---|---|
| `room:subscribe` | `{ code }` | `{ ok, snapshot }` | Marks this tab present (presence is counted per tab). |
| `room:snapshot` | `{ code }` | `{ ok, snapshot }` | Re-sync, e.g. after a visibility change. Presence is unchanged. |
| `room:ready` | `{ code, ready: boolean, requestId? }` | `{ ok }` | Lobby only. `wrong_phase` |
| `room:start` | `{ code, requestId? }` | `{ ok, roundId }` | Host only, both players connected and ready. `not_host`, `not_ready`, `player_disconnected`, `waiting_for_player`, `wrong_phase` |
| `room:rematch` | `{ code, requestId? }` | `{ ok }` | Host only, after a finished round, both seats filled. Returns to the lobby with readiness reset. |
| `room:leave` | `{ code }` | `{ ok }` | Not allowed during a round. |

| Server → client | Payload |
|---|---|
| `room:update` | `Snapshot` built for the receiving player |
| `room:closed` | `{ code, message }` |
| `submission:update` | `job` (sent only to the author’s channel) |

The same `requestId` repeated by the same guest returns the first result.

### Snapshot (authoritative room state, per viewer)

```json
{
  "revision": 17,
  "serverTime": 1700000000000,
  "code": "K7Q2MX",
  "phase": "lobby | active | judging | finished",
  "difficulty": "mixed",
  "invitePath": "/arena.html?room=K7Q2MX",
  "you": { "seat": 0, "isHost": true },
  "players": [
    { "seat": 0, "name": "Ada", "isHost": true, "isYou": true, "connected": true, "ready": true,
      "status": "ready | not_ready | solving | judging | solved | finished" },
    null
  ],
  "round": {
    "id": "uuid", "number": 1, "startedAt": 0, "deadline": 0, "settleDeadline": null, "durationMs": 600000,
    "problem": "public problem detail — present once the round has started"
  },
  "result": {
    "outcome": "win | draw | void", "winnerSeat": 0, "winnerName": "Ada", "reason": "…",
    "players": [{ "seat": 0, "name": "Ada", "submissions": 2, "status": "solved | not_solved | unjudged", "solvedSeq": 41 }],
    "problem": { "id": "…", "title": "…", "difficulty": "easy" }, "roundNumber": 1, "finishedAt": 0
  },
  "mySubmissions": ["job objects for this round — the viewer’s own only"]
}
```

Clients ignore a pushed snapshot whose `revision` is not newer than the one they hold for the
same round. They compute the timer as `deadline − (Date.now() + (serverTime − receiveTime))`.
Opponents see only presence, readiness and the coarse `status`. They never see each other's
source, drafts, custom input, test results or diagnostics.
