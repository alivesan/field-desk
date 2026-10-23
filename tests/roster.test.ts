/*
 * HQ roster import (src/lib/roster.ts) — parsing, column / store detection, player building,
 * the refresh diff, and the result going through the real bracket.load handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeText, detectColumns, diffRoster, diffSummary, loadStatus, looksLikeHtml, matchStore, parseRoster, parseTable, readyStores, type RosterParse, type StoreRef } from '../src/lib/roster.ts';
import { applyCommand, dayVersion, type CommandContext } from '../src/lib/commands.ts';
import { playerIdFor } from '../src/lib/phone.ts';
import type { Player, Store, TournamentEvent } from '../src/lib/types.ts';

const BOM = String.fromCharCode(0xfeff);

const STORES: StoreRef[] = [
  { id: 'nsk', name: 'ASUS ROG Exclusive Store — San Infotech', city: 'Nashik' },
  { id: 'pne', name: 'ASUS ROG Exclusive Store — Vision Computers', city: 'Pune' },
  { id: 'bom1', name: 'ASUS ROG Exclusive Store — Prime IT', city: 'Mumbai' },
  { id: 'bom2', name: 'ASUS ROG Exclusive Store — Lamington Road', city: 'Mumbai' },
  { id: 'ngp', name: 'ASUS ROG Exclusive Store — Techno Hub', city: 'Nagpur' },
];

const one = (text: string, storeId = 'nsk') => parseRoster(text, { stores: STORES, storeId });
const store = (p: RosterParse, id: string) => p.stores.find((s) => s.storeId === id)!;
const names = (p: RosterParse, id = 'nsk') => store(p, id).players.map((x) => x.name);
const msgs = (list: { line: number; message: string }[]) => list.map((e) => `${e.line}: ${e.message}`).join('\n');

/* ---------- CSV / TSV ---------- */

test('CSV: quoted fields, escaped quotes, commas and line breaks inside quotes, CRLF', () => {
  const t = parseTable('Name,Note\r\n"Rao, Asha","said ""hi"""\r\n"Two\r\nlines",x\r\n');
  assert.equal(t.delimiter, ',');
  assert.deepEqual(t.rows, [
    ['Name', 'Note'],
    ['Rao, Asha', 'said "hi"'],
    ['Two\r\nlines', 'x'],
  ]);
});

test('CSV: BOM, semicolons, tabs, lone CR, blank and ragged rows keep sheet numbering', () => {
  assert.deepEqual(parseTable(`${BOM}Name;Phone\n"A; B";1\n`).rows, [
    ['Name', 'Phone'],
    ['A; B', '1'],
  ]);
  assert.equal(parseTable('Name;Phone\nA;1\nB;2').delimiter, ';');
  const tsv = parseTable('Name\tPhone\tStore\rAsha\t98200 11111\r\rBilal\r');
  assert.equal(tsv.delimiter, '\t');
  assert.deepEqual(tsv.rows, [['Name', 'Phone', 'Store'], ['Asha', '98200 11111'], [''], ['Bilal']]);
  // A comma inside a quoted name doesn't make a semicolon file look comma-separated.
  assert.equal(parseTable('Name;Phone\n"Rao, Asha";1\n"Khan, Bilal";2\n').delimiter, ';');
  // One column, no delimiter.
  assert.equal(parseTable('Asha\nBilal\n').delimiter, null);
  // An unclosed quote is reported, not lost.
  const bad = parseTable('Name\n"Asha\nBilal\n');
  assert.equal(bad.unclosedQuote, 2);
});

test('blank lines, ragged rows and spaces around cells are tolerated in a roster', () => {
  const r = one('\n Name , Phone \n\nAsha ,  98200 11111\nBilal\n , \nChetan,98200 33333,extra,cells\n');
  assert.deepEqual(names(r), ['Asha', 'Bilal', 'Chetan']);
  assert.deepEqual(store(r, 'nsk').entries.map((e) => e.line), [4, 5, 7]);
  assert.equal(r.rows, 3); // the " , " row counts as blank
});

/* ---------- columns ---------- */

test('header synonyms with case, spacing and (notes) tolerated', () => {
  const c = (h: string[]) => detectColumns(h).columns;
  assert.deepEqual(c(['Player Name', 'Mobile', 'Rank', 'Store Name']), { name: 0, phone: 1, seed: 2, store: 3 });
  assert.deepEqual(c(['FULL NAME', 'WhatsApp', 'Venue']), { name: 0, phone: 1, store: 2 });
  assert.deepEqual(c(['participant', 'Phone Number (WhatsApp preferred)', 'Seed', 'City']), { name: 0, phone: 1, seed: 2, city: 3 });
  assert.deepEqual(c(['Name', 'Contact', 'Location', 'IGN', 'Team Name']), { name: 0, phone: 1, store: 2, ign: 3, team: 4 });
  assert.deepEqual(c(['Timestamp', 'Your full name', 'Your WhatsApp number', 'Store you will play at']), { name: 1, phone: 2, store: 3 });
  assert.deepEqual(c(['First Name', 'Last Name', 'Number']), { first: 0, last: 1, phone: 2 });
  assert.deepEqual(c(['Store Name', 'Name']), { store: 0, name: 1 }); // "Store Name" isn't the player name
});

