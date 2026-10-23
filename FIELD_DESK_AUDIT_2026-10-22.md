# Field Desk — independent architecture and flow audit

**Reviewed:** 22 October 2026  
**Purpose:** Second-opinion review for the owner and Claude Code / Opus.  
**Changes made:** This report only. No application source, configuration, dependencies, credentials, or business data were changed.

## 1. Executive assessment

The app has a sensible, focused product structure: HQ configures campaigns and assignments; field admins collect venue evidence and run tournaments; HQ receives reports; a venue board displays matches. The code is small enough to understand and improve incrementally. A framework rewrite is not warranted by this review.

The largest risks are **silent data loss, inconsistent multi-device tournament state, and a mismatch between what the interface promises and what has actually been saved or verified**. These should take priority over visual polish or additional features.

The TypeScript check passes. That does not establish operational correctness: most important findings concern retries, concurrent changes, runtime input validation, and incomplete evidence.

**Recommendation:** Fix the P1 findings and exercise the release scenarios below before using this as the sole source of truth for a live tournament. This is a source audit, not a claim that the deployed app has been penetration-tested or every browser flow exercised.

### Severity and evidence conventions

- **P1 — high:** Potential data loss, material security exposure, service interruption, or tournament corruption. Fix before production reliance.
- **P2 — medium:** Incorrect workflows, misleading results, or reliability gaps. Fix in the next stabilization pass.
- **P3 — improvement:** Product clarity, accessibility, and maintainability.
- **Executed:** A safe, in-memory reproduction was run against the relevant code.
- **Source-confirmed:** The failure path is supported by code inspection; its full browser/server scenario was not executed.
- **Design decision:** An improvement or policy choice, not automatically a bug.

File references below are relative to the workspace root, `G:\02. Creative Code\ADMIN WORKFLOW`; line numbers refer to this review snapshot.

## 2. Review scope and limits

Reviewed the application entry points, all page flows, shared UI, recce/report/photo pipeline, tournament logic, synchronization, backups, authorization, API storage, production serving, Docker packaging, and build configuration. Three parallel reviewers independently examined server/security, synchronization/data integrity, and tournament behavior; the primary review covered integration, recce, reports, and product flow.

Verification performed:

- Ran the installed TypeScript compiler with `--noEmit`: **passed** on Node v24.15.0.
- Executed in-memory checks confirming malformed Maps URL failure, blank manual-speed acceptance, and missing stale-image flags for camera-path images.
- Parallel reviewers ran in-memory checks of array merge loss, concurrent station assignment, bracket parsing, undo behavior, operation validation, and malformed URL decoding.
- A reviewer completed seeded tournaments for every entrant count from 2 through 64 in memory; each progressed to a champion. This supports the basic seeding/bye implementation, not multi-device safety.
- Inspected package scripts: no test or lint script is configured.

Not performed:

- No production writes, live database reads, credential reads, logins, destructive security probes, dependency installation, or app edits.
- No full build, because it writes generated output; only no-output type checking was run.
- No browser/mobile camera/GPS/print validation, network fault injection against a running app, load test, dependency vulnerability scan, or deployment inspection.
- This folder is not a Git checkout, so Git could not provide a clean-tree baseline or commit identifier.

## 3. How the app is built

| Layer | Current implementation | Implication |
|---|---|---|
| Frontend | React 18, TypeScript, Vite 5, custom CSS | Lightweight and understandable; runtime data still needs validation. |
| Routing | Hash routes plus path-based personal-code sign-in | Easy static serving; authorization must remain on the API. |
| App state | Module-level external store consumed through `useSyncExternalStore` | Simple shared state; identity changes and asynchronous callbacks require careful lifecycle handling. |
| Offline storage | IndexedDB through `idb-keyval` | Supports local edits while a loaded app is disconnected; does not itself provide offline app loading. |
| Synchronization | Optimistic state, operation diffing, persisted batches, HTTP POST, SSE updates | Useful design, but generic field merging cannot enforce tournament invariants. |
| Backend | Custom Node HTTP API, native `node:sqlite` | Small dependency footprint; validation, sessions, routing errors, and observability are application responsibilities. |
| Persistence | JSON documents in SQLite, metadata and deduplication tables, photos on disk | Suitable starting point for a small single-instance installation with persistent storage. |
| Access | HQ secret; four-character field-admin codes; signed cookies | Convenient field workflow, but session expiry and principal isolation need strengthening. |
| Evidence | Browser photo decoding, EXIF reading, canvas stamping, photo references | Useful operational evidence, not independent proof of capture location/time. |
| Reporting | One React report renderer for screen and exported HTML; browser print for PDF | Good reuse; completeness must be checked before export. |
| Deployment | Docker Node 24 image; persistent `/data`; TLS expected upstream | Requires correct proxy trust, secret exclusion, backups, and single-instance assumptions. |

