import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chequeRoleOf, driveIdOf, isDriveFolder, kindOfRow, matchPrintBlocks, parsePrintSheet, printFileName, printSpecOf, PRINT_DEFAULTS, PRINT_KINDS, resolveCheques, safeFileName, tabDate, thisWeekKits, type PrintSheetTab } from '../src/lib/print.ts';
import type { PrintFile, Store, TournamentEvent } from '../src/lib/types.ts';

/* The creatives sheet: tab per date, a block per store. All names, ids and links here are synthetic. */

const id = (tag: string) => `${tag}`.padEnd(28, 'x').replace(/[^\w-]/g, '_');
const link = (tag: string, form: 'view' | 'sharing' = 'view') => `https://drive.google.com/file/d/${id(tag)}/view?usp=${form === 'view' ? 'drive_link' : 'sharing'}`;
const ROG = { cheque1: 'rogChequeOne', cheque2: 'rogChequeTwo' };

const block = (label: string, tag: string, cheques: [string, string] = [ROG.cheque1, ROG.cheque2]) => [
  { a: label, b: '' },
  { a: 'standee', b: link(`${tag}Standee`) },
  { a: 'Poster', b: link(`${tag}Poster`, 'sharing') },
  { a: 'Pamphlet', b: link(`${tag}Pamphlet`) },
  { a: 'Cheque', b: link(cheques[0]) },
  { a: 'Cheque', b: link(cheques[1]) },
  { a: '', b: '' },
];

