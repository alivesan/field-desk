import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, seedBasic, fixtureStore, type TestServer } from './helpers/server.ts';
import type { HopResponse, LookupAddress, RosterFetchOptions } from '../server/roster-fetch.ts';
import { readZip } from '../server/zip.ts';
import { buildXlsx } from './helpers/xlsx-fixture.ts';

/*
 * Print files through the real API. Google (Sheets, Drive pages, Drive downloads) is a local fake behind
 * the same injected DNS + transport the roster tests use — nothing here touches the network.
 */

const id = (tag: string) => tag.padEnd(28, 'x');
const view = (tag: string) => `https://drive.google.com/file/d/${id(tag)}/view?usp=drive_link`;
const THIS_WEEK = '2026-10-28T10:00:00.000Z';
const OLD = '2026-10-21T10:00:00.000Z';
const TOKEN = 'desk_Token-synthetic-0001';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/SHEET_OK_synthetic/edit?usp=sharing';

const DNS: Record<string, LookupAddress[]> = Object.fromEntries(
  ['docs.google.com', 'doc-0k-sheets.googleusercontent.com', 'drive.google.com', 'drive.usercontent.google.com', 'accounts.google.com', 'doc-0g-docs.googleusercontent.com', 'evil.example'].map((h) => [h, [{ address: '142.250.183.14', family: 4 }]]),
);
const lookup = async (host: string) => {
  const a = DNS[host];
  if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return a;
};

/* ids with a special behaviour on the fake Drive */
const SPECIAL = {
  png: id('specialPng'),
  svg: id('specialSvg'),
  htmlFile: id('specialHtmlFile'),
  interstitial: id('specialInterstitial'),
  private: id('specialPrivate'),
  forbidden: id('specialForbidden'),
  missing: id('specialMissing'),
  htmlNoForm: id('specialHtmlNoForm'),
  big: id('specialBig'),
  hold: id('specialHold'),
  redirect: id('specialRedirect'),
  evil: id('specialEvil'),
};
/** Drive's own file names: the cheques say which is which (the sheet lists them the wrong way round). */
const TITLES: Record<string, string> = { [id('subCR')]: 'ROG_Showdown_Cheque-C.jpg', [id('subCW')]: 'ROG_Showdown_Cheque-R.jpg' };

const seen: string[] = []; // every upstream request, "host path?query"
const held: http.ServerResponse[] = [];
const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg-of-${tag}`)]);
const PAGE = (name: string) => `<!doctype html><html><head><title>${name} - Google Drive</title></head><body>viewer</body></html>`;

function sheetXlsx() {
  const block = (label: string, tag: string, cheques: [string, string]) => [
    [label, null],
    ['standee', view(`${tag}Standee`)],
    ['Poster', { text: 'link', link: view(`${tag}Poster`) }], // the link only sits on the cell as a hyperlink
    ['Pamphlet', view(`${tag}Pamphlet`)],
    ['Cheque', view(cheques[0])],
    ['Cheque', view(cheques[1])],
    [null, null],
  ];
  return buildXlsx([
    { name: '31-Oct', rows: block('Shubham info Bhubneshwar', 'sub', ['subCW', 'subCR']) as any },
    { name: '01-Nov', rows: [...block('Vijay Sales Pune Bhosari', 'vj', ['vjCW', 'vjCR']), ['Waves Forum mall Kochi', null], ['standee', view('wavStandee')], ['Poster', 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWx']] as any },
  ]);
}

function upstream() {
  return http.createServer((req, res) => {
    const host = String(req.headers['x-host']);
    const u = new URL(req.url!, `https://${host}`);
    seen.push(`${host} ${u.pathname}${u.search}`);
    const go = (loc: string, status = 302) => (res.writeHead(status, { Location: loc }), res.end());
    if (host === 'docs.google.com') {
      if (u.pathname === '/spreadsheets/d/SHEET_OK_synthetic/export') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        return res.end(sheetXlsx());
      }
      if (u.pathname === '/spreadsheets/d/SHEET_REDIRECT/export') return go('https://doc-0k-sheets.googleusercontent.com/export/abc');
      if (u.pathname === '/spreadsheets/d/SHEET_PRIVATE/export') return go('https://accounts.google.com/ServiceLogin?continue=x');
      if (u.pathname === '/spreadsheets/d/SHEET_HTML/export') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>nope</html>');
      }
      if (u.pathname === '/spreadsheets/d/SHEET_NOTXLSX/export') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end('this is not a zip');
      }
      if (u.pathname === '/spreadsheets/d/SHEET_BIG/export') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(6 * 1024 * 1024) });
        return res.end();
      }
    }
    if (host === 'doc-0k-sheets.googleusercontent.com') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      return res.end(sheetXlsx());
    }
    if (host === 'drive.google.com') {
      const fid = u.pathname.match(/^\/file\/d\/([\w-]+)\/view$/)?.[1];
      if (!fid) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE(TITLES[fid] ?? `ROG_${fid}.jpg`));
    }
    if (host === 'doc-0g-docs.googleusercontent.com') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(jpeg('redirected'));
    }
    if (host === 'drive.usercontent.google.com' && u.pathname === '/download') {
      const fid = u.searchParams.get('id') ?? '';
      const send = (type: string, body: Buffer) => (res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(body.length) }), res.end(body));
      switch (fid) {
        case SPECIAL.png:
          return send('image/png', Buffer.from('\x89PNG-synthetic'));
        case SPECIAL.svg:
          return send('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
        case SPECIAL.htmlFile:
          return send('text/html', Buffer.from('<script>alert(1)</script>'));
        case SPECIAL.interstitial:
          if (u.searchParams.get('uuid') === 'u-1') return send('image/jpeg', jpeg('after-interstitial'));
          return send('text/html; charset=utf-8', Buffer.from(`<html><form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="${fid}"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form></html>`));
        case SPECIAL.private:
          return go('https://accounts.google.com/ServiceLogin?continue=x');
        case SPECIAL.forbidden:
          res.writeHead(403);
          return res.end();
        case SPECIAL.missing:
          res.writeHead(404);
          return res.end();
        case SPECIAL.htmlNoForm:
          return send('text/html', Buffer.from('<html>Sorry, you cannot view or download this file at this time.</html>'));
        case SPECIAL.big:
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': '5000' });
          return res.end(Buffer.alloc(5000, 1));
        case SPECIAL.hold:
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.write(jpeg('held'));
          held.push(res); // never finishes until the test lets go
          return;
        case SPECIAL.redirect:
          return go('https://doc-0g-docs.googleusercontent.com/dl/xyz', 303);
        case SPECIAL.evil:
          return go('https://evil.example/steal');
        default:
          return send('image/jpeg', jpeg(fid));
      }
    }
    res.writeHead(404);
    res.end();
  });
}

