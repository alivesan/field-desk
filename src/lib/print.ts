import type { PrintFile, PrintKind, PrintSpec, Store, TournamentEvent } from './types.ts';
import { storeShortName } from './names.ts';
import { storeDate } from './recce.ts';

/*
 * Print files: the five collaterals per store, their labels and print instructions, and reading
 * HQ's weekly creatives sheet. HQ gets one Google Sheet each week: a tab per event date ("31-Oct"),
 * and in each tab a block per store — a row with the store's name in column A, then
 *
 *   standee | <drive link>      Poster | <link>      Pamphlet | <link>      Cheque | <link>      Cheque | <link>
 *
 * Everything here is pure (no I/O) and Node-loadable: the server reads the sheet (server/print.ts)
 * and hands rows to parsePrintSheet; the screens match the blocks to stores with matchPrintBlocks.
 */

export const PRINT_KINDS: PrintKind[] = ['standee', 'poster', 'pamphlet', 'chequeWinner', 'chequeRunnerUp'];

/** Labels, print sizes and copies the user gave; a campaign can override them (event.printSpec). */
export const PRINT_DEFAULTS: Record<PrintKind, { label: string } & PrintSpec> = {
  standee: { label: 'Standee', size: '6 × 3 ft', qty: 1 },
  poster: { label: 'A3 Poster', size: 'A3 (297 × 420 mm)', qty: 10 },
  pamphlet: { label: 'A5 Pamphlet', size: 'A5 (148 × 210 mm)', qty: 100 },
  chequeWinner: { label: 'Winner cheque', size: '2 × 1 ft', qty: 1 },
  chequeRunnerUp: { label: 'Runner-up cheque', size: '2 × 1 ft', qty: 1 },
};

export const isPrintKind = (v: unknown): v is PrintKind => typeof v === 'string' && (PRINT_KINDS as string[]).includes(v);

/** What a row of the sheet is called: the two cheques look alike until their file names say which is which. */
export type RowKind = 'standee' | 'poster' | 'pamphlet' | 'cheque';

/** One tab of the sheet as the server reads it: column A and column B of every row (links already picked out of hyperlinks). */
export interface PrintSheetTab {
  name: string;
  rows: { a: string; b: string }[];
}

export interface PrintBlock {
  label: string; // the store as written in the sheet
  files: PrintFile[];
  problems: string[];
}

export interface PrintSheetParse {
  tabs: { tab: string; date?: string; blocks: PrintBlock[] }[];
}

export interface PrintMatch {
  tab: string;
  date?: string;
  label: string;
  files: PrintFile[];
  problems: string[];
  storeId: string | null; // null: nothing close enough, or two stores fit equally well
  candidates: string[]; // store ids worth offering (just [storeId] for a clean match)
}

/* ---------- rows ---------- */

const KEYWORDS: Record<string, RowKind> = {
  standee: 'standee',
  standy: 'standee',
  standie: 'standee',
  poster: 'poster',
  pamphlet: 'pamphlet',
  pamplet: 'pamphlet',
  flyer: 'pamphlet',
  flier: 'pamphlet',
  leaflet: 'pamphlet',
  cheque: 'cheque',
  check: 'cheque',
  chq: 'cheque',
  cheq: 'cheque',
};
/** Words that may follow the keyword in a row label: "Poster A3", "Cheque 1", "Cheque - Winner". */
const QUALIFIER = /^(?:\d{1,2}|a\d|c|r|winner|runner|up|runnerup|champion|1st|2nd)$/;

/** The kind a row's label names ("standee", "Posters", "Flyer", "Cheque - C"), or null for anything else — including store names. */
export function kindOfRow(label: string): RowKind | null {
  const words = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length || words.length > 4) return null;
  const kw = (w: string): RowKind | undefined => (Object.hasOwn(KEYWORDS, w) ? KEYWORDS[w] : Object.hasOwn(KEYWORDS, w.replace(/s$/, '')) ? KEYWORDS[w.replace(/s$/, '')] : undefined);
  const at = words.findIndex((w) => kw(w));
  if (at < 0) return null;
  const kind = kw(words[at])!;
  return words.every((w, i) => i === at || QUALIFIER.test(w)) ? kind : null;
}

const ROW_NAME: Record<RowKind, string> = { standee: 'standee', poster: 'poster', pamphlet: 'pamphlet', cheque: 'cheque' };
const ROW_TITLE: Record<RowKind, string> = { standee: 'Standee', poster: 'Poster', pamphlet: 'Pamphlet', cheque: 'Cheque' };

/* ---------- Drive links ---------- */

