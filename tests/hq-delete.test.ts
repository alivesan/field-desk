/*
 * HQ deleting test data: onspot.remove (tournament.ts) and recce.delete / recce.reset
 * (submission.ts) as pure handlers — roles, conflicts, what stays and what goes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, CommandError, COMMAND_ROLES, submissionVersion, validateCommand, type CommandContext } from '../src/lib/commands.ts';
import { blankRecce, latestSubmission, submissionIdFor, submissionsOf } from '../src/lib/submission.ts';
import { newRecce } from '../src/lib/db.ts';
import type { OnSpotEntry, Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

const event = () => fixtureEvent('e1', { games: ['Game A'], gameReadyTarget: 1, minDownMbps: 25 }) as TournamentEvent;
const ctx = (commandId: string, role: 'super' | 'admin' = 'super', now = '2026-10-24T12:00:00.000Z'): CommandContext => ({
  commandId,
  now,
  actor: role === 'super' ? { principal: 'super', name: 'HQ', role } : { principal: 'admin:a1', name: 'Synthetic a1', role },
  event: event(),
});
const entry = (name: string, playerId: string, over: Partial<OnSpotEntry> = {}): OnSpotEntry => ({ id: `os-${name.toLowerCase()}`, playerId, name, at: '2026-10-24T09:30:00.000Z', by: 'Priya', ...over });
const forbidden = (e: unknown) => e instanceof CommandError && e.code === 'forbidden';
const conflict = (re?: RegExp) => (e: unknown) => e instanceof CommandError && e.code === 'conflict' && (!re || re.test(e.message));

/** A store with a real player, two walk-ins (both checked in) and no matches. */
function withWalkIns(): Store {
  const s = fixtureStore('s1', 'e1', 'a1') as unknown as Store;
  s.day = {
    ...s.day,
    players: [
      { id: 'real', name: 'Asha R.', seed: 1, phone: '9820011111' },
      { id: 'ravi', name: 'Ravi K.', seed: 2, phone: '9820055555' },
      { id: 'meera', name: 'Meera', seed: 3 },
    ],
    checkIn: { real: '2026-10-24T09:00:00.000Z', ravi: '2026-10-24T09:30:00.000Z', meera: '2026-10-24T09:31:00.000Z' },
    checkInSource: { real: 'self', ravi: 'staff', meera: 'staff' },
    onSpot: [entry('Ravi', 'ravi', { phone: '9820055555' }), entry('Meera', 'meera')],
    version: 4,
  };
  return s;
}

/* ---------- onspot.remove ---------- */

test('onspot.remove: HQ only; the record goes, the players stay by default', () => {
  const s0 = withWalkIns();
  assert.deepEqual(COMMAND_ROLES['onspot.remove'], ['super']);
  assert.throws(() => applyCommand(s0, { type: 'onspot.remove', base: 4, entryIds: ['os-ravi'] }, ctx('c1', 'admin')), forbidden);
  const s1 = applyCommand(s0, { type: 'onspot.remove', base: 4, entryIds: ['os-ravi'] }, ctx('c2'));
  assert.equal(s0.day.onSpot!.length, 2, 'input not mutated');
  assert.deepEqual(s1.day.onSpot!.map((e) => e.name), ['Meera']);
  assert.equal(s1.day.players.length, 3);
  assert.ok(s1.day.checkIn.ravi);
  assert.equal(s1.day.version, 5);
});

test('onspot.remove with several ids is one atomic step; an unknown id changes nothing', () => {
  const s0 = withWalkIns();
  const all = applyCommand(s0, { type: 'onspot.remove', base: 0, entryIds: ['os-ravi', 'os-meera', 'os-ravi'] }, ctx('c3'));
  assert.deepEqual(all.day.onSpot, []);
  assert.equal(all.day.version, 5, 'one version bump for the whole command');
  assert.throws(() => applyCommand(s0, { type: 'onspot.remove', base: 4, entryIds: ['os-ravi', 'os-nope'] }, ctx('c4')), conflict(/1 of these/));
  assert.throws(() => applyCommand(all, { type: 'onspot.remove', base: 5, entryIds: ['os-ravi'] }, ctx('c5')), conflict(/any more/));
});

