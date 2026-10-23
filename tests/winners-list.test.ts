/*
 * HQ's winners list (src/lib/winners.ts) — one row per store per place, the statuses, the sort
 * order, and the CSV HQ downloads. Brackets are built with the real bracket code; the saved
 * details are written into day.winners the way winners.set leaves them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBracket, resolve } from '../src/lib/bracket.ts';
import { playerIdFor } from '../src/lib/phone.ts';
import { storeWinnerRows, summarize, winnerRows, winnersCsv, CSV_HEADER } from '../src/lib/winners.ts';
import type { Match, Player, Store, TournamentEvent, WinnerDetails, Winners } from '../src/lib/types.ts';
import { fixtureStore } from './helpers/server.ts';

const ev = (id: string, name: string, date: string): TournamentEvent => ({ id, name, date, games: [], collateral: [], gameReadyTarget: 4, minDownMbps: 25, createdAt: '2026-10-01T00:00:00.000Z' });
const events = { e1: ev('e1', 'Campus Clash', '2026-10-24'), e2: ev('e2', 'Alpha Cup', '2026-10-20') };
const player = (name: string, phone: string | undefined, seed: number, ign?: string): Player => ({ id: playerIdFor(phone, name), name, seed, ...(phone ? { phone } : {}), ...(ign ? { ign } : {}) });
const roster = () => [player('Asha Rao', '9820011111', 1, 'AshaX'), player('Rohan Mehta', '9820022222', 2), player('Kabir Singh', '9820033333', 3), player('Meera Nair', '9820044444', 4)];

/** A 4-player bracket played out: seed 1 beats seed 4 and seed 2 beats seed 3, then `finalWinner` of the two wins. */
function played(players: Player[], upTo: 'none' | 'semis' | 'final', idPrefix: string): Match[] {
  let ms = buildBracket(players, null, idPrefix);
  if (upTo === 'none') return ms;
  const semi = ms.filter((m) => m.round === 0);
  ms = ms.map((m) => (m.round === 0 ? { ...m, status: 'done' as const, winner: m.a, endedAt: '2026-10-24T11:00:00.000Z' } : m));
  ms = resolve(ms).matches;
  assert.equal(semi.length, 2);
  if (upTo === 'semis') return ms;
  return ms.map((m) => (m.round === 1 ? { ...m, status: 'done' as const, winner: m.a, score: '2-1', endedAt: '2026-10-24T12:00:00.000Z' } : m));
}

const full = (playerId: string, name: string): WinnerDetails => ({ playerId, realName: name, ign: 'ign', phone: '9820099999', email: 'x@example.com', instagram: 'handle_x' });
const savedFor = (matches: Match[], over: Partial<Winners> = {}, wOver: Partial<WinnerDetails> = {}, rOver: Partial<WinnerDetails> = {}): Winners => {
  const final = matches.find((m) => m.round === 1)!;
  const runner = final.winner === final.a ? final.b! : final.a!;
  return {
    winner: { ...full(final.winner!, 'Asha Rao'), ...wOver },
    runnerUp: { ...full(runner, 'Rohan Mehta'), ...rOver },
    finalMatchId: final.id,
    at: '2026-10-24T12:30:00.000Z',
    updatedAt: '2026-10-24T12:40:00.000Z',
    by: 'Priya (admin)',
    ...over,
  };
};

function store(id: string, eventId: string, name: string, over: Partial<Store> = {}, day: Partial<Store['day']> = {}): Store {
  const s = fixtureStore(id, eventId, null, { name, city: 'Mumbai', ...over }) as unknown as Store;
  return { ...s, day: { ...s.day, ...day } };
}
const withPlayers = (id: string, eventId: string, name: string, upTo: 'none' | 'semis' | 'final', over: Partial<Store> = {}, saved?: (m: Match[]) => Winners | undefined) => {
  const players = roster();
  const matches = upTo === 'none' ? [] : played(players, upTo, id);
  return store(id, eventId, name, over, { players, matches, ...(saved ? { winners: saved(matches) } : {}) });
};
const state = (...stores: Store[]) => ({ events, stores: Object.fromEntries(stores.map((s) => [s.id, s])) });
const rowsOf = (s: Store) => storeWinnerRows(s, events.e1);

