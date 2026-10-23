/*
 * On-spot registrations — walk-ins an admin adds at the desk on the day (players.onspot), which
 * HQ then has to add to Toornament (and ticks off with onspot.mark). The pure half: which player
 * an entry is now, whether they're in the bracket, what HQ copies / downloads, and keeping
 * walk-ins when HQ replaces the player list. src/components/OnSpotList.tsx is the HQ list.
 *
 * An OnSpotEntry outlives its Player (HQ may replace the list), so an entry is matched to the
 * current list by its playerId, then by phone, then by name (ignoring case and spacing).
 *
 * Node-loadable: no browser APIs, explicit .ts imports only.
 */
import type { MatchDay, OnSpotEntry, Player, Store } from './types.ts';
import { pad2, todayLocal } from './util.ts';

/** Same name, ignoring case and spacing (the same rule as toornament.ts nameKey). */
export const onSpotKey = (name: string) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** "98200 11111" — the full number, for HQ (admins see it masked). */
export const prettyPhone = (p?: string) => (p ? (p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p) : '');

export const onSpotOf = (day: MatchDay): OnSpotEntry[] => day.onSpot ?? [];
export const isAdded = (e: OnSpotEntry) => !!e.toornament;

/** The player an entry is on this list: same id, else same phone, else same name. */
export function onSpotPlayer(players: Player[], e: OnSpotEntry): Player | undefined {
  return players.find((p) => p.id === e.playerId) ?? (e.phone ? players.find((p) => p.phone === e.phone) : undefined) ?? players.find((p) => onSpotKey(p.name) === onSpotKey(e.name));
}

/** playerId → the on-spot entry behind that player, for tagging HQ's player list. */
export function onSpotByPlayer(day: MatchDay): Map<string, OnSpotEntry> {
  const out = new Map<string, OnSpotEntry>();
  for (const e of onSpotOf(day)) {
    const p = onSpotPlayer(day.players, e);
    if (p && !out.has(p.id)) out.set(p.id, e);
  }
  return out;
}

/** In the current bracket — the proof that HQ's Toornament round trip worked. */
export function inBracket(day: MatchDay, e: OnSpotEntry): boolean {
  const p = onSpotPlayer(day.players, e);
  return !!p && day.matches.some((m) => m.a === p.id || m.b === p.id);
}

export interface OnSpotState {
  entry: OnSpotEntry;
  player?: Player; // absent = no longer on the player list
  checkedIn: boolean;
  inBracket: boolean;
}

export function onSpotStates(day: MatchDay): OnSpotState[] {
  return onSpotOf(day).map((entry) => {
    const player = onSpotPlayer(day.players, entry);
    return { entry, player, checkedIn: !!player && !!day.checkIn[player.id], inBracket: !!player && day.matches.some((m) => m.a === player.id || m.b === player.id) };
  });
}

export type OnSpotFilter = 'todo' | 'done' | 'all';
export const FILTER_LABEL: Record<OnSpotFilter, string> = { todo: 'To add to Toornament', done: 'Added', all: 'All' };
export const filterOnSpot = <T extends { entry: OnSpotEntry } | OnSpotEntry>(list: T[], f: OnSpotFilter) =>
  f === 'all' ? list : list.filter((x) => isAdded('entry' in x ? x.entry : x) === (f === 'done'));

/** Entries across stores: how many, and how many HQ still has to add to Toornament. */
export function onSpotCounts(stores: Pick<Store, 'day'>[]): { total: number; todo: number } {
  let total = 0;
  let todo = 0;
  for (const s of stores)
    for (const e of onSpotOf(s.day)) {
      total++;
      if (!isAdded(e)) todo++;
    }
  return { total, todo };
}

/**
 * What HQ pastes into Toornament's "add participants", one per line. 'ign' uses the in-game name
 * where the player gave one (Toornament names are often gamertags), else the name.
 */
export const copyText = (entries: OnSpotEntry[], use: 'name' | 'ign' = 'name') => entries.map((e) => (use === 'ign' && e.ign ? e.ign : e.name)).join('\n');

/* ---------- CSV ---------- */

export const CSV_HEADER = ['Name', 'Phone', 'In-game name', 'Store', 'Registered at', 'By', 'Added to Toornament'];

/** yyyy-mm-dd HH:MM on this device's clock — what a spreadsheet reads as a date and time. */
export function localStamp(iso: string | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${todayLocal(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function csvRows(stores: Pick<Store, 'name' | 'day'>[], f: OnSpotFilter = 'all'): string[][] {
  return stores.flatMap((s) => filterOnSpot(onSpotOf(s.day), f).map((e) => [e.name, prettyPhone(e.phone), e.ign ?? '', s.name, localStamp(e.at), e.by, e.toornament ? localStamp(e.toornament) : 'No']));
}

/** One CSV cell: quoted when needed, and never read as a formula by a spreadsheet. */
export const csvCell = (v: string) => {
  const t = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export const toCsv = (rows: string[][]) => [CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/* ---------- HQ replaces the player list ---------- */

/**
 * Walk-ins are kept when HQ loads a new list that doesn't have them: every on-spot player still
 * on the store's list who isn't in `next` (same id, same phone, or same name) is appended after
 * the file's players, seeds continuing. A walk-in who IS in the file is the file's row (same
 * phone + name → same id, so the check-in stays).
 */
export function keepOnSpot(day: MatchDay, next: Player[]): { players: Player[]; kept: Player[] } {
  const ids = new Set(next.map((p) => p.id));
  const phones = new Set(next.flatMap((p) => (p.phone ? [p.phone] : [])));
  const names = new Set(next.map((p) => onSpotKey(p.name)));
  let seed = next.reduce((n, p) => Math.max(n, p.seed), 0);
  const kept: Player[] = [];
  for (const e of onSpotOf(day)) {
    const p = onSpotPlayer(day.players, e);
    if (!p || ids.has(p.id) || (p.phone && phones.has(p.phone)) || names.has(onSpotKey(p.name))) continue;
    ids.add(p.id);
    if (p.phone) phones.add(p.phone);
    names.add(onSpotKey(p.name));
    kept.push({ ...p, seed: ++seed });
  }
  return { players: kept.length ? [...next, ...kept] : next, kept };
}
