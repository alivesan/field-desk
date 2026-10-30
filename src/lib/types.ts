export type YesNo = 'yes' | 'no' | null;

export interface GeoFix {
  lat: number;
  lng: number;
  accuracy: number;
}

/** Metadata for a proof photo. The image itself (with the stamp burned in) lives in IndexedDB under `id`. */
export interface PhotoRef {
  id: string;
  label: string;
  takenAt: string; // when it was saved here (device clock), ISO
  fileTime: string; // the file's own lastModified, ISO
  live: boolean; // taken with the camera just now, not picked from the gallery
  source?: 'camera' | 'upload'; // upload = from the gallery, e.g. a GPS-camera app photo
  shotAt?: string; // capture time read from the photo's EXIF, when it has one
  geo: GeoFix | null; // best location we have: EXIF GPS for uploads, else the phone's GPS at the time
  geoFrom?: 'device' | 'photo'; // where `geo` came from
  geoAt?: string; // when the device fix in `geo` was measured (ISO) — absent on older photos and EXIF locations
  geoError?: string;
}

export interface Laptop {
  id: string;
  label: string;
  role: 'game' | 'admin' | 'spare';
  games: Record<string, boolean>; // game installed
  launched?: Record<string, boolean>; // game launched and runs
  drivers: boolean;
  windows: boolean;
  notes: string;
  photos: PhotoRef[];
}

export interface SpeedResult {
  down: number | null; // Mbps
  up: number | null; // Mbps
  ping: number | null; // ms
  method: 'auto' | 'manual';
  at: string;
  server?: string;
}

export interface Recce {
  status: 'draft' | 'submitted';
  startedAt?: string;
  submittedAt?: string;
  venue: { photos: PhotoRef[]; area?: string; notes?: string }; // area/notes: older recces only
  laptops: Laptop[];
  network: { wifi: YesNo; lan: YesNo; speed: SpeedResult | null; photos: PhotoRef[]; ssid?: string };
  furniture: {
    setup: 'none' | 'standard' | 'rog' | null;
    chairType: string;
    chairCount: number | null;
    tablecloth: YesNo; // only asked for a standard desk setup — ROG tables come branded
    photos: PhotoRef[];
  };
  collateral: Collateral;
  summary: string;
}

export interface Collateral {
  posters: boolean; // printed and with the admin, for the promotion team
  standee: boolean; // placed at the store
  cheque: boolean; // prize cheque placed at the store
  standeePhotos: PhotoRef[];
  chequePhotos: PhotoRef[];
  chequeInStandeePhoto: boolean; // one photo shows both
  // older recces
  placed?: Record<string, boolean>;
  handedTo?: string;
  photos?: PhotoRef[];
}

export interface Player {
  id: string; // stable across re-imports: playerIdFor() in src/lib/phone.ts
  name: string;
  seed: number;
  phone?: string; // normalized digits (normalizePhone) — how a player finds themselves at QR check-in
  ign?: string; // in-game name / gamertag from HQ's list (cleanIgn, ≤ 40) — shown to staff, searchable; never part of the id
  phoneEnd?: string; // admins only: last 4 digits while the player isn't checked in — the server sends this instead of `phone` (never stored)
}

export interface Match {
  id: string;
  round: number; // 0 = first round
  index: number; // position within the round
  a: string | null; // player ids
  b: string | null;
  winner: string | null;
  status: 'pending' | 'live' | 'done';
  bye?: boolean;
  walkover?: boolean;
  station?: number;
  score: string;
  startedAt?: string;
  endedAt?: string;
}

export interface MatchDay {
  players: Player[];
  checkIn: Record<string, string>; // playerId -> ISO time of check-in (plain field edits)
  matches: Match[]; // players / matches / stations change only through server commands (src/lib/commands.ts)
  stations: number;
  version?: number; // bumped by every server-applied tournament command; absent = 0
  checkInSource?: Record<string, 'self' | 'staff'>; // playerId -> who checked them in (absent = staff)
  selfCheckIn?: SelfCheckIn; // the store's player QR check-in
  onSpot?: OnSpotEntry[]; // players registered at the desk on the day, oldest first (commands only)
  winners?: Winners; // winner + runner-up details the admin collects after the final (commands only)
}

/**
 * The store's winner and runner-up, as the admin collected them at the desk after the final.
 * Who they are comes from the final match (server-side, never typed); the contact details are
 * typed or confirmed by the admin — name / in-game name / phone are prefilled from the player list.
 * Kept even if HQ later resets the bracket, so prize details are never lost; HQ's list flags a
 * record whose final no longer matches.
 */
