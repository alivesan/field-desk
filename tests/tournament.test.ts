/*
 * Tournament commands — the real handlers via applyCommand, over in-memory stores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, CommandError, dayVersion, validateCommand, type Command, type CommandContext } from '../src/lib/commands.ts';
import { differentName, onSpotClash } from '../src/lib/tournament.ts';
import { playerIdFor } from '../src/lib/phone.ts';
import { computeQueue, nextOf, seedOrder, nextPow2 } from '../src/lib/bracket.ts';
import type { Match, Player, Store, TournamentEvent } from '../src/lib/types.ts';

const event: TournamentEvent = { id: 'e1', name: 'Test Cup', date: '2026-10-23', games: [], collateral: [], gameReadyTarget: 0, minDownMbps: 0, createdAt: '2026-10-01T00:00:00.000Z' };

function emptyStore(stations = 2): Store {
  return {
    id: 's1',
    eventId: 'e1',
    name: 'Store',
    city: '',
    address: '',
    admin: '',
    pin: null,
    recce: {} as Store['recce'],
    day: { players: [], checkIn: {}, matches: [], stations },
  };
}

let seq = 0;
const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  commandId: `c${++seq}`,
  now: new Date(Date.UTC(2026, 9, 23, 10, 0, seq)).toISOString(),
  actor: { principal: 'super', name: 'HQ', role: 'super' },
  event,
  ...over,
});

const run = (s: Store, cmd: Command, c = ctx()) => applyCommand(s, cmd, c);
const players = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, seed: i + 1 }));
const checkAll = (s: Store): Store => ({ ...s, day: { ...s.day, checkIn: Object.fromEntries(s.day.players.map((p) => [p.id, '2026-10-23T09:00:00.000Z'])) } });

function loaded(n: number, stations = 4, pairs?: [string | null, string | null][]): Store {
  const s = emptyStore(stations);
  return checkAll(run(s, { type: 'bracket.load', base: 0, players: players(n), pairs, stations }));
}

const m = (s: Store, round: number, index: number) => s.day.matches.find((x) => x.round === round && x.index === index)!;
const byId = (s: Store, id: string) => s.day.matches.find((x) => x.id === id)!;

function rejects(fn: () => unknown, code: 'conflict' | 'invalid' | 'forbidden', msg?: RegExp) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof CommandError, `expected CommandError, got ${e}`);
    assert.equal(e.code, code);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

const seedOf = (s: Store, id: string | null) => s.day.players.find((p) => p.id === id)!.seed;

test('every entrant count 2..64 runs to a champion through the commands; byes go to the top seeds', () => {
  for (let n = 2; n <= 64; n++) {
    let s = loaded(n, 4);
    const size = nextPow2(n);
    const first = s.day.matches.filter((x) => x.round === 0);
    assert.equal(first.length, size / 2, `n=${n}: first-round size`);
    const placed = first.flatMap((x) => [x.a, x.b]).filter(Boolean);
    assert.deepEqual([...placed].sort(), players(n).map((p) => p.id).sort(), `n=${n}: everyone placed once`);
    const byes = first.filter((x) => x.bye);
    assert.equal(byes.length, size - n, `n=${n}: bye count`);
    assert.deepEqual(byes.map((x) => seedOf(s, x.winner)).sort((a, b) => a - b), Array.from({ length: size - n }, (_, i) => i + 1), `n=${n}: byes to top seeds`);
    // Seeded positions follow the standard order.
    const order = seedOrder(size);
    first.forEach((x, i) => {
      assert.equal(x.a ? seedOf(s, x.a) : null, order[2 * i] <= n ? order[2 * i] : null);
      assert.equal(x.b ? seedOf(s, x.b) : null, order[2 * i + 1] <= n ? order[2 * i + 1] : null);
    });

    let guard = 0;
    for (;;) {
      const q = computeQueue(s.day);
      if (q.champion) break;
      assert.ok(q.ready.length || q.live.length, `n=${n}: stuck`);
      q.ready.slice(0, q.freeStations.length).forEach((r, i) => {
        s = run(s, { type: 'match.start', base: dayVersion(s), matchId: r.match.id, station: q.freeStations[i] });
      });
      for (const live of computeQueue(s.day).live) {
        const w = seedOf(s, live.a) < seedOf(s, live.b) ? live.a! : live.b!; // favourite wins
        s = run(s, { type: 'match.finish', base: dayVersion(s), matchId: live.id, winner: w, score: '2-0' });
      }
      assert.ok(++guard < 200);
    }
    const q = computeQueue(s.day);
    assert.equal(seedOf(s, q.champion), 1, `n=${n}: top seed wins when favourites win`);
    assert.equal(s.day.matches.filter((x) => !x.bye && x.status === 'done').length, n - 1, `n=${n}: n-1 matches played`);
    assert.ok(s.day.matches.every((x) => x.status === 'done'));
  }
});

test('F03: two match.start for different matches on the same station against the same base — second is a conflict', () => {
  const s0 = loaded(8, 4);
  const base = dayVersion(s0);
  const s1 = run(s0, { type: 'match.start', base, matchId: m(s0, 0, 0).id, station: 1 });
  rejects(() => run(s1, { type: 'match.start', base, matchId: m(s0, 0, 1).id, station: 1 }), 'conflict', /Station 1 is already running M1/);
  // the same command on another station is fine — base alone is not a guard for start
  const s2 = run(s1, { type: 'match.start', base, matchId: m(s0, 0, 1).id, station: 2 });
  assert.equal(s2.day.matches.filter((x) => x.status === 'live').length, 2);
  assert.equal(dayVersion(s2), base + 2);
});

test('a player can’t be in two live matches; start needs both checked in and a real station', () => {
  // Corrupt/legacy shape: a later match already names a player who is live elsewhere.
  let s = loaded(4, 4);
  s = run(s, { type: 'match.start', base: dayVersion(s), matchId: m(s, 0, 0).id, station: 1 });
  const p = m(s, 0, 0).a!;
  const forged: Store = { ...s, day: { ...s.day, matches: s.day.matches.map((x) => (x.round === 0 && x.index === 1 ? { ...x, a: p } : x)) } };
  rejects(() => run(forged, { type: 'match.start', base: 0, matchId: m(s, 0, 1).id, station: 2 }), 'conflict', /already playing M1 on station 1/);
  rejects(() => run(s, { type: 'match.start', base: 0, matchId: m(s, 0, 0).id, station: 2 }), 'conflict', /already being played on station 1/);

  const notIn: Store = { ...s, day: { ...s.day, checkIn: { [m(s, 0, 1).a!]: 'x' } } };
  rejects(() => run(notIn, { type: 'match.start', base: 0, matchId: m(s, 0, 1).id, station: 2 }), 'conflict', /hasn’t checked in/);
  rejects(() => run(s, { type: 'match.start', base: 0, matchId: m(s, 0, 1).id, station: 5 }), 'conflict', /Station 5 isn’t set up/);
  rejects(() => run(s, { type: 'match.start', base: 0, matchId: m(s, 1, 0).id, station: 2 }), 'conflict', /waiting on an earlier result/);
  rejects(() => run(s, { type: 'match.start', base: 0, matchId: 'gone', station: 2 }), 'conflict', /no longer in this bracket/);
});

test('F14: reducing stations below an occupied station is a conflict; above it is fine', () => {
  let s = loaded(8, 4);
  s = run(s, { type: 'match.start', base: dayVersion(s), matchId: m(s, 0, 0).id, station: 3 });
  rejects(() => run(s, { type: 'stations.set', base: dayVersion(s), count: 2 }), 'conflict', /Station 3 is running M1/);
  const s3 = run(s, { type: 'stations.set', base: 0 /* stale base is fine */, count: 3 });
  assert.equal(s3.day.stations, 3);
  assert.equal(dayVersion(s3), dayVersion(s) + 1);
});

