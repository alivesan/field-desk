import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBracket } from '../src/lib/bracket.ts';
import { agoText, feederMatch, followPath, matchLabel, publicBracketUrl, publicBracketView, readPublicBracket, rotatePublicBracket, turnOffPublicBracket, turnOnPublicBracket, upNextIds, UP_NEXT_COUNT } from '../src/lib/publicBracket.ts';
import { validateDocument } from '../src/lib/schema.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';
import type { Match, Player, Store } from '../src/lib/types.ts';

/* The public live bracket: what the payload may say, "Up next", following a player, and HQ's link edits. */

const players: Player[] = [
  { id: 'hash-a', name: 'Asha Rao', seed: 1, phone: '9820011111', ign: 'AshaX' },
  { id: 'hash-b', name: 'Vikram', seed: 2, phone: '9820022222' },
  { id: 'hash-c', name: 'Meera Nair', seed: 3, phone: '9820033333', ign: 'MN' },
  { id: 'hash-d', name: 'Kabir Singh', seed: 4, phoneEnd: '4444' },
];

/** A 4-player bracket: seeds 1 v 4 and 2 v 3 in round 0, the final in round 1. */
function day(over: (m: Match[]) => void = () => {}) {
  const matches = buildBracket(players, null, 'm');
  over(matches);
  const checkIn: Record<string, string> = { 'hash-a': '2026-10-24T09:01:00.000Z', 'hash-b': '2026-10-24T09:02:00.000Z' };
  return { players, checkIn, matches, stations: 2, version: 3 };
}
const store = (d: object = day(), over: Record<string, unknown> = {}) => fixtureStore('s1', 'e1', null, { name: 'ASUS ROG Exclusive Store — Croma Andheri', day: d, ...over }) as unknown as Store;
const event = fixtureEvent('e1', { games: ['Tekken 8'] }) as any;
const view = (s = store()) => publicBracketView(s, event, [s.name, 'ASUS ROG Exclusive Store — Croma Bandra']);
const at = (m: Match[], r: number, i: number) => m.find((x) => x.round === r && x.index === i)!;

test('view: header, short name, date, game and the bracket’s shape', () => {
  const v = view();
  assert.equal(v.store, 'Croma Andheri');
  assert.equal(v.city, 'Testville');
  assert.equal(v.campaign, 'Synthetic Campaign');
  assert.equal(v.game, 'Tekken 8');
  assert.equal(v.date, '2026-10-24');
  assert.equal(v.rounds, 2);
  assert.equal(v.matches.length, 3);
  assert.deepEqual(v.matches.map((m) => [m.round, m.index, m.no]), [[0, 0, 1], [0, 1, 2], [1, 0, 3]]);
  assert.equal(view(store(day(), { date: '2026-10-25' })).date, '2026-10-25', 'the store’s own day wins');
  assert.equal('game' in publicBracketView(store(), fixtureEvent('e1', { games: [] }) as any, []), false);
});

test('view: names, in-game names and seeds — never ids, phones or check-ins', () => {
  const v = view();
  const first = v.matches[0];
  assert.deepEqual([first.a, first.aIgn, first.aSeed, first.b, first.bIgn, first.bSeed], ['Asha Rao', 'AshaX', 1, 'Kabir Singh', undefined, 4]);
  assert.equal(v.matches[2].a, null, 'the final is waiting on both semifinals');
  assert.equal(v.matches[2].aSeed, null);
  const text = JSON.stringify(v);
  for (const secret of ['9820011111', '9820022222', '9820033333', '4444', 'hash-a', 'hash-d', '2026-10-24T09:01', 'phone', 'checkIn']) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  // exactly these keys per match, nothing else rides along
  const keys = new Set(v.matches.flatMap((m) => Object.keys(m)));
  assert.deepEqual([...keys].sort(), ['a', 'aIgn', 'aSeed', 'b', 'bIgn', 'bSeed', 'id', 'index', 'no', 'round', 'score', 'status', 'bye', 'winner'].sort());
  assert.deepEqual(Object.keys(v).sort(), ['campaign', 'champion', 'city', 'date', 'game', 'matches', 'rounds', 'store', 'updatedAt']);
});

