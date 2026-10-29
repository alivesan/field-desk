/*
 * The status timeline each store row shows (Recce → Approved → Players → Bracket → Live → Winners → Finished)
 * and the date words the home screens use. Pure helpers in src/lib/stages.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, type CommandContext } from '../src/lib/commands.ts';
import { campaignProgress, daysUntil, greeting, isLiveNow, nextEventDate, storeStages, unreviewedReports, whenLabel, winnersMissing } from '../src/lib/stages.ts';
import type { Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

const event = () => fixtureEvent('e1', { date: '2026-10-24' }) as TournamentEvent;
const fresh = (id = 's1') => fixtureStore(id, 'e1', 'a1') as unknown as Store;
let seq = 0;
const ctx = (role: 'admin' | 'super' = 'super'): CommandContext => ({
  commandId: `st${++seq}`,
  now: new Date(Date.UTC(2026, 9, 24, 8, 0, seq)).toISOString(),
  actor: role === 'admin' ? { principal: 'admin:a1', name: 'Rhea', role } : { principal: 'super', name: 'HQ', role },
  event: event(),
});
const run = (s: Store, cmd: Parameters<typeof applyCommand>[1], role: 'admin' | 'super' = 'super') => applyCommand(s, cmd, ctx(role));
const players = [
  { id: 'p1', name: 'Asha R.', seed: 1, phone: '9820011111' },
  { id: 'p2', name: 'Bilal', seed: 2 },
];
const states = (s: Store) => storeStages(s).map((x) => x.state).join(' ');

test('a new store: Recce is next, everything else to do', () => {
  const st = storeStages(fresh());
  assert.deepEqual(st.map((x) => x.label), ['Recce', 'Approved', 'Players', 'Bracket', 'Live', 'Winners', 'Finished']);
  assert.equal(states(fresh()), 'current todo todo todo todo todo todo');
});

test('submitted, reviewed, players, bracket: each step turns done in order', () => {
  let s = run(fresh(), { type: 'recce.submit', base: 0 }, 'admin');
  assert.equal(states(s), 'done current todo todo todo todo todo');
  s = run(s, { type: 'recce.review', base: 1, submissionId: s.submissions![0].id });
  assert.equal(states(s), 'done done current todo todo todo todo');
  s = run(s, { type: 'bracket.load', base: 0, players });
  assert.equal(states(s), 'done done done done current todo todo');
});

test('players can come before the recce: the current step is the first one not done', () => {
  const s = run(fresh(), { type: 'bracket.load', base: 0, players });
  assert.equal(states(s), 'current todo done done todo todo todo');
});

test('live while a match is on a station; done once the final is played; winners after the details are saved', () => {
  let s = run(fresh(), { type: 'recce.submit', base: 0 }, 'admin');
  s = run(s, { type: 'recce.review', base: 1, submissionId: s.submissions![0].id });
  s = run(s, { type: 'bracket.load', base: 0, players });
  s = { ...s, day: { ...s.day, checkIn: { p1: '2026-10-24T07:00:00.000Z', p2: '2026-10-24T07:00:00.000Z' } } };
  assert.equal(isLiveNow(s), false);
  const m = s.day.matches[0];
  s = run(s, { type: 'match.start', base: 0, matchId: m.id, station: 1 }, 'admin');
  assert.equal(isLiveNow(s), true);
  const live = storeStages(s).find((x) => x.key === 'live')!;
  assert.equal(live.state, 'current');
  assert.equal(live.live, true);
  s = run(s, { type: 'match.finish', base: 0, matchId: m.id, winner: 'p2' }, 'admin');
  assert.equal(isLiveNow(s), false);
  assert.equal(storeStages(s).find((x) => x.key === 'live')!.state, 'done');
  assert.equal(storeStages(s).find((x) => x.key === 'winners')!.state, 'current');
  assert.equal(winnersMissing(s), true);
  s = run(s, { type: 'winners.set', base: 0, winner: { realName: 'Bilal Khan', phone: '9820022222' }, runnerUp: { realName: 'Asha Rao', phone: '9820011111' } }, 'admin');
  assert.equal(storeStages(s).find((x) => x.key === 'winners')!.state, 'done');
  assert.equal(winnersMissing(s), false);
  // the winner details complete the event: Finished turns done by itself
  const fin = storeStages(s).find((x) => x.key === 'finished')!;
  assert.equal(fin.state, 'done');
  assert.match(fin.note ?? '', /winner details are saved/);
});

test('Finished: current after Winners, done by HQ’s mark (with who), and reopen takes it back; campaign progress ignores it', () => {
  let s = run(fresh(), { type: 'recce.submit', base: 0 }, 'admin');
  s = run(s, { type: 'recce.review', base: 1, submissionId: s.submissions![0].id });
  assert.equal(storeStages(s).find((x) => x.key === 'reviewed')!.note, 'Recce approved ✓');
  const before = campaignProgress([s]).overall;
  s = run(s, { type: 'event.finish', base: 0 });
  const fin = storeStages(s).find((x) => x.key === 'finished')!;
  assert.equal(fin.state, 'done');
  assert.equal(fin.note, 'Marked finished by HQ');
  assert.equal(campaignProgress([s]).overall, before, 'Finished is not a progress step');
  s = run(s, { type: 'event.reopen', base: 0 });
  assert.equal(storeStages(s).find((x) => x.key === 'finished')!.state, 'todo');
  // undoing the approval turns the Approved step back to a to-do
  s = run(s, { type: 'recce.unreview', base: 1, submissionId: s.submissions![0].id });
  assert.equal(storeStages(s).find((x) => x.key === 'reviewed')!.state, 'current');
});

test('campaign progress counts stores per step; unreviewed reports are the latest revision without a review', () => {
  const a = run(fresh('a'), { type: 'recce.submit', base: 0 }, 'admin');
  const b = run(run(fresh('b'), { type: 'recce.submit', base: 0 }, 'admin'), { type: 'bracket.load', base: 0, players });
  const reviewedB = run(b, { type: 'recce.review', base: 1, submissionId: b.submissions![0].id });
  const c = fresh('c');
  const p = campaignProgress([a, reviewedB, c]);
  assert.deepEqual({ stores: p.stores, recce: p.recce, players: p.players, brackets: p.brackets, winners: p.winners }, { stores: 3, recce: 2, players: 1, brackets: 1, winners: 0 });
  assert.ok(p.overall > 0 && p.overall < 1);
  assert.equal(campaignProgress([]).overall, 0);
  assert.equal(unreviewedReports([a, reviewedB, c]), 1);
});

test('date words: days until, labels, the next event, the greeting', () => {
  assert.equal(daysUntil('2026-10-24', '2026-10-24'), 0);
  assert.equal(daysUntil('2026-10-25', '2026-10-24'), 1);
  assert.equal(daysUntil('2026-11-01', '2026-10-24'), 8);
  assert.equal(daysUntil('2026-10-21', '2026-10-24'), -3);
  assert.equal(daysUntil('2027-01-01', '2026-12-31'), 1); // across a year
  assert.deepEqual([0, 1, 3, -1, -4].map(whenLabel), ['Today', 'Tomorrow', 'In 3 days', 'Yesterday', '4 days ago']);
  assert.deepEqual(nextEventDate(['2026-10-30', '2026-10-24', '2026-10-24'], '2026-10-25'), { date: '2026-10-30', days: 5, past: false });
  assert.deepEqual(nextEventDate(['2026-10-24'], '2026-10-24'), { date: '2026-10-24', days: 0, past: false });
  assert.deepEqual(nextEventDate(['2026-10-01', '2026-10-10'], '2026-10-24'), { date: '2026-10-10', days: -14, past: true });
  assert.equal(nextEventDate([], '2026-10-24'), null);
  assert.deepEqual([3, 9, 12, 16, 17, 23].map(greeting), ['Hello', 'Good morning', 'Good afternoon', 'Good afternoon', 'Good evening', 'Good evening']);
});