### Data flow

```text
HQ creates campaign → creates admin → assigns store → shares code link
                                           ↓
Admin signs in → server returns permitted stores/events
                                           ↓
Recce/check-in/match edit → optimistic local view → IndexedDB outbox
                                           ↓
Upload photos → send operation batches → authorize → SQLite commit
                                           ↓
SSE update / snapshot refresh → HQ, field devices, venue board
                                           ↓
Report renderer → on-screen report / embedded-photo HTML / browser PDF
```

Positive foundations worth preserving: server-side store filtering, field-level permissions, prepared SQL statements, transactional document commits, prototype-related path restrictions, cookie `HttpOnly`/`SameSite`, photo-before-edit upload ordering, a shared assessment function, standard seeded brackets, and a reused report renderer.

## 4. High-priority findings

### F01 — A failed response can cause a later edit to disappear on retry [P1]

**Evidence:** Source-confirmed. `src/lib/db.ts:169–183, 381`; `server/api.ts:155–158`.

The client can append new operations to an existing unsent batch whenever it is not currently in flight. After a request fails, its in-flight marker is removed. However, the server may already have committed that batch before the response was lost. If another edit is appended to the same batch ID, the server treats the retry as already processed and ignores its expanded payload.

**Reproduce:** Send batch X; allow the server to commit; lose its response and SSE confirmation; make another edit before successful synchronization; retry X. The newer operation can be acknowledged indirectly without ever being applied.

**Fix:** Persist an immutable payload once a batch is first attempted. Every later edit gets a new batch ID. Record a payload hash with deduplication and reject reuse of an ID with a different payload. Keep retries byte-for-byte equivalent.

**Acceptance:** Fault injection at the post-commit/pre-response boundary preserves both edits exactly once, including across reloads.

### F02 — Array updates can overwrite other devices' work [P1]

**Evidence:** Executed pure-operation reproduction. `src/lib/ops.ts:56–61, 81–94`.

Equal-length arrays are diffed by position; different-length arrays are replaced wholesale. Two devices appending photos to the same baseline produce competing full-array replacements. One addition disappears. Position-based edits also become unsafe when another client removes or rearranges entries.

**Reproduce:** Both devices begin with photo P1. Device A adds P2; device B adds P3. Applying both generated diffs results in one append replacing the other.

**Fix:** Use stable entity IDs for mutable collections and explicit add/remove/update operations. For destructive roster or bracket replacement, use a version check and conflict response instead of pretending it merges safely. Define removal/tombstone behavior.

**Acceptance:** Concurrent additions survive; editing a laptop never applies to a different laptop after list resizing; stale roster replacement cannot overwrite a newer tournament.

### F03 — Two clients can call different matches to the same station [P1]

**Evidence:** Executed with the actual diff/apply mechanism. `src/lib/bracket.ts:122–124`; `src/pages/DayPage.tsx:180, 202–207`; `server/api.ts:170`.

Station allocation is based on each device's local queue. `startMatch` marks a match live without checking server state. Two valid local calls merge into two live matches assigned to one station. The queue UI uses `.find()` per station, hiding one of those matches' controls.

**Reproduce:** Two clients see station 1 free; each calls a different ready match before receiving the other's update.

**Fix:** Add a server-authoritative start-match command executed against current state. Validate station availability, participant availability, check-ins, match state, and expected tournament version within the transaction. Apply the same principle to finish/undo/reset commands. Offline calls must remain explicitly pending until arbitration.

**Acceptance:** Exactly one competing call succeeds; the other gets a recoverable conflict and refreshed queue. A player and a station cannot be active in multiple matches.

### F04 — Valid operation syntax can persist invalid business documents [P1]

**Evidence:** Executed operation validation/application check. `src/lib/ops.ts:97–114`; `server/api.ts:137–145, 170–177`.

Validation checks the operation envelope and allowed paths, not the resulting document shape or business invariants. An assigned admin can submit a syntactically accepted operation setting their store's `recce` to `null`. That can be persisted and subsequently crash recce assessment on HQ pages. Similar issues affect matches, counts, references, and field types.

**Fix:** Validate complete resulting documents before commit, including required structures, finite numeric ranges, dates, IDs, referential integrity, and allowed state transitions. Reject malformed state atomically. Apply the same schema to backup import. Add a render error boundary as containment, not as a replacement for validation.