test('F16: finish 2–0 → undo → finish with no score: the old score is not attached', () => {
  let s = loaded(4, 2);
  const id = m(s, 0, 0).id;
  s = run(s, { type: 'match.start', base: dayVersion(s), matchId: id, station: 1 });
  s = run(s, { type: 'match.finish', base: dayVersion(s), matchId: id, winner: byId(s, id).a!, score: '2–0' });
  assert.equal(byId(s, id).score, '2–0');
  s = run(s, { type: 'match.undo', base: dayVersion(s), matchId: id });
  const u = byId(s, id);
  assert.equal(u.status, 'pending');
  assert.equal(u.score, '');
  for (const k of ['winner', 'station', 'startedAt', 'endedAt', 'walkover'] as const) assert.ok(!u[k], `${k} cleared`);
  s = run(s, { type: 'match.start', base: dayVersion(s), matchId: id, station: 1 });
  s = run(s, { type: 'match.finish', base: dayVersion(s), matchId: id, winner: byId(s, id).b! });
  assert.equal(byId(s, id).score, '');
});

test('cancel a live match: back to pending with station, start time and score cleared', () => {
  let s = loaded(4, 2);
  const id = m(s, 0, 0).id;
  s = run(s, { type: 'match.start', base: dayVersion(s), matchId: id, station: 2 });
  s = run(s, { type: 'match.undo', base: dayVersion(s), matchId: id });
  assert.deepEqual(byId(s, id), { id, round: 0, index: 0, a: 'p1', b: 'p4', winner: null, status: 'pending', score: '' });
  assert.deepEqual(computeQueue(s.day).freeStations, [1, 2]);
});

test('finish → undo → replay propagates the correct participants downstream', () => {
  let s = loaded(4, 2);
  const [m0, m1] = [m(s, 0, 0).id, m(s, 0, 1).id];
  const final = m(s, 1, 0).id;
  s = run(s, { type: 'match.start', base: dayVersion(s), matchId: m0, station: 1 });
  s = run(s, { type: 'match.finish', base: dayVersion(s), matchId: m0, winner: 'p1' });
  assert.equal(byId(s, final).a, 'p1');
  s = run(s, { type: 'match.undo', base: dayVersion(s), matchId: m0 });
  assert.equal(byId(s, final).a, null);
  s = run(s, { type: 'match.start', base: dayVersion(s), matchId: m0, station: 1 });
  s = run(s, { type: 'match.finish', base: dayVersion(s), matchId: m0, winner: 'p4' });
  s = run(s, { type: 'match.start', base: dayVersion(s), matchId: m1, station: 2 });
  s = run(s, { type: 'match.finish', base: dayVersion(s), matchId: m1, winner: 'p3' });
  assert.equal(byId(s, final).a, 'p4');
  assert.equal(byId(s, final).b, 'p3');
});

test('§6.16: correcting a result after the next match started is rejected and changes nothing', () => {
  let s = loaded(4, 2);
  const [m0, m1, final] = [m(s, 0, 0).id, m(s, 0, 1).id, m(s, 1, 0).id];
  for (const [id, w, st] of [[m0, 'p1', 1], [m1, 'p2', 2]] as const) {
    s = run(s, { type: 'match.start', base: dayVersion(s), matchId: id, station: st });
    s = run(s, { type: 'match.finish', base: dayVersion(s), matchId: id, winner: w });
  }
  s = run(s, { type: 'match.start', base: dayVersion(s), matchId: final, station: 1 });
  rejects(() => run(s, { type: 'match.undo', base: dayVersion(s), matchId: m0 }), 'conflict', /M3 .* has already started — undo that first/);
  s = run(s, { type: 'match.finish', base: dayVersion(s), matchId: final, winner: 'p2', score: '3-1' });
  rejects(() => run(s, { type: 'match.undo', base: dayVersion(s), matchId: m1 }), 'conflict', /has already been played/);
  // Undo the final first, then the semi is correctable.
  s = run(s, { type: 'match.undo', base: dayVersion(s), matchId: final });
  s = run(s, { type: 'match.undo', base: dayVersion(s), matchId: m1 });
  assert.equal(byId(s, final).b, null);
  assert.equal(byId(s, final).score, '');
});

test('finish preconditions: winner must be a participant; done can’t be finished twice; byes can’t be undone', () => {
  let s = loaded(3, 2); // p1 has a bye
  const bye = s.day.matches.find((x) => x.bye)!;
  rejects(() => run(s, { type: 'match.undo', base: 0, matchId: bye.id }), 'conflict', /bye/);
  const real = s.day.matches.find((x) => x.round === 0 && !x.bye)!;
  rejects(() => run(s, { type: 'match.finish', base: 0, matchId: real.id, winner: real.a! }), 'conflict', /hasn’t started/);
  s = run(s, { type: 'match.start', base: 0, matchId: real.id, station: 1 });
  rejects(() => run(s, { type: 'match.finish', base: 0, matchId: real.id, winner: 'p1' }), 'conflict', /isn’t playing in M2/);
  rejects(() => run(s, { type: 'match.finish', base: 0, matchId: real.id, winner: real.a!, score: 'x'.repeat(41) }), 'invalid');
  s = run(s, { type: 'match.finish', base: 0, matchId: real.id, winner: real.a! });
  rejects(() => run(s, { type: 'match.finish', base: 0, matchId: real.id, winner: real.b! }), 'conflict', /already has a result/);
  rejects(() => run(s, { type: 'match.undo', base: 0, matchId: m(s, 1, 0).id }), 'conflict', /no result to undo/);
});