export interface Winners {
  winner: WinnerDetails;
  runnerUp: WinnerDetails;
  finalMatchId: string; // the final these were taken from
  at: string; // ISO, first saved
  updatedAt: string; // ISO, last saved
  by: string; // who saved them last (admin's or HQ's name)
}

export interface WinnerDetails {
  playerId: string; // from the final (winner / loser)
  realName: string; // full legal name for the prize ('' = not given yet)
  ign?: string;
  phone?: string; // normalized digits
  email?: string; // lower-cased
  instagram?: string; // handle without '@'
}

/**
 * A player who registered at the desk on the day — not on HQ's list. The admin adds them
 * (players.onspot: they join day.players, checked in); HQ copies them into Toornament and marks
 * them done (onspot.mark). The entry is a record of the registration: it stays even if HQ later
 * replaces the player list, so HQ never loses track of who still has to go into Toornament.
 */
export interface OnSpotEntry {
  id: string; // deterministic from the command id
  playerId: string; // the Player it added to day.players (may since have been replaced by HQ)
  name: string;
  phone?: string; // normalized digits
  ign?: string;
  at: string; // ISO, when the admin registered them
  by: string; // who registered them (admin's name)
  toornament?: string; // ISO, when HQ marked them added to Toornament; absent = still to add
}

/**
 * Player self check-in: the QR at the venue opens /c/<token>; a player types their phone number
 * and is checked in. The admin turns it on/off and can issue a new token (old QR stops working).
 */
export interface SelfCheckIn {
  token: string; // 16+ url-safe random chars — the only thing in the QR
  open: boolean;
  openedAt?: string;
}

/** Where HQ got this store's player list from (HQ-only metadata; the players themselves are in day.players). */
export interface RosterSource {
  kind: 'upload' | 'link' | 'paste';
  url?: string; // for 'link': the published sheet / CSV link HQ refreshes from
  fileName?: string; // for 'upload'
  fetchedAt: string;
  rows: number; // players taken for this store
  by: string; // principal
}

/**
 * The store's bracket on toornament.com (HQ-only metadata, like RosterSource). The bracket itself
 * is loaded with one bracket.load command — see src/lib/toornament.ts.
 */
export interface ToornamentSource {
  url: string; // the tournament (or stage) page HQ pasted: https://play.toornament.com/…/tournaments/<id>/
  stageId?: string; // the stage last used
  stageName?: string;
  appliedAt?: string; // when HQ (or the auto-check) last used it for this store's bracket
  by?: string; // principal ('system:toornament' = the auto-check)
  loadId?: string; // id of the bracket.load that built the current bracket: its matches' ids start with it (how the auto-check tells a Toornament bracket from one built by hand)
  auto?: ToornamentAuto; // the server's 5-minute check on the event day (server/toornament-auto.ts)
}

export type ToornamentAutoResult = 'waiting' | 'not-placed' | 'applied' | 'skipped-underway' | 'skipped-manual' | 'error';

/**
 * The auto-check's switch (HQ) and what it last found (written by the server only). `enabled` is on
 * unless it says false. waiting = no bracket on Toornament yet; not-placed = a bracket, but the players
 * aren't placed in it; applied / skipped-* end the day's checking (HQ's "Check again" clears them).
 */
export interface ToornamentAuto {
  enabled: boolean;
  lastCheckAt?: string; // ISO
  lastResult?: ToornamentAutoResult;
  message?: string; // one plain sentence for HQ — never a link
  appliedAt?: string; // ISO, when the auto-check loaded the bracket
}

/** The requirements a recce was assessed against when it was submitted. */
export interface SubmissionPolicy {
  games: string[];
  gameReadyTarget: number;
  minDownMbps: number;
}

/**
 * One submitted revision of a store's recce. Created only by the server ('recce.submit'
 * command) with server time and actor, and never edited afterwards except for review fields.
 */
export interface Submission {
  id: string;
  rev: number; // 1, 2, 3… per store
  submittedAt: string; // server time
  by: string; // principal, e.g. "admin:<id>" or "super"
  byName: string;
  recce: Recce; // frozen copy as submitted
  policy: SubmissionPolicy;
  reviewedAt?: string;
  reviewedBy?: string;
}