test('IGN goes on the player, team is display-only, first + last names are joined', () => {
  const r = one('First Name,Last Name,Phone,IGN,Team\nAsha,Rao,9820011111,  ash   X ,Red\nBilal,Khan,9820022222,,\n');
  assert.deepEqual(names(r), ['Asha Rao', 'Bilal Khan']);
  const [a, b] = store(r, 'nsk').players;
  assert.deepEqual(a, { id: playerIdFor('9820011111', 'Asha Rao'), name: 'Asha Rao', seed: 1, phone: '9820011111', ign: 'ash X' }, 'spaces collapsed; the id ignores the IGN');
  assert.equal(b.ign, undefined);
  assert.equal(store(r, 'nsk').entries[0].team, 'Red');
});

test('in-game name headers: IGN, In-game name, Gamertag, Game ID, Username, Riot ID, Steam name…', () => {
  const c = (h: string[]) => detectColumns(h).columns;
  for (const h of ['IGN', 'ign', 'In-game name', 'In Game Name', 'In-Game Name (IGN)', 'Gamertag', 'Gamer Tag', 'Game ID', 'Game Name', 'Username', 'User name', 'Nickname', 'Riot ID', 'Steam name', 'Steam ID', 'BattleTag', 'Your in-game name', 'IGN / Gamertag'])
    assert.deepEqual(c(['Name', h, 'Phone']), { name: 0, ign: 1, phone: 2 }, h);
  // Never stolen from the Name column, whichever comes first
  assert.deepEqual(c(['Username', 'Full Name']), { ign: 0, name: 1 });
  assert.deepEqual(c(['Player', 'Gamertag']), { name: 0, ign: 1 });
  // "Game" alone (which game they play) and "Team name" are not in-game names
  assert.deepEqual(c(['Name', 'Game', 'Team name']), { name: 0, team: 2 });
});

test('a lone Username / IGN column with no Name column is read as the names', () => {
  const d = detectColumns(['Username', 'Phone']);
  assert.deepEqual(d.columns, { name: 0, phone: 1 });
  assert.equal(d.nameFromIgn, true);
  const r = one('Username,Phone\nashX,9820011111\nb1lal,9820022222\n');
  assert.equal(r.kind, 'table');
  assert.deepEqual(names(r), ['ashX', 'b1lal']);
  assert.equal(store(r, 'nsk').players[0].ign, undefined);
  assert.match(msgs(r.warnings), /No Name column — using “Username” as the player names/);
  // A single "Gamertag" column is a header, not a player called "Gamertag"
  assert.deepEqual(names(one('Gamertag\nashX\nb1lal\n')), ['ashX', 'b1lal']);
});

test('email and Discord columns are never read or kept; the preview names them', () => {
  const c = (h: string[]) => detectColumns(h).columns;
  assert.deepEqual(c(['Name', 'Email', 'Discord', 'Discord Username', 'Discord name', 'Contact email', 'Phone']), { name: 0, phone: 6 });
  assert.deepEqual(c(['Discord name', 'Email', 'IGN']), { name: 2 }, 'a Discord name is not the player name');
  const r = one('Name,Email,Discord,IGN,Phone\nAsha Rao,asha@example.test,asha#1234,AshR,9820011111\nBilal,b@example.test,bilal,,9820022222\n');
  assert.deepEqual(r.ignored, ['Email', 'Discord']);
  assert.deepEqual(r.columns, { name: 'Name', ign: 'IGN', phone: 'Phone' });
  const kept = JSON.stringify(store(r, 'nsk'));
  assert.ok(!kept.includes('example.test') && !kept.includes('#1234'), 'nothing from those columns reaches the roster');
  assert.deepEqual(store(r, 'nsk').players.map((p) => p.ign), ['AshR', undefined]);
});

test('an IGN longer than 40 characters is left out with a warning; one equal to the name is dropped', () => {
  const long = 'x'.repeat(41);
  const r = one(`Name,IGN\nAsha,${long}\nBilal,BILAL\nChetan,${'c'.repeat(40)}\n`);
  assert.deepEqual(store(r, 'nsk').players.map((p) => p.ign), [undefined, undefined, 'c'.repeat(40)]);
  assert.match(msgs(store(r, 'nsk').warnings), /Asha: in-game name .* longer than 40 characters — left out/);
  assert.ok(store(r, 'nsk').ready);
});