test('walkover: pending match, winner checked in and opponent not; both absent → no walkover', () => {
  const base = loaded(4, 2);
  const x = m(base, 0, 0);
  const only = (ids: string[]): Store => ({ ...base, day: { ...base.day, checkIn: Object.fromEntries(ids.map((p) => [p, 't'])) } });
  const s = run(only([x.a!]), { type: 'match.finish', base: 0, matchId: x.id, winner: x.a!, walkover: true });
  assert.equal(byId(s, x.id).walkover, true);
  assert.equal(byId(s, x.id).status, 'done');
  assert.equal(m(s, 1, 0).a, x.a);
  rejects(() => run(only([]), { type: 'match.finish', base: 0, matchId: x.id, winner: x.a!, walkover: true }), 'conflict', /hasn’t checked in/);
  rejects(() => run(only([x.a!, x.b!]), { type: 'match.finish', base: 0, matchId: x.id, winner: x.a!, walkover: true }), 'conflict', /play the match instead/);
  // undo a walkover clears the flag
  const u = run(s, { type: 'match.undo', base: 0, matchId: x.id });
  assert.equal(byId(u, x.id).walkover, undefined);
});

test('reset / load with a stale base are conflicts; each success bumps the version by one', () => {
  let s = loaded(4, 2);
  assert.equal(dayVersion(s), 1);
  const stale = dayVersion(s);
  s = run(s, { type: 'match.start', base: stale, matchId: m(s, 0, 0).id, station: 1 });
  rejects(() => run(s, { type: 'bracket.reset', base: stale }), 'conflict', /changed on another device/);
  rejects(() => run(s, { type: 'bracket.load', base: stale, players: players(4) }), 'conflict', /changed on another device/);
  // load over a running bracket is refused even with the right base — reset first
  rejects(() => run(s, { type: 'bracket.load', base: dayVersion(s), players: players(4) }), 'conflict', /reset the bracket/);
  const r = run(s, { type: 'bracket.reset', base: dayVersion(s) });
  // reset clears the bracket only: players, seeds and check-ins stay for re-seeding / rebuilding
  assert.deepEqual([r.day.players, r.day.checkIn, r.day.matches, dayVersion(r)], [s.day.players, s.day.checkIn, [], 3]);
  assert.equal(r.day.stations, 2);
});

test('load: validation of players and explicit pairs; check-ins for removed players are dropped', () => {
  const s = emptyStore();
  const P = players(4);
  rejects(() => run(s, { type: 'bracket.load', base: 0, players: [P[0], { ...P[1], id: 'p1' }] }), 'invalid', /appears twice/);
  rejects(() => run(s, { type: 'bracket.load', base: 0, players: [P[0], { ...P[1], name: 'player 1' }] }), 'invalid', /appears twice/);
  rejects(() => run(s, { type: 'bracket.load', base: 0, players: P, pairs: [['p1', 'p2'], ['p3', 'p4'], ['p1', null]] }), 'invalid', /1, 2, 4/);
  rejects(() => run(s, { type: 'bracket.load', base: 0, players: P, pairs: [['p1', 'p2'], ['p3', 'p1']] }), 'invalid', /two pairings/);
  rejects(() => run(s, { type: 'bracket.load', base: 0, players: P, pairs: [['p1', 'p2'], ['p3', null]] }), 'invalid', /Player 4 isn’t in any pairing/);
  rejects(() => run(s, { type: 'bracket.load', base: 0, players: P, pairs: [['p1', 'p2'], ['p3', 'p4'], [null, null], ['x', null]] as [string | null, string | null][] }), 'invalid', /BYE vs BYE/);
  rejects(() => run(s, { type: 'bracket.load', base: 0, players: P, pairs: [['p1', 'p2'], ['p3', 'zz']] }), 'invalid', /isn’t on the roster/);

  const withCheckIns: Store = { ...s, day: { ...s.day, checkIn: { p1: 'a', gone: 'b' } } };
  const l = run(withCheckIns, { type: 'bracket.load', base: 0, players: P, pairs: [['p4', 'p1'], ['p2', 'p3']], stations: 3 });
  assert.deepEqual(l.day.checkIn, { p1: 'a' });
  assert.equal(l.day.stations, 3);
  assert.deepEqual(l.day.matches.filter((x) => x.round === 0).map((x) => [x.a, x.b]), [['p4', 'p1'], ['p2', 'p3']]);
});

test('deterministic: the same command and commandId give identical results (client optimistic == server)', () => {
  const s = emptyStore();
  const c: CommandContext = { commandId: 'cmd-xyz', now: '2026-10-23T10:00:00.000Z', actor: { principal: 'super', name: 'HQ', role: 'super' }, event };
  const cmd: Command = { type: 'bracket.load', base: 0, players: players(13), stations: 3 };
  const a = run(structuredClone(s), cmd, c);
  const b = run(structuredClone(s), cmd, { ...c, actor: { principal: 'super', name: 'Another HQ device', role: 'super' } });
  assert.deepEqual(a, b);
  assert.ok(a.day.matches.every((x) => x.id.startsWith('cmd-xyz-')));
  const checked = checkAll(a);
  const start: Command = { type: 'match.start', base: 1, matchId: m(a, 0, 1).id, station: 2 };
  assert.deepEqual(run(structuredClone(checked), start, { ...c, commandId: 'k' }), run(structuredClone(checked), start, { ...c, commandId: 'k' }));
  // handlers don't mutate their input
  const before = structuredClone(checked);
  run(checked, start, c);
  assert.deepEqual(checked, before);
});

test('role check runs through applyCommand', () => {
  const s = loaded(2, 1);
  const forbidden = ctx({ actor: { principal: 'x', name: 'x', role: 'viewer' as never } });
  rejects(() => applyCommand(s, { type: 'bracket.reset', base: 1 }, forbidden), 'forbidden');
});

test('downstream next match is pending → a done result can be undone; resolve never re-points a started match', () => {
  let s = loaded(8, 4);
  for (const i of [0, 1]) {
    const id = m(s, 0, i).id;
    s = run(s, { type: 'match.start', base: 0, matchId: id, station: i + 1 });
    s = run(s, { type: 'match.finish', base: 0, matchId: id, winner: byId(s, id).a! });
  }
  const semi: Match = m(s, 1, 0);
  assert.deepEqual([semi.a, semi.b], [m(s, 0, 0).a, m(s, 0, 1).a]);
  assert.equal(nextOf(m(s, 0, 0), s.day.matches)!.id, semi.id);
  s = run(s, { type: 'match.undo', base: 0, matchId: m(s, 0, 0).id });
  assert.equal(m(s, 1, 0).a, null);
});

