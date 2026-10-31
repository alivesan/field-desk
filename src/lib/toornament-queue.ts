/*
 * Toornament result jobs, what HQ sees (docs/toornament-jobs.md, "HQ"): the shape GET /api/toornament/jobs answers with
 * (names and ids only, nothing secret), and the plain words for the to-do page — states, codes, "A beat B", the counts on
 * a store's panel, and the matches a store's setup can't send.
 *
 * Node-loadable: no browser APIs, no node: modules, explicit .ts imports only. The server imports the types only.
 */
import type { Match, Store } from './types.ts';
import { matchNo } from './bracket.ts';
import { blockReasonText, jobsBlockReason, type BlockReason } from './toornament-jobs.ts';

export type QueueState = 'pending' | 'claimed' | 'done' | 'failed' | 'needs-human' | 'cancelled';

/** One line of a job's history as HQ gets it (codes, ids and times only). */
export interface QueueHistoryLine {
  at: string;
  state: QueueState;
  code: string;
  attempt: number;
  workerId?: string;
  by?: string;
}

/** A job as GET /api/toornament/jobs lists it. */
export interface QueueJob {
  id: string;
  storeId: string;
  entityId: string; // the Field Desk match id
  revision: number;
  kind: 'match.result' | 'match.reset';
  state: QueueState;
  attempt: number;
  code: string | null;
  createdAt: string;
  updatedAt: string;
  history: QueueHistoryLine[];
  toornamentLabel: string; // "Match #1.1.2.1"
  participants: [string, string]; // names, side a then side b
  desired: { outcome: 'played' | 'forfeit'; winnerName: string } | null; // null for a reset
}

/* ---------- words ---------- */

export const STATE_TEXT: Record<QueueState, string> = {
  pending: 'waiting',
  claimed: 'working',
  done: 'done',
  failed: 'failed',
  'needs-human': 'needs you',
  cancelled: 'cancelled',
};

export type QueueTone = 'ok' | 'warn' | 'accent' | 'muted';
export const STATE_TONE: Record<QueueState, QueueTone> = { pending: 'muted', claimed: 'accent', done: 'ok', failed: 'warn', 'needs-human': 'warn', cancelled: 'muted' };

/** Jobs HQ can act on. */
export const needsHq = (s: QueueState) => s === 'needs-human' || s === 'failed';

const CODE_TEXT: Record<string, string> = {
  created: 'Waiting for the worker',
  claimed: 'The worker is on it',
  checkpoint: 'The worker was about to save',
  retry: 'The worker will try again',
  VERIFIED: 'Saved on Toornament and read back',
  UNCERTAIN_EFFECT: 'The worker saved but could not confirm it — check Toornament',
  REVIEW_REQUIRED: 'The worker found something it would not decide alone — look on Toornament',
  superseded: 'The bracket was replaced before this was sent',
  'lease-expired': 'The worker stopped answering; it will try again',
  'lease-expired-after-checkpoint': 'The worker stopped while saving — it may or may not have saved. Look on Toornament',
  'too-many-attempts': 'Tried five times without luck',
  'resolved-by-hq': 'Fixed on Toornament by hand',
  'retry-by-hq': 'Sent back to try again',
};

/** A job's code in plain words; a code nobody here knows is shown as it is. */
export const codeText = (code: string | null | undefined): string => (code ? (CODE_TEXT[code] ?? code) : '');

/** "M5 · #1.1.2.1": the desk's match number and Toornament's. Without the match (the bracket was replaced) just Toornament's number. */
export function jobMatchTitle(j: Pick<QueueJob, 'toornamentLabel' | 'entityId'>, matches: Match[] | undefined): string {
  const label = j.toornamentLabel.replace(/^Match\s*/i, '');
  const m = matches?.find((x) => x.id === j.entityId);
  const no = m && matches ? `M${matchNo(m, matches)}` : '';
  return [no, label].filter(Boolean).join(' · ') || 'A match';
}

/** What the job does: "Asha beat Bilal", "Bilal wins by forfeit", "Reset". */
export function jobWhat(j: Pick<QueueJob, 'kind' | 'participants' | 'desired'>): string {
  if (j.kind === 'match.reset' || !j.desired) return 'Reset';
  const { winnerName: w, outcome } = j.desired;
  if (outcome === 'forfeit') return `${w} wins by forfeit`;
  const loser = j.participants[0] === w ? j.participants[1] : j.participants[0];
  return `${w} beat ${loser}`;
}

/** The order on the page: what needs HQ, then what is waiting or working, then the rest; newest first within each. */
export function sortQueue(jobs: QueueJob[]): QueueJob[] {
  const rank = (s: QueueState) => (needsHq(s) ? 0 : s === 'pending' || s === 'claimed' ? 1 : 2);
  return [...jobs].sort((a, b) => rank(a.state) - rank(b.state) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** Jobs of one store, for its panel: waiting (waiting + working), needs you (needs you + failed), done on `today` (a local yyyy-mm-dd). */
export function queueCounts(jobs: QueueJob[], today: string, localDay: (iso: string) => string): { waiting: number; needsYou: number; doneToday: number } {
  let waiting = 0;
  let needsYou = 0;
  let doneToday = 0;
  for (const j of jobs) {
    if (j.state === 'pending' || j.state === 'claimed') waiting++;
    else if (needsHq(j.state)) needsYou++;
    else if (j.state === 'done' && localDay(j.updatedAt) === today) doneToday++;
  }
  return { waiting, needsYou, doneToday };
}

/** "3 waiting · 1 needs you · 5 done today" (only what is not zero; "Nothing sent yet" when all are). */
export function countsLine(c: { waiting: number; needsYou: number; doneToday: number }): string {
  const parts = [c.waiting && `${c.waiting} waiting`, c.needsYou && `${c.needsYou} ${c.needsYou === 1 ? 'needs' : 'need'} you`, c.doneToday && `${c.doneToday} done today`].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nothing sent yet.';
}

/* ---------- matches the queue can't cover ---------- */

export interface Unsendable {
  matchId: string;
  title: string; // "M5 · #1.1.2.1"
  reason: BlockReason;
  text: string;
}

/**
 * With the store's sync on: the matches whose results can't be sent, and why — so HQ knows to enter them by hand. Left out:
 * byes, a match still waiting for its players (not a problem yet), and everything when sync is off.
 */
export function unsendableMatches(store: Store): Unsendable[] {
  const all = store.day.matches;
  const out: Unsendable[] = [];
  for (const m of all) {
    const reason = jobsBlockReason(store, m);
    if (!reason || reason === 'sync-off' || reason === 'bye' || reason === 'not-mapped:no-players') continue;
    const no = `M${matchNo(m, all)}`;
    out.push({ matchId: m.id, title: m.toornament?.label ? `${no} · #${m.toornament.label}` : no, reason, text: blockReasonText(reason) });
  }
  return out;
}
