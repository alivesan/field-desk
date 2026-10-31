import type { Match, MatchDay, Player } from './types.ts';
import { uid } from './util.ts';

/* Single-elimination bracket. Round r, index i feeds round r+1, index floor(i/2). */

export function nextPow2(n: number) {
  let s = 1;
  while (s < n) s *= 2;
  return s;
}

export const isPow2 = (n: number) => n >= 1 && nextPow2(n) === n;

/** Standard seeding positions: 8 -> [1,8,4,5,2,7,3,6], so top seeds meet last and byes go to top seeds. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

const blank = (id: string, round: number, index: number, a: string | null, b: string | null): Match => ({
  id,
  round,
  index,
  a,
  b,
  winner: null,
  status: 'pending',
  score: '',
});

/** The same match, back to "not played": no winner, station, times, score or walkover. It is still the same Toornament match (`toornament`), whoever plays it. */
export const reopened = (m: Match): Match => {
  const r = blank(m.id, m.round, m.index, m.a, m.b);
  if (m.toornament) r.toornament = m.toornament;
  return r;
};

/* ---------- pasting the bracket in ---------- */

export type FeedMode = 'auto' | 'names' | 'pairs';
export interface FeedError {
  line: number; // 1-based line in the pasted text; 0 = the input as a whole
  message: string;
}
export interface ParsedFeed {
  mode: 'names' | 'pairs' | null; // null = nothing pasted, or auto mode couldn't decide (mixed input)
  names: string[]; // seed order (names), or pairing order (pairs)
  pairs: [string | null, string | null][] | null; // null = BYE
  errors: FeedError[];
}

const NUMBERING = /^\s*\d+\s*[.)]\s*/; // "1. ", "12) "
const STRONG = /\s+(?:vs\.?|v\/s|versus)\s+/i; // "A vs B"
const WEAK = /\s+(?:v\.?|-|–|—)\s+/i; // "A v B", "A - B" — only used when there's no "vs", so "Arjun V Rao vs Meera" works
const MAX_NAME = 80;

/**
 * Parse what the organiser pastes in. Either a seeded list (one name per line) or explicit
 * first-round pairings ("Asha vs Rohan", "Kabir vs BYE"). 'auto' decides from the lines and
 * rejects a mix; 'names' takes every line verbatim as a name (the escape hatch for names that
 * look like pairings, e.g. "Arjun V"). Nothing non-empty is dropped: every line becomes a
 * player or pairing, or an error pointing at it.
 */
