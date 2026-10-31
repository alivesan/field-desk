# Changelog

## Unreleased

- **Toornament result jobs, HQ’s side (HQ only; the desk and field admins see none of it):** a store’s Toornament panel gets the switch **Send results to Toornament** (off by default; win/loss only, through Astra’s worker) with a one-line count (waiting / needs you / done today) and, when it is on, the matches that can’t be sent and why (“enter this one by hand”). A new **Toornament to-do** page (`#/toornament`, linked from HQ’s home once any store sends results, and from each store’s panel) lists the jobs by store — `M5 · #1.1.2.1`, “A beat B” / “wins by forfeit” / “Reset”, state, attempts, last code in plain words, time — needs-you first, refreshed every 15 s; for a job that needs a person: **Fixed on Toornament by hand** (→ done, `resolved-by-hq`) or **Try again** (→ pending, attempts back to 0, the worker reads Toornament before saving anything). Routes `GET /api/toornament/jobs[?storeId=]` and `POST /api/toornament/jobs/:id/resolve { action: "manual" | "retry" }`, HQ only.
- **Toornament result jobs, the worker’s routes (needs `FD_TOORNAMENT_JOBS_KEY`; nothing claims jobs until it is set):** `POST /api/v1/toornament/worker/v1/jobs/{claim,heartbeat,checkpoint,ack}` for the automation’s browser worker, with its own bearer key (scope `toornament-jobs:write`; the Steam key and sessions are refused there). A claim is atomic (one job per stage, oldest first, a match’s later revision waits for the earlier one, only stores with sync on), carries a 2-minute lease that heartbeats extend, and a lease that runs out puts the job back to waiting — or to “needs a person” if the worker had reached its pre-save checkpoint. A retry after a checkpoint is refused, and five attempts is the limit. History keeps codes and times only. Details in `docs/toornament-jobs.md`.
- **Toornament result jobs, the queue (off by default, nothing claims them yet):** with `store.toornament.sync = { on: true }` (HQ only; no switch on the page yet), finishing a match from a Toornament bracket queues a `match.result` (a win/loss, or a forfeit for a walkover) and undoing it a `match.reset`, in the same transaction as the command, in a new `toornament_jobs` table. A job is made only when the store has its tournament and stage, the bracket came from Toornament, the match has its Toornament number and both players their Toornament participant id — new `Player.toornamentId`, kept by `bracket.load` from Toornament (and by `players.set`); never for a bye. A new `bracket.load` or `bracket.reset` cancels the store’s waiting jobs. The store also remembers the tournament’s name (`toornament.tournamentName`). Design: `docs/toornament-jobs.md`.
- **Toornament match numbers on a bracket that’s already here** (`bracket.label`, HQ only): after **Fetch from Toornament**, a store whose matches lack Toornament’s numbers (loaded before they existed) or have different ones gets **Add Toornament match numbers** — also with matches under way, when the bracket can’t be loaded again. It sets only the number on each match, never players, slots or results, and is refused if Toornament’s bracket isn’t the same size as the one here. If Toornament’s first round differs from the one here, a hint says so (the numbers go by position). The queue, Up next, the Board, the Seeding tab, the winners banner and the “queued actions” notices now show `M5 · #1.1.2.1` too.
- **Edit a player from Players & bracket (HQ):** every player row gets **Edit** — a sheet with name, in-game name and number (prefilled, the number in full), sending only what changed as `players.edit`. A refusal (a name or number already on the list) shows in the sheet. It works before the bracket is built and while matches are under way (the list itself stays locked then, so there is no Remove); the bracket picks up a new name by itself. The form is the one the Check-in card already used.
- **The public bracket is always on:** every store now has its live bracket link (`/b/<token>`) without HQ pressing **Turn on** — the server gives one to each store that has none when it starts and to each new store (a link HQ turned off stays off). After a QR check-in, and when the player is already checked in, the check-in page shows **Follow the live bracket** (`GET /api/public/checkin/:token` gains `bracketPath`, only while the link is on); the bracket page says “The bracket isn’t out yet — this page updates by itself” until the draw is made. HQ’s **Public bracket** panel is reworded to match.
- **Toornament match numbers on every match:** a bracket loaded from Toornament (`bracket.load` gains `toornament`) remembers which Toornament match each Field Desk match is — its id and the organizer’s “Match #stage.group.round.match” (e.g. `#1.1.2.1`) — and shows it small and muted next to the M number on the Bracket cards, the match sheet, the Seeding tab and HQ’s store bracket (`M5 · #1.1.2.1`). It stays with the match when players are placed, swapped or a result is undone; byes Toornament doesn’t have, and hand-built brackets, have none.
- **Public live bracket** (`store.publicBracket`, HQ only): on a store’s Players & bracket page, **Public bracket** → **Turn on** makes a link and QR (`/b/<token>`, **Copy link**, **New link** stops the old one, **Turn off**). Players and the venue follow the bracket on a phone or a TV with no sign-in — round by round, results, **Live · Station N**, **Up next**, tap a name to follow that player’s path, a champion banner, **Fit** for big screens — refreshed every 15 s. It carries names, in-game names, scores and stations only: never phones, check-ins or winners’ details. `GET /api/public/bracket/:token`, rate limited per address.
- **Edit a player** (`players.edit`): tap a player in the Check-in list → **Edit** (HQ: name, in-game name, number — emptying the number removes it; a name or number already on the list is refused). A player with no number — say, imported from Toornament registrations — gets one at the desk with **Add number**, and the desk can set the in-game name; changing or removing a number that’s there, or renaming, stays with HQ. It works with or without a bracket and never changes the bracket. The desk still sees only the last 4 digits until the player is checked in.
- **Toornament import keeps the right “Rohit Rajan”:** a player registered as “Name (2)” (to give a number-less player one) now matches Toornament’s “Name” when Toornament has no “(2)” of its own — the one with the number is used, with their check-in, and is named as on Toornament; the number-less duplicate is dropped. Two different people with the same name on Toornament still match exactly, and with several equal candidates nothing is guessed.
- **HQ can type the winners by hand** (`winners.manual`, HQ only): for a store whose bracket ran elsewhere (Toornament). On the Winners page a store with no saved winners gets **Enter by hand** (**Edit** once typed) — a sheet with Winner and Runner-up blocks, each with an optional “pick from the player list”. Only the winner’s name is required; the runner-up may stay empty. The rows are tagged “Entered by HQ”, the CSV has a new last column **Source** (“By hand” / “Bracket”), and the desk can’t overwrite a hand-entered record with `winners.set`.
- **Match day on phones:** the Steam login is now a thin strip above the tabs — Steam ID, **Login details** (opens the ID, password and tips; remembered per store for the tab) and the Steam Guard code block always in view. The four numbers at the top fit on one row, and a free station with nothing to call is a single line instead of an empty card.
- **Seeding tab for HQ** on match day (after Queue; Bracket stays last): every first-round slot in bracket order with its player, seed, *(on-spot)* tag and check-in, a pencil to change it, **+ Free slot** on an empty one, and a lock on slots whose match is live or played. The picker offers players not in the bracket, players moved from another slot (the two swap places) and *Empty this slot*; players without a slot are listed below with **Place…**. Field Desk doesn’t change Toornament, so do it there too.
- `bracket.place` gains `swap`: a player who already has a first-round slot trades places with whoever (or nobody) is in the target slot. Both matches must be unplayed, neither may be left empty, and a started match downstream still refuses it.
- **“A new version of Field Desk is ready”:** a bar under the header with **Reload** appears when a newer version has been deployed (checked every 2 minutes and when you come back to the tab), so a phone that hasn’t reloaded stops running last night’s page.
- **On-spot closes for the desk once the bracket is out:** admins and store teams see "The bracket is out — on-spot registration is closed. Ask HQ if a player must be added." in place of the form, and the server refuses it too. HQ can still register a walk-in.
- **HQ can change a first-round slot** (`bracket.place`): tap a match on the Bracket tab (byes too) → **Change players** puts a player into an empty or unplayed first-round slot, swaps one, or empties it, before that match starts. A match left with one player becomes a bye and the player advances. Refused if the match, or the one it feeds, has started — undo that first. Field Desk doesn’t change Toornament, so do it there too.