export interface Store {
  id: string;
  eventId: string;
  name: string;
  city: string;
  state?: string; // from HQ's store sheet or the details form
  exclusive?: boolean; // an ASUS ROG Exclusive store (absent = not marked)
  address: string;
  date?: string; // yyyy-mm-dd — this store's tournament day; falls back to the campaign date
  phone?: string; // store's phone, from HQ
  mapsUrl?: string; // Google Maps link, from HQ
  venue?: string; // where in the store the tournament happens, from HQ
  geo?: GeoFix | null; // venue location read from the Maps link — the reference for photo distance checks
  adminId?: string | null; // assigned field admin (see Admin)
  admin: string; // that admin's display name, copied on assignment
  pin: GeoFix | null; // fallback location: the first geotagged proof photo
  recce: Recce;
  day: MatchDay;
  updatedAt?: string; // last edit from any device
  submissions?: Submission[]; // append-only revision history, newest last (server commands only)
  roster?: RosterSource; // HQ-only
  access?: StoreAccess; // HQ-only: the store team's shared sign-in code (never sent to admins)
  print?: PrintKit; // the store's print files (HQ imports them from the creatives sheet); the store team sees them
  printDownloads?: Partial<Record<PrintKind, PrintDownload>>; // who on the store team saved each file (admin-writable)
  toornament?: ToornamentSource; // HQ-only
  steam?: SteamAssignment; // HQ-only: which Steam account this store was given, and for what
  /** The team's Steam Guard lookups — written by the server only (POST /api/steam/otp-request, /otp-dismiss), never by a client. */
  otpState?: StoreOtpState;
  finishedAt?: string; // ISO — HQ marked the event finished (event.finish / event.reopen). A store whose final is played with winner details saved counts as finished without it (src/lib/done.ts)
  finishedBy?: string; // who marked it
  steamLogin?: SteamLogin; // computed by the server for the store's own team / admin on every read — never stored, never written
}

export interface TournamentEvent {
  id: string;
  name: string;
  date: string; // yyyy-mm-dd
  games: string[];
  collateral: string[];
  gameReadyTarget: number; // laptops that must have games installed
  minDownMbps: number;
  createdAt: string;
  storeSheet?: StoreSheetSource; // HQ-only: the sheet the campaign's stores are imported from
  printSheet?: PrintSheetSource; // HQ-only: the creatives sheet (one tab per date, a block of 5 Drive links per store)
  printDesk?: PrintDesk; // HQ-only: the no-sign-in link for whoever downloads every store's print files
  printSpec?: Partial<Record<PrintKind, PrintSpec>>; // print instructions; missing kinds use PRINT_DEFAULTS
  marketing?: EventMarketing; // HQ-only: prize pool, times and promo texts that fill the Discord post and the WhatsApp promos (src/lib/marketing.ts)
  toornamentAuto?: { from: string }; // 'HH:MM' India time: when the server starts checking Toornament for each store's bracket on its day (default 12:30)
  closedAt?: string; // ISO — HQ closed the campaign by hand (HQ-only field); it is also complete once every store is finished (src/lib/done.ts)
}

/** What HQ types once per campaign for the Marketing page; an empty field falls back to a default (the ROG Showdown's fixed prize pool and times, a stock text) or a visible [… missing] marker. */
export interface EventMarketing {
  prizePool?: string; // "10,000" — the templates add the ₹
  reportingTime?: string; // free text: "11:00 AM"
  firstMatch?: string; // free text: "12:00 PM"
  discordIntro?: string;
  discordClosing?: string;
  whatsappIntro?: string;
  discordInvite?: string; // https link; default is the ROG Showdown server
  playerIntro?: string; // the one line under the date in the night-before message to registered players
  rules?: string; // the tournament rules in that message, one "– …" line each
}

/** The sheet link HQ imports this campaign's stores from — so next time it's one press on Refresh. */
export interface StoreSheetSource {
  url: string; // a published / "anyone with the link" Google Sheet or CSV link
  fetchedAt: string; // when the stores were last imported from it
}

/** A field admin. Signs in with a personal 4-character code link; sees only assigned stores. */
/**
 * One sign-in code per store, shared by everyone working that store (2–4 people). Opening
 * `/<code>` signs a phone in to that store only; each person types their name once so actions
 * read "Rhea (Nashik team)". A new code signs the old one out everywhere.
 */
/** The five collaterals every store gets for an event. */
export type PrintKind = 'standee' | 'poster' | 'pamphlet' | 'chequeWinner' | 'chequeRunnerUp';

/** One Drive file of a store's print kit. Files are "Anyone with the link" JPG/PDFs on Google Drive. */
export interface PrintFile {
  kind: PrintKind;
  driveId: string; // the /file/d/<id>/ part of the link
  url: string; // the link as given in the sheet
  name?: string; // Drive's own file name (e.g. ROG_Showdown_Tekken_Cheque-C.jpg), when known
}

