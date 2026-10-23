/*
 * HQ store import: turns an uploaded CSV, a fetched sheet or pasted cells into the stores of a
 * campaign. Pure and Node-loadable (the HQ page + tests).
 *
 *   parseStoreSheet   rows → columns → one SheetRow per store, each with its own errors / warnings
 *   planStoreSheet    each row against the campaign's stores: create / update / unchanged / error
 *   applySheetFields  writes a row's fields onto a store draft (create and update alike)
 *
 * Row numbers are the sheet's own (1 = the first row of the file). A store is found again by
 * its name (case, spacing and the "ASUS ROG Exclusive Store — " prefix ignored), so importing
 * the same sheet twice updates instead of duplicating. A blank cell never erases what a store
 * already has, and a store that isn't in the sheet is never touched — only listed.
 */
import type { Admin, GeoFix, Store } from './types.ts';
import { headerKey, headerWords, parseTable, type Delimiter } from './roster.ts';
import { coordsFromMapsUrl, isShortMapsLink, mapsUrlProblem } from './recce.ts';
import { applyToornamentLink, toornamentLinkProblem } from './toornament.ts';

/* ---------- columns ---------- */

export type SheetColumn = 'name' | 'exclusive' | 'city' | 'state' | 'maps' | 'address' | 'phone' | 'venue' | 'toornament' | 'date' | 'admin';
export type SheetColumns = Partial<Record<SheetColumn, number>>;

/** How a column is named to HQ ("Two state columns", "Type → ROG Exclusive"). */
export const COLUMN_LABEL: Record<SheetColumn, string> = { name: 'store name', exclusive: 'ROG Exclusive', city: 'city', state: 'state', maps: 'Google Maps link', address: 'address', phone: 'phone', venue: 'venue spot', toornament: 'Toornament link', date: 'date', admin: 'admin' };

// Exact matches on the header with case, spacing, punctuation and "(…)" removed.
const SYNONYMS: [SheetColumn, string[]][] = [
  ['name', ['store', 'storename', 'name', 'outlet', 'outletname', 'venue', 'venuename', 'shop', 'shopname', 'storetitle']],
  ['exclusive', ['rogexclusive', 'exclusive', 'storetype', 'type', 'rogexclusivestore', 'exclusivestore', 'isexclusive', 'isrogexclusive', 'rogstore', 'rogstoretype', 'outlettype']],
  ['city', ['city', 'town', 'location', 'storelocation', 'cityname']],
  ['state', ['state', 'statename', 'province']],
  ['maps', ['maps', 'googlemaps', 'map', 'locationlink', 'mapsurl', 'mapslink', 'googlemapslink', 'googlemapsurl', 'googlemapslocation', 'maplink', 'mapurl', 'gmaps', 'googlemap', 'maplocation', 'mapslocation', 'locationurl', 'googlelocation', 'googlemaplink', 'gmaplink']],
  ['address', ['address', 'storeaddress', 'fulladdress', 'streetaddress']],
  ['phone', ['phone', 'phonenumber', 'phoneno', 'mobile', 'mobilenumber', 'contact', 'contactnumber', 'contactno', 'storephone', 'storecontact', 'tel', 'telephone']],
  ['venue', ['venuespot', 'spot', 'spotinstore', 'venuelocation', 'tournamentspot', 'whereinstore', 'venuearea']],
  ['toornament', ['toornament', 'toornamentlink', 'toornamenturl', 'bracketlink', 'bracket', 'bracketurl', 'tournamentlink', 'tournamenturl', 'tournament']],
  ['date', ['date', 'tournamentdate', 'eventdate', 'matchdate', 'day', 'tournamentday']],
  ['admin', ['admin', 'adminname', 'fieldadmin', 'assignedadmin', 'assignedto', 'incharge', 'assignee']],
];
// Second pass for headers like "Google Maps location" or "ROG Exclusive store? (Y/N)": any wanted
// word ("store name" = both words) and none of the unwanted ones.
const WORDS: [SheetColumn, string[], string[]][] = [
  ['maps', ['maps', 'map'], ['toornament', 'spot']],
  ['toornament', ['toornament', 'bracket link', 'bracket url', 'tournament link', 'tournament url'], []],
  ['exclusive', ['exclusive'], ['non']],
  ['admin', ['admin'], ['phone', 'mobile', 'contact', 'number']],
  ['date', ['date'], []],
  ['state', ['state'], []],
  ['city', ['city', 'town'], []],
  ['phone', ['phone', 'mobile', 'whatsapp', 'contact'], ['admin', 'name']],
  ['address', ['address'], ['email', 'mail']],
  ['venue', ['spot'], []],
  ['name', ['store name', 'outlet name', 'venue name', 'shop name'], []],
];
const hasWords = (words: string[], list: string[]) => list.some((w) => w.split(' ').every((x) => words.includes(x)));