- **Steam Guard, several PCs one after another:** an old code no longer blocks asking again. The card's button is now **Get code**; with a code on screen it also has **Logged in** (the code goes from every phone of the team) and **Check for new code** (a new look-up for the next email; the old code stays hidden).
- Each press is its own look-up and tells the e-mail automation (a double tap within 5 seconds is one; 20 in ten minutes is the limit). The automation hears when a look-up ends (`steam.otp.request.closed`), can send the `requestId` it answers, and is told in the answer whether the code is on the card.
- A code's own ten minutes are unchanged, and HQ's Steam page still shows every new code. Details in `docs/steam-otp-api.md`.
- **Steam accounts shared by several stores:** an account held by more than one store (several for downloads, or a play store and a download store) no longer stops its codes — the automation can deliver whenever any store holds it. Each store's card shows such a code only after that store's own **Get code**; a store that didn't ask never sees another's. `GET /api/v1/steam/accounts` gains `eligibleStoreIds` and `holders`, `POST …/otp` answers `eligibleStoreIds` and `displayedStoreIds`, and `steam.otp.requested` carries `eligibleStoreIds`.

- **Marketing** (HQ only, `#/marketing`, **Marketing** in the header): this weekend's and next weekend's campaigns, each with the **Discord post** (one message, a heading per day, with Copy) and a **WhatsApp promo per store** — caption, the store's poster, **Share poster + caption** (the phone's share sheet sends the picture with the text to WhatsApp), **Copy caption** and **Download poster**.
- Prize pool, reporting time, first match, the three promo texts and the Discord invite are typed once per campaign (empty boxes use a default text with the game name); a missing Toornament or Maps link, or poster, is flagged on the card and stays readable in the text as `[Toornament link missing]`.
- Stored as `event.marketing`, which admins and store teams never receive.
- **This weekend only:** next weekend's stores join on the Monday, once their links are in.
- **Fixed for the ROG Showdown:** ₹30,000 prize pool, reporting 11:00 AM, first match 12:30 PM. Empty boxes use these; type in a box only to change it for one campaign.
- **Players — the night before:** a third block with one message per store for its registered players. It gives the venue, date, reporting and first match times, the Maps link, the **bracket page** on Toornament (`/stages/`, not the registration page), the rules, and the store admin's name and phone, signed "Team La-eGamers". A Tekken campaign starts with the owner's Tekken 8 rules; another game's rules are typed once per campaign. A missing link, admin or phone is flagged on the card.

