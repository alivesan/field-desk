# Toornament Phase 2 — local feasibility toolkit

This package prepares owner-operated tests on approved single-elimination tournaments. The owner supplied Kochi as a testing tournament and explicitly authorized its current Alive De account. A 2–1 result, synthetic participant creation, forfeit and locked/unlocked reset behavior were observed there; see the evidence map for verification limits. It is not the production bot. No Field Desk queue, live result webhook or automatic organizer write is implemented. Steam OTP and both servers are unaffected.

## Current handoff

- [Feasibility findings and outstanding trials](FEASIBILITY.md)
- [Selector/URL evidence map](SELECTOR-MAP.md)
- [Proposed contract for Claude](JOB-CONTRACT.md)

Further tests require owner-confirmed tournament and stage IDs and organizer access. The local unit tests do not verify website behavior, session lifetime or safe pacing. The current Kochi approval covers testing on that tournament; it does not make the recorder safe to navigate anywhere else.

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

On this Codex Windows execution environment the Chromium download succeeded, but launching a visible Chromium from the protected terminal returned `spawn UNKNOWN`, including when a separate approved process was attempted. The owner ran `npm run login` from an interactive PowerShell, which saved the state. `npm run probe` then succeeded from a fresh headless process here. Run `npm run record` in your interactive PowerShell to use the visible recorder. Do not send the state file, cookies or password through chat. A full recorder trial has not yet passed.

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

After the evidence is collected, update the report with a decision per operation. Only then implement the queue consumer, verified website adapter and approved deployment. Any later VM pilot must measure Chromium memory/latency alongside n8n on the 1 GB host.
