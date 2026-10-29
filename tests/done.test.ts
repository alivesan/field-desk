/*
 * "Finished" and "campaign complete" (src/lib/done.ts): the automatic rule (final played + winner details
 * saved in full), HQ's hand-made mark and reopen, and when a campaign counts as complete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, CommandError, validateCommand, type Command, type CommandContext } from '../src/lib/commands.ts';
import { campaignComplete, storeFinished } from '../src/lib/done.ts';
import { validateDocument } from '../src/lib/schema.ts';
import type { Player, Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureStore } from './helpers/server.ts';

const event = (over: Partial<TournamentEvent> = {}): TournamentEvent => ({ id: 'e1', name: 'Test Cup', date: '2026-10-23', games: [], collateral: [], gameReadyTarget: 0, minDownMbps: 0, createdAt: '2026-10-01T00:00:00.000Z', ...over });
let seq = 0;
const ctx = (role: 'super' | 'admin' = 'super', name = 'HQ'): CommandContext => ({
  commandId: `d${++seq}`,
  now: new Date(Date.UTC(2026, 9, 23, 10, 0, seq)).toISOString(),
  actor: { principal: role === 'super' ? 'super' : 'a1', name, role },
  event: event(),
});
const run = (s: Store, cmd: Command, c = ctx()) => applyCommand(s, cmd, c);
const fresh = (id = 's1') => fixtureStore(id, 'e1', 'a1') as unknown as Store;
const players: Player[] = [1, 2, 3, 4].map((i) => ({ id: `p${i}`, name: `Player ${i}`, seed: i, phone: `98200000${i}0` }));

/** A 4-player bracket played to the end (p1 beats p2 in the final). */
function played(id = 's1'): Store {
  const l = run(fresh(id), { type: 'bracket.load', base: 0, players, stations: 2 });
  let s: Store = { ...l, day: { ...l.day, checkIn: Object.fromEntries(l.day.players.map((p) => [p.id, '2026-10-23T09:00:00.000Z'])) } };
  const play = (round: number, index: number, winner: string) => {
    const m = s.day.matches.find((x) => x.round === round && x.index === index)!;
    s = run(run(s, { type: 'match.start', base: 0, matchId: m.id, station: 1 }, ctx('admin')), { type: 'match.finish', base: 0, matchId: m.id, winner }, ctx('admin'));
  };
  play(0, 0, 'p1');
  play(0, 1, 'p2');
  play(1, 0, 'p1');
  return s;
}
const withWinners = (s: Store, winner = { realName: 'Player One', phone: '9820000010' }, runnerUp = { realName: 'Player Two', phone: '9820000020' }) =>
  run(s, { type: 'winners.set', base: 0, winner, runnerUp } as Command, ctx('admin', 'Rhea'));

test('a store with nothing played is not finished', () => {
  assert.deepEqual(storeFinished(fresh(), event()), { finished: false, how: null });
  assert.equal(storeFinished(played(), event()).finished, false, 'final played, no winner details yet');
});

test('automatic: the final has a winner AND the winner details are saved in full', () => {
  const s = withWinners(played());
  const f = storeFinished(s, event());
  assert.equal(f.finished, true);
  assert.equal(f.how, 'auto');
  assert.equal(f.at, s.day.winners!.updatedAt);
});

test('details saved but a real name or phone still missing: not finished by itself', () => {
  const s = withWinners(played(), { realName: 'Player One', phone: '' }, { realName: 'Player Two', phone: '9820000020' });
  assert.equal(storeFinished(s, event()).finished, false);
});

test('winner details that no longer match the bracket (the final was undone) do not count', () => {
  const s = withWinners(played());
  const final = s.day.matches.find((m) => m.round === 1)!;
  const undone = run(s, { type: 'match.undo', base: 0, matchId: final.id }, ctx('admin'));
  assert.equal(storeFinished(undone, event()).finished, false);
});

