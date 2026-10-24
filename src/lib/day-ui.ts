/*
 * Pure helpers for the match-day screens (src/pages/DayPage.tsx and the sheets in
 * src/components): what state a bracket match is in, how a slot reads, and the phone link for
 * "Call". No browser APIs, explicit .ts imports only, so Node tests can load it.
 */
import type { Match, MatchDay, Player } from './types.ts';
import { nextOf } from './bracket.ts';
import { maskPhone } from './phone.ts';

/** `tel:` link for a stored number, or null when there is nothing dialable. 10-digit Indian mobiles get +91; longer numbers are already international (+); anything else is dialled as stored. */
export function telHref(phone: string | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length < 6 || d.length > 15) return null;
  if (d.length === 10 && /^[6-9]/.test(d)) return `tel:+91${d}`;
  if (d.length > 10) return `tel:+${d}`;
  return `tel:${d}`;
}

/*
 * The phone rule: a field admin gets a player's full number only once the player is checked in (the
 * server sends `phoneEnd`, the last 4 digits, until then); HQ always has the full number.
 */

/** Last 4 digits of a player's number, from the full number or the admin-side `phoneEnd` ('' = no number on the list). */
export const phoneTail = (p: Pick<Player, 'phone' | 'phoneEnd'>): string => (p.phone ? p.phone.slice(-4) : (p.phoneEnd ?? ''));

/** "•••• •• 1111" for the lists — all anyone gets to see there — or '' when the player has no number. */
export const maskedPhone = (p: Pick<Player, 'phone' | 'phoneEnd'>): string => maskPhone(phoneTail(p));

/**
 * What a screen may show of a player's number:
 * 'open' — the full number is here (HQ, or the player is checked in);
 * 'after-check-in' — an admin and the player isn't checked in yet: only the last 4;
 * 'loading' — checked in just now, the full number arrives with the server's next sync;
 * 'none' — there is no number on the list.
 */
export type NumberAccess = 'open' | 'after-check-in' | 'loading' | 'none';

export function numberAccess(p: Pick<Player, 'phone' | 'phoneEnd'>, checkedIn: boolean, hq: boolean): NumberAccess {
  if (hq) return p.phone ? 'open' : 'none';
  // Not checked in: hidden even if this device still holds the number (an undo not yet synced).
  if (!checkedIn) return p.phone || p.phoneEnd ? 'after-check-in' : 'none';
  return p.phone ? 'open' : p.phoneEnd ? 'loading' : 'none';
}

/** The `tel:` link for Call, only when the rule lets this person see the number. */
export const telFor = (p: Pick<Player, 'phone' | 'phoneEnd'>, checkedIn: boolean, hq: boolean): string | null => (numberAccess(p, checkedIn, hq) === 'open' ? telHref(p.phone) : null);

/* ---------- a match ---------- */

export type MatchKind = 'bye' | 'done' | 'live' | 'ready' | 'busy' | 'one-missing' | 'both-missing' | 'waiting';

export interface MatchState {
  kind: MatchKind;
  missing: string[]; // player ids not checked in (both players known, match not started)
  busyWith?: Match; // 'busy': the live match one of them is still in
}

/** Where a match stands, from the bracket and who has checked in. Mirrors computeQueue's rules. */
export function matchState(m: Match, day: Pick<MatchDay, 'checkIn' | 'matches'>): MatchState {
  if (m.bye) return { kind: 'bye', missing: [] };
  if (m.status === 'done') return { kind: 'done', missing: [] };
  if (m.status === 'live') return { kind: 'live', missing: [] };
  if (!m.a || !m.b) return { kind: 'waiting', missing: [] };
  const missing = [m.a, m.b].filter((p) => !day.checkIn[p]);
  if (missing.length === 2) return { kind: 'both-missing', missing };
  if (missing.length === 1) return { kind: 'one-missing', missing };
  const busyWith = day.matches.find((x) => x.status === 'live' && x.id !== m.id && (x.a === m.a || x.b === m.a || x.a === m.b || x.b === m.b));
  return busyWith ? { kind: 'busy', missing, busyWith } : { kind: 'ready', missing };
}

export interface KindInfo {
  glyph: string; // a shape as well as a colour, so it reads without telling reds from greens
  label: string;
  hint: string; // the legend's one-liner
}