const kit = (tag: string, at = THIS_WEEK, over: Record<string, string> = {}) => ({
  importedAt: at,
  tab: '31-Oct',
  label: `${tag} as written in the sheet`,
  files: [
    { kind: 'standee', driveId: over.standee ?? id(`${tag}Standee`), url: view(`${tag}Standee`), name: `${tag}-standee.jpg` },
    { kind: 'poster', driveId: over.poster ?? id(`${tag}Poster`), url: view(`${tag}Poster`) },
    { kind: 'pamphlet', driveId: over.pamphlet ?? id(`${tag}Pamphlet`), url: view(`${tag}Pamphlet`) },
    { kind: 'chequeWinner', driveId: over.chequeWinner ?? id(`${tag}CW`), url: view(`${tag}CW`) },
    { kind: 'chequeRunnerUp', driveId: over.chequeRunnerUp ?? id(`${tag}CR`), url: view(`${tag}CR`) },
  ],
});

async function setup(opts: Record<string, unknown> = {}) {
  seen.length = 0;
  const up = upstream();
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
  const port = (up.address() as { port: number }).port;
  const get = async (url: URL, _addr: LookupAddress, signal: AbortSignal): Promise<HopResponse> => {
    const r = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { redirect: 'manual', signal, headers: { 'x-host': url.hostname } });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: (r.body ?? (async function* () {})()) as AsyncIterable<Uint8Array>, close: () => void r.body?.cancel().catch(() => {}) };
  };
  const rosterFetch: RosterFetchOptions = { lookup, get, timeoutMs: 1500 };
  const logs: string[] = [];
  const t = await startTestServer({ rosterFetch, log: (level: string, event: string, f: unknown) => void logs.push(JSON.stringify({ level, event, ...(f as object) })), ...opts });
  const hq = await seedBasic(t);
  const a1 = await t.login('AAA2');
  const a2 = await t.login('BBB3');
  const at = '2026-10-01T00:00:00.000Z';
  const r = await t.json('/api/batch', {
    method: 'POST',
    cookie: hq,
    body: {
      id: 'seed-print-0001',
      ops: [
        { k: 'events', id: 'e1', p: ['printSheet'], v: { url: SHEET_URL, importedAt: THIS_WEEK } },
        { k: 'events', id: 'e1', p: ['printDesk'], v: { token: TOKEN, createdAt: at } },
        { k: 'events', id: 'e1', p: ['printSpec'], v: { poster: { size: 'A2', qty: 4 } } },
        // s1: this week's kit, a store team, private details that must never reach the desk
        { k: 'stores', id: 's1', p: ['name'], v: 'ASUS ROG Exclusive Store — Subham Infotech' },
        { k: 'stores', id: 's1', p: ['city'], v: 'Bhubaneswar' },
        { k: 'stores', id: 's1', p: ['date'], v: '2026-10-31' },
        { k: 'stores', id: 's1', p: ['phone'], v: '9820099999' },
        { k: 'stores', id: 's1', p: ['address'], v: 'Secret Street 42' },
        { k: 'stores', id: 's1', p: ['access'], v: { code: 'KQ27', createdAt: at } },
        { k: 'stores', id: 's1', p: ['print'], v: kit('sub') },
        // s2: last week's kit — not on the desk
        { k: 'stores', id: 's2', p: ['name'], v: 'ASUS ROG Exclusive Store — Old Week Store' },
        { k: 'stores', id: 's2', p: ['access'], v: { code: 'MR43', createdAt: at } },
        { k: 'stores', id: 's2', p: ['print'], v: kit('old', OLD) },
        // s3: this week too, another day
        { k: 'stores', id: 's3', p: [], v: fixtureStore('s3', 'e1', 'a2', { name: 'Vijay Sales — Bhosari', city: 'Pune', date: '2026-11-01', print: kit('vj') }) },
        // s4: one broken file; s5: nothing downloadable
        { k: 'stores', id: 's4', p: [], v: fixtureStore('s4', 'e1', 'a1', { name: 'Gamma Store', print: kit('gam', OLD, { chequeRunnerUp: SPECIAL.forbidden }) }) },
        { k: 'stores', id: 's5', p: [], v: fixtureStore('s5', 'e1', 'a1', { name: 'Delta Store', print: kit('del', OLD, { standee: SPECIAL.forbidden, poster: SPECIAL.missing, pamphlet: SPECIAL.private, chequeWinner: SPECIAL.htmlNoForm, chequeRunnerUp: SPECIAL.forbidden }) }) },
        // s6: no kit at all
        { k: 'stores', id: 's6', p: [], v: fixtureStore('s6', 'e1', 'a1', { name: 'Epsilon Store' }) },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const team1 = await t.login('KQ27', 'Rhea');
  const team2 = await t.login('MR43', 'Sam');
  return {
    t,
    hq,
    a1,
    a2,
    team1,
    team2,
    logs,
    close: async () => {
      for (const h of held.splice(0)) h.destroy();
      up.closeAllConnections();
      up.close();
      await t.close();
    },
  };
}
type Env = Awaited<ReturnType<typeof setup>>;

const sheetVia = (e: Env, link: string, cookie = e.hq, extra = '') => e.t.json(`/api/print/sheet?url=${encodeURIComponent(link)}${extra}`, { cookie });
const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer());

/* ---------- the sheet ---------- */

test('print sheet: HQ only; tabs, blocks and Drive names come back, the cheques sorted by name; the hyperlink-only poster is found', async () => {
  const e = await setup();
  try {
    assert.equal((await sheetVia(e, SHEET_URL, e.a1)).status, 403);
    assert.equal((await sheetVia(e, SHEET_URL, e.team1)).status, 403);
    assert.equal((await e.t.json(`/api/print/sheet?url=${encodeURIComponent(SHEET_URL)}`)).status, 401);

    const r = await sheetVia(e, SHEET_URL, e.hq, '&year=2026');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [oct, nov] = r.body.tabs;
    assert.deepEqual([oct.tab, oct.date, oct.blocks.length], ['31-Oct', '2026-10-31', 1]);
    assert.deepEqual([nov.tab, nov.date, nov.blocks.length], ['01-Nov', '2026-11-01', 2]);
    const sub = oct.blocks[0];
    assert.equal(sub.label, 'Shubham info Bhubneshwar');
    assert.deepEqual(sub.problems, []);
    assert.deepEqual(sub.files.map((f: any) => f.kind), ['standee', 'poster', 'pamphlet', 'chequeWinner', 'chequeRunnerUp']);
    assert.equal(sub.files[1].driveId, id('subPoster'), 'a link that only sits on the cell as a hyperlink');
    assert.equal(sub.files[0].name, `ROG_${id('subStandee')}.jpg`, 'names come from the Drive page title');
    // the sheet lists the -R cheque first; Drive's names put the -C one (the champion's) first
    assert.equal(sub.files[3].driveId, id('subCR'));
    assert.equal(sub.files[3].name, 'ROG_Showdown_Cheque-C.jpg');
    assert.equal(sub.files[4].driveId, id('subCW'));
    // problems of other blocks are theirs alone
    assert.deepEqual(nov.blocks[0].problems, []);
    assert.deepEqual(nov.blocks[1].problems, ['Poster: That’s a folder — each file needs its own link', 'No pamphlet link', 'No cheque links']);
    // every distinct file got one title request; asking again within the hour asks Google for none
    const titles = () => seen.filter((s) => s.startsWith('drive.google.com ')).length;
    const distinct = new Set(r.body.tabs.flatMap((t: any) => t.blocks.flatMap((b: any) => b.files.map((f: any) => f.driveId)))).size;
    assert.equal(titles(), distinct);
    await sheetVia(e, SHEET_URL);
    assert.equal(titles(), distinct, 'titles are cached');
    // the export request itself
    assert.ok(seen.includes('docs.google.com /spreadsheets/d/SHEET_OK_synthetic/export?format=xlsx'));
    // the link is a capability: it is never logged
    assert.ok(!e.logs.join('\n').includes('SHEET_OK_synthetic'));
  } finally {
    await e.close();
  }
});

test('print sheet: redirects to googleusercontent are followed; a private sheet, bad links, HTML, non-xlsx and huge files are plain errors', async () => {
  const e = await setup();
  try {
    const ok = await sheetVia(e, 'https://docs.google.com/spreadsheets/d/SHEET_REDIRECT/edit');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.tabs.length, 2);
    const priv = await sheetVia(e, 'https://docs.google.com/spreadsheets/d/SHEET_PRIVATE/edit');
    assert.deepEqual([priv.status, priv.body.code, priv.body.reason], [502, 'upstream', 'not-shared']);
    const html = await sheetVia(e, 'https://docs.google.com/spreadsheets/d/SHEET_HTML/edit');
    assert.deepEqual([html.status, html.body.reason], [502, 'not-shared']);
    const nz = await sheetVia(e, 'https://docs.google.com/spreadsheets/d/SHEET_NOTXLSX/edit');
    assert.deepEqual([nz.status, nz.body.code], [415, 'unsupported-media']);
    const big = await sheetVia(e, 'https://docs.google.com/spreadsheets/d/SHEET_BIG/edit');
    assert.deepEqual([big.status, big.body.code], [413, 'too-large']);
    for (const bad of ['', 'nope', 'http://docs.google.com/spreadsheets/d/x/edit', 'https://evil.example/spreadsheets/d/x/edit', 'https://drive.google.com/file/d/x/view']) {
      const r = await sheetVia(e, bad);
      assert.deepEqual([r.status, r.body.code], [400, 'bad-url'], bad);
    }
    assert.ok(!seen.some((s) => s.startsWith('evil.example')), 'nothing was requested from a host that isn\'t Google\'s');
  } finally {
    await e.close();
  }
});

/* ---------- named downloads ---------- */

test('print file: streamed from Drive under the proper name; type from upstream; inline for a preview', async () => {
  const e = await setup();
  try {
    const r = await e.t.req('/api/print/file/s1/poster', { cookie: e.hq });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal(r.headers.get('content-disposition'), `attachment; filename="Subham Infotech - A3 Poster.jpg"; filename*=UTF-8''Subham%20Infotech%20-%20A3%20Poster.jpg`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await bytes(r), jpeg(id('subPoster')));
    assert.ok(seen.includes(`drive.usercontent.google.com /download?id=${id('subPoster')}&export=download&confirm=t`));

    const names: Record<string, string> = { standee: 'Standee', pamphlet: 'A5 Pamphlet', chequeWinner: 'Winner cheque', chequeRunnerUp: 'Runner-up cheque' };
    for (const [kind, label] of Object.entries(names)) {
      const k = await e.t.req(`/api/print/file/s1/${kind}`, { cookie: e.hq });
      assert.match(k.headers.get('content-disposition')!, new RegExp(`filename="Subham Infotech - ${label}\\.jpg"`), kind);
      await k.arrayBuffer();
    }
    const inline = await e.t.req('/api/print/file/s1/standee?inline=1', { cookie: e.hq });
    assert.match(inline.headers.get('content-disposition')!, /^inline; filename="Subham Infotech - Standee\.jpg"/);
    await inline.arrayBuffer();
    assert.ok(!e.logs.join('\n').includes(id('subPoster')), 'file ids stay out of the log');
  } finally {
    await e.close();
  }
});

test('print file: the extension follows the file\'s type; HTML and SVG are never served as such; the interstitial and a redirect are followed', async () => {
  const e = await setup();
  try {
    const put = (kind: string, driveId: string) => e.t.json('/api/batch', { method: 'POST', cookie: e.hq, body: { id: `swap-${kind}-${driveId.slice(0, 12)}`, ops: [{ k: 'stores', id: 's1', p: ['print', 'files'], v: kitFiles({ [kind]: driveId }) }] } });
    const kitFiles = (over: Record<string, string>) => kit('sub').files.map((f) => ({ ...f, driveId: over[f.kind] ?? f.driveId }));
    const download = async (kind: string, driveId: string, q = '') => {
      assert.equal((await put(kind, driveId)).status, 200);
      return e.t.req(`/api/print/file/s1/${kind}${q}`, { cookie: e.hq });
    };
    const png = await download('standee', SPECIAL.png);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.match(png.headers.get('content-disposition')!, /Subham Infotech - Standee\.png"/);
    await png.arrayBuffer();

    const svg = await download('poster', SPECIAL.svg, '?inline=1');
    assert.equal(svg.headers.get('content-type'), 'application/octet-stream');
    assert.match(svg.headers.get('content-disposition')!, /^attachment/, 'an SVG is never shown inline on our origin');
    assert.match(svg.headers.get('content-security-policy')!, /sandbox/);
    await svg.arrayBuffer();

    // an HTML "file" looks like Drive's own page: refused, never passed on
    const html = await download('pamphlet', SPECIAL.htmlFile, '?inline=1');
    assert.equal(html.status, 502);
    assert.equal((await html.json()).reason, 'not-shared');

    const inter = await download('chequeWinner', SPECIAL.interstitial);
    assert.equal(inter.status, 200);
    assert.deepEqual(await bytes(inter), jpeg('after-interstitial'));

    const redirected = await download('chequeRunnerUp', SPECIAL.redirect);
    assert.equal(redirected.status, 200);
    assert.deepEqual(await bytes(redirected), jpeg('redirected'));
  } finally {
    await e.close();
  }
});

test('print file: files that aren\'t shared / are gone / redirect off Google are readable errors, not downloads', async () => {
  const e = await setup();
  try {
    const kinds = { s5standee: 'standee', s5poster: 'poster', s5pamphlet: 'pamphlet', s5chequeWinner: 'chequeWinner' };
    const want: Record<string, [number, string]> = { standee: [502, 'not-shared'], poster: [502, 'not-found'], pamphlet: [502, 'not-shared'], chequeWinner: [502, 'not-shared'] };
    for (const kind of Object.values(kinds)) {
      const r = await e.t.json(`/api/print/file/s5/${kind}`, { cookie: e.hq });
      assert.deepEqual([r.status, r.body.code, r.body.reason], [want[kind][0], 'upstream', want[kind][1]], kind);
    }
    const msg = await e.t.json('/api/print/file/s5/standee', { cookie: e.hq });
    assert.match(msg.body.error, /Anyone with the link/);
    // a file that redirects to somewhere that isn't Google's
    await e.t.json('/api/batch', { method: 'POST', cookie: e.hq, body: { id: 'swap-evil-0001', ops: [{ k: 'stores', id: 's6', p: ['print'], v: kit('eps', THIS_WEEK, { standee: SPECIAL.evil }) }] } });
    const evil = await e.t.json('/api/print/file/s6/standee', { cookie: e.hq });
    assert.equal(evil.status, 502);
    assert.ok(!seen.some((s) => s.startsWith('evil.example')));
  } finally {
    await e.close();
  }
});

test('print file: ownership — a store team and the store\'s admin get their own store\'s files, nobody else\'s; no kit / no such kind is 404', async () => {
  const e = await setup();
  try {
    const get = (path: string, cookie?: string) => e.t.req(path, { cookie });
    assert.equal((await get('/api/print/file/s1/poster')).status, 401);
    const own = await get('/api/print/file/s1/poster', e.team1);
    assert.equal(own.status, 200);
    assert.match(own.headers.get('content-disposition')!, /Subham Infotech - A3 Poster\.jpg/);
    await own.arrayBuffer();
    const admin = await get('/api/print/file/s1/standee', e.a1);
    assert.equal(admin.status, 200);
    await admin.arrayBuffer();
    for (const [cookie, who] of [[e.team2, 'other store\'s team'], [e.a2, 'other admin']] as const) {
      const r = await e.t.json('/api/print/file/s1/poster', { cookie });
      assert.deepEqual([r.status, r.body.code], [404, 'not-found'], who);
    }
    assert.equal((await e.t.json('/api/print/zip/s1', { cookie: e.team2 })).status, 404);
    assert.equal((await e.t.json('/api/print/file/s6/poster', { cookie: e.hq })).status, 404, 'no kit');
    assert.equal((await e.t.json('/api/print/file/s1/banner', { cookie: e.hq })).status, 404, 'no such kind');
    assert.equal((await e.t.json('/api/print/file/nope/poster', { cookie: e.hq })).status, 404);
    assert.equal((await e.t.json('/api/print/zip/s6', { cookie: e.hq })).status, 404);
  } finally {
    await e.close();
  }
});

test('print zip: five named files, bytes intact, valid zip; a broken file becomes a note; a wholly broken store is an error', async () => {
  const e = await setup();
  try {
    const r = await e.t.req('/api/print/zip/s1', { cookie: e.team1 });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    assert.match(r.headers.get('content-disposition')!, /filename="Subham Infotech - print files\.zip"/);
    const z = readZip(await bytes(r));
    assert.deepEqual(z.names(), ['Subham Infotech - Standee.jpg', 'Subham Infotech - A3 Poster.jpg', 'Subham Infotech - A5 Pamphlet.jpg', 'Subham Infotech - Winner cheque.jpg', 'Subham Infotech - Runner-up cheque.jpg']);
    assert.deepEqual(z.read('Subham Infotech - A3 Poster.jpg'), jpeg(id('subPoster')));
    assert.deepEqual(z.read('Subham Infotech - Winner cheque.jpg'), jpeg(id('subCW')));

    const part = await e.t.req('/api/print/zip/s4', { cookie: e.hq });
    assert.equal(part.status, 200);
    const pz = readZip(await bytes(part));
    assert.equal(pz.names().length, 5);
    assert.ok(pz.names().includes('Gamma Store - Runner-up cheque - COULD NOT DOWNLOAD.txt'), pz.names().join(' | '));
    assert.match(pz.text('Gamma Store - Runner-up cheque - COULD NOT DOWNLOAD.txt'), /Anyone with the link/);
    assert.deepEqual(pz.read('Gamma Store - A3 Poster.jpg'), jpeg(id('gamPoster')));

    const none = await e.t.json('/api/print/zip/s5', { cookie: e.hq });
    assert.deepEqual([none.status, none.body.code], [502, 'upstream']);
  } finally {
    await e.close();
  }
});

test('print download: only a few at once — the rest are told to wait; a finished one frees its place', async () => {
  const e = await setup({ print: { maxDownloads: 1 } });
  try {
    await e.t.json('/api/batch', { method: 'POST', cookie: e.hq, body: { id: 'swap-hold-0001', ops: [{ k: 'stores', id: 's6', p: ['print'], v: kit('eps', THIS_WEEK, { standee: SPECIAL.hold }) }] } });
    const first = await e.t.req('/api/print/file/s6/standee', { cookie: e.hq });
    assert.equal(first.status, 200);
    const second = await e.t.json('/api/print/file/s1/poster', { cookie: e.hq });
    assert.deepEqual([second.status, second.body.code], [503, 'busy']);
    await first.body!.cancel();
    for (const h of held.splice(0)) h.destroy();
    let third = 0;
    for (let i = 0; i < 40 && third !== 200; i++) {
      const r = await e.t.req('/api/print/file/s1/poster', { cookie: e.hq });
      third = r.status;
      await r.arrayBuffer();
      if (third !== 200) await new Promise((res) => setTimeout(res, 25));
    }
    assert.equal(third, 200);
  } finally {
    await e.close();
  }
});

test('print file: a file over the size cap is refused before any byte is sent', async () => {
  const e = await setup({ print: { maxFileBytes: 1000 } });
  try {
    await e.t.json('/api/batch', { method: 'POST', cookie: e.hq, body: { id: 'swap-big-0001', ops: [{ k: 'stores', id: 's6', p: ['print'], v: kit('eps', THIS_WEEK, { standee: SPECIAL.big }) }] } });
    const r = await e.t.json('/api/print/file/s6/standee', { cookie: e.hq });
    assert.deepEqual([r.status, r.body.code], [413, 'too-large']);
  } finally {
    await e.close();
  }
});

/* ---------- who may write and see what ---------- */

test('printDownloads is writable by the store\'s team (and checked); print, printSheet, printDesk, printSpec are HQ\'s', async () => {
  const e = await setup();
  try {
    const batch = (cookie: string, id: string, ops: unknown[]) => e.t.json('/api/batch', { method: 'POST', cookie, body: { id, ops } });
    const mark = { at: '2026-10-29T08:00:00.000Z', by: 'Rhea (Subham Infotech team)' };
    assert.equal((await batch(e.team1, 'dl-mark-000001', [{ k: 'stores', id: 's1', p: ['printDownloads'], v: { poster: mark } }])).status, 200);
    assert.equal((await batch(e.team1, 'dl-mark-000002', [{ k: 'stores', id: 's1', p: ['printDownloads', 'standee'], v: mark }])).status, 200);
    assert.equal((await batch(e.a1, 'dl-mark-000003', [{ k: 'stores', id: 's1', p: ['printDownloads', 'chequeWinner'], v: mark }])).status, 200, 'the store\'s admin too');
    const st = (await e.t.json('/api/state', { cookie: e.team1 })).body.stores.s1;
    assert.deepEqual(Object.keys(st.printDownloads).sort(), ['chequeWinner', 'poster', 'standee']);

    // not another store's
    const other = await batch(e.team2, 'dl-mark-000004', [{ k: 'stores', id: 's1', p: ['printDownloads'], v: { poster: mark } }]);
    assert.equal(other.status, 403);
    // shape is checked
    for (const [n, v] of [
      ['by too long', { poster: { at: mark.at, by: 'x'.repeat(121) } }],
      ['bad time', { poster: { at: 'yesterday-ish', by: 'x' } }],
      ['unknown kind', { banner: mark }],
      ['not an object', { poster: 'done' }],
    ] as const) {
      const r = await batch(e.team1, `dl-bad-${n.replace(/\W/g, '')}`, [{ k: 'stores', id: 's1', p: ['printDownloads'], v }]);
      assert.deepEqual([r.status, r.body.code], [400, 'invalid'], n);
    }
    // HQ's alone
    for (const [n, op] of [
      ['print', { k: 'stores', id: 's1', p: ['print'], v: kit('hack') }],
      ['print.files', { k: 'stores', id: 's1', p: ['print', 'files'], v: [] }],
      ['name', { k: 'stores', id: 's1', p: ['name'], v: 'x' }],
    ] as const) {
      const r = await batch(e.team1, `dl-hq-${n.replace(/\W/g, '')}`, [op]);
      assert.deepEqual([r.status, r.body.code], [403, 'forbidden'], n);
    }
    for (const field of ['printSheet', 'printDesk', 'printSpec']) {
      const r = await batch(e.a1, `dl-ev-${field}`, [{ k: 'events', id: 'e1', p: [field], v: {} }]);
      assert.equal(r.status, 403, field);
    }
    assert.equal((await batch(e.hq, 'dl-hq-ok-0001', [{ k: 'events', id: 'e1', p: ['printSpec'], v: { poster: { size: 'A1', qty: 2 } } }])).status, 200);
  } finally {
    await e.close();
  }
});

test('visibility: a team / admin gets their store\'s print files, downloads and the campaign\'s print specs — not the sheet link or the desk token', async () => {
  const e = await setup();
  try {
    const hq = (await e.t.json('/api/state', { cookie: e.hq })).body;
    assert.equal(hq.events.e1.printSheet.url, SHEET_URL);
    assert.equal(hq.events.e1.printDesk.token, TOKEN);
    for (const cookie of [e.team1, e.a1]) {
      const s = (await e.t.json('/api/state', { cookie })).body;
      assert.equal(s.events.e1.printSheet, undefined);
      assert.equal(s.events.e1.printDesk, undefined);
      assert.deepEqual(s.events.e1.printSpec, { poster: { size: 'A2', qty: 4 } });
      assert.equal(s.stores.s1.print.files.length, 5);
      assert.equal(s.stores.s1.print.importedAt, THIS_WEEK);
      assert.ok(!JSON.stringify(s).includes(TOKEN));
      assert.ok(!JSON.stringify(s).includes('SHEET_OK_synthetic'));
    }
    assert.equal(Object.keys((await e.t.json('/api/state', { cookie: e.team1 })).body.stores).join(), 's1');
  } finally {
    await e.close();
  }
});

test('visibility: live updates to a team carry the same filtered campaign (no sheet link, no desk token)', async () => {
  const e = await setup();
  try {
    const msgs: any[] = [];
    const ctrl = new AbortController();
    const res = await fetch(e.t.base + '/api/stream', { headers: { Cookie: e.a1 }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    let buf = '';
    const pump = (async () => {
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value);
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: {'));
            buf = buf.slice(i + 2);
            if (line) msgs.push(JSON.parse(line.slice(6)));
          }
        }
      } catch {
        /* aborted */
      }
    })();
    const newToken = 'desk_Token-synthetic-ROTATED1';
    const r = await e.t.json('/api/batch', { method: 'POST', cookie: e.hq, body: { id: 'rotate-desk-0001', ops: [{ k: 'events', id: 'e1', p: ['printDesk'], v: { token: newToken, createdAt: '2026-10-29T00:00:00.000Z' } }] } });
    assert.equal(r.status, 200);
    for (let i = 0; i < 100 && !msgs.some((m) => m.id === 'rotate-desk-0001'); i++) await new Promise((res) => setTimeout(res, 20));
    const m = msgs.find((x) => x.id === 'rotate-desk-0001');
    assert.ok(m, 'the admin hears of the commit');
    const doc = m.ops.find((o: any) => o.k === 'events')?.v;
    assert.ok(doc, 'as a whole campaign document');
    assert.equal(doc.printDesk, undefined);
    assert.equal(doc.printSheet, undefined);
    assert.ok(!JSON.stringify(m).includes(newToken));
    ctrl.abort();
    await pump;
  } finally {
    await e.close();
  }
});

/* ---------- the print desk ---------- */

const desk = (e: Env, path = '', token = TOKEN, headers: Record<string, string> = {}) => e.t.json(`/api/public/print/${token}${path}`, { headers });

test('print desk: no sign-in; this week\'s stores only; exactly the files, specs and downloaded marks — nothing private', async () => {
  const e = await setup();
  try {
    // mark a download first, as the store's team would
    await e.t.json('/api/batch', { method: 'POST', cookie: e.team1, body: { id: 'dl-mark-desk-01', ops: [{ k: 'stores', id: 's1', p: ['printDownloads'], v: { poster: { at: '2026-10-29T08:00:00.000Z', by: 'Rhea (Subham Infotech team)' } } }] } });
    const r = await desk(e);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['campaign', 'stores']);
    assert.deepEqual(r.body.campaign, { id: 'e1', name: 'Synthetic Campaign' });
    assert.deepEqual(r.body.stores.map((s: any) => s.id), ['s1', 's3'], 'sorted by date; last week\'s kit (s2), broken-link stores and kit-less stores are not here');
    const s1 = r.body.stores[0];
    assert.deepEqual(Object.keys(s1).sort(), ['city', 'date', 'downloaded', 'files', 'id', 'name']);
    assert.deepEqual([s1.name, s1.city, s1.date], ['Subham Infotech', 'Bhubaneswar', '2026-10-31']);
    assert.deepEqual(s1.files.map((f: any) => f.kind), ['standee', 'poster', 'pamphlet', 'chequeWinner', 'chequeRunnerUp']);
    assert.deepEqual(s1.files[1], { kind: 'poster', label: 'A3 Poster', size: 'A2', qty: 4, driveId: id('subPoster') }, 'the campaign\'s print spec');
    assert.deepEqual(s1.files[0], { kind: 'standee', label: 'Standee', size: '6 × 3 ft', qty: 1, driveId: id('subStandee') }, 'defaults where the campaign has none');
    assert.deepEqual(s1.downloaded, ['poster']);
    assert.deepEqual(r.body.stores[1].downloaded, []);
    const text = JSON.stringify(r.body);
    for (const secret of ['9820099999', 'Secret Street', 'KQ27', 'AAA2', 'BBB3', 'access', 'steam', 'phone', 'players', 'adminId', 'recce', 'Rhea', 'as written in the sheet', '"url"']) assert.ok(!text.includes(secret), secret);
    // a signed-in browser makes no difference
    assert.deepEqual((await e.t.json(`/api/public/print/${TOKEN}`, { cookie: e.team2 })).body, r.body);
  } finally {
    await e.close();
  }
});