/** A store's print kit, from one block of the creatives sheet. Kept on the store until a later refresh replaces it. */
export interface PrintKit {
  files: PrintFile[];
  tab?: string; // the sheet tab it came from ("31-Oct")
  label?: string; // the block's store name as written in the sheet ("Shubham info Bhubneshwar")
  importedAt: string; // ISO — equals event.printSheet.importedAt for kits from the latest refresh ("this week")
}

export interface PrintDownload {
  at: string; // ISO
  by: string; // who saved it ("Rhea (Subham Infotech team)")
}

export interface PrintSheetSource {
  url: string; // the Google Sheets link HQ pasted
  importedAt?: string; // ISO, the last refresh applied
}

/** A public, unguessable link (/p/<token>) that shows this week's print files of every store — no sign-in. */
export interface PrintDesk {
  token: string; // 16+ url-safe random chars; a new token stops the old link
  createdAt: string;
}

/** A print instruction: physical size and how many copies. */
export interface PrintSpec {
  size: string; // "6 × 3 ft", "A3 (297 × 420 mm)"
  qty: number;
}

export interface StoreAccess {
  code: string; // same alphabet as admin codes (ADMIN_CODE), unique across admins and stores
  createdAt: string; // ISO, when this code was made (a new code = a new createdAt)
}

/**
 * One of HQ's Steam accounts (HQ-only: field admins and store teams never receive the `accounts` kind).
 * HQ hands a store one for the weekend; the store team sees only the login of the account given to them.
 */
export interface SteamAccount {
  id: string;
  label?: string; // HQ's own name for it: "ROG 01"
  username: string; // the Steam ID people sign in with
  password: string;
  email?: string; // the account's e-mail, for HQ's reference
  notes?: string;
  createdAt: string; // ISO
  /** The newest Steam Guard code the e-mail automation delivered (POST /api/v1/steam/otp). Written by the server only; no client write can set it. */
  otp?: SteamOtp;
}

/** A Steam Guard code and its life: expiresAt = receivedAt (when Steam sent the e-mail) + 10 minutes. */
export interface SteamOtp {
  code: string;
  receivedAt: string; // ISO
  expiresAt: string; // ISO
}

/** Where a store's team is with its Steam Guard codes (Store.otpState); see cardOtp in steam.ts and docs/steam-otp-api.md. */
export interface StoreOtpState {
  /** The lookup the team started last (id = its steam.otp.requested event id); gone once dismissed. */
  lookup?: { id: string; requestedAt: string };
  /** receivedAt of the newest code the team has dismissed or moved past: that code and older never show again. */
  seenThrough?: string;
  /** "Logged in" was pressed: no code shows until the next lookup. */
  dismissedAt?: string;
}

export type SteamPurpose = 'play' | 'download';

/**
 * A store's Steam account for its weekend. `play` is exclusive per weekend (Steam lets one PC be online
 * with an account at a time); `download` may be shared by any number of stores, and by a recce.
 */
export interface SteamAssignment {
  accountId: string;
  purpose: SteamPurpose;
  assignedAt: string; // ISO
}

/** What the store's own team sees (Store.steamLogin): the assigned account's login, read-only. */
export interface SteamLogin {
  username: string;
  password: string;
  purpose: SteamPurpose;
  email?: string;
  /** The current Steam Guard code, only while it hasn't expired (the server checks on every read). */
  otp?: SteamOtp;
  /** The server can ask the automation to look for the code (FD_STEAM_WEBHOOK_URL is set) — shows the Get code button. */
  otpRequest?: boolean;
  /** The lookup the team started last, until it is dismissed (the card waits for it while it is under 10 minutes old). */
  otpLookup?: { id: string; requestedAt: string };
  /** When that lookup was made, while it may still be answered (10 minutes) — what cards cached before otpLookup read. */
  otpRequestedAt?: string;
}

export interface Admin {
  id: string;
  name: string;
  phone: string;
  code: string; // A–Z / 2–9 without look-alikes, e.g. "K7Q2"
  createdAt: string;
}

export interface AppState {
  version: 1;
  events: Record<string, TournamentEvent>;
  stores: Record<string, Store>;
  admins: Record<string, Admin>; // super admin only — always empty for field admins
  accounts: Record<string, SteamAccount>; // HQ's Steam accounts — super admin only, always empty for field admins and store teams
}

