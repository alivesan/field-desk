/*
 * Which weekend a campaign belongs to, for HQ's campaign list: this weekend, the ones coming, or past.
 * Weeks run Monday to Sunday, a weekend is that week's Saturday and Sunday, dates are local yyyy-mm-dd
 * strings (todayLocal / storeDate), so nothing here reads a clock. Pure and Node-loadable.
 */
import { addDaysLocal } from './util.ts';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Monday of the week (Mon–Sun) this date is in. */
export const weekStart = (date: string) => addDaysLocal(date, -((weekdayOf(date) + 6) % 7));

export interface Weekend {
  /** The Saturday, yyyy-mm-dd. */
  sat: string;
  /** The Sunday. */
  sun: string;
}

/** The Saturday and Sunday of the week (Mon–Sun) this date is in. */
export function weekendOf(date: string): Weekend {
  const sat = addDaysLocal(weekStart(date), 5);
  return { sat, sun: addDaysLocal(sat, 1) };
}

/** The weekend after the one this date is in. */
export const nextWeekendOf = (date: string): Weekend => weekendOf(addDaysLocal(weekendOf(date).sun, 1));

/** "Sat 31 Oct" */
export function shortDay(date: string) {
  const [, m, d] = date.split('-').map(Number);
  return `${DAY[weekdayOf(date)]} ${d} ${MONTH[m - 1]}`;
}

/** "Sat 31 Oct – Sun 1 Nov" */
export const weekendLabel = (w: Weekend) => `${shortDay(w.sat)} – ${shortDay(w.sun)}`;

/** The span of some dates: "Sat 31 Oct", or "Sat 31 Oct – Sat 14 Nov". Empty when there are none. */
export function dateRange(dates: string[]) {
  const sorted = [...new Set(dates)].filter(Boolean).sort();
  if (!sorted.length) return '';
  const [a, b] = [sorted[0], sorted[sorted.length - 1]];
  return a === b ? shortDay(a) : `${shortDay(a)} – ${shortDay(b)}`;
}

export type WeekGroup = 'this' | 'upcoming' | 'past';

/**
 * Where one event day falls. "This" is the current week's weekend (the Saturday still counts on Sunday),
 * today whatever day it is, and what is left of the week after today; "past" is before that; "upcoming" is later.
 */
export function groupOfDate(date: string, today: string): WeekGroup {
  const wk = weekendOf(today);
  if ((date >= wk.sat && date <= wk.sun) || (date >= today && date <= wk.sun)) return 'this';
  return date < today ? 'past' : 'upcoming';
}

export interface Placement {
  group: WeekGroup;
  /** The date it is placed by: the first store date this weekend / coming, else the last one (past). */
  anchor: string;
  /** The weekend it is listed under (upcoming only). */
  weekend?: Weekend;
}

/** A campaign appears once, where its next store date falls — this weekend first, else the nearest later date, else the past. */
export function placeDates(dates: string[], today: string): Placement | null {
  const sorted = [...new Set(dates)].filter(Boolean).sort();
  if (!sorted.length) return null;
  const now = sorted.find((d) => groupOfDate(d, today) === 'this');
  if (now) return { group: 'this', anchor: now };
  const next = sorted.find((d) => d > today);
  if (next) return { group: 'upcoming', anchor: next, weekend: weekendOf(next) };
  return { group: 'past', anchor: sorted[sorted.length - 1] };
}

export interface WeekendBucket<T> {
  weekend: Weekend;
  items: T[];
}
export interface CampaignGroups<T> {
  this: T[];
  /** Later weekends, nearest first. */
  upcoming: WeekendBucket<T>[];
  /** Most recent first. */
  past: T[];
}

/** Sorts items (anything with the dates it plays on) into This weekend / Upcoming by weekend / Past. */
export function groupByWeekend<T extends { dates: string[] }>(items: T[], today: string): CampaignGroups<T> {
  const placed = items.flatMap((item) => {
    const p = placeDates(item.dates, today);
    return p ? [{ item, p }] : [];
  });
  const by = (dir: 1 | -1) => (a: { p: Placement }, b: { p: Placement }) => dir * a.p.anchor.localeCompare(b.p.anchor);
  const out: CampaignGroups<T> = {
    this: placed.filter((x) => x.p.group === 'this').sort(by(1)).map((x) => x.item),
    upcoming: [],
    past: placed.filter((x) => x.p.group === 'past').sort(by(-1)).map((x) => x.item),
  };
  for (const x of placed.filter((y) => y.p.group === 'upcoming').sort(by(1))) {
    const last = out.upcoming[out.upcoming.length - 1];
    if (last && last.weekend.sat === x.p.weekend!.sat) last.items.push(x.item);
    else out.upcoming.push({ weekend: x.p.weekend!, items: [x.item] });
  }
  return out;
}

/** "This weekend", or "This week" when a date in the group falls on a weekday. */
export const thisGroupLabel = (dates: string[]) => (dates.every((d) => [0, 6].includes(weekdayOf(d))) ? 'This weekend' : 'This week');

export interface DayPlaces {
  date: string;
  /** "Sat 24 Oct" */
  label: string;
  /** The distinct cities of the stores playing that day, in order of first appearance. */
  cities: string[];
  stores: number;
}

/** A campaign's event days, each with the cities playing: Sat 24 Oct → Mumbai, Pune. Dates come from storeDate. */
export function dayPlaces(stores: { date: string; city?: string }[]): DayPlaces[] {
  const days = new Map<string, DayPlaces>();
  for (const s of stores) {
    if (!s.date) continue;
    const d = days.get(s.date) ?? { date: s.date, label: shortDay(s.date), cities: [], stores: 0 };
    d.stores++;
    const city = (s.city ?? '').trim();
    if (city && !d.cities.some((c) => c.toLowerCase() === city.toLowerCase())) d.cities.push(city);
    days.set(s.date, d);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