test('onspot.remove with alsoPlayers takes the matching players (and their check-in) off the list, nobody else', () => {
  const s1 = applyCommand(withWalkIns(), { type: 'onspot.remove', base: 4, entryIds: ['os-ravi', 'os-meera'], alsoPlayers: true }, ctx('c6'));
  assert.deepEqual(s1.day.players.map((p) => p.id), ['real']);
  assert.deepEqual(Object.keys(s1.day.checkIn), ['real']);
  assert.deepEqual(s1.day.checkInSource, { real: 'self' });
  assert.deepEqual(s1.day.onSpot, []);
});

test('onspot.remove alsoPlayers: a bracket with them is cleared; one without stays; matches under way refuse', () => {
  const base = withWalkIns();
  const pending = (a: string, b: string) => ({ id: `m-${a}-${b}`, round: 0, index: 0, a, b, winner: null, status: 'pending' as const });
  const withRavi = { ...base, day: { ...base.day, matches: [pending('real', 'ravi')] } } as Store;
  const cleared = applyCommand(withRavi, { type: 'onspot.remove', base: 4, entryIds: ['os-ravi'], alsoPlayers: true }, ctx('c7'));
  assert.deepEqual(cleared.day.matches, []);
  const elsewhere = applyCommand(withRavi, { type: 'onspot.remove', base: 4, entryIds: ['os-meera'], alsoPlayers: true }, ctx('c8'));
  assert.equal(elsewhere.day.matches.length, 1);
  assert.ok(!elsewhere.day.players.some((p) => p.id === 'meera'));

  const live = { ...withRavi, day: { ...withRavi.day, matches: [{ ...withRavi.day.matches[0], status: 'live' as const, station: 1 }] } } as Store;
  assert.throws(() => applyCommand(live, { type: 'onspot.remove', base: 4, entryIds: ['os-ravi'], alsoPlayers: true }, ctx('c9')), conflict(/under way/));
  // without alsoPlayers the record can still go while matches run
  assert.equal(applyCommand(live, { type: 'onspot.remove', base: 4, entryIds: ['os-ravi'] }, ctx('c10')).day.onSpot!.length, 1);
});

test('onspot.remove / recce.delete: shape check', () => {
  const bad = (cmd: unknown) => assert.throws(() => validateCommand(cmd), (e) => e instanceof CommandError && e.code === 'invalid');
  bad({ type: 'onspot.remove', base: 0 });
  bad({ type: 'onspot.remove', base: 0, entryIds: [] });
  bad({ type: 'onspot.remove', base: 0, entryIds: [3] });
  bad({ type: 'onspot.remove', base: 0, entryIds: ['a'], alsoPlayers: 'yes' });
  bad({ type: 'recce.delete', base: 0 });
  assert.equal(validateCommand({ type: 'onspot.remove', base: 0, entryIds: ['a'], alsoPlayers: true }).type, 'onspot.remove');
  assert.equal(validateCommand({ type: 'recce.reset', base: 0 }).type, 'recce.reset');
});

/* ---------- recce.delete / recce.reset ---------- */

/** Two submitted revisions (the second reviewed), the working recce edited after them. */
function submitted(): Store {
  let s = fixtureStore('s1', 'e1', 'a1') as unknown as Store;
  s.recce.summary = 'Looks fine';
  s = applyCommand(s, { type: 'recce.submit', base: 0 }, ctx('sub-1', 'admin', '2026-10-23T10:00:00.000Z'));
  s = applyCommand(s, { type: 'recce.submit', base: 1 }, ctx('sub-2', 'admin', '2026-10-23T11:00:00.000Z'));
  s = applyCommand(s, { type: 'recce.review', base: 2, submissionId: submissionIdFor('sub-2') }, ctx('rev-2'));
  s.pin = { lat: 1, lng: 2, accuracy: 5 } as never;
  return s;
}