test('bracket.load keeps phones (QR check-in needs them), and reload/reset keep check-in sources consistent', () => {
  const ps: Player[] = [
    { id: 'pa', name: 'Asha', seed: 1, phone: '9820011111' },
    { id: 'pb', name: 'Bilal', seed: 2, phone: '9820022222' },
    { id: 'pc', name: 'Chen', seed: 3 },
  ];
  const loaded = run(emptyStore(), { type: 'bracket.load', base: 0, players: ps });
  assert.equal(loaded.day.players.find((p) => p.id === 'pa')!.phone, '9820011111');
  assert.equal(loaded.day.players.find((p) => p.id === 'pc')!.phone, undefined);
  assert.throws(() => run(emptyStore(), { type: 'bracket.load', base: 0, players: [{ ...ps[0], phone: '98-20' }, ps[1]] }), CommandError);

  // a self check-in, then HQ re-imports without Bilal: Asha keeps her check-in and its source
  const checked: Store = { ...loaded, day: { ...loaded.day, checkIn: { pa: '2026-10-24T09:00:00.000Z', pb: '2026-10-24T09:01:00.000Z' }, checkInSource: { pa: 'self', pb: 'self' } } };
  const reloaded = run(checked, { type: 'bracket.load', base: dayVersion(checked), players: [ps[0], ps[2]] });
  assert.deepEqual(reloaded.day.checkIn, { pa: '2026-10-24T09:00:00.000Z' });
  assert.deepEqual(reloaded.day.checkInSource, { pa: 'self' });

  const reset = run(reloaded, { type: 'bracket.reset', base: dayVersion(reloaded) });
  assert.deepEqual(reset.day.matches, []);
  assert.deepEqual(reset.day.checkIn, { pa: '2026-10-24T09:00:00.000Z' }, 'reset keeps check-ins');
  assert.deepEqual(reset.day.checkInSource, { pa: 'self' });
});

test('players → seeding → bracket: set the roster, seed it, build, reset, re-seed, rebuild', () => {
  const P = players(6);
  let s = run(emptyStore(), { type: 'players.set', base: 0, players: P });
  assert.equal(s.day.players.length, 6);
  assert.deepEqual(s.day.matches, [], 'players.set never builds a bracket');
  rejects(() => run(s, { type: 'bracket.build', base: dayVersion(s) - 1 }), 'conflict', /changed on another device/);

  // seed in reverse: p6 is now seed 1
  const order = [...P].reverse().map((p) => p.id);
  s = run(s, { type: 'players.seed', base: dayVersion(s), order });
  assert.deepEqual(s.day.players.map((p) => [p.id, p.seed]), order.map((id, i) => [id, i + 1]));
  rejects(() => run(s, { type: 'players.seed', base: dayVersion(s), order: order.slice(1) }), 'conflict', /player list changed/);

  s = run(s, { type: 'bracket.build', base: dayVersion(s), stations: 3 }, ctx({ commandId: 'build-1' }));
  assert.equal(s.day.stations, 3);
  assert.ok(s.day.matches.length > 0 && s.day.matches.every((m) => m.id.startsWith('build-1-')));
  const top = s.day.matches.find((m) => m.round === 0 && (m.a === 'p6' || m.b === 'p6'))!;
  assert.ok(top.bye, 'seed 1 (p6) gets the bye with 6 players');

  // seeding again clears an unstarted bracket; reset keeps the players
  const reseeded = run(s, { type: 'players.seed', base: dayVersion(s), order: P.map((p) => p.id) });
  assert.deepEqual(reseeded.day.matches, []);
  const reset = run(s, { type: 'bracket.reset', base: dayVersion(s) });
  assert.equal(reset.day.players.length, 6);
  assert.deepEqual(reset.day.matches, []);

  // once a match is played, roster / seeding / rebuild are refused until reset
  const checked = checkAll(s);
  const m = checked.day.matches.find((x) => x.round === 0 && !x.bye)!;
  const live = run(checked, { type: 'match.start', base: dayVersion(checked), matchId: m.id, station: 1 });
  rejects(() => run(live, { type: 'players.set', base: dayVersion(live), players: P }), 'conflict', /reset the bracket/);
  rejects(() => run(live, { type: 'players.seed', base: dayVersion(live), order }), 'conflict', /reset the bracket/);
  rejects(() => run(live, { type: 'bracket.build', base: dayVersion(live) }), 'conflict', /reset the bracket/);

  // an empty roster is allowed (remove everyone); a bracket needs 2
  const empty = run(emptyStore(), { type: 'players.set', base: 0, players: [] });
  assert.deepEqual(empty.day.players, []);
  rejects(() => run(empty, { type: 'bracket.build', base: dayVersion(empty) }), 'invalid', /at least 2/);
});

test('in-game names: kept (spaces collapsed) through players.set, seeding, build and bracket.load; bad ones refused', () => {
  const P: Player[] = [
    { id: 'pa', name: 'Asha Rao', seed: 1, phone: '9820011111', ign: '  Ash   R ' },
    { id: 'pb', name: 'Bilal', seed: 2, ign: '' },
    { id: 'pc', name: 'Chetan', seed: 3 },
  ];
  let s = run(emptyStore(), { type: 'players.set', base: 0, players: P });
  assert.deepEqual(s.day.players[0], { id: 'pa', name: 'Asha Rao', seed: 1, phone: '9820011111', ign: 'Ash R' });
  assert.ok(!('ign' in s.day.players[1]) && !('ign' in s.day.players[2]), 'an empty in-game name is dropped');
  s = run(s, { type: 'players.seed', base: dayVersion(s), order: ['pc', 'pa', 'pb'] });
  s = run(s, { type: 'bracket.build', base: dayVersion(s) });
  assert.equal(s.day.players.find((p) => p.id === 'pa')!.ign, 'Ash R');
  const loaded = run(emptyStore(), { type: 'bracket.load', base: 0, players: P });
  assert.equal(loaded.day.players[0].ign, 'Ash R');

  rejects(() => run(emptyStore(), { type: 'players.set', base: 0, players: [{ ...P[0], ign: 42 as unknown as string }] }), 'invalid', /in-game name should be text/);
  rejects(() => run(emptyStore(), { type: 'players.set', base: 0, players: [{ ...P[0], ign: 'x'.repeat(41) }] }), 'invalid', /longer than 40/);
  assert.equal(run(emptyStore(), { type: 'players.set', base: 0, players: [{ ...P[0], ign: 'x'.repeat(40) }] }).day.players[0].ign, 'x'.repeat(40));
});

test('players / seeding / bracket commands are HQ-only', () => {
  const admin = ctx({ actor: { principal: 'admin:1', name: 'Rhea', role: 'admin' } });
  for (const cmd of [
    { type: 'players.set', base: 0, players: players(2) },
    { type: 'players.seed', base: 0, order: [] },
    { type: 'bracket.build', base: 0 },
  ] as Command[])
    rejects(() => run(emptyStore(), cmd, admin), 'forbidden', /./);
});