**Acceptance:** Invalid documents return a useful 4xx response, do not advance the committed state, and cannot break another user's dashboard.

### F05 — Local cached state and pending work are not scoped to an actual user [P1]

**Evidence:** Source-confirmed. `src/lib/db.ts:51, 277–292, 338–365`; `server/api.ts:236` (`/api/me`).

The client remembers a role, not a stable authenticated principal. Both field admins have role `admin`. Opening a second admin's personal link can temporarily reuse the first admin's cached state before the new snapshot arrives. The outbox and photo storage are also shared across identities. Revocation clears the saved server snapshot but retains queued work and photos; this is weaker than the README's device-wipe claim.

**Fix:** Return a stable principal/session-generation identifier; namespace cached state, uploads, and outboxes by that identity. Introduce a session generation that invalidates old asynchronous responses. Quarantine pending work on account change and never replay it automatically under a different principal. Define the offline access/revocation policy explicitly.

**Acceptance:** Admin A → Admin B, HQ → admin, revoked code, failed login, and multiple-tab transitions never expose another identity's cached records or replay its writes.

### F06 — Malformed public URLs can escape production request handling [P1]

**Evidence:** Decode failure executed; full production process termination not executed. `server/index.ts:36–55`, particularly line 43.

The production HTTP listener is asynchronous but has no outer error handler. A non-API URL such as `/%` throws from `decodeURIComponent`. The resulting rejected promise is outside the API's catch boundary; under normal Node unhandled-rejection behavior this can terminate the process.

**Fix:** Wrap the complete request listener, return 400 for invalid URLs, and handle static-file stream errors. Avoid a single malformed request bringing down the service.

**Acceptance:** Malformed encoded paths return a bounded 4xx response; the server remains healthy and serves a subsequent valid request.

### F07 — Docker packaging includes local environment secrets [P1]

**Evidence:** Source-confirmed. `Dockerfile:7`; `.dockerignore:1–5`. The `.env.local` filename exists; its contents were not read.

`COPY . .` copies the workspace, while `.dockerignore` does not exclude `.env.local` or other environment files. The README says the local HQ secret is generated there. Building an image can therefore embed that credential in image contents/layers. `.gitignore` does not protect Docker build context.

**Fix:** Exclude environment files, secrets, VCS metadata, and unrelated local artifacts from the context; prefer explicit source copies or a minimal multi-stage build. Keep runtime secrets outside images. If such an image was already distributed, assess exposure and rotate the relevant credential.

**Acceptance:** Inspect a freshly built image and its build context: no local environment file or secret-bearing file is present.

### F08 — Photo authorization is derived from references that the caller can edit [P1]

**Evidence:** Source-confirmed. `server/api.ts:120–145, 313–331`.

Photo GET access is granted when an ID appears in one of the admin's stores. That same admin can edit photo references. If they learn another store's photo ID, adding it to their own allowed store can make that photo readable. IDs are not automatically enumerable, so knowledge of an ID is a prerequisite; this is not a claim of anonymous bulk access.

Uploads also lack durable owner/store metadata. The existence check followed by asynchronous write/rename is not an atomic write-once operation: concurrent initial writes to the same ID race.

**Fix:** Store immutable photo ownership and store association server-side, authorize uploads and reference attachment, and enforce exclusive creation atomically. Validate actual image bytes and impose storage quotas. Preserve the upload-before-reference workflow through an authorized staged-upload record.

**Acceptance:** Knowing a foreign photo ID does not grant access; simultaneous PUTs cannot replace committed content; unreferenced uploads are accountable and bounded.

### F09 — Rejected writes are removed with no user recovery [P1]

**Evidence:** Source-confirmed. `src/lib/db.ts:154–160, 174–177`.

400/403 edit responses are treated as confirmed and removed. Rejected photo uploads are also removed from the upload queue. The UI may eventually show no pending work even though the data was not accepted. A coalesced batch can include edits to several stores: if one store was reassigned, the server rejects the entire batch, losing unrelated valid edits too.

**Fix:** Retain a failed-work queue with reason, affected records, retry/recovery/export actions, and a visible status. Partition operations appropriately by authorization/conflict boundary. Never count rejected work as successfully synced. Distinguish authentication failure, permission change, validation failure, oversized media, and transient failure.

**Acceptance:** Reassignment of one store cannot silently discard another store's edits; a failed photo never becomes an unexplained empty proof slot.

## 5. Workflow and reliability findings

### F10 — Buffered resync messages can be discarded [P2]

**Evidence:** Source-confirmed. `src/lib/db.ts:227–239, 247–253`.