/** The file id in a Google Drive file link (…/file/d/<id>/view, open?id=<id>, uc?id=<id>), or null. */
export function driveIdOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'drive.google.com' && host !== 'docs.google.com' && host !== 'drive.usercontent.google.com') return null;
  const fromPath = u.pathname.match(/\/(?:file|document|presentation|spreadsheets)\/(?:u\/\d+\/)?d\/([\w-]{20,})/)?.[1];
  const id = fromPath ?? ((u.pathname === '/open' || u.pathname === '/uc' || u.pathname === '/download') ? u.searchParams.get('id') : null);
  return id && /^[\w-]{20,}$/.test(id) ? id : null;
}

/** A Drive folder link — every file needs its own link, a folder can't be downloaded as one file. */
export function isDriveFolder(url: string): boolean {
  try {
    const u = new URL(String(url ?? '').trim());
    return u.hostname.toLowerCase() === 'drive.google.com' && /\/folders\/|\/drive\/(?:u\/\d+\/)?my-drive|\/drive\/mobile\/folders/.test(u.pathname);
  } catch {
    return false;
  }
}

const FOLDER_PROBLEM = 'That’s a folder — each file needs its own link';
const urlIn = (s: string) => s.match(/https?:\/\/[^\s<>"]+/i)?.[0] ?? '';

/* ---------- tabs ---------- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORDS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthOf = (w: string) => {
  const i = MONTHS.indexOf(w.slice(0, 3));
  return i >= 0 && (MONTH_WORDS[i].startsWith(w) || w === 'sept') ? i + 1 : 0;
};

/** The date a tab name stands for — "31-Oct", "01 Nov", "1st November", "Oct 31", "31/10", "31-10-2026" — as yyyy-mm-dd in `year` (day first, as in India); undefined if it isn't one. */
export function tabDate(name: string, year: number): string | undefined {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/(\d)(?:st|nd|rd|th)\b/g, '$1')
    .trim();
  let d = 0;
  let m = 0;
  let y = year;
  const yr = (v?: string) => (v ? (v.length === 2 ? 2000 + Number(v) : Number(v)) : year);
  let r = s.match(/(?:^|[^\d])(\d{1,2})[\s\-/.,]*([a-z]{3,9})\b(?:[\s\-/.,]*(\d{4}|\d{2})\b)?/);
  if (r && monthOf(r[2])) [d, m, y] = [Number(r[1]), monthOf(r[2]), yr(r[3])];
  else if ((r = s.match(/\b([a-z]{3,9})[\s\-/.,]*(\d{1,2})\b(?:[\s\-/.,]*(\d{4})\b)?/)) && monthOf(r[1])) [d, m, y] = [Number(r[2]), monthOf(r[1]), yr(r[3])];
  else if ((r = s.match(/(?:^|[^\d])(\d{1,2})[\-/.](\d{1,2})(?:[\-/.](\d{4}|\d{2}))?(?!\d)/))) [d, m, y] = [Number(r[1]), Number(r[2]), yr(r[3])];
  if (!d || !m) return undefined;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return undefined;
  return t.toISOString().slice(0, 10);
}

/* ---------- parsing the sheet ---------- */

interface RawItem {
  kind: RowKind;
  b: string;
}

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

function blockOf(label: string, items: RawItem[], extra: string[]): PrintBlock {
  const files: PrintFile[] = [];
  const problems = [...extra];
  for (const kind of ['standee', 'poster', 'pamphlet', 'cheque'] as RowKind[]) {
    const name = ROW_NAME[kind];
    const rows = items.filter((i) => i.kind === kind);
    const good: { driveId: string; url: string }[] = [];
    for (const row of rows) {
      const url = urlIn(row.b);
      if (!url) problems.push(`${ROW_TITLE[kind]}: no link`);
      else if (isDriveFolder(url)) problems.push(`${ROW_TITLE[kind]}: ${FOLDER_PROBLEM}`);
      else {
        const driveId = driveIdOf(url);
        if (driveId) good.push({ driveId, url });
        else problems.push(`${ROW_TITLE[kind]}: that isn’t a Google Drive file link`);
      }
    }
    if (kind !== 'cheque') {
      if (!rows.length) problems.push(`No ${name} link`);
      else if (good.length > 1) problems.push(`${good.length} ${name} links — using the first`);
      if (good.length) files.push({ kind, ...good[0] });
      continue;
    }
    // Both cheques look the same in the sheet; the first is taken as the winner's until their names say otherwise (resolveCheques).
    if (!rows.length) problems.push('No cheque links');
    else if (good.length === 1) problems.push('Only one cheque link — need a winner’s and a runner-up’s');
    else if (good.length > 2) problems.push(`${good.length} cheque links — using the first two`);
    good.slice(0, 2).forEach((g, i) => files.push({ kind: i === 0 ? 'chequeWinner' : 'chequeRunnerUp', ...g }));
  }
  return { label, files, problems };
}

/**
 * The sheet's tabs → one block per store. A row whose column A isn't a file kind and has no link
 * in column B starts a block; "Standee", "Poster", "Pamphlet" and two "Cheque" rows belong to it.
 * Blocks with no file rows at all (a title, a note) are left out. `year` completes tab names like "31-Oct".
 */
export function parsePrintSheet(tabs: PrintSheetTab[], year: number): PrintSheetParse {
  return {
    tabs: tabs.map((t) => {
      const blocks: PrintBlock[] = [];
      let cur: { label: string; items: RawItem[]; extra: string[] } | null = null;
      const close = () => {
        if (cur && cur.items.length) blocks.push(blockOf(cur.label, cur.items, cur.extra));
        cur = null;
      };
      for (const row of t.rows) {
        const a = clean(row.a);
        const b = clean(row.b);
        if (!a && !b) continue;
        const kind = kindOfRow(a);
        if (kind) {
          if (cur) (cur as { items: RawItem[] }).items.push({ kind, b });
        } else if (a && !urlIn(b)) {
          close();
          cur = { label: a, items: [], extra: [] };
        } else if (cur) {
          (cur as { extra: string[] }).extra.push(a ? `Unrecognised row “${a}” — ignored` : 'A link with no label — ignored');
        }
      }
      close();
      const date = tabDate(t.name, year);
      return { tab: t.name, ...(date ? { date } : {}), blocks };
    }),
  };
}

/* ---------- cheques ---------- */

/** Which cheque a Drive file name says it is: "…Cheque-C.jpg" winner (champion), "…Cheque-R.jpg" runner-up; null if it doesn't say. */
export function chequeRoleOf(name: string | undefined): 'chequeWinner' | 'chequeRunnerUp' | null {
  if (!name) return null;
  const base = name
    .replace(/\.[A-Za-z0-9]{2,5}$/, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim();
  if (/[-_\s.]r$/i.test(base)) return 'chequeRunnerUp';
  if (/[-_\s.]c$/i.test(base)) return 'chequeWinner';
  if (/runner|2nd/i.test(base)) return 'chequeRunnerUp';
  if (/champion|winner|1st/i.test(base)) return 'chequeWinner';
  return null;
}

const byKind = (a: PrintFile, b: PrintFile) => PRINT_KINDS.indexOf(a.kind) - PRINT_KINDS.indexOf(b.kind);
const isCheque = (f: PrintFile) => f.kind === 'chequeWinner' || f.kind === 'chequeRunnerUp';

/**
 * Settles which cheque is the winner's and which the runner-up's: by the Drive file names (-C / -R,
 * "champion", "winner", "runner…") where they say, else the sheet's order (first = winner, second =
 * runner-up). Returns the files in PRINT_KINDS order; other files pass through.
 */
export function resolveCheques(files: PrintFile[]): PrintFile[] {
  const cheques = files.filter(isCheque);
  const rest = files.filter((f) => !isCheque(f));
  let out: PrintFile[];
  if (cheques.length === 2) {
    const [x, y] = cheques;
    const [rx, ry] = [chequeRoleOf(x.name), chequeRoleOf(y.name)];
    const other = (r: 'chequeWinner' | 'chequeRunnerUp') => (r === 'chequeWinner' ? 'chequeRunnerUp' : 'chequeWinner');
    let kx: PrintKind = 'chequeWinner';
    if (rx && ry && rx !== ry) kx = rx;
    else if (rx && !ry) kx = rx;
    else if (!rx && ry) kx = other(ry);
    out = [{ ...x, kind: kx }, { ...y, kind: other(kx as 'chequeWinner' | 'chequeRunnerUp') }];
  } else out = cheques.map((f) => ({ ...f, kind: chequeRoleOf(f.name) ?? f.kind }));
  return [...rest, ...out].sort(byKind);
}

/* ---------- matching blocks to stores ---------- */

const STOP = new Set(['asus', 'rog', 'exclusive', 'store', 'stores', 'the', 'and', 'of', 'in', 'at']);
const words = (s: string | undefined) => [
  ...new Set(
    String(s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !STOP.has(w)),
  ),
];

/** Edit distance, giving up (returning max+1) once it is past `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      low = Math.min(low, cur[j]);
    }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How well one written word stands for a store's word: 1 identical, .9 a typo away, .7 a prefix ("info" of "infotech"), 0 otherwise. */
function wordScore(written: string, real: string): number {
  if (written === real) return 1;
  const shortest = Math.min(written.length, real.length);
  if (shortest < 4) return 0;
  const tol = Math.max(written.length, real.length) >= 7 ? 2 : 1;
  if (editDistance(written, real, tol) <= tol) return 0.9;
  if (real.startsWith(written) || written.startsWith(real)) return 0.7;
  return 0;
}

function storeScore(label: string[], store: Store): { score: number; ownCover: number } {
  if (!label.length) return { score: 0, ownCover: 0 };
  const own = [...new Set([...words(storeShortName(store.name)), ...words(store.city)])];
  const pool = [...own.map((w) => ({ w, own: true })), ...words(store.state).filter((w) => !own.includes(w)).map((w) => ({ w, own: false }))];
  const used = new Set<number>();
  let writtenHit = 0;
  let ownHit = 0;
  for (const word of label) {
    let best = 0;
    let at = -1;
    pool.forEach((p, i) => {
      const s = used.has(i) ? 0 : wordScore(word, p.w);
      if (s > best) [best, at] = [s, i];
    });
    if (at < 0) continue;
    used.add(at);
    writtenHit += best;
    if (pool[at].own) ownHit += best;
  }
  const ownCover = ownHit / Math.max(1, own.length);
  return { score: 0.6 * (writtenHit / label.length) + 0.4 * ownCover, ownCover };
}

const MATCH_MIN = 0.5;
/** At least this share of the store's own words must be in the block's name: one shared word ("Infotech") is a suggestion, not a match. */
const OWN_MIN = 0.4;
const AMBIGUOUS_WITHIN = 0.1;
const DATE_BONUS = 0.15;

/**
 * Which store each block of the sheet is for. The block's name (misspelt as it may be: "Shubham info
 * Bhubneshwar", "laptop hub byderabad") is compared word by word with each store's short name, city
 * and state, forgiving a typo or two; a store whose event date is the tab's date is preferred. Two
 * stores fitting about equally → storeId null with both in `candidates`, for HQ to pick.
 */
export function matchPrintBlocks(parse: PrintSheetParse, stores: Store[], event: TournamentEvent): PrintMatch[] {
  const mine = stores.filter((s) => s.eventId === event.id);
  const out: PrintMatch[] = [];
  for (const t of parse.tabs) {
    for (const b of t.blocks) {
      const label = words(b.label);
      const ranked = mine
        .map((s) => {
          const { score, ownCover } = storeScore(label, s);
          return { id: s.id, ownCover, score: score + (t.date && storeDate(s, event) === t.date ? DATE_BONUS : 0) };
        })
        .filter((r) => r.score > 0)
        .sort((x, y) => y.score - x.score);
      const best = ranked[0];
      const close = best ? ranked.filter((r) => best.score - r.score <= AMBIGUOUS_WITHIN && r.score >= MATCH_MIN) : [];
      let storeId: string | null = null;
      let candidates: string[];
      if (best && best.score >= MATCH_MIN && best.ownCover >= OWN_MIN && close.length === 1) [storeId, candidates] = [best.id, [best.id]];
      else if (close.length > 1) candidates = close.map((r) => r.id);
      else candidates = ranked.filter((r) => r.score >= 0.3).slice(0, 4).map((r) => r.id);
      out.push({ tab: t.tab, ...(t.date ? { date: t.date } : {}), label: b.label, files: b.files, problems: b.problems, storeId, candidates });
    }
  }
  return out;
}

/* ---------- names, specs, this week ---------- */

/** A file or folder name that is safe on Windows, macOS and in a Content-Disposition header. */
export function safeFileName(s: string, max = 120): string {
  const t = String(s ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
    .replace(/[. ]+$/, '');
  return t || 'file';
}

/** "<short name> - <label>.<ext>" — "Subham Infotech - A3 Poster.jpg". */
export function printFileName(store: Pick<Store, 'name'>, kind: PrintKind, ext: string): string {
  const e = String(ext ?? '').replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'jpg';
  return `${safeFileName(`${safeFileName(storeShortName(store.name), 100)} - ${PRINT_DEFAULTS[kind].label}`, 150)}.${e}`;
}

/** The label, print size and number of copies for a kind: the campaign's own where set, else PRINT_DEFAULTS. */
export function printSpecOf(event: Pick<TournamentEvent, 'printSpec'>, kind: PrintKind): { label: string } & PrintSpec {
  const d = PRINT_DEFAULTS[kind];
  const o = event.printSpec?.[kind];
  return { label: d.label, size: o?.size || d.size, qty: o?.qty ?? d.qty };
}

/** The stores whose print files came with the sheet's latest refresh ("this week"). */
export function thisWeekKits(event: Pick<TournamentEvent, 'id' | 'printSheet'>, stores: Store[]): Store[] {
  const at = event.printSheet?.importedAt;
  return at ? stores.filter((s) => s.eventId === event.id && s.print?.importedAt === at && s.print.files.length > 0) : [];
}
