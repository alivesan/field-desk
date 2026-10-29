import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readZip, zipChunks, ZipError } from '../server/zip.ts';
import { readXlsx } from '../server/xlsx.ts';
import { printTabsOf, sheetExportUrl, confirmUrl, disposition } from '../server/print.ts';
import { buildXlsx, buildZip } from './helpers/xlsx-fixture.ts';

const ID = 'AbCdEfGhIjKlMnOpQrStUvWxYz1';

test('readZip: stored and deflated entries, CRC and size checked, damage and bombs refused', () => {
  const zip = buildZip([
    { name: 'a.txt', data: Buffer.from('hello world, hello world, hello world') },
    { name: 'dir/b.txt', data: Buffer.from('stored'), stored: true },
    { name: 'ünï.txt', data: Buffer.from('utf8 name') },
  ]);
  const z = readZip(zip);
  assert.deepEqual(z.names(), ['a.txt', 'dir/b.txt', 'ünï.txt']);
  assert.equal(z.text('a.txt'), 'hello world, hello world, hello world');
  assert.equal(z.text('dir/b.txt'), 'stored');
  assert.equal(z.text('ünï.txt'), 'utf8 name');
  assert.throws(() => z.read('missing'), ZipError);

  assert.throws(() => readZip(Buffer.from('not a zip at all')), ZipError);
  const flipped = Buffer.from(zip);
  flipped[30 + 'a.txt'.length + 2] ^= 0xff; // inside the first entry's data
  assert.throws(() => readZip(flipped).read('a.txt'), ZipError);
  assert.throws(() => readZip(zip.subarray(0, zip.length - 10)), ZipError, 'cut off');

  const bomb = buildZip([{ name: 'big', data: Buffer.alloc(2 * 1024 * 1024) }]);
  assert.ok(bomb.length < 10000);
  assert.throws(() => readZip(bomb, { maxEntryBytes: 1024 * 1024 }).read('big'), ZipError);
});

test('zipChunks: stored entries with data descriptors read back by an independent reader, with correct CRCs', async () => {
  const big = Buffer.alloc(300_000, 7);
  async function* body() {
    for (let i = 0; i < 3; i++) yield big.subarray(i * 100_000, (i + 1) * 100_000);
  }
  async function* entries() {
    yield { name: 'Store One/Store One - A3 Poster.jpg', body: body() };
    yield { name: 'Store One/note ünï.txt', body: Buffer.from('plain bytes') };
    yield { name: 'empty.bin', body: Buffer.alloc(0) };
  }
  const chunks: Buffer[] = [];
  for await (const c of zipChunks(entries(), () => Date.UTC(2026, 9, 31, 10, 30, 0))) chunks.push(c);
  const zip = Buffer.concat(chunks);
  const z = readZip(zip);
  assert.deepEqual(z.names(), ['Store One/Store One - A3 Poster.jpg', 'Store One/note ünï.txt', 'empty.bin']);
  assert.deepEqual(z.read('Store One/Store One - A3 Poster.jpg'), big);
  assert.equal(z.text('Store One/note ünï.txt'), 'plain bytes');
  assert.equal(z.read('empty.bin').length, 0);
  const e = z.entry('Store One/Store One - A3 Poster.jpg')!;
  assert.equal(e.method, 0);
  assert.equal(e.crc, zlib.crc32(big));
  // the local header says "sizes follow" (bit 3) and a UTF-8 name (bit 11); the descriptor after the data carries the real ones
  assert.equal(zip.readUInt16LE(6), 0x0808);
  assert.equal(zip.readUInt32LE(14), 0);
  const dd = 30 + e.name.length + big.length;
  assert.equal(zip.readUInt32LE(e.offset + dd), 0x08074b50);
  assert.equal(zip.readUInt32LE(e.offset + dd + 4), zlib.crc32(big));
  assert.equal(zip.readUInt32LE(e.offset + dd + 8), big.length);
});

test('zipChunks: an upstream error ends the stream with that error (no silent truncation)', async () => {
  async function* bad() {
    yield Buffer.from('some');
    throw new Error('upstream broke');
  }
  async function* entries() {
    yield { name: 'x', body: bad() };
  }
  await assert.rejects(async () => {
    for await (const _ of zipChunks(entries())) void _;
  }, /upstream broke/);
});

