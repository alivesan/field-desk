/*
 * Match-day screen helpers: the Call link, a bracket match's state, how a slot reads, why an undo is blocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBracket } from '../src/lib/bracket.ts';
import { feederOf, KIND_INFO, KIND_ORDER, matchState, playedFor, slotKind, stationSlots, telHref, undoBlockedBy } from '../src/lib/day-ui.ts';
import type { Match, MatchDay, Player } from '../src/lib/types.ts';

const players: Player[] = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, name: id.toUpperCase(), seed: i + 1 }));

/** 5 players → 8-slot bracket: seeds 1-3 get byes; round 0 has b-vs-e... use ids to find matches. */
const day = (over: Partial<MatchDay> = {}): MatchDay => ({ players, checkIn: {}, matches: buildBracket(players), stations: 2, ...over });
const at = (d: MatchDay, round: number, index: number) => d.matches.find((m) => m.round === round && m.index === index)!;
const swap = (d: MatchDay, m: Match, patch: Partial<Match>): MatchDay => ({ ...d, matches: d.matches.map((x) => (x.id === m.id ? { ...x, ...patch } : x)) });

test('telHref: Indian mobiles get +91, international numbers a +, short numbers as stored, junk nothing', () => {
  assert.equal(telHref('9820011111'), 'tel:+919820011111');
  assert.equal(telHref('98200 11111'), 'tel:+919820011111');
  assert.equal(telHref('14155550123'), 'tel:+14155550123');
  assert.equal(telHref('4155550123'), 'tel:4155550123'); // 10 digits, not a 6-9 mobile: as stored
  assert.equal(telHref('2012345'), 'tel:2012345');
  assert.equal(telHref(undefined), null);
  assert.equal(telHref(''), null);
  assert.equal(telHref('12345'), null);
  assert.equal(telHref('1234567890123456'), null);
});

test('matchState: bye, waiting, ready, one or both missing, busy, live, done', () => {
  const d0 = day();
  const first = d0.matches.filter((m) => m.round === 0);
  const bye = first.find((m) => m.bye)!;
  assert.equal(matchState(bye, d0).kind, 'bye');
  const real = first.find((m) => m.a && m.b)!;
  assert.deepEqual(matchState(real, d0), { kind: 'both-missing', missing: [real.a, real.b] });
  const one = { ...d0, checkIn: { [real.a!]: 't' } };
  assert.deepEqual(matchState(real, one), { kind: 'one-missing', missing: [real.b] });
  const both = { ...d0, checkIn: { [real.a!]: 't', [real.b!]: 't' } };
  assert.equal(matchState(real, both).kind, 'ready');
  const final = at(d0, 2, 0);
  assert.equal(matchState(final, d0).kind, 'waiting');

  // a player still playing another match → busy, naming that match
  const other = { id: 'x', round: 1, index: 9, a: real.a, b: 'zz', winner: null, status: 'live', station: 1, score: '' } as Match;
  const busy = { ...both, matches: [...both.matches, other] };
  const s = matchState(real, busy);
  assert.equal(s.kind, 'busy');
  assert.equal(s.busyWith?.id, 'x');

  assert.equal(matchState({ ...real, status: 'live', station: 1 }, both).kind, 'live');
  assert.equal(matchState({ ...real, status: 'done', winner: real.a }, both).kind, 'done');
});

test('every state has a glyph, a label and a hint, and appears once in the legend', () => {
  assert.equal(new Set(KIND_ORDER).size, KIND_ORDER.length);
  assert.deepEqual([...KIND_ORDER].sort(), Object.keys(KIND_INFO).sort());
  const glyphs = KIND_ORDER.map((k) => KIND_INFO[k].glyph);
  assert.equal(new Set(glyphs).size, glyphs.length, 'each state has its own shape');
  for (const k of KIND_ORDER) assert.ok(KIND_INFO[k].label && KIND_INFO[k].hint);
});

test('slotKind: checked in / not here, winner / loser, bye, and slots still to be decided', () => {
  const d = day();
  const real = d.matches.find((m) => m.round === 0 && m.a && m.b)!;
  assert.equal(slotKind(real, real.a, {}), 'away');
  assert.equal(slotKind(real, real.a, { [real.a!]: 't' }), 'here');
  const done: Match = { ...real, status: 'done', winner: real.a };
  assert.equal(slotKind(done, real.a, {}), 'won');
  assert.equal(slotKind(done, real.b, {}), 'lost');
  const bye = d.matches.find((m) => m.bye)!;
  assert.equal(slotKind(bye, null, {}), 'bye');
  assert.equal(slotKind(bye, bye.a ?? bye.b, {}), 'adv');
  assert.equal(slotKind(at(d, 2, 0), null, {}), 'tbd');
  assert.equal(slotKind({ ...real, a: null, b: null, bye: undefined }, null, {}), 'open');
});

test('feederOf finds the earlier match behind each side', () => {
  const d = day();
  const sf = at(d, 1, 1);
  assert.equal(feederOf(sf, 0, d.matches)?.index, 2);
  assert.equal(feederOf(sf, 1, d.matches)?.index, 3);
  assert.equal(feederOf(at(d, 0, 0), 0, d.matches), undefined);
});

test('undoBlockedBy names the follow-on match that has already started; a live or pending match is never blocked', () => {
  let d = day();
  const real = d.matches.find((m) => m.round === 0 && m.a && m.b)!;
  d = swap(d, real, { status: 'done', winner: real.a });
  const next = d.matches.find((m) => m.round === 1 && m.index === Math.floor(real.index / 2))!;
  assert.equal(undoBlockedBy(d.matches.find((m) => m.id === real.id)!, d.matches), null);
  d = swap(d, next, { status: 'live', station: 1 });
  assert.equal(undoBlockedBy(d.matches.find((m) => m.id === real.id)!, d.matches)?.id, next.id);
  assert.equal(undoBlockedBy(d.matches.find((m) => m.id === next.id)!, d.matches), null);
});

test('playedFor and stationSlots', () => {
  assert.equal(playedFor({ startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:22:00Z' } as Match), '22 min');
  assert.equal(playedFor({ startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:00:20Z' } as Match), 'under a minute');
  assert.equal(playedFor({} as Match), '');
  assert.equal(playedFor({ startedAt: '2026-01-01T10:30:00Z', endedAt: '2026-01-01T10:00:00Z' } as Match), '');
  const d = day({ stations: 3 });
  const live = swap(d, d.matches[0], { status: 'live', station: 2 });
  assert.deepEqual(
    stationSlots(live).map((s) => [s.station, s.live?.id]),
    [
      [1, undefined],
      [2, d.matches[0].id],
      [3, undefined],
    ],
  );
});
