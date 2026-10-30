/*
 * HQ's Steam accounts: the weekend rule (a "play" assignment is exclusive per Sat–Sun week, "download"
 * never clashes), how a weekend is read from a store's date, and what a store's team may see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictMessage, inUse, steamAvailability, steamConflicts, steamLoginFor, steamUses, storeWeekend, weekFilterKey, weekendPhrase } from '../src/lib/steam.ts';
import { shortStoreName } from '../src/lib/teams.ts';
import type { SteamAccount, SteamPurpose, Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

// 24 Oct 2026 is a Saturday: the week is Mon 19 – Sun 25, the next weekend Sat 31 Oct – Sun 1 Nov.
const SAT = '2026-10-24';
const acct = (id: string, over: Partial<SteamAccount> = {}): SteamAccount => ({ id, username: `test_rog_${id}`, password: 'fake-pass-123', createdAt: '2026-10-01T00:00:00.000Z', ...over });

function world(stores: { id: string; date?: string; steam?: [string, SteamPurpose]; eventId?: string }[], events: Record<string, Partial<TournamentEvent>> = { e1: {} }) {
  return {
    events: Object.fromEntries(Object.entries(events).map(([id, o]) => [id, { ...fixtureEvent(id), date: SAT, ...o } as TournamentEvent])),
    stores: Object.fromEntries(
      stores.map((s) => [
        s.id,
        fixtureStore(s.id, s.eventId ?? 'e1', null, {
          name: `ASUS ROG Exclusive Store — ${s.id}`,
          ...(s.date ? { date: s.date } : {}),
          ...(s.steam ? { steam: { accountId: s.steam[0], purpose: s.steam[1], assignedAt: '2026-10-20T00:00:00.000Z' } } : {}),
        }) as unknown as Store,
      ]),
    ),
  };
}
const names = (list: Store[]) => list.map((s) => s.id);

test('a play assignment is exclusive per weekend: a second store the same Saturday or Sunday is refused', () => {
  const w = world([{ id: 'a', date: SAT, steam: ['x', 'play'] }, { id: 'b', date: '2026-10-25' }, { id: 'c', date: SAT }]);
  assert.deepEqual(names(steamConflicts(w, 'b', 'x', 'play')), ['a'], 'Sunday vs Saturday of one weekend');
  assert.deepEqual(names(steamConflicts(w, 'c', 'x', 'play')), ['a']);
  assert.deepEqual(steamConflicts(w, 'c', 'y', 'play'), [], 'another account is free');
});

test('downloads never clash — with plays or with each other', () => {
  const w = world([{ id: 'a', steam: ['x', 'play'] }, { id: 'b', steam: ['x', 'download'] }, { id: 'c' }]);
  assert.deepEqual(steamConflicts(w, 'c', 'x', 'download'), []);
  assert.deepEqual(names(steamConflicts(w, 'c', 'x', 'play')), ['a'], 'a download elsewhere doesn’t block playing; the play at a does');
  const onlyDownloads = world([{ id: 'a', steam: ['x', 'download'] }, { id: 'b', steam: ['x', 'download'] }, { id: 'c' }]);
  assert.deepEqual(steamConflicts(onlyDownloads, 'c', 'x', 'play'), []);
});

test('the same account can play at stores on different weekends', () => {
  const w = world([{ id: 'a', date: SAT, steam: ['x', 'play'] }, { id: 'b', date: '2026-10-31' }, { id: 'c', date: '2026-10-17' }]);
  assert.deepEqual(steamConflicts(w, 'b', 'x', 'play'), []);
  assert.deepEqual(steamConflicts(w, 'c', 'x', 'play'), []);
});

test('weekday events are bucketed with their own week; Sunday and the next Monday are different weeks', () => {
  const w = world([{ id: 'a', date: '2026-10-22', steam: ['x', 'play'] }, { id: 'b', date: SAT }, { id: 'c', date: '2026-10-26' }, { id: 'd', date: '2026-10-19' }]);
  assert.deepEqual(names(steamConflicts(w, 'b', 'x', 'play')), ['a'], 'Thursday and Saturday of one week');
  assert.deepEqual(names(steamConflicts(w, 'd', 'x', 'play')), ['a'], 'Monday and Thursday of one week');
  assert.deepEqual(steamConflicts(w, 'c', 'x', 'play'), [], 'Monday 26 starts the next week');
  assert.equal(storeWeekend(w, w.stores.a), '2026-10-24');
  assert.equal(storeWeekend(w, w.stores.c), '2026-10-31');
});

test('a store’s own date wins over its campaign’s; without one the campaign’s date counts', () => {
  const w = world([{ id: 'a', steam: ['x', 'play'] }, { id: 'b', date: '2026-11-07' }, { id: 'c' }]);
  assert.deepEqual(names(steamConflicts(w, 'c', 'x', 'play')), ['a'], 'both on the campaign date');
  assert.deepEqual(steamConflicts(w, 'b', 'x', 'play'), [], 'b has its own date, a later weekend');
});

test('stores of different campaigns clash when their days share a weekend; a store never clashes with itself', () => {
  const w = world([{ id: 'a', eventId: 'e1', steam: ['x', 'play'] }, { id: 'b', eventId: 'e2' }], { e1: { date: SAT }, e2: { date: '2026-10-25' } });
  assert.deepEqual(names(steamConflicts(w, 'b', 'x', 'play')), ['a']);
  assert.deepEqual(steamConflicts(w, 'a', 'x', 'play'), [], 'changing its own purpose is fine');
  assert.deepEqual(steamConflicts(w, 'missing', 'x', 'play'), []);
});

test('availability for a store’s weekend: free, playing elsewhere, downloads, mine', () => {
  const w = world([
    { id: 'me', date: SAT },
    { id: 'p', date: '2026-10-25', steam: ['busy', 'play'] },
    { id: 'd', date: SAT, steam: ['dl', 'download'] },
    { id: 'later', date: '2026-10-31', steam: ['free', 'play'] },
    { id: 'mine', date: SAT, steam: ['own', 'play'] },
  ]);
  const me = w.stores.me;
  const busy = steamAvailability(w, me, 'busy');
  assert.equal(busy.canPlay, false);
  assert.deepEqual(names(busy.playingAt), ['p']);
  const dl = steamAvailability(w, me, 'dl');
  assert.equal(dl.canPlay, true);
  assert.deepEqual(names(dl.downloadingAt), ['d']);
  assert.equal(steamAvailability(w, me, 'free').canPlay, true, 'played on another weekend');
  assert.equal(steamAvailability(w, me, 'nobody').canPlay, true);
  // the store that holds it sees it as its own, and doesn't count itself as a clash
  const own = steamAvailability(w, w.stores.mine, 'own');
  assert.deepEqual([own.mine, own.canPlay, own.playingAt.length], [true, true, 0]);
});

test('where an account is assigned, earliest day first; in use means playing in that weekend', () => {
  const w = world([{ id: 'b', date: '2026-10-31', steam: ['x', 'download'] }, { id: 'a', date: SAT, steam: ['x', 'play'] }, { id: 'z' }]);
  assert.deepEqual(steamUses(w, 'x').map((u) => [u.store.id, u.purpose, u.date]), [['a', 'play', SAT], ['b', 'download', '2026-10-31']]);
  assert.equal(inUse(w, 'x', '2026-10-24'), true);
  assert.equal(inUse(w, 'x', '2026-10-31'), false, 'that weekend it is only downloading');
  assert.equal(inUse(w, 'x', null), true);
  assert.equal(inUse(w, 'nope', null), false);
});

test('the weekend filter: this weekend, next weekend, all — from any day of the week', () => {
  assert.equal(weekFilterKey('this', '2026-10-20'), '2026-10-24', 'Tuesday');
  assert.equal(weekFilterKey('this', '2026-10-25'), '2026-10-24', 'Sunday');
  assert.equal(weekFilterKey('next', '2026-10-25'), '2026-10-31');
  assert.equal(weekFilterKey('next', '2026-10-26'), '2026-11-07', 'Monday starts a new week');
  assert.equal(weekFilterKey('all', '2026-10-24'), null);
});

test('what a store sees of its account: the login and purpose, never its id, notes or label', () => {
  const accounts = { x: acct('x', { label: 'ROG 01', email: ' hq@example.test ', notes: 'HQ only note' }), y: acct('y') };
  const store = { steam: { accountId: 'x', purpose: 'download' as const, assignedAt: '2026-10-20T00:00:00.000Z' } };
  const login = steamLoginFor(store, accounts)!;
  assert.deepEqual(login, { username: 'test_rog_x', password: 'fake-pass-123', purpose: 'download' }, 'the email stays with HQ');
  assert.doesNotMatch(JSON.stringify(login), /ROG 01|HQ only note|"x"|accountId/);
  assert.deepEqual(steamLoginFor({ steam: { accountId: 'y', purpose: 'play', assignedAt: '' } }, accounts), { username: 'test_rog_y', password: 'fake-pass-123', purpose: 'play' }, 'no email key when there is none');
  assert.equal(steamLoginFor({}, accounts), undefined);
  assert.equal(steamLoginFor({ steam: { accountId: 'gone', purpose: 'play', assignedAt: '' } }, accounts), undefined);
  assert.equal(steamLoginFor(store, undefined), undefined);
});

test('a store’s login carries the lookup its team started, and the old otpRequestedAt, when the server says so', () => {
  const accounts = { x: acct('x') };
  const store = { steam: { accountId: 'x', purpose: 'play' as const, assignedAt: '' } };
  const otpLookup = { id: 'lookup-1', requestedAt: '2026-10-24T06:00:00.000Z' };
  assert.deepEqual(steamLoginFor(store, accounts, { otpRequest: true, otpLookup, otpRequestedAt: otpLookup.requestedAt }), {
    username: 'test_rog_x',
    password: 'fake-pass-123',
    purpose: 'play',
    otpRequest: true,
    otpLookup,
    otpRequestedAt: otpLookup.requestedAt,
  });
  assert.equal('otpLookup' in steamLoginFor(store, accounts, { otpRequest: true })!, false);
});

test('the refusal says where it is already playing', () => {
  const w = world([{ id: 'a', date: SAT, steam: ['x', 'play'] }, { id: 'b', date: SAT }]);
  const clash = steamConflicts(w, 'b', 'x', 'play');
  assert.equal(
    conflictMessage(clash, (n) => shortStoreName(n), weekendPhrase('2026-10-24', '2026-10-22')),
    'Already playing at a this weekend — assign it for downloads only, or pick another account.',
  );
  assert.match(weekendPhrase('2026-10-31', '2026-10-22'), /^the weekend of Sat 31 Oct – Sun 1 Nov$/);
});