const SHEET: PrintSheetTab[] = [
  {
    name: '31-Oct',
    rows: [...block('Shubham info Bhubneshwar', 'sub'), ...block('laptop hub byderabad', 'lap'), ...block('Waves Forum mall Kochi', 'wav'), ...block('Vijay Sales Pune Bhosari', 'vjb', ['vijayChequeA', 'vijayChequeB'])],
  },
  {
    name: '01 Nov',
    rows: [
      ...block('Vijay Sales Pune Wakad', 'vjw', ['vijayChequeC', 'vijayChequeD']),
      // Poster link missing
      { a: 'Alpha Computers Jaipur', b: '' },
      { a: 'standee', b: link('alpStandee') },
      { a: 'Poster', b: '' },
      { a: 'Pamphlet', b: link('alpPamphlet') },
      { a: 'Cheque', b: link(ROG.cheque1) },
      { a: 'Cheque', b: link(ROG.cheque2) },
      { a: '', b: '' },
      // A folder instead of a file, and only one cheque
      { a: 'Beta Systems Surat', b: '' },
      { a: 'standee', b: link('betStandee') },
      { a: 'Poster', b: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWx' },
      { a: 'Pamphlet', b: link('betPamphlet') },
      { a: 'Cheque', b: link(ROG.cheque1) },
    ],
  },
];

test('kindOfRow: case, spacing and plurals; store names are not kinds', () => {
  for (const [label, kind] of [
    ['standee', 'standee'], ['Standee', 'standee'], ['  STANDEE ', 'standee'], ['Standees', 'standee'],
    ['Poster', 'poster'], ['posters', 'poster'], ['A3 Poster', 'poster'],
    ['Pamphlet', 'pamphlet'], ['Pamphlets', 'pamphlet'], ['Flyer', 'pamphlet'], ['flyers', 'pamphlet'], ['A5 pamphlet', 'pamphlet'],
    ['Cheque', 'cheque'], ['cheques', 'cheque'], ['Check', 'cheque'], ['Cheque - C', 'cheque'], ['Cheque 2', 'cheque'], ['Winner cheque', 'cheque'],
  ] as const) assert.equal(kindOfRow(label), kind, label);
  for (const label of ['', 'Waves Forum mall Kochi', 'Check Point Computers', 'Poster House', 'constructor', 'toString', 'Vijay Sales Pune Bhosari']) assert.equal(kindOfRow(label), null, label);
});

test('driveIdOf: file/d, open?id=, uc?id=; folders and others are not files', () => {
  const ID = id('someFileIdentifier');
  assert.equal(driveIdOf(`https://drive.google.com/file/d/${ID}/view?usp=drive_link`), ID);
  assert.equal(driveIdOf(`https://drive.google.com/file/d/${ID}/view?usp=sharing`), ID);
  assert.equal(driveIdOf(`https://drive.google.com/file/u/1/d/${ID}/view`), ID);
  assert.equal(driveIdOf(`https://drive.google.com/open?id=${ID}`), ID);
  assert.equal(driveIdOf(`https://drive.google.com/uc?export=download&id=${ID}`), ID);
  assert.equal(driveIdOf(`https://drive.google.com/uc?id=${ID}`), ID);
  assert.equal(driveIdOf('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWx'), null);
  assert.equal(isDriveFolder('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWx?usp=sharing'), true);
  assert.equal(isDriveFolder('https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQrStUvWx'), true);
  assert.equal(isDriveFolder(`https://drive.google.com/file/d/${ID}/view`), false);
  for (const bad of ['', 'not a link', 'https://example.com/file/d/' + ID + '/view', 'https://drive.google.com/file/d/short/view', 'javascript:alert(1)', 'ftp://drive.google.com/open?id=' + ID]) assert.equal(driveIdOf(bad), null, bad);
});

test('tabDate: the shapes tabs are named in', () => {
  for (const [name, want] of [
    ['31-Oct', '2026-10-31'], ['01-Nov', '2026-11-01'], ['01 Nov', '2026-11-01'], ['1st Nov', '2026-11-01'], ['31 October', '2026-10-31'], ['Oct 31', '2026-10-31'],
    ['31/10', '2026-10-31'], ['01/11', '2026-11-01'], ['31-10', '2026-10-31'], ['31-Oct-2027', '2027-10-31'], ['31.10.27', '2027-10-31'], ['Sept 5', '2026-09-05'],
  ] as const) assert.equal(tabDate(name, 2026), want, name);
  for (const name of ['Sheet1', 'Notes', '31-Foo', '32-Oct', '30-Feb', '', '12 tabs']) assert.equal(tabDate(name, 2026), undefined, name);
});

test('parsePrintSheet: two tabs, seven blocks, five files each, cheques in sheet order, links read from "view" and "sharing" forms', () => {
  const p = parsePrintSheet(SHEET, 2026);
  assert.deepEqual(p.tabs.map((t) => [t.tab, t.date, t.blocks.length]), [['31-Oct', '2026-10-31', 4], ['01 Nov', '2026-11-01', 3]]);
  const [sub, lap, wav, vjb] = p.tabs[0].blocks;
  assert.deepEqual(p.tabs[0].blocks.map((b) => b.label), ['Shubham info Bhubneshwar', 'laptop hub byderabad', 'Waves Forum mall Kochi', 'Vijay Sales Pune Bhosari']);
  for (const b of [sub, lap, wav, vjb]) {
    assert.deepEqual(b.problems, [], b.label);
    assert.deepEqual(b.files.map((f) => f.kind), PRINT_KINDS, b.label);
  }
  assert.equal(sub.files[0].driveId, id('subStandee'));
  assert.equal(sub.files[1].driveId, id('subPoster'));
  assert.equal(sub.files[1].url, link('subPoster', 'sharing'));
  assert.equal(sub.files[3].driveId, id(ROG.cheque1));
  assert.equal(sub.files[4].driveId, id(ROG.cheque2));
  assert.equal(sub.files[3].kind, 'chequeWinner', 'the first cheque row is provisionally the winner');
  assert.equal(vjb.files[3].driveId, id('vijayChequeA'), 'Vijay Sales has cheques of its own');
  assert.notEqual(vjb.files[3].driveId, sub.files[3].driveId);
});

test('parsePrintSheet: a missing link, a folder link, a single cheque are problems on that block only', () => {
  const [, nov] = parsePrintSheet(SHEET, 2026).tabs;
  const [vjw, alp, bet] = nov.blocks;
  assert.deepEqual(vjw.problems, []);
  assert.deepEqual(alp.problems, ['Poster: no link']);
  assert.deepEqual(alp.files.map((f) => f.kind), ['standee', 'pamphlet', 'chequeWinner', 'chequeRunnerUp']);
  assert.deepEqual(bet.problems, ['Poster: That’s a folder — each file needs its own link', 'Only one cheque link — need a winner’s and a runner-up’s']);
  assert.ok(!bet.files.some((f) => f.kind === 'poster'));
  assert.equal(bet.files.filter((f) => f.kind.startsWith('cheque')).length, 1);
});

test('parsePrintSheet: a block with no row for a file says so; extras are noted; titles and blank rows are skipped', () => {
  const p = parsePrintSheet(
    [
      {
        name: 'Week 44 creatives',
        rows: [
          { a: 'Creatives for the ROG showdown', b: '' },
          { a: '', b: '' },
          { a: 'Gamma Store Delhi', b: '' },
          { a: 'Standee', b: link('gamStandee') },
          { a: 'Standee', b: link('gamStandee2') },
          { a: 'Flyer', b: link('gamFlyer') },
          { a: 'Banner', b: link('gamBanner') },
          { a: '', b: link('gamLoose') },
          { a: 'Cheque', b: 'see https://example.com/not-drive' },
        ],
      },
    ],
    2026,
  );
  assert.equal(p.tabs[0].date, undefined);
  assert.equal(p.tabs[0].blocks.length, 1, 'the title row has no files under it');
  const b = p.tabs[0].blocks[0];
  assert.deepEqual(b.files.map((f) => [f.kind, f.driveId]), [['standee', id('gamStandee')], ['pamphlet', id('gamFlyer')]]);
  assert.deepEqual(b.problems, [
    'Unrecognised row “Banner” — ignored',
    'A link with no label — ignored',
    '2 standee links — using the first',
    'No poster link',
    'Cheque: that isn’t a Google Drive file link',
  ]);
});

test('chequeRoleOf and resolveCheques: Drive names (-C / -R) beat the sheet order; no names → order', () => {
  assert.equal(chequeRoleOf('ROG_Showdown_Tekken_Cheque-C.jpg'), 'chequeWinner');
  assert.equal(chequeRoleOf('ROG_Showdown_Tekken_Cheque-R.jpg'), 'chequeRunnerUp');
  assert.equal(chequeRoleOf('Cheque-C (1).jpg'), 'chequeWinner');
  assert.equal(chequeRoleOf('Champion cheque.png'), 'chequeWinner');
  assert.equal(chequeRoleOf('Runner-up cheque.png'), 'chequeRunnerUp');
  assert.equal(chequeRoleOf('First Cry Cheque.jpg'), null);
  assert.equal(chequeRoleOf('Epic.jpg'), null);
  assert.equal(chequeRoleOf(undefined), null);

  const f = (kind: PrintFile['kind'], tag: string, name?: string): PrintFile => ({ kind, driveId: id(tag), url: link(tag), ...(name ? { name } : {}) });
  const standee = f('standee', 'st', 'Standee.jpg');
  // sheet lists the runner-up's first
  const swapped = resolveCheques([f('chequeWinner', 'a', 'Tekken_Cheque-R.jpg'), f('chequeRunnerUp', 'b', 'Tekken_Cheque-C.jpg'), standee]);
  assert.deepEqual(swapped.map((x) => [x.kind, x.driveId]), [['standee', id('st')], ['chequeWinner', id('b')], ['chequeRunnerUp', id('a')]]);
  // one name is enough
  const oneNamed = resolveCheques([f('chequeWinner', 'a'), f('chequeRunnerUp', 'b', 'x-C.jpg')]);
  assert.deepEqual(oneNamed.map((x) => x.driveId), [id('b'), id('a')]);
  // no names, or contradicting ones → the sheet's order
  for (const names of [[undefined, undefined], ['a-C.jpg', 'b-C.jpg'], ['a-R.jpg', 'b-R.jpg'], ['plain.jpg', 'other.jpg']] as const) {
    const r = resolveCheques([f('chequeWinner', 'a', names[0]), f('chequeRunnerUp', 'b', names[1])]);
    assert.deepEqual(r.map((x) => [x.kind, x.driveId]), [['chequeWinner', id('a')], ['chequeRunnerUp', id('b')]], String(names));
  }
  // idempotent, and doesn't touch its input
  const input = [f('chequeWinner', 'a', 'Tekken_Cheque-R.jpg'), f('chequeRunnerUp', 'b', 'Tekken_Cheque-C.jpg')];
  const once = resolveCheques(input);
  assert.deepEqual(resolveCheques(once), once);
  assert.equal(input[0].kind, 'chequeWinner');
});

/* ---------- matching ---------- */

const event = { id: 'e1', name: 'ROG Showdown', date: '2026-10-31', games: [], collateral: [], gameReadyTarget: 4, minDownMbps: 25, createdAt: '2026-10-01T00:00:00.000Z' } as TournamentEvent;
const store = (sid: string, name: string, city: string, state: string, date?: string, over: Partial<Store> = {}) => ({ id: sid, eventId: 'e1', name, city, state, address: '', admin: '', pin: null, ...(date ? { date } : {}), ...over }) as unknown as Store;
const STORES = [
  store('s-sub', 'ASUS ROG Exclusive Store — Subham Infotech', 'Bhubaneswar', 'Odisha', '2026-10-31'),
  store('s-lap', 'ASUS ROG Exclusive Store — Laptop Hub', 'Hyderabad', 'Telangana', '2026-10-31'),
  store('s-wav', 'ASUS ROG Exclusive Store — Waves Forum Mall', 'Kochi', 'Kerala', '2026-10-31'),
  store('s-vjb', 'Vijay Sales — Bhosari', 'Pune', 'Maharashtra', '2026-10-31'),
  store('s-vjw', 'Vijay Sales — Wakad', 'Pune', 'Maharashtra', '2026-11-01'),
  store('s-alp', 'ASUS ROG Exclusive Store — Alpha Computers', 'Jaipur', 'Rajasthan', '2026-11-01'),
  store('s-bet', 'ASUS ROG Exclusive Store — Beta Systems', 'Surat', 'Gujarat', '2026-11-01'),
  store('s-other', 'ASUS ROG Exclusive Store — Subham Infotech', 'Bhubaneswar', 'Odisha', undefined, { eventId: 'e2' }),
];

test('matchPrintBlocks: misspelt store names find their stores', () => {
  const m = matchPrintBlocks(parsePrintSheet(SHEET, 2026), STORES, event);
  assert.deepEqual(
    m.map((x) => [x.label, x.storeId]),
    [
      ['Shubham info Bhubneshwar', 's-sub'],
      ['laptop hub byderabad', 's-lap'],
      ['Waves Forum mall Kochi', 's-wav'],
      ['Vijay Sales Pune Bhosari', 's-vjb'],
      ['Vijay Sales Pune Wakad', 's-vjw'],
      ['Alpha Computers Jaipur', 's-alp'],
      ['Beta Systems Surat', 's-bet'],
    ],
  );
  assert.deepEqual(m[0].candidates, ['s-sub']);
  assert.equal(m[0].tab, '31-Oct');
  assert.equal(m[0].date, '2026-10-31');
  assert.equal(m[0].files.length, 5);
  assert.deepEqual(m[5].problems, ['Poster: no link'], 'problems travel with the match');
});

test('matchPrintBlocks: same chain, same city → the tab\'s date decides; undated tab → ambiguous with both candidates', () => {
  const one = (label: string, tab: string): PrintSheetTab => ({ name: tab, rows: block(label, 'x') });
  const [onOct31] = matchPrintBlocks(parsePrintSheet([one('Vijay Sales Pune', '31-Oct')], 2026), STORES, event);
  assert.equal(onOct31.storeId, 's-vjb');
  const [onNov1] = matchPrintBlocks(parsePrintSheet([one('Vijay Sales Pune', '01-Nov')], 2026), STORES, event);
  assert.equal(onNov1.storeId, 's-vjw');
  const [undated] = matchPrintBlocks(parsePrintSheet([one('Vijay Sales Pune', 'Week 44')], 2026), STORES, event);
  assert.equal(undated.storeId, null);
  assert.deepEqual([...undated.candidates].sort(), ['s-vjb', 's-vjw']);
});

test('matchPrintBlocks: unknown names are unmatched, other campaigns\' stores are ignored, near misses are only suggested', () => {
  const m = matchPrintBlocks(parsePrintSheet([{ name: '31-Oct', rows: [...block('Totally Different Mart Nagpur', 'a'), ...block('Infotech', 'b')] }], 2026), STORES, event);
  assert.equal(m[0].storeId, null);
  assert.deepEqual(m[0].candidates, []);
  assert.equal(m[1].storeId, null, 'one shared word is not a match');
  assert.ok(!m.some((x) => x.candidates.includes('s-other')), 'a store of another campaign is never offered');
  const sub = matchPrintBlocks(parsePrintSheet([{ name: '31-Oct', rows: block('Shubham info Bhubneshwar', 'a') }], 2026), STORES, event)[0];
  assert.equal(sub.storeId, 's-sub', 'the identically named store of the other campaign does not make it ambiguous');
});

/* ---------- names, specs, this week ---------- */

test('printFileName: "<short name> - <label>.<ext>", safe on a file system', () => {
  const s = store('s1', 'ASUS ROG Exclusive Store — Subham Infotech', 'Bhubaneswar', 'Odisha');
  assert.equal(printFileName(s, 'poster', 'jpg'), 'Subham Infotech - A3 Poster.jpg');
  assert.equal(printFileName(s, 'standee', '.PNG'), 'Subham Infotech - Standee.png');
  assert.equal(printFileName(s, 'pamphlet', 'pdf'), 'Subham Infotech - A5 Pamphlet.pdf');
  assert.equal(printFileName(s, 'chequeWinner', 'jpg'), 'Subham Infotech - Winner cheque.jpg');
  assert.equal(printFileName(s, 'chequeRunnerUp', 'jpg'), 'Subham Infotech - Runner-up cheque.jpg');
  assert.equal(printFileName(s, 'poster', ''), 'Subham Infotech - A3 Poster.jpg', 'no extension → jpg');
  const odd = store('s2', 'Croma / Pune: "Hinjewadi"? <Phase 1>.', 'Pune', 'MH');
  const name = printFileName(odd, 'poster', 'jpg');
  assert.ok(!/[\\/:*?"<>|]/.test(name), name);
  assert.match(name, /^Croma Pune Hinjewadi Phase 1 - A3 Poster\.jpg$/);
  assert.equal(safeFileName('...'), 'file');
  assert.equal(safeFileName('a'.repeat(300)).length, 120);
});

test('printSpecOf: the campaign\'s own where set, else the defaults', () => {
  assert.deepEqual(printSpecOf(event, 'poster'), { label: 'A3 Poster', size: PRINT_DEFAULTS.poster.size, qty: 10 });
  const custom = { ...event, printSpec: { poster: { size: 'A2', qty: 4 } } } as TournamentEvent;
  assert.deepEqual(printSpecOf(custom, 'poster'), { label: 'A3 Poster', size: 'A2', qty: 4 });
  assert.deepEqual(printSpecOf(custom, 'standee'), { label: 'Standee', size: '6 × 3 ft', qty: 1 });
});

test('thisWeekKits: only stores imported by the latest refresh', () => {
  const kit = (at: string) => ({ files: [{ kind: 'standee' as const, driveId: id('a'), url: link('a') }], importedAt: at });
  const stores = [
    store('a', 'A Store', 'X', 'Y', undefined, { print: kit('2026-10-28T10:00:00.000Z') }),
    store('b', 'B Store', 'X', 'Y', undefined, { print: kit('2026-10-21T10:00:00.000Z') }),
    store('c', 'C Store', 'X', 'Y'),
    store('d', 'D Store', 'X', 'Y', undefined, { print: kit('2026-10-28T10:00:00.000Z'), eventId: 'e2' }),
  ];
  const ev = { ...event, printSheet: { url: 'https://docs.google.com/spreadsheets/d/x', importedAt: '2026-10-28T10:00:00.000Z' } } as TournamentEvent;
  assert.deepEqual(thisWeekKits(ev, stores).map((s) => s.id), ['a']);
  assert.deepEqual(thisWeekKits(event, stores), [], 'no refresh yet → nothing is this week\'s');
});
