/*
 * HQ roster import: turns an uploaded CSV, a fetched sheet or a pasted list into players per
 * campaign store, ready for 'bracket.load'. Pure and Node-loadable (the HQ page + tests).
 *
 *   parseTable   CSV / TSV / semicolon text → rows of cells (quotes, BOM, CRLF, ragged rows)
 *   parseRoster  rows → columns → stores → Player[] per store, with errors and warnings
 *   diffRoster   what loading a list would change against a store's current players
 *
 * Row numbers are the sheet's own (1 = the header row, when there is one). For pasted text
 * that is also the line number, unless a quoted cell has a line break inside it.
 * Player ids come from playerIdFor(phone, name), so re-importing keeps ids — and check-ins.
 * An IGN / gamertag column is kept on the player (Player.ign); it never changes the id. Columns
 * that aren't recognised (Email, Discord…) are not read at all — RosterParse.ignored names them.
 */
import type { MatchDay, Player, Store } from './types.ts';
import { cleanIgn, isPhone, MAX_IGN, maskPhone, normalizePhone, playerIdFor } from './phone.ts';

/* ---------- delimited text ---------- */

export type Delimiter = ',' | ';' | '\t';

export interface Table {
  rows: string[][]; // rows[i] is sheet row i + 1 (cells trimmed); blank rows are kept so numbering holds
  delimiter: Delimiter | null; // null = a single column
  unclosedQuote?: number; // row where a quote was opened and never closed (the rest became one cell)
}

/** Parse delimited text. Without a delimiter it is detected from the first rows. */
export function parseTable(text: string, delimiter?: Delimiter | null): Table {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const d = delimiter === undefined ? detectDelimiter(src) : delimiter;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false; // this cell started with a quote
  let inQ = false;
  let openedAt = 0;
  const endCell = () => {
    row.push(cell.trim());
    cell = '';
    quoted = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c !== '"') cell += c;
      else if (src[i + 1] === '"') {
        cell += '"';
        i++;
      }
      else inQ = false;
    } else if (c === '"' && !quoted && !cell.trim()) {
      inQ = quoted = true;
      cell = '';
      openedAt = rows.length + 1;
    } else if (d && c === d) endCell();
    else if (c === '\n' || c === '\r') {
      endRow();
      if (c === '\r' && src[i + 1] === '\n') i++;
    } else cell += c;
  }
  if (cell || quoted || row.length) endRow();
  return inQ ? { rows, delimiter: d, unclosedQuote: openedAt } : { rows, delimiter: d };
}

/**
 * The delimiter of the first rows: the one (outside quotes) on the most lines — at least half —
 * then the one whose count agrees on the most lines. Ties go to tab, then comma, then semicolon.
 */
export function detectDelimiter(src: string): Delimiter | null {
  const cands: Delimiter[] = ['\t', ',', ';'];
  const counts: number[][] = [];
  let cur = [0, 0, 0];
  let inQ = false;
  let content = false; // the line has something besides delimiters and spaces
  const flush = () => {
    if (content) counts.push(cur);
    cur = [0, 0, 0];
    content = false;
  };
  for (let i = 0; i < src.length && counts.length < 30; i++) {
    const c = src[i];
    if (c === '"') inQ = !inQ;
    if (inQ || c === '"') {
      content = true;
      continue;
    }
    const k = cands.indexOf(c as Delimiter);
    if (k >= 0) cur[k]++;
    else if (c === '\n' || c === '\r') flush();
    else if (c.trim()) content = true;
  }
  flush();
  if (!counts.length) return null;
  let best: Delimiter | null = null;
  let bestScore = 0;
  cands.forEach((d, k) => {
    // Lines that use it (ragged rows may have fewer), then how many agree on the count.
    const freq = new Map<number, number>();
    for (const line of counts) if (line[k] > 0) freq.set(line[k], (freq.get(line[k]) ?? 0) + 1);
    const used = counts.filter((line) => line[k] > 0).length;
    let agree = 0;
    for (const f of freq.values()) agree = Math.max(agree, f);
    const score = used * 1000 + agree;
    if (score > bestScore && used >= Math.ceil(counts.length / 2)) {
      best = d;
      bestScore = score;
    }
  });
  return best;
}

/* ---------- columns ---------- */

