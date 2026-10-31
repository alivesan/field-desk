# Organizer selector and identifier evidence

Status: supervised UI feasibility, 31 October 2026. The owner supplied and approved Kochi tournament `2596029129977786367` for testing, including use of its existing Alive De organizer account. Result, participant, forfeit and reset actions were observed there. These are not Playwright recorder output or session persistence tests.

## Observed login page

Opening `https://organizer.toornament.com/` in a separate, signed-out browser navigated to `https://organizer.toornament.com/en_US/login/`. The accessibility view showed heading **Log in to your organizer account**, fields labelled **Email** and **Password**, and button **Log in**. No credentials were entered. This proves only the initial login form, not successful authentication, saved-session portability or the absence of later challenges.

## Owner-reported organizer controls — not yet independently verified

| Flow | Reported controls / URL | What the recording must establish |
| --- | --- | --- |
| Matches list | `https://organizer.toornament.com/…/tournaments/<tid>/matches/`; row `Match #S.G.R.N` | Exact locale/path; one unique row scoped by label; both participant names; stage/group/round/match numbering |
| Match detail | `…/matches/<id>/` | Real match ID, tournament ownership, relation to public bracket-node ID |
| Open result | Row menu or dialog: **Result** | Accessible menu/button names, dialog scope and stable role/label locators |
| Played result | Each side: **Score**, **W / D / L**; **Update** | Side-to-participant mapping, number-input labels, win/loss behavior and saved 2–1 result |
| Forfeit | Each side: **Forfeit**, then **Update** | Which side forfeits, required W/L selection, score treatment and persisted outcome |
| Reset | Unknown | Exact reset action, confirmation, cleared values and later-match lock behavior |
| Add participant | Unknown | Required fields, returned participant ID, duplicate-name behavior and distinction from bracket placement |

Do not invent executable selectors from this table. Record them on the approved test tournaments. A label shared by both score fields must be scoped to a verified participant section; `.first()`/`.nth()` is not proof of player identity.

## Observed Kochi organizer path and result

- Tournament overview: `https://organizer.toornament.com/toornament/tournaments/2596029129977786367/`. The Matches menu exposed `/matches/` and the Playoffs stage route `/stages/2602174454093946879/result`. The overview showed 17 participants and a 32-slot tournament; the stage bracket contained 19 matches.
- The Playoffs bracket exposed link **M 1.1 Surendar Rohit Rajan** to `/matches/2602174454244941769/`. The detail heading was **Match #1.1.1.1**, corresponding to stage 1, group 1, round 1, match 1. The next-round match **M 2.1** linked to `/matches/2602174454244941772/`.
- Public `bracket-nodes` IDs exactly matched both organizer match IDs. Before the write, both were pending. Node `2602174454244941772` referenced the first node as its second opponent's `sourceNode.id` and `sourceType: winner`.
- The match Result tab exposed the two participant names, per-side **Forfeit** checkbox, numeric **Score**, **W/D/L** radio labels and **Update** button. Stable observed input IDs were `match_edit_opponents_0_score`, `match_edit_opponents_1_score`, corresponding forfeit IDs and result radio IDs. Before using these indexes, the observed page matched side 0 to Surendar and side 1 to Rohit Rajan. Both player names must be checked again for each job; side indexes are not permanent player mappings.
- Filled side 0 with 2 and side 1 with 1. The radio `check()` action reported failure to reach checked state, so the visible **W** label for side 0 was clicked; inspection then showed side 0 W and side 1 L checked. **Update** returned **The update was successful**, Match completed, 2 and 1. A reload retained the values and outcomes.
- The immediate public read still showed pending, consistent with existing importer documentation's approximate two-minute cache. A later read at `2026-10-31T16:54:01.878Z` showed `completed`, `win`/`loss`, scores 2/1, and Surendar advanced into node `2602174454244941772`. No exact first-visibility delay was measured; do not report one.
- The organizer's match menu exposed **Result**, **Match locations**, **Videos**, **Streams** and **Settings**. The participant-create page exposed labelled **Player name**, **Player email**, optional **Custom user identifier**, Steam ID, Mobile Number, Discord ID, and **Create**. The first create attempt was stopped by automatic approval review before execution; a later attempt succeeded as recorded below.

## Further observed Kochi actions

- The temporary automatic review limit elapsed, and the participant action later executed. **Player name** was the only HTML-required text input. Creating `FD Automation Test 20261031` with custom user identifier `fielddesk:feasibility:20261031:participant-1`, no contact data, returned to the participant list showing **18 / 32 Players** (previously 17) and one matching row marked not checked in. Public participant ID `2602457851960137727` appeared exactly once; it appeared in zero existing bracket nodes. No duplicate retry was submitted.
- Match `2602174454244941766` was **Match #1.1.2.2**, side 0 Amaythedevil and side 1 Navya Lakshmi. Checking `#match_edit_opponents_1_forfeit` automatically checked side 0 **W** and disabled the other result choices; no score was entered. **Update** returned successful, **W/F**, Match completed. Public node later showed completed, Amaythedevil `result:win`, Navya `forfeit:true`, and null scores. Advancement was not checked separately.
- On first-round match `2602174454244941769`, clicking the link `data-role="outcome-picker-reset"` cleared both W/L radio selections locally; scores stayed 2/1 until each numeric input was emptied. **Update** changed Match completed to Match pending with blank outcome and score fields. Clearing W/L alone would leave the old scores, so the worker must clear both.
- After restoring the first-round 2–1 result, completing successor match `2602174454244941772` as Steve 1–0 Surendar made the first-round page display **Match locked**. Clearing the successor's outcome and both scores changed it to pending. Returning to the first-round page then showed **Match completed** instead of locked. Clearing that earlier result changed it to pending. Public readback at `2026-10-31T17:01:38.401Z` confirmed both nodes pending, null scores/results and the removed advancement. The separate forfeit and synthetic participant remained.

## Evidence to collect for each test

Keep private raw evidence in `automation/data/toornament/`, already ignored. Publish only sanitized findings here:

- Test alias (8-player or 16-player), browser/tool version, observation timestamp and dedicated-account confirmation.
- Verified organizer path template and role/label locator sequence, with expected element counts.
- Tournament/stage/node/match/participant relationships. Record equality or inequality explicitly; a similar number is not evidence.
- Before and desired outcome keyed by participant ID, organizer saved/reopened state, and public readback state.
- Time of save, organizer confirmation and first matching public observation. A public timeout is inconclusive, not proof the save failed.
- Any challenge or lock, and whether the action remains safe to retry. Never retain credentials, cookies, tokens or login recordings.

Run ordinary 2–1 wins in both participant orientations, duplicate names, bye paths and later-round matches. On separate disposable matches, test reset before and after a descendant is completed. Do not clear descendants automatically. Participant-add tests before/after bracket generation must report registration and placement separately.