/* ---------- on-the-spot registration ---------- */

const desk = (name = 'Rhea') => ctx({ actor: { principal: 'admin:1', name, role: 'admin' } });
const onspot = (name: string, over: Partial<Extract<Command, { type: 'players.onspot' }>> = {}): Command => ({ type: 'players.onspot', base: 0, name, ...over });

test('players.onspot: an admin registers a walk-in — next seed, checked in by staff, recorded for HQ; the bracket is never touched', () => {
  const c = desk();
  const four = checkAll(run(emptyStore(), { type: 'players.set', base: 0, players: players(4) }));
  const s = run(four, onspot('  Ravi   K. ', { phone: '+91 98200 55555', ign: '  RaviOP ' }), c);
  const p = s.day.players[4];
  assert.deepEqual(p, { id: playerIdFor('9820055555', 'Ravi K.'), name: 'Ravi K.', seed: 5, phone: '9820055555', ign: 'RaviOP' });
  assert.equal(s.day.checkIn[p.id], c.now);
  assert.equal(s.day.checkInSource?.[p.id], 'staff');
  assert.deepEqual(s.day.onSpot, [{ id: `os-${c.commandId}`, playerId: p.id, name: 'Ravi K.', phone: '9820055555', ign: 'RaviOP', at: c.now, by: 'Rhea' }]);
  assert.deepEqual(s.day.matches, four.day.matches, 'bracket untouched');
  assert.equal(dayVersion(s), dayVersion(four) + 1);

  // no phone, no IGN, empty list (HQ hasn't loaded anyone yet): still works; the id comes from the name
  const e = run(emptyStore(), onspot('Meera'), desk());
  assert.deepEqual(e.day.players, [{ id: playerIdFor(undefined, 'Meera'), name: 'Meera', seed: 1 }]);
  assert.equal(e.day.onSpot?.[0].phone, undefined);

  // once the bracket is out only HQ registers: recorded, the live match stays live
  const out = loaded(4);
  let live = run(out, { type: 'match.start', base: 1, matchId: m(out, 0, 0).id, station: 1 });
  const before = live.day.matches;
  live = run(live, onspot('Late Comer', { base: 0 }), ctx());
  assert.deepEqual(live.day.matches, before);
  assert.equal(live.day.players.length, 5);
  assert.equal(live.day.onSpot?.length, 1);
});

test('players.onspot: closed for the desk once the bracket is out (admin and store team), open before it; HQ can still register', () => {
  const msg = /The bracket is out, so on-spot registration is closed here. Ask HQ to add a player./;
  const before = checkAll(run(emptyStore(), { type: 'players.set', base: 0, players: players(4) }));
  assert.equal(run(before, onspot('Early Bird'), desk()).day.players.length, 5);
  const out = loaded(4);
  rejects(() => run(out, onspot('Late Comer'), desk()), 'conflict', msg);
  rejects(() => run(out, onspot('Late Comer'), ctx({ actor: { principal: 'store:s1', name: 'Rhea (Store team)', role: 'admin' } })), 'conflict', msg);
  const hq = run(out, onspot('Late Comer'), ctx());
  assert.equal(hq.day.players.length, 5);
  assert.deepEqual(hq.day.matches, out.day.matches);
  // after a reset the desk may register again
  const reset = run(out, { type: 'bracket.reset', base: dayVersion(out) });
  assert.equal(run(reset, onspot('Late Comer'), desk()).day.players.length, 5);
});

test('players.onspot: a phone already on the list is refused; bad input is invalid', () => {
  const withPhone = run(emptyStore(), { type: 'players.set', base: 0, players: [{ id: 'p1', name: 'Asha R.', seed: 1, phone: '9820011111' }] });
  rejects(() => run(withPhone, onspot('Someone Else', { phone: '098200-11111' }), desk()), 'conflict', /number ending 1111 is already on the list as Asha R\. — check them in instead/);
  const checked = { ...withPhone, day: { ...withPhone.day, checkIn: { p1: '2026-10-23T09:00:00.000Z' } } };
  rejects(() => run(checked, onspot('Someone Else', { phone: '9820011111' }), desk()), 'conflict', /already checked in/);
  rejects(() => run(emptyStore(), onspot('   '), desk()), 'invalid', /name/);
  rejects(() => run(emptyStore(), onspot('x'.repeat(81)), desk()), 'invalid', /80/);
  rejects(() => run(emptyStore(), onspot('Ravi', { phone: '12345' }), desk()), 'invalid', /phone number doesn’t look right/);
  rejects(() => run(emptyStore(), onspot('Ravi', { ign: 'x'.repeat(41) }), desk()), 'invalid', /40/);
});

test('players.onspot: the same name needs the admin to confirm a different person → "Name (2)", "(3)"', () => {
  const s = run(emptyStore(), { type: 'players.set', base: 0, players: [{ id: 'p1', name: 'Asha R.', seed: 1 }] });
  rejects(() => run(s, onspot(' asha   r. '), desk()), 'conflict', /Asha R\. is already on the list — if it’s them, check them in instead/);
  assert.deepEqual(onSpotClash(s.day, 'ASHA R.'), { kind: 'name', player: s.day.players[0] });
  const two = run(s, onspot('asha r.', { sameName: 'different', phone: '9000000002' }), desk());
  assert.equal(two.day.players[1].name, 'asha r. (2)');
  assert.equal(two.day.onSpot?.[0].name, 'asha r. (2)');
  assert.equal(differentName(two.day, 'Asha R.'), 'Asha R. (3)');
  const three = run(two, onspot('Asha R.', { sameName: 'different' }), desk());
  assert.equal(three.day.players[2].name, 'Asha R. (3)');
  // "different" with no clash is simply the name; a long name is cut to keep within 80 with the tag
  assert.equal(run(emptyStore(), onspot('Solo', { sameName: 'different' }), desk()).day.players[0].name, 'Solo');
  const long = 'L'.repeat(80);
  const l1 = run(emptyStore(), onspot(long), desk());
  const l2 = run(l1, onspot(long, { sameName: 'different' }), desk());
  assert.equal(l2.day.players[1].name, `${'L'.repeat(76)} (2)`);
  // the next HQ players.set with everyone still passes the roster rules (unique names, ≤ 80)
  run(three, { type: 'players.set', base: dayVersion(three), players: three.day.players });
});