test('a header without a name column is an error', () => {
  const r = one('Phone,Store\n9820011111,Nashik\n');
  assert.match(msgs(r.errors), /No name column/);
  assert.equal(readyStores(r).length, 0);
});

test('headerless lists: one name per line (numbering stripped), or name + phone columns', () => {
  const r = one('1. Asha Rao\n2) Bilal  Khan\n\nChetan\n');
  assert.equal(r.kind, 'list');
  assert.deepEqual(names(r), ['Asha Rao', 'Bilal Khan', 'Chetan']);
  assert.deepEqual(store(r, 'nsk').entries.map((e) => e.line), [1, 2, 4]);
  assert.match(msgs(store(r, 'nsk').warnings), /No phone numbers/);

  const two = one('Asha Rao\t+91 98200 11111\nBilal Khan\t098200 22222\n');
  assert.deepEqual(names(two), ['Asha Rao', 'Bilal Khan']);
  assert.deepEqual(store(two, 'nsk').players.map((p) => p.phone), ['9820011111', '9820022222']);
  assert.match(msgs(two.warnings), /No header row/);

  const flipped = one('98200 11111,Asha Rao\n98200 22222,Bilal Khan\n');
  assert.deepEqual(names(flipped), ['Asha Rao', 'Bilal Khan']);
});

/* ---------- stores ---------- */

test('store matching: exact, part of the name, city, combined parts, ambiguous, unmatched', () => {
  const id = (v: string) => {
    const m = matchStore(v, STORES);
    return 'store' in m ? m.store.id : 'ambiguous' in m ? `ambiguous:${m.ambiguous.map((s) => s.id).join('+')}` : 'none';
  };
  assert.equal(id('ASUS ROG Exclusive Store — San Infotech'), 'nsk');
  assert.equal(id('asus rog exclusive store - san infotech'), 'nsk');
  assert.equal(id('San Infotech'), 'nsk');
  assert.equal(id('  VISION computers '), 'pne');
  assert.equal(id('Nagpur'), 'ngp');
  assert.equal(id('San Infotech, Nashik'), 'nsk');
  assert.equal(id('Prime IT - Mumbai'), 'bom1');
  assert.equal(id('ASUS ROG Exclusive Store — Prime IT, Mumbai'), 'bom1');
  assert.equal(id('Mumbai'), 'ambiguous:bom1+bom2');
  assert.equal(id('ASUS ROG'), 'ambiguous:nsk+pne+bom1+bom2+ngp');
  assert.equal(id('Delhi'), 'none');
  assert.equal(id('IT'), 'none'); // too short to match part of a name
});

test('campaign scope: rows go to their stores; ambiguous / unmatched / blank store rows are errors with rows', () => {
  const csv = ['Name,Phone,Store', 'Asha,9820011111,San Infotech', 'Bilal,9820022222,Nashik', 'Chetan,9820033333,Mumbai', 'Dev,9820044444,Delhi', 'Esha,9820055555,Delhi', 'Farah,9820066666,', 'Gita,9820077777,Pune', 'Hari,9820088888,Vision Computers'].join('\n');
  const r = parseRoster(csv, { stores: STORES });
  assert.equal(r.stores.length, 5);
  assert.deepEqual(names(r, 'nsk'), ['Asha', 'Bilal']);
  assert.deepEqual(names(r, 'pne'), ['Gita', 'Hari']);
  assert.deepEqual(r.errors.map((e) => e.line).sort(), [4, 5, 7]);
  assert.match(msgs(r.errors), /^4: Row 4: “Mumbai” matches 2 stores/m);
  assert.match(msgs(r.errors), /^5: Rows 5, 6: “Delhi” doesn’t match any store/m);
  assert.match(msgs(r.errors), /^7: Row 7: no store given/m);
  assert.equal(readyStores(r).length, 0, 'nothing loads while rows can’t be placed');
  assert.match(msgs(store(r, 'ngp').warnings), /Not in this list/);
  assert.equal(store(r, 'ngp').ready, false);
});

test('campaign scope without a store column: an error for several stores, fine for one', () => {
  const r = parseRoster('Name,Phone\nAsha,9820011111\nBilal,9820022222\n', { stores: STORES });
  assert.match(msgs(r.errors), /no Store column/);
  const solo = parseRoster('Name,Phone\nAsha,9820011111\nBilal,9820022222\n', { stores: [STORES[0]] });
  assert.equal(solo.errors.length, 0);
  assert.equal(readyStores(solo).length, 1);
});