While loading a snapshot, SSE messages are buffered. During replay the code ignores the return value of `applyRemote`, including its request to resync after a structural change or sequence gap. A reassignment arriving after the snapshot was captured can be lost during this drain, while the UI is marked live.

**Fix:** Restart snapshot acquisition when buffered replay signals a gap/structural resync; serialize resync attempts and invalidate obsolete stream generations.

**Acceptance:** Reassign a store between snapshot capture and response delivery; the old client removes it without needing another unrelated update.

### F11 — Submitted reports remain editable without a new submission revision [P2]

**Evidence:** Source-confirmed. `src/pages/ReccePage.tsx:25–30, 44–51`; `src/components/ReportsInbox.tsx:10–36`; `src/components/Report.tsx:12–16`.

After submission, edits change the same live report while leaving the old `submittedAt` and submitted status. HQ's New marker is keyed to that timestamp, so meaningful changes need not appear as a new submission. Changes to campaign settings also recalculate historical reports against current requirements. Offline submission immediately displays Submitted even before delivery to HQ.

**Fix:** Separate working draft, queued submission, acknowledged submission, and review status. Save a submission revision containing the recce and applicable policy/settings snapshot. Show subsequent edits as an updated draft until resubmitted. Preserve an actor and server timestamp.

**Acceptance:** HQ can reproduce the exact report it reviewed; later edits do not silently alter it; offline submission says waiting to send until acknowledged.

### F12 — PDF, HTML, and backup can silently omit proof photos [P2]

**Evidence:** Source-confirmed. `src/pages/ReportPage.tsx:22, 31–55`; `src/lib/exportReport.ts:12–17`; `src/lib/backup.ts:9–14`; `src/components/Report.tsx:29–30`.

Manual PDF waits only on existing `<img>` elements. Missing photos render placeholders, so they do not participate in the image check. `img.complete` also does not prove successful decoding. Automatic PDF proceeds after eight seconds. HTML and backup export silently skip missing blobs.

**Fix:** Build an explicit expected-photo manifest. Require all referenced images to load/decode, or ask the user to deliberately export an incomplete artifact that lists the missing evidence. Use `naturalWidth`/decode checks. Backups need counts/checksums and a verified-completeness status.

**Acceptance:** With a photo unavailable or still uploading, no artifact is presented as complete; retry works without losing the report.

### F13 — Backup import is neither fully validated nor safely staged [P2]

**Evidence:** Source-confirmed. `src/lib/backup.ts:19–29`; `src/pages/Home.tsx:108–116`.

Import checks only a kind marker and schema version, writes photos before completing validation, and merges matching IDs over current records. A malformed or old backup can replace current work, restore obsolete admin credentials, or fail after partial side effects. The success alert means locally imported, not server accepted.

**Fix:** Parse and validate the whole file first; show a dry-run summary of creates/replacements, credential implications, and missing photos; stage the import and commit through a controlled server workflow. Report completion only after acceptance. Distinguish a portable app export from a full disaster-recovery backup of SQLite plus retained photos and metadata.

**Acceptance:** Malformed files make zero changes; conflicting records are reviewable; interrupted import is recoverable and idempotent.

### F14 — Decreasing station count hides an active match [P2]

**Evidence:** Source-confirmed with in-memory state inspection. `src/pages/DayPage.tsx:202–207`.

Station count can be reduced below an occupied station number. Rendering loops only through the new count, leaving the live match without its normal result/cancel controls until the count is raised again.

**Fix:** Reject reductions that affect occupied stations or require an explicit reassignment. Also show an actionable invariant warning if legacy/corrupt data contains an out-of-range live station.

**Acceptance:** A live match on station 2 remains controllable when someone attempts to reduce capacity to one.

### F15 — Bracket paste parsing silently changes malformed input [P2]

**Evidence:** Executed. `src/lib/bracket.ts:41–58`.

`Alice vs Bob vs Carol` is split and only the first two values are used. Mixed name-only and pairing lines fall through to the name-list branch, turning pairing text into player names.

**Fix:** Make the import mode explicit or reject mixed formats. Require exactly two sides per pairing. Show a parsed roster/bracket preview and line-specific errors before saving. Define duplicate-name handling deliberately.

**Acceptance:** No nonempty input fragment disappears; mixed input is rejected with useful guidance.

### F16 — Undo keeps the previous score [P2]

**Evidence:** Executed. `src/lib/bracket.ts:127–145`; `src/pages/DayPage.tsx:182, 230`.

Undo clears winner/status/times but does not clear score. A later finish without a new score falls back to the old one. UI-local score drafts can also survive an undo/replay.