export function parseFeed(text: string, mode: FeedMode = 'auto'): ParsedFeed {
  const errors: FeedError[] = [];
  const rows: { line: number; text: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const t = raw.replace(NUMBERING, '').replace(/\s+/g, ' ').trim();
    if (!t) errors.push({ line: i + 1, message: `“${raw.trim()}” is a number with no name after it.` });
    else rows.push({ line: i + 1, text: t });
  });
  if (!rows.length) return { mode: null, names: [], pairs: null, errors };

  const looksPair = (t: string) => STRONG.test(` ${t} `) || WEAK.test(` ${t} `);
  let use = mode === 'auto' ? null : mode;
  if (!use) {
    const pairRows = rows.filter((r) => looksPair(r.text));
    if (!pairRows.length) use = 'names';
    else if (pairRows.length === rows.length) use = 'pairs';
    else {
      // Mixed: point at the minority so the fix is obvious (ties: the single-name lines).
      const flagPairs = pairRows.length < rows.length - pairRows.length;
      for (const r of rows)
        if (looksPair(r.text) === flagPairs)
          errors.push({
            line: r.line,
            message: flagPairs
              ? `“${r.text}” looks like a pairing, but the other lines are single names. Paste one or the other — or choose “One name per line” if this is a name.`
              : `“${r.text}” is a single name, but the other lines are pairings. Write it as “${r.text} vs BYE” or pair it with someone.`,
          });
      return { mode: null, names: [], pairs: null, errors: sortErrors(errors) };
    }
  }

  const seen = new Map<string, number>(); // lower-cased name -> first line
  const add = (name: string, line: number) => {
    if (name.length > MAX_NAME) return errors.push({ line, message: `“${name.slice(0, 24)}…” is longer than ${MAX_NAME} characters.` }), false;
    const key = name.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) return errors.push({ line, message: `“${name}” already appears on line ${first}. Names must be unique — add an initial or surname.` }), false;
    seen.set(key, line);
    return true;
  };
  const isBye = (s: string) => /^bye$/i.test(s);

  if (use === 'names') {
    const names: string[] = [];
    for (const r of rows) {
      if (isBye(r.text)) errors.push({ line: r.line, message: 'BYE isn’t a player — in a seeded list, byes are given to the top seeds automatically.' });
      else if (add(r.text, r.line)) names.push(r.text);
    }
    if (rows.length === 1 && !errors.length) errors.push({ line: rows[0].line, message: 'Only one player — a bracket needs at least two.' });
    if (names.length > 256) errors.push({ line: 0, message: `${names.length} players — the limit is 256.` });
    return { mode: 'names', names: errors.length ? [] : names, pairs: null, errors: sortErrors(errors) };
  }

  const pairs: [string | null, string | null][] = [];
  for (const r of rows) {
    const padded = ` ${r.text} `;
    const sides = padded.split(STRONG.test(padded) ? STRONG : WEAK).map((s) => s.trim());
    if (sides.length < 2) {
      errors.push({ line: r.line, message: `“${r.text}” has no “vs” — write each pairing as “Name vs Name” (or “Name vs BYE”).` });
      continue;
    }
    if (sides.length > 2) {
      errors.push({ line: r.line, message: `“${r.text}” has ${sides.length} sides — a pairing is exactly two players.` });
      continue;
    }
    if (sides.some((s) => !s)) {
      errors.push({ line: r.line, message: `“${r.text}” is missing a name on one side — use BYE for an empty slot.` });
      continue;
    }
    const [a, b] = sides;
    if (isBye(a) && isBye(b)) {
      errors.push({ line: r.line, message: 'A pairing can’t be BYE vs BYE.' });
      continue;
    }
    const ok = [a, b].map((s) => isBye(s) || add(s, r.line));
    if (ok.every(Boolean)) pairs.push([isBye(a) ? null : a, isBye(b) ? null : b]);
  }
  if (!errors.length && !isPow2(rows.length)) {
    const need = nextPow2(rows.length);
    errors.push({
      line: rows[rows.length - 1].line,
      message: `${rows.length} pairings — a bracket needs 1, 2, 4, 8, 16… Add ${need - rows.length} more “Name vs BYE” line${need - rows.length === 1 ? '' : 's'}.`,
    });
  }
  if (!errors.length && pairs.length > 128) errors.push({ line: 0, message: `${pairs.length} pairings — the limit is 128.` });
  if (errors.length) return { mode: 'pairs', names: [], pairs: null, errors: sortErrors(errors) };
  return { mode: 'pairs', names: pairs.flat().filter((n): n is string => !!n), pairs, errors };
}

const sortErrors = (e: FeedError[]) => e.sort((x, y) => x.line - y.line);

/* ---------- building and resolving ---------- */

/**
 * The full bracket for these players. Match ids are `${idPrefix}-${round}-${index}` when a
 * prefix is given (server commands: deterministic), else random (demo data).
 */
export function buildBracket(players: Player[], pairs?: [string | null, string | null][] | null, idPrefix?: string): Match[] {
  let first: [string | null, string | null][];
  if (pairs) {
    first = pairs;
  } else {
    const size = Math.max(2, nextPow2(players.length));
    const bySeed = [...players].sort((x, y) => x.seed - y.seed);
    const order = seedOrder(size);
    first = [];
    for (let i = 0; i < size; i += 2) first.push([bySeed[order[i] - 1]?.id ?? null, bySeed[order[i + 1] - 1]?.id ?? null]);
  }
  const id = (r: number, i: number) => (idPrefix ? `${idPrefix}-${r}-${i}` : uid());
  const matches = first.map(([a, b], i) => blank(id(0, i), 0, i, a, b));
  const rounds = Math.log2(first.length * 2);
  for (let r = 1; r < rounds; r++) for (let i = 0; i < first.length / 2 ** r; i++) matches.push(blank(id(r, i), r, i, null, null));
  return resolve(matches).matches;
}

/**
 * Push winners forward and auto-advance first-round byes. A pending match simply takes its
 * new participants. A match that has started (live or done) is never re-pointed at different
 * players: it is left as it was and reported in `disturbed`, and the caller must reject the
 * change (audit §6.16) — e.g. undoing a result whose next match is already being played.
 */
