# Proposed Field Desk → Toornament browser job contract

Phase 2 feasibility proposal only. This document does not define a deployed API, queue or production worker. Field Desk would own a durable outbound queue; a browser worker would claim authorized jobs, verify the organizer UI, perform one bounded mutation and report verified state. No participant placement, seeding or bracket generation is authorized by these job kinds.

## Envelope and identity

All jobs would carry `schemaVersion`, immutable `jobId`, `kind` (`participant.add`, `match.result`, `match.reset`), `sourceCommandId`, `origin: field-desk`, `createdAt`, `storeId`, tournament/stage IDs, `bracketGenerationId`, per-entity `revision`, `expectedPreviousRevision`, and an immutable payload hash. Reusing a job ID with another payload is a conflict. Remote-origin imports must not echo back as new outbound writes.

Match jobs additionally need a verified mapping from Field Desk `matchId` to the actual Toornament organizer match ID, plus both sides' Field Desk player IDs and Toornament participant IDs. Required payload cross-checks are `toornamentLabel` (the verified organizer match label), `expectedTournamentName`, `expectedStageName`, and `expectedParticipantNames` keyed by remote participant ID. Participant jobs also carry the expected tournament/stage names and `expectedParticipantName`. Check these against the current UI before mutation; a mismatch requires reconciliation or human review. Keep a public bracket `nodeId` separately if useful; its equivalence to an organizer match ID is **unverified**. Round/index, display names and labels are cross-checks, never identity keys. Verify actual UI label names, localization, side ordering and navigation during feasibility; do not assume button names or public-node numbering identify a writable match.

Persist participant and match mappings with their tournament/stage/generation scope and verification evidence. A bracket reload/rebuild invalidates the old generation's mappings and pending jobs until explicitly reconciled. Never infer a new generation's target from an old round/index.

## Job payloads

| Kind | Required intent and preconditions |
| --- | --- |
| `participant.add` | Local player ID and on-spot entry ID; intended display name and approved identifying metadata; existing remote ID if reconciled; prior mapping state. Create a registered participant only, without placement. Persist the observed remote participant ID before completion. |
| `match.result` | Verified target and participant mappings; structured scores keyed by participant ID (including game/set detail when required); winner participant ID; explicit outcome (`played` or `forfeit`), forfeiting participant ID for a forfeit; expected previous remote result and complete desired result. Do not parse the app's free-text score or treat its walkover flag as proven Toornament forfeit semantics. |
| `match.reset` | Verified target and participant mappings; the exact prior result to remove, including score, winner, outcome and remote lifecycle state; desired cleared state; downstream dependencies and expected prior state. Reset only if remote state matches the recorded predecessor. Stop for human review if it would erase a different result, invalidate underway descendants or require an unapproved stage reopen. |

For participant creation, check a saved mapping first. After an uncertain create, reconcile against a durable pre-create observation and strong identifying evidence or an approved external correlation field if the UI supports one. Equal names, or a single same-name search hit, do not prove identity. If reconciliation cannot distinguish an existing participant from a newly created one, use `needs-human`; do not create again. Avoid copying phone/contact data unless a verified field and approved purpose require it.

## Delivery, claims and recovery

Proposed owner-visible statuses: `pending`, `done`, `failed`, `needs-human`; internal `claimed` tracks a live lease. Persist the job with the accepted source mutation in one transaction/outbox commit. A webhook may wake the worker but must not replace the queue. No such transaction or endpoint is implemented here.

Claim atomically with worker ID, opaque claim/fencing token, lease expiry, attempt count and `nextAttemptAt`. Heartbeat while working; accept completion only from the current claim. Serialize mutations for a tournament/stage and order dependent entity revisions. A reclaimed job must reconcile any prior uncertain attempt before saving. Lease expiry does not prove the prior browser stopped: require session/execution exclusion before another worker writes; fencing a queue acknowledgment alone cannot fence a remote UI click.

Before every save, read the current remote entity and verify generation, mapped IDs, both participants, expected predecessor and source revision eligibility. If desired state is already present and attributable to this intent, complete by reconciliation. If remote state differs from both predecessor and desired state, stop with `needs-human`; never overwrite it. Block dependent revisions until their predecessor is verified done or explicitly resolved.

Persist an attempt checkpoint before clicking save. A click, toast, timeout or HTTP success alone is insufficient for `done`: re-open/re-read the target and verify persisted IDs, scores, winner/outcome or cleared state. A crash, logout, navigation error or timeout after possible save is `uncertain`, an internal recovery condition, not permission to repeat the mutation. Recover by read-only reconciliation: desired state → verified done; unchanged predecessor → retry only with proof no earlier save remains in flight; ambiguity → `needs-human`.

Retry only classified transient failures with bounded exponential backoff/jitter and the same job ID. Stop retries after a configured attempt/age limit; `failed` means a definite non-applied terminal failure, while uncertain effects remain `needs-human`. Authentication challenges, unsupported UI, missing/ambiguous mappings and state conflicts require human review. A human-approved correction creates a new revision/job; retain the original history.

Report `jobId`, revision, status, current claim token, attempt timestamps, sanitized error code/message, observed remote IDs/state, payload hash and minimal verification evidence. Store no cookies, credentials or participant contact details in reports/screenshots. Worker reporting must not manufacture a Field Desk result or mark an on-spot entry added until the remote participant mapping is verified.

## Repository evidence and unresolved gates

- `src/lib/types.ts:85–99`: `Match` has local ID/round/index/player IDs, free-text `score` and optional `walkover`; no remote match mapping or structured score. `MatchDay.version` is a whole-day command version, not a per-match outbound revision.
- `src/lib/types.ts:145–186`: on-spot records retain local entry/player IDs and a manual added timestamp; Toornament metadata retains URL/stage/load ID, not participant or organizer match mappings.
- `src/lib/toornament.ts:211–225,253–300`: public readers see participant/node IDs, but `StageBracket` returns names and first-round name pairs. The existing import is insufficient evidence for safe outbound identity. Node ID stability across bracket regeneration and its relation to organizer match IDs remain unverified.
- `src/lib/command-types.ts:30–31` and `src/lib/tournament.ts:592–631`: finish accepts winner/free-text score/walkover; undo receives only `matchId` and clears result fields. A durable outbound undo needs the pre-mutation snapshot; reading only the resulting app state loses it. Local undo also guards downstream matches, but remote dependency/lifecycle behavior needs separate verification.
- `src/lib/types.ts:261` defines `TournamentEvent` as a campaign record, not an outbound match-event contract. `automation/CONTRACT-NOTES.md` explicitly defers tournament workflows and their identity/revision/score/undo agreements. These app observations were rechecked against the new branch based on `d4a2353`.

Before production work: agree the queue/API/authentication and transactional enqueue contract with the app owner; retain ID mappings and full predecessor snapshots; define revision/dependency and stale-job rules; verify organizer UI identity, labels, score/forfeit/reset semantics, downstream reset effects and final-stage reopening in a disposable tournament. Completion/reopening synchronization is a separate explicit contract decision. This proposal provides no evidence that these capabilities currently work.
