# Toornament Phase 2 — browser worker prototype

This package contains the owner-operated feasibility tools and a browser worker prototype. The owner supplied Kochi as a testing tournament and explicitly authorized its current Alive De account. A 2–1 result, synthetic participant creation, forfeit and locked/unlocked reset behavior were observed there; see the evidence map for verification limits. The current worker runs against an **in-memory mock queue**; Field Desk has no matching queue API yet. Nothing has been deployed to either server, and Steam OTP is unaffected.

## Current handoff

- [Feasibility findings and outstanding trials](FEASIBILITY.md)
- [Selector/URL evidence map](SELECTOR-MAP.md)
- [Proposed queue contract for Claude](JOB-CONTRACT.md)

## What is implemented now

- `adapter.mjs` prepares result, forfeit and reset writes through the observed organizer form. It requires an exact tournament/stage allowlist, public node and organizer match ID mapping, label, both player IDs and names, previous result, and a durable pre-save checkpoint. It reopens the organizer form and waits for matching public readback. A mismatch or possible save with uncertain readback stops for review.
- `public-reader.mjs` reads the public tournament, stage, participant and bracket-node endpoints with page/size bounds. The public participant endpoint omits the organizer's custom user identifier, so `participant.add` is deliberately stopped before navigation until an identity-safe organizer readback is established.
- `queue.mjs` is a client and worker for the **proposed** Field Desk lease/heartbeat/checkpoint/ack API. `mock-queue.mjs` is an in-memory reference for local tests only. There is no production execution guard, runnable service or live Field Desk queue yet. No background browser worker is running on the VM.
- `npm test` runs the pure/local tests. On 31 October, the approved Kochi pending match and existing forfeit both passed read-only adapter reconciliation with the saved Playwright session. A full mock-queue claim → real browser/public readback → mock acknowledgment also returned `done` / `VERIFIED` on an already-pending match. Those checks did not click Update or Create.

The proposed queue needs structured score and exact mapping data from Field Desk; see [JOB-CONTRACT.md](JOB-CONTRACT.md). Do not set queue credentials or run live jobs until that contract, an exclusive execution guard, server capacity and website automation permission are resolved.

Further tests require owner-confirmed tournament and stage IDs and organizer access. The local unit tests do not verify session lifetime or safe pacing. The current Kochi approval covers testing on that tournament; it does not make the recorder safe to navigate anywhere else.

## Local Windows setup

Use Node 22+ and run these commands in `automation/toornament/`:

```powershell
npm ci
npx playwright install chromium
npm test
```

Dependencies and browser installation are local. Nothing is installed on the VM. The package and lockfile are independent of Field Desk's root package.

Create the private directory `automation/data/toornament/`. Restrict its Windows Security permissions to the owner and necessary system administrators; POSIX file modes alone do not enforce Windows ACLs. On Linux the directory must be 700 and credential files 600. This directory is excluded by the existing `automation/.gitignore`.

Inside that directory create `approved.local.json`, using the **confirmed throwaway** IDs as strings:

```json
{
  "tournamentId": "REPLACE_WITH_TEST_TOURNAMENT_ID",
  "stageId": "REPLACE_WITH_TEST_STAGE_ID",
  "approvedThrowaway": true,
  "manualRecorderAcknowledged": true
}
```

These placeholders intentionally fail validation. Approve one tournament/stage at a time, perform its tests, then explicitly update this private file for the other test tournament. Never use numeric JSON values for Toornament IDs: their size may exceed JavaScript's safe integer range.

## Sign in privately, then record

```powershell
npm run login
npm run probe
npm run inspect -- <approved-match-id>
npm run record
```

`login` opens a separate visible Chromium browser without recording actions. Enter credentials directly on Toornament and finish any normal verification yourself. Return to the terminal only after successful sign-in; pressing Enter saves private browser state. This does not prove that the session is valid or how long it lasts. It stores no password for automated re-login; VM re-login is deferred until feasibility is established.

`probe` starts a fresh headless Chromium process with the saved state and opens only the approved tournament. It prints whether access works, without showing cookies or credentials. The owner completed login locally; the first fresh-process probe succeeded on 31 October 2026. Session lifetime beyond this immediate check remains unknown.

`inspect` first confirms the exact match ID belongs to the approved public stage, then opens its organizer result page read-only using the saved session. It reports the heading and control counts only. The Kochi match `2602174454244941769` passed with two scores, two forfeit checkboxes and one Update button. This verifies Playwright can reach the form; it does not record a write.

On this Codex Windows execution environment the Chromium download succeeded, but launching a visible Chromium from the protected terminal returned `spawn UNKNOWN`, including when a separate approved process was attempted. The owner ran `npm run login` from an interactive PowerShell, which saved the state. `npm run probe` then succeeded from a fresh headless process here. Run `npm run record` in your interactive PowerShell to use the visible recorder. Do not send the state file, cookies or password through chat. The owner confirmed the recorder opened Kochi; no recorder-generated mutation was executed.

`record` loads that state into Playwright's recorder and opens the configured tournament. The owner confirmed on 31 October 2026 that it opened Kochi without a login prompt. **This is an owner-operated recorder, not an enforced browser sandbox: subsequent clicks can leave the approved tournament.** Stay inside the approved disposable tournament/stage. If a login screen appears, close the recorder and run `login` again. Typing credentials while recording can put them into the generated code; never do that.

Record add-participant, a 2–1 win, forfeit, clear-result and locked-reset flows separately. Record actual role/label locators, not guesses. Store raw generated recordings privately; manually extract only sanitized selectors and path templates into the evidence map. No generated recording is executed automatically.

## Public identity snapshots

```powershell
npm run snapshot -- test8-before.json
npm run snapshot -- test8-after.json
npm run compare -- test8-before.json test8-after.json test8-diff.json
```

These commands read the same public JSON family the existing app importer uses. They require exact configured tournament/stage membership, bounded pages/response sizes and complete reads; redirects are refused. Snapshot filenames are private, simple basenames, and new outputs cannot overwrite existing files. Console output contains counts, not credential values.

The snapshot tool is for identifier and placement comparisons. It does not establish that a bracket node is an organizer match, or verify a saved score. Record organizer and public result evidence separately during the real trial. Public API schema changes or delayed data are inconclusive, not permission to re-submit a write.

## Acceptance and boundaries

First verify the mapping without writes. Then use only the approved test fixtures for one mutation at a time, reopening the organizer match after saving and measuring public visibility separately. Test both score orientations, duplicate names, byes, later rounds, restart/session reuse and the two reset cases. Adding a registered participant is not permission to reseed or place them.

No pressure testing is included. Start serially and use the conservative proposed pacing in the feasibility report. A locked match, identity mismatch, uncertain save or login challenge ends that automated attempt; don't erase downstream results or blindly retry.

The queue consumer and adapter are now prototypes. A live pilot still requires Field Desk's durable queue, a process-level execution guard, an identity-safe path for participant creation, operator handling for uncertain jobs, and the remaining policy/session tests. Any later VM pilot must measure Chromium memory/latency alongside n8n on the 1 GB host.
