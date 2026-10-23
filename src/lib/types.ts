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
  appliedAt?: string; // when HQ last used it for this store's bracket
  by?: string; // principal
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
  toornament?: ToornamentSource; // HQ-only
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
}

/** A field admin. Signs in with a personal 4-character code link; sees only assigned stores. */
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
}
