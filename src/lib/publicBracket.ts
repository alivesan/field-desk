/*
 * The public live bracket (/b/<token>) — the pure parts, shared by the server (what it may say), the
 * public page and HQ's panel. Node-loadable: no browser globals, no db.ts (the public page must never
 * start the sync engine).
 *
 * The answer names players and nothing else: no player ids (they are derived from the phone), phones,
 * check-in times, on-spot details or winners' contact details. A player is told apart by seed.
 */
import type { Store, TournamentEvent } from './types.ts';
import { matchNo, roundCount } from './bracket.ts';
import { newCheckInToken } from './checkin.ts';
import { campaignStoreNames, storeShortName } from './names.ts';
import { storeDate } from './recce.ts';
import { feederOf } from './day-ui.ts';
import { finalResult } from './winnerInput.ts';

export interface PublicMatch {
  id: string;
  round: number; // 0 = first round
  index: number;
  no: number; // matchNo: the number on the card
  a: string | null; // the player's name; null = not decided yet (or a bye's empty side)
  aIgn?: string; // in-game name, when HQ's list has one
  aSeed: number | null; // tells two players apart for "follow" — the player id would be a hash of the phone
  b: string | null;
  bIgn?: string;
  bSeed: number | null;
  winner: 'a' | 'b' | null;
  status: 'pending' | 'live' | 'done';
  bye: boolean;
  walkover?: boolean;
  score: string;
  station?: number; // only while it is live
}

export interface PublicBracketView {
  store: string; // short name
  city: string;
  campaign: string;
  game?: string;
  date: string; // yyyy-mm-dd
  rounds: number;
  matches: PublicMatch[];
  champion: string | null;
  updatedAt: string; // ISO — the latest match start / finish (else the store's last edit)
}

/** What anyone holding the store's bracket link may see. `siblingNames` are the campaign's store names (for the short name). */
export function publicBracketView(store: Store, event: TournamentEvent, siblingNames: string[]): PublicBracketView {
  const day = store.day;
  const player = new Map(day.players.map((p) => [p.id, p]));
  const side = (id: string | null) => {
    const p = id ? player.get(id) : undefined;
    return p ? { name: p.name, ign: p.ign || undefined, seed: p.seed } : { name: null, ign: undefined, seed: null };
  };
  const matches: PublicMatch[] = [...day.matches]
    .sort((x, y) => x.round - y.round || x.index - y.index)
    .map((m) => {
      const [a, b] = [side(m.a), side(m.b)];
      const live = m.status === 'live';
      return {
        id: m.id,
        round: m.round,
        index: m.index,
        no: matchNo(m, day.matches),
        a: a.name,
        ...(a.ign ? { aIgn: a.ign } : {}),
        aSeed: a.seed,
        b: b.name,
        ...(b.ign ? { bIgn: b.ign } : {}),
        bSeed: b.seed,
        winner: m.winner && m.winner === m.a ? 'a' : m.winner && m.winner === m.b ? 'b' : null,
        status: m.status,
        bye: !!m.bye,
        ...(m.walkover ? { walkover: true } : {}),
        score: m.score,
        ...(live && m.station ? { station: m.station } : {}),
      };
    });
  const champion = finalResult(day.matches)?.winner;
  const times = day.matches.flatMap((m) => [m.startedAt, m.endedAt]).filter((t): t is string => !!t);
  return {
    store: storeShortName(store.name, siblingNames),
    city: store.city,
    campaign: event.name,
    ...(event.games.length ? { game: event.games.join(' · ') } : {}),
    date: storeDate(store, event),
    rounds: roundCount(day.matches),
    matches,
    champion: (champion && player.get(champion)?.name) || null,
    updatedAt: times.sort().pop() ?? store.updatedAt ?? event.createdAt,
  };
}

/** The bracket view for a store, with the campaign's other stores supplying the short name. */
export const publicBracketOf = (store: Store, event: TournamentEvent, all: Iterable<Store>) => publicBracketView(store, event, campaignStoreNames(all, event.id));

/* ---------- the link (HQ's edits run inside updateStore) ---------- */

export const publicBracketUrl = (origin: string, token: string) => `${origin.replace(/\/$/, '')}/b/${token}`;

/** Turn the link on — makes the token the first time, keeps it after that. */
export function turnOnPublicBracket(s: Store, now: string, token: () => string = newCheckInToken) {
  if (!s.publicBracket) s.publicBracket = { token: token(), on: true, createdAt: now };
  else s.publicBracket.on = true;
}

export function turnOffPublicBracket(s: Store) {
  if (s.publicBracket) s.publicBracket.on = false;
}

/** New link: the old one stops working at once. On / off stays as it was. */
export function rotatePublicBracket(s: Store, now: string, token: () => string = newCheckInToken) {
  if (!s.publicBracket) return;
  s.publicBracket.token = token();
  s.publicBracket.createdAt = now;
}

/* ---------- the page ---------- */

/** The label on a card. TOORNAMENT LABEL: when a match carries Toornament's label ("#1.1.2.1"), have the server add it to PublicMatch and return it here. */
export const matchLabel = (m: Pick<PublicMatch, 'no'>) => `M${m.no}`;

/** How many matches the page marks "Up next" — the public can't see who has checked in, so it names the next few whose players are both known. */
export const UP_NEXT_COUNT = 4;

/** The next few matches to be called: not started, both players known, earliest round and position first. */
export function upNextIds(matches: PublicMatch[]): Set<string> {
  const ready = matches.filter((m) => m.status === 'pending' && !m.bye && m.a !== null && m.b !== null);
  return new Set(ready.sort((x, y) => x.round - y.round || x.index - y.index).slice(0, UP_NEXT_COUNT).map((m) => m.id));
}

/** Every match a player (by seed) is in — the ones to light up when following them. */
export const followPath = (matches: PublicMatch[], seed: number): Set<string> => new Set(matches.filter((m) => m.aSeed === seed || m.bSeed === seed).map((m) => m.id));

/** The earlier match whose winner fills this side of a card, for "Winner of M5" (round 0 has none). */
export const feederMatch = (m: PublicMatch, side: 0 | 1, all: PublicMatch[]): PublicMatch | undefined => feederOf(m, side, all) as PublicMatch | undefined;

/** What the page shows beside the title: "Updated 12 s ago", "Updated 3 min ago". */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}

/** Reads the answer defensively: a proxy's error page or an older server must not blank the screen. */
export function readPublicBracket(body: unknown): PublicBracketView | null {
  const b = body as Partial<PublicBracketView> | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.matches) || typeof b.store !== 'string') return null;
  const matches = (b.matches as PublicMatch[]).filter((m) => m && typeof m.id === 'string' && Number.isInteger(m.round) && Number.isInteger(m.index));
  return {
    store: b.store,
    city: typeof b.city === 'string' ? b.city : '',
    campaign: typeof b.campaign === 'string' ? b.campaign : '',
    ...(typeof b.game === 'string' && b.game ? { game: b.game } : {}),
    date: typeof b.date === 'string' ? b.date : '',
    rounds: Number.isInteger(b.rounds) ? (b.rounds as number) : 0,
    matches,
    champion: typeof b.champion === 'string' ? b.champion : null,
    updatedAt: typeof b.updatedAt === 'string' ? b.updatedAt : '',
  };
}