export function resolve(input: Match[]): { matches: Match[]; disturbed: Match[] } {
  const m = input.map((x) => ({ ...x }));
  const at = new Map(m.map((x) => [`${x.round}:${x.index}`, x]));
  const disturbed: Match[] = [];
  const rounds = roundCount(m);
  for (let r = 0; r < rounds; r++) {
    for (const x of m.filter((x) => x.round === r)) {
      if (r === 0) {
        if (!!x.a !== !!x.b && x.status === 'pending') Object.assign(x, { winner: x.a ?? x.b, status: 'done', bye: true });
        continue;
      }
      const a = at.get(`${r - 1}:${x.index * 2}`)?.winner ?? null;
      const b = at.get(`${r - 1}:${x.index * 2 + 1}`)?.winner ?? null;
      if (a === x.a && b === x.b) continue;
      if (x.status !== 'pending') {
        disturbed.push(x);
        continue;
      }
      Object.assign(x, { a, b });
    }
  }
  return { matches: m, disturbed };
}

export const roundCount = (m: Match[]) => (m.length ? Math.max(...m.map((x) => x.round)) + 1 : 0);

export function roundName(r: number, total: number) {
  const left = total - r;
  if (left === 1) return 'Final';
  if (left === 2) return 'Semifinals';
  if (left === 3) return 'Quarterfinals';
  return `Round of ${2 ** left}`;
}

export function matchNo(m: Match, all: Match[]) {
  return all.filter((x) => x.round < m.round || (x.round === m.round && x.index < m.index)).length + 1;
}

export function nextOf(m: Match, all: Match[]) {
  return all.find((x) => x.round === m.round + 1 && x.index === Math.floor(m.index / 2));
}

/** Undo a result / cancel a live match — allowed only while the follow-on match hasn't started. */
export function canUndo(m: Match, all: Match[]) {
  const n = nextOf(m, all);
  return m.status !== 'pending' && !m.bye && (m.status === 'live' || !n || n.status === 'pending');
}

/* ---------- the call queue ---------- */

export interface QueueItem {
  match: Match;
  since: string; // when both players became available
}

export interface Queue {
  live: Match[];
  ready: QueueItem[]; // both players checked in, not playing — call these next, in order
  waiting: { match: Match; missing: string[] }[]; // opponent known but someone hasn't checked in
  upcoming: Match[]; // waiting on another match's result
  freeStations: number[];
  champion: string | null;
}

/**
 * Who should play next. A match is ready when both players are known and checked in.
 * Ready matches are called earliest round first (keeps the bracket moving evenly),
 * then by who has been waiting longest, then bracket order.
 */
export function computeQueue(day: MatchDay): Queue {
  const { matches, checkIn } = day;
  const played = matches.filter((m) => m.status === 'done' && !m.bye);
  const availableSince = (pid: string) => {
    const ends = played.filter((m) => m.a === pid || m.b === pid).map((m) => m.endedAt ?? '');
    return [checkIn[pid] ?? '', ...ends].sort().pop() ?? '';
  };

  const live = matches.filter((m) => m.status === 'live').sort((x, y) => (x.station ?? 0) - (y.station ?? 0));
  const busy = new Set(live.flatMap((m) => [m.a, m.b]));
  const open = matches.filter((m) => m.status === 'pending' && m.a && m.b);
  const ready = open
    .filter((m) => checkIn[m.a!] && checkIn[m.b!] && !busy.has(m.a) && !busy.has(m.b))
    .map((match) => ({ match, since: [availableSince(match.a!), availableSince(match.b!)].sort().pop()! }))
    .sort((x, y) => x.match.round - y.match.round || x.since.localeCompare(y.since) || x.match.index - y.match.index);
  const waiting = open
    .filter((m) => !checkIn[m.a!] || !checkIn[m.b!])
    .map((match) => ({ match, missing: [match.a!, match.b!].filter((p) => !checkIn[p]) }));
  const upcoming = matches.filter((m) => m.status === 'pending' && m.round > 0 && !!m.a !== !!m.b);

  const used = new Set(live.map((m) => m.station));
  const freeStations = Array.from({ length: day.stations }, (_, i) => i + 1).filter((s) => !used.has(s));
  const final = matches.find((m) => m.round === roundCount(matches) - 1);

  return { live, ready, waiting, upcoming, freeStations, champion: final?.winner ?? null };
}