test('manual: event.finish stamps the time and who; finishing twice keeps the first mark', () => {
  const c = ctx();
  const s = run(fresh(), { type: 'event.finish', base: 0 }, c);
  assert.deepEqual(storeFinished(s, event()), { finished: true, how: 'manual', at: c.now, by: 'HQ' });
  const again = run(s, { type: 'event.finish', base: 0 }, ctx('super', 'Someone else'));
  assert.equal(again, s, 'already marked: the same store back');
  assert.equal(again.finishedBy, 'HQ');
});

test('event.reopen clears the mark; with nothing to clear it is a no-op; an automatic finish is not a mark', () => {
  const marked = run(fresh(), { type: 'event.finish', base: 0 });
  const open = run(marked, { type: 'event.reopen', base: 0 });
  assert.equal(storeFinished(open, event()).finished, false);
  assert.equal('finishedAt' in open || 'finishedBy' in open, false);
  assert.equal(run(open, { type: 'event.reopen', base: 0 }), open);
  const auto = withWinners(played());
  assert.equal(run(auto, { type: 'event.reopen', base: 0 }), auto);
  assert.equal(storeFinished(run(auto, { type: 'event.reopen', base: 0 }), event()).how, 'auto');
  // marked by hand on top of an automatic finish: reopening falls back to the automatic one
  const both = run(auto, { type: 'event.finish', base: 0 });
  assert.equal(storeFinished(both, event()).how, 'manual');
  assert.equal(storeFinished(run(both, { type: 'event.reopen', base: 0 }), event()).how, 'auto');
});

test('event.finish / event.reopen are HQ-only and take only a base', () => {
  for (const type of ['event.finish', 'event.reopen'] as const)
    assert.throws(() => run(fresh(), { type, base: 0 }, ctx('admin', 'Rhea')), (e: unknown) => e instanceof CommandError && e.code === 'forbidden');
  assert.deepEqual(validateCommand({ type: 'event.finish', base: 3 }), { type: 'event.finish', base: 3 });
  assert.throws(() => validateCommand({ type: 'event.reopen' }), (e: unknown) => e instanceof CommandError && e.code === 'invalid');
});

test('the finish fields and the campaign’s closedAt are valid; junk is refused', () => {
  const s = run(fresh(), { type: 'event.finish', base: 0 });
  assert.deepEqual(validateDocument('stores', s, { events: { e1: event() } }), []);
  assert.deepEqual(validateDocument('events', event({ closedAt: '2026-10-25T12:00:00.000Z' })), []);
  assert.match(validateDocument('events', { ...event(), closedAt: 'yesterday' }).join(), /closedAt/);
  assert.match(validateDocument('stores', { ...s, finishedAt: 5 }, { events: { e1: event() } }).join(), /finishedAt/);
});

test('campaign complete: every store finished, or closed by HQ; other campaigns’ stores are ignored', () => {
  const ev = event();
  const a = run(fresh('a'), { type: 'event.finish', base: 0 });
  const b = fresh('b');
  const other = { ...run(fresh('x'), { type: 'event.finish', base: 0 }), eventId: 'e2' } as Store;
  assert.deepEqual(campaignComplete(ev, [a, b, other]), { complete: false, how: null, finished: 1, total: 2 });
  const bDone = withWinners(played('b'));
  const all = campaignComplete(ev, [a, bDone]);
  assert.equal(all.complete, true);
  assert.equal(all.how, 'auto');
  assert.equal(all.finished, 2);
  assert.equal(all.at, [a.finishedAt!, bDone.day.winners!.updatedAt].sort().at(-1), 'the time the last store finished');
  // closed by hand while a store hasn't finished
  const closed = campaignComplete(event({ closedAt: '2026-10-30T09:00:00.000Z' }), [a, b]);
  assert.deepEqual(closed, { complete: true, how: 'manual', at: '2026-10-30T09:00:00.000Z', finished: 1, total: 2 });
  // reopening a store makes an auto-complete campaign incomplete again
  assert.equal(campaignComplete(ev, [run(a, { type: 'event.reopen', base: 0 }), bDone]).complete, false);
});

test('a campaign with no stores is complete only when closed', () => {
  assert.equal(campaignComplete(event(), []).complete, false);
  assert.equal(campaignComplete(event({ closedAt: '2026-10-30T09:00:00.000Z' }), []).complete, true);
});
