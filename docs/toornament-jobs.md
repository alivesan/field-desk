# Field Desk → Toornament result jobs

Field Desk sends match results to Toornament through a browser worker run by the automation side (Astra,
`automation/toornament/`). Field Desk keeps a durable queue of **jobs**. The worker claims one job, opens the
organizer site, checks the match is the one described, saves the result, reads it back, and reports. This file is
Field Desk's side of `automation/toornament/JOB-CONTRACT.md` (schemaVersion 1). It is both the build plan and the
contract handed back to the automation.

## v1 scope

- **Results only:** `match.result` when a match is finished here, and `match.reset` when HQ or the desk undoes a
  finished match. **No scores:** the desk records W/L only, so `desired` carries the winner and never `scores`.
  A walkover becomes `outcome: "forfeit"`, with the loser as `forfeitingParticipantId`.
- **No participant jobs.** Walk-ins keep being added on Toornament by hand (the existing on-spot "added to
  Toornament" flow). `participant.add` is never created.
- **Off by default, per store:** `store.toornament.sync = { on: true }` (HQ-only, like the rest of
  `store.toornament`). With it off, no jobs are made and none of that store's jobs can be claimed.
- **Bracket rules:** a job is never made for a bye. Later matches are never reset automatically.

## When a job is made

On the server, in the **same SQLite transaction** as the command's commit (`commit()` in server/api.ts), so the
result and its job are saved together or not at all.

| Command | Condition | Job |
| --- | --- | --- |
| `match.finish` | the match was not `done` before, is not a bye | `match.result` |
| `match.undo` | the match was `done` before | `match.reset` |

A job is made only when every one of these holds; otherwise none is made, and the HQ page shows why for that match
("not mapped"):

- the store's sync is on;
- `store.toornament` has a tournament id (from its url) and a `stageId`;
- `store.toornament.loadId` is set and the bracket came from it (`bracketOrigin(store) === 'toornament'`);
- the match has `toornament.id` and `toornament.label`;
- both players have `toornamentId` (the participant id kept at `bracket.load`).

A `bracket.load` or `bracket.reset` cancels every `pending` job of that store from the old bracket (state
`cancelled`, code `superseded`). A claimed job keeps running; the worker's own checks catch a changed bracket.

## Data Field Desk keeps

- `Player.toornamentId?: string`: the Toornament participant id, kept by `bracket.load` from Toornament when a name
  is matched (`planImport` already reads `ToornamentParticipant.id`). Digits, at most 24.
- `Match.toornament = { id, label }`: already there. The node id is used as both `matchId` and `publicNodeId`
  (Kochi showed they are equal for the matches checked; the worker verifies every time).
- `store.toornament.loadId`: already there; used as `bracketGenerationId`.
- A `toornament_jobs` table, not a doc, so the bot's churn stays off the SSE doc stream:
  `id, store_id, entity_id, revision, state, payload (JSON, immutable), payload_hash, created_at, updated_at,
  attempt, claim_token, worker_id, lease_until, checkpoint_at, next_attempt_at, code, history (JSON)`.

## The job (immutable once made)

As in JOB-CONTRACT.md. Every id is a string.

```json
{
  "schemaVersion": 1, "origin": "field-desk",
  "jobId": "tj_…", "payloadHash": "sha256 of the canonical payload without jobId/payloadHash",
  "sourceCommandId": "<the command's id>", "createdAt": "…Z",
  "storeId": "…", "entityId": "<Field Desk match id>", "bracketGenerationId": "<store.toornament.loadId>",
  "revision": 1, "expectedPreviousRevision": 0,
  "kind": "match.result",
  "tournamentId": "…", "stageId": "…",
  "expectedTournamentName": "<store.toornament tournament name if known, else store name>",
  "expectedStageName": "<store.toornament.stageName or ''>",
  "matchId": "<match.toornament.id>", "publicNodeId": "<match.toornament.id>", "mappingVerified": true,
  "toornamentLabel": "Match #1.1.2.1",
  "participants": [{ "id": "<a.toornamentId>", "name": "<a.name>" }, { "id": "<b.toornamentId>", "name": "<b.name>" }],
  "expectedPrevious": { "status": "pending", "sides": [
    { "id": "…", "score": null, "result": null, "forfeit": false },
    { "id": "…", "score": null, "result": null, "forfeit": false } ] },
  "desired": { "outcome": "played", "winnerId": "…" }
}
```

- `revision` counts per (store, match), starting at 1. `expectedPreviousRevision` is the revision before it (0 for
  the first).
- `expectedPrevious` is the match as Field Desk last sent it (the newest job for the match that is not cancelled): before the
  first result, and again after a reset, `status: "pending"` with all sides null. Before a reset (or a result sent while
  an earlier result was never reset) it is the last result Field Desk sent: `status: "completed"`, `result: "win" | "loss"`,
  `forfeit` true for the side that forfeited, `score: null`.
- `desired` for a forfeit: `{ "outcome": "forfeit", "winnerId": "…", "forfeitingParticipantId": "…" }`.
- `match.reset` omits `desired`.

## The worker's routes

Base `FIELD_DESK_QUEUE_URL = https://<host>/api/v1/toornament`, so the automation's paths stay as they are:
`POST /api/v1/toornament/worker/v1/jobs/{claim,heartbeat,checkpoint,ack}`. Bearer key with scope
`toornament-jobs:write`, configured the same way as the Steam keys (never logged, never in a response).

- **claim** `{ workerId, scopes: [{ tournamentId, stageId }] }` (1–50 scopes) → `null` or `{ job, claimToken, attempt,
  recoveryRequired }`. Picks the oldest claimable job in an asked scope whose store has sync on: state `pending`,
  `next_attempt_at` passed, no other job of the same stage (tournament + stage, any store) `claimed`, and no earlier
  revision of the same match still `pending`, `claimed` or `needs-human`. Select and update are one `BEGIN IMMEDIATE`
  transaction. `recoveryRequired` is true when an earlier attempt of this job had its lease expire or reached a
  checkpoint (the history holds `lease-expired`, `lease-expired-after-checkpoint`, `checkpoint` or `retry-by-hq`).
- **heartbeat** `{ jobId, payloadHash, revision, claimToken, workerId }` → `{ ok: true, leaseUntil }`, extends the lease
  (2 minutes from now). A job no longer `claimed`, a stale token, a wrong worker, hash or revision → 409, `{ error, message }`
  with the fixed `error` `not_claimed`, `stale_token`, `wrong_worker`, `wrong_hash` or `wrong_revision` (checked in that
  order); an unknown job id → 404 `job_not_found`.
- **checkpoint** same identity plus `phase: "before-save"` → `{ ok: true }`, records `checkpoint_at` for this attempt (saying it
  again changes nothing). 409 as above.
- **ack** same identity plus `status: "done" | "failed" | "needs-human" | "retry"`, `code`, optional `nextAttemptAt` (ISO
  time), `observedRemoteIds` (strings) → `{ ok: true, state, code }` with the state the job is in now. `code` is
  `[a-z0-9-]{1,64}`, or `[A-Z][A-Z0-9_]{0,63}` (the automation’s client sends its codes in that style, e.g. `VERIFIED`); `pending`
  is accepted as another word for `retry` (the client calls a transient failure `pending`). `retry` is refused (409
  `checkpoint_reached`) once this attempt has a checkpoint: an uncertain save never goes back to `pending` by itself.
  `retry` → `pending` with `next_attempt_at` (`nextAttemptAt`, kept between now and an hour ahead; else 1 s, 2 s, 4 s … up to
  60 s), capped at 5 attempts: a retry after the fifth attempt, and a job that has used five attempts and is claimable again,
  becomes `failed`, code `too-many-attempts`. `observedRemoteIds`: at most 100 printable strings are accepted; the history line
  keeps the first 10 that are at most 40 characters.
- Input is checked strictly (types, lengths, the id formats): anything else is 400 `invalid_body`; a body over 16 KB is 413. No key
  → 401 `unauthorized`; `FD_TOORNAMENT_JOBS_KEY` unset → 503 `not_configured`; another method → 405. Errors are the Steam
  routes’ shape `{ error, message }`.
- **Lease expiry** (checked on every claim, heartbeat, checkpoint and ack, and every minute — a worker whose lease ran out gets 409 `not_claimed`): a `claimed` job whose lease ran out goes back to
  `pending` (recoveryRequired next time) if it has no checkpoint this attempt, else to `needs-human`, code
  `lease-expired-after-checkpoint`.
- Every state change appends `{ at, state, code, attempt, workerId? }` to `history`. Codes, ids and timestamps only:
  never OTPs, cookies, passwords or page content.

States: `pending`, `claimed`, `done`, `failed`, `needs-human`, `cancelled`.

### How the worker connects

- **Base URL:** `https://<host>/api/v1/toornament` (the automation’s `FIELD_DESK_QUEUE_URL`), so it posts to
  `<base>/worker/v1/jobs/claim` etc.
- **Scope:** `toornament-jobs:write`. Like the Steam keys, the scope is a server environment variable holding one bearer token:
  `FD_TOORNAMENT_JOBS_KEY` (in `deploy/.env`, passed on by `deploy/docker-compose.yml`; `createApi({ toornamentWorker: { apiKey } })`
  in tests). There is no screen for it: HQ (whoever runs the server) makes a long random value (`openssl rand -base64 32`), puts it in
  `deploy/.env`, restarts, and gives the same value to the automation as `FIELD_DESK_QUEUE_KEY`. It is the only credential those
  routes accept and it is accepted nowhere else (not the Steam key, not a session). Rotate it by changing the variable and restarting.
  Unset = the routes answer 503. It is never logged and never in a response.
- Nothing is claimable until a store’s sync is on (`store.toornament.sync`) and a match is finished there.

## HQ

- The store's Toornament panel gets the switch **Send results to Toornament** (off by default) and a one-line count
  (waiting / needs you).
- An HQ-only **Toornament to-do** page lists the jobs by store: the match (`M5 · #1.1.2.1`, both names, W/L), state,
  attempts, last code and time. For `needs-human` and `failed`: **Fixed on Toornament by hand** (→ `done`, code
  `resolved-by-hq`) or **Try again** (→ `pending`, a new attempt, recoveryRequired). HQ routes: `GET /api/toornament/jobs`
  and `POST /api/toornament/jobs/:id/resolve` `{ action: "manual" | "retry" }`, super only. The page polls every 15 s.
- Matches the queue could not cover (sync on, but "not mapped") are listed with the reason, so HQ knows to enter them
  by hand.
