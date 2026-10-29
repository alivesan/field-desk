import { pipeline, Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import type { PrintFile, PrintKind, Store } from '../src/lib/types.ts';
import { chequeRoleOf, kindOfRow, parsePrintSheet, printFileName, resolveCheques, safeFileName, type PrintSheetParse, type PrintSheetTab } from '../src/lib/print.ts';
import { storeShortName } from '../src/lib/names.ts';
import { followGuarded, header, RosterFetchError, upstreamError, type HopResponse, type RosterFetchOptions } from './roster-fetch.ts';
import { readXlsx, unescapeXml, type XlsxCell, type XlsxSheet } from './xlsx.ts';
import { zipChunks, ZipError, type ZipInput } from './zip.ts';
import type { Logger } from './log.ts';

/*
 * Print files on the server: reading HQ's creatives sheet, and handing out the Drive files under
 * proper names. Everything that leaves the server goes through followGuarded (server/roster-fetch.ts):
 * https, port 443, every hop's addresses checked and pinned, redirects followed by hand — and here
 * only Google's hosts are allowed:
 *
 *   sheet     docs.google.com (+ the *.googleusercontent.com it redirects the export to) → the sheet as
 *             .xlsx (≤ 5 MB), read with server/xlsx.ts: tab names, column A, and column B's link —
 *             from the cell's text or, when only a hyperlink sits on it, from the hyperlink.
 *   titles    drive.google.com/file/d/<id>/view → "<NAME> - Google Drive" in <title>: the file's real name
 *             (the two cheques end -C and -R). Cached for an hour; a file with no title just has no name.
 *   files     drive.usercontent.google.com/download?id=<id>&export=download&confirm=t, streamed to the
 *             caller (never held in memory) with the upstream Content-Type, ≤ 300 MB, a timeout on the
 *             answer and on silence mid-file. Drive's "can't scan this file" page is followed once.
 *
 * Files must be shared "Anyone with the link"; if they aren't, Google asks for a sign-in and the error
 * says to share them. Downloads are bounded: only a handful run at once, the rest are told to wait.
 */

const SHEET_MAX_BYTES = 5 * 1024 * 1024;
const FILE_MAX_BYTES = 300 * 1024 * 1024;
const MAX_DOWNLOADS = 8;
const TITLE_TTL_MS = 3600000;
const MISS_TTL_MS = 300000;
const DRIVE_SUFFIX = ' - Google Drive';

const sheetHost = (h: string) => h === 'docs.google.com' || h.endsWith('.googleusercontent.com');
const driveHost = (h: string) => h === 'drive.google.com' || h === 'drive.usercontent.google.com' || h.endsWith('.googleusercontent.com');

/** The link that returns a Google Sheet as .xlsx, from whatever link HQ copied (edit, share, or "Publish to the web"). */
export function sheetExportUrl(raw: string): URL {
  let u: URL;
  try {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) throw new Error();
    u = new URL(raw.trim());
  } catch {
    throw new RosterFetchError(400, 'bad-url', 'That isn’t a link.');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') throw new RosterFetchError(400, 'bad-url', 'Paste the Google Sheets link (docs.google.com/spreadsheets/…).');
  const pub = u.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/e\/([\w-]+)\/(?:pub|pubhtml)\/?$/);
  if (pub) return new URL(`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=xlsx`);
  const doc = u.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/);
  if (!doc || doc[1] === 'e') throw new RosterFetchError(400, 'bad-url', 'That isn’t a Google Sheets link.');
  return new URL(`https://docs.google.com/spreadsheets/d/${doc[1]}/export?format=xlsx`);
}

const isDriveLink = (s: string | undefined) => !!s && /^https?:\/\/(?:drive|docs)\.google\.com\//i.test(s.trim());