export type ColumnKey = 'name' | 'first' | 'last' | 'phone' | 'seed' | 'store' | 'city' | 'ign' | 'team';
export type Columns = Partial<Record<ColumnKey, number>>;

// Exact matches on the header with case, spacing, punctuation and "(…)" removed.
const SYNONYMS: [ColumnKey, string[]][] = [
  ['store', ['store', 'storename', 'venue', 'venuename', 'location', 'storelocation', 'outlet', 'branch', 'shop']],
  ['city', ['city', 'town']],
  ['team', ['team', 'teamname', 'clan', 'squad']],
  ['ign', ['ign', 'ingamename', 'ingameid', 'ingameusername', 'ingamenick', 'gamertag', 'gamename', 'gameid', 'gamerid', 'gamerhandle', 'handle', 'username', 'nickname', 'nick', 'riotid', 'riotname', 'steamid', 'steamname', 'steamusername', 'epicid', 'epicname', 'epicusername', 'battletag', 'psnid', 'xboxgamertag']],
  ['seed', ['seed', 'seeding', 'seedno', 'seednumber', 'rank', 'ranking']],
  ['phone', ['phone', 'phonenumber', 'phoneno', 'mobile', 'mobilenumber', 'mobileno', 'contact', 'contactnumber', 'contactno', 'whatsapp', 'whatsappnumber', 'whatsappno', 'number', 'cell', 'telephone']],
  ['first', ['firstname', 'givenname']],
  ['last', ['lastname', 'surname', 'familyname']],
  ['name', ['name', 'player', 'playername', 'fullname', 'participant', 'participantname', 'playerfullname', 'nameofplayer', 'nameoftheplayer', 'yourname', 'entrant']],
];
// Second pass for headers like "Your full name" or "WhatsApp number (for updates)": any wanted
// word ("game name" = both words) and none of the unwanted ones. Email / Discord are never read.
const NEVER = ['email', 'mail', 'discord'];
const WORDS: [ColumnKey, string[], string[]][] = [
  ['store', ['store', 'venue', 'outlet', 'branch', 'location'], NEVER],
  ['seed', ['seed', 'rank'], NEVER],
  ['phone', ['phone', 'mobile', 'whatsapp', 'contact'], ['name', ...NEVER]],
  ['ign', ['ign', 'gamertag', 'username', 'nickname', 'ingame', 'game name', 'game id', 'game tag'], ['team', 'clan', 'store', 'venue', ...NEVER]],
  ['name', ['name'], ['store', 'team', 'game', 'venue', 'city', 'user', 'nick', 'first', 'last', 'father', 'parent', 'guardian', 'school', 'college', 'emergency', 'ign', 'steam', 'riot', 'epic', ...NEVER]],
];

export const headerKey = (h: string) => h.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
export const headerWords = (h: string) => h.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const hasWords = (words: string[], list: string[]) => list.some((w) => w.split(' ').every((x) => words.includes(x)));

/**
 * Which header cell is which column. Unknown headers are ignored. A list with an IGN / Username
 * column but no Name column uses it as the names (`nameFromIgn`) — that's what players go by there.
 */
export function detectColumns(header: string[]): { columns: Columns; duplicates: [ColumnKey, number][]; nameFromIgn?: boolean } {
  const columns: Columns = {};
  const duplicates: [ColumnKey, number][] = [];
  const taken = new Set<number>();
  header.forEach((h, i) => {
    const key = headerKey(h);
    if (!key) return;
    const hit = SYNONYMS.find(([, syn]) => syn.includes(key));
    if (!hit) return;
    taken.add(i);
    if (columns[hit[0]] === undefined) columns[hit[0]] = i;
    else duplicates.push([hit[0], i]);
  });
  for (const [k, want, not] of WORDS) {
    if (columns[k] !== undefined) continue;
    const i = header.findIndex((h, j) => !taken.has(j) && hasWords(headerWords(h), want) && !hasWords(headerWords(h), not));
    if (i >= 0) {
      columns[k] = i;
      taken.add(i);
    }
  }
  if (!hasName(columns) && columns.ign !== undefined) {
    columns.name = columns.ign;
    delete columns.ign;
    return { columns, duplicates, nameFromIgn: true };
  }
  return { columns, duplicates };
}

