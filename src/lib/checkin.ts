/*
 * Player self check-in (QR → /c/<token>) — the pure parts, shared by the match-day page, the
 * venue board and the public check-in page. Node-loadable: no browser globals at load time,
 * no db.ts (the public page must never start the sync engine).
 *
 * Who checked a player in lives in day.checkInSource (absent = staff). The server writes
 * 'self' when a player checks in by phone; staff edits write 'staff' or remove both.
 */
import type { MatchDay, Player } from './types.ts';

/** What the QR link carries — the same shape the router in src/main.tsx accepts. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += B64URL[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

/** A fresh check-in token: 18 random bytes → 24 url-safe chars (144 bits). */
export function newCheckInToken(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  return base64url(random(18));
}

export const checkInUrl = (origin: string, token: string) => `${origin.replace(/\/$/, '')}/c/${token}`;

/* ---------- admin edits (run inside updateStore) ---------- */

/** Turn the QR on — makes the token the first time, keeps it after that. */
export function openSelfCheckIn(d: MatchDay, now: string, token: () => string = newCheckInToken) {
  if (!d.selfCheckIn) d.selfCheckIn = { token: token(), open: true, openedAt: now };
  else {
    d.selfCheckIn.open = true;
    d.selfCheckIn.openedAt = now;
  }
}

export function closeSelfCheckIn(d: MatchDay) {
  if (d.selfCheckIn) d.selfCheckIn.open = false;
}

/** New QR: the old link stops working at once. Open/closed stays as it was. */
export function rotateSelfCheckIn(d: MatchDay, token: () => string = newCheckInToken) {
  if (d.selfCheckIn) d.selfCheckIn.token = token();
}

/**
 * Staff checked this player in. Absent source already means staff, so the map is only written
 * when it exists — creating it here would be a whole-object write that could race (and wipe)
 * a 'self' entry the server is adding at the same moment.
 */
export function staffCheckIn(d: MatchDay, pid: string, now: string) {
  d.checkIn[pid] = now;
  if (d.checkInSource) d.checkInSource[pid] = 'staff';
}

/** Undo any check-in: the time and who did it both go. */
export function undoCheckIn(d: MatchDay, pid: string) {
  delete d.checkIn[pid];
  if (d.checkInSource && pid in d.checkInSource) delete d.checkInSource[pid];
}

/* ---------- reading ---------- */

export const isSelf = (day: MatchDay, pid: string) => !!day.checkIn[pid] && day.checkInSource?.[pid] === 'self';

export interface SelfArrival {
  pid: string;
  at: string; // ISO check-in time
}

/**
 * Self check-ins in `next` that weren't in `prev` — the "Aarav S. joined" notices. The first
 * snapshot (prev undefined) reports nothing, so opening the page doesn't replay the morning.
 * A player who was undone and checks in again (new time) counts as new. Oldest first.
 */
export function newSelfCheckIns(prev: MatchDay | undefined, next: MatchDay): SelfArrival[] {
  if (!prev) return [];
  const out: SelfArrival[] = [];
  for (const [pid, at] of Object.entries(next.checkIn)) {
    if (next.checkInSource?.[pid] !== 'self') continue;
    if (prev.checkIn[pid] === at && prev.checkInSource?.[pid] === 'self') continue;
    out.push({ pid, at });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Everyone currently checked in by QR, newest first. */
export function recentSelfCheckIns(day: MatchDay, limit = 8): SelfArrival[] {
  return Object.entries(day.checkIn)
    .filter(([pid]) => day.checkInSource?.[pid] === 'self')
    .map(([pid, at]) => ({ pid, at }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.pid.localeCompare(b.pid))
    .slice(0, limit);
}

/** Players HQ sent without a phone number — they can't use the QR. (An admin's device holds only the last 4 — `phoneEnd` — for players not yet checked in; that counts as a number.) */
export const withoutPhone = (players: Player[]) => players.filter((p) => !p.phone && !p.phoneEnd).length;

/**
 * Roster search: names and in-game names, or (3+ digits typed) a phone number. A player whose full
 * number this device doesn't hold yet (an admin, not checked in) is found by their last 4 digits —
 * typing 3–4 digits, or a whole number ending in them.
 */
export function matchesPlayer(p: Player, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (p.name.toLowerCase().includes(q) || !!p.ign?.toLowerCase().includes(q)) return true;
  const digits = q.replace(/\D/g, '');
  if (digits.length < 3 || digits.length !== q.replace(/[\s+()-]/g, '').length) return false;
  if (p.phone) return p.phone.includes(digits);
  return !!p.phoneEnd && (digits.length <= p.phoneEnd.length ? p.phoneEnd.includes(digits) : digits.endsWith(p.phoneEnd));
}

/* ---------- the public page's answers ---------- */

export type CheckInProblem = 'closed' | 'no-match' | 'ambiguous' | 'bad-request' | 'rate-limited' | 'offline' | 'not-found' | 'server';

/** Maps a POST response status/code to what went wrong. */
export function problemFor(status: number, code?: string): CheckInProblem {
  if (status === 429) return 'rate-limited';
  if (code === 'closed' || status === 403) return 'closed';
  if (code === 'ambiguous' || status === 409) return 'ambiguous';
  if (code === 'no-match') return 'no-match';
  if (code === 'not-found') return 'not-found';
  if (code === 'bad-request' || status === 400) return 'bad-request';
  if (status === 404) return 'no-match';
  return 'server';
}

/** Retry-After (seconds or HTTP date) → whole seconds to wait, at least 1, at most 15 min. */
export function retryAfterSeconds(header: string | null | undefined, now = Date.now()): number {
  const fallback = 30;
  if (!header) return fallback;
  const n = Number(header.trim());
  const s = Number.isFinite(n) ? n : (new Date(header).getTime() - now) / 1000;
  if (!Number.isFinite(s)) return fallback;
  return Math.min(900, Math.max(1, Math.ceil(s)));
}

/** The sentence a player sees for each problem. Never names another player. */
export function problemText(p: CheckInProblem, wait?: number): { title: string; body: string } {
  switch (p) {
    case 'closed':
      return { title: 'Check-in isn’t open yet.', body: 'The staff will open it shortly. You can also check in at the desk.' };
    case 'no-match':
      return { title: 'We couldn’t find that number.', body: 'Check the number you registered with and try again — or go to the desk with your name.' };
    case 'ambiguous':
      return { title: 'Please check in at the desk.', body: 'That number is on the list more than once, so the staff need to check you in by name.' };
    case 'bad-request':
      return { title: 'That doesn’t look like a phone number.', body: 'Type the number you registered with — 10 digits, no spaces needed.' };
    case 'rate-limited':
      return { title: 'Too many tries.', body: `Wait ${wait && wait > 1 ? `${wait} seconds` : 'a moment'} and try again, or check in at the desk.` };
    case 'offline':
      return { title: 'No connection.', body: 'Check your signal or Wi-Fi and try again. Nothing was sent.' };
    case 'not-found':
      return { title: 'This check-in link isn’t working.', body: 'The QR may have been replaced. Scan the one at the venue now, or check in at the desk.' };
    default:
      return { title: 'Something went wrong.', body: 'Try again in a moment, or check in at the desk.' };
  }
}
