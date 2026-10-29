/*
 * HQ's home page, store by store (src/lib/home.ts): the recces still to review, this weekend's events by day,
 * the campaign list. Today is Thu 29 Oct 2026, so this weekend is Sat 31 Oct / Sun 1 Nov and the next one
 * is Sat 7 / Sun 8 Nov. 2026-10-24 is a Saturday.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, type CommandContext } from '../src/lib/commands.ts';
import { homeBuckets, recceState } from '../src/lib/home.ts';
import { dateRange, nextWeekendOf } from '../src/lib/weekends.ts';
import type { Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

const TODAY = '2026-10-29'; // Thursday

const ev = (id: string, date: string, name = id): TournamentEvent => fixtureEvent(id, { date, name }) as TournamentEvent;
const mk = (id: string, eventId: string, over: Record<string, unknown> = {}) => fixtureStore(id, eventId, 'a1', over) as unknown as Store;
let seq = 0;
const run = (s: Store, e: TournamentEvent, cmd: Parameters<typeof applyCommand>[1], role: 'admin' | 'super' = 'super') =>
  applyCommand(s, cmd, {
    commandId: `h${++seq}`,
    now: new Date(Date.UTC(2026, 9, 24, 8, 0, seq)).toISOString(),
    actor: role === 'admin' ? { principal: 'admin:a1', name: 'Rhea', role } : { principal: 'super', name: 'HQ', role },
    event: e,
  } as CommandContext);
const sent = (s: Store, e: TournamentEvent) => run(s, e, { type: 'recce.submit', base: 0 }, 'admin');
const reviewed = (s: Store, e: TournamentEvent) => {
  const x = sent(s, e);
  return run(x, e, { type: 'recce.review', base: 1, submissionId: x.submissions![0].id });
};
const started = (s: Store): Store => ({ ...s, recce: { ...s.recce, summary: 'Wi-Fi is slow near the counter' } });

const state = (events: TournamentEvent[], stores: Store[]) => ({ events: Object.fromEntries(events.map((e) => [e.id, e])), stores: Object.fromEntries(stores.map((s) => [s.id, s])) });
const ids = (rows: { store: Store }[]) => rows.map((r) => r.store.id);

test('the recce state: not started, in progress (something filled in), sent, reviewed', () => {
  const e = ev('e1', '2026-11-07');
  assert.equal(recceState(mk('s1', 'e1')), 'not-started');
  assert.equal(recceState(started(mk('s1', 'e1'))), 'in-progress');
  assert.equal(recceState(sent(mk('s1', 'e1'), e)), 'sent');
  assert.equal(recceState(reviewed(mk('s1', 'e1'), e)), 'reviewed');
});

test('a re-submission after a review is waiting for review again', () => {
  const e = ev('e1', '2026-11-07');
  const r1 = reviewed(mk('s1', 'e1'), e);
  const r2 = run(r1, e, { type: 'recce.submit', base: 1 }, 'admin');
  assert.equal(recceState(r2), 'sent');
});

test('next weekend: the recces still open, grouped by state, and the reviewed ones counted', () => {
  const e = ev('e1', '2026-11-07');
  const stores = [
    mk('a', 'e1', { date: '2026-11-07' }),
    started(mk('b', 'e1', { date: '2026-11-07' })),
    sent(mk('c', 'e1', { date: '2026-11-08' }), e),
    reviewed(mk('d', 'e1', { date: '2026-11-08' }), e),
    reviewed(mk('f', 'e1', { date: '2026-11-07' }), e),
    mk('later', 'e1', { date: '2026-11-14' }), // the weekend after: not shown while next weekend has stores
  ];
  const { recceTodo: t } = homeBuckets(state([e], stores), TODAY);
  assert.deepEqual(t.weekend, { sat: '2026-11-07', sun: '2026-11-08' });
  assert.equal(t.label, 'Sat 7 Nov – Sun 8 Nov');
  assert.equal(t.isNext, true);
  assert.deepEqual(t.groups.map((g) => [g.state, ids(g.rows)]), [['not-started', ['a']], ['in-progress', ['b']], ['sent', ['c']]]);
  assert.equal(t.reviewed, 2);
  assert.equal(t.total, 5);
  assert.equal(t.urgent, 0);
  assert.ok(t.groups.every((g) => g.rows.every((r) => !r.urgent)));
});

test('this weekend’s open recces are listed too, flagged and first', () => {
  const e = ev('e1', '2026-10-31');
  const stores = [
    mk('next', 'e1', { date: '2026-11-07' }),
    mk('sat', 'e1', { date: '2026-10-31' }),
    reviewed(mk('done', 'e1', { date: '2026-10-31' }), e),
    sent(mk('sun', 'e1', { date: '2026-11-01' }), e),
  ];
  const { recceTodo: t } = homeBuckets(state([e], stores), TODAY);
  assert.deepEqual(t.groups.map((g) => [g.state, g.rows.map((r) => `${r.store.id}${r.urgent ? '!' : ''}`)]), [['not-started', ['sat!', 'next']], ['in-progress', []], ['sent', ['sun!']]]);
  assert.equal(t.urgent, 2);
  assert.equal(t.reviewed, 0); // counts the shown (next) weekend only
  assert.equal(t.total, 1);
});

test('a weekday event buckets with its week', () => {
  const e = ev('e1', '2026-11-04');
  const stores = [mk('wed', 'e1', { date: '2026-11-04' }), mk('fri', 'e1', { date: '2026-11-06' }), mk('mon', 'e1', { date: '2026-11-09' })];
  const { recceTodo: t, thisWeekend } = homeBuckets(state([e], stores), TODAY);
  // Wed 4 and Fri 6 Nov are in the week of Sat 7 Nov; Mon 9 Nov is the week after
  assert.equal(t.label, 'Sat 7 Nov – Sun 8 Nov');
  assert.deepEqual(ids(t.groups[0].rows), ['wed', 'fri']);
  assert.equal(thisWeekend.count, 0);
});

test('a nearer weekend with nothing in it is skipped: the nearest upcoming one is shown instead, with its dates', () => {
  const e = ev('e1', '2026-11-14');
  const stores = [mk('x', 'e1', { date: '2026-11-14' }), mk('y', 'e1', { date: '2026-11-21' })];
  const { recceTodo: t } = homeBuckets(state([e], stores), TODAY);
  assert.equal(t.isNext, false);
  assert.equal(t.label, 'Sat 14 Nov – Sun 15 Nov');
  assert.deepEqual(ids(t.groups[0].rows), ['x']);
  assert.equal(t.total, 1);
});

test('no later store at all: no weekend to show', () => {
  const e = ev('e1', '2026-10-31');
  const { recceTodo: t, nextWeekendLabel } = homeBuckets(state([e], [mk('s', 'e1')]), TODAY);
  assert.equal(t.weekend, null);
  assert.equal(t.label, '');
  assert.equal(t.total, 0);
  assert.equal(nextWeekendLabel, '');
  assert.equal(t.groups.flatMap((g) => g.rows).length, 1); // this weekend's own open recce is still there
  assert.equal(t.urgent, 1);
});

test('this weekend: only its stores, by day; a campaign’s other weekends stay out', () => {
  const e = ev('e1', '2026-10-31', 'Clash');
  const e2 = ev('e2', '2026-11-14', 'Later');
  const stores = [
    mk('sun', 'e1', { date: '2026-11-01', city: 'Pune' }),
    mk('sat2', 'e1', { date: '2026-10-31', name: 'B Store' }),
    mk('sat1', 'e1', { date: '2026-10-31', name: 'A Store' }),
    mk('nextwk', 'e1', { date: '2026-11-07' }),
    mk('past', 'e1', { date: '2026-10-24' }),
    mk('l', 'e2'),
  ];
  const { thisWeekend: w } = homeBuckets(state([e, e2], stores), TODAY);
  assert.equal(w.title, 'This weekend');
  assert.equal(w.range, 'Sat 31 Oct – Sun 1 Nov');
  assert.deepEqual(w.days.map((d) => [d.label, ids(d.stores)]), [['Sat 31 Oct', ['sat1', 'sat2']], ['Sun 1 Nov', ['sun']]]);
  assert.equal(w.days[0].stores[0].event.name, 'Clash');
  assert.equal(w.count, 3);
});

test('a weekday event later this week joins the list, and the title says week', () => {
  const e = ev('e1', '2026-10-30');
  const stores = [mk('fri', 'e1', { date: '2026-10-30' }), mk('mon', 'e1', { date: '2026-10-26' }), mk('sat', 'e1', { date: '2026-10-31' })];
  const { thisWeekend: w } = homeBuckets(state([e], stores), TODAY);
  assert.equal(w.title, 'This week');
  assert.deepEqual(w.days.map((d) => d.label), ['Fri 30 Oct', 'Sat 31 Oct']); // Monday already happened
});

test('a weekday with no event this weekend: nothing, and the next weekend is named', () => {
  const e = ev('e1', '2026-11-07');
  const { thisWeekend: w, nextWeekendLabel } = homeBuckets(state([e], [mk('s', 'e1')]), TODAY);
  assert.deepEqual(w.days, []);
  assert.equal(w.count, 0);
  assert.equal(nextWeekendLabel, 'Sat 7 Nov – Sun 8 Nov');
});

test('on Sunday it is still this weekend (Saturday’s stores too); next weekend is the following one', () => {
  const e = ev('e1', '2026-10-31');
  const stores = [mk('sat', 'e1', { date: '2026-10-31' }), mk('sun', 'e1', { date: '2026-11-01' }), mk('n', 'e1', { date: '2026-11-07' })];
  const b = homeBuckets(state([e], stores), '2026-11-01');
  assert.deepEqual(b.thisWeekend.days.map((d) => d.label), ['Sat 31 Oct', 'Sun 1 Nov']);
  assert.equal(b.recceTodo.label, 'Sat 7 Nov – Sun 8 Nov');
  assert.deepEqual(ids(b.recceTodo.groups[0].rows).sort(), ['n', 'sat', 'sun']);
});

test('on Monday after the weekend, that weekend is past and the week’s own weekend is this one', () => {
  const e = ev('e1', '2026-10-31');
  const stores = [mk('sat', 'e1', { date: '2026-10-31' }), mk('n', 'e1', { date: '2026-11-07' })];
  const b = homeBuckets(state([e], stores), '2026-11-02');
  assert.deepEqual(b.thisWeekend.days.map((d) => d.label), ['Sat 7 Nov']);
  assert.equal(b.recceTodo.weekend, null);
});

test('a store without its own date plays on the campaign’s date', () => {
  const e = ev('e1', '2026-10-31');
  const { thisWeekend: w } = homeBuckets(state([e], [mk('s', 'e1')]), TODAY);
  assert.deepEqual(w.days.map((d) => [d.label, ids(d.stores)]), [['Sat 31 Oct', ['s']]]);
});

test('stores of a missing campaign and campaigns without stores are tolerated', () => {
  const e = ev('e1', '2026-11-07');
  const b = homeBuckets(state([e], [mk('orphan', 'gone')]), TODAY);
  assert.equal(b.thisWeekend.count, 0);
  assert.equal(b.recceTodo.total, 0);
  assert.deepEqual(b.campaigns.current.map((c) => [c.event.id, c.stores.length, c.range, c.progress]), [['e1', 0, 'Sat 7 Nov', 0]]);
});

test('campaigns: current and upcoming nearest first, past last, each with its date range and progress', () => {
  const now = ev('now', '2026-10-31', 'Now');
  const far = ev('far', '2026-12-05', 'Far');
  const old = ev('old', '2026-10-10', 'Old');
  const span = ev('span', '2026-10-31', 'Span');
  const stores = [
    mk('1', 'now', { date: '2026-10-31' }),
    mk('2', 'far', { date: '2026-12-05' }),
    mk('3', 'old', { date: '2026-10-10' }),
    mk('4', 'span', { date: '2026-10-31' }),
    mk('5', 'span', { date: '2026-11-14' }),
  ];
  const { campaigns: c } = homeBuckets(state([far, old, span, now], stores), TODAY);
  assert.deepEqual(c.current.map((x) => x.event.id), ['now', 'span', 'far']);
  assert.deepEqual(c.past.map((x) => x.event.id), ['old']);
  assert.equal(c.current[1].range, 'Sat 31 Oct – Sat 14 Nov');
  assert.equal(c.current[0].stores.length, 1);
  assert.ok(c.current.every((x) => x.progress >= 0 && x.progress <= 1));
});

test('weekend helpers: the weekend after, and a span of dates', () => {
  assert.deepEqual(nextWeekendOf('2026-10-29'), { sat: '2026-11-07', sun: '2026-11-08' });
  assert.deepEqual(nextWeekendOf('2026-11-01'), { sat: '2026-11-07', sun: '2026-11-08' }); // a Sunday
  assert.deepEqual(nextWeekendOf('2026-10-31'), { sat: '2026-11-07', sun: '2026-11-08' });
  assert.equal(dateRange(['2026-11-01', '2026-10-31', '2026-10-31']), 'Sat 31 Oct – Sun 1 Nov');
  assert.equal(dateRange(['2026-10-31']), 'Sat 31 Oct');
  assert.equal(dateRange([]), '');
});