test('view: winner is a or b, a station shows only while live, W/O and score pass through', () => {
  const v = view(
    store(
      day((m) => {
        Object.assign(at(m, 0, 0), { status: 'done', winner: 'hash-d', score: '2-1', endedAt: '2026-10-24T10:00:00.000Z', station: 1 });
        Object.assign(at(m, 0, 1), { status: 'live', station: 2, startedAt: '2026-10-24T10:05:00.000Z' });
      }),
    ),
  );
  const [done, live, final] = v.matches;
  assert.deepEqual([done.winner, done.status, done.score, done.station], ['b', 'done', '2-1', undefined]);
  assert.deepEqual([live.winner, live.status, live.station], [null, 'live', 2]);
  assert.equal(final.status, 'pending');
  const wo = view(store(day((m) => Object.assign(at(m, 0, 0), { status: 'done', winner: 'hash-a', score: 'W/O', walkover: true })))).matches[0];
  assert.deepEqual([wo.winner, wo.walkover], ['a', true]);
});

test('view: byes, the champion and updatedAt', () => {
  const three = players.slice(0, 3);
  const bye = publicBracketView(store({ players: three, checkIn: {}, matches: buildBracket(three, null, 'b'), stations: 1, version: 1 }), event, []);
  const first = bye.matches.filter((m) => m.round === 0);
  assert.ok(first.some((m) => m.bye && m.winner === 'a' && m.b === null), JSON.stringify(first));
  assert.equal(bye.champion, null);

  const played = view(
    store(
      day((m) => {
        Object.assign(at(m, 0, 0), { status: 'done', winner: 'hash-a', endedAt: '2026-10-24T10:00:00.000Z' });
        Object.assign(at(m, 0, 1), { status: 'done', winner: 'hash-c', endedAt: '2026-10-24T10:20:00.000Z' });
        Object.assign(at(m, 1, 0), { a: 'hash-a', b: 'hash-c', status: 'done', winner: 'hash-c', startedAt: '2026-10-24T10:30:00.000Z', endedAt: '2026-10-24T10:50:00.000Z' });
      }),
    ),
  );
  assert.equal(played.champion, 'Meera Nair');
  assert.equal(played.updatedAt, '2026-10-24T10:50:00.000Z');
  assert.equal(view(store(day(), { updatedAt: '2026-10-24T08:00:00.000Z' })).updatedAt, '2026-10-24T08:00:00.000Z', 'nothing played: the store’s last edit');
  assert.equal(view().champion, null);
  const none = publicBracketView(store({ players, checkIn: {}, matches: [], stations: 1 }), event, []);
  assert.deepEqual([none.rounds, none.matches, none.champion], [0, [], null]);
});

test('upNextIds: pending matches with both players, earliest first, at most UP_NEXT_COUNT', () => {
  const eight = Array.from({ length: 8 }, (_, i): Player => ({ id: `x${i}`, name: `Player ${i + 1}`, seed: i + 1 }));
  const v = publicBracketView(store({ players: eight, checkIn: {}, matches: buildBracket(eight, null, 'e'), stations: 2, version: 1 }), event, []);
  const next = upNextIds(v.matches);
  assert.equal(next.size, UP_NEXT_COUNT);
  assert.deepEqual([...next], v.matches.filter((m) => m.round === 0).slice(0, UP_NEXT_COUNT).map((m) => m.id));
  // a live or finished match is not "up next"; the queue moves on
  const moved = v.matches.map((m, i) => (i === 0 ? { ...m, status: 'live' as const } : i === 1 ? { ...m, status: 'done' as const } : m));
  assert.ok(!upNextIds(moved).has(v.matches[0].id) && !upNextIds(moved).has(v.matches[1].id));
  assert.deepEqual([...upNextIds(moved)], v.matches.slice(2, 4).map((m) => m.id), 'the queue moves on to the next two');
  // a match waiting on a result isn't named, and neither is a bye
  assert.deepEqual([...upNextIds(view().matches)].length, 2);
  assert.ok(!upNextIds(view().matches).has(view().matches[2].id));
  const byes = publicBracketView(store({ players: players.slice(0, 3), checkIn: {}, matches: buildBracket(players.slice(0, 3), null, 'b'), stations: 1 }), event, []).matches;
  for (const id of upNextIds(byes)) assert.ok(!byes.find((m) => m.id === id)!.bye);
});

test('followPath: every match a seed is in; feederMatch and matchLabel', () => {
  const v = view(
    store(
      day((m) => {
        Object.assign(at(m, 0, 0), { status: 'done', winner: 'hash-a' });
        Object.assign(at(m, 1, 0), { a: 'hash-a' });
      }),
    ),
  );
  assert.deepEqual([...followPath(v.matches, 1)].sort(), [v.matches[0].id, v.matches[2].id].sort());
  assert.deepEqual([...followPath(v.matches, 3)], [v.matches[1].id]);
  assert.deepEqual([...followPath(v.matches, 99)], []);
  const final = v.matches[2];
  assert.equal(feederMatch(final, 0, v.matches)?.id, v.matches[0].id);
  assert.equal(feederMatch(final, 1, v.matches)?.id, v.matches[1].id);
  assert.equal(feederMatch(v.matches[0], 0, v.matches), undefined);
  assert.equal(matchLabel(final), 'M3');
});