test('players.onspot: ids never clash; caps at 256 players / registrations', () => {
  const name = 'Clash Test';
  const s = run(emptyStore(), { type: 'players.set', base: 0, players: [{ id: playerIdFor('9000000001', name), name: 'Other Name', seed: 1 }] });
  const t = run(s, onspot(name, { phone: '9000000001' }), desk());
  assert.equal(t.day.players[1].id, `${playerIdFor('9000000001', name)}-2`);
  const full = run(emptyStore(), { type: 'players.set', base: 0, players: players(256) });
  rejects(() => run(full, onspot('One More'), desk()), 'conflict', /list is full/);
  const many = { ...emptyStore(), day: { ...emptyStore().day, onSpot: Array.from({ length: 256 }, (_, i) => ({ id: `os-${i}`, playerId: `x${i}`, name: `W ${i}`, at: '2026-10-23T09:00:00.000Z', by: 'Rhea' })) } };
  rejects(() => run(many, onspot('One More'), desk()), 'conflict', /256/);
});

test('players.onspot: deterministic per command id; a view that already has it is unchanged', () => {
  const c = desk();
  const two = run(emptyStore(), { type: 'players.set', base: 0, players: players(2) });
  const a = run(two, onspot('Same', { phone: '9000000009' }), c);
  const b = run(two, onspot('Same', { phone: '9000000009' }), c);
  assert.deepEqual(a, b);
  // a device re-running its own pending command over a view that already has it (no double entry, no version bump)
  const again = run(a, onspot('Same', { phone: '9000000009' }), c);
  assert.equal(again, a);
});

test('onspot.mark: HQ marks / unmarks a registration; admins can’t; a missing entry is a conflict', () => {
  const c = desk();
  const s = run(emptyStore(), onspot('Ravi K.'), c);
  const entryId = `os-${c.commandId}`;
  rejects(() => run(s, { type: 'onspot.mark', base: 1, entryId, done: true }, desk()), 'forbidden', /./);
  const hqc = ctx();
  const marked = run(s, { type: 'onspot.mark', base: 1, entryId, done: true }, hqc);
  assert.equal(marked.day.onSpot?.[0].toornament, hqc.now);
  assert.equal(run(marked, { type: 'onspot.mark', base: 2, entryId, done: true }).day.onSpot?.[0].toornament, hqc.now, 'marking twice keeps the first time');
  const unmarked = run(marked, { type: 'onspot.mark', base: 2, entryId, done: false });
  assert.equal('toornament' in unmarked.day.onSpot![0], false);
  rejects(() => run(s, { type: 'onspot.mark', base: 1, entryId: 'os-nope', done: true }), 'conflict', /isn’t on this store/);
});

test('players.set / seed / build / reset / bracket.load keep the on-the-spot record', () => {
  let s = run(emptyStore(), { type: 'players.set', base: 0, players: players(3) });
  s = run(s, onspot('Walk In'), desk());
  const record = s.day.onSpot;
  assert.equal(record?.length, 1);
  const order = [...s.day.players].reverse().map((p) => p.id);
  s = run(s, { type: 'players.seed', base: dayVersion(s), order });
  assert.deepEqual(s.day.onSpot, record);
  s = run(s, { type: 'bracket.build', base: dayVersion(s) });
  assert.deepEqual(s.day.onSpot, record);
  s = run(s, { type: 'bracket.reset', base: dayVersion(s) });
  assert.deepEqual(s.day.onSpot, record);
  // HQ replaces the list without the walk-in: the record (HQ's Toornament to-do) stays
  s = run(s, { type: 'players.set', base: dayVersion(s), players: players(2) });
  assert.deepEqual(s.day.onSpot, record);
  s = run(s, { type: 'bracket.load', base: dayVersion(s), players: players(4) });
  assert.deepEqual(s.day.onSpot, record);
});

test('validateCommand: players.onspot and onspot.mark shapes', () => {
  assert.equal(validateCommand({ type: 'players.onspot', base: 0, name: 'Ravi', phone: '98200', ign: 'r', sameName: 'different' }).type, 'players.onspot');
  for (const bad of [
    { type: 'players.onspot', base: 0 },
    { type: 'players.onspot', base: 0, name: 'Ravi', phone: 98200 },
    { type: 'players.onspot', base: 0, name: 'Ravi', sameName: 'yes' },
    { type: 'onspot.mark', base: 0, entryId: 'os-1' },
    { type: 'onspot.mark', base: 0, done: true },
  ])
    assert.throws(() => validateCommand(bad), CommandError);
});

test('bracket.load from Toornament: a walk-in not on Toornament yet stays on the list outside the bracket; anyone else missing is refused', () => {
  let s = run(emptyStore(), { type: 'players.set', base: 0, players: players(4) });
  s = run(s, onspot('Ravi K', { phone: '9820099999' }), ctx({ actor: { principal: 'admin:a1', name: 'Rhea', role: 'admin' } }));
  const ravi = s.day.players.find((p) => p.name === 'Ravi K')!;
  const P = s.day.players;
  const r = run(s, { type: 'bracket.load', base: dayVersion(s), players: P, pairs: [['p1', 'p4'], ['p2', 'p3']] });
  assert.ok(r.day.players.some((p) => p.id === ravi.id), 'still on the list');
  assert.ok(!r.day.matches.some((m) => m.a === ravi.id || m.b === ravi.id), 'not in the bracket');
  assert.ok(r.day.checkIn[ravi.id], 'still checked in');
  assert.equal(r.day.onSpot?.length, 1);
  rejects(() => run(s, { type: 'bracket.load', base: dayVersion(s), players: P, pairs: [['p1', 'p4'], ['p2', ravi.id]] }), 'invalid', /Player 3 isn’t in any pairing/);
});

/* ---------- bracket.place: HQ changes a first-round slot ---------- */

/** Round 0: M1 p1 v p2, M2 p3 v bye, M3 p4 v p5, M4 p6 v bye — plus a walk-in HQ registered who has no slot. All checked in. */
function slotted(): Store {
  const pairs: [string | null, string | null][] = [['p1', 'p2'], ['p3', null], ['p4', 'p5'], ['p6', null]];
  const s = run(emptyStore(4), { type: 'bracket.load', base: 0, players: players(6), pairs, stations: 4 });
  return checkAll(run(s, onspot('Walk In'), ctx()));
}
const place = (s: Store, matchId: string, side: 'a' | 'b', playerId: string | null, over: Partial<Extract<Command, { type: 'bracket.place' }>> = {}): Command => ({ type: 'bracket.place', base: dayVersion(s), matchId, side, playerId, ...over });
const walkId = (s: Store) => s.day.players.find((p) => p.name === 'Walk In')!.id;

