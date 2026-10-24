/*
 * The match-day gate. A field admin's match-day part (match day, QR check-in, bracket, queue,
 * venue board) opens once HQ has marked the store's recce reviewed — or, so a forgotten review
 * never blocks a tournament, on the store's event date (and after it). Until then the admin
 * only sees the recce. HQ is never gated.
 *
 *   hq               HQ, always open
 *   reviewed         HQ marked a revision reviewed (stays open if the admin edits the recce afterwards)
 *   event-day        no review, but today is the store's date or later
 *   waiting-review   a recce has been submitted; HQ hasn't checked it yet
 *   not-submitted    no recce submitted yet
 *
 * A recce submitted before revisions existed (the legacy shape) has no review to mark, so it
 * opens on the event date like any other unreviewed one.
 *
 * Pure and Node-loadable: the caller passes today's local date (todayLocal in util.ts).
 */
import type { Store } from './types.ts';
import { storeDate } from './recce.ts';
import { submissionsOf } from './submission.ts';

export type MatchDayReason = 'reviewed' | 'event-day' | 'hq' | 'waiting-review' | 'not-submitted';

export interface MatchDayGate {
  open: boolean;
  reason: MatchDayReason;
}

/** `today` is yyyy-mm-dd on this device. `role` defaults to a field admin; HQ is never gated. */
export function matchDayOpen(store: Store, event: { date: string }, today: string, role: 'super' | 'admin' = 'admin'): MatchDayGate {
  if (role === 'super') return { open: true, reason: 'hq' };
  const subs = submissionsOf(store);
  // Any reviewed revision counts: reviewing an older one stays true after a newer one arrives.
  if (subs.some((s) => !!s.reviewedAt)) return { open: true, reason: 'reviewed' };
  if (today >= storeDate(store, event)) return { open: true, reason: 'event-day' };
  return { open: false, reason: subs.length ? 'waiting-review' : 'not-submitted' };
}