test('link edits: the first On makes the token, later ones keep it; a new link changes it and keeps On / Off', () => {
  const s = store();
  const tokens = ['tok_first-0000000001', 'tok_second-000000002'];
  let n = 0;
  const next = () => tokens[n++];
  turnOnPublicBracket(s, '2026-10-24T08:00:00.000Z', next);
  assert.deepEqual(s.publicBracket, { token: tokens[0], on: true, createdAt: '2026-10-24T08:00:00.000Z' });
  turnOffPublicBracket(s);
  assert.equal(s.publicBracket!.on, false);
  assert.equal(s.publicBracket!.token, tokens[0], 'Off keeps the token');
  turnOnPublicBracket(s, '2026-10-24T09:00:00.000Z', next);
  assert.deepEqual(s.publicBracket, { token: tokens[0], on: true, createdAt: '2026-10-24T08:00:00.000Z' }, 'On again is the same link');
  rotatePublicBracket(s, '2026-10-24T10:00:00.000Z', next);
  assert.deepEqual(s.publicBracket, { token: tokens[1], on: true, createdAt: '2026-10-24T10:00:00.000Z' });
  turnOffPublicBracket(s);
  rotatePublicBracket(s, '2026-10-24T11:00:00.000Z', () => 'tok_third-00000000003');
  assert.equal(s.publicBracket!.on, false, 'a new link while Off stays Off');
  const bare = store();
  rotatePublicBracket(bare, 'x');
  turnOffPublicBracket(bare);
  assert.equal(bare.publicBracket, undefined, 'nothing to rotate or turn off before the first On');
  // real tokens are url-safe and long enough for the schema
  const real = store();
  turnOnPublicBracket(real, '2026-10-24T08:00:00.000Z');
  assert.match(real.publicBracket!.token, /^[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(validateDocument('stores', real, { events: { e1: event } }), []);
  assert.equal(publicBracketUrl('https://fieldesk.example/', 'abc'), 'https://fieldesk.example/b/abc');
});

test('schema: publicBracket is optional; its token, flag and time are checked; tokens are unique across stores', () => {
  const ctx = (stores?: Record<string, Store>) => ({ events: { e1: event }, stores });
  const ok = { token: 'tok_synthetic-000001', on: true, createdAt: '2026-10-24T08:00:00.000Z' };
  assert.deepEqual(validateDocument('stores', store(day(), { publicBracket: ok }), ctx()), []);
  const bad = (publicBracket: unknown) => validateDocument('stores', store(day(), { publicBracket }), ctx());
  assert.ok(bad('nope').some((p) => /^publicBracket: must be an object/.test(p)));
  for (const token of ['short', 'has space not ok!', 'x'.repeat(65), 5, undefined]) assert.ok(bad({ ...ok, token }).some((p) => /^publicBracket\.token: must be 16–64/.test(p)), String(token));
  assert.ok(bad({ ...ok, on: 'yes' }).some((p) => /^publicBracket\.on/.test(p)));
  assert.ok(bad({ ...ok, createdAt: 'yesterday' }).some((p) => /^publicBracket\.createdAt/.test(p)));
  const other = fixtureStore('s2', 'e1', null, { publicBracket: ok }) as unknown as Store;
  assert.ok(validateDocument('stores', store(day(), { publicBracket: ok }), ctx({ s2: other })).some((p) => /publicBracket\.token: is already used by another store/.test(p)));
});

test('agoText and readPublicBracket', () => {
  assert.deepEqual([0, 12400, 59000, 61000, 3 * 60000, 3600000].map(agoText), ['0 s ago', '12 s ago', '59 s ago', '1 min ago', '3 min ago', '1 h ago']);
  assert.equal(agoText(-5), '0 s ago');
  const v = view();
  assert.deepEqual(readPublicBracket(JSON.parse(JSON.stringify(v))), v);
  for (const junk of [null, 'x', 5, {}, { store: 'a' }, { store: 'a', matches: 'no' }]) assert.equal(readPublicBracket(junk), null);
  const lenient = readPublicBracket({ store: 'S', matches: [null, { id: 5 }, { id: 'm', round: 0, index: 0 }], rounds: 'two', champion: 7 })!;
  assert.deepEqual([lenient.matches.length, lenient.rounds, lenient.champion, lenient.city, lenient.date], [1, 0, null, '', '']);
});