export const KIND_INFO: Record<MatchKind, KindInfo> = {
  ready: { glyph: '▶', label: 'Ready', hint: 'Both here — call it to a station.' },
  'one-missing': { glyph: '◐', label: '1 missing', hint: 'One isn’t checked in (marked ○).' },
  'both-missing': { glyph: '○', label: '2 missing', hint: 'Neither is checked in.' },
  live: { glyph: '●', label: 'Live', hint: 'Being played, on that station.' },
  done: { glyph: '■', label: 'Done', hint: 'Winner bold, loser faded.' },
  waiting: { glyph: '…', label: 'Waiting', hint: 'Needs an earlier result first.' },
  busy: { glyph: '◷', label: 'Busy', hint: 'Both here, one is still playing.' },
  bye: { glyph: '–', label: 'Bye', hint: 'No opponent — goes through.' },
};

/** Legend order: what an admin acts on first. */
export const KIND_ORDER: MatchKind[] = ['ready', 'one-missing', 'both-missing', 'live', 'done', 'waiting', 'busy', 'bye'];

/* ---------- a slot (one player's line in a match) ---------- */

export type SlotKind = 'here' | 'away' | 'won' | 'lost' | 'adv' | 'tbd' | 'bye' | 'open';

/** How one side of a match reads: checked in / not here, who won / lost, still to be decided, or a bye. */
export function slotKind(m: Match, id: string | null, checkIn: Record<string, string>): SlotKind {
  if (!id) return m.bye && m.round === 0 ? 'bye' : m.round === 0 ? 'open' : 'tbd';
  if (m.bye) return 'adv';
  if (m.status === 'done') return m.winner === id ? 'won' : 'lost';
  return checkIn[id] ? 'here' : 'away';
}

/** The earlier match whose winner fills this side (round 0 has none). */
export const feederOf = (m: Match, side: 0 | 1, all: Match[]): Match | undefined => (m.round === 0 ? undefined : all.find((x) => x.round === m.round - 1 && x.index === m.index * 2 + side));

/** Why a result or live match can't be undone: the follow-on match that has already started (or null when it can). */
export function undoBlockedBy(m: Match, all: Match[]): Match | null {
  if (m.status !== 'done' || m.bye) return null;
  const n = nextOf(m, all);
  return n && n.status !== 'pending' ? n : null;
}

/** Whole minutes between start and finish ('' when either is missing). */
export function playedFor(m: Match): string {
  if (!m.startedAt || !m.endedAt) return '';
  const min = Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 60000);
  return !Number.isFinite(min) || min < 0 ? '' : min < 1 ? 'under a minute' : `${min} min`;
}

/** Every station number 1..count with who holds it: a live match, or nobody. */
export function stationSlots(day: Pick<MatchDay, 'stations' | 'matches'>): { station: number; live?: Match }[] {
  return Array.from({ length: day.stations }, (_, i) => ({ station: i + 1, live: day.matches.find((x) => x.status === 'live' && x.station === i + 1) }));
}

/* ---------- the bracket chart: round picker, connector lines, following a player ---------- */

/** Short round names for the picker chips: R1, R2… then QF, SF, Final. */
export function roundShort(r: number, total: number): string {
  const left = total - r;
  return left === 1 ? 'Final' : left === 2 ? 'SF' : left === 3 ? 'QF' : `R${r + 1}`;
}

/** The round the day is in: where a match is live, else the first round with an unplayed real match, else the last round. */
export function roundInPlay(matches: Match[]): number {
  const live = matches.find((m) => m.status === 'live');
  if (live) return live.round;
  const open = matches.filter((m) => m.status !== 'done' && !m.bye);
  return open.length ? Math.min(...open.map((m) => m.round)) : Math.max(0, ...matches.map((m) => m.round));
}

/** Every match a player is in — the ones to light up when following them. */
export const pathOf = (matches: Match[], pid: string): Set<string> => new Set(matches.filter((m) => m.a === pid || m.b === pid).map((m) => m.id));

/** How the line leaving a match toward the next round is drawn: accent while it is being played, ink once decided, faint until then (a bye decides nothing). */
export type WireTone = 'rule' | 'ink' | 'live';
export const wireTone = (m: Match): WireTone => (m.bye ? 'rule' : m.status === 'live' ? 'live' : m.status === 'done' ? 'ink' : 'rule');