test('print desk: unknown / malformed / rotated tokens are 404; only GET; this week only for files too', async () => {
  const e = await setup();
  try {
    for (const bad of ['desk_Token-synthetic-0002', 'short', 'x'.repeat(65), 'has%20space-in-it-0123456']) {
      const r = await desk(e, '', bad);
      assert.deepEqual([r.status, r.body.code], [404, 'not-found'], bad);
    }
    assert.equal((await e.t.json(`/api/public/print/${TOKEN}`, { method: 'POST', body: {} })).status, 405);
    // last week's store, a store with no kit, an unknown one, an unknown kind
    for (const path of ['/file/s2/poster', '/file/s6/poster', '/file/nope/poster', '/file/s1/banner', '/zip/s2', '/zip/nope', '/nothing']) {
      const r = await desk(e, path);
      assert.deepEqual([r.status, r.body.code], [404, 'not-found'], path);
    }
    // HQ rotates the link: the old one stops, the new one works
    const fresh = 'desk_Token-synthetic-0099';
    await e.t.json('/api/batch', { method: 'POST', cookie: e.hq, body: { id: 'rotate-desk-0002', ops: [{ k: 'events', id: 'e1', p: ['printDesk'], v: { token: fresh, createdAt: '2026-10-29T00:00:00.000Z' } }] } });
    assert.equal((await desk(e)).status, 404);
    assert.equal((await desk(e, '', fresh)).status, 200);
    // and a refresh that brings no kits makes the desk empty rather than showing stale files
    await e.t.json('/api/batch', { method: 'POST', cookie: e.hq, body: { id: 'refresh-0001', ops: [{ k: 'events', id: 'e1', p: ['printSheet'], v: { url: SHEET_URL, importedAt: '2026-11-04T10:00:00.000Z' } }] } });
    assert.deepEqual((await desk(e, '', fresh)).body.stores, []);
  } finally {
    await e.close();
  }
});

