/*
 * HQ store import (src/lib/storesheet.ts) — columns, dates, ROG Exclusive, links, admins,
 * matching an existing store (upsert), and what applying a row writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySheetFields, detectColumns, needsResolve, parseExclusive, parseSheetDate, parseStoreSheet, planStoreSheet, storeKey, STORE_SHEET_TEMPLATE, type StoreSheetParse } from '../src/lib/storesheet.ts';
import { validateDocument } from '../src/lib/schema.ts';
import type { Store } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

const ADMINS = [
  { id: 'a1', name: 'Rahul Sharma' },
  { id: 'a2', name: 'Priya Nair' },
  { id: 'a3', name: 'Priya Menon' },
];
const EVENT = { date: '2026-10-24' };
const MAPS = 'https://www.google.com/maps/place/Synthetic/@19.9975,73.7898,17z';
const MQ = `"${MAPS}"`; // real Maps links have commas: in a CSV they are quoted
const TN = 'https://play.toornament.com/en_US/tournaments/2606138892358238208/';

const parse = (text: string, year?: number) => parseStoreSheet(text, { admins: ADMINS, year });
const store = (id: string, name: string, city = '', over: Record<string, unknown> = {}) => fixtureStore(id, 'e1', null, { name, city, ...over }) as unknown as Store;
const row = (p: StoreSheetParse, i = 0) => p.rows[i];

/* ---------- columns ---------- */

test('columns: the documented headers, any case and spacing', () => {
  const c = detectColumns(['  STORE NAME ', 'Rog exclusive?', 'Location', 'STATE', 'Google Maps', 'Address', 'Mobile', 'Venue spot', 'Bracket link', 'Date', 'Admin']).columns;
  assert.deepEqual(c, { name: 0, exclusive: 1, city: 2, state: 3, maps: 4, address: 5, phone: 6, venue: 7, toornament: 8, date: 9, admin: 10 });
  const d = detectColumns(['Outlet', 'Type', 'City', 'Province', 'Location link', 'Tournament link', 'Day', 'Assigned to']).columns;
  assert.deepEqual(d, { name: 0, exclusive: 1, city: 2, state: 3, maps: 4, toornament: 5, date: 6, admin: 7 });
  const e = detectColumns(['Venue', 'Google Maps location', 'ROG Exclusive Store (Y/N)', 'Toornament', 'Email']).columns;
  assert.deepEqual(e, { name: 0, maps: 1, exclusive: 2, toornament: 3 });
});

test('parse: header, ignored columns, no name column, empty sheet', () => {
  const p = parse('Store name,City,Email,Discord\nA Store,Nashik,a@b.c,x#1\n');
  assert.equal(p.errors.length, 0);
  assert.deepEqual(p.ignored, ['Email', 'Discord']);
  assert.equal(row(p).fields.name, 'A Store');
  assert.match(parse('City,State\nNashik,MH').errors[0].message, /No store name column/);
  assert.match(parse('').errors[0].message, /empty/);
  assert.match(parse('Store name,City\n').errors[0].message, /no stores under it/);
});

test('parse: a title row above the header is skipped and row numbers stay the sheet’s', () => {
  const p = parse('ROG campaign stores,,\n,,\nStore name,City,State\nA,Nashik,Maharashtra\nB,Pune,Maharashtra\n');
  assert.equal(p.header, 3);
  assert.deepEqual(p.rows.map((r) => r.line), [4, 5]);
});

test('parse: tabs (pasted from a sheet), semicolons, quotes, blank rows', () => {
  const p = parse('Store name\tROG Exclusive\tCity\nAsha "Mega" Store\tYes\tNashik\n\n"Rao, Sons"\tno\tPune\n');
  assert.deepEqual(p.rows.map((r) => [r.fields.name, r.fields.exclusive, r.fields.city]), [['Asha "Mega" Store', true, 'Nashik'], ['Rao, Sons', false, 'Pune']]);
  assert.deepEqual(p.rows.map((r) => r.line), [2, 4]);
  assert.equal(parse('Store;City\nA;Pune').rows[0].fields.city, 'Pune');
});

/* ---------- cells ---------- */

