/*
 * What HQ's home page shows, store by store: the campaigns with their weekends, the recces still to review
 * (next weekend's stores, plus any of this weekend's that are still open), this weekend's events by day and
 * the recce reports worth a look now. Weeks run
 * Monday to Sunday and a weekday event belongs to its week's weekend (weekends.ts). Dates are local
 * yyyy-mm-dd strings and `today` is passed in, so nothing here reads a clock. Pure and Node-loadable.
 */
import type { Store, TournamentEvent } from './types.ts';
import { blankRecce, latestSubmission, sameJson, type AnySubmission } from './submission.ts';
import { readRecce, storeDate } from './recce.ts';
import { campaignProgress } from './stages.ts';
import { campaignComplete, storeFinished } from './done.ts';
import { dateRange, groupByWeekend, groupOfDate, groupStoresByWeekend, nextWeekendOf, shortDay, storeWhen, thisGroupLabel, weekendLabel, weekendOf, weekendShort, type Weekend } from './weekends.ts';

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

/** One weekend of a campaign, with the stores playing in it. */
export interface CampaignWeekend {
  when: 'this' | 'next' | 'later';
  /** "This weekend" (or "This week"), "Next weekend", or "Later". */
  title: string;
  /** "Sat 7 – Sun 8 Nov" */
  label: string;
  stores: Store[];
}

export interface CampaignRow {
  event: TournamentEvent;
  stores: Store[];
  /** "Sat 31 Oct – Sun 1 Nov" */
  range: string;
  /** Steps done across the campaign's stores, 0..1. */
  progress: number;
  /** The weekends still to play, this one first; finished and past stores are left out (see `done`). */
  weekends: CampaignWeekend[];
  /** Stores already played or finished. */
  done: number;
}

/** A recce report waiting for HQ: the store's latest revision, not reviewed yet. */
export interface ReportRow extends HomeStore {
  sub: AnySubmission;
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

/**
 * The recce reports HQ's home shows: a store's latest revision, not reviewed, for a store whose event day is this weekend
 * (or what is left of this week) or next weekend — newest first. Reviewing one removes it; a weekend that is over drops off
 * on the Monday. Everything else is on the campaign page and the store's report page.
 */
export function homeReports(state: { events: Record<string, TournamentEvent>; stores: Record<string, Store> }, today: string): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const store of Object.values(state.stores)) {
    const event = state.events[store.eventId];
    const sub = event && latestSubmission(store);
    if (!event || !sub || sub.reviewedAt) continue;
    const date = storeDate(store, event);
    if (!date || !['this', 'next'].includes(storeWhen(date, today))) continue;
    rows.push({ store, event, date, sub });
  }
  return rows.sort((a, b) => b.sub.submittedAt.localeCompare(a.sub.submittedAt) || a.store.name.localeCompare(b.store.name));
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

/**
 * Campaigns by where their next store date falls: this weekend and later (nearest first), then past — complete or all dates over
 * (latest first). A current campaign lists its weekends still to play, with the stores in each.
 */
function campaignRows(state: { events: Record<string, TournamentEvent>; stores: Record<string, Store> }, today: string) {
  const items = Object.values(state.events).sort((a, b) => a.name.localeCompare(b.name)).map((event) => { // by name, so campaigns with the same date keep a steady order
    const stores = Object.values(state.stores).filter((s) => s.eventId === event.id);
    const dated = stores.map((store) => ({ store, date: storeDate(store, event) })).sort((a, b) => a.date.localeCompare(b.date) || a.store.name.localeCompare(b.store.name));
    const dates = dated.length ? dated.map((x) => x.date) : [event.date];
    const g = groupStoresByWeekend(dated, today, (x) => storeFinished(x.store, event).finished);
    const weekends: CampaignWeekend[] = [
      ...(g.this.length ? [{ when: 'this' as const, title: thisGroupLabel(g.this.map((x) => x.date)), label: weekendShort(weekendOf(g.this[0].date)), stores: g.this.map((x) => x.store) }] : []),
      ...(g.next.length ? [{ when: 'next' as const, title: 'Next weekend', label: weekendShort(weekendOf(g.next[0].date)), stores: g.next.map((x) => x.store) }] : []),
      ...g.later.map((w) => ({ when: 'later' as const, title: 'Later', label: weekendShort(w.weekend), stores: w.items.map((x) => x.store) })),
    ];
    const row: CampaignRow & { dates: string[]; complete: boolean } = {
      event, stores, dates, range: dateRange(dates), progress: campaignProgress(stores).overall, weekends, done: g.done.length,
      complete: campaignComplete(event, stores).complete || dates.every((d) => groupOfDate(d, today) === 'past'), // finished or closed by hand, or every date is over
    };
    return row;
  });
  const strip = ({ event, stores, range, progress, weekends, done }: CampaignRow): CampaignRow => ({ event, stores, range, progress, weekends, done });
  const g = groupByWeekend(items.filter((c) => !c.complete), today);
  const past = items.filter((c) => c.complete).sort((a, b) => b.dates.slice().sort().at(-1)!.localeCompare(a.dates.slice().sort().at(-1)!));
  return { current: [...g.this, ...g.upcoming.flatMap((w) => w.items)].map(strip), past: past.map(strip) };
}
