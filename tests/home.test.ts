/*
 * HQ's home page, store by store (src/lib/home.ts): the recces still to review, this weekend's events by day,
 * the campaign list. Today is Thu 29 Oct 2026, so this weekend is Sat 31 Oct / Sun 1 Nov and the next one
 * is Sat 7 / Sun 8 Nov. 2026-10-24 is a Saturday.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, type CommandContext } from '../src/lib/commands.ts';
import { homeBuckets, homeReports, recceState } from '../src/lib/home.ts';
import { dateRange, groupStoresByWeekend, nextWeekendOf, storeWhen, weekendShort } from '../src/lib/weekends.ts';
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

/* ---------- the reports box, campaigns with their weekends, and the campaign page's grouping ---------- */

/** A report sent at a given moment (the commands stamp their own time, so the stored one is overwritten). */
const sentAt = (s: Store, e: TournamentEvent, at: string): Store => {
  const x = sent(s, e);
  return { ...x, submissions: x.submissions!.map((sub) => ({ ...sub, submittedAt: at })) };
};

test('reports box: unreviewed reports of this weekend and next, newest first; reviewed, later and past ones stay out', () => {
  const e = ev('e1', '2026-10-31');
  const stores = [
    sentAt(mk('old', 'e1', { date: '2026-10-31' }), e, '2026-10-26T08:00:00.000Z'),
    sentAt(mk('new', 'e1', { date: '2026-11-07' }), e, '2026-10-28T08:00:00.000Z'),
    sentAt(mk('sun', 'e1', { date: '2026-11-01' }), e, '2026-10-27T08:00:00.000Z'),
    reviewed(mk('done', 'e1', { date: '2026-10-31' }), e), // reviewed: it is on the campaign page
    sentAt(mk('later', 'e1', { date: '2026-11-14' }), e, '2026-10-28T09:00:00.000Z'), // two weekends away
    sentAt(mk('past', 'e1', { date: '2026-10-24' }), e, '2026-10-20T08:00:00.000Z'), // last weekend, never reviewed
    mk('none', 'e1', { date: '2026-10-31' }), // no report yet
  ];
  assert.deepEqual(ids(homeReports(state([e], stores), TODAY)), ['new', 'sun', 'old']);
});

test('reports box: a weekday event of this or next week counts; reviewing a report takes it out', () => {
  const e = ev('e1', '2026-10-30');
  const wed = sentAt(mk('wed', 'e1', { date: '2026-11-04' }), e, '2026-10-28T08:00:00.000Z');
  const fri = sentAt(mk('fri', 'e1', { date: '2026-10-30' }), e, '2026-10-27T08:00:00.000Z');
  const mon = sentAt(mk('mon', 'e1', { date: '2026-10-26' }), e, '2026-10-26T08:00:00.000Z'); // Monday already happened
  assert.deepEqual(ids(homeReports(state([e], [wed, fri, mon]), TODAY)), ['wed', 'fri']);
  const done = run(fri, e, { type: 'recce.review', base: 1, submissionId: fri.submissions![0].id });
  assert.deepEqual(ids(homeReports(state([e], [wed, done, mon]), TODAY)), ['wed']);
});

test('reports box: a re-submission after a review is back in the box', () => {
  const e = ev('e1', '2026-11-07');
  const r1 = reviewed(mk('s', 'e1', { date: '2026-11-07' }), e);
  assert.equal(homeReports(state([e], [r1]), TODAY).length, 0);
  const r2 = run(r1, e, { type: 'recce.submit', base: 1 }, 'admin');
  assert.deepEqual(ids(homeReports(state([e], [r2]), TODAY)), ['s']);
});

test('reports box: Sunday still shows the weekend; the Monday after, its unreviewed reports are gone and next weekend’s remain', () => {
  const e = ev('e1', '2026-10-31');
  const stores = [
    sentAt(mk('sat', 'e1', { date: '2026-10-31' }), e, '2026-10-27T08:00:00.000Z'),
    sentAt(mk('n', 'e1', { date: '2026-11-07' }), e, '2026-10-28T08:00:00.000Z'),
    sentAt(mk('nn', 'e1', { date: '2026-11-14' }), e, '2026-10-28T08:00:00.000Z'),
  ];
  assert.deepEqual(ids(homeReports(state([e], stores), '2026-11-01')).sort(), ['n', 'sat']);
  assert.deepEqual(ids(homeReports(state([e], stores), '2026-11-02')).sort(), ['n', 'nn']); // Mon 2 Nov: Sat 7 is this weekend, Sat 14 next
});

test('reports box: stores of a missing campaign are tolerated', () => {
  assert.deepEqual(homeReports(state([], [mk('x', 'gone')]), TODAY), []);
});

test('a campaign lists this and next weekend, with the stores in each; played and later stores are counted, not listed', () => {
  const e = ev('e1', '2026-10-31', 'Clash');
  const stores = [
    mk('past', 'e1', { date: '2026-10-24' }),
    mk('sat', 'e1', { date: '2026-10-31', name: 'B Store' }),
    mk('sun', 'e1', { date: '2026-11-01', name: 'A Store' }),
    mk('next', 'e1', { date: '2026-11-07' }),
    mk('wed', 'e1', { date: '2026-11-11' }), // a weekday belongs to its week's weekend, Sat 14
    mk('far', 'e1', { date: '2026-11-21' }),
  ];
  const [c] = homeBuckets(state([e], stores), TODAY).campaigns.current;
  assert.deepEqual(c.weekends.map((w) => [w.when, w.title, w.label, w.stores.map((s) => s.id)]), [
    ['this', 'This weekend', 'Sat 31 Oct – Sun 1 Nov', ['sat', 'sun']],
    ['next', 'Next weekend', 'Sat 7 – Sun 8 Nov', ['next']],
  ]);
  assert.equal(c.done, 1);
  assert.equal(c.later, 2); // the weekends after next are counted, not listed
});