**Fix:** Clear score in both domain state and any UI draft when undoing/canceling, or explicitly implement a result-correction mode that preserves it intentionally.

**Acceptance:** Finish 2–0, undo, replay with no score: the old score is not silently attached to the new result.

### F17 — Blank speed measurements satisfy the Internet checklist [P2]

**Evidence:** Executed. `src/components/SpeedTest.tsx:95–96`; `src/lib/assess.ts:82–90`.

Saving an empty manual form creates a speed object whose numbers are all null. With Wi-Fi/LAN answered and a screenshot attached, the Internet section becomes complete; there is no missing-download or below-threshold warning, only the generic manual-entry note. Negative/infinite values are also not consistently rejected.

**Fix:** Require finite, nonnegative values for the metrics the policy requires; an absent download must not count as measured. Validate on client and server. Add HTTP-status checks and bounded timeouts to `src/lib/speedtest.ts`; cancel on component unmount so a background measurement cannot unexpectedly update a closed section.

**Acceptance:** Empty, invalid, negative, and infinite values are rejected; failed speed endpoints cannot produce a trusted successful result.

### F18 — Photo proof can be labeled more strongly than it was verified [P2]

**Evidence:** Executed stale-camera-path flag check; remaining paths source-confirmed. `src/components/PhotoSlot.tsx:47, 62, 72, 88`; `src/lib/assess.ts:37–48`; `src/components/Report.tsx:229`.

The camera input is a browser hint, not a guarantee that a new image was captured. The app records `live: false` for an old file, but `photoFlags` does not apply upload-age checks when `source` is camera. GPS is requested before the camera opens and can be stale by the time the image is returned. With no HQ coordinates, the first device-geotagged photo in any slot can establish the fallback pin. Future photos then being near that pin does not independently verify the venue. The report footer claims every image has capture-time GPS, which is false for uploads/missing metadata.

**Fix:** Distinguish verified HQ reference, provisional photo-derived reference, capture time, upload time, and location measurement time. Flag stale/unknown camera-path images and uncertain location accuracy. Obtain a suitably recent fix near capture completion. Make the footer conditional and honest. Keep photo evidence advisory unless stronger provenance is implemented.

**Acceptance:** An old image selected through a camera input is flagged; an unknown venue pin never appears independently verified; missing GPS/time is clearly disclosed in exports.

### F19 — A malformed Maps link leaves Save stuck [P2]

**Evidence:** Executed parser failure. `src/lib/recce.ts:83`; `src/components/StoreForm.tsx:32–42, 51–54`.

`https://maps.google.com/%` is accepted by the URL constructor but fails in `decodeURIComponent`, outside the parser's catch. `locate` invokes that parser before its own try block; the form has no `finally` to reset busy state.

**Fix:** Catch parsing/decoding failures, validate allowed URL schemes, display a field error, and always release busy state in `finally`. Do not silently present an unresolved location as verified.

**Acceptance:** Invalid percent encoding never crashes/stalls saving; the user can correct the link and retry.

### F20 — Campaign game-list editing removes the delimiter while typing [P2]

**Evidence:** Source-confirmed. `src/pages/EventPage.tsx:130`; `src/pages/Home.tsx:124–128` (`split`).

The settings field renders `games.join(', ')` and immediately parses every keystroke back into the array. Typing a comma at the end of an existing game is normalized away before the next game can be typed. Pasting a complete list can work, but ordinary incremental editing is unreliable.

**Fix:** Keep a local text draft; validate and commit on blur or Save. Treat game-name changes as changes to checklist policy, with a clear migration policy for existing laptop evidence.

**Acceptance:** A user can type a second game naturally, including spaces, without losing delimiters or producing transient requirements on every keystroke.

### F21 — Proxy deployment can turn per-address rate limiting into shared lockout [P2]

**Evidence:** Source-confirmed; depends on proxy topology. `server/api.ts:239`; README deployment guidance.

The API buckets failed logins by `req.socket.remoteAddress`. Behind a reverse proxy, many users can share that address. Ten incorrect attempts can therefore block otherwise correct HQ/admin logins from all those users for the window. The global limit also deliberately creates a shared ceiling.

**Fix:** Define trusted proxy behavior explicitly; derive client IP only from trusted infrastructure and combine sensible per-source/account/global limits. Do not blindly trust arbitrary forwarded headers. Verify behavior in the actual hosting setup.

**Acceptance:** One user's mistyped code cannot lock out unrelated users; spoofed client headers cannot bypass the policy.

### F22 — Cookie expiry and logout do not invalidate the underlying token [P2]