test('dates: every format becomes yyyy-mm-dd, day first', () => {
  for (const [raw, want] of [
    ['2026-10-24', '2026-10-24'],
    ['2026/10/4', '2026-10-04'],
    ['24/10/2026', '2026-10-24'],
    ['4-10-2026', '2026-10-04'],
    ['04.10.26', '2026-10-04'],
    ['24 Oct 2026', '2026-10-24'],
    ['24th October 2026', '2026-10-24'],
    ['Sat, 24 Oct 2026', '2026-10-24'],
    ['Oct 24, 2026', '2026-10-24'],
    ['24-Oct-26', '2026-10-24'],
    ['20261024', '2026-10-24'],
    ['46319', '2026-10-24'], // Excel serial
    ['46319.0', '2026-10-24'],
  ] as const) assert.equal(parseSheetDate(raw), want, raw);
  assert.equal(parseSheetDate('24 Oct'), null); // no year, no default
  assert.equal(parseSheetDate('24 Oct', 2026), '2026-10-24');
  for (const bad of ['31/02/2026', '2026-13-01', 'soon', '12', '1/1', '24 Octember 2026']) assert.equal(parseSheetDate(bad), null, bad);
});

test('ROG Exclusive: yes / no / words; blank leaves it, nonsense is a warning', () => {
  for (const y of ['Yes', 'Y', 'TRUE', '1', 'Exclusive', 'ROG Exclusive Store', 'ASUS ROG Exclusive', '✓']) assert.equal(parseExclusive(y), true, y);
  for (const n of ['No', 'n', 'false', '0', 'Non-exclusive', 'Not exclusive', 'Multi-brand', 'Regular']) assert.equal(parseExclusive(n), false, n);
  assert.equal(parseExclusive(''), undefined);
  assert.equal(parseExclusive('n/a'), undefined);
  assert.equal(parseExclusive('maybe'), null);
  const p = parse('Store name,ROG Exclusive\nA,maybe\n');
  assert.equal(row(p).fields.exclusive, undefined);
  assert.match(row(p).warnings[0], /isn’t Yes or No/);
});

test('maps link: kept, geo read from it, short links flagged, bad ones are row errors', () => {
  const p = parse(`Store name,Maps\nA,${MQ}\nB,https://maps.app.goo.gl/abc123\nC,maps.app.goo.gl/zzz\nD,not a link\nE,https://www.google.com/maps/place/Nowhere\nF,https://example.com/x\n`);
  assert.equal(row(p, 0).fields.mapsUrl, MAPS);
  assert.deepEqual(row(p, 0).geo, { lat: 19.9975, lng: 73.7898, accuracy: 0 });
  assert.equal(row(p, 0).resolve, false);
  assert.equal(row(p, 1).resolve, true);
  assert.equal(row(p, 1).geo, null);
  assert.equal(row(p, 2).fields.mapsUrl, 'https://maps.app.goo.gl/zzz'); // scheme added
  assert.equal(row(p, 2).resolve, true);
  assert.match(row(p, 3).errors[0], /Google Maps link/);
  assert.equal(row(p, 3).fields.mapsUrl, undefined);
  assert.match(row(p, 4).warnings[0], /No coordinates/);
  assert.equal(row(p, 4).errors.length, 0);
  assert.match(row(p, 5).warnings[0], /isn’t a Google Maps address/);
});

test('toornament link: only toornament.com tournament links', () => {
  const p = parse(`Store name,Toornament\nA,${TN}\nB,play.toornament.com/en_US/tournaments/2606138892358238208/stages/2606170040841388032/\nC,https://example.com/tournaments/12/\nD,https://play.toornament.com/en_US/\n`);
  assert.equal(row(p, 0).fields.toornamentUrl, TN);
  assert.equal(row(p, 1).fields.toornamentUrl, 'https://play.toornament.com/en_US/tournaments/2606138892358238208/stages/2606170040841388032/');
  assert.match(row(p, 2).errors[0], /Toornament link: Only toornament\.com/);
  assert.match(row(p, 3).errors[0], /Toornament link: No tournament/);
});

test('admin: matched to Team by name; unknown or ambiguous is a warning, not an error', () => {
  const p = parse('Store name,Admin\nA,rahul sharma\nB,Rahul\nC,Priya\nD,Nobody\nE,\n');
  assert.equal(row(p, 0).fields.adminId, 'a1');
  assert.equal(row(p, 1).fields.adminId, 'a1'); // one admin has the word
  assert.equal(row(p, 2).fields.adminId, undefined); // Priya Nair and Priya Menon
  assert.match(row(p, 2).warnings[0], /fits 2 admins/);
  assert.match(row(p, 3).warnings[0], /isn’t an admin in Team/);
  assert.equal(row(p, 3).errors.length, 0);
  assert.equal(row(p, 4).fields.adminId, undefined);
});

test('row problems: no name, bad date, over-long text; "-" and "n/a" are blank', () => {
  const p = parse(`Store name,City,Date,Address\n,Pune,,\nA,Pune,31/02/2026,\nB,${'x'.repeat(201)},,\nC,n/a,-,TBD\n`);
  assert.match(row(p, 0).errors[0], /No store name/);
  assert.match(row(p, 1).errors[0], /isn’t a date/);
  assert.match(row(p, 2).errors[0], /City is longer than 200/);
  assert.deepEqual(row(p, 3).errors, []);
  assert.equal(row(p, 3).fields.city, undefined);
});

