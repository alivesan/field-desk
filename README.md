# Field Desk

**Beta — 1.0.0-beta.3.** See [CHANGELOG.md](CHANGELOG.md).

Internal tool for in-store tournaments. HQ (the super admin) runs campaigns, stores, the team and every bracket; each store gets one **team link** that the 2–4 people working it share (it shows only that store and what's left to do), or a field admin who covers several stores gets a personal link; players check themselves in with a QR at the venue.

## Who does what

| | HQ (super admin) | Store team (2–4 people per store) | Field admin (optional, personal) | Player |
|---|---|---|---|---|
| Signs in at | `https://<host>/hq` with `SUPER_ADMIN_CODE` | the store's team link `https://<host>/K7Q2` (4 characters), shared by everyone there | their personal link `https://<host>/M4P9` | the venue QR → `https://<host>/c/<token>`, no account |
| Sees | every campaign, store, report, the team | only that store (and its campaign) | only the stores assigned to them (and those campaigns) | the store's name and their own first name + initial — nothing else |
| Does | campaigns, stores, team links, admins and codes; **players and brackets** per store (CSV upload, sheet link with Refresh, paste, or one at a time; build and reset); reviews recce reports | the same as a field admin, for that one store: the recce (photos, checks, submit); on match day: check-ins, calling matches to stations, results, undo, station count, opening QR check-in, walk-ins, winner details | the same, for each of their stores | types their phone number to check in |

The server enforces all of this — an admin's or a store team's device never receives other stores, other admins or any codes, and the server refuses any write outside the caller's scope.

## Store team links

Most stores have two to four people on the day, and a login per person (ten logins for five events) isn't needed: HQ gives each **store** one code.

- **Make it.** Campaign page → the store row → **Create team link** (or the **Store team links** list on the Team page, which shows every store of every campaign). It shows the 4-character code and the link (on `localhost` it uses the PC's Wi-Fi address). **Copy**, **Share** ("Field Desk link for <store> — open it on your phone: <link>"; the phone's share sheet, else WhatsApp), **New code** and **Turn off**.
- **Use it.** Everyone on the team opens the same link (or types the 4 characters on the sign-in page). The first time on a phone it asks **"What's your name?"** — kept on that phone, so the next link (after a new code) doesn't ask again; "change name" is in the page footer; signing out forgets it. Everything the team does is recorded as the person plus the team: **Rhea (San Infotech team)** — on walk-ins, winner details and recce submissions — so HQ can tell it was the store team and who. Until someone has typed a name it reads "San Infotech team". Each phone has its own name; two people on one code never overwrite each other.
- **Scope.** A team code signs a phone in as the principal `store:<id>`: it sees and may write exactly that store (and its campaign) — the same powers as a field admin assigned to it, no more. It never receives the code itself, other stores or the team list, and can't change the store's name, assignment or code. If a personal admin is also assigned to the store, both work.
- **Rotate or turn off.** A **new code** (even one with the same letters) or **Turn off** ends every session of that store at once — open pages sign out within a moment; the old link says it isn't valid any more. Work still queued on a signed-out phone is kept and sent after signing in again.
- **Uniqueness.** A code is unique across every admin's and every store's; HQ's screen picks a free one and the server refuses a batch that would repeat one ("access.code: is already used by another store" / "…by an admin"). Wrong store codes count in the same sign-in limits as admin codes (below).
- **Personal admins** (Team page → *Admins (optional)*) still work as before — useful for someone who covers several stores, or who should be named on every report. Assign stores to them from the campaign page. The player check-in endpoint only ever sets *that player's* check-in.

## Steam accounts

HQ keeps the Steam IDs it gives out in one list, and assigns each store one for its weekend — before the recce, since people ask HQ for the login. The store's team then sees which Steam ID and password to use, and how Steam lets several PCs share it.

- **The list** (HQ → **Steam** in the header, `#/steam`): a table with the name you gave it, the Steam ID, the password (dots until tapped, with Copy), email, notes and **where it's assigned** (store, campaign, date, *Play* or *Downloads*). **Add account** / **Edit** / **Delete**; a Steam ID can be listed once. Filter by **This weekend**, **Next weekend** or **All**: for a weekend each account says *Free* or *In use*, with the summary "5 free to play, 2 in use". An account that is still given to a store can't be deleted — the × next to each store unassigns it.
- **Assign it** (campaign page → the store row → **Assign Steam account**; the `SteamAssign` component): pick **Play** or **Downloads**, then the account. The list says per account who holds it that weekend — *Free*, *Playing at …* (downloads only), *Downloads at …*. **Change** and **Unassign** are on the row.
- **The rule.** One PC can be online with an account at a time, so a **Play** assignment is exclusive per **weekend**: two stores whose event dates fall in the same Saturday–Sunday can't both play with it. A weekend is the Saturday of the Monday–Sunday week the store's date falls in (an event on a weekday counts with its own week). HQ's screen refuses a second play — "Already playing at Incredible Technologies this weekend — assign it for downloads only, or pick another account" — and offers **Assign for downloads**. **Downloads** never clash: any number of stores, and a recce, can share one (many PCs can download at once). The rule lives in `src/lib/steam.ts` (`steamConflicts`); it is HQ's screen that enforces it, the server only checks that the account exists.
- **What the store team sees.** `SteamCard` (`store.steamLogin`): **Steam account for this store**, the Steam ID and password (tap to show, Copy), a badge — *For playing* / *For downloads only* — and the tips: *Downloading: many PCs can download at once with this account.* · *Playing: only one PC can be online with it at a time. To play on all PCs, start the game once online, then turn off Wi-Fi and play offline.* · *For the Steam Guard code (OTP), call HQ.* (Sending the code automatically comes later; for now the team phones HQ.)
- **Who gets what.** Accounts are an HQ-only kind of document (`accounts`): a field admin or store team never receives the list, and the server refuses their writes (403). The assignment (`store.steam`) is HQ's too. Each request, the server works out for the store's own team (and an admin assigned to the store) `store.steamLogin = { username, password, purpose, email? }` from the assigned account — never stored, never written — and drops `steam` (the account id) from their copy. A new password, a changed purpose or an unassign reaches the team's open pages at once (an account edit is sent to the teams of the stores that hold it, and to nobody else).
- **Security.** Passwords are stored in the server database as typed (not hashed — HQ and the team need to read them), shown to HQ, and to the team of the one store an account is given to. They are in the database file, in server backups (`node server/backup.ts`) and in the JSON "Export backup" from HQ's home page: keep those private. Use accounts made for this, not anyone's personal Steam account.

## Print files

Each week HQ gets one Google Sheet of creatives, and replaces its tabs for the new week. Field Desk reads it, gives every store its five files under proper names, and lets the person at the print shop download everything from one link.

- **The sheet.** One tab per event date, named like `31-Oct` / `01 Nov` / `31/10` (the year comes from the campaign). In a tab, a block per store: a row with the store's name in column A (column B empty), then `standee`, `Poster`, `Pamphlet` and two `Cheque` rows with the Drive link in column B — the link may be the cell's text or a hyperlink on it (`https://drive.google.com/file/d/<id>/view?usp=drive_link` or `…=sharing`; `open?id=` and `uc?id=` work too). Blank rows between blocks. Store names can be informal ("Shubham info Bhubneshwar", "laptop hub byderabad"): they are matched to the campaign's stores word by word, forgiving a typo or two, and by the tab's date (a chain with two stores in one city is told apart by the day). Two stores that fit equally well are left for HQ to pick.
- **Reading it.** `GET /api/print/sheet?url=<sheet link>` (HQ only) exports the sheet as .xlsx from Google (`docs.google.com`, the same SSRF protection as the roster link: https, port 443, every redirect hop's address checked, host-locked to Google, ≤ 5 MB), reads it with node built-ins only (`server/zip.ts`, `server/xlsx.ts`), looks up each distinct Drive file's real name from its public page title (cached for an hour) and returns tabs → blocks → files plus problems per block ("No poster link", "Poster: That’s a folder — each file needs its own link", "Only one cheque link…"). The sheet must be shared **"Anyone with the link"** (or published to the web); a private one answers "That sheet isn’t public".
- **The two cheques.** The Drive names end `…Cheque-C.jpg` (champion = winner) and `…Cheque-R.jpg` (runner-up); when the names say so they decide, otherwise the first cheque row is the winner's and the second the runner-up's. Most ROG stores share the same two cheque files; third-party stores (Vijay Sales…) have their own.
- **Refresh = this week.** HQ's **Refresh** stores each matched block on its store as `store.print` (the files, the tab, the label as written, `importedAt`) and stamps `event.printSheet.importedAt`. A store whose kit has that same stamp is on **this week's** list; last week's kits stay on their stores but drop off the print desk. The sheet link is remembered on the campaign (`event.printSheet`, HQ-only, never sent to admins).
- **Store team.** The store's team (or its admin) sees `store.print`, the campaign's print instructions (`event.printSpec`: size and copies per file, defaults in `src/lib/print.ts`) and downloads: `GET /api/print/file/:storeId/:kind` streams the file from Google Drive (`drive.usercontent.google.com`, ≤ 300 MB, timeouts, Drive's "can't scan for viruses" page followed) as `Content-Disposition: attachment; filename*=UTF-8''Subham Infotech - A3 Poster.jpg` (`?inline=1` previews images and PDFs; anything else is always sent as a download); `GET /api/print/zip/:storeId` is the five files in one zip (stored entries with data descriptors, streamed — nothing is held in memory; a file Drive won't hand over becomes "… - COULD NOT DOWNLOAD.txt" in the zip, and a store with nothing downloadable is an error). Only a store's own team / admins and HQ may download a store's files. The server records nothing on download: the screen writes `store.printDownloads[kind] = { at, by }`, the one print field a team may write (`print`, `printSheet`, `printDesk`, `printSpec` are HQ's). At most 8 downloads stream at once; the rest are told to try again.
- **Print desk (no sign-in).** HQ makes a link `https://<host>/p/<token>` (`event.printDesk.token`, 16+ random characters; a new token stops the old link; HQ-only, never sent to admins). `GET /api/public/print/:token` answers `{ campaign: { id, name }, stores: [{ id, name, city, date, files: [{ kind, label, size, qty, driveId }], downloaded: [kind] }] }` — this week's stores only, and nothing else about them (no players, phones, Steam logins, codes, addresses). `/file/:storeId/:kind`, `/zip/:storeId` and `/zip` (every store of the week, a folder each: `<short name>/<file name>`) download. Like the QR check-in it is rate limited per address (120 requests / 10 min; a wrong token costs 10; 429 + `Retry-After`), and the token never reaches the log.
- **Drive sharing.** Every file must be shared **"Anyone with the link"**; otherwise Google asks for a sign-in and the download says to share it. A file that is really an HTML page can't be downloaded.

## HQ screens on a big display

- **Width.** HQ's pages (home, campaign, players & bracket, winners, team, match day) use up to 1240 px on a desktop screen; phones and anything narrower than ~880 px are laid out as before. A page asks for the wide column with a hidden `<i class="hq-wide">` marker (the shell's width is a CSS variable, `--page-max`, in `base.css`).
- **Store names.** Stores are entered as "ASUS ROG Exclusive Store — Incredible Technologies"; screens lead with the short name ("Incredible Technologies") and say the shared part once (`src/lib/names.ts`: the known prefix, plus any leading part every store of the campaign shares). Stored names are never changed; CSVs and reports keep the full name.
- **Campaigns on HQ's home** are grouped by their stores' dates (`src/lib/weekends.ts`): **This weekend** (Sat–Sun of the current Mon–Sun week, plus today or what is left of the week when an event is on a weekday), **Upcoming** under each weekend ("Sat 31 Oct – Sun 1 Nov"), then **Past**. A campaign spanning several weekends is listed once, where its next store date falls, with every event day and the cities playing.

## Campaign flow

1. **HQ** creates the campaign, admins (Team page) and stores (one by one, or all at once from a sheet — see *Stores from a sheet*: name, ROG Exclusive, city, state, Google Maps link, Toornament link, date, admin).
2. **Recce** (admin, days before): venue, setup (what is in place when you walk in), laptops (each game *Installed* + *Launched*, drivers, Windows), internet (in-app speed test or typed figures + screenshot), collateral — each with time/GPS-stamped photo proof. **Submit** creates a numbered revision; HQ sees it in **Recce reports** (New until opened), views exactly what was submitted against the requirements of that moment, marks it reviewed, and can save it as PDF/HTML. Later edits show as "edited since rev N" until resubmitted.
   - **Match day opens for the admin when HQ marks the recce reviewed** — or automatically on the store's event date (and after), so a forgotten review never blocks a tournament. Until then the admin sees only the recce ("Sent — waiting for HQ to check it"), and the match-day / venue-board links show a short "not open yet" page. Editing the recce after review keeps it open; HQ is never gated.
3. **Players & bracket** (HQ, per store): on the campaign page each store row has **Players & bracket**, two steps:
   - **01 Players** — upload a CSV, link a published sheet (Refresh pulls the latest), paste, or add one player at a time; remove one or all. Same number or same name twice → HQ is asked *"which one is it?"* (keep one, or both). The list order is the seed order: the file's row order, or its Seed column if it has one (seed 1 is the strongest; top seeds get the byes).
   - **02 Bracket** — first-round preview, **Create bracket** (stations set here), see it, **Reset bracket**. Reset clears results and live matches only; players (in their order) and check-ins stay.

   Changing the players clears a bracket that hasn't started; once matches are under way they're locked until HQ resets. "Are you sure?" questions (remove all, replace a roster, reset…) are asked in the page, not with the browser's own pop-up, which some embedded browsers block. One file for several stores (matched by a Store/City column) is under **One player file for several stores** on the campaign page.
4. **Match day** (admin): open **QR check-in**; players scan and type their number; the admin sees "Aarav S. checked in by QR" and can undo. The queue says which match to call to which station; the server guarantees one match per station and per player. The dark **venue board** shows now playing / up next / the check-in QR and how fresh its data is.

## Player lists (HQ)

Store row → **Players & bracket** → 01 Players (or campaign page → **One player file for several stores**). Sources: **Upload CSV**, **Sheet link** (Google Sheets shared "Anyone with the link" or "Published to the web"; **Refresh** re-pulls it and shows what changed before loading), or **Paste** (cells copied straight from a sheet work). Scope: the whole campaign (rows matched to stores by a Store or City column) or one store. On one store's page a Store column only filters out rows for the campaign's other stores; if it names no campaign store at all, every row is that store's.

| Column | Headers recognised (any case/spacing) |
|---|---|
| **Name** — required | Name, Player, Player Name, Full Name, Participant, Entrant — or First Name + Last Name |
| **Phone** — needed for QR check-in | Phone, Mobile, Mobile Number, Contact, WhatsApp, Number, Cell, Telephone |
| **Store** | Store, Store Name, Venue, Location, Outlet, Branch, Shop — "San Infotech" matches "ASUS ROG Exclusive Store — San Infotech" |
| **City** | City, Town |
| **Seed** | Seed, Seeding, Rank, Ranking (none → sheet order); this is the bracket's seed order |
| **IGN** (in-game name) — optional | IGN, In-game name, Gamertag, Game ID, Game Name, Username, Nickname, Handle, Riot ID, Steam name / ID, Epic name, BattleTag, PSN ID — up to 40 characters, kept on the player and shown next to the name for HQ and admins (store list, check-in list and search, station cards). Never on the public QR page. With no Name column, a lone IGN / Username column is used as the names |
| *Not kept* | Email, Discord and any other column — not read, not stored; the preview lists them as "Not kept" |

Comma, semicolon or tab separated; UTF-8, Excel's UTF-16 "Unicode Text" or Windows-1252; other columns (Email, Discord…) are ignored; any phone format (`+91 98200 11111`, `098200-11111`). Excel's `9.82E+09` is caught with a "format the column as text" hint. Rows that can't be matched and bad phones are listed by row number and block that store until fixed. A repeated row (same name and number) is kept once; the same number on two names, or the same name on two numbers, is a question HQ answers before loading ("Both" on a shared number means those players check in at the desk, not by QR). Player ids come from the phone (or name) — never the IGN — so re-importing keeps check-ins, and a re-import where only IGNs changed shows as "N in-game names changed"; a store whose matches are under way is never replaced.

## Stores from a sheet (HQ)

Campaign page → **Import from a sheet**. One row per store, so nobody has to add stores one by one. Sources: **Upload CSV**, **Sheet link** (Google Sheets shared "Anyone with the link" or File → Share → **Publish to the web**; the link is remembered on the campaign and **Refresh** re-pulls it), or **Paste** cells copied from a sheet. The preview says per row **New**, **Changed** (with each field's old → new), **Unchanged** or **Fix the row**; nothing is written until **Apply**. **Download a template** gives the headers.

| Column | Headers recognised (any case/spacing) |
|---|---|
| **Store name** — required | Store name, Store, Name, Outlet, Venue |
| **ROG Exclusive** | ROG Exclusive, Exclusive, Store type, Type — Yes / No / True / 1 / "Exclusive" / "ROG Exclusive Store" are yes; "Multi-brand", "Non-exclusive" are no |
| **City** | City, Town, Location |
| **State** | State, Province |
| **Google Maps link** | Google Maps, Maps, Map, Location link, Maps URL — coordinates are read from it (short `maps.app.goo.gl` links are expanded by the server) so photo distance checks work |
| **Toornament link** | Toornament, Bracket link, Tournament link — a toornament.com tournament link |
| **Date** | Date, Tournament date — `24/10/2026`, `24-10-26`, `2026-10-24`, `24 Oct 2026`, `Sat, 24th October 2026` or an Excel date number; day first. No date → the campaign's date |
| Address, Phone, Venue spot — optional | Address; Phone, Mobile, Contact; Venue spot |
| Admin — optional | Admin, Field admin, Assigned to — a name from Team (case-insensitive; "Rahul" works if only one admin has that word). An unknown name is a warning: the store is left without an admin |

**Rules.** A store is found again by its **name** (case, spacing and the "ASUS ROG Exclusive Store — " prefix ignored: "San Infotech" is "ASUS ROG Exclusive Store — San Infotech"), so importing the same sheet again updates instead of duplicating. The name is the key and is never changed by an import. Two stores with one name (a chain in several cities) are told apart by **City**. A blank cell (or "-", "n/a") never erases what a store has. A store that isn't in the sheet is never changed or deleted — it is only listed as "not in the sheet". A row with a bad date, a Maps link that isn't a link, a Toornament link that isn't Toornament's, a missing name or the same store twice is skipped with the reason and its row number; the other rows still apply. Apply is one local edit (synced like any other store edit), so a store the import creates behaves exactly like one added by hand. In a CSV, a Maps link has commas in it, so the sheet's CSV export (which quotes it) is fine but a hand-typed CSV needs the link in quotes; pasting cells from a sheet needs nothing.

## Brackets from Toornament (HQ)

Each store can carry its Toornament link (store details, or pasted on the store's bracket step): `https://play.toornament.com/en_US/tournaments/<id>/` — a `…/stages/<id>/` link picks that stage. **Fetch from Toornament** shows the stages, the players (matched to the store's list by name, ignoring case and spacing, then by IGN since Toornament names are often gamertags — matched players keep their phone, IGN and check-in; new ones come without a phone) and Toornament's first-round pairings; **Use this bracket** replaces the store's players and bracket in one step (refused once matches are under way). The tournament must be public. Toornament's pages are JavaScript-only, so the server reads the public JSON those pages use (`play.toornament.com/api/…`, no key); if Toornament changes it, fetching stops working with a plain error and the other player sources still work.

- **Single elimination only.** Double elimination, groups, leagues, Swiss and free-for-all stages are named and refused.
- Byes come across as byes. A first-round match with nobody in it (stage bigger than its field) can't be held here: set the stage size on Toornament, or use the players as a seeded list.
- Results and the 3rd-place match aren't copied; the bracket starts fresh and is run here.

## Toornament auto-check (the server)

Walk-ins register until about 12:30–1 pm; HQ then adds them on Toornament and Toornament publishes the bracket. So nobody has to press **Fetch from Toornament** → **Use this bracket** at every store, the **server** does it (it works with nobody signed in):

- **When.** Stores with a Toornament link, switched on (default on), on **their own day** (the store's date, else the campaign's), in **India time** (`EVENT_TZ`, default `Asia/Kolkata`): from **12:30** — the campaign page → *Campaign settings* → *Check Toornament for the bracket from* changes it — every **5 minutes**, until it succeeds or the day ends (midnight). One store at a time with a short pause between stores; a 429 from Toornament pauses everyone for 10, 20, 30 minutes.
- **What counts as "the bracket is there".** A **single-elimination** stage whose players are **placed** in Toornament's first round (not the "registered only → seeded list" fallback), with no empty first-round match. No bracket generated → *waiting*; a bracket but nobody (or one player) placed, or an empty slot → *not-placed*; a stage that can't be used (double elimination, groups…) or Toornament not answering → *error* (tried again in 5 minutes).
- **What it does.** The same `bracket.load` as **Use this bracket** (players matched to the store's list keep phone, in-game name and check-in; walk-ins not on Toornament yet stay on the list outside the bracket; others not on Toornament are removed), committed as the system actor *Toornament auto-check* through the normal command path — one version bump, versions, dedupe and live updates as usual. The load and its record are one commit. Then it **stops** for that store for the day.
- **What it never does.** Replace a bracket **under way** (any real match called or played) — *skipped-underway*, or one **built by hand** (anything not built by a Toornament load, which the store remembers by the load's id) — *skipped-manual*; both end the day's checking. A bracket from an earlier Toornament load that hasn't started *may* be replaced. If HQ already pressed **Use this bracket** that day and nothing was touched since, it just stops ("Loaded by HQ").
- **Status for HQ** (`store.toornament.auto`, written by the server, shown on the store's *Players & bracket → 02 Bracket*): "Auto-check: on — from 12:30 on 24 Oct, every 5 min · last checked 12:45: no bracket on Toornament yet", then "Applied automatically at 12:50 ✓". The tick box switches it off for that store (changing the link keeps it off); **Check again** (after it applied or stopped) clears the day's result so it looks again. Field admins can't write any of it.
- **Settings.** `TOORNAMENT_AUTO=0` turns it off for the whole server; `EVENT_TZ` sets the zone. The dev server (`npm run dev`) doesn't run it unless `TOORNAMENT_AUTO=1`. Logs: one `toornament-auto` line per check (store id and result, never the link).
- **Not done for you:** marking walk-ins as *added to Toornament* (HQ is still offered that), and results are never copied.

## On-spot registrations (walk-ins)

- **At the desk** (admin, match day): a player who isn't on HQ's list is added on the spot (name, phone, optional in-game name). They join the store's players already checked in, and the registration is recorded as **on-spot** (when, by which admin). It never touches the bracket.
- **HQ sees them** in **On-spot registrations** (a section that only appears once somebody has been registered — on the campaign page when any of its stores has a walk-in, on a store's page when that store has) — on the campaign page (every store, grouped by store; each store row also shows "2 on-spot to add"; the campaign on HQ's home page says so too) and on the store's **Players & bracket → 01 Players** (that store only; the walk-ins carry an **On spot** tag in the player list). Tabs: **To add to Toornament** (default) / **Added** / **All**. Each row: name, IGN, full phone, time, admin, checked in, and **In bracket** / **Not in bracket yet**.
- **The Toornament round trip**: **Copy names** (one per line, for Toornament's participant add; **Copy in-game names** uses the IGN where given) or **Download CSV** (Name, Phone, In-game name, Store, Registered at, By, Added to Toornament) → add them on Toornament → tick **Added to Toornament** per player (or **Mark all as added**; **Undo** to clear) → Players & bracket → Bracket → **Refresh** from Toornament. Walk-ins match by name or IGN and keep their phone, IGN and check-in; once the bracket is used, HQ is offered **Mark N as added to Toornament** for any not ticked yet. **In bracket** is the proof.
- **Not lost when HQ replaces the list**: a CSV / sheet / paste load keeps walk-ins who aren't in the file (after the file's players, check-in kept) and says so in the preview, with **Drop them** as the choice; a walk-in who is in the file is the file's row (same phone + name → same player, check-in kept). A Toornament bracket that doesn't have a walk-in yet names them in the preview ("aren't on Toornament yet — add them there first, then Refresh"); using it anyway takes them off the player list for now (a bracket here holds only Toornament's players), and the Refresh after they're added brings them back with phone and IGN. The registration itself is never removed, so the list keeps showing who still has to go into Toornament.

## Deleting test data (HQ)

- **On-spot registrations**: a **×** per row and **Remove all (N)** per store (`onspot.remove`, HQ only, one atomic command). It removes the registration record only — the player stays on the list (and checked in) so a real walk-in isn't lost; tick **Also take them off the player list** to remove those players (and their check-in) too, which is refused once matches are under way (a bracket that had them is cleared, like any roster change).
- **Recce reports**: **Delete** in the inbox row, or on the report page's **Delete test data** area at the bottom: **Delete rev N** (`recce.delete`: that revision only, the admin's working recce stays) and **Reset recce for this store** (`recce.reset`: every revision gone and the working recce blank, so the admin does it again). Photo files are write-once and stay on the server, just unreferenced. Revision numbers keep counting up past the highest one left. Admins get 403 for all three.

## Winners (match day)

When the final is recorded, the match-day page (Queue and Bracket tabs) shows **🏆 Champion: <name>**, the runner-up, and the next step: **Collect winner details**. The admin's home card shows the same as its main button (until both real names and phones are saved), then **Winners: details saved ✓**.

- **The form** (a sheet; full-screen-friendly on a phone) has a **Winner** and a **Runner-up** block: real name, in-game name and phone start from the player list (the admin corrects them), plus email and Instagram (typed; `@handle`, `handle` or an `instagram.com/handle` link all become the bare handle). Each block says what is still missing. Saving again edits; the card shows "Saved 7:42 PM by Rhea".
- **Server rules** (`winners.set`, admin for their own stores or HQ): refused until the final is done ("Record the final first"). *Who* won and lost is read from the final, never from the request. Real name ≤ 100 characters (empty = not given yet); phone 8–15 digits; email `x@y.z`, lower-cased; Instagram letters, digits, `.` and `_`, ≤ 30 — a bad field is refused with a plain message ("Winner’s email doesn’t look right"). The first save time is kept; every save records when and by whom.
- **Never lost**: `day.winners` is command-only (batches get 403) and survives **Reset bracket**, rebuilding, a new player list and backup import. If the final is later undone or won by someone else, the card (and HQ's list) warns that the saved details no longer match the bracket, and the admin collects them again for the new pair. The venue board shows the champion and runner-up by name only — contact details never leave the admin and HQ screens.

## Winners (HQ)

**Winners** in the header (HQ only; `#/winners`, a field admin gets "Nothing here") lists every store's winner and runner-up with the date of the event, grouped by campaign. The campaign page has a **Winners** strip ("3 of 5 stores have a winner · 2 with full details") with **View** (`#/winners/<campaign id>`, the same page filtered to that campaign) and **Download CSV**.

- **The page**: campaign filter, status filter (with counts), then a card per store — city, state, event date, links to **Players & bracket** and **Match day**, and a Winner and a Runner-up block: real name, in-game name, phone (`tel:`), email (`mailto:`), Instagram (link), who saved it and when. Stores without a final just say "Final not played yet".
- **Reset winner details** (HQ only; a button on each store's card that has saved details, and a link under the bracket on the store's **Players & bracket** page) asks first, then clears that store's saved winner and runner-up details (`winners.clear`). The bracket, players and check-ins are untouched; once the final is done the admin sees **Collect winner details** again.
- **Statuses** (per person; who won is always read from the bracket's final): **Complete** (real name, phone, email and Instagram saved; the in-game name is optional) · **Partial** (says what is missing) · **No details saved** (the final is done but the admin hasn't saved anything — the name, phone and in-game name from the player list are shown so HQ still sees who won) · **Final not played** (no bracket, or not finished) · **To check** (the details were saved for a different final than the bracket has now — HQ reset or replayed the bracket; they're shown but flagged, never trusted).
- **Download CSV** (UTF-8 with BOM, so Excel reads it right; `winners-<campaign|all>-<yyyy-mm-dd>.csv`) is what's on screen: the chosen campaign (or all), and with a status filter on, those stores, winner and runner-up each. One line per store per place, stores without a final included (Status says "Final not played") so the list doubles as a checklist. Columns: Campaign, Store, City, State, Event date (yyyy-mm-dd), Place, Real name, In-game name, Phone, Email, Instagram (@handle), Status, Saved at, Saved by. Instagram is the bare handle (a leading `@` is a formula marker to a spreadsheet); other cells starting with `= + - @` get a leading apostrophe.

## QR check-in (match day)

The admin opens **Player QR check-in** on the match-day page; the QR is also on the venue board. A player scans it, types their phone number, and sees "You're checked in, Asha R." — the admin sees a "checked in by QR" notice with Undo, and a **Self** badge in the list. Closing it (or **New QR**, which kills the old link) stops it immediately. The page shows only the store name and the player's own first name + initial; nothing is stored on the player's phone. Rate limits: per address (wrong numbers cost more) and per store.

## Guarantees (and their limits)

- **Edits are kept on the device until the server accepts them.** They're stored in the browser's IndexedDB outbox before they're sent; a retry after a lost response is byte-identical and applied once. If the device can't store them (storage full or blocked), the header says **Storage problem** instead of pretending.
- **Rejected work is never silently dropped.** The header shows "N need attention"; the panel lists the reason (no permission, invalid, conflict, photo too large…) with Retry / Discard / Export.
- **Concurrent edits merge by item, not by position** (two phones adding photos keep both). Tournament actions are **server commands**: two devices calling different matches to station 1 → one succeeds, the other is told why.
- **Per-person storage.** Signing in as someone else on the same device never shows the previous person's data or sends their queued work; it waits for them. Signing out wipes that person's copy.
- **Photos** are owned by the store they were uploaded for; knowing a photo id doesn't grant access. They're write-once and kept on the server even when removed from a recce.
- **Evidence exports** check every expected photo first; an export with missing photos is clearly marked incomplete.
- **Photo proof is advisory, not forensic**: the app records capture/upload time and how location was measured, and flags old files, poor GPS, unknown or provisional venue pins.
- **Not offline-launchable**: a page that's already open keeps working with no signal; opening the app from scratch needs a connection (no service worker — open product decision).

## Run locally

```bash
npm install
npm run dev          # app + API on http://localhost:5173 (data in .data/)
npm run dev:phone    # same over HTTPS on your LAN, for phone camera + GPS
npm test             # unit + integration tests (real API on temp dirs)
npm run typecheck
```

There is no open mode. On first run a random HQ code is generated into `.env.local` (git- and Docker-ignored) — sign in at `/hq` with it.

**Isolated instance for testing** (throwaway data, synthetic HQ code, separate cookie): `node scripts/isolated-dev.mjs [--fresh]` → `http://localhost:5174`; the code is written next to its temp data dir.

## Run from this PC (HQ on the PC, admins on phones)

Your real data (`.data/`) and HQ code (`.env.local`) are the same as `npm run dev`. Stop `npm run dev` first — one server per data folder.

```bash
npm run pc               # builds, then serves on http://localhost:8080 and this PC's Wi-Fi address
npm run pc -- --tunnel   # same, for use behind a Cloudflare quick tunnel
```

- **Phone on the same Wi-Fi** (testing at home): `npm run dev:phone` and open the `https://192.168.x.x:5173` address it prints on the phone; accept the certificate warning once. HQ's home page on the PC shows that address (with a QR), and admin links / check-in QR codes made on the PC at `localhost` already use it instead of `localhost`. HTTPS is needed for the phone's GPS (recce). Allow Node through Windows Firewall on *private* networks when asked.
- **Phone at a store on mobile data**: the PC must be reachable from the internet. Free route: [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) — run `npm run pc -- --tunnel`, then `cloudflared tunnel --url http://localhost:8080`; it prints an `https://….trycloudflare.com` address (new each time it starts). The PC must stay on, awake and online.

## Run for real

One server process per data directory (it takes `DATA_DIR/.lock`; sync state lives in that process). Put it behind HTTPS on a host with **persistent storage**.

```bash
npm run build
SUPER_ADMIN_CODE=<long secret> PORT=8080 DATA_DIR=./data npm start
```

Docker (two-stage build, explicit copies only, runs as the `node` user — a bind-mounted `/data` must be writable by uid 1000):

```bash
docker build -t field-desk .
docker run -p 8080:8080 -e SUPER_ADMIN_CODE=<long secret> -v field-desk-data:/data field-desk
```

| Variable | Default | |
|---|---|---|
| `SUPER_ADMIN_CODE` | — (required) | HQ sign-in; 16+ characters. Changing it signs HQ out everywhere. |
| `DATA_DIR` / `PORT` / `DIST_DIR` | `data` / `8080` / `dist` | |
| `TRUST_PROXY` | `0` | Number of trusted reverse proxies in front. `0` ignores `X-Forwarded-For` (otherwise anyone could fake their address). Set to `1` behind one proxy (Caddy, Fly, Render…) so rate limits see real client addresses. |
| `SESSION_DAYS_ADMIN` / `SESSION_DAYS_SUPER` | `30` / `7` | Sessions expire server-side (store teams count as admins); sign-out revokes; a new admin code revokes that admin's sessions, a new store team code that store's. |
| `MAX_PHOTO_MB` / `MAX_PHOTOS_PER_STORE` | `15` / `500` | |
| `COOKIE_NAME` | `fd_session` | |
| `TOORNAMENT_AUTO` / `EVENT_TZ` | on / `Asia/Kolkata` | The Toornament auto-check (above): `0` switches it off; the zone the store's day and the 12:30 start are read in. |

Sign-in rate limits: 10 wrong codes per address per 15 min (separately for admin / store team codes and HQ), plus a global ceiling of 300 wrong admin or store codes per hour that never blocks HQ. 429 responses carry `Retry-After`.

### Free server: Oracle Cloud Always Free (or any Ubuntu VPS)

`deploy/` has everything: Docker Compose with the app and [Caddy](https://caddyserver.com) for automatic HTTPS. No domain is needed — it uses the free `<ip-with-dashes>.sslip.io` name for the server's IP (a real domain works too).

1. **Oracle console:** create an Ubuntu instance (Ampere A1 or the AMD micro shape), keep the SSH key it gives you, and note the public IP. Then Networking → Virtual cloud networks → your VCN → Security List → **add ingress rules for TCP 80 and 443** from `0.0.0.0/0`.
2. **Copy the code to the server** (the repo is private, so from your PC): `git archive HEAD | ssh -i <key> ubuntu@<ip> "mkdir -p field-desk && tar -x -C field-desk"`.
3. **On the server:** `cd field-desk && sudo bash deploy/setup.sh` (or `sudo bash deploy/setup.sh your.domain`). It installs Docker, opens the machine's own firewall for 80/443, creates `deploy/.env` with a new HQ code (`sudo grep SUPER_ADMIN_CODE deploy/.env`), and starts everything.
4. Open `https://<ip-with-dashes>.sslip.io/hq`.

**Update:** copy the new code the same way, then `cd deploy && sudo docker compose up -d --build`. Data lives in the `field-desk-data` Docker volume and survives updates. **Move your PC data there:** home page → Export backup on the PC, then Import on the server.

## Backups and restore

```bash
node server/backup.ts <dataDir> <outDir>                 # consistent DB snapshot + photos + manifest (safe while running)
node server/backup.ts --verify <backupDir>               # counts + sha256 against the manifest
node server/backup.ts --restore <backupDir> <emptyDir>   # verify, then restore into a new data dir
```

Restore = stop the server, restore into an empty directory, point `DATA_DIR` at it, start. This round trip is covered by `tests/server-ops.test.ts`. A backup contains admin codes, session hashes and the Steam accounts' passwords: store it like the data itself. The JSON "Export backup" on the home page is a portable copy for moving data between installs, not a disaster-recovery backup.

## Upgrading

- Stop **every** process using the data directory first.
- Start the new version: migrations run automatically after writing `DATA_DIR/backups/pre-migrate-<from>-<time>.db`. Dry run on a copy first: `node server/migrate.ts --check <copyOfDataDir>` (never writes).
- **Everyone signs in once** after this upgrade (sessions changed). Let field devices finish syncing before upgrading; work queued by an older version is held on the device for the person to send or export, never sent automatically.
- **Rollback:** stop the server, replace `field-desk.db` with the `pre-migrate` file (delete `-wal`/`-shm`), run the previous build.

## Open product decisions

Built with a default; change the default if it's wrong:

- **QR check-in needs no approval** — accepted at once, the admin can undo. Alternative: admin approves each one. No time window either (open/close is manual).
- **Readiness** — "Ready — with notes" covers everything flagged; proposal: block play for no internet / no setup / too few game laptops; HQ approval for slow internet, Wi-Fi only, flagged photos, unverified venue pin.
- **One tournament per store** — campaign games are install requirements, not separate competitions.
- **Double no-show / disqualification** — not modelled; the admin sees "Both players missing".
- **Offline cold launch** — not supported (no service worker).
- **Venue board** uses the admin's session; a separate read-only TV login is not built.
- **Evidence retention** — photos are kept indefinitely; proposal: keep submitted evidence for the campaign + 90 days.
- **Tournament website brackets** — **Toornament** works (below); other platforms (Challonge, start.gg, Battlefy…) would each need their own reader.
- **Names on a store team link are typed, not verified** — anyone with the link can type any name; the team part of "Rhea (San Infotech team)" is always the server's. Alternative: a personal admin per person.
- **Full phone numbers reach the admin's device** (shown masked); stripping them from admin data is possible if staff never need them.

## Code map

- `server/api.ts` — routes, scoping, validation-before-commit, batches & commands, SSE; `server/sessions.ts`, `ratelimit.ts`, `photos.ts`, `migrate.ts`, `backup.ts`, `lock.ts`, `log.ts`; `server/index.ts` — production server
- `src/lib/schema.ts` — document validation (server + backup import)
- `src/lib/steam.ts` — Steam accounts: the weekend rule (`steamConflicts`), availability, what a store's team may see (`steamLoginFor`); `pages/SteamPage.tsx` — HQ's list; `components/SteamAssign.tsx` — HQ's picker on a store row; `components/SteamCard.tsx` — the store team's login card
- `src/lib/teams.ts` — store team helpers (short store name, "Rhea (San Infotech team)", codes in use); `components/StoreTeamLink.tsx` — HQ's team link controls; the name screen is `NamePrompt` in `components/ui.tsx`
- `src/lib/ops.ts` — id-aware diff / apply shared by app and server
- `src/lib/commands.ts`, `tournament.ts`, `submission.ts` — server-authoritative commands (bracket, matches, stations, winners, recce submit/review); `src/lib/winnerInput.ts` — winner-details cleaning and state; `components/WinnersBanner.tsx` + `WinnersForm.tsx` — the match-day winners card and form
- `src/lib/sync/engine.ts` — outbox, per-person storage, retries, failed work; `src/lib/db.ts` — the app's state API
- `src/lib/bracket.ts` — seeding, byes, queue; `src/lib/assess.ts` — recce assessment and photo flags
- `src/lib/phone.ts` — phone normalization, stable player ids; `src/lib/roster.ts` + `components/RosterImport.tsx` — HQ player import; `src/lib/storesheet.ts` + `components/StoreSheetImport.tsx` — HQ store import from a sheet; `src/lib/toornament.ts` + `components/ToornamentImport.tsx` — brackets from Toornament; `src/lib/onspot.ts` + `components/OnSpotList.tsx` — HQ's on-spot registrations list; `src/lib/winners.ts` + `pages/WinnersPage.tsx` — HQ's winners list and CSV
- `src/lib/print.ts` — print files: sheet parsing (`parsePrintSheet`, `kindOfRow`, `driveIdOf`, `resolveCheques`), matching blocks to stores (`matchPrintBlocks`), file names, specs, this week's kits; `server/print.ts` — reading the sheet and streaming Drive files / zips (`createPrinter`), `server/xlsx.ts` + `server/zip.ts` — the minimal .xlsx reader and zip reader / streaming writer, `GET /api/print/…` and `/api/public/print/…` in `server/api.ts`
- `server/public.ts` — player QR check-in (public); `server/roster-fetch.ts` — HQ sheet-link fetch (private / internal addresses refused on every redirect); `server/toornament-fetch.ts` — the same, for Toornament (toornament.com only); `server/toornament-auto.ts` + `src/lib/toornament-auto.ts` — the timed check that loads the bracket (rules, status line)
- `src/pages/CheckInPage.tsx` — the player's page; `src/lib/checkin.ts`, `src/lib/qr.ts` — check-in helpers, QR drawing
- `tests/` — `npm test`