test('a complete record: both places, from the bracket, with the store’s date and place', () => {
  const s = withPlayers('s1', 'e1', 'San Infotech', 'final', { state: 'Maharashtra' }, (m) => savedFor(m));
  const [w, r] = rowsOf(s);
  assert.deepEqual([w.place, w.status, w.realName, w.listName, w.campaign, w.store, w.city, w.state, w.date], ['Winner', 'complete', 'Asha Rao', 'Asha Rao', 'Campus Clash', 'San Infotech', 'Mumbai', 'Maharashtra', '2026-10-24']);
  assert.deepEqual([r.place, r.status, r.listName], ['Runner-up', 'complete', 'Rohan Mehta']);
  assert.equal(w.savedBy, 'Priya (admin)');
  assert.equal(w.savedAt, '2026-10-24T12:40:00.000Z');
  assert.ok(w.finalDone && r.finalDone);
});

test('the store’s own date wins over the campaign’s', () => {
  const s = withPlayers('s1', 'e1', 'Late Store', 'final', { date: '2026-11-02' });
  assert.equal(rowsOf(s)[0].date, '2026-11-02');
});

test('partial: lists what is missing; the in-game name is optional', () => {
  const s = withPlayers('s1', 'e1', 'A', 'final', {}, (m) => savedFor(m, {}, { ign: undefined, email: undefined }, { instagram: '', phone: undefined }));
  const [w, r] = rowsOf(s);
  assert.equal(w.status, 'partial');
  assert.deepEqual(w.missing, ['email']);
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.missing, ['phone', 'instagram']);
});

test('no details saved: the final is done, so who won still shows — from the player list', () => {
  const s = withPlayers('s1', 'e1', 'A', 'final');
  const [w, r] = rowsOf(s);
  assert.deepEqual([w.status, w.realName, w.ign, w.phone, w.savedAt], ['no-details', 'Asha Rao', 'AshaX', '9820011111', '']);
  assert.deepEqual([r.status, r.realName, r.phone], ['no-details', 'Rohan Mehta', '9820022222']);
});

test('no final: not played yet, or no bracket at all — two empty rows', () => {
  for (const upTo of ['none', 'semis'] as const) {
    const rows = rowsOf(withPlayers('s1', 'e1', 'A', upTo));
    assert.equal(rows.length, 2);
    for (const r of rows) assert.deepEqual([r.status, r.realName, r.finalDone], ['no-final', '', false]);
  }
});

test('mismatch: HQ reset the bracket after the details were saved — they are shown, flagged, never trusted', () => {
  const done = withPlayers('s1', 'e1', 'A', 'final', {}, (m) => savedFor(m));
  // Reset: no bracket, details kept.
  const reset = { ...done, day: { ...done.day, matches: [] } };
  const [w] = rowsOf(reset);
  assert.equal(w.status, 'mismatch');
  assert.equal(w.realName, 'Asha Rao');
  assert.match(w.note, /no finished final/);
  // Rebuilt and replayed differently: another player wins.
  const flipped = done.day.matches.map((m) => (m.round === 1 ? { ...m, winner: m.b } : m));
  const [w2, r2] = rowsOf({ ...done, day: { ...done.day, matches: flipped } });
  assert.deepEqual([w2.status, r2.status], ['mismatch', 'mismatch']);
  assert.match(w2.note, /different player/);
  // Another final match id.
  const other = rowsOf({ ...done, day: { ...done.day, winners: { ...done.day.winners!, finalMatchId: 'old-1-0' } } });
  assert.match(other[0].note, /different match/);
});

