/*
 * What HQ's home page shows, store by store: the recces still to review (next weekend's stores, plus any
 * of this weekend's that are still open), this weekend's events by day, and the campaign list. Weeks run
 * Monday to Sunday and a weekday event belongs to its week's weekend (weekends.ts). Dates are local
 * yyyy-mm-dd strings and `today` is passed in, so nothing here reads a clock. Pure and Node-loadable.
 */
import type { Store, TournamentEvent } from './types.ts';
import { blankRecce, latestSubmission, sameJson } from './submission.ts';
import { readRecce, storeDate } from './recce.ts';
import { campaignProgress } from './stages.ts';
import { dateRange, groupByWeekend, groupOfDate, nextWeekendOf, shortDay, weekendLabel, weekendOf, type Weekend } from './weekends.ts';

/** Where a store's recce stands for HQ: nothing done, started, sent and waiting for review, or reviewed. */
export type RecceState = 'not-started' | 'in-progress' | 'sent' | 'reviewed';

/** The recce minus the bookkeeping that changes on submit, so a recce nobody touched equals a blank one. */
function touched(store: Store) {
  const r = readRecce(store.recce ?? blankRecce()) as unknown as Record<string, unknown>;
  const blank = blankRecce() as unknown as Record<string, unknown>;
  for (const k of ['status', 'submittedAt', 'startedAt']) delete r[k], delete blank[k];
  return !sameJson(r, blank);
}

/** "Sent" is the latest revision, as in HQ's inbox: a re-submission is waiting for review again. */
export function recceState(store: Store): RecceState {
  const sub = latestSubmission(store);
  if (sub) return sub.reviewedAt ? 'reviewed' : 'sent';
  return touched(store) ? 'in-progress' : 'not-started';
}

export interface HomeStore {
  store: Store;
  event: TournamentEvent;
  /** The store's event day (storeDate). */
  date: string;
}

export type OpenState = Exclude<RecceState, 'reviewed'>;
/** The order the recce list reads in. */
export const OPEN_STATES: OpenState[] = ['not-started', 'in-progress', 'sent'];

export interface RecceRow extends HomeStore {
  state: OpenState;
  /** The event is this weekend (or later this week) and its recce still isn't reviewed. */
  urgent: boolean;
}

export interface RecceTodo {
  /** The weekend being shown; null when no store has a later date. */
  weekend: Weekend | null;
  /** "Sat 7 Nov – Sun 8 Nov" (empty without a weekend). */
  label: string;
  /** True for the weekend right after this one; false when it had no stores and a later one is shown. */
  isNext: boolean;
  /** Not started / in progress / sent — each group lists this weekend's open stores first, then the shown weekend's. */
  groups: { state: OpenState; rows: RecceRow[] }[];
  /** Stores of the shown weekend whose recce is reviewed. */
  reviewed: number;
  /** Stores of the shown weekend. */
  total: number;
  /** Rows of this weekend still open. */
  urgent: number;
}

export interface WeekendDay {
  date: string;
  /** "Sat 31 Oct" */
  label: string;
  stores: HomeStore[];
}

export interface CampaignRow {
  event: TournamentEvent;
  stores: Store[];
  /** "Sat 31 Oct – Sun 1 Nov" */
  range: string;
  /** Steps done across the campaign's stores, 0..1. */
  progress: number;
}

export interface HomeBuckets {
  recceTodo: RecceTodo;
  thisWeekend: {
    /** "This weekend", or "This week" when a weekday event is among them. */
    title: string;
    /** "Sat 31 Oct – Sun 1 Nov" */
    range: string;
    /** Event days from today (or the Saturday) on; empty days are left out. */
    days: WeekendDay[];
    count: number;
  };
  /** The nearest weekend after this one that has a store ("Sat 7 Nov – Sun 8 Nov"), or '' when none. */
  nextWeekendLabel: string;
  campaigns: { current: CampaignRow[]; past: CampaignRow[] };
}

const byDateName = (a: HomeStore, b: HomeStore) => a.date.localeCompare(b.date) || a.store.name.localeCompare(b.store.name);

export function homeBuckets(state: { events: Record<string, TournamentEvent>; stores: Record<string, Store> }, today: string): HomeBuckets {
  const all: HomeStore[] = Object.values(state.stores)
    .filter((s) => state.events[s.eventId])
    .map((store) => ({ store, event: state.events[store.eventId], date: storeDate(store, state.events[store.eventId]) }))
    .filter((x) => !!x.date)
    .sort(byDateName);

  // This weekend: the Sat–Sun of the current week (the Saturday still counts on Sunday), plus what is left of the week.
  const wk = weekendOf(today);
  const now = all.filter((x) => groupOfDate(x.date, today) === 'this');
  const days: WeekendDay[] = [];
  for (const x of now) {
    const day = days.find((d) => d.date === x.date);
    if (day) day.stores.push(x);
    else days.push({ date: x.date, label: shortDay(x.date), stores: [x] });
  }
  const weekdays = now.some((x) => x.date < wk.sat);

  // Recce to do: next weekend's stores, else the nearest later weekend that has any.
  const later = all.filter((x) => x.date > wk.sun);
  const next = nextWeekendOf(today);
  const showNext = later.some((x) => weekendOf(x.date).sat === next.sat);
  const target = showNext ? next : later.length ? weekendOf(later[0].date) : null; // `later` is sorted
  const targetStores = target ? later.filter((x) => weekendOf(x.date).sat === target.sat) : [];
  const open = (list: HomeStore[], urgent: boolean): RecceRow[] =>
    list.flatMap((x) => {
      const st = recceState(x.store);
      return st === 'reviewed' ? [] : [{ ...x, state: st, urgent }];
    });
  const rows = [...open(now, true), ...open(targetStores, false)];

  return {
    recceTodo: {
      weekend: target,
      label: target ? weekendLabel(target) : '',
      isNext: showNext,
      groups: OPEN_STATES.map((s) => ({ state: s, rows: rows.filter((r) => r.state === s) })),
      reviewed: targetStores.filter((x) => recceState(x.store) === 'reviewed').length,
      total: targetStores.length,
      urgent: rows.filter((r) => r.urgent).length,
    },
    thisWeekend: { title: weekdays ? 'This week' : 'This weekend', range: weekendLabel(wk), days, count: now.length },
    nextWeekendLabel: later.length ? weekendLabel(weekendOf(later[0].date)) : '',
    campaigns: campaignRows(state, today),
  };
}

/** Campaigns by where their next store date falls: this weekend and later (nearest first), then past (latest first). */
function campaignRows(state: { events: Record<string, TournamentEvent>; stores: Record<string, Store> }, today: string) {
  const items = Object.values(state.events).sort((a, b) => a.name.localeCompare(b.name)).map((event) => { // by name, so campaigns with the same date keep a steady order
    const stores = Object.values(state.stores).filter((s) => s.eventId === event.id);
    const dates = stores.length ? stores.map((s) => storeDate(s, event)) : [event.date];
    const row: CampaignRow & { dates: string[] } = { event, stores, dates, range: dateRange(dates), progress: campaignProgress(stores).overall };
    return row;
  });
  const g = groupByWeekend(items, today);
  const strip = ({ event, stores, range, progress }: CampaignRow): CampaignRow => ({ event, stores, range, progress });
  return { current: [...g.this, ...g.upcoming.flatMap((w) => w.items)].map(strip), past: g.past.map(strip) };
}