test('blankRecce is the same blank recce the app starts a store with (newRecce in db.ts)', () => {
  assert.deepEqual(blankRecce(), newRecce());
  assert.notEqual(blankRecce(), blankRecce(), 'a new object every time');
});

test('recce.delete: HQ only; drops one revision, the working recce stays, rev numbers never repeat', () => {
  const s0 = submitted();
  assert.deepEqual(COMMAND_ROLES['recce.delete'], ['super']);
  const first = submissionIdFor('sub-1');
  assert.throws(() => applyCommand(s0, { type: 'recce.delete', base: 2, submissionId: first }, ctx('d0', 'admin')), forbidden);
  const s1 = applyCommand(s0, { type: 'recce.delete', base: 0, submissionId: first }, ctx('d1'));
  assert.deepEqual(s1.submissions!.map((x) => x.rev), [2]);
  assert.equal(s1.recce.summary, 'Looks fine');
  assert.equal(s1.recce.status, 'submitted');
  assert.equal(s1.recce.submittedAt, '2026-10-23T11:00:00.000Z');
  assert.equal(s0.submissions!.length, 2, 'input not mutated');
  // a new submission continues after the highest revision left (rev 2 → 3), not at length+1 (= 2)
  const s2 = applyCommand(s1, { type: 'recce.submit', base: submissionVersion(s1) }, ctx('sub-3', 'admin'));
  assert.deepEqual(s2.submissions!.map((x) => x.rev), [2, 3]);
  assert.throws(() => applyCommand(s1, { type: 'recce.delete', base: 1, submissionId: first }, ctx('d2')), conflict());
});

test('recce.delete of the last revision leaves no phantom legacy report behind', () => {
  let s = submitted();
  s = applyCommand(s, { type: 'recce.delete', base: 2, submissionId: submissionIdFor('sub-1') }, ctx('d3'));
  s = applyCommand(s, { type: 'recce.delete', base: 1, submissionId: submissionIdFor('sub-2') }, ctx('d4'));
  assert.deepEqual(s.submissions, []);
  assert.equal(s.recce.status, 'draft');
  assert.equal(s.recce.submittedAt, undefined);
  assert.equal(latestSubmission(s), undefined);
  assert.equal(submissionsOf(s).length, 0);
  assert.equal(s.recce.summary, 'Looks fine', 'the admin’s draft stays');
});

test('recce.reset: HQ only; needs the revisions HQ saw; blanks the recce, the pin and every revision', () => {
  const s0 = submitted();
  assert.deepEqual(COMMAND_ROLES['recce.reset'], ['super']);
  assert.throws(() => applyCommand(s0, { type: 'recce.reset', base: 2 }, ctx('r0', 'admin')), forbidden);
  assert.throws(() => applyCommand(s0, { type: 'recce.reset', base: 1 }, ctx('r1')), conflict(/new revision/));
  const s1 = applyCommand(s0, { type: 'recce.reset', base: 2 }, ctx('r2'));
  assert.deepEqual(s1.submissions, []);
  assert.deepEqual(s1.recce, blankRecce());
  assert.equal(s1.pin, null);
  assert.equal(submissionsOf(s1).length, 0);
  assert.deepEqual(s1.day, s0.day, 'players and bracket are not touched');
  assert.equal(s1.name, s0.name);
  // a store that was never submitted can be reset too (blanks the draft)
  const draft = fixtureStore('s9', 'e1', null) as unknown as Store;
  draft.recce.summary = 'dummy';
  assert.equal(applyCommand(draft, { type: 'recce.reset', base: 0 }, ctx('r3')).recce.summary, '');
});