test('single-store scope: a store column only filters; other stores skipped, unknown ones warned', () => {
  const csv = 'Name,Phone,Store\nAsha,9820011111,San Infotech\nBilal,9820022222,Pune\nChetan,9820033333,\nDev,9820044444,Delhi\nEsha,9820055555,Nashik\n';
  const r = one(csv);
  assert.equal(r.errors.length, 0, msgs(r.errors));
  assert.deepEqual(names(r), ['Asha', 'Chetan', 'Esha']);
  assert.match(msgs(r.warnings), /Skipped 1 row for other stores/);
  assert.match(msgs(r.warnings), /Row 5: “Delhi” doesn’t match any store in this campaign — skipped/);
  assert.equal(readyStores(r).length, 1);
  assert.match(msgs(one('Name,Store\nA,Pune\nB,Pune\n').stores[0].errors), /No players for this store/);
});

/* ---------- players ---------- */

test('phones are normalized; invalid phones are row errors; missing phones a warning', () => {
  const r = one('Name,Phone\nAsha,+91 98200-11111\nBilal,098200 22222\nChetan,(982) 003-3333\nDev,12345\nEsha,9.82E+09\nFarah,\nGita,  \n');
  const s = store(r, 'nsk');
  assert.deepEqual(
    s.players.map((p) => [p.name, p.phone]),
    [
      ['Asha', '9820011111'],
      ['Bilal', '9820022222'],
      ['Chetan', '9820033333'],
      ['Farah', undefined],
      ['Gita', undefined],
    ],
  );
  assert.deepEqual(
    s.errors.map((e) => e.line),
    [5, 6],
  );
  assert.match(msgs(s.errors), /^5: Dev: “12345” isn’t a phone number/m);
  assert.match(msgs(s.errors), /^6: .*turned this phone into a number/m);
  assert.match(msgs(s.warnings), /^7: Rows 7, 8: no phone number — these players can’t check in with the QR/m);
  assert.equal(s.ready, false, 'a store with row errors is not loaded');
});

test('a phone number in the name column is caught (swapped columns)', () => {
  const r = one('Name,Phone\n9820011111,Asha\nBilal,9820022222\n');
  assert.match(msgs(store(r, 'nsk').errors), /^2: .*looks like a phone number/m);
});

test('duplicate numbers / names are questions for HQ ("which one is it?"), not errors', () => {
  const text = 'Name,Phone\nAsha Rao,9820011111\nBilal,9820022222\nasha  rao,9820033333\nChetan,+91 9820022222\n';
  const s = store(one(text), 'nsk');
  assert.equal(s.errors.length, 0, msgs(s.errors));
  assert.equal(s.ready, false, 'not loadable until answered');
  const [phoneQ, nameQ] = s.questions;
  assert.equal(phoneQ.kind, 'phone');
  assert.match(phoneQ.title, /Same number •••• •• 2222 on rows 3 and 5 — which one is it\?/);
  assert.deepEqual(phoneQ.options.map((o) => [o.line, o.name]), [[3, 'Bilal'], [5, 'Chetan']]);
  assert.doesNotMatch(phoneQ.title, /9820022222/, 'the number is masked');
  assert.equal(nameQ.kind, 'name');
  assert.match(nameQ.title, /Two players called “Asha Rao” \(rows 2 and 4\) — which one is it\?/);
  // held rows are out of the roster while unanswered
  assert.deepEqual(s.players.map((p) => p.name), []);

  // answer: it's Chetan; and the two Ashas are different people
  const answered = store(parseRoster(text, { stores: STORES, storeId: 'nsk', answers: { [phoneQ.key]: 5, [nameQ.key]: 'all' } }), 'nsk');
  assert.equal(answered.ready, true, msgs(answered.errors));
  assert.deepEqual(answered.questions, []);
  assert.deepEqual(answered.players.map((p) => p.name).sort(), ['Asha Rao', 'Chetan', 'asha rao (2)'].sort());

  // "both share a number": both kept, with different ids
  const shared = store(parseRoster(text, { stores: STORES, storeId: 'nsk', answers: { [phoneQ.key]: 'all', [nameQ.key]: 2 } }), 'nsk');
  const both = shared.players.filter((p) => p.phone === '9820022222');
  assert.equal(both.length, 2);
  assert.notEqual(both[0].id, both[1].id);

  // an exact repeat (same name, same number) is kept once, with a note
  const rep = store(one('Name,Phone\nAsha,9820011111\nBilal,9820022222\nAsha,98200 11111\n'), 'nsk');
  assert.deepEqual(rep.questions, []);
  assert.equal(rep.players.length, 2);
  assert.match(msgs(rep.warnings), /Row 4 repeats row 2/);

  // the same player at two different stores is fine
  const r2 = parseRoster('Name,Phone,Store\nAsha,9820011111,Nashik\nBilal,9820022222,Nashik\nAsha,9820011111,Pune\nDev,9820044444,Pune\n', { stores: STORES });
  assert.equal(store(r2, 'nsk').questions.length + store(r2, 'pne').questions.length, 0);
});