## 1.0.0-beta.6

- **Steam Guard codes, automated:** the e-mail automation posts each Steam Guard code to Field Desk (`POST /api/v1/steam/otp`, its own private key); the store team holding that account sees it on its Steam card in big type with a countdown (10 minutes from the e-mail) and a Copy button, and HQ sees it on the Steam page.
- **Request code** on the store's Steam card tells the automation to look for the e-mail now (signed webhook, once a minute per store). "Call HQ for the code" stays as the fallback.
- Off until the keys are set on the server; details in `docs/steam-otp-api.md`.

## 1.0.0-beta.5

- **Campaigns at a glance:** HQ home shows each campaign's stores for this weekend and next only (later ones are counted); the campaign page folds later weekends away like Done.
- **Toornament:** the bracket link now opens the tournament's stages page (where the bracket is), not the registration page the sheet gives.
- **Recce PDF:** address and venue pin once under the store name; Venue and Setup side by side; prints like the on-screen report, on desktop and phone, in 2 A4 pages.

## 1.0.0-beta.4

- **HQ home, campaigns first:** each campaign with its weekends and store chips at the top; Recce to do, This weekend and Recce reports below as shortcuts.
- **Recce reports box** shows only this and next weekend's reports still to review; approved ones move to their campaign page (which now lists every report).
- **Approve recce** (from the box or the report, with Undo): the store shows "Recce approved ✓" and its timeline ticks the step.
- **Event finished:** a store is finished once its winners are in, or HQ presses Mark event finished (Reopen undoes it). The store team sees "Event finished — thank you!".
- **Campaign complete** when every store is finished, or HQ closes it by hand.
- Campaign page groups stores by This weekend, Next weekend, Later and Done.