**Evidence:** Source-confirmed. `server/api.ts:79–88, 251, 255–258`.

Tokens are deterministic signatures of identity/code and have no server-enforced expiration. Cookie Max-Age controls normal browser storage, not token validity. Logout clears the browser cookie but a previously copied token remains usable until its code changes.

**Fix:** Issue expiring, revocable sessions with distinct IDs, timestamps, and session-generation checks. Define whether logout means this session or all sessions. Preserve code rotation as a bulk revocation mechanism.

**Acceptance:** Expired and explicitly revoked sessions fail on the server even if a client manually resends the token.

## 6. Product decisions and secondary improvements

These are separate from the confirmed high-priority defects.

1. **Readiness needs a policy, not only checklist completeness.** `assess.ts` labels completed-but-flagged setups “Ready — with notes,” including no internet or no setup. Decide which risks block play and which HQ can waive. Model `incomplete`, `blocked`, `ready with approved exception`, and `ready` separately if operations need that distinction. Empty campaign games currently allow game checks to be vacuously satisfied.
2. **One tournament per store is the current model.** Campaigns accept several games, but `Store.day` has only one roster/bracket/champion with no game identifier. If the games are only install requirements, label them that way. If several tournaments run at one store, introduce separate competitions before promising support.
3. **Results handoff is incomplete or mislabeled.** `DayPage.tsx:189` says results are in the store report; `Report.tsx` intentionally contains only recce data. Correct the copy or introduce a separate match-day results export with champion, results, walkovers, and corrections.
4. **Both players absent has no explicit resolution.** The walkover UI offers advancement only when one player is present. Define double no-show, disqualification, late arrival, and tournament closure policies rather than forcing fake check-ins.
5. **TV access should have its own scope.** The board is visually read-only but uses an admin/HQ session. Consider a revocable, store-specific display session so a public/shared display never needs operational write privileges. Show connection freshness on the board; its advancing clock is not proof that match data is current.
6. **Offline editing and offline reopening are different promises.** IndexedDB retains work, but no service-worker registration/app-shell offline strategy was found. A loaded page can operate offline; a fresh launch/reload offline is not guaranteed. Decide whether an installable offline app is required, then test it deliberately.
7. **Local storage failure needs an explicit mode.** `db.ts` reads localStorage at module scope; `main.tsx` waits on `loadState` without a recovery render. Storage denial/quota/corruption can prevent startup or durable saves. Add a recoverable error screen and truthful saved/persisting/failed status.
8. **Laptop resizing is destructive.** Reducing the count slices away laptop records and evidence references; increasing it again creates new records. Add a preview/confirmation or retire records reversibly. Campaign target changes also only reassign roles when a count is edited, so checklist policy can temporarily disagree with stored roles.
9. **Long photo operations can race with edits.** `PhotoSlot.tsx:87` appends to the `photos` array captured before asynchronous processing. A remote addition received during stamping can be replaced by that stale array. Use ID-based mutations against current state, not a captured collection.
10. **Dates need one explicit convention.** New campaign defaults use UTC `toISOString().slice(0,10)` while most display/operational logic uses local dates. In India before 05:30, the default can be the previous calendar day. Use an explicit operational timezone/date helper and validate blank dates.
11. **Error states should be visible and recoverable.** Replace console-only sync failures and generic alert chains with inline actionable feedback. Add an error boundary, a support-safe diagnostic identifier, and structured logs without secrets.
12. **Accessibility deserves a focused pass.** Some controls use visual spans rather than associated labels; custom tabs/radio groups need keyboard behavior; the photo lightbox needs dialog semantics, focus management, Escape handling, and focus return. This was not tested with assistive technology.
13. **Avoid unbounded storage and memory growth.** Photo object URLs are cached without revocation; server photos are retained indefinitely; confirmed batch IDs accumulate in the client session. Define bounded caches and retention while preserving evidence required by policy.
14. **Keep deployment expectations explicit.** In-memory documents and SSE subscribers assume one coordinated server process. Multiple independently running replicas over the same logical data are not a supported synchronization design. Document single-instance operation now; add shared coordination only if scale requires it.
15. **Keep operational backup separate from user export.** Test a restore of SQLite, its consistent snapshot/WAL handling, retained photos, and required metadata. A client JSON export omits unreferenced retained photos and is not a complete infrastructure recovery procedure.
16. **Downstream result correction has a constrained-reachability defect.** An in-memory test of `bracket.ts:91–97` confirmed that replacing a completed match's losing participant can preserve its old winner, score, and done state when that winner remains a participant. The ordinary single-client undo UI prevents this once the next match starts, so this is not a routine single-user reproduction. Stale clients, generic operations, or future correction/import features can bypass that protection. Reject changes affecting started descendants, or explicitly invalidate dependent results whenever either participant changes.