test('seeds: from the column (1st, #2, 3.0), validated, unseeded after seeded; else row order', () => {
  const r = one('Name,Seed\nAsha,3\nBilal,#1\nChetan,\nDev,2nd\nEsha,7.0\n');
  const s = store(r, 'nsk');
  assert.equal(s.errors.length, 0, msgs(s.errors));
  assert.deepEqual(s.players.map((p) => `${p.seed}:${p.name}`), ['1:Bilal', '2:Dev', '3:Asha', '4:Esha', '5:Chetan']);
  assert.match(msgs(s.warnings), /1 player without a seed goes after the 4 seeded/);

  const bad = store(one('Name,Seed\nAsha,1\nBilal,0\nChetan,x\nDev,1\nEsha,-2\n'), 'nsk');
  assert.deepEqual(bad.errors.map((e) => e.line), [3, 4, 5, 6]);
  assert.match(bad.errors[2].message, /seed 1 is also given on row 2 \(rows 2 and 5\)/);

  assert.deepEqual(store(one('Name\nZed\nAmy\nMo\n'), 'nsk').players.map((p) => p.seed), [1, 2, 3]);
});

test('player limits: one player is an error, over 256 is an error', () => {
  assert.match(msgs(store(one('Name\nAsha\n'), 'nsk').errors), /at least 2/);
  const many = ['Name', ...Array.from({ length: 257 }, (_, i) => `Player ${i + 1}`)].join('\n');
  assert.match(msgs(store(one(many), 'nsk').errors), /at most 256/);
  const max = ['Name', ...Array.from({ length: 256 }, (_, i) => `Player ${i + 1}`)].join('\n');
  assert.equal(store(one(max), 'nsk').ready, true);
});

test('ids are stable: same input → same ids; reordered / respaced input → same ids per player', () => {
  const a = one('Name,Phone\nAsha Rao,9820011111\nBilal,\nChetan,9820033333\n');
  const b = one('Phone;Player\n"+91 98200 33333";Chetan\n;Bilal\n098200 11111;Asha   Rao\n');
  const ids = (p: RosterParse) => Object.fromEntries(store(p, 'nsk').players.map((x) => [x.name, x.id]));
  assert.deepEqual(ids(one('Name,Phone\nAsha Rao,9820011111\nBilal,\nChetan,9820033333\n')), ids(a));
  assert.deepEqual(ids(b), ids(a));
  assert.equal(ids(a)['Asha Rao'], playerIdFor('9820011111', 'Asha Rao'));
  assert.equal(ids(a)['Bilal'], playerIdFor(undefined, 'Bilal'));
  // a rename keeps the id when the phone is the same
  assert.equal(ids(one('Name,Phone\nAsha R.,9820011111\nX,\n'))['Asha R.'], ids(a)['Asha Rao']);
});

/* ---------- refresh diff ---------- */

const P = (name: string, phone: string | undefined, seed: number): Player => ({ id: playerIdFor(phone, name), name, seed, ...(phone ? { phone } : {}) });

test('diff: added, removed, renamed, phone changed, reseeded, unchanged', () => {
  const cur = [P('Asha', '9820011111', 1), P('Bilal', '9820022222', 2), P('Chetan', '9820033333', 3), P('Dev', undefined, 4)];
  assert.equal(diffRoster(cur, cur.map((p) => ({ ...p }))).same, true);
  // phones dropped by an older server copy don't count as a change (ids decide)
  assert.equal(diffRoster(cur.map(({ phone: _, ...p }) => p), cur).same, true);

  const next = [P('Asha Rao', '9820011111', 1), P('Chetan', '9820099999', 2), P('Dev', '9820044444', 3), P('Esha', '9820055555', 4)];
  const d = diffRoster(cur, next);
  assert.deepEqual(d.added.map((p) => p.name), ['Esha']);
  assert.deepEqual(d.removed.map((p) => p.name), ['Bilal']);
  assert.deepEqual(d.renamed.map((x) => `${x.from.name}→${x.to.name}`), ['Asha→Asha Rao']);
  assert.deepEqual(d.phoneChanged.map((x) => `${x.from.name}:${x.from.phone ?? '-'}→${x.to.phone}`), ['Chetan:9820033333→9820099999', 'Dev:-→9820044444']);
  assert.equal(d.reseeded, 0);
  assert.equal(d.same, false);
  assert.equal(diffSummary(d), '+1 added · 1 removed · 1 renamed · 2 new phone numbers');

  const swapped = diffRoster(cur, [{ ...cur[1], seed: 1 }, { ...cur[0], seed: 2 }, cur[2], cur[3]]);
  assert.equal(swapped.reseeded, 2);
  assert.equal(diffSummary(swapped), '2 reseeded');
});

