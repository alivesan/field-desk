import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, CommandError, submissionVersion, type CommandContext } from '../src/lib/commands.ts';
import { submissionCommand, submissionIdFor, submissionState, submissionLabel, submissionsOf, type PendingLike } from '../src/lib/submission.ts';
import { assess } from '../src/lib/assess.ts';
import type { Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

const event = () => fixtureEvent('e1', { games: ['Game A'], gameReadyTarget: 1, minDownMbps: 25 }) as TournamentEvent;
const store = () => fixtureStore('s1', 'e1', 'a1') as unknown as Store;
const ctx = (commandId: string, over: Partial<CommandContext> = {}): CommandContext => ({
  commandId,
  now: '2026-10-23T10:00:00.000Z',
  actor: { principal: 'admin:a1', name: 'Synthetic a1', role: 'admin' },
  event: event(),
  ...over,
});
const hq = (commandId: string, now = '2026-10-23T12:00:00.000Z'): CommandContext => ({ ...ctx(commandId), now, actor: { principal: 'super', name: 'HQ', role: 'super' } });

test('recce.submit appends rev 1, 2… with server time, actor, frozen recce and policy', () => {
  const s0 = store();
  const s1 = applyCommand(s0, { type: 'recce.submit', base: 0 }, ctx('c1'));
  assert.equal(s0.submissions, undefined, 'input store is not mutated');
  assert.equal(s1.submissions!.length, 1);
  const a = s1.submissions![0];
  assert.equal(a.id, submissionIdFor('c1'));
  assert.equal(a.rev, 1);
  assert.equal(a.submittedAt, '2026-10-23T10:00:00.000Z');
  assert.equal(a.by, 'admin:a1');
  assert.equal(a.byName, 'Synthetic a1');
  assert.deepEqual(a.policy, { games: ['Game A'], gameReadyTarget: 1, minDownMbps: 25 });
  assert.equal(a.recce.status, 'submitted');
  assert.equal(s1.recce.status, 'submitted', 'legacy status kept for older readers');
  assert.equal(s1.recce.submittedAt, '2026-10-23T10:00:00.000Z');
  assert.equal(submissionVersion(s1), 1);

  const edited = structuredClone(s1);
  edited.recce.summary = 'changed';
  const s2 = applyCommand(edited, { type: 'recce.submit', base: 1 }, ctx('c2', { now: '2026-10-23T11:00:00.000Z' }));
  assert.equal(s2.submissions![1].rev, 2);
  assert.equal(s2.submissions![1].recce.summary, 'changed');
  assert.equal(s2.submissions![0].recce.summary, '', 'rev 1 unchanged');
});

test('recce.submit with a stale base is a conflict', () => {
  const s1 = applyCommand(store(), { type: 'recce.submit', base: 0 }, ctx('c1'));
  assert.throws(
    () => applyCommand(s1, { type: 'recce.submit', base: 0 }, ctx('c2')),
    (e: unknown) => e instanceof CommandError && e.code === 'conflict',
  );
});

test('recce.submit is deterministic and idempotent for the same command id', () => {
  const a = applyCommand(store(), { type: 'recce.submit', base: 0 }, ctx('same'));
  const b = applyCommand(store(), { type: 'recce.submit', base: 0 }, ctx('same'));
  assert.deepEqual(a, b);
  // Replaying the same command over a state that already contains it (optimistic replay) is a no-op, not a conflict.
  assert.equal(applyCommand(a, { type: 'recce.submit', base: 0 }, ctx('same')), a);
});

test('policy snapshot is frozen against later campaign changes', () => {
  const ev = event();
  const s1 = applyCommand(store(), { type: 'recce.submit', base: 0 }, ctx('c1', { event: ev }));
  ev.games.push('Game B');
  ev.minDownMbps = 500;
  assert.deepEqual(s1.submissions![0].policy, { games: ['Game A'], gameReadyTarget: 1, minDownMbps: 25 });
});

test('recce.review marks only that revision; field admins cannot review', () => {
  let s = applyCommand(store(), { type: 'recce.submit', base: 0 }, ctx('c1'));
  s = applyCommand(s, { type: 'recce.submit', base: 1 }, ctx('c2'));
  const first = s.submissions![0].id;
  assert.throws(() => applyCommand(s, { type: 'recce.review', base: 2, submissionId: first }, ctx('r0')), (e: unknown) => e instanceof CommandError && e.code === 'forbidden');
  const r = applyCommand(s, { type: 'recce.review', base: 2, submissionId: first }, hq('r1'));
  assert.equal(r.submissions![0].reviewedAt, '2026-10-23T12:00:00.000Z');
  assert.equal(r.submissions![0].reviewedBy, 'HQ');
  assert.equal(r.submissions![1].reviewedAt, undefined);
  // reviewing again keeps the first review
  const again = applyCommand(r, { type: 'recce.review', base: 2, submissionId: first }, hq('r2', '2026-10-24T00:00:00.000Z'));
  assert.equal(again.submissions![0].reviewedAt, '2026-10-23T12:00:00.000Z');
  assert.throws(() => submissionCommand(s, { type: 'recce.review', base: 2, submissionId: 'nope' }, hq('r3')), (e: unknown) => e instanceof CommandError && e.code === 'conflict');
});

test('recce.unreview takes one approval back: HQ only, idempotent, the revision itself stays', () => {
  let s = applyCommand(store(), { type: 'recce.submit', base: 0 }, ctx('c1'));
  s = applyCommand(s, { type: 'recce.submit', base: 1 }, ctx('c2'));
  const [first, second] = s.submissions!.map((x) => x.id);
  s = applyCommand(s, { type: 'recce.review', base: 2, submissionId: first }, hq('r1'));
  s = applyCommand(s, { type: 'recce.review', base: 2, submissionId: second }, hq('r2'));
  assert.throws(() => applyCommand(s, { type: 'recce.unreview', base: 2, submissionId: first }, ctx('u0')), (e: unknown) => e instanceof CommandError && e.code === 'forbidden');
  const u = applyCommand(s, { type: 'recce.unreview', base: 2, submissionId: first }, hq('u1'));
  assert.equal(u.submissions![0].reviewedAt, undefined);
  assert.equal('reviewedBy' in u.submissions![0], false);
  assert.equal(u.submissions![0].id, first);
  assert.ok(u.submissions![1].reviewedAt, 'the other revision keeps its approval');
  assert.ok(s.submissions![0].reviewedAt, 'the input store is not mutated');
  // again: nothing to undo, the same store comes back; a revision that isn't there is a conflict
  assert.equal(applyCommand(u, { type: 'recce.unreview', base: 2, submissionId: first }, hq('u2')), u);
  assert.throws(() => applyCommand(s, { type: 'recce.unreview', base: 2, submissionId: 'nope' }, hq('u3')), (e: unknown) => e instanceof CommandError && e.code === 'conflict');
  // approving it again afterwards stamps a fresh time
  const again = applyCommand(u, { type: 'recce.review', base: 2, submissionId: first }, hq('r3', '2026-10-25T00:00:00.000Z'));
  assert.equal(again.submissions![0].reviewedAt, '2026-10-25T00:00:00.000Z');
});

test('UI state: draft → waiting → submitted → edited (draft) → reviewed', () => {
  const s0 = store();
  assert.equal(submissionState(s0, []).kind, 'draft');
  assert.equal(submissionLabel(submissionState(s0, [])), 'Draft');

  // Optimistically applied while the command waits in the outbox.
  const s1 = applyCommand(s0, { type: 'recce.submit', base: 0 }, ctx('w1'));
  const pending: PendingLike[] = [{ id: 'w1', kind: 'cmd', storeId: 's1', cmd: { type: 'recce.submit' }, state: 'queued' }];
  const waiting = submissionState(s1, pending);
  assert.equal(waiting.kind, 'waiting');
  assert.equal(waiting.acknowledged, undefined, 'not acknowledged while pending');

  // A failed command surfaces as failed, never as submitted.
  assert.equal(submissionState(s1, [{ ...pending[0], state: 'failed', error: 'x' }]).kind, 'failed');

  const acked = submissionState(s1, []);
  assert.equal(acked.kind, 'submitted');
  assert.equal(submissionLabel(acked), 'Submitted · rev 1');

  const edited = structuredClone(s1);
  edited.recce.furniture.chairType = 'Gaming';
  const e = submissionState(edited, []);
  assert.equal(e.kind, 'draft');
  assert.equal(e.edited, true);
  assert.equal(submissionLabel(e), 'Edited since rev 1');

  // Bookkeeping-only differences don't count as edits.
  const touched = structuredClone(s1);
  touched.recce.startedAt = '2026-10-22T00:00:00.000Z';
  assert.equal(submissionState(touched, []).kind, 'submitted');

  const reviewed = applyCommand(s1, { type: 'recce.review', base: 1, submissionId: s1.submissions![0].id }, hq('r'));
  assert.equal(submissionState(reviewed, []).kind, 'reviewed');
  assert.equal(submissionLabel(submissionState(reviewed, [])), 'Recce approved ✓');
  const undone = applyCommand(reviewed, { type: 'recce.unreview', base: 1, submissionId: s1.submissions![0].id }, hq('u'));
  assert.equal(submissionState(undone, []).kind, 'submitted');
});

test('legacy submitted store without revisions shows as one legacy submission', () => {
  const s = store();
  s.recce.status = 'submitted';
  s.recce.submittedAt = '2026-10-20T09:00:00.000Z';
  const subs = submissionsOf(s);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].rev, 0);
  assert.equal(submissionState(s, []).kind, 'submitted');
  // and the next real submit is rev 1
  assert.equal(applyCommand(s, { type: 'recce.submit', base: 0 }, ctx('c1')).submissions![0].rev, 1);
});

