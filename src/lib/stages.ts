/*
 * Where a store stands on its way through a campaign, and the small date words the home screens
 * use ("Tomorrow", "In 3 days", "Good morning"). Pure and Node-loadable: the caller passes today's
 * local date (todayLocal in util.ts) and the hour, so tests don't depend on a clock.
 */
import type { Store } from './types.ts';
import { latestSubmission, submissionsOf } from './submission.ts';
import { storeFinished } from './done.ts';
import { finalResult, winnersState } from './winnerInput.ts';

export type StageKey = 'recce' | 'reviewed' | 'players' | 'bracket' | 'live' | 'winners' | 'finished';
export type StageState = 'done' | 'current' | 'todo';

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
  /** The current step is a tournament that is under way right now. */
  live?: true;
  /** What the dot means in words (a tooltip): how the step was done. */
  note?: string;
}

export const STAGE_LABEL: Record<StageKey, string> = { recce: 'Recce', reviewed: 'Approved', players: 'Players', bracket: 'Bracket', live: 'Live', winners: 'Winners', finished: 'Finished' };
const ORDER: StageKey[] = ['recce', 'reviewed', 'players', 'bracket', 'live', 'winners', 'finished'];
/** The steps that make a campaign's progress: every one but the last, which only says the event is over. */
const PROGRESS: StageKey[] = ORDER.slice(0, -1);

/** Some real (non-bye) match has been called or played. */
const underway = (s: Store) => s.day.matches.some((m) => !m.bye && m.status !== 'pending');
/** A match is on a station right now. */
export const isLiveNow = (s: Store) => s.day.matches.some((m) => !m.bye && m.status === 'live');

/** The seven steps of a store, each done / current (the first one not done, plus Live while a tournament is under way) / todo. */
export function storeStages(store: Store): Stage[] {
  const day = store.day;
  const subs = submissionsOf(store);
  const ws = winnersState(day);
  const fin = storeFinished(store);
  const done: Record<StageKey, boolean> = {
    recce: subs.length > 0,
    reviewed: subs.some((x) => !!x.reviewedAt),
    players: day.players.length > 0,
    bracket: day.matches.length > 0,
    live: !!finalResult(day.matches),
    winners: (ws.kind === 'saved' || ws.kind === 'manual') && !ws.missing,
    finished: fin.finished,
  };
  const current = ORDER.find((k) => !done[k]);
  const going = !done.live && underway(store); // a tournament under way is "live" even if an earlier step (the recce) was never ticked
  return ORDER.map((key) => {
    const stage: Stage = { key, label: STAGE_LABEL[key], state: done[key] ? 'done' : key === current || (key === 'live' && going) ? 'current' : 'todo' };
    if (key === 'live' && going) stage.live = true;
    if (key === 'reviewed' && done.reviewed) stage.note = 'Recce approved ✓';
    if (key === 'finished' && fin.finished) stage.note = fin.how === 'manual' ? `Marked finished by ${fin.by || 'HQ'}` : 'Finished — the final is played and the winner details are saved';
    return stage;
  });
}

/** A final that has been played, but whose winner and runner-up details aren't saved in full. */
export const winnersMissing = (store: Store) => {
  const ws = winnersState(store.day);
  return ws.kind === 'collect' || ws.kind === 'stale' || ((ws.kind === 'saved' || ws.kind === 'manual') && ws.missing);
};

export interface CampaignProgress {
  stores: number;
  recce: number; // stores whose recce is submitted
  players: number; // stores with a player list
  brackets: number; // stores with a bracket
  winners: number; // stores with both winners' details saved
  /** Steps done across the whole campaign, 0..1 (six steps per store; Finished is not counted). */
  overall: number;
}

export function campaignProgress(stores: Store[]): CampaignProgress {
  const count = (key: StageKey) => stores.filter((s) => storeStages(s).find((x) => x.key === key)!.state === 'done').length;
  const steps = stores.reduce((n, s) => n + storeStages(s).filter((x) => x.state === 'done' && PROGRESS.includes(x.key)).length, 0);
  return {
    stores: stores.length,
    recce: count('recce'),
    players: count('players'),
    brackets: count('bracket'),
    winners: count('winners'),
    overall: stores.length ? steps / (stores.length * PROGRESS.length) : 0,
  };
}

/** Recce reports HQ hasn't marked reviewed yet (each store's latest revision). */
export const unreviewedReports = (stores: Store[]) => stores.filter((s) => {
  const sub = latestSubmission(s);
  return !!sub && !sub.reviewedAt;
}).length;

/* ---------- dates ---------- */

const MS_DAY = 864e5;
const asUtc = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Whole calendar days from `today` to `date` (both yyyy-mm-dd): 0 today, 1 tomorrow, negative once past. */
export const daysUntil = (date: string, today: string) => Math.round((asUtc(date) - asUtc(today)) / MS_DAY);

/** "Today", "Tomorrow", "In 3 days", "Yesterday", "5 days ago". */
export function whenLabel(days: number) {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
}

/** The next event day on or after today among these dates, else the most recent one before it. */
export function nextEventDate(dates: string[], today: string): { date: string; days: number; past: boolean } | null {
  const sorted = [...new Set(dates)].sort();
  if (!sorted.length) return null;
  const next = sorted.find((d) => d >= today);
  const date = next ?? sorted[sorted.length - 1];
  return { date, days: daysUntil(date, today), past: !next };
}

export const greeting = (hour: number) => (hour < 5 ? 'Hello' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');