test('print desk: files and zips under proper names, a folder per store in the big zip; the token never reaches the log', async () => {
  const e = await setup();
  try {
    const f = await e.t.req(`/api/public/print/${TOKEN}/file/s1/chequeRunnerUp`);
    assert.equal(f.status, 200);
    assert.match(f.headers.get('content-disposition')!, /filename="Subham Infotech - Runner-up cheque\.jpg"/);
    assert.deepEqual(await bytes(f), jpeg(id('subCR')));
    const inline = await e.t.req(`/api/public/print/${TOKEN}/file/s3/standee?inline=1`);
    assert.equal(inline.headers.get('content-disposition'), `inline; filename="Vijay Sales _ Bhosari - Standee.jpg"; filename*=UTF-8''Vijay%20Sales%20%E2%80%94%20Bhosari%20-%20Standee.jpg`);
    await inline.arrayBuffer();

    const one = await e.t.req(`/api/public/print/${TOKEN}/zip/s1`);
    assert.match(one.headers.get('content-disposition')!, /Subham Infotech - print files\.zip/);
    assert.equal(readZip(await bytes(one)).names().length, 5);

    const all = await e.t.req(`/api/public/print/${TOKEN}/zip`);
    assert.equal(all.status, 200);
    assert.match(all.headers.get('content-disposition')!, /Synthetic Campaign - print files\.zip/);
    const z = readZip(await bytes(all));
    const names = z.names();
    assert.equal(names.length, 10);
    const folders = [...new Set(names.map((n) => n.split('/')[0]))];
    assert.deepEqual(folders.sort(), ['Subham Infotech', 'Vijay Sales — Bhosari']);
    assert.ok(names.includes('Subham Infotech/Subham Infotech - A3 Poster.jpg'), names.join(' | '));
    assert.deepEqual(z.read('Subham Infotech/Subham Infotech - A3 Poster.jpg'), jpeg(id('subPoster')));
    assert.ok(names.every((n) => n.includes('/') && !n.startsWith('/') && !n.includes('..')));

    const logged = e.logs.join('\n');
    assert.ok(!logged.includes(TOKEN), 'no token in the log');
    assert.match(logged, /print-desk-download/);
  } finally {
    await e.close();
  }
});

