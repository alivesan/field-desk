import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from '../src/lib/schema.ts';
import { selfCheckIn, storeByToken } from '../server/public.ts';
import { fixtureAdmin, fixtureEvent, fixtureStore } from './helpers/server.ts';

/* Schema for the self check-in / roster fields (src/lib/schema.ts) and the pure lookup (server/public.ts). */

const ctx = (stores?: Record<string, any>) => ({ events: { e1: fixtureEvent('e1') as any }, admins: { a1: fixtureAdmin('a1', 'AAA2') as any }, stores });
const players = [
  { id: 'p1', name: 'Asha Rao', seed: 1, phone: '9820011111' },
  { id: 'p2', name: 'Vikram', seed: 2 },
];
const store = (dayOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  fixtureStore('s1', 'e1', 'a1', { day: { players, checkIn: {}, matches: [], stations: 2, version: 1, ...dayOver }, ...over }) as any;
const problems = (s: any, stores?: Record<string, any>) => validateDocument('stores', s, ctx(stores));
const has = (p: string[], re: RegExp) => assert.ok(p.some((x) => re.test(x)), `expected ${re}, got ${JSON.stringify(p)}`);

test('schema: player phone is optional, else 6–15 digits', () => {
  assert.deepEqual(problems(store()), []);
  for (const bad of ['+919820011111', '98200 11111', '12345', '1'.repeat(16), 9820011111]) {
    has(problems(store({ players: [{ id: 'p1', name: 'A', seed: 1, phone: bad }] })), /players\[id=p1\]\.phone: must be 6–15 digits/);
  }
  assert.deepEqual(problems(store({ players: [{ id: 'p1', name: 'A', seed: 1, phone: '123456' }] })), []);
});

test('schema: player in-game name is optional text of at most 40 characters', () => {
  assert.deepEqual(problems(store({ players: [{ id: 'p1', name: 'A', seed: 1, ign: 'AshR' }] })), []);
  assert.deepEqual(problems(store({ players: [{ id: 'p1', name: 'A', seed: 1, ign: 'x'.repeat(40) }] })), []);
  for (const bad of [42, null, ['AshR'], { n: 'AshR' }, 'x'.repeat(41)]) has(problems(store({ players: [{ id: 'p1', name: 'A', seed: 1, ign: bad }] })), /players\[id=p1\]\.ign: must be text of at most 40/);
});

test('schema: checkInSource keys are players, values self | staff; check-in keys still ⊂ players', () => {
  assert.deepEqual(problems(store({ checkIn: { p1: '2026-10-24T09:00:00.000Z' }, checkInSource: { p1: 'self', p2: 'staff' } })), []);
  has(problems(store({ checkInSource: { ghost: 'self' } })), /day\.checkInSource\.ghost: isn’t a player/);
  has(problems(store({ checkInSource: { p1: 'qr' } })), /day\.checkInSource\.p1: must be one of "self", "staff"/);
  has(problems(store({ checkInSource: ['p1'] })), /day\.checkInSource: must be an object/);
  has(problems(store({ checkIn: { ghost: '2026-10-24T09:00:00.000Z' } })), /day\.checkIn\.ghost: isn’t a player/);
});

test('schema: selfCheckIn token format, boolean open, optional ISO openedAt', () => {
  const ok = { token: 'abcDEF123_-abcdef0', open: false };
  assert.deepEqual(problems(store({ selfCheckIn: ok })), []);
  assert.deepEqual(problems(store({ selfCheckIn: { ...ok, open: true, openedAt: '2026-10-24T09:00:00.000Z' } })), []);
  for (const token of ['short', 'has space in it 0000', 'x'.repeat(65), 'dots.are.not.ok.0000', 42]) has(problems(store({ selfCheckIn: { ...ok, token } })), /selfCheckIn\.token: must be 16–64/);
  has(problems(store({ selfCheckIn: { ...ok, open: 'yes' } })), /selfCheckIn\.open: must be true or false/);
  has(problems(store({ selfCheckIn: { ...ok, openedAt: 'soon' } })), /selfCheckIn\.openedAt: must be a date-time/);
  has(problems(store({ selfCheckIn: null })), /day\.selfCheckIn: must be an object/);
});

test('schema: self check-in tokens are unique across stores (when the stores are given)', () => {
  const token = 'abcDEF123_-abcdef0';
  const mine = store({ selfCheckIn: { token, open: true } });
  const other = { ...store({ selfCheckIn: { token, open: false } }), id: 's2' };
  has(problems(mine, { s1: mine, s2: other }), /day\.selfCheckIn\.token: is already used by another store/);
  assert.deepEqual(problems(mine, { s1: mine }), [], 'its own entry is not a clash');
  assert.deepEqual(problems(mine), [], 'skipped without ctx.stores');
});

test('schema: store.roster shape', () => {
  const roster = { kind: 'upload', fileName: 'players.csv', fetchedAt: '2026-10-23T10:00:00.000Z', rows: 12, by: 'super' };
  assert.deepEqual(problems(store({}, { roster })), []);
  assert.deepEqual(problems(store({}, { roster: { ...roster, kind: 'link', url: 'https://example.com/x.csv', fileName: undefined } })), []);
  has(problems(store({}, { roster: { ...roster, kind: 'email' } })), /roster\.kind: must be one of/);
  has(problems(store({}, { roster: { ...roster, rows: -1 } })), /roster\.rows: must be a whole number/);
  has(problems(store({}, { roster: { ...roster, fetchedAt: 'yesterday' } })), /roster\.fetchedAt: must be a date-time/);
  has(problems(store({}, { roster: { ...roster, by: undefined } })), /roster\.by: must be text/);
  has(problems(store({}, { roster: { ...roster, url: 5 } })), /roster\.url: must be text/);
  has(problems(store({}, { roster: 'csv' })), /^roster: must be an object/);
});

test('selfCheckIn (pure): outcomes, normalized matching, never mutates the store', () => {
  const s = store({ selfCheckIn: { token: 'abcDEF123_-abcdef0', open: true }, players: [...players, { id: 'p3', name: 'T One', seed: 3, phone: '9820033333' }, { id: 'p4', name: 'T Two', seed: 4, phone: '9820033333' }] });
  const frozen = JSON.stringify(s);
  const at = '2026-10-24T09:05:00.000Z';
  const ok = selfCheckIn(s, '+91-98200-11111', at);
  assert.equal(ok.kind, 'ok');
  if (ok.kind === 'ok') {
    assert.equal(ok.name, 'Asha R.');
    assert.equal(ok.next.day.checkIn.p1, at);
    assert.equal(ok.next.day.checkInSource!.p1, 'self');
    assert.deepEqual(validateDocument('stores', ok.next, ctx()), []);
  }
  assert.equal(JSON.stringify(s), frozen);
  assert.equal(selfCheckIn(s, '9820033333', at).kind, 'ambiguous');
  assert.equal(selfCheckIn(s, '9000000000', at).kind, 'no-match');
  assert.equal(selfCheckIn(s, 'call me', at).kind, 'bad-phone');
  assert.equal(selfCheckIn(s, undefined, at).kind, 'bad-phone');
  assert.equal(selfCheckIn({ ...s, day: { ...s.day, checkIn: { p1: at } } }, '9820011111', at).kind, 'already');
  assert.equal(selfCheckIn({ ...s, day: { ...s.day, selfCheckIn: { token: 'abcDEF123_-abcdef0', open: false } } }, '9820011111', at).kind, 'closed');
  assert.equal(storeByToken({ s1: s }, 'abcDEF123_-abcdef0'), s);
  assert.equal(storeByToken({ s1: s }, 'abcDEF123_-abcdef1'), undefined);
  assert.equal(storeByToken({ s1: s }, '../../etc'), undefined);
});