test('readXlsx: tabs in order; text, hyperlink-only, formula and inline cells; cell refs optional; entities decoded', () => {
  const LINK = `https://drive.google.com/file/d/${ID}/view?usp=drive_link`;
  const buf = buildXlsx([
    {
      name: '31-Oct',
      rows: [
        ['Shubham & Sons <Bhubneshwar>', null],
        ['standee', LINK],
        ['Poster', { text: 'Drive link', link: `https://drive.google.com/file/d/${ID}/view?usp=sharing&x=1` }],
        [{ inline: 'Pamphlet' }, { formula: `HYPERLINK("${LINK}","open")`, text: 'open' }],
        [null, null],
        ['Cheque', 'ünï'],
      ],
    },
    { name: '01-Nov', rows: [['Second tab', null]], noRefs: true },
  ]);
  const sheets = readXlsx(buf);
  assert.deepEqual(sheets.map((s) => s.name), ['31-Oct', '01-Nov']);
  const [a] = sheets;
  assert.deepEqual(a.rows.map((r) => r.n), [1, 2, 3, 4, 6], 'the empty row has no cells');
  assert.equal(a.rows[0].cells.A.text, 'Shubham & Sons <Bhubneshwar>');
  assert.equal(a.rows[1].cells.B.text, LINK);
  assert.equal(a.rows[1].cells.B.link, undefined);
  assert.equal(a.rows[2].cells.B.text, 'Drive link');
  assert.equal(a.rows[2].cells.B.link, `https://drive.google.com/file/d/${ID}/view?usp=sharing&x=1`);
  assert.equal(a.rows[3].cells.A.text, 'Pamphlet');
  assert.equal(a.rows[3].cells.B.link, LINK, 'HYPERLINK() formula');
  assert.equal(a.rows[4].cells.B.text, 'ünï');
  assert.equal(sheets[1].rows[0].cells.A.text, 'Second tab');
  assert.throws(() => readXlsx(buildZip([{ name: 'other.txt', data: Buffer.from('x') }])), ZipError);
});

test('printTabsOf: column B\'s Drive link comes from the text or the hyperlink, whichever is the Drive link', () => {
  const LINK = `https://drive.google.com/file/d/${ID}/view?usp=drive_link`;
  const tabs = printTabsOf(
    readXlsx(
      buildXlsx([
        {
          name: 'T',
          rows: [
            ['Store', null],
            ['standee', LINK],
            ['Poster', { text: 'link', link: LINK }],
            ['Pamphlet', 'see ' + LINK + ' thanks'],
            ['Cheque', { text: 'https://example.com/decoy', link: LINK }],
            ['Cheque', 'nothing here'],
          ],
        },
      ]),
    ),
  );
  assert.deepEqual(tabs[0].rows.map((r) => r.b), ['', LINK, LINK, LINK, LINK, 'nothing here']);
  assert.deepEqual(tabs[0].rows.map((r) => r.a)[0], 'Store');
});

test('sheetExportUrl: edit, share and published links become the .xlsx export; other hosts are refused', () => {
  const ok = (raw: string) => sheetExportUrl(raw).href;
  assert.equal(ok('https://docs.google.com/spreadsheets/d/SHEET_ID_123/edit?usp=sharing#gid=0'), 'https://docs.google.com/spreadsheets/d/SHEET_ID_123/export?format=xlsx');
  assert.equal(ok('https://docs.google.com/spreadsheets/u/1/d/SHEET_ID_123/edit'), 'https://docs.google.com/spreadsheets/d/SHEET_ID_123/export?format=xlsx');
  assert.equal(ok('https://docs.google.com/spreadsheets/d/e/PUB_ID-456/pubhtml'), 'https://docs.google.com/spreadsheets/d/e/PUB_ID-456/pub?output=xlsx');
  for (const bad of ['', 'not a link', 'http://docs.google.com/spreadsheets/d/x/edit', 'https://evil.example/spreadsheets/d/x/edit', 'https://docs.google.com/document/d/x/edit', 'https://drive.google.com/file/d/x/view'])
    assert.throws(() => sheetExportUrl(bad), (e: any) => e.status === 400 && e.code === 'bad-url', bad);
});

test('confirmUrl: follows Drive\'s "can\'t scan for viruses" form; a page without one is nothing', () => {
  const html = `<html><body><form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="${ID}"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1&amp;2"><input type="submit" value="Download anyway"></form></body></html>`;
  const u = confirmUrl(html, new URL('https://drive.usercontent.google.com/download?id=x'))!;
  assert.equal(u.origin + u.pathname, 'https://drive.usercontent.google.com/download');
  assert.deepEqual(Object.fromEntries(u.searchParams), { id: ID, export: 'download', confirm: 't', uuid: 'u-1&2' });
  assert.equal(confirmUrl('<html>Sign in</html>', new URL('https://drive.usercontent.google.com/download')), null);
});

test('disposition: UTF-8 name plus a safe ASCII fallback', () => {
  assert.equal(disposition('Subham Infotech - A3 Poster.jpg', false), `attachment; filename="Subham Infotech - A3 Poster.jpg"; filename*=UTF-8''Subham%20Infotech%20-%20A3%20Poster.jpg`);
  assert.equal(disposition('Zoë "Q" 100%.jpg', true), `inline; filename="Zo_ _Q_ 100_.jpg"; filename*=UTF-8''Zo%C3%AB%20%22Q%22%20100%25.jpg`);
});