test('bracket.place: a walk-in fills an empty bye slot — the bye becomes a real match and its winner leaves round 1', () => {
  const s = slotted();
  const bye = m(s, 0, 1);
  assert.ok(bye.bye && bye.status === 'done');
  assert.equal(m(s, 1, 0).b, 'p3', 'the bye winner had advanced');
  const t = run(s, place(s, bye.id, 'b', walkId(s)));
  const now = byId(t, bye.id);
  assert.deepEqual([now.a, now.b, now.winner, now.status], ['p3', walkId(s), null, 'pending']);
  assert.ok(!now.bye);
  assert.equal(m(t, 1, 0).b, null, 'pulled back out of round 1');
  assert.equal(dayVersion(t), dayVersion(s) + 1);
  assert.deepEqual(t.day.players, s.day.players);
  assert.deepEqual(t.day.checkIn, s.day.checkIn);
  // the new match plays like any other
  const started = run(t, { type: 'match.start', base: dayVersion(t), matchId: bye.id, station: 1 });
  assert.equal(byId(started, bye.id).status, 'live');
});

test('bracket.place: a no-show is replaced in a pending match; the replaced player stays on the list', () => {
  const s = slotted();
  const m1 = m(s, 0, 0);
  const t = run(s, place(s, m1.id, 'a', walkId(s)));
  assert.deepEqual([byId(t, m1.id).a, byId(t, m1.id).b, byId(t, m1.id).status], [walkId(s), 'p2', 'pending']);
  assert.ok(t.day.players.some((p) => p.id === 'p1') && t.day.checkIn.p1, 'p1 stays on the list, still checked in');
  assert.ok(!t.day.matches.some((x) => x.a === 'p1' || x.b === 'p1'));
  // and p1 can now be put in the empty bye slot
  const u = run(t, place(t, m(t, 0, 1).id, 'b', 'p1'));
  assert.deepEqual([m(u, 0, 1).a, m(u, 0, 1).b], ['p3', 'p1']);
});

test('bracket.place: emptying a slot gives the opponent a bye and they advance; a match can’t lose both players', () => {
  const s = slotted();
  const m1 = m(s, 0, 0);
  const t = run(s, place(s, m1.id, 'b', null));
  const now = byId(t, m1.id);
  assert.deepEqual([now.a, now.b, now.bye, now.status, now.winner], ['p1', null, true, 'done', 'p1']);
  assert.equal(m(t, 1, 0).a, 'p1', 'advanced');
  assert.ok(t.day.players.some((p) => p.id === 'p2'), 'p2 stays on the list');
  // the other side of that bye can't be emptied too; an empty slot stays empty without a version bump
  rejects(() => run(t, place(t, m1.id, 'a', null)), 'invalid', /A match needs at least one player\./);
  assert.equal(run(t, place(t, m1.id, 'b', null)), t);
  rejects(() => run(s, place(s, m(s, 0, 1).id, 'a', null)), 'invalid', /at least one player/);
});

test('bracket.place: a live or played match is refused, and so is one whose next match has started', () => {
  const s = slotted();
  const m1 = m(s, 0, 0);
  const live = run(s, { type: 'match.start', base: dayVersion(s), matchId: m1.id, station: 1 });
  rejects(() => run(live, place(live, m1.id, 'a', walkId(s))), 'conflict', /M1 has already started — undo it first, or change a match that hasn’t been played\./);
  const done = run(live, { type: 'match.finish', base: dayVersion(live), matchId: m1.id, winner: 'p1' });
  rejects(() => run(done, place(done, m1.id, 'a', walkId(s))), 'conflict', /M1 has already been played — undo it first/);
  // M5 (p1 v the bye's p3) is being played, so M2's bye can't be given an opponent
  const m5 = m(done, 1, 0);
  const next = run(done, { type: 'match.start', base: dayVersion(done), matchId: m5.id, station: 2 });
  rejects(() => run(next, place(next, m(next, 0, 1).id, 'b', walkId(s))), 'conflict', /M5 \(Player 1 vs Player 3\) has already started — undo that first\./);
  // undo M5 and M1, and it works again
  const undone = run(run(next, { type: 'match.undo', base: dayVersion(next), matchId: m5.id }), { type: 'match.undo', base: dayVersion(next) + 1, matchId: m1.id });
  assert.equal(run(undone, place(undone, m1.id, 'a', walkId(s))).day.matches.find((x) => x.id === m1.id)!.a, walkId(s));
});

test('bracket.place: only first-round matches, only players on the list, and nobody already in the bracket', () => {
  const s = slotted();
  rejects(() => run(s, place(s, m(s, 1, 0).id, 'a', walkId(s))), 'conflict', /M5 isn’t a first-round match/);
  rejects(() => run(s, place(s, 'nope', 'a', walkId(s))), 'conflict', /no longer in this bracket/);
  rejects(() => run(s, place(s, m(s, 0, 1).id, 'b', 'ghost')), 'conflict', /isn’t on the list/);
  rejects(() => run(s, place(s, m(s, 0, 1).id, 'b', 'p4')), 'conflict', /^Player 4 is already in M3\. Empty that slot first\.$/);
  rejects(() => run(s, place(s, m(s, 0, 0).id, 'b', 'p1')), 'conflict', /Player 1 is already in M1\./);
  // the same player in the same slot changes nothing
  assert.equal(run(s, place(s, m(s, 0, 0).id, 'a', 'p1')), s);
});

test('bracket.place: HQ only, and only from a device that has seen the latest bracket', () => {
  const s = slotted();
  const cmd = place(s, m(s, 0, 1).id, 'b', walkId(s));
  rejects(() => run(s, cmd, desk()), 'forbidden', /can’t bracket\.place/);
  rejects(() => run(s, place(s, m(s, 0, 1).id, 'b', walkId(s), { base: dayVersion(s) - 1 })), 'conflict', /changed on another device/);
  rejects(() => run(s, place(s, m(s, 0, 1).id, 'b', walkId(s), { base: dayVersion(s) + 1 })), 'conflict', /changed on another device/);
});

test('bracket.place swap: two players in different pending matches trade slots', () => {
  const s = slotted();
  const [m1, m3] = [m(s, 0, 0), m(s, 0, 2)];
  const t = run(s, place(s, m3.id, 'b', 'p1', { swap: true }));
  assert.deepEqual([byId(t, m1.id).a, byId(t, m1.id).b, byId(t, m1.id).status], ['p5', 'p2', 'pending']);
  assert.deepEqual([byId(t, m3.id).a, byId(t, m3.id).b, byId(t, m3.id).status], ['p4', 'p1', 'pending']);
  assert.equal(dayVersion(t), dayVersion(s) + 1);
  assert.deepEqual(t.day.players, s.day.players);
  assert.deepEqual(t.day.checkIn, s.day.checkIn);
  // without swap it is still refused, with the old advice
  rejects(() => run(s, place(s, m3.id, 'b', 'p1')), 'conflict', /^Player 1 is already in M1\. Empty that slot first\.$/);
  // the player already in that slot: nothing changes
  assert.equal(run(s, place(s, m3.id, 'b', 'p5', { swap: true })), s);
});