test('loadStatus mirrors the handler: create / update / unchanged / started', () => {
  const players = [P('Asha', '9820011111', 1), P('Bilal', '9820022222', 2)];
  const day = (over: Partial<Store['day']> = {}): Store['day'] => ({ players: [], checkIn: {}, matches: [], stations: 2, ...over });
  assert.equal(loadStatus(day(), players).status, 'create');
  const m = { id: 'm1', round: 0, index: 0, a: players[0].id, b: players[1].id, winner: null, status: 'pending' as const, score: '' };
  assert.equal(loadStatus(day({ players, matches: [m] }), players).status, 'unchanged');
  assert.equal(loadStatus(day({ players, matches: [m] }), [...players, P('Chetan', '9820033333', 3)]).status, 'update');
  assert.equal(loadStatus(day({ players, matches: [{ ...m, status: 'live', station: 1 }] }), players).status, 'started');
  assert.equal(loadStatus(day({ players, matches: [{ ...m, status: 'done', winner: players[0].id }] }), players).status, 'started');
});

test('a fetched web page instead of CSV is recognised', () => {
  assert.equal(looksLikeHtml('<!DOCTYPE html><html>…'), true);
  assert.equal(looksLikeHtml(`${BOM}  <html lang="en">`), true);
  assert.equal(looksLikeHtml('Name,Phone\n<b>Asha</b>,1'), false);
});

/* ---------- through the real handler ---------- */

const event: TournamentEvent = { id: 'e1', name: 'ROG Cup', date: '2026-10-24', games: [], collateral: [], gameReadyTarget: 0, minDownMbps: 0, createdAt: '2026-10-01T00:00:00.000Z' };
let seq = 0;
const hq = (): CommandContext => ({ commandId: `roster-${++seq}`, now: '2026-10-23T10:00:00.000Z', actor: { principal: 'super', name: 'HQ', role: 'super' }, event });
const emptyStore = (s: StoreRef): Store => ({ id: s.id, eventId: 'e1', name: s.name, city: s.city, address: '', admin: '', pin: null, recce: {} as Store['recce'], day: { players: [], checkIn: {}, matches: [], stations: 3 } });

// A realistic export: Google Form → Sheet, five stores over two days, messy phones and spacing.
function campaignCsv(extra = '') {
  const header = 'Timestamp,Full Name,WhatsApp Number,IGN,Store,City';
  const where: [string, string][] = [
    ['San Infotech', 'Nashik'],
    ['Vision Computers', 'Pune'],
    ['Prime IT', 'Mumbai'],
    ['Lamington Road', 'Mumbai'],
    ['ASUS ROG Exclusive Store — Techno Hub', 'Nagpur'],
  ];
  const rows: string[] = [];
  let n = 0;
  where.forEach(([s, city], k) => {
    const count = [12, 9, 16, 5, 7][k];
    for (let i = 0; i < count; i++) {
      n++;
      const phone = i % 3 === 0 ? `+91 98${String(n).padStart(3, '0')} ${String(10000 + n)}` : i % 3 === 1 ? `098${String(n).padStart(3, '0')}${10000 + n}` : `98${String(n).padStart(3, '0')}${10000 + n}`;
      rows.push(`24/10/2026 10:${String(i).padStart(2, '0')},"  Player ${n}  ${k ? '' : ', Jr'}",${phone},gamer${n},"${s}",${city}`);
    }
  });
  return [header, ...rows].join('\r\n') + extra + '\r\n';
}

test('a realistic 5-store campaign CSV: every store loads through the real bracket.load handler', () => {
  const r = parseRoster(BOM + campaignCsv(), { stores: STORES });
  assert.equal(r.errors.length, 0, msgs(r.errors));
  assert.deepEqual(r.columns, { name: 'Full Name', phone: 'WhatsApp Number', ign: 'IGN', store: 'Store', city: 'City' });
  const ready = readyStores(r);
  assert.deepEqual(ready.map((s) => [s.storeId, s.players.length]), [
    ['nsk', 12],
    ['pne', 9],
    ['bom1', 16],
    ['bom2', 5],
    ['ngp', 7],
  ]);
  assert.equal(store(r, 'nsk').players[0].name, 'Player 1 , Jr');
  for (const s of ready) {
    for (const w of s.warnings) assert.fail(`unexpected warning at ${s.storeName}: ${w.message}`);
    const before = emptyStore(STORES.find((x) => x.id === s.storeId)!);
    const after = applyCommand(before, { type: 'bracket.load', base: dayVersion(before), players: s.players }, hq());
    assert.equal(after.day.players.length, s.players.length);
    assert.deepEqual(after.day.players.map((p) => [p.id, p.name, p.seed, p.phone]), s.players.map((p) => [p.id, p.name, p.seed, p.phone]));
    assert.ok(after.day.matches.length >= s.players.length - 1);
    assert.equal(after.day.version, 1);
    assert.ok(s.players.every((p) => p.phone && p.phone.length === 10));
  }
});

