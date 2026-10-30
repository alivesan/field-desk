# Changelog

## Unreleased

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