test('the same store twice in a sheet: the second is an error, unless the cities differ', () => {
  const p = parse('Store name,City\nASUS ROG Exclusive Store — Prime IT,Mumbai\nprime  it,Mumbai\nPrime IT,Pune\n');
  assert.deepEqual(p.rows.map((r) => r.errors.length), [0, 1, 0]);
  assert.match(row(p, 1).errors[0], /Same store as row 2/);
});

test('the template parses as a sheet', () => {
  const p = parse(STORE_SHEET_TEMPLATE);
  assert.deepEqual(p.errors, []);
  assert.equal(p.rows.length, 1);
  assert.deepEqual(p.ignored, []);
  assert.equal(row(p).fields.date, '2026-10-24');
});

/* ---------- matching (upsert) ---------- */

const plan = (text: string, stores: Store[]) => planStoreSheet(parse(text), stores, EVENT, ADMINS);

test('storeKey: case, spacing and the ASUS ROG Exclusive Store prefix are ignored', () => {
  assert.equal(storeKey('ASUS ROG Exclusive Store — San Infotech'), 'san infotech');
  assert.equal(storeKey('  san   INFOTECH '), 'san infotech');
  assert.equal(storeKey('ROG Exclusive Store - San Infotech'), 'san infotech');
  assert.equal(storeKey('ASUS ROG Exclusive Store'), 'asus rog exclusive store'); // nothing left → itself
});

test('plan: create / update / unchanged / error, and stores not in the sheet are listed, never touched', () => {
  const stores = [
    store('s1', 'ASUS ROG Exclusive Store — San Infotech', 'Nashik', { mapsUrl: MAPS, state: 'Maharashtra', exclusive: true }),
    store('s2', 'Vision Computers', 'Pune', { date: '2026-10-25' }),
    store('s3', 'Not In The Sheet', 'Nagpur'),
  ];
  const p = plan(`Store name,ROG Exclusive,City,State,Maps,Date\nSan Infotech,Yes,Nashik,Maharashtra,${MQ},24/10/2026\nvision computers,Yes,Pune,Maharashtra,,26 Oct 2026\nTechno Hub,No,Nagpur,Maharashtra,,\nBad Row,No,Mumbai,Maharashtra,,31/02/2026\n`, stores);
  assert.deepEqual(p.items.map((i) => i.status), ['unchanged', 'update', 'create', 'error']);
  assert.equal(p.items[0].store!.id, 's1');
  assert.deepEqual(p.items[1].changes.map((c) => [c.field, c.from, c.to]), [
    ['state', '', 'Maharashtra'],
    ['exclusive', 'No', 'Yes'],
    ['date', '2026-10-25', '2026-10-26'],
  ]);
  assert.deepEqual(p.missing.map((s) => s.id), ['s3']);
  assert.deepEqual(p.counts, { create: 1, update: 1, unchanged: 1, error: 1 });
});

test('plan: a date equal to the campaign date is not a change for a store without its own', () => {
  const p = plan('Store name,Date\nA,24/10/2026\n', [store('s1', 'A')]);
  assert.equal(p.items[0].status, 'unchanged');
});

test('plan: a blank cell never erases', () => {
  const s = store('s1', 'A', 'Nashik', { phone: '123', venue: 'Ground floor' });
  const p = plan('Store name,City,Phone,Venue spot\nA,,,\n', [s]);
  assert.equal(p.items[0].status, 'unchanged');
});

test('plan: a chain — same name in two cities — is matched by city', () => {
  const stores = [store('m', 'Prime IT', 'Mumbai'), store('p', 'Prime IT', 'Pune')];
  const p = plan('Store name,City,State\nPrime IT,Pune,Maharashtra\nPrime IT,Mumbai,Maharashtra\n', stores);
  assert.deepEqual(p.items.map((i) => i.store?.id), ['p', 'm']);
  // without a City the row can't say which
  const q = plan('Store name,State\nPrime IT,Maharashtra\n', stores);
  assert.equal(q.items[0].status, 'error');
  assert.match(q.items[0].problems[0], /fits 2 stores/);
  // a sheet chain with only one of them in the campaign: the other city is new
  const r = plan('Store name,City\nPrime IT,Pune\nPrime IT,Goa\n', [stores[1]]);
  assert.deepEqual(r.items.map((i) => i.status), ['unchanged', 'create']);
});