test('refresh: re-importing the edited sheet keeps ids, so check-ins carry over through bracket.load', () => {
  const first = parseRoster(campaignCsv(), { stores: STORES });
  const nsk = store(first, 'nsk');
  let s = applyCommand(emptyStore(STORES[0]), { type: 'bracket.load', base: 0, players: nsk.players }, hq());
  const asha = nsk.players[3].id;
  s = { ...s, day: { ...s.day, checkIn: { [asha]: '2026-10-24T09:00:00.000Z' }, checkInSource: { [asha]: 'self' } } };

  // The sheet gains a late entry for Nashik and is re-sorted; refresh just that store.
  const lines = campaignCsv('\r\n24/10/2026 11:00,Late Comer,9811122222,late,San Infotech,Nashik').split('\r\n');
  const shuffled = [lines[0], ...lines.slice(1).filter(Boolean).reverse()].join('\n');
  const again = parseRoster(shuffled, { stores: STORES, storeId: 'nsk' });
  const next = store(again, 'nsk');
  assert.equal(again.errors.length, 0, msgs(again.errors));
  const { status, diff } = loadStatus(s.day, next.players);
  assert.equal(status, 'update');
  assert.deepEqual(diff.added.map((p) => p.name), ['Late Comer']);
  assert.equal(diff.removed.length + diff.renamed.length + diff.phoneChanged.length, 0);
  assert.ok(diff.reseeded > 0, 'row order is the seed order, so a re-sorted sheet reseeds');
  const after = applyCommand(s, { type: 'bracket.load', base: dayVersion(s), players: next.players }, hq());
  assert.deepEqual(Object.keys(after.day.checkIn), [asha], 'the check-in survived the refresh');
  assert.deepEqual(after.day.checkInSource, { [asha]: 'self' });
  assert.equal(after.day.players.length, 13);
});

test('bracket.load keeps the players’ normalized phones (needed for QR self check-in)', () => {
  const r = one('Name,Phone\nAsha,+91 98200-11111\nBilal,098200 22222\nChetan,\n');
  const players = store(r, 'nsk').players;
  assert.ok(players.every((p) => p.phone === undefined || /^\d{6,15}$/.test(p.phone)), 'digits only, as the handler requires');
  const after = applyCommand(emptyStore(STORES[0]), { type: 'bracket.load', base: 0, players }, hq());
  assert.deepEqual(after.day.players.map((p) => p.phone), ['9820011111', '9820022222', undefined]);
});

test('an admin can’t load the parsed roster — HQ only', () => {
  const r = one('Name\nAsha\nBilal\n');
  const admin: CommandContext = { ...hq(), actor: { principal: 'admin:a1', name: 'Field', role: 'admin' } };
  assert.throws(() => applyCommand(emptyStore(STORES[0]), { type: 'bracket.load', base: 0, players: store(r, 'nsk').players }, admin), /admin can’t bracket.load/);
});

/* ---------- one store's page: upload → Load players ---------- */

// What a store's own player file looks like: Excel "CSV UTF-8" (BOM, CRLF), an Email column we
// don't use, phones typed every way, Excel-quoted names, blank rows, and a Store column.
function storeCsv(storeCell: string, count = 30) {
  const rows = ['Name,Phone,Email,Store'];
  for (let i = 1; i <= count; i++) {
    const n = 10000 + i;
    const phone = [`+91 98200 ${n}`, `"+91 98200-${n}"`, `098200${n}`, `98200 ${n}`][i % 4];
    rows.push(`${i % 5 ? `Player ${i}` : `"Rao, Player ${i}"`},${phone},p${i}@example.com,${storeCell}`);
    if (i % 9 === 0) rows.push('');
    if (i % 11 === 0) rows.push(',,,');
  }
  return BOM + rows.join('\r\n') + '\r\n';
}