export function detectColumns(header: string[]): { columns: SheetColumns; duplicates: [SheetColumn, number][] } {
  const columns: SheetColumns = {};
  const duplicates: [SheetColumn, number][] = [];
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
  return { columns, duplicates };
}

/* ---------- cell values ---------- */

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
/** "-", "n/a", "TBD" in a cell mean "nothing here". */
const EMPTY_CELL = /^(?:-+|–|—|n\/?a|nil|none|tbd|tba|\?+)$/i;

const norm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function ymd(y: number, m: number, d: number): string | null {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const monthOf = (w: string) => {
  if (w.length < 3) return 0;
  const i = MONTHS.findIndex((m) => m.startsWith(w) || (w === 'sept' && m === 'september'));
  return i + 1;
};
const fullYear = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s));

/**
 * A date as yyyy-mm-dd, from what people type: 2026-10-24, 24/10/2026, 24-10-26, 24.10.2026,
 * "24 Oct 2026", "Sat, 24th October 2026", "Oct 24, 2026", 20261024 or an Excel serial (46319).
 * Day first when it's a number/number/year (this is an Indian-market tool). A date without a year
 * ("24 Oct") takes `defaultYear`. null = not a date.
 */
export function parseSheetDate(raw: string, defaultYear?: number): string | null {
  const s = collapse(raw);
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{5})(?:\.\d+)?$/))) {
    const n = Number(m[1]);
    if (n < 20000 || n > 80000) return null;
    const t = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/))) return ymd(fullYear(m[3]), +m[2], +m[1]);
  if (!/[a-z]/i.test(s)) return null;
  // Words: drop a weekday, commas, dots, dashes and "24th" suffixes, then day-month[-year] or month-day[-year].
  const t = s
    .toLowerCase()
    .replace(/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/, '')
    .replace(/(\d)(?:st|nd|rd|th)\b/g, '$1')
    .replace(/[,.\-/]+/g, ' ')
    .trim();
  if ((m = t.match(/^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}|\d{2}))?$/))) {
    const mo = monthOf(m[2]);
    const y = m[3] ? fullYear(m[3]) : defaultYear;
    return mo && y ? ymd(y, mo, +m[1]) : null;
  }
  if ((m = t.match(/^([a-z]{3,9})\s+(\d{1,2})(?:\s+(\d{4}|\d{2}))?$/))) {
    const mo = monthOf(m[1]);
    const y = m[3] ? fullYear(m[3]) : defaultYear;
    return mo && y ? ymd(y, mo, +m[2]) : null;
  }
  return null;
}

/**
 * The ROG Exclusive cell: yes / no / true / 1 / "Exclusive" / "ROG Exclusive Store" → true,
 * no / false / 0 / "Non-exclusive" / "Multi-brand" → false, blank → undefined (leave as is),
 * anything else → null (HQ is told; the value isn't changed).
 */
export function parseExclusive(raw: string): boolean | null | undefined {
  const s = collapse(raw);
  if (!s || EMPTY_CELL.test(s)) return undefined;
  if (/^[✓✔☑xX]$/.test(s)) return true;
  if (/^[✗✘☐]$/.test(s)) return false;
  const k = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['yes', 'y', 'true', '1', 'ok'].includes(k)) return true;
  if (['no', 'n', 'false', '0'].includes(k)) return false;
  if (/^(?:non|not|un)/.test(k) || /multi|regular|standard|other|partner|authori[sz]ed|general|normal/.test(k)) return false;
  if (k.includes('exclusive')) return true;
  return null;
}

