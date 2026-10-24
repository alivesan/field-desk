# Changelog

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