test('a store’s own CSV: every row is loaded, in file order, into an empty store and over an existing roster', () => {
  const r = one(storeCsv('San Infotech'));
  const nsk = store(r, 'nsk');
  assert.equal(r.errors.length + nsk.errors.length, 0, msgs([...r.errors, ...nsk.errors]));
  assert.equal(r.rows, 30);
  assert.equal(readyStores(r).length, 1);
  assert.deepEqual(nsk.players.map((p) => p.seed), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(nsk.players[0].name, 'Player 1');
  assert.equal(nsk.players[4].name, 'Rao, Player 5');
  assert.ok(nsk.players.every((p) => p.phone && /^98200\d{5}$/.test(p.phone)));

  // Empty store → players.set (what Load players sends on the store page).
  let s = applyCommand(emptyStore(STORES[0]), { type: 'players.set', base: 0, players: nsk.players }, hq());
  assert.deepEqual(s.day.players, nsk.players);

  // A store that already has players (one checked in, a bracket built): the file replaces them.
  s = applyCommand(s, { type: 'bracket.build', base: dayVersion(s) }, hq());
  const kept = nsk.players[2].id;
  s = { ...s, day: { ...s.day, checkIn: { [kept]: '2026-10-24T09:00:00.000Z' } } };
  const edited = one(storeCsv('San Infotech', 34));
  const next = store(edited, 'nsk').players;
  assert.equal(next.length, 34);
  assert.equal(loadStatus(s.day, next).status, 'update');
  const after = applyCommand(s, { type: 'players.set', base: dayVersion(s), players: next }, hq());
  assert.equal(after.day.players.length, 34);
  assert.deepEqual(after.day.matches, [], 'an unstarted bracket is cleared');
  assert.deepEqual(Object.keys(after.day.checkIn), [kept], 'the check-in carries over');
});

test('a store’s own CSV whose Store column names no campaign store: every row is this store’s', () => {
  for (const cell of ['ROG Store Phoenix Mall', 'Store 1']) {
    const r = one(storeCsv(cell));
    assert.equal(store(r, 'nsk').players.length, 30, cell);
    assert.equal(readyStores(r).length, 1, cell);
    assert.match(msgs(r.warnings), /doesn’t name a store in this campaign — read every row/);
  }
  // Words of the store name and city in any order are a match, not a miss.
  assert.equal(store(one(storeCsv('San Infotech Nashik')), 'nsk').players.length, 30);
  assert.equal(store(one(storeCsv('ROG Nashik')), 'nsk').players.length, 30);
  const id = (v: string) => {
    const m = matchStore(v, STORES);
    return 'store' in m ? m.store.id : 'ambiguous' in m ? 'ambiguous' : 'none';
  };
  assert.equal(id('Prime IT Mumbai'), 'bom1');
  assert.equal(id('ROG Mumbai'), 'ambiguous');
  // A file that does name campaign stores still only filters (rows for Pune aren't Nashik's).
  const mixed = one('Name,Phone,Store\nAsha,9820011111,San Infotech\nBilal,9820022222,Pune\nChetan,9820033333,Delhi\nDev,9820044444,Nashik\n');
  assert.deepEqual(names(mixed), ['Asha', 'Dev']);
  // Only other stores' rows: nothing for this store, not "everything".
  assert.match(msgs(one('Name,Store\nA,Pune\nB,Pune\n').stores[0].errors), /No players for this store/);
});

test('uploaded files: UTF-8 (with or without BOM), Excel’s UTF-16 “Unicode Text”, and Windows-1252 CSV', () => {
  const text = 'Name,Phone\nJosé Ñúñez,9820011111\nAsha,9820022222\n';
  const utf8 = new TextEncoder().encode(text);
  assert.equal(decodeText(utf8), text);
  assert.deepEqual(names(one(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])))), ['José Ñúñez', 'Asha']);
  const le = new Uint8Array(2 + text.length * 2);
  le.set([0xff, 0xfe]);
  for (let i = 0; i < text.length; i++) le[2 + i * 2] = text.charCodeAt(i);
  assert.equal(decodeText(le), text);
  const cp1252 = Uint8Array.from(text, (c) => c.charCodeAt(0)); // é Ñ ú ñ are single bytes there
  assert.equal(decodeText(cp1252), text);
});

test('re-importing with only in-game names changed is an update, not "unchanged"; ids and check-ins stay', () => {
  const first = store(one('Name,Phone,IGN\nAsha,9820011111,AshR\nBilal,9820022222,\n'), 'nsk').players;
  const next = store(one('Name,Phone,IGN\nAsha,9820011111,AshaTheGreat\nBilal,9820022222,B1\n'), 'nsk').players;
  assert.deepEqual(next.map((p) => p.id), first.map((p) => p.id));
  const d = diffRoster(first, next);
  assert.equal(d.same, false);
  assert.deepEqual(d.ignChanged.map((c) => [c.from.ign, c.to.ign]), [['AshR', 'AshaTheGreat'], [undefined, 'B1']]);
  assert.equal(diffSummary(d), '2 in-game names changed');
  assert.equal(diffRoster(first, first).same, true);

  let s = applyCommand(emptyStore(STORES[0]), { type: 'players.set', base: 0, players: first }, hq());
  s = { ...s, day: { ...s.day, checkIn: { [first[0].id]: '2026-10-24T09:00:00.000Z' } } };
  assert.equal(loadStatus(s.day, next).status, 'update');
  const after = applyCommand(s, { type: 'players.set', base: dayVersion(s), players: next }, hq());
  assert.deepEqual(after.day.players.map((p) => p.ign), ['AshaTheGreat', 'B1']);
  assert.deepEqual(Object.keys(after.day.checkIn), [first[0].id], 'the check-in carries over');
});