test('bracket.place swap: into an empty bye slot — the source match becomes a bye, or is refused if it would be empty', () => {
  const s = slotted();
  const [m1, m2] = [m(s, 0, 0), m(s, 0, 1)];
  assert.ok(m2.bye && m(s, 1, 0).b === 'p3');
  const t = run(s, place(s, m2.id, 'b', 'p1', { swap: true }));
  assert.deepEqual([byId(t, m2.id).a, byId(t, m2.id).b, byId(t, m2.id).status, byId(t, m2.id).bye], ['p3', 'p1', 'pending', undefined]);
  assert.deepEqual([byId(t, m1.id).a, byId(t, m1.id).b, byId(t, m1.id).bye, byId(t, m1.id).winner], [null, 'p2', true, 'p2']);
  assert.deepEqual([m(t, 1, 0).a, m(t, 1, 0).b], ['p2', null], 'p2 advanced, p3 pulled back out of round 1');
  // p3 sits alone in M2: moving them to the empty slot of M4 would leave M2 with nobody
  rejects(() => run(s, place(s, m(s, 0, 3).id, 'b', 'p3', { swap: true })), 'invalid', /A match needs at least one player\./);
  // …but with an opponent in the target slot it is fine: that player takes p3’s place and M2 stays a bye
  const u = run(s, place(s, m(s, 0, 3).id, 'a', 'p3', { swap: true }));
  assert.deepEqual([byId(u, m2.id).a, byId(u, m2.id).b, byId(u, m2.id).bye, byId(u, m2.id).winner], ['p6', null, true, 'p6']);
  assert.deepEqual([m(u, 0, 3).a, m(u, 0, 3).b], ['p3', null]);
  assert.deepEqual([m(u, 1, 0).b, m(u, 1, 1).b], ['p6', 'p3'], 'each bye now sends its new player on');
});

test('bracket.place swap: top and bottom of one match', () => {
  const s = slotted();
  const m1 = m(s, 0, 0);
  const t = run(s, place(s, m1.id, 'a', 'p2', { swap: true }));
  assert.deepEqual([byId(t, m1.id).a, byId(t, m1.id).b, byId(t, m1.id).status], ['p2', 'p1', 'pending']);
  assert.equal(dayVersion(t), dayVersion(s) + 1);
  // a bye keeps its player when it moves to the other side
  const m2 = m(s, 0, 1);
  const u = run(s, place(s, m2.id, 'b', 'p3', { swap: true }));
  assert.deepEqual([byId(u, m2.id).a, byId(u, m2.id).b, byId(u, m2.id).bye, byId(u, m2.id).winner], [null, 'p3', true, 'p3']);
  assert.equal(m(u, 1, 0).b, 'p3');
});

test('bracket.place swap: refused when either match is live or played, or when a started match downstream would move', () => {
  const s = slotted();
  const [m1, m3] = [m(s, 0, 0), m(s, 0, 2)];
  const live = run(s, { type: 'match.start', base: dayVersion(s), matchId: m1.id, station: 1 });
  rejects(() => run(live, place(live, m3.id, 'a', 'p1', { swap: true })), 'conflict', /M1 has already started — undo it first/); // the source is live
  rejects(() => run(live, place(live, m1.id, 'a', 'p4', { swap: true })), 'conflict', /M1 has already started — undo it first/); // the target is live
  const done = run(live, { type: 'match.finish', base: dayVersion(live), matchId: m1.id, winner: 'p1' });
  rejects(() => run(done, place(done, m3.id, 'a', 'p1', { swap: true })), 'conflict', /M1 has already been played/);
  rejects(() => run(done, place(done, m1.id, 'b', 'p4', { swap: true })), 'conflict', /M1 has already been played/);
  // M5 (p1 v the bye’s p3) is being played: p3 can’t be swapped out of M2 for p4, as M5 would get a new opponent
  const next = run(done, { type: 'match.start', base: dayVersion(done), matchId: m(done, 1, 0).id, station: 2 });
  rejects(() => run(next, place(next, m3.id, 'a', 'p3', { swap: true })), 'conflict', /M5 \(Player 1 vs Player 3\) has already started — undo that first\./);
  // the refused swap changed nothing, and a swap that leaves M5 alone still works
  assert.deepEqual([m(next, 0, 1).a, m(next, 0, 2).a], ['p3', 'p4']);
  const ok = run(next, place(next, m3.id, 'a', 'p5', { swap: true }));
  assert.deepEqual([m(ok, 0, 2).a, m(ok, 0, 2).b], ['p5', 'p4']);
  // a first-round slot only: later rounds can’t be the target
  rejects(() => run(s, place(s, m(s, 1, 0).id, 'a', 'p4', { swap: true })), 'conflict', /M5 isn’t a first-round match/);
});

test('bracket.place swap: HQ only, and only from a device that has seen the latest bracket', () => {
  const s = slotted();
  const cmd = place(s, m(s, 0, 2).id, 'b', 'p1', { swap: true });
  rejects(() => run(s, cmd, desk()), 'forbidden', /can’t bracket\.place/);
  rejects(() => run(s, place(s, m(s, 0, 2).id, 'b', 'p1', { swap: true, base: dayVersion(s) - 1 })), 'conflict', /changed on another device/);
  rejects(() => run(s, place(s, m(s, 0, 2).id, 'b', 'p1', { swap: true, base: dayVersion(s) + 1 })), 'conflict', /changed on another device/);
});

test('validateCommand: bracket.place shape', () => {
  assert.equal(validateCommand({ type: 'bracket.place', base: 3, matchId: 'x', side: 'b', playerId: null }).type, 'bracket.place');
  assert.equal(validateCommand({ type: 'bracket.place', base: 3, matchId: 'x', side: 'a', playerId: 'p1' }).type, 'bracket.place');
  assert.equal(validateCommand({ type: 'bracket.place', base: 3, matchId: 'x', side: 'a', playerId: 'p1', swap: true }).type, 'bracket.place');
  for (const bad of [
    { type: 'bracket.place', base: 3, side: 'a', playerId: 'p1' },
    { type: 'bracket.place', base: 3, matchId: 'x', side: 'c', playerId: 'p1' },
    { type: 'bracket.place', base: 3, matchId: 'x', side: 'a' },
    { type: 'bracket.place', base: 3, matchId: 'x', side: 'a', playerId: '' },
    { type: 'bracket.place', base: 3, matchId: 'x', side: 'a', playerId: 'p'.repeat(201) },
    { type: 'bracket.place', base: 3, matchId: 'x', side: 'a', playerId: 7 },
    { type: 'bracket.place', base: 3, matchId: 'x', side: 'a', playerId: 'p1', swap: false },
    { type: 'bracket.place', base: 3, matchId: 'x', side: 'a', playerId: 'p1', swap: 'yes' },
  ])
    assert.throws(() => validateCommand(bad), CommandError);
});