test('print desk: rate-limited per address; wrong tokens cost more; the limit is the address\'s, not the token\'s', async () => {
  const e = await setup({ printLimits: { perIp: 30, failCost: 10 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await desk(e, '', `bad_token-synthetic-000${i}`)).status, 404);
    const blocked = await e.t.req(`/api/public/print/bad_token-synthetic-0009`);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // even the right link is refused for this address for now
    assert.equal((await desk(e)).status, 429);
  } finally {
    await e.close();
  }
  const p = await setup({ printLimits: { perIp: 30, failCost: 10 }, trustProxy: 1 });
  try {
    const from = (ip: string, token: string) => p.t.json(`/api/public/print/${token}`, { headers: { 'X-Forwarded-For': ip } });
    for (let i = 0; i < 3; i++) assert.equal((await from('203.0.113.7', `bad_token-synthetic-000${i}`)).status, 404);
    assert.equal((await from('203.0.113.7', TOKEN)).status, 429);
    assert.equal((await from('203.0.113.8', TOKEN)).status, 200);
    // good requests alone cost 1 each: 30 fit
    for (let i = 0; i < 30; i++) assert.equal((await from('203.0.113.9', TOKEN)).status, 200, `request ${i + 1}`);
    assert.equal((await from('203.0.113.9', TOKEN)).status, 429);
  } finally {
    await p.close();
  }
});