/** Column B's link: the hyperlink or the text, whichever is the Drive link. */
function linkOf(c: XlsxCell | undefined): string {
  if (!c) return '';
  const inText = c.text.match(/https?:\/\/[^\s<>"]+/)?.[0];
  return (isDriveLink(c.link) ? c.link! : isDriveLink(inText) ? inText! : (c.link ?? inText ?? c.text)).trim();
}

/** The sheets as the parser wants them: column A's text, and column B's link (or column A's, when a kind label itself carries the link). */
export function printTabsOf(sheets: XlsxSheet[]): PrintSheetTab[] {
  return sheets.map((s) => ({
    name: s.name,
    rows: s.rows.map((r) => {
      const a = r.cells.A?.text ?? '';
      return { a, b: linkOf(r.cells.B) || (r.cells.A?.link && kindOfRow(a) ? linkOf(r.cells.A) : '') };
    }),
  }));
}

const imageTypes: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
/** Only these are served under their own type; anything else (HTML, SVG…) is sent as an opaque download. */
const mimeOf = (contentType: string | undefined) => {
  const m = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return imageTypes[m] ? m : 'application/octet-stream';
};
const extOf = (contentType: string | undefined, name?: string) => imageTypes[mimeOf(contentType)] ?? name?.match(/\.([A-Za-z0-9]{2,5})$/)?.[1]?.toLowerCase() ?? 'jpg';

/** Content-Disposition with the UTF-8 name and an ASCII fallback. */
export function disposition(filename: string, inline: boolean) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const enc = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

export interface DriveFile {
  contentType: string;
  length?: number;
  /** The bytes. Ends (or throws RosterFetchError) at the size cap or on silence; closes the upstream connection when done or abandoned. */
  body: AsyncIterable<Uint8Array>;
}

export interface PrinterOptions {
  now: () => number;
  /** DNS / transport / timeouts, for tests (server/roster-fetch.ts). */
  fetch?: RosterFetchOptions;
  log: Logger;
  maxFileBytes?: number;
  maxSheetBytes?: number;
  maxDownloads?: number;
}

export function createPrinter(o: PrinterOptions) {
  const maxFile = o.maxFileBytes ?? FILE_MAX_BYTES;
  const maxSheet = o.maxSheetBytes ?? SHEET_MAX_BYTES;
  const maxDownloads = o.maxDownloads ?? MAX_DOWNLOADS;
  const waitMs = o.fetch?.timeoutMs ?? 20000;
  const titles = new Map<string, { name: string | null; at: number }>();
  let active = 0;

  const guarded = (allowHost: (h: string) => boolean): RosterFetchOptions => ({ ...o.fetch, allowHost });

  /** Slot for one running download; throws 503 when they are all taken. Call the result when it ends. */
  function acquire(): () => void {
    if (active >= maxDownloads) throw new RosterFetchError(503, 'busy', 'A lot of downloads are running — try again in a minute.');
    active++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        active--;
      }
    };
  }

  /* ---------- Drive titles ---------- */

  async function title(driveId: string): Promise<string | null> {
    const hit = titles.get(driveId);
    if (hit && o.now() - hit.at < (hit.name ? TITLE_TTL_MS : MISS_TTL_MS)) return hit.name;
    let name: string | null = null;
    const signal = AbortSignal.timeout(Math.min(waitMs, 8000));
    try {
      const { res } = await followGuarded(new URL(`https://drive.google.com/file/d/${driveId}/view`), guarded(driveHost), signal);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const c of res.body) {
        chunks.push(c);
        size += c.length;
        if (size > 256 * 1024 || /<\/title>/i.test(Buffer.concat(chunks).toString('utf8'))) break;
      }
      res.close();
      const t = Buffer.concat(chunks).toString('utf8').match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
      const full = t ? unescapeXml(t).trim() : '';
      if (full.endsWith(DRIVE_SUFFIX) && full.length > DRIVE_SUFFIX.length) name = full.slice(0, -DRIVE_SUFFIX.length).trim().slice(0, 300) || null;
    } catch {
      /* no name: the file still downloads, just without a name to tell the cheques apart by */
    }
    titles.set(driveId, { name, at: o.now() });
    return name;
  }

  async function titlesOf(ids: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const until = o.now() + 45000; // a slow Drive costs names, not the whole sheet
    let next = 0;
    const worker = async () => {
      while (next < ids.length && o.now() < until) {
        const id = ids[next++];
        out.set(id, await title(id));
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
    return out;
  }

  /* ---------- the sheet ---------- */

  async function sheet(rawUrl: string, year: number): Promise<PrintSheetParse> {
    const signal = AbortSignal.timeout(Math.max(waitMs, 20000));
    const { res } = await followGuarded(sheetExportUrl(rawUrl), guarded(sheetHost), signal);
    const mime = (header(res.headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (mime === 'text/html') {
      res.close();
      throw new RosterFetchError(502, 'upstream', 'That sheet isn’t public — share it “Anyone with the link”, then try again.', { reason: 'not-shared' });
    }
    const tooBig = () => new RosterFetchError(413, 'too-large', `That sheet is over ${Math.round(maxSheet / 1048576)} MB.`);
    if (Number(header(res.headers, 'content-length')) > maxSheet) {
      res.close();
      throw tooBig();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const c of res.body) {
        size += c.length;
        if (size > maxSheet) {
          res.close();
          throw tooBig();
        }
        chunks.push(c);
      }
    } catch (e) {
      throw upstreamError(e, signal, 'The download broke off.');
    }
    let sheets: XlsxSheet[];
    try {
      sheets = readXlsx(Buffer.concat(chunks));
    } catch (e) {
      if (e instanceof ZipError) throw new RosterFetchError(415, 'unsupported-media', 'That link didn’t give an Excel export of a Google Sheet — is it a Google Sheets link?');
      throw e;
    }
    const parse = parsePrintSheet(printTabsOf(sheets), year);

    // Drive's own file names settle which cheque is the winner's.
    const ids = [...new Set(parse.tabs.flatMap((t) => t.blocks.flatMap((b) => b.files.map((f) => f.driveId))))];
    const names = await titlesOf(ids);
    for (const t of parse.tabs) {
      for (const b of t.blocks) {
        b.files = resolveCheques(b.files.map((f) => ({ ...f, ...(names.get(f.driveId) ? { name: names.get(f.driveId)! } : {}) })));
        const cheques = b.files.filter((f) => f.kind === 'chequeWinner' || f.kind === 'chequeRunnerUp');
        const roles = cheques.map((f) => chequeRoleOf(f.name));
        if (cheques.length === 2 && roles[0] && roles[0] === roles[1]) b.problems.push('Both cheque files are named for the same place (-C or -R) — check which is which');
      }
    }
    return parse;
  }

  /* ---------- a file ---------- */

  const notShared = () => new RosterFetchError(502, 'upstream', 'Google Drive won’t hand that file over — share it “Anyone with the link”, then try again.', { reason: 'not-shared' });

  /** Opens a Drive file for streaming. Throws RosterFetchError (502 not shared / not found / unreachable, 413 too big). */
  async function open(driveId: string): Promise<DriveFile> {
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), waitMs);
    let url = new URL('https://drive.usercontent.google.com/download');
    url.searchParams.set('id', driveId);
    url.searchParams.set('export', 'download');
    url.searchParams.set('confirm', 't');
    let res: HopResponse | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          ({ res } = await followGuarded(url, guarded(driveHost), ctrl.signal));
        } catch (e) {
          if (e instanceof RosterFetchError && e.extra?.reason === 'not-shared') throw notShared();
          if (e instanceof RosterFetchError && (e.extra?.status === 401 || e.extra?.status === 403)) throw notShared();
          if (e instanceof RosterFetchError && e.extra?.status === 404) throw new RosterFetchError(502, 'upstream', 'Google Drive can’t find that file — check the link in the sheet.', { reason: 'not-found' });
          throw upstreamError(e, ctrl.signal, 'Couldn’t reach Google Drive.');
        }
        if (!/^text\/html/i.test(header(res.headers, 'content-type') ?? '')) break;
        // Drive's page for files it can't scan: a form that asks for the same file again.
        const page = await readHead(res, ctrl.signal);
        const again = confirmUrl(page, url);
        res = undefined;
        if (!again || attempt) throw notShared();
        url = again;
      }
    } catch (e) {
      clearTimeout(timer);
      res?.close();
      throw e;
    }
    clearTimeout(timer);
    if (!res) throw notShared();
    const file = res;
    const length = Number(header(file.headers, 'content-length'));
    if (length > maxFile) {
      file.close();
      throw new RosterFetchError(413, 'too-large', `That file is over ${Math.round(maxFile / 1048576)} MB.`);
    }
    async function* body(): AsyncGenerator<Uint8Array> {
      const it = file.body[Symbol.asyncIterator]();
      let n = 0;
      try {
        for (;;) {
          timer = setTimeout(() => ctrl.abort(), waitMs); // silence while waiting for Drive, not a slow reader
          let r: IteratorResult<Uint8Array>;
          try {
            r = await it.next();
          } catch (e) {
            throw upstreamError(e, ctrl.signal, 'The download broke off.');
          } finally {
            clearTimeout(timer);
          }
          if (r.done) return;
          n += r.value.length;
          if (n > maxFile) throw new RosterFetchError(413, 'too-large', `That file is over ${Math.round(maxFile / 1048576)} MB.`);
          yield r.value;
        }
      } finally {
        file.close();
      }
    }
    return { contentType: header(file.headers, 'content-type') ?? '', ...(Number.isFinite(length) && length > 0 ? { length } : {}), body: body() };
  }

  /* ---------- sending ---------- */

  const baseHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" };

  /** One file, under its proper name. Errors before the first byte are thrown (RosterFetchError); after that the connection is cut. */
  async function sendFile(res: ServerResponse, store: Pick<Store, 'name'>, file: PrintFile, inline: boolean) {
    const release = acquire();
    let f: DriveFile;
    try {
      f = await open(file.driveId);
    } catch (e) {
      release();
      throw e;
    }
    const mime = mimeOf(f.contentType);
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Type': mime,
      ...(f.length ? { 'Content-Length': String(f.length) } : {}),
      'Content-Disposition': disposition(printFileName(store, file.kind, extOf(f.contentType, file.name)), inline && mime !== 'application/octet-stream'),
    });
    await new Promise<void>((resolve) =>
      pipeline(Readable.from(f.body), res, (err) => {
        release();
        if (err) o.log('warn', 'print-download-broke', { kind: file.kind, error: err.message });
        resolve();
      }),
    );
  }

  /**
   * A zip of print files, streamed. `items` are in the order they go in; a store's folder is its short name when
   * `folders` is set. A file Drive won't give (not shared, gone) becomes "<name> - COULD NOT DOWNLOAD.txt" in its place,
   * so one bad link doesn't lose the rest; if none can be opened the error is thrown instead of a zip.
   */
  async function sendZip(res: ServerResponse, zipName: string, items: { store: Pick<Store, 'id' | 'name'>; file: PrintFile }[], folders: boolean) {
    if (!items.length) throw new RosterFetchError(404, 'not-found', 'There are no print files to zip.');
    const release = acquire();
    try {
      const folderOf = new Map<string, string>();
      const used = new Set<string>();
      for (const { store } of items) {
        if (folderOf.has(store.id)) continue;
        let name = safeFileName(storeShortName(store.name), 80);
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${safeFileName(storeShortName(store.name), 80)} (${n})`;
        used.add(name.toLowerCase());
        folderOf.set(store.id, name);
      }
      const pathOf = (store: Pick<Store, 'id' | 'name'>, kind: PrintKind, ext: string) => `${folders ? `${folderOf.get(store.id)}/` : ''}${printFileName(store, kind, ext)}`;

      // Find the first file that opens before saying 200, so a wholly broken week is an error, not an empty zip.
      const failed: { path: string; message: string }[] = [];
      let first: { at: number; file: DriveFile } | null = null;
      let lastError: unknown;
      for (let i = 0; i < items.length && !first; i++) {
        try {
          first = { at: i, file: await open(items[i].file.driveId) };
        } catch (e) {
          if (!(e instanceof RosterFetchError)) throw e;
          lastError = e;
          failed.push({ path: pathOf(items[i].store, items[i].file.kind, 'txt'), message: e.message });
        }
      }
      if (!first) throw lastError;
      const start = first;

      async function* entries(): AsyncGenerator<ZipInput> {
        const note = (f: { path: string; message: string }): ZipInput => ({
          name: f.path.replace(/\.txt$/, ' - COULD NOT DOWNLOAD.txt'),
          body: Buffer.from(`This file could not be downloaded from Google Drive.\r\n${f.message}\r\n`, 'utf8'),
        });
        for (const f of failed) yield note(f);
        for (let i = start.at; i < items.length; i++) {
          const { store, file } = items[i];
          let d: DriveFile | null = i === start.at ? start.file : null;
          if (!d) {
            try {
              d = await open(file.driveId);
            } catch (e) {
              if (!(e instanceof RosterFetchError)) throw e;
              yield note({ path: pathOf(store, file.kind, 'txt'), message: e.message });
              continue;
            }
          }
          yield { name: pathOf(store, file.kind, extOf(d.contentType, file.name)), body: d.body };
        }
      }

      res.writeHead(200, { ...baseHeaders, 'Content-Type': 'application/zip', 'Content-Disposition': disposition(`${safeFileName(zipName, 150)}.zip`, false) });
      await new Promise<void>((resolve) =>
        pipeline(Readable.from(zipChunks(entries(), o.now)), res, (err) => {
          if (err) o.log('warn', 'print-zip-broke', { error: err.message });
          resolve();
        }),
      );
    } finally {
      release();
    }
  }

  return { sheet, title, open, acquire, sendFile, sendZip };
}

export type Printer = ReturnType<typeof createPrinter>;

/** The first 64 KB of an HTML answer. */
async function readHead(res: HopResponse, signal: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const c of res.body) {
      chunks.push(c);
      size += c.length;
      if (size > 64 * 1024) break;
    }
  } catch (e) {
    throw upstreamError(e, signal, 'Couldn’t read Google Drive’s answer.');
  } finally {
    res.close();
  }
  return Buffer.concat(chunks).toString('utf8');
}

const attrOf = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? unescapeXml(m[1] ?? m[2] ?? '') : undefined;
};

/** The link Drive's "can't scan this file for viruses" form would go to (its action plus the hidden fields), or null if the page has no such form. */
export function confirmUrl(html: string, base: URL): URL | null {
  const form = html.match(/<form\b[^>]*\bid=["']download-form["'][^>]*>[\s\S]*?<\/form>/i) ?? html.match(/<form\b[^>]*\baction=["'][^"']*download[^"']*["'][^>]*>[\s\S]*?<\/form>/i);
  if (!form) return null;
  const action = attrOf(form[0].match(/^<form\b[^>]*>/i)![0], 'action');
  if (!action) return null;
  let u: URL;
  try {
    u = new URL(action, base);
  } catch {
    return null;
  }
  for (const m of form[0].matchAll(/<input\b[^>]*>/gi)) {
    const name = attrOf(m[0], 'name');
    if (name && (attrOf(m[0], 'type') ?? '').toLowerCase() === 'hidden') u.searchParams.set(name, attrOf(m[0], 'value') ?? '');
  }
  return u;
}