/** "maps.app.goo.gl/x" or "www.google.com/maps/…" typed without https:// */
const withScheme = (v: string, host: RegExp) => (/^https?:\/\//i.test(v) || !host.test(v) ? v : `https://${v}`);
const MAPS_HOST = /^(?:www\.)?(?:maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps|maps\.google\.)/i;
const TOORNAMENT_HOST = /^(?:[a-z0-9-]+\.)?toornament\.com\//i;
const LIKELY_MAPS_HOST = /^(?:maps\.app\.goo\.gl|goo\.gl|g\.co|(?:www\.|maps\.)?google\.[a-z.]+|(?:www\.)?(?:bing\.com|maps\.apple\.com|openstreetmap\.org))$/i;

const MAX = { name: 200, city: 200, state: 200, address: 1000, phone: 100, venue: 500, mapsUrl: 2000 } as const;

/* ---------- the sheet ---------- */

/** What one sheet row says about a store. undefined = the column isn't there or the cell is blank. */
export interface SheetFields {
  name: string;
  exclusive?: boolean;
  city?: string;
  state?: string;
  mapsUrl?: string;
  address?: string;
  phone?: string;
  venue?: string;
  toornamentUrl?: string;
  date?: string; // yyyy-mm-dd
  adminId?: string;
}

export interface SheetRow {
  line: number;
  fields: SheetFields;
  geo: GeoFix | null; // read from the Maps link itself
  resolve: boolean; // a short Maps link (maps.app.goo.gl) — the server has to expand it to get the coordinates
  adminName?: string; // the admin cell as written, whether or not it matched
  errors: string[]; // any error and this row isn't applied
  warnings: string[];
}

export interface SheetIssue {
  line: number; // sheet row; 0 = the sheet as a whole
  message: string;
}

export interface StoreSheetParse {
  delimiter: Delimiter | null;
  header: number; // the row with the column names (0 = none found)
  columns: Partial<Record<SheetColumn, string>>; // header text per column used
  ignored: string[]; // header text of the columns not read
  rows: SheetRow[];
  errors: SheetIssue[]; // the sheet as a whole — nothing is applied while there are any
  warnings: SheetIssue[];
}

export interface StoreSheetOptions {
  admins: Pick<Admin, 'id' | 'name'>[]; // existing admins, matched by name
  year?: number; // for dates written without one ("24 Oct")
}

export const MAX_SHEET_ROWS = 500;

function adminByName(value: string, admins: StoreSheetOptions['admins']): { admin?: Pick<Admin, 'id' | 'name'>; problem?: string } {
  const v = norm(value);
  if (!v) return {};
  const exact = admins.filter((a) => norm(a.name) === v);
  if (exact.length === 1) return { admin: exact[0] };
  if (exact.length > 1) return { problem: `“${value}” is the name of ${exact.length} admins — rename one of them (Team) so the sheet can tell them apart` };
  // "Rahul" for "Rahul Sharma": every word of the cell is in exactly one admin's name.
  const words = v.split(' ');
  const part = admins.filter((a) => {
    const own = norm(a.name).split(' ');
    return words.every((w) => own.includes(w));
  });
  if (part.length === 1) return { admin: part[0] };
  return { problem: part.length > 1 ? `“${value}” fits ${part.length} admins (${part.slice(0, 3).map((a) => a.name).join(', ')}) — use the full name` : `“${value}” isn’t an admin in Team` };
}

/** Parse a store sheet. Nothing is thrown: every problem is an error or warning with its row. */
export function parseStoreSheet(text: string, opts: StoreSheetOptions): StoreSheetParse {
  const table = parseTable(text);
  const errors: SheetIssue[] = [];
  const warnings: SheetIssue[] = [];
  const out: StoreSheetParse = { delimiter: table.delimiter, header: 0, columns: {}, ignored: [], rows: [], errors, warnings };
  if (table.unclosedQuote) warnings.push({ line: table.unclosedQuote, message: 'A quote (") opened here is never closed — everything after it was read as one cell.' });

  const all = table.rows.map((cells, i) => ({ line: i + 1, cells })).filter((r) => r.cells.some(Boolean));
  if (!all.length) {
    errors.push({ line: 0, message: 'Nothing to read — the sheet is empty.' });
    return out;
  }

  // The header is the first of the top rows that has a store-name column and at least one more known column
  // (a title or a note above it is skipped); failing that, the first row.
  let head = all.slice(0, 6).find((r) => {
    const c = detectColumns(r.cells).columns;
    return c.name !== undefined && Object.keys(c).length >= 2;
  });
  head ??= all[0];
  const det = detectColumns(head.cells);
  const cols = det.columns;
  out.header = head.line;
  for (const [k, i] of Object.entries(cols) as [SheetColumn, number][]) out.columns[k] = head.cells[i];
  const used = new Set(Object.values(cols));
  out.ignored = head.cells.filter((h, i) => h && !used.has(i));
  for (const [k, i] of det.duplicates) warnings.push({ line: head.line, message: `Two ${COLUMN_LABEL[k]} columns — using “${head.cells[cols[k]!]}”, ignoring “${head.cells[i]}”.` });
  if (cols.name === undefined) {
    errors.push({ line: head.line, message: `No store name column. Call the column with the store names “Store name” (or “Store”). The columns found: ${head.cells.filter(Boolean).slice(0, 8).join(', ') || 'none'}.` });
    return out;
  }
  const data = all.filter((r) => r.line > head!.line);
  if (!data.length) {
    errors.push({ line: 0, message: 'The header is there but no stores under it.' });
    return out;
  }
  if (data.length > MAX_SHEET_ROWS) {
    errors.push({ line: 0, message: `${data.length} rows — import at most ${MAX_SHEET_ROWS} stores at a time.` });
    return out;
  }
  if (cols.exclusive === undefined) warnings.push({ line: 0, message: 'No “ROG Exclusive” column — stores keep whatever they are now (new ones are not marked ROG Exclusive).' });

  for (const r of data) {
    const cell = (k: SheetColumn) => {
      const v = cols[k] === undefined ? '' : collapse(r.cells[cols[k]!] ?? '');
      return EMPTY_CELL.test(v) ? '' : v;
    };
    const rowErrors: string[] = [];
    const rowWarnings: string[] = [];
    const fields: SheetFields = { name: cell('name') };
    let geo: GeoFix | null = null;
    let resolve = false;
    let adminName: string | undefined;

    if (!fields.name) rowErrors.push('No store name.');
    else if (fields.name.length > MAX.name) rowErrors.push(`“${fields.name.slice(0, 24)}…” is longer than ${MAX.name} characters.`);

    for (const k of ['city', 'state', 'address', 'phone', 'venue'] as const) {
      const v = cell(k);
      if (!v) continue;
      if (v.length > MAX[k]) rowErrors.push(`${COLUMN_LABEL[k][0].toUpperCase()}${COLUMN_LABEL[k].slice(1)} is longer than ${MAX[k]} characters.`);
      else fields[k] = v;
    }

    const ex = cell('exclusive');
    if (ex) {
      const x = parseExclusive(ex);
      if (x === null) rowWarnings.push(`ROG Exclusive: “${ex}” isn’t Yes or No — left as it is.`);
      else if (x !== undefined) fields.exclusive = x;
    }

    const maps = cell('maps');
    if (maps) {
      const url = withScheme(maps, MAPS_HOST);
      const problem = mapsUrlProblem(url);
      if (problem) rowErrors.push(`Google Maps link “${maps.slice(0, 40)}”: ${problem}`);
      else if (url.length > MAX.mapsUrl) rowErrors.push('Google Maps link is too long — copy it again from Share in Google Maps.');
      else {
        fields.mapsUrl = url;
        geo = coordsFromMapsUrl(url);
        resolve = !geo && isShortMapsLink(url);
        if (!LIKELY_MAPS_HOST.test(new URL(url).hostname)) rowWarnings.push('The Maps link isn’t a Google Maps address — is it in the right column?');
        else if (!geo && !resolve) rowWarnings.push('No coordinates in the Maps link — open the place in Google Maps and copy the link from Share. Until then photo distance checks use the first geotagged photo.');
      }
    }

    const tn = cell('toornament');
    if (tn) {
      const url = withScheme(tn, TOORNAMENT_HOST);
      const problem = toornamentLinkProblem(url);
      if (problem) rowErrors.push(`Toornament link: ${problem}`);
      else fields.toornamentUrl = url;
    }

    const date = cell('date');
    if (date) {
      const d = parseSheetDate(date, opts.year);
      if (d) fields.date = d;
      else rowErrors.push(`Date “${date.slice(0, 30)}” isn’t a date I can read — use dd/mm/yyyy, yyyy-mm-dd or “24 Oct 2026”.`);
    }

    const adm = cell('admin');
    if (adm) {
      adminName = adm;
      const a = adminByName(adm, opts.admins);
      if (a.admin) fields.adminId = a.admin.id;
      else rowWarnings.push(`Admin: ${a.problem} — the store is left without an admin.`);
    }

    out.rows.push({ line: r.line, fields, geo, resolve, ...(adminName ? { adminName } : {}), errors: rowErrors, warnings: rowWarnings });
  }

  // The same store twice in one sheet: only the first is used.
  const seen = new Map<string, SheetRow>();
  for (const row of out.rows) {
    if (!row.fields.name) continue;
    const k = `${storeKey(row.fields.name)}|${norm(row.fields.city ?? '')}`;
    const first = seen.get(k);
    if (first) row.errors.push(`Same store as row ${first.line}${row.fields.city ? ` (${row.fields.city})` : ''} — only the first is used. If they are different stores, give each its City.`);
    else seen.set(k, row);
  }
  return out;
}

/* ---------- matching to the campaign's stores ---------- */

const PREFIXES = ['asus rog exclusive store', 'asus rog exclusive', 'rog exclusive store', 'asus exclusive store', 'asus rog store', 'rog store', 'exclusive store'];

/** "ASUS ROG Exclusive Store — San Infotech" and "san  infotech" are the same key. */
export function storeKey(name: string): string {
  const n = norm(name);
  for (const p of PREFIXES) {
    if (!n.startsWith(`${p} `)) continue;
    const rest = n.slice(p.length + 1).trim();
    return rest === 'store' ? n : rest; // "ASUS ROG Exclusive Store" alone is a name, not a prefix
  }
  return n;
}

export type ChangeField = 'city' | 'state' | 'exclusive' | 'mapsUrl' | 'address' | 'phone' | 'venue' | 'date' | 'toornamentUrl' | 'admin';
export interface FieldChange {
  field: ChangeField;
  label: string;
  from: string;
  to: string;
}
export type PlanStatus = 'create' | 'update' | 'unchanged' | 'error';
export interface PlanItem {
  row: SheetRow;
  status: PlanStatus;
  store?: Store; // the existing store this row is (update / unchanged, or an error that names one)
  changes: FieldChange[]; // update only
  problems: string[]; // matching problems, added to row.errors
}
export interface StoreSheetPlan {
  items: PlanItem[];
  missing: Store[]; // campaign stores the sheet doesn't mention — left as they are
  counts: Record<PlanStatus, number>;
}

const CHANGE_LABEL: Record<ChangeField, string> = { city: 'City', state: 'State', exclusive: 'ROG Exclusive', mapsUrl: 'Maps link', address: 'Address', phone: 'Phone', venue: 'Venue spot', date: 'Date', toornamentUrl: 'Toornament', admin: 'Admin' };
const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

/** What importing this row would change on an existing store. A blank cell changes nothing. */
export function changesFor(f: SheetFields, store: Store, eventDate: string, adminName: (id: string) => string): FieldChange[] {
  const out: FieldChange[] = [];
  const add = (field: ChangeField, from: string, to: string) => out.push({ field, label: CHANGE_LABEL[field], from, to });
  if (f.city !== undefined && f.city !== store.city) add('city', store.city, f.city);
  if (f.state !== undefined && f.state !== (store.state ?? '')) add('state', store.state ?? '', f.state);
  if (f.exclusive !== undefined && f.exclusive !== !!store.exclusive) add('exclusive', yesNo(!!store.exclusive), yesNo(f.exclusive));
  if (f.mapsUrl !== undefined && f.mapsUrl !== (store.mapsUrl ?? '')) add('mapsUrl', store.mapsUrl ?? '', f.mapsUrl);
  if (f.address !== undefined && f.address !== store.address) add('address', store.address, f.address);
  if (f.phone !== undefined && f.phone !== (store.phone ?? '')) add('phone', store.phone ?? '', f.phone);
  if (f.venue !== undefined && f.venue !== (store.venue ?? '')) add('venue', store.venue ?? '', f.venue);
  if (f.date !== undefined && f.date !== (store.date || eventDate)) add('date', store.date || eventDate, f.date);
  if (f.toornamentUrl !== undefined && f.toornamentUrl !== (store.toornament?.url ?? '')) add('toornamentUrl', store.toornament?.url ?? '', f.toornamentUrl);
  if (f.adminId !== undefined && f.adminId !== (store.adminId ?? '')) add('admin', store.adminId ? adminName(store.adminId) : '', adminName(f.adminId));
  return out;
}

/** Every sheet row against the campaign's stores. Nothing is planned while the sheet as a whole has errors. */
export function planStoreSheet(parse: StoreSheetParse, stores: Store[], event: { date: string }, admins: Pick<Admin, 'id' | 'name'>[]): StoreSheetPlan {
  const adminName = (id: string) => admins.find((a) => a.id === id)?.name ?? '';
  const counts: StoreSheetPlan['counts'] = { create: 0, update: 0, unchanged: 0, error: 0 };
  const items: PlanItem[] = [];
  if (parse.errors.length) return { items, missing: [], counts };

  const claimed = new Map<string, number>(); // store id → the row that has it
  const sameName = new Map<string, number>(); // how many sheet rows share a name key (a chain: "Prime IT" in two cities)
  for (const r of parse.rows) if (r.fields.name) sameName.set(storeKey(r.fields.name), (sameName.get(storeKey(r.fields.name)) ?? 0) + 1);

  for (const row of parse.rows) {
    const item: PlanItem = { row, status: 'create', changes: [], problems: [] };
    items.push(item);
    if (!row.fields.name) {
      item.status = 'error';
      counts.error++;
      continue;
    }
    const key = storeKey(row.fields.name);
    const city = norm(row.fields.city ?? '');
    let cands = stores.filter((s) => storeKey(s.name) === key);
    if (cands.length > 1 && city) cands = cands.filter((s) => norm(s.city) === city);
    if (cands.length === 1 && (sameName.get(key) ?? 0) > 1 && city && norm(cands[0].city) && norm(cands[0].city) !== city) cands = []; // another city of a chain: a new store
    if (cands.length > 1) item.problems.push(`“${row.fields.name}” fits ${cands.length} stores in this campaign (${cands.map((s) => s.city || 'no city').join(', ')}) — give the row its City.`);
    else if (cands.length === 1) {
      const owner = claimed.get(cands[0].id);
      if (owner) item.problems.push(`Same store as row ${owner} (“${cands[0].name}”) — only the first is used.`);
      else {
        item.store = cands[0];
        claimed.set(cands[0].id, row.line);
      }
    }
    if (row.errors.length || item.problems.length) {
      item.status = 'error';
      counts.error++;
      continue;
    }
    if (!item.store) {
      counts.create++;
      continue;
    }
    item.changes = changesFor(row.fields, item.store, event.date, adminName);
    item.status = item.changes.length ? 'update' : 'unchanged';
    counts[item.status]++;
  }
  return { items, missing: stores.filter((s) => !claimed.has(s.id)), counts };
}

/** Does applying this item need the Maps link's coordinates from the server (a short link)? */
export const needsResolve = (it: PlanItem) => it.row.resolve && (it.status === 'create' || it.changes.some((c) => c.field === 'mapsUrl'));

/**
 * Writes a row onto a store (a new one, or a draft inside update()): only the fields the sheet
 * has. A changed Maps link replaces the venue location with the one read from it (`geo`), or
 * clears it; the Toornament link keeps what was last fetched while it stays the same.
 * `admins` is the draft's admin list, for the copied admin name.
 */
export function applySheetFields(store: Store, f: SheetFields, geo: GeoFix | null, admins: Record<string, Pick<Admin, 'name'>>, eventDate: string, now = new Date().toISOString()) {
  if (f.city !== undefined) store.city = f.city;
  if (f.state !== undefined) store.state = f.state;
  if (f.exclusive !== undefined) store.exclusive = f.exclusive;
  if (f.address !== undefined) store.address = f.address;
  if (f.phone !== undefined) store.phone = f.phone;
  if (f.venue !== undefined) store.venue = f.venue;
  if (f.mapsUrl !== undefined && f.mapsUrl !== (store.mapsUrl ?? '')) {
    store.mapsUrl = f.mapsUrl;
    store.geo = geo;
  }
  if (f.date !== undefined && (store.date || eventDate) !== f.date) store.date = f.date;
  if (f.toornamentUrl !== undefined) applyToornamentLink(store, f.toornamentUrl);
  if (f.adminId !== undefined && admins[f.adminId] && store.adminId !== f.adminId) {
    store.adminId = f.adminId;
    store.admin = admins[f.adminId].name;
  }
  store.updatedAt = now;
}

/* ---------- the template ---------- */

export const TEMPLATE_HEADER = ['Store name', 'ROG Exclusive', 'City', 'State', 'Google Maps link', 'Address', 'Phone', 'Venue spot', 'Toornament link', 'Date', 'Admin'];
export const STORE_SHEET_TEMPLATE = `${TEMPLATE_HEADER.join(',')}\r\nExample Computers,Yes,Nashik,Maharashtra,,,,,,24/10/2026,\r\n`;
