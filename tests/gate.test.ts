import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, type CommandContext } from '../src/lib/commands.ts';
import { matchDayOpen } from '../src/lib/gate.ts';
import type { Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

const event = () => fixtureEvent('e1', { date: '2026-10-24' }) as TournamentEvent;
const store = (over: Record<string, unknown> = {}) => fixtureStore('s1', 'e1', 'a1', over) as unknown as Store;
const ctx = (commandId: string, role: 'admin' | 'super' = 'admin'): CommandContext => ({
  commandId,
  now: '2026-10-20T10:00:00.000Z',
  actor: role === 'admin' ? { principal: 'admin:a1', name: 'Synthetic a1', role } : { principal: 'super', name: 'HQ', role },
  event: event(),
});
const submitted = () => applyCommand(store(), { type: 'recce.submit', base: 0 }, ctx('c1'));
const reviewed = () => {
  const s = submitted();
  return applyCommand(s, { type: 'recce.review', base: 1, submissionId: s.submissions![0].id }, ctx('c2', 'super'));
};

test('no recce yet: closed, not-submitted', () => {
  assert.deepEqual(matchDayOpen(store(), event(), '2026-10-20'), { open: false, reason: 'not-submitted' });
});

test('a draft with edits but no submission is still not-submitted', () => {
  const s = store();
  s.recce.summary = 'half way';
  assert.deepEqual(matchDayOpen(s, event(), '2026-10-20'), { open: false, reason: 'not-submitted' });
});

test('submitted, not reviewed: closed, waiting-review', () => {
  assert.deepEqual(matchDayOpen(submitted(), event(), '2026-10-23'), { open: false, reason: 'waiting-review' });
});

test('reviewed: open', () => {
  assert.deepEqual(matchDayOpen(reviewed(), event(), '2026-10-20'), { open: true, reason: 'reviewed' });
});

test('edited after review: stays open', () => {
  const s = reviewed();
  s.recce.summary = 'changed after review';
  assert.deepEqual(matchDayOpen(s, event(), '2026-10-20'), { open: true, reason: 'reviewed' });
});

test('an older revision reviewed, a newer one submitted since: still open', () => {
  const s = reviewed();
  s.recce.summary = 'rev 2';
  const s2 = applyCommand(s, { type: 'recce.submit', base: 1 }, ctx('c3'));
  assert.equal(s2.submissions!.length, 2);
  assert.deepEqual(matchDayOpen(s2, event(), '2026-10-20'), { open: true, reason: 'reviewed' });
});

test('event day opens it without a review, whether submitted or not', () => {
  assert.deepEqual(matchDayOpen(store(), event(), '2026-10-24'), { open: true, reason: 'event-day' });
  assert.deepEqual(matchDayOpen(submitted(), event(), '2026-10-24'), { open: true, reason: 'event-day' });
});

test('the day before is still closed; after the event date it stays open', () => {
  assert.equal(matchDayOpen(submitted(), event(), '2026-10-23').open, false);
  assert.deepEqual(matchDayOpen(submitted(), event(), '2026-10-25'), { open: true, reason: 'event-day' });
});

test('reviewed beats event-day as the reason', () => {
  assert.equal(matchDayOpen(reviewed(), event(), '2026-10-24').reason, 'reviewed');
});

test("the store's own date wins over the campaign's", () => {
  const s = store({ date: '2026-10-30' });
  assert.equal(matchDayOpen(s, event(), '2026-10-24').open, false);
  assert.equal(matchDayOpen(s, event(), '2026-10-30').open, true);
});

test('legacy submitted recce (no revisions) has nothing to review: waiting, then the event day opens it', () => {
  const s = store();
  s.recce.status = 'submitted';
  s.recce.submittedAt = '2026-10-18T10:00:00.000Z';
  assert.deepEqual(matchDayOpen(s, event(), '2026-10-20'), { open: false, reason: 'waiting-review' });
  assert.deepEqual(matchDayOpen(s, event(), '2026-10-24'), { open: true, reason: 'event-day' });
});

test('HQ is never gated', () => {
  assert.deepEqual(matchDayOpen(store(), event(), '2026-10-01', 'super'), { open: true, reason: 'hq' });
});

test('after HQ deletes the only reviewed revision the gate closes again', () => {
  const s = reviewed();
  const gone = applyCommand(s, { type: 'recce.delete', base: 1, submissionId: s.submissions![0].id }, ctx('c4', 'super'));
  assert.deepEqual(matchDayOpen(gone, event(), '2026-10-20'), { open: false, reason: 'not-submitted' });
});

test('recce.unreview re-locks the gate before the event date, unless another revision is still approved; the event date opens it anyway', () => {
  const s = reviewed();
  const id = s.submissions![0].id;
  const undone = applyCommand(s, { type: 'recce.unreview', base: 1, submissionId: id }, ctx('c5', 'super'));
  assert.deepEqual(matchDayOpen(undone, event(), '2026-10-20'), { open: false, reason: 'waiting-review' });
  assert.deepEqual(matchDayOpen(undone, event(), '2026-10-24'), { open: true, reason: 'event-day' });
  assert.equal(matchDayOpen(undone, event(), '2026-10-20', 'super').open, true, 'HQ is never gated');
  // a second revision, the first still approved: undoing the second changes nothing
  const two = applyCommand(s, { type: 'recce.submit', base: 1 }, ctx('c6'));
  const both = applyCommand(two, { type: 'recce.review', base: 2, submissionId: two.submissions![1].id }, ctx('c7', 'super'));
  const one = applyCommand(both, { type: 'recce.unreview', base: 2, submissionId: two.submissions![1].id }, ctx('c8', 'super'));
  assert.deepEqual(matchDayOpen(one, event(), '2026-10-20'), { open: true, reason: 'reviewed' });
  // …but taking back the only approved one closes it again
  const none = applyCommand(one, { type: 'recce.unreview', base: 2, submissionId: id }, ctx('c9', 'super'));
  assert.equal(matchDayOpen(none, event(), '2026-10-20').open, false);
});