/** How a column is named to HQ ("Two in-game name columns", "IGN → in-game name"). */
export const COLUMN_LABEL: Record<ColumnKey, string> = { name: 'name', first: 'first name', last: 'last name', phone: 'phone', seed: 'seed', store: 'store', city: 'city', ign: 'in-game name', team: 'team' };

const hasName = (c: Columns) => c.name !== undefined || c.first !== undefined;

/* ---------- stores ---------- */

export type StoreRef = Pick<Store, 'id' | 'name' | 'city'>;
export type StoreMatch = { store: StoreRef } | { ambiguous: StoreRef[] } | { none: true };

const norm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function candidates(part: string, stores: StoreRef[]): StoreRef[] {
  const v = norm(part);
  if (!v) return [];
  const exact = stores.filter((s) => norm(s.name) === v);
  if (exact.length) return exact;
  if (v.length >= 3) {
    // whole words inside the store name, or the store name inside the value
    const sub = stores.filter((s) => {
      const n = norm(s.name);
      return n && (` ${n} `.includes(` ${v} `) || ` ${v} `.includes(` ${n} `));
    });
    if (sub.length) return sub;
  }
  const city = stores.filter((s) => s.city && norm(s.city) === v);
  if (city.length) return city;
  // "San Infotech Nashik", "ROG Nashik": every word is in the store's name or city.
  const words = v.split(' ');
  if (words.length < 2) return [];
  return stores.filter((s) => {
    const own = new Set(`${norm(s.name)} ${norm(s.city ?? '')}`.split(' '));
    return words.every((w) => own.has(w));
  });
}

/**
 * Which campaign store a sheet's store / city text means: "San Infotech" ⊂ "ASUS ROG Exclusive
 * Store — San Infotech", or the city. "San Infotech, Nashik" is matched part by part (each part
 * narrows the candidates).
 */
export function matchStore(value: string, stores: StoreRef[]): StoreMatch {
  let found = candidates(value, stores);
  if (!found.length) {
    const parts = value.split(/\s*(?:[,|/·•]|\s[-–—]\s)\s*/).filter((p) => norm(p));
    if (parts.length > 1) {
      let set: StoreRef[] | null = null;
      for (const p of parts) {
        const c = candidates(p, stores);
        if (!c.length) continue;
        set = set ? set.filter((s) => c.includes(s)) : c;
      }
      found = set ?? [];
    }
  }
  if (found.length === 1) return { store: found[0] };
  return found.length ? { ambiguous: found } : { none: true };
}

/* ---------- the roster ---------- */

export interface RosterIssue {
  line: number; // sheet row; 0 = the list as a whole
  message: string;
}
export interface RosterEntry {
  line: number;
  player: Player; // with its in-game name (player.ign) when the list has one
  team?: string; // display-only
}
export interface StoreRoster {
  storeId: string;
  storeName: string;
  players: Player[]; // seed order, seeds 1..n — what goes into players.set / bracket.load
  entries: RosterEntry[]; // the same players with their sheet row and display-only extras
  errors: RosterIssue[]; // any error and this store isn't loaded
  warnings: RosterIssue[];
  questions: RosterQuestion[]; // duplicates HQ still has to decide on — the store isn't loaded until answered
  ready: boolean; // no errors, no open questions, and 2–256 players
}

/**
 * Two rows with the same phone number (or the same name): HQ picks which one it is, or keeps both.
 * Answer with `answers[key] = <row number to keep>` or `'all'`.
 */
export interface RosterQuestion {
  key: string; // stable while the list is the same: "<storeId>:phone:<digits>" / "<storeId>:name:<name>"
  kind: 'phone' | 'name';
  storeId: string;
  title: string; // "Same number •••• •• 1111 on rows 4 and 9 — which one is it?"
  options: { line: number; name: string; phone?: string; ign?: string }[];
  both: string; // label for keeping every row
}

/** A question's answer: the sheet row to keep, or 'all' to keep every row. */
export type RosterAnswer = number | 'all';
export interface RosterParse {
  kind: 'table' | 'list' | 'empty'; // table = has a header row
  delimiter: Delimiter | null;
  columns: Partial<Record<ColumnKey, string>>; // header text per column used
  ignored: string[]; // header text of the columns not read (Email, Discord…) — nothing in them is kept
  stores: StoreRoster[]; // campaign scope: every store, in the order given; single scope: that store
  errors: RosterIssue[]; // the list as a whole, and rows that can't be placed in a store
  warnings: RosterIssue[];
  rows: number; // non-blank data rows read
}
export interface RosterOptions {
  stores: StoreRef[]; // the campaign's stores
  storeId?: string | null; // a single store: a store column then only filters rows
  answers?: Record<string, RosterAnswer>; // HQ's answers to duplicate questions (RosterQuestion.key)
}