## 7. Recommended implementation order

### Phase A — protect state and secrets

Fix F06/F07 first because they are isolated production hazards. Then add runtime document validation and regression coverage for F04. Fix immutable retry batches, failed-work retention, identity-scoped storage, and robust SSE resync before expanding functionality. Resolve photo ownership and atomic write-once behavior.

### Phase B — make match day authoritative

Introduce domain commands for start, finish, undo, and reset with version/conflict checks. Enforce tournament invariants on the server. Fix station reduction, parser validation, and stale score handling. Keep ordinary checklist field edits lightweight where merge semantics are well-defined.

### Phase C — make evidence and submission trustworthy

Add explicit submission acknowledgment/revisions; validate evidence manifests for report/export/backup; fix speed/photo provenance and Maps errors. Decide readiness blocking and approval policies. Do not substitute a polished success label for actual server acknowledgment.

### Phase D — improve operations and usability

Add safe import previews, board freshness/read-only scope, timezone helpers, error recovery, accessibility, restore drills, and focused observability. Decide multi-game and fully offline reopening requirements before adding their architecture.

## 8. Release verification matrix

| Scenario | Required outcome |
|---|---|
| HQ creates campaign/admin/store and assigns it | Correct admin receives only the assigned store and its campaign. |
| Admin attempts another store's write/read | Denied; no foreign metadata or photo access. |
| Photo ID from another store is attached manually | Attachment/read denied by ownership, not accepted because of the new reference. |
| Same device switches between two admins | No previous user's records, photo cache, or queued writes are exposed/replayed. |
| HQ rotates a code with admin online/offline | Online session is revoked; offline policy is explicit; pending work is recoverable under the correct identity. |
| Response is lost after a committed batch | Retry applies once; subsequent edits remain separate and survive. |
| Two devices append photos | Both additions remain, with no reference/blob mismatch. |
| Store reassigned while snapshot is loading | Old device loses access without needing an unrelated later event. |
| One rejected operation shares a queue with valid work | User sees failure; unrelated valid work survives. |
| IndexedDB write fails or quota is exceeded | No false “saved” state; recoverable message/export path appears. |
| Recce submitted offline | “Waiting to send” until confirmed; HQ sees a specific acknowledged revision. |
| Submitted recce edited later | Reviewed revision remains reproducible; changes become a new draft/revision. |
| Export with unavailable/invalid photo | Wait, retry, or explicit incomplete export; never silent completeness. |
| Malformed backup / conflicting backup | No partial mutation; preview and validation precede commit. |
| Two clients call matches to station 1 | Exactly one succeeds; other gets conflict feedback. |
| Capacity decreases while station occupied | Operation blocked or controlled reassignment; live match remains operable. |
| Finish → undo → replay | Correct participants propagate; old result/score does not survive accidentally. |
| Pairing import has mixed/extra separators | Line-specific validation; no silently dropped entrant. |
| Seeded brackets of 2, 3, 5, 8, 17 entrants | Correct seed pairing/byes, one champion, no duplicate active participant. |
| Blank speed / old camera-path photo / missing venue pin | No unqualified complete/verified claim. |
| Malformed URL or failing static read | Server stays alive, returns controlled error. |
| Proxy login rate limit | One client's failures do not accidentally lock out all clients. |
| Offline cold launch / mobile capture / print | Test actual supported devices; document any unsupported behavior. |
| Backup restoration on a clean instance | Documents and all expected evidence restored and verified. |

## 9. Ready-to-use prompt for Claude Code / Opus

Copy the following prompt into Claude Code with this report available in the workspace. This is a proposed follow-up implementation task; no implementation has been done by this audit.