## 1.0.0-beta.3

- **Print files:** HQ pastes the weekly creatives sheet (a tab per date, a block of 5 Drive links per store) and presses Refresh; blocks are matched to the campaign's stores by name, city and date (fix any match by hand), then applied.
- Each store team gets a **Print files** page (from its home and the recce's Collateral step): Standee, A3 Poster, A5 Pamphlet, Winner and Runner-up cheques — each with a true-shape preview, print size and copies, **Save to phone** with a proper file name ("Subham Infotech - A3 Poster.jpg") and **Share** with a caption; **Send to print shop** (one WhatsApp message with every original-quality link) and a zip.
- **Print desk link** (no sign-in) for whoever handles printing: this week's stores, every file, a zip per store or everything.
- Print instructions per campaign (defaults: standee 6×3 ft ×1, A3 ×10, A5 ×100, cheques 2×1 ft ×1 each). HQ sees who saved which file.

## 1.0.0-beta.2

- **Store team links:** one sign-in link per store, shared by the whole store team (2–4 people). Each person types their name once, so history reads "Rhea (Nashik team)". New code / Turn off signs the old phones out. Named admins are optional now, for someone covering several stores.
- **Steam accounts:** HQ keeps the Steam accounts on a new Steam page and gives each store one for playing (one store per weekend; double-booking is refused) or for downloads during the recce (can be shared). The store team sees its Steam ID and password, the download/offline-play tips, and "call HQ for the OTP".
- **Desktop:** HQ pages use the full width (up to 1240 px); store rows on one line.
- **Store names:** the shared "ASUS ROG Exclusive Store —" prefix is shown once, each store by its own name.
- **Campaigns by weekend** on HQ home: This weekend, Upcoming (by weekend), Past.
- **On-spot registrations** only show once there are walk-ins.

## 1.0.0-beta.1 — first official beta

Field Desk is ready to run real in-store tournaments end to end. Beta means: the whole flow works and is tested, but it hasn't been through a live event yet — expect rough edges, report them, and avoid deploying during event hours.

**Before the day**
- Campaigns and stores, imported or refreshed from a Google Sheet (store, ROG Exclusive, city, state, Maps, Toornament link, date, admin).
- Field admins sign in with a personal 4-character link and see only their stores.
- Store recce with time- and GPS-stamped photo proof (venue → setup → laptops → internet → collateral), submitted as numbered revisions; HQ reviews, deletes or resets them.
- Players per store from a CSV, sheet link, paste, one at a time or Toornament; duplicate numbers/names ask "which one is it?"; in-game names kept.

**Event day**
- Match day opens for admins once HQ reviews the recce, or on the event date.
- Player QR check-in by phone number, desk check-in, and on-the-spot registration for walk-ins.
- Admins see a player's full number only after check-in, then can call them.
- HQ's on-spot list to copy walk-ins into Toornament; the server checks each store's Toornament stage every 5 minutes from 12:30 and loads the bracket once it's there.
- Server-authoritative bracket and station queue (one match per station and per player), tap a match to call / record / undo, a bracket legend, and the venue board.
- Winner and runner-up details collected at the desk after the final.

**After the event**
- HQ Winners page across all stores with a CSV export; reset tools for test data.

**Running it**
- Live on an Oracle Cloud Always Free server with automatic HTTPS; every merge to `main` is tested and deployed automatically.