test('plan: two rows can’t claim one store; an errored row still keeps its store out of "not in the sheet"', () => {
  const stores = [store('s1', 'San Infotech', 'Nashik'), store('s2', 'Other', 'Pune')];
  const p = plan('Store name,City,Date\nSan Infotech,Nashik,\nASUS ROG Exclusive Store — San Infotech,,\nOther,Pune,bad\n', stores);
  assert.deepEqual(p.items.map((i) => i.status), ['unchanged', 'error', 'error']);
  assert.match(p.items[1].row.errors[0] ?? p.items[1].problems[0], /Same store/);
  assert.deepEqual(p.missing, []);
});

test('plan: a sheet-level error plans nothing', () => {
  const p = plan('City\nNashik\n', [store('s1', 'A')]);
  assert.deepEqual(p.items, []);
  assert.deepEqual(p.missing, []);
});

test('plan: exclusive changes and admin changes are listed with names', () => {
  const s = store('s1', 'A', 'Nashik', { adminId: 'a2', admin: 'Priya Nair' });
  const p = plan('Store name,Exclusive,Admin\nA,yes,Rahul Sharma\n', [s]);
  assert.deepEqual(p.items[0].changes.map((c) => [c.field, c.from, c.to]), [['exclusive', 'No', 'Yes'], ['admin', 'Priya Nair', 'Rahul Sharma']]);
});

/* ---------- applying ---------- */

test('apply: a new store gets the sheet’s fields, a valid document, geo and Toornament link', () => {
  const p = plan(`Store name,ROG Exclusive,City,State,Maps,Address,Phone,Venue spot,Toornament,Date,Admin\nTechno Hub,yes,Nagpur,Maharashtra,${MQ},1 Main Rd,98200 11111,Ground floor,${TN},2026-10-25,Priya Menon\n`, []);
  const it = p.items[0];
  assert.equal(it.status, 'create');
  assert.equal(needsResolve(it), false);
  const s = store('n1', 'Techno Hub');
  applySheetFields(s, it.row.fields, it.row.geo, { a3: { name: 'Priya Menon' } }, EVENT.date, '2026-10-20T00:00:00.000Z');
  assert.equal(s.exclusive, true);
  assert.equal(s.state, 'Maharashtra');
  assert.equal(s.city, 'Nagpur');
  assert.equal(s.date, '2026-10-25');
  assert.deepEqual(s.geo, { lat: 19.9975, lng: 73.7898, accuracy: 0 });
  assert.equal(s.toornament?.url, TN);
  assert.equal(s.adminId, 'a3');
  assert.equal(s.admin, 'Priya Menon');
  assert.deepEqual(validateDocument('stores', s, { events: { e1: fixtureEvent('e1') as any }, admins: { a3: { id: 'a3', name: 'Priya Menon', phone: '', code: 'AAA2', createdAt: '2026-10-01T00:00:00.000Z' } as any } }), []);
});

test('apply: an update changes only what the sheet has; Maps link replaces geo, Toornament keeps its fetch state', () => {
  const s = store('s1', 'A', 'Nashik', { phone: '123', mapsUrl: MAPS, geo: { lat: 1, lng: 2, accuracy: 0 }, toornament: { url: TN, stageId: '5', stageName: 'Main' } });
  const f = parse(`Store name,Maps,Toornament,State\nA,${MQ},${TN},Maharashtra\n`).rows[0].fields;
  applySheetFields(s, f, { lat: 9, lng: 9, accuracy: 0 }, {}, EVENT.date);
  assert.equal(s.phone, '123');
  assert.equal(s.state, 'Maharashtra');
  assert.deepEqual(s.geo, { lat: 1, lng: 2, accuracy: 0 }); // same link: geo untouched
  assert.equal(s.toornament?.stageId, '5'); // same link: kept
  const g = parse('Store name,Maps\nA,"https://www.google.com/maps/place/Else/@20.0,74.0,17z"\n').rows[0];
  applySheetFields(s, g.fields, g.geo, {}, EVENT.date);
  assert.deepEqual(s.geo, { lat: 20, lng: 74, accuracy: 0 });
  const h = parse('Store name,Maps\nA,https://maps.app.goo.gl/q\n').rows[0];
  assert.equal(needsResolve({ row: h, status: 'update', changes: [{ field: 'mapsUrl', label: '', from: '', to: '' }], problems: [] }), true);
  applySheetFields(s, h.fields, null, {}, EVENT.date); // the server couldn't expand it
  assert.equal(s.geo, null);
});

test('apply: a date equal to the campaign date isn’t written to a store that follows the campaign', () => {
  const s = store('s1', 'A');
  applySheetFields(s, { name: 'A', date: '2026-10-24' }, null, {}, EVENT.date);
  assert.equal(s.date, undefined);
});