```text
Act as the lead engineer stabilizing Field Desk, our internal tournament operations app.

Read FIELD_DESK_AUDIT_2026-10-22.md first, then inspect the current code and applicable repository instructions. This report is an independent review, not infallible authority: reproduce findings, update line references, and distinguish confirmed defects from hypotheses and product decisions. Do not blindly implement every suggestion or rewrite the stack.

Product context:
- HQ creates campaigns, admins and assigned stores.
- Field admins sign in through personal links and can access only their stores.
- They collect photo-backed recce data, submit reports, check players in, run a single-elimination bracket, and display a venue board.
- React/Vite/TypeScript frontend; custom Node HTTP API; native SQLite; IndexedDB outbox; photo files; SSE synchronization.
- Reliability on weak connections and correctness across several devices are essential.

Start by producing a concise execution plan and revalidating F01-F09. Preserve user data, current useful behavior, and the lightweight architecture. Use focused parallel agents if available, assigning non-overlapping ownership and integrating their results carefully. Never read or print secrets unnecessarily. Use synthetic test data and isolated temporary storage; do not test destructive cases against the real .data directory.

Implement in reviewable stages:

1. Production safety and validation
   - Add complete HTTP error boundaries and malformed-URL handling.
   - Exclude environment/secret files from Docker build context and images.
   - Validate resulting domain documents and references before persistence.
   - Validate backup payloads before any upload or mutation.
   - Bind photo ownership/store association server-side and enforce atomic write-once storage.

2. Synchronization correctness
   - Freeze a persisted batch permanently before its first send attempt.
   - Retry the same ID only with the same payload; later edits get new IDs.
   - Preserve failed operations and uploads with actionable user-visible recovery.
   - Scope snapshots, outboxes, photos, and asynchronous work to a stable authenticated principal/session generation.
   - Prevent obsolete responses from repopulating state after identity changes or logout.
   - Correct snapshot/SSE buffer replay and serialize resync attempts.
   - Replace unsafe collection overwrites with ID-based operations or explicit versioned conflicts.
   - Make saved/pending/failed states reflect durable local persistence and server acceptance accurately.

3. Tournament correctness
   - Introduce server-authoritative start/finish/undo/reset commands with expected-version checks.
   - Enforce one active match per station and per player, valid participants/winners, valid station ranges, and legal downstream changes.
   - Define an explicit pending/conflict experience for offline match actions.
   - Prevent station reduction from hiding live matches.
   - Reject malformed/mixed pairing imports with line-specific errors.
   - Clear stale result scores and UI score drafts on undo/replay.
   - Preserve ordinary seeded bracket/byes behavior with regression tests.

4. Reports and evidence
   - Separate working drafts, queued submission, acknowledged submission, and review state.
   - Preserve submission revisions and the requirements used to assess them.
   - Verify a photo manifest before PDF/HTML/backup export; disclose incompleteness explicitly if the user chooses to proceed.
   - Fix empty/invalid speed acceptance, malformed Maps URL handling, and misleading photo provenance.
   - Fix incremental editing of comma-separated game settings.
   - Correct the claim that match results appear in the recce report; keep recce and match-day results distinct unless product requirements explicitly call for a combined report.

5. Operations
   - Establish trusted-proxy-aware rate limiting and server-enforced session expiration/revocation.
   - Add safe backup-import preview and acknowledgment, error recovery, and board data freshness.
   - Use explicit local/operational calendar-date handling rather than UTC truncation for date defaults.
   - Document single-instance deployment, persistent storage, and tested restore steps.

Do not silently decide major product policies. Identify and propose defaults for:
- Which readiness issues block play versus require HQ approval.
- Whether multiple games mean multiple competitions or only installation requirements.
- Double no-shows and disqualifications.
- Whether offline cold launch is required.
- Dedicated read-only venue-board access and evidence retention.
Continue independent bug fixes while those decisions are unresolved; do not invent a larger product scope.

Testing requirements:
- Add focused regression tests for each confirmed failure, using real production functions where practical.
- Include post-commit response loss, concurrent photo additions, simultaneous station calls, identity switching, reassignment during snapshot fetch, invalid schemas, rejected batches, missing evidence, and malformed imports/URLs.
- Test browser flows with synthetic HQ/admin identities in an isolated environment.
- Test mobile capture/upload and print separately; clearly state if device coverage is unavailable.
- Run type checking and production build after changes, plus the relevant tests. Do not claim checks that were not executed.
- Validate migrations against copies/synthetic fixtures, preserve existing records and pending work, and provide rollback guidance for schema changes.

Deliver:
- Root cause and before/after behavior for each fixed finding.
- Changed files and architecture decisions.
- Regression-test results and remaining risks.
- Data migration and rollout instructions where needed.
- Updated README claims that match actual guarantees.
- Remaining product decisions and deferred findings, without presenting them as completed.

Prioritize correctness, privacy, recoverability, and operational clarity over cosmetic redesign. Avoid broad unrelated refactoring and new infrastructure unless a demonstrated requirement justifies it.
```

## 10. Final assessment

The app has a useful core and a clear operating model. Its next improvement should be a stabilization pass centered on authoritative state transitions, immutable retries, user-scoped caches, validated evidence, and truthful submission/export states. Those changes will produce more practical value than adding more features to the current synchronization and reporting assumptions.
