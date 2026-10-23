# Field Desk

Internal tool for in-store tournaments. HQ (the super admin) runs campaigns, stores, the team and every bracket; each field admin gets a personal link that shows only their own stores and what's left to do; players check themselves in with a QR at the venue.

## Who does what

| | HQ (super admin) | Field admin | Player |
|---|---|---|---|
| Signs in at | `https://<host>/hq` with `SUPER_ADMIN_CODE` | personal link `https://<host>/K7Q2` (4 characters) | the venue QR → `https://<host>/c/<token>`, no account |
| Sees | every campaign, store, report, the team | only the stores assigned to them (and those campaigns) | the store's name and their own first name + initial — nothing else |
| Does | campaigns, stores, assignments, admins and codes; **players and brackets** per store (CSV upload, sheet link with Refresh, paste, or one at a time; build and reset); reviews recce reports | the recce (photos, checks, submit); on match day: check-ins, calling matches to stations, results, undo, station count, opening QR check-in | types their phone number to check in |

The server enforces all of this — an admin's device never receives other stores, other admins or codes, and the server refuses any write outside the caller's scope. The player check-in endpoint only ever sets *that player's* check-in.

## Campaign flow

1. **HQ** creates the campaign, admins (Team page) and stores (address, Google Maps link, venue spot, date, admin).
2. **Recce** (admin, days before): venue, laptops (each game *Installed* + *Launched*, drivers, Windows), internet (in-app speed test or typed figures + screenshot), setup, collateral — each with time/GPS-stamped photo proof. **Submit** creates a numbered revision; HQ sees it in **Recce reports** (New until opened), views exactly what was submitted against the requirements of that moment, marks it reviewed, and can save it as PDF/HTML. Later edits show as "edited since rev N" until resubmitted.
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

## Brackets from Toornament (HQ)

Each store can carry its Toornament link (store details, or pasted on the store's bracket step): `https://play.toornament.com/en_US/tournaments/<id>/` — a `…/stages/<id>/` link picks that stage. **Fetch from Toornament** shows the stages, the players (matched to the store's list by name, ignoring case and spacing, then by IGN since Toornament names are often gamertags — matched players keep their phone, IGN and check-in; new ones come without a phone) and Toornament's first-round pairings; **Use this bracket** replaces the store's players and bracket in one step (refused once matches are under way). The tournament must be public. Toornament's pages are JavaScript-only, so the server reads the public JSON those pages use (`play.toornament.com/api/…`, no key); if Toornament changes it, fetching stops working with a plain error and the other player sources still work.

- **Single elimination only.** Double elimination, groups, leagues, Swiss and free-for-all stages are named and refused.
- Byes come across as byes. A first-round match with nobody in it (stage bigger than its field) can't be held here: set the stage size on Toornament, or use the players as a seeded list.
- Results and the 3rd-place match aren't copied; the bracket starts fresh and is run here.

## On-spot registrations (walk-ins)

- **At the desk** (admin, match day): a player who isn't on HQ's list is added on the spot (name, phone, optional in-game name). They join the store's players already checked in, and the registration is recorded as **on-spot** (when, by which admin). It never touches the bracket.
- **HQ sees them** in **On-spot registrations** — on the campaign page (every store, grouped by store; each store row also shows "2 on-spot to add"; the campaign on HQ's home page says so too) and on the store's **Players & bracket → 01 Players** (that store only; the walk-ins carry an **On spot** tag in the player list). Tabs: **To add to Toornament** (default) / **Added** / **All**. Each row: name, IGN, full phone, time, admin, checked in, and **In bracket** / **Not in bracket yet**.
- **The Toornament round trip**: **Copy names** (one per line, for Toornament's participant add; **Copy in-game names** uses the IGN where given) or **Download CSV** (Name, Phone, In-game name, Store, Registered at, By, Added to Toornament) → add them on Toornament → tick **Added to Toornament** per player (or **Mark all as added**; **Undo** to clear) → Players & bracket → Bracket → **Refresh** from Toornament. Walk-ins match by name or IGN and keep their phone, IGN and check-in; once the bracket is used, HQ is offered **Mark N as added to Toornament** for any not ticked yet. **In bracket** is the proof.
- **Not lost when HQ replaces the list**: a CSV / sheet / paste load keeps walk-ins who aren't in the file (after the file's players, check-in kept) and says so in the preview, with **Drop them** as the choice; a walk-in who is in the file is the file's row (same phone + name → same player, check-in kept). A Toornament bracket that doesn't have a walk-in yet names them in the preview ("aren't on Toornament yet — add them there first, then Refresh"); using it anyway takes them off the player list for now (a bracket here holds only Toornament's players), and the Refresh after they're added brings them back with phone and IGN. The registration itself is never removed, so the list keeps showing who still has to go into Toornament.

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
| `SESSION_DAYS_ADMIN` / `SESSION_DAYS_SUPER` | `30` / `7` | Sessions expire server-side; sign-out revokes; a new admin code revokes that admin's sessions. |
| `MAX_PHOTO_MB` / `MAX_PHOTOS_PER_STORE` | `15` / `500` | |
| `COOKIE_NAME` | `fd_session` | |

Sign-in rate limits: 10 wrong codes per address per 15 min (separately for admin codes and HQ), plus a global ceiling of 300 wrong admin codes per hour that never blocks HQ. 429 responses carry `Retry-After`.

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

Restore = stop the server, restore into an empty directory, point `DATA_DIR` at it, start. This round trip is covered by `tests/server-ops.test.ts`. A backup contains admin codes and session hashes: store it like the data itself. The JSON "Export backup" on the home page is a portable copy for moving data between installs, not a disaster-recovery backup.

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
- **Full phone numbers reach the admin's device** (shown masked); stripping them from admin data is possible if staff never need them.

## Code map

- `server/api.ts` — routes, scoping, validation-before-commit, batches & commands, SSE; `server/sessions.ts`, `ratelimit.ts`, `photos.ts`, `migrate.ts`, `backup.ts`, `lock.ts`, `log.ts`; `server/index.ts` — production server
- `src/lib/schema.ts` — document validation (server + backup import)
- `src/lib/ops.ts` — id-aware diff / apply shared by app and server
- `src/lib/commands.ts`, `tournament.ts`, `submission.ts` — server-authoritative commands (bracket, matches, stations, recce submit/review)
- `src/lib/sync/engine.ts` — outbox, per-person storage, retries, failed work; `src/lib/db.ts` — the app's state API
- `src/lib/bracket.ts` — seeding, byes, queue; `src/lib/assess.ts` — recce assessment and photo flags
- `src/lib/phone.ts` — phone normalization, stable player ids; `src/lib/roster.ts` + `components/RosterImport.tsx` — HQ player import; `src/lib/toornament.ts` + `components/ToornamentImport.tsx` — brackets from Toornament; `src/lib/onspot.ts` + `components/OnSpotList.tsx` — HQ's on-spot registrations list
- `server/public.ts` — player QR check-in (public); `server/roster-fetch.ts` — HQ sheet-link fetch (private / internal addresses refused on every redirect); `server/toornament-fetch.ts` — the same, for Toornament (toornament.com only)
- `src/pages/CheckInPage.tsx` — the player's page; `src/lib/checkin.ts`, `src/lib/qr.ts` — check-in helpers, QR drawing
- `tests/` — `npm test`