/* ---------- schema ---------- */

test('schema: print fields are validated; a desk token is unique across campaigns', async () => {
  const e = await setup();
  try {
    const batch = (id: string, ops: unknown[]) => e.t.json('/api/batch', { method: 'POST', cookie: e.hq, body: { id, ops } });
    const bad = async (n: string, ops: unknown[], needle: RegExp) => {
      const r = await batch(`schema-${n}-0001`, ops);
      assert.deepEqual([r.status, r.body.code], [400, 'invalid'], n);
      assert.match(JSON.stringify(r.body), needle, n);
    };
    const ev = (p: string[], v: unknown) => [{ k: 'events', id: 'e1', p, v }];
    const st = (p: string[], v: unknown) => [{ k: 'stores', id: 's1', p, v }];
    const file = { kind: 'poster', driveId: id('abc'), url: view('abc') };
    await bad('tokenshort', ev(['printDesk'], { token: 'short', createdAt: '2026-10-29T00:00:00.000Z' }), /printDesk\.token/);
    await bad('specqty', ev(['printSpec'], { poster: { size: 'A3', qty: 0 } }), /printSpec\.poster\.qty/);
    await bad('specqty2', ev(['printSpec'], { poster: { size: 'A3', qty: 100001 } }), /printSpec\.poster\.qty/);
    await bad('specsize', ev(['printSpec'], { poster: { size: 'x'.repeat(61), qty: 1 } }), /printSpec\.poster\.size/);
    await bad('speckind', ev(['printSpec'], { banner: { size: 'A3', qty: 1 } }), /printSpec\.banner/);
    await bad('sheetUrl', ev(['printSheet'], { url: 5 }), /printSheet\.url/);
    await bad('kind', st(['print', 'files'], [{ ...file, kind: 'banner' }]), /print\.files\[0\]\.kind/);
    await bad('driveid', st(['print', 'files'], [{ ...file, driveId: 'tooshort' }]), /driveId/);
    await bad('url', st(['print', 'files'], [{ ...file, url: 'https://evil.example/file/d/x' }]), /print\.files\[0\]\.url/);
    await bad('urllong', st(['print', 'files'], [{ ...file, url: 'https://drive.google.com/' + 'a'.repeat(500) }]), /print\.files\[0\]\.url/);
    await bad('dup', st(['print', 'files'], [file, file]), /listed twice/);
    await bad('time', st(['print', 'importedAt'], 'never'), /print\.importedAt/);
    // a second campaign may not reuse the desk token
    const other = await batch('schema-event2-0001', [{ k: 'events', id: 'e2', p: [], v: { id: 'e2', name: 'Other', date: '2026-11-07', games: [], collateral: [], gameReadyTarget: 4, minDownMbps: 25, createdAt: '2026-10-01T00:00:00.000Z', printDesk: { token: TOKEN, createdAt: '2026-10-29T00:00:00.000Z' } } }]);
    assert.deepEqual([other.status, other.body.code], [400, 'invalid']);
    assert.match(JSON.stringify(other.body), /already used by another campaign/);
    // and the good shapes are accepted
    assert.equal((await batch('schema-good-0001', st(['print', 'files'], [file, { ...file, kind: 'standee', name: 'x.jpg' }]))).status, 200);
  } finally {
    await e.close();
  }
});