test('assess uses a revision’s own recce and policy when given', () => {
  const ev = event();
  const s = store();
  s.recce.laptops = [{ id: 'l1', label: 'Laptop 01', role: 'game', games: { 'Game A': true }, launched: { 'Game A': true }, drivers: true, windows: true, notes: '', photos: [{ id: 'p1', label: 'x', takenAt: '2026-10-23T10:00:00.000Z', fileTime: '2026-10-23T10:00:00.000Z', live: true, source: 'camera', geo: null }] }];
  s.recce.network = { wifi: 'yes', lan: 'yes', speed: { down: 30, up: 10, ping: 20, method: 'auto', at: '2026-10-23T10:00:00.000Z' }, photos: [] };
  const sub = applyCommand(s, { type: 'recce.submit', base: 0 }, ctx('c1', { event: ev })).submissions![0];

  ev.games = ['Game A', 'Game B'];
  ev.minDownMbps = 100;
  const now = assess(ev, s);
  assert.ok(now.sections.find((x) => x.key === 'laptops')!.todo.some((t) => t.includes('Game B')), 'current policy needs Game B');
  assert.ok(now.issues.some((i) => i.includes('below the 100 Mbps')));

  const then = assess(ev, s, { recce: sub.recce, policy: sub.policy });
  assert.equal(then.sections.find((x) => x.key === 'laptops')!.done, true, 'as submitted, Game A was all that was required');
  assert.ok(!then.issues.some((i) => i.includes('Mbps minimum')));
  assert.deepEqual(then.policy.games, ['Game A']);

  // recce override: the frozen copy, not the working draft
  const draft = structuredClone(s);
  draft.recce.network.wifi = null;
  assert.equal(assess(ev, draft, { recce: sub.recce, policy: sub.policy }).sections.find((x) => x.key === 'network')!.todo.length, 0);
  assert.ok(assess(ev, draft).sections.find((x) => x.key === 'network')!.todo.includes('Wi-Fi available?'));
});