export const MAX_PLAYERS = 256;
const MAX_NAME = 80;
const NUMBERING = /^\s*\d+\s*[.)]\s+/; // "1. Asha" in a pasted list

const rowsList = (lines: number[]) => (lines.length === 1 ? `Row ${lines[0]}` : `Rows ${lines.slice(0, 8).join(', ')}${lines.length > 8 ? ` and ${lines.length - 8} more` : ''}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Row {
  line: number;
  cells: string[];
}

/** Parse a roster for a campaign. Nothing is thrown: every problem is an error or warning with its row. */
export function parseRoster(text: string, opts: RosterOptions): RosterParse {
  const table = parseTable(text);
  const errors: RosterIssue[] = [];
  const warnings: RosterIssue[] = [];
  const single = opts.storeId ? opts.stores.find((s) => s.id === opts.storeId) : undefined;
  const scope = single ? [single] : opts.stores;
  const out: RosterParse = { kind: 'empty', delimiter: table.delimiter, columns: {}, ignored: [], stores: [], errors, warnings, rows: 0 };
  if (opts.storeId && !single) {
    errors.push({ line: 0, message: 'That store isn’t in this campaign any more.' });
    return out;
  }
  if (table.unclosedQuote) warnings.push({ line: table.unclosedQuote, message: 'A quote (") opened here is never closed — everything after it was read as one cell.' });

  const all: Row[] = table.rows.map((cells, i) => ({ line: i + 1, cells })).filter((r) => r.cells.some(Boolean));
  if (!all.length) return out;

  // Header row, or a bare list?
  const first = all[0];
  const det = detectColumns(first.cells);
  let cols = det.columns;
  let data: Row[];
  const known = Object.keys(cols).length;
  if (hasName(cols) || known >= 2) {
    out.kind = 'table';
    data = all.slice(1);
    for (const [k, i] of Object.entries(cols) as [ColumnKey, number][]) out.columns[k] = first.cells[i];
    const used = new Set(Object.values(cols));
    out.ignored = first.cells.filter((h, i) => h && !used.has(i));
    for (const [k, i] of det.duplicates) warnings.push({ line: first.line, message: `Two ${COLUMN_LABEL[k]} columns — using “${first.cells[cols[k]!]}”, ignoring “${first.cells[i]}”.` });
    if (det.nameFromIgn) warnings.push({ line: first.line, message: `No Name column — using “${first.cells[cols.name!]}” as the player names.` });
    if (!hasName(cols)) {
      errors.push({ line: first.line, message: 'No name column. Call the column with player names “Name” (or “Player”).' });
      return { ...out, rows: data.length };
    }
  } else {
    out.kind = 'list';
    data = all;
    cols = guessColumns(all);
    if (cols.phone !== undefined) warnings.push({ line: 0, message: `No header row — read column ${cols.name! + 1} as names and column ${cols.phone + 1} as phone numbers. A header row (Name, Phone, Store) makes this certain.` });
    else if (table.delimiter && all.some((r) => r.cells.length > 1)) warnings.push({ line: 0, message: `No header row — read column ${cols.name! + 1} as names and ignored the rest. Add a header row (Name, Phone, Store) to use the other columns.` });
  }
  out.rows = data.length;
  if (!data.length) {
    errors.push({ line: 0, message: 'The header is there but no players under it.' });
    return out;
  }

  // Rows → stores.
  const byStore = new Map<string, Row[]>(scope.map((s) => [s.id, []]));
  const storeCell = (r: Row) => [cols.store, cols.city].map((i) => (i === undefined ? '' : (r.cells[i] ?? '').trim())).filter(Boolean).join(', ');
  const hasStoreCol = cols.store !== undefined || cols.city !== undefined;
  if (!hasStoreCol) {
    if (scope.length === 1) byStore.get(scope[0].id)!.push(...data);
    else if (!scope.length) errors.push({ line: 0, message: 'This campaign has no stores yet.' });
    else {
      errors.push({ line: 0, message: `There’s no Store column, so this list can’t be split between ${scope.length} stores. Add a Store column (store name or city), or choose a single store.` });
      return out;
    }
  } else {
    const cache = new Map<string, StoreMatch>();
    const problems = new Map<string, { lines: number[]; message: string }>();
    const problem = (key: string, line: number, message: string) => {
      const p = problems.get(key) ?? { lines: [], message };
      p.lines.push(line);
      problems.set(key, p);
    };
    let elsewhere = 0;
    let placed = 0; // rows whose store cell names a campaign store
    for (const r of data) {
      const v = storeCell(r);
      if (!v) {
        if (single) byStore.get(single.id)!.push(r);
        else problem('', r.line, 'no store given');
        continue;
      }
      const k = norm(v);
      if (!cache.has(k)) cache.set(k, matchStore(v, opts.stores));
      const m = cache.get(k)!;
      if ('store' in m) {
        placed++;
        if (byStore.has(m.store.id)) byStore.get(m.store.id)!.push(r);
        else elsewhere++;
      } else if ('ambiguous' in m) problem(k, r.line, `“${v}” matches ${m.ambiguous.length} stores (${m.ambiguous.map((s) => s.name).join('; ')}) — use more of the store name`);
      else problem(k, r.line, `“${v}” doesn’t match any store in this campaign`);
    }
    if (single && !placed && problems.size) {
      // On one store's page, a Store column that names no store of the campaign at all
      // ("ROG Nashik" for "ASUS ROG Exclusive Store — San Infotech") isn't a filter: every row is this store's.
      const seen = [...new Set(data.map(storeCell).filter(Boolean))];
      byStore.set(single.id, [...data]);
      warnings.push({ line: 0, message: `The ${cols.store !== undefined ? 'Store' : 'City'} column (${seen.slice(0, 2).map((v) => `“${v}”`).join(', ')}${seen.length > 2 ? ' …' : ''}) doesn’t name a store in this campaign — read every row as ${single.name}’s.` });
      problems.clear();
    }
    for (const p of problems.values()) {
      const issue = { line: p.lines[0], message: `${rowsList(p.lines)}: ${p.message}${single ? ' — skipped.' : '.'}` };
      (single ? warnings : errors).push(issue);
    }
    if (elsewhere) warnings.push({ line: 0, message: `Skipped ${plural(elsewhere, 'row')} for other stores.` });
  }

  out.stores = scope.map((s) => buildStore(s, byStore.get(s.id)!, cols, out.kind === 'list', !!single || !hasStoreCol, opts.answers ?? {}));
  return out;
}

/** A headerless table: a column that is mostly phone numbers is the phone; the first other text column is the name. */
function guessColumns(rows: Row[]): Columns {
  const width = Math.max(...rows.map((r) => r.cells.length));
  const share = (i: number, test: (c: string) => boolean) => {
    const cells = rows.map((r) => r.cells[i] ?? '').filter(Boolean);
    return cells.length ? cells.filter(test).length / cells.length : 0;
  };
  const phoneLike = (c: string) => /^[\d\s+().-]+$/.test(c) && isPhone(c);
  let phone: number | undefined;
  for (let i = 0; i < width; i++) if (share(i, phoneLike) >= 0.6 && (phone === undefined || share(i, phoneLike) > share(phone, phoneLike))) phone = i;
  let name = 0;
  for (let i = 0; i < width; i++)
    if (i !== phone && share(i, (c) => /[a-z]/i.test(c)) >= 0.5) {
      name = i;
      break;
    }
  return phone === undefined ? { name } : { name, phone };
}

function parseSeed(cell: string): number | null {
  const m = /^#?\s*(\d+)(?:\.0+)?\s*(?:st|nd|rd|th)?\.?$/i.exec(cell.trim());
  return m ? Number(m[1]) : null;
}

type Candidate = { line: number; name: string; phone?: string; seed: number | null; ign?: string; team?: string; shared?: boolean };
const option = (c: Candidate) => (c.ign ? { line: c.line, name: c.name, phone: c.phone, ign: c.ign } : { line: c.line, name: c.name, phone: c.phone });

const nameKey = (name: string) => name.toLowerCase();
const groupBy = <T,>(list: T[], key: (t: T) => string | undefined) => {
  const m = new Map<string, T[]>();
  for (const t of list) {
    const k = key(t);
    if (k === undefined) continue;
    m.set(k, [...(m.get(k) ?? []), t]);
  }
  return m;
};
const lineList = (cs: Candidate[]) => {
  const l = cs.map((c) => c.line);
  return l.length === 2 ? `rows ${l[0]} and ${l[1]}` : `rows ${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
};

/**
 * Duplicates → questions. Same phone first (two names on one number), then same name among what's
 * left (one name, two numbers). Unanswered groups are held out of the roster until HQ decides.
 */
function resolveDuplicates(store: StoreRef, cands: Candidate[], answers: Record<string, RosterAnswer>, questions: RosterQuestion[]): Candidate[] {
  let kept = cands;
  for (const [phone, group] of groupBy(kept, (c) => c.phone)) {
    if (group.length < 2) continue;
    const key = `${store.id}:phone:${phone}`;
    const ans = answers[key];
    if (ans === 'all') {
      for (const c of group) c.shared = true;
      continue;
    }
    if (typeof ans === 'number' && group.some((c) => c.line === ans)) {
      kept = kept.filter((c) => !group.includes(c) || c.line === ans);
      continue;
    }
    questions.push({
      key,
      kind: 'phone',
      storeId: store.id,
      title: `Same number ${maskPhone(phone)} on ${lineList(group)} — which one is it?`,
      options: group.map(option),
      both: 'Both — they share this number (they’ll check in at the desk, not by QR)',
    });
    kept = kept.filter((c) => !group.includes(c));
  }
  for (const [nk, group] of groupBy(kept, (c) => nameKey(c.name))) {
    if (group.length < 2) continue;
    const key = `${store.id}:name:${nk}`;
    const ans = answers[key];
    if (ans === 'all') {
      const taken = new Set(kept.map((c) => nameKey(c.name)));
      group.slice(1).forEach((c) => {
        let n = 2;
        while (taken.has(nameKey(`${c.name} (${n})`))) n++;
        c.name = `${c.name} (${n})`;
        taken.add(nameKey(c.name));
      });
      continue;
    }
    if (typeof ans === 'number' && group.some((c) => c.line === ans)) {
      kept = kept.filter((c) => !group.includes(c) || c.line === ans);
      continue;
    }
    questions.push({
      key,
      kind: 'name',
      storeId: store.id,
      title: `Two players called “${group[0].name}” (${lineList(group)}) — which one is it?`,
      options: group.map(option),
      both: `Both — different people (the second becomes “${group[0].name} (2)”)`,
    });
    kept = kept.filter((c) => !group.includes(c));
  }
  return kept;
}

function buildStore(store: StoreRef, rows: Row[], cols: Columns, list: boolean, required: boolean, answers: Record<string, RosterAnswer>): StoreRoster {
  const errors: RosterIssue[] = [];
  const warnings: RosterIssue[] = [];
  const questions: RosterQuestion[] = [];
  const cell = (r: Row, k: ColumnKey) => (cols[k] === undefined ? '' : (r.cells[cols[k]!] ?? '').trim());
  const byId = new Map<string, number>();
  const seedLine = new Map<number, number>();
  const noPhone: number[] = [];
  const cands: Candidate[] = [];
  const exact = new Map<string, number>(); // name+phone → first row: a repeated row is kept once
  const taken: { id: string; line: number; name: string; phone?: string; seed: number | null; ign?: string; team?: string }[] = [];

  for (const r of rows) {
    let name = cols.name !== undefined ? cell(r, 'name') : [cell(r, 'first'), cell(r, 'last')].filter(Boolean).join(' ');
    if (list) name = name.replace(NUMBERING, '');
    name = name.replace(/\s+/g, ' ').trim();
    const rawPhone = cell(r, 'phone');
    const rawSeed = cell(r, 'seed');
    const err = (message: string) => errors.push({ line: r.line, message });
    if (!name) {
      err('No name.');
      continue;
    }
    if (name.length > MAX_NAME) {
      err(`“${name.slice(0, 24)}…” is longer than ${MAX_NAME} characters.`);
      continue;
    }
    if (/^[\d\s+().-]+$/.test(name) && isPhone(name)) {
      err(`“${maskPhone(normalizePhone(name))}” in the name column looks like a phone number — are the columns swapped?`);
      continue;
    }
    let phone: string | undefined;
    if (rawPhone) {
      if (!isPhone(rawPhone)) {
        err(/e\+?\d/i.test(rawPhone) ? `${name}: “${rawPhone}” — the spreadsheet turned this phone into a number. Format the column as plain text and export again.` : `${name}: “${rawPhone}” isn’t a phone number.`);
        continue;
      }
      phone = normalizePhone(rawPhone);
    }
    let seed: number | null = null;
    if (rawSeed) {
      seed = parseSeed(rawSeed);
      if (!seed || seed < 1) {
        err(`${name}: seed “${rawSeed}” must be a whole number from 1.`);
        continue;
      }
    }
    let ign: string | undefined = cleanIgn(cell(r, 'ign')) || undefined;
    if (ign && ign.length > MAX_IGN) {
      warnings.push({ line: r.line, message: `${name}: in-game name “${ign.slice(0, 24)}…” is longer than ${MAX_IGN} characters — left out.` });
      ign = undefined;
    }
    if (ign && nameKey(ign) === nameKey(name)) ign = undefined; // the same as the name: nothing to add
    const ek = `${nameKey(name)}|${phone ?? ''}`;
    if (exact.has(ek)) {
      warnings.push({ line: r.line, message: `Row ${r.line} repeats row ${exact.get(ek)} (${name}) — kept once.` });
      continue;
    }
    exact.set(ek, r.line);
    cands.push({ line: r.line, name, phone, seed, ign, team: cell(r, 'team') || undefined });
  }

  for (const c of resolveDuplicates(store, cands, answers, questions)) {
    const err = (message: string) => errors.push({ line: c.line, message });
    if (c.seed && seedLine.has(c.seed)) {
      err(`${c.name}: seed ${c.seed} is also given on row ${seedLine.get(c.seed)} (rows ${seedLine.get(c.seed)} and ${c.line}).`);
      continue;
    }
    // Players sharing a number need ids that don't come from that number alone.
    const id = c.shared ? playerIdFor(undefined, `${c.phone} ${c.name}`) : playerIdFor(c.phone, c.name);
    if (byId.has(id)) {
      err(`${c.name} clashes with row ${byId.get(id)} (rows ${byId.get(id)} and ${c.line}) — change one of the names slightly.`);
      continue;
    }
    if (!c.phone) noPhone.push(c.line);
    if (c.seed) seedLine.set(c.seed, c.line);
    byId.set(id, c.line);
    taken.push({ id, line: c.line, name: c.name, phone: c.phone, seed: c.seed, ign: c.ign, team: c.team });
  }

  // Seeds: given ones first (in seed order), the rest after them in sheet order; renumbered 1..n.
  const seeded = taken.filter((t) => t.seed !== null).sort((a, b) => a.seed! - b.seed!);
  const rest = taken.filter((t) => t.seed === null);
  if (seeded.length && rest.length) warnings.push({ line: 0, message: `${plural(rest.length, 'player')} without a seed ${rest.length === 1 ? 'goes' : 'go'} after the ${seeded.length} seeded, in sheet order.` });
  const entries: RosterEntry[] = [...seeded, ...rest].map((t, i) => {
    const player: Player = { id: t.id, name: t.name, seed: i + 1 };
    if (t.phone) player.phone = t.phone;
    if (t.ign) player.ign = t.ign;
    const e: RosterEntry = { line: t.line, player };
    if (t.team) e.team = t.team;
    return e;
  });

  if (noPhone.length && cols.phone !== undefined) warnings.push({ line: noPhone[0], message: `${rowsList(noPhone)}: no phone number — ${noPhone.length === 1 ? 'this player' : 'these players'} can’t check in with the QR (staff can still tick them in).` });
  else if (noPhone.length) warnings.push({ line: 0, message: 'No phone numbers — players can’t check themselves in with the QR (staff can still tick them in). Add a Phone column.' });

  if (entries.length > MAX_PLAYERS) errors.push({ line: 0, message: `${entries.length} players — a bracket holds at most ${MAX_PLAYERS}.` });
  else if (entries.length === 1 && !errors.length && !questions.length) errors.push({ line: 0, message: 'Only one player — a bracket needs at least 2.' });
  else if (!entries.length && !errors.length && !questions.length && required) errors.push({ line: 0, message: 'No players for this store in the list.' });
  else if (!entries.length && !errors.length && !questions.length) warnings.push({ line: 0, message: 'Not in this list.' });

  const players = entries.map((e) => e.player);
  errors.sort((x, y) => x.line - y.line);
  return { storeId: store.id, storeName: store.name, players, entries, errors, warnings, questions, ready: !errors.length && !questions.length && players.length >= 2 && players.length <= MAX_PLAYERS };
}

/** Stores that would be loaded: none while the list as a whole has errors. */
export const readyStores = (p: RosterParse) => (p.errors.length ? [] : p.stores.filter((s) => s.ready));

/* ---------- comparing with what's loaded ---------- */

export interface RosterDiff {
  added: Player[];
  removed: Player[];
  renamed: { from: Player; to: Player }[]; // same phone, new spelling
  phoneChanged: { from: Player; to: Player }[]; // same name, new (or first) number → new id; a check-in doesn't carry over
  ignChanged: { from: Player; to: Player }[]; // same player, new / changed / removed in-game name (the id and check-in stay)
  reseeded: number; // players kept whose seed moved
  same: boolean;
}

export function diffRoster(current: Player[], next: Player[]): RosterDiff {
  const cur = new Map(current.map((p) => [p.id, p]));
  const nxt = new Map(next.map((p) => [p.id, p]));
  const renamed: RosterDiff['renamed'] = [];
  const ignChanged: RosterDiff['ignChanged'] = [];
  let reseeded = 0;
  for (const p of next) {
    const was = cur.get(p.id);
    if (!was) continue;
    if (was.name !== p.name) renamed.push({ from: was, to: p });
    if ((was.ign ?? '') !== (p.ign ?? '')) ignChanged.push({ from: was, to: p });
    if (was.seed !== p.seed) reseeded++;
  }
  let added = next.filter((p) => !cur.has(p.id));
  let removed = current.filter((p) => !nxt.has(p.id));
  const phoneChanged: RosterDiff['phoneChanged'] = [];
  const key = (p: Player) => p.name.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const to of added) {
    const from = removed.find((r) => key(r) === key(to));
    if (from) {
      phoneChanged.push({ from, to });
      removed = removed.filter((r) => r !== from);
    }
  }
  added = added.filter((a) => !phoneChanged.some((c) => c.to === a));
  return { added, removed, renamed, phoneChanged, ignChanged, reseeded, same: !added.length && !removed.length && !renamed.length && !phoneChanged.length && !ignChanged.length && !reseeded };
}

