# Field Desk → Toornament browser worker: proposed queue contract

**For Claude / Field Desk.** The automation-side queue client, worker and in-memory mock implement this proposal. Field Desk has **no deployed queue endpoints yet**. Steam OTP uses a separate contract and is unaffected. Do not enable Toornament jobs for production from this document alone.

## Transport and ownership

Field Desk owns a durable outbox. It creates an immutable job in the same transaction as the HQ edit, records the complete previous remote result, and suppresses echo jobs for results imported from Toornament. The browser worker claims one job at a time. The current client proposes these authenticated HTTPS routes under `FIELD_DESK_QUEUE_URL` using a dedicated bearer key `FIELD_DESK_QUEUE_KEY`:

| Route (POST) | Request | Response / rule |
| --- | --- | --- |
| `/worker/v1/jobs/claim` | `{workerId, scopes:[{tournamentId,stageId}]}` | JSON `null` if empty, else `{job,claimToken,attempt,recoveryRequired}`. Claim only approved scope and at most one job per stage. `recoveryRequired` is true after any expired lease or possible save. |
| `/worker/v1/jobs/heartbeat` | `{jobId,payloadHash,revision,claimToken,workerId}` | Extend the current lease; reject stale tokens. |
| `/worker/v1/jobs/checkpoint` | Identity above plus `phase:"before-save"` | Durably mark a possible remote effect **before** the browser clicks Create/Update. Reject stale tokens. |
| `/worker/v1/jobs/ack` | Identity above plus `status`, fixed `code`, optional `nextAttemptAt`, `observedRemoteIds` | Accept only the current claim. Persist status/history. Never log OTPs, cookies, passwords or raw browser state. |

Queue states are `pending`, internal `claimed`, `done`, `failed`, `needs-human`. `done` requires verified organizer reload and public readback; public nodes may lag for minutes. A possible save with unclear result goes to `needs-human`, never an automatic second click. Retry only a proven pre-save transient error with bounded backoff. A later revision waits for the prior revision to finish. A worker lease is **not** enough to stop an old browser; deployment also needs an exclusive process/browser execution guard that works after crashes. The in-memory mock is for tests only.

## Immutable job envelope

All IDs, including Toornament IDs, are **strings**. Example shape; names and IDs are illustrative:

```json
{
  "schemaVersion": 1,
  "origin": "field-desk",
  "jobId": "immutable-job-id",
  "payloadHash": "immutable-canonical-payload-hash",
  "sourceCommandId": "hq-command-id",
  "createdAt": "2026-10-31T12:00:00Z",
  "storeId": "field-desk-store-id",
  "entityId": "field-desk-match-id",
  "bracketGenerationId": "field-desk-bracket-import-id",
  "revision": 1,
  "expectedPreviousRevision": 0,
  "kind": "match.result",
  "tournamentId": "111",
  "stageId": "222",
  "expectedTournamentName": "Test Cup",
  "expectedStageName": "Playoffs",
  "matchId": "333",
  "publicNodeId": "333",
  "mappingVerified": true,
  "toornamentLabel": "Match #1.1.1.1",
  "participants": [{"id":"444","name":"Alice"},{"id":"555","name":"Bob"}],
  "expectedPrevious": {"status":"pending","sides":[
    {"id":"444","score":null,"result":null,"forfeit":false},
    {"id":"555","score":null,"result":null,"forfeit":false}
  ]},
  "desired": {"outcome":"played","winnerId":"444","scores":{"444":2,"555":1}}
}
```

`match.reset` uses the same verified match identity and `expectedPrevious`, but omits `desired`; the worker clears both scores, both outcomes and forfeit. `match.result` with `desired.outcome:"forfeit"` uses `winnerId` and `forfeitingParticipantId`, with no fabricated score. A participant job would use `kind:"participant.add"`, `name`, `customUserIdentifier` and `expectedPrevious:{absent:true}` and would create a registered participant only, without bracket placement. **Participant creation is currently disabled:** Toornament's public participant endpoint does not expose the custom identifier needed for strong duplicate detection. The worker stops it before navigation and returns `needs-human` until an organizer-side identity readback is proven.

Field Desk must persist exact participant and match mappings in the tournament/stage/bracket-generation scope. The worker compares tournament and stage names, public node ID, organizer match URL and label, both participant IDs and names, previous result and the current organizer form before saving. The two public-node IDs checked in Kochi equal their organizer match IDs; this is evidence for those matches only, so do not infer mappings for a regenerated bracket or another stage. A mismatch, changed bracket generation, completed descendant lock, expired session or ambiguous identity needs human review. Never automatically reset a downstream match.

## Field Desk changes needed before integration

1. Add the transactional outbound queue and the four routes above with scoped worker authentication, claim fencing, lease, history and revision ordering.
2. Add durable Toornament participant/match mappings and a bracket-generation identifier. Capture the full predecessor result for finish/undo; the current free-text score alone is insufficient for a structured remote 2–1 result.
3. Decide how HQ creates structured score and forfeit intent, how an undo is gated if a later match is played, and how stale jobs are invalidated after a bracket refresh or reseed.
4. Agree on operator review for `needs-human`, plus a new correction job after review. Do not retry an uncertain browser save just because a lease expired.

Until those changes exist, the automation uses `MockQueue` and cannot claim a live Field Desk job. The current read-only Kochi checks and local tests validate the adapter's shape; they do not authorize production writes or settle Toornament's website automation policy.