test('a campaign whose stores are all finished is past, even with dates ahead; one with a store left stays current', () => {
  const e = ev('e1', '2026-11-07', 'Done');
  const e2 = ev('e2', '2026-11-07', 'Open');
  const closed = { ...ev('e3', '2026-11-14', 'Closed'), closedAt: '2026-10-28T10:00:00.000Z' };
  const fin = (s: Store): Store => ({ ...s, finishedAt: '2026-10-28T10:00:00.000Z' });
  const stores = [fin(mk('a', 'e1', { date: '2026-11-07' })), fin(mk('b', 'e2', { date: '2026-11-07' })), mk('c', 'e2', { date: '2026-11-07' }), mk('d', 'e3', { date: '2026-11-14' })];
  const { campaigns: c } = homeBuckets(state([e, e2, closed], stores), TODAY);
  assert.deepEqual(c.current.map((x) => x.event.id), ['e2']);
  assert.deepEqual(c.past.map((x) => x.event.id).sort(), ['e1', 'e3']);
  assert.deepEqual(c.current[0].weekends[0].stores.map((s) => s.id), ['c']); // the finished store is out of the list …
  assert.equal(c.current[0].done, 1); // … and counted
});

test('store grouping for the campaign page: this weekend, next weekend, later by weekend, done', () => {
  const at = (date: string) => ({ date, id: date });
  const items = [at('2026-10-24'), at('2026-10-30'), at('2026-10-31'), at('2026-11-01'), at('2026-11-06'), at('2026-11-08'), at('2026-11-13'), at('2026-11-14'), at('2026-11-28')];
  const g = groupStoresByWeekend(items, TODAY);
  assert.deepEqual(g.done.map((x) => x.id), ['2026-10-24']);
  assert.deepEqual(g.this.map((x) => x.id), ['2026-10-30', '2026-10-31', '2026-11-01']); // Fri, Sat, Sun
  assert.deepEqual(g.next.map((x) => x.id), ['2026-11-06', '2026-11-08']);
  assert.deepEqual(g.later.map((w) => [weekendShort(w.weekend), w.items.map((x) => x.id)]), [['Sat 14 – Sun 15 Nov', ['2026-11-13', '2026-11-14']], ['Sat 28 – Sun 29 Nov', ['2026-11-28']]]);
});

test('store grouping: a finished store is done whatever its date; weekend labels across a month end', () => {
  const items = [{ date: '2026-10-31', id: 'fin' }, { date: '2026-10-31', id: 'open' }];
  const g = groupStoresByWeekend(items, TODAY, (x) => x.id === 'fin');
  assert.deepEqual([g.this.map((x) => x.id), g.done.map((x) => x.id)], [['open'], ['fin']]);
  assert.equal(weekendShort({ sat: '2026-10-31', sun: '2026-11-01' }), 'Sat 31 Oct – Sun 1 Nov');
  assert.equal(weekendShort({ sat: '2026-11-07', sun: '2026-11-08' }), 'Sat 7 – Sun 8 Nov');
});

test('Mon 2 Nov 2026: Home and the campaign page agree — last weekend is done, Sat 7 is this weekend, Sat 14 is next', () => {
  const MON = '2026-11-02';
  const e = ev('e1', '2026-10-31', 'Clash');
  const stores = [mk('last', 'e1', { date: '2026-10-31' }), mk('sat7', 'e1', { date: '2026-11-07' }), mk('sun8', 'e1', { date: '2026-11-08' }), mk('sat14', 'e1', { date: '2026-11-14' }), mk('sat21', 'e1', { date: '2026-11-21' })];
  const dated = stores.map((s) => ({ s, date: s.date! }));
  const page = groupStoresByWeekend(dated, MON);
  const home = homeBuckets(state([e], stores), MON);
  assert.deepEqual(page.done.map((x) => x.s.id), ['last']);
  assert.deepEqual(page.this.map((x) => x.s.id), ['sat7', 'sun8']);
  assert.deepEqual(page.next.map((x) => x.s.id), ['sat14']);
  assert.deepEqual(page.later.map((w) => w.items.map((x) => x.s.id)), [['sat21']]);
  // Home's This weekend strip and the campaign row list the same stores, and the Recce to do weekend is the one after
  assert.deepEqual(home.thisWeekend.days.flatMap((d) => ids(d.stores)), ['sat7', 'sun8']);
  assert.deepEqual(home.campaigns.current[0].weekends.map((w) => [w.when, w.stores.map((s) => s.id)]), [['this', ['sat7', 'sun8']], ['next', ['sat14']]]);
  assert.equal(home.campaigns.current[0].done, 1);
  assert.equal(home.campaigns.current[0].later, 1);
  assert.equal(home.recceTodo.label, 'Sat 14 Nov – Sun 15 Nov');
  assert.equal(storeWhen('2026-10-31', MON), 'past');
  assert.equal(storeWhen('2026-11-07', '2026-11-01'), 'next'); // the day before, Sunday: still next
});