test('rows: one per store per place, filtered by campaign, sorted by event date, campaign, store', () => {
  const a = withPlayers('s1', 'e1', 'Zeta Store', 'final', {}, (m) => savedFor(m)); // 24 Oct
  const b = withPlayers('s2', 'e1', 'Alpha Store', 'none'); // 24 Oct
  const c = withPlayers('s3', 'e2', 'Mid Store', 'semis'); // 20 Oct, other campaign
  const d = withPlayers('s4', 'e1', 'Early Store', 'none', { date: '2026-10-19' });
  const rows = winnerRows(state(a, b, c, d));
  assert.deepEqual(
    rows.map((r) => `${r.date} ${r.store} ${r.place}`),
    ['2026-10-19 Early Store Winner', '2026-10-19 Early Store Runner-up', '2026-10-20 Mid Store Winner', '2026-10-20 Mid Store Runner-up', '2026-10-24 Alpha Store Winner', '2026-10-24 Alpha Store Runner-up', '2026-10-24 Zeta Store Winner', '2026-10-24 Zeta Store Runner-up'],
  );
  const e1 = winnerRows(state(a, b, c, d), { eventId: 'e1' });
  assert.equal(e1.length, 6);
  assert.ok(e1.every((r) => r.eventId === 'e1'));
  assert.deepEqual(winnerRows(state(a), { eventId: 'nope' }), []);
  // A store whose campaign is gone is skipped rather than crashing the page.
  assert.equal(winnerRows({ events: {}, stores: { s1: a } }).length, 0);
});

test('summary: stores with a final, with full details, and needing a look', () => {
  const full1 = withPlayers('s1', 'e1', 'A', 'final', {}, (m) => savedFor(m));
  const part = withPlayers('s2', 'e1', 'B', 'final', {}, (m) => savedFor(m, {}, { email: undefined }));
  const none = withPlayers('s3', 'e1', 'C', 'final');
  const open = withPlayers('s4', 'e1', 'D', 'semis');
  const stale = { ...withPlayers('s5', 'e1', 'E', 'final', {}, (m) => savedFor(m)), day: { ...full1.day, matches: [] } };
  assert.deepEqual(summarize(winnerRows(state(full1, part, none, open, stale))), { stores: 5, played: 3, full: 1, check: 1 });
  assert.deepEqual(summarize([]), { stores: 0, played: 0, full: 0, check: 0 });
});

test('CSV: BOM, the agreed header, one line per row, phones spaced, handle bare', () => {
  const s = withPlayers('s1', 'e1', 'San Infotech', 'final', { state: 'Maharashtra' }, (m) => savedFor(m, {}, { realName: 'Asha Rao', phone: '9820011111', instagram: 'asha.rao' }));
  const csv = winnersCsv(winnerRows(state(s)));
  assert.ok(csv.startsWith('\uFEFF'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'Campaign,Store,City,State,Event date (yyyy-mm-dd),Place,Real name,In-game name,Phone,Email,Instagram (@handle),Status,Saved at,Saved by');
  assert.equal(lines[0], CSV_HEADER.join(','));
  assert.equal(lines.length, 4); // header, winner, runner-up, trailing newline
  assert.match(lines[1], /^Campus Clash,San Infotech,Mumbai,Maharashtra,2026-10-24,Winner,Asha Rao,ign,98200 11111,x@example\.com,asha\.rao,Complete,2026-10-24 \d\d:\d\d,Priya \(admin\)$/);
  assert.match(lines[2], /,Runner-up,Rohan Mehta,/);
});

test('CSV: quoting and formula guard; unfinished stores are listed with their status', () => {
  const s = withPlayers('s1', 'e1', 'Chai, "Chat" & Co', 'final', { city: '=HYPERLINK("x")' }, (m) => savedFor(m, { by: '-cmd' }, { realName: '+91 Asha\nRao', instagram: 'a' }));
  const open = withPlayers('s2', 'e1', 'Open Store', 'semis');
  const part = withPlayers('s3', 'e1', 'Part Store', 'final', {}, (m) => savedFor(m, {}, { email: undefined, phone: undefined }));
  const csv = winnersCsv(winnerRows(state(s, open, part)));
  assert.match(csv, /"Chai, ""Chat"" & Co","'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"'\+91 Asha\nRao"/);
  assert.match(csv, /,'-cmd\r\n/);
  assert.match(csv, /Open Store,Mumbai,,2026-10-24,Winner,,,,,,Final not played,,\r\n/);
  assert.match(csv, /Partial — missing phone, email/);
  assert.equal(csv.split('\r\n').length, 1 + 6 + 1 - 0);
});