export type LoadStatus = 'create' | 'update' | 'unchanged' | 'started';

/** What pressing Load would do at a store — the same "under way" test as the bracket.load handler. */
export function loadStatus(day: MatchDay, players: Player[]): { status: LoadStatus; diff: RosterDiff } {
  const diff = diffRoster(day.players, players);
  if (day.matches.some((m) => !m.bye && m.status !== 'pending')) return { status: 'started', diff };
  if (!day.players.length) return { status: 'create', diff };
  return { status: diff.same && day.matches.length ? 'unchanged' : 'update', diff };
}

/** "+3 added · 1 removed · 2 renamed · 1 in-game name changed" — empty when nothing changes. */
export function diffSummary(d: RosterDiff): string {
  const parts: string[] = [];
  if (d.added.length) parts.push(`+${d.added.length} added`);
  if (d.removed.length) parts.push(`${d.removed.length} removed`);
  if (d.renamed.length) parts.push(`${d.renamed.length} renamed`);
  if (d.phoneChanged.length) parts.push(`${plural(d.phoneChanged.length, 'new phone number')}`);
  if (d.ignChanged.length) parts.push(`${plural(d.ignChanged.length, 'in-game name')} changed`);
  if (d.reseeded) parts.push(`${d.reseeded} reseeded`);
  return parts.join(' · ');
}

/**
 * The text of an uploaded file. Excel's "CSV UTF-8" has a BOM, its "Unicode Text" is UTF-16, and
 * its plain "CSV (Comma delimited)" is Windows-1252 — reading those as UTF-8 garbles names.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes); // keeps a UTF-8 BOM; parseTable drops it
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** A fetched "CSV" that is really a web page — a sheet that isn't shared or published. */
export const looksLikeHtml = (text: string) => /^\s*(?:\uFEFF)?\s*<(?:!doctype\s+html|html|head|body)\b/i.test(text);
