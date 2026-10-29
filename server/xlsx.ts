import { readZip, ZipError } from './zip.ts';

/*
 * A small .xlsx reader — just enough for a Google Sheets export: the sheets in order, each cell's text
 * and, where the cell is a link, where it goes. Read straight from the XML parts:
 *
 *   xl/workbook.xml (+ _rels)      sheet names and which part holds each
 *   xl/sharedStrings.xml           the text cells point into
 *   xl/worksheets/sheetN.xml       rows and cells; <hyperlinks> name a target through the sheet's own _rels
 *                                  (a link can sit only there: the cell says "Standee", the link is the file)
 *                                  and =HYPERLINK("url", "text") formulas carry theirs inline
 *
 * Not a general spreadsheet reader: no styles, dates, merged cells or formulas' results beyond their text.
 */

export interface XlsxCell {
  text: string;
  link?: string;
}
export interface XlsxRow {
  n: number; // the row number, 1-based
  cells: Record<string, XlsxCell>; // by column letters: "A", "B", …
}
export interface XlsxSheet {
  name: string;
  rows: XlsxRow[];
}

const MAX_SHEETS = 60;
const MAX_ROWS = 20000;

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function unescapeXml(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITY[e.toLowerCase()] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** The attributes of one tag, entities decoded. A prefix is ignored when asked for by `local` name (r:id → id). */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = unescapeXml(m[2] ?? m[3] ?? '');
  return out;
}
const local = (a: Record<string, string>, name: string) => {
  for (const k of Object.keys(a)) if (k === name || k.endsWith(`:${name}`)) return a[k];
  return undefined;
};

/** The text of every <t> in a fragment (rich-text runs joined; phonetic hints skipped). */
function textOf(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += unescapeXml(m[1] ?? '');
  return out;
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) out.push(textOf(m[1] ?? ''));
  return out;
}

/** Relationship id → { target, type } for a .rels part. */
function rels(xml: string | undefined): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  if (!xml) return out;
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) out.set(a.Id, { target: a.Target, type: a.Type ?? '' });
  }
  return out;
}

/** A relationship target relative to the part that holds it, as a path inside the zip. */
function resolve(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromPart.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

const colNumber = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colLetters = (n: number) => {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function readSheet(xml: string, strings: string[], sheetRels: Map<string, { target: string; type: string }>): XlsxRow[] {
  // Hyperlinks, by the cell(s) they cover.
  const links = new Map<string, string>();
  for (const m of xml.matchAll(/<hyperlink\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    const rid = local(a, 'id');
    const target = rid ? sheetRels.get(rid)?.target : undefined;
    if (!target || !a.ref) continue;
    const [from, to = from] = a.ref.split(':');
    const f = from.match(/^([A-Z]+)(\d+)$/);
    const t = to.match(/^([A-Z]+)(\d+)$/);
    if (!f || !t) continue;
    for (let r = Number(f[2]); r <= Math.min(Number(t[2]), Number(f[2]) + 200); r++) for (let c = colNumber(f[1]); c <= Math.min(colNumber(t[1]), colNumber(f[1]) + 26); c++) links.set(`${colLetters(c)}${r}`, target);
  }

  const rows: XlsxRow[] = [];
  let rowNo = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= MAX_ROWS) break;
    const ra = attrs(rm[1]);
    rowNo = ra.r ? Number(ra.r) : rowNo + 1;
    const cells: Record<string, XlsxCell> = {};
    let colNo = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]);
      const at = ca.r?.match(/^([A-Z]+)\d+$/);
      colNo = at ? colNumber(at[1]) : colNo + 1;
      const inner = cm[2] ?? '';
      const v = inner.match(/<v\b[^>]*?>([\s\S]*?)<\/v>/)?.[1];
      let text = '';
      if (ca.t === 's') text = strings[Number(unescapeXml(v ?? ''))] ?? '';
      else if (ca.t === 'inlineStr') text = textOf(inner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] ?? '');
      else if (ca.t === 'e') text = '';
      else text = unescapeXml(v ?? '');
      const col = colLetters(colNo);
      let link = links.get(`${col}${rowNo}`);
      const f = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
      if (!link && f) link = unescapeXml(f).match(/HYPERLINK\(\s*"([^"]*)"/i)?.[1];
      if (text !== '' || link) cells[col] = link ? { text, link } : { text };
    }
    if (Object.keys(cells).length) rows.push({ n: rowNo, cells });
  }
  return rows;
}

/** Every sheet of a workbook, in tab order. Throws ZipError if the file isn't a readable .xlsx. */
export function readXlsx(buf: Buffer): XlsxSheet[] {
  const zip = readZip(buf, { maxEntries: 500, maxEntryBytes: 24 * 1024 * 1024 });
  if (!zip.has('xl/workbook.xml')) throw new ZipError('That isn’t an Excel (.xlsx) file.');
  const strings = sharedStrings(zip.has('xl/sharedStrings.xml') ? zip.text('xl/sharedStrings.xml') : undefined);
  const wbRels = rels(zip.has('xl/_rels/workbook.xml.rels') ? zip.text('xl/_rels/workbook.xml.rels') : undefined);
  const out: XlsxSheet[] = [];
  for (const m of zip.text('xl/workbook.xml').matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    if (out.length >= MAX_SHEETS) break;
    const a = attrs(m[1]);
    const rid = local(a, 'id');
    const target = rid ? wbRels.get(rid)?.target : undefined;
    const part = target ? resolve('xl/workbook.xml', target) : '';
    if (!a.name || !part || !zip.has(part)) continue;
    const relPart = part.replace(/([^/]+)$/, '_rels/$1.rels');
    out.push({ name: a.name, rows: readSheet(zip.text(part), strings, rels(zip.has(relPart) ? zip.text(relPart) : undefined)) });
  }
  return out;
}
