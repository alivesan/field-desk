/*
 * HQ's campaign list: this weekend / upcoming (by weekend) / past. Weeks run Mon–Sun, a weekend is Sat–Sun.
 * 2026-10-24 is a Saturday.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayPlaces, groupByWeekend, groupOfDate, placeDates, shortDay, thisGroupLabel, weekdayOf, weekendLabel, weekendOf, weekStart } from '../src/lib/weekends.ts';

test('weekdays, weeks start on Monday, weekends are Saturday and Sunday', () => {
  assert.equal(weekdayOf('2026-10-24'), 6);
  assert.equal(weekdayOf('2026-10-25'), 0);
  assert.equal(weekStart('2026-10-24'), '2026-10-19'); // Saturday → that week's Monday
  assert.equal(weekStart('2026-10-25'), '2026-10-19'); // Sunday belongs to the week that began on the Monday before
  assert.equal(weekStart('2026-10-26'), '2026-10-26');
  assert.deepEqual(weekendOf('2026-10-21'), { sat: '2026-10-24', sun: '2026-10-25' });
  assert.deepEqual(weekendOf('2026-10-25'), { sat: '2026-10-24', sun: '2026-10-25' });
  assert.deepEqual(weekendOf('2026-10-26'), { sat: '2026-10-31', sun: '2026-11-01' });
});

test('labels read day-first and cross months', () => {
  assert.equal(shortDay('2026-10-31'), 'Sat 31 Oct');
  assert.equal(weekendLabel(weekendOf('2026-10-31')), 'Sat 31 Oct – Sun 1 Nov');
  assert.equal(weekendLabel(weekendOf('2026-12-31')), 'Sat 2 Jan – Sun 3 Jan');
});

test('on a Monday: the coming Saturday and Sunday are this weekend, earlier days are past', () => {
  const today = '2026-10-19';
  assert.equal(groupOfDate('2026-10-24', today), 'this');
  assert.equal(groupOfDate('2026-10-25', today), 'this');
  assert.equal(groupOfDate('2026-10-19', today), 'this'); // a weekday event today
  assert.equal(groupOfDate('2026-10-21', today), 'this'); // a weekday event later this week
  assert.equal(groupOfDate('2026-10-18', today), 'past');
  assert.equal(groupOfDate('2026-10-26', today), 'upcoming');
});

test('on a Saturday or a Sunday the whole weekend is still this weekend', () => {
  assert.equal(groupOfDate('2026-10-24', '2026-10-25'), 'this'); // yesterday's event, same weekend
  assert.equal(groupOfDate('2026-10-23', '2026-10-25'), 'past'); // Friday
  assert.equal(groupOfDate('2026-10-25', '2026-10-24'), 'this');
  assert.equal(groupOfDate('2026-10-26', '2026-10-25'), 'upcoming'); // Monday after
});

test('a weekday event today counts as this weekend’s group, a Friday one is "this week"', () => {
  assert.equal(groupOfDate('2026-10-21', '2026-10-21'), 'this');
  assert.equal(thisGroupLabel(['2026-10-24', '2026-10-25']), 'This weekend');
  assert.equal(thisGroupLabel(['2026-10-21', '2026-10-24']), 'This week');
});

test('a campaign spanning weekends is placed by its next store date', () => {
  const today = '2026-10-24';
  assert.deepEqual(placeDates(['2026-10-17', '2026-10-24'], today), { group: 'this', anchor: '2026-10-24' });
  assert.deepEqual(placeDates(['2026-10-10', '2026-10-31', '2026-11-07'], today), { group: 'upcoming', anchor: '2026-10-31', weekend: { sat: '2026-10-31', sun: '2026-11-01' } });
  assert.deepEqual(placeDates(['2026-10-10', '2026-10-17'], today), { group: 'past', anchor: '2026-10-17' });
  assert.equal(placeDates([], today), null);
});

test('groupByWeekend: this weekend first, upcoming by weekend (nearest first), past most recent first', () => {
  const today = '2026-10-22'; // Thursday
  const c = (id: string, ...dates: string[]) => ({ id, dates });
  const g = groupByWeekend(
    [
      c('old', '2026-09-05'),
      c('older', '2026-08-01', '2026-08-02'),
      c('later', '2026-11-14'),
      c('next-b', '2026-10-31'),
      c('now-b', '2026-10-25'),
      c('next-a', '2026-11-01', '2026-10-31'),
      c('now-a', '2026-10-24'),
      c('span', '2026-10-10', '2026-11-07'),
    ],
    today,
  );
  assert.deepEqual(g.this.map((x) => x.id), ['now-a', 'now-b']);
  assert.deepEqual(g.upcoming.map((b) => [weekendLabel(b.weekend), b.items.map((x) => x.id)]), [
    ['Sat 31 Oct – Sun 1 Nov', ['next-b', 'next-a']],
    ['Sat 7 Nov – Sun 8 Nov', ['span']],
    ['Sat 14 Nov – Sun 15 Nov', ['later']],
  ]);
  assert.deepEqual(g.past.map((x) => x.id), ['old', 'older']);
});

test('groupByWeekend with nothing to group', () => {
  assert.deepEqual(groupByWeekend([], '2026-10-24'), { this: [], upcoming: [], past: [] });
});

test('dayPlaces lists each event day with the cities playing, in date order', () => {
  const days = dayPlaces([
    { date: '2026-10-25', city: 'Pune' },
    { date: '2026-10-24', city: 'Mumbai' },
    { date: '2026-10-24', city: 'mumbai' },
    { date: '2026-10-24', city: 'Thane' },
    { date: '2026-10-25' },
  ]);
  assert.deepEqual(days, [
    { date: '2026-10-24', label: 'Sat 24 Oct', cities: ['Mumbai', 'Thane'], stores: 3 },
    { date: '2026-10-25', label: 'Sun 25 Oct', cities: ['Pune'], stores: 2 },
  ]);
  assert.deepEqual(dayPlaces([]), []);
});
