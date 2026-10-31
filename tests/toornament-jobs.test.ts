/*
 * Toornament result jobs, the pure half (src/lib/toornament-jobs.ts): when a command makes a job, what is in it, and why
 * a match can't have one. Plus Player.toornamentId through planImport / bracket.load / players.set / the schema.
 * Synthetic data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyCommand, type Command, type CommandContext } from '../src/lib/commands.ts';
import { blockReasonText, buildToornamentJob, jobMatchId, jobsBlockReason, type BuildInput, type ToornamentJobDraft } from '../src/lib/toornament-jobs.ts';
import { bracketFromNodes, planImport, readParticipants, readStages, pickStage } from '../src/lib/toornament.ts';
import { validateDocument } from '../src/lib/schema.ts';
import type { Player, Store } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

const event = fixtureEvent('e1') as any;
const ctx = (commandId = 'cmd-00001', role: 'super' | 'admin' = 'super'): CommandContext => ({ commandId, now: '2026-10-24T10:00:00.000Z', actor: { principal: role, name: role, role }, event });
const run = (store: Store, cmd: Command, commandId = 'cmd-00001') => applyCommand(structuredClone(store), cmd, ctx(commandId));

const URL_ = 'https://play.toornament.com/en_US/tournaments/111/stages/222/';
const players: Player[] = [
  { id: 'p1', name: 'Asha', seed: 1, toornamentId: '1001' },
  { id: 'p2', name: 'Bilal', seed: 2, toornamentId: '1002' },
  { id: 'p3', name: 'Chen', seed: 3, toornamentId: '1003' },
  { id: 'p4', name: 'Dev', seed: 4, toornamentId: '1004' },
];
const nodes = [
  { round: 0, index: 0, id: '333', label: '1.1.1.1' },
  { round: 0, index: 1, id: '334', label: '1.1.1.2' },
  { round: 1, index: 0, id: '335', label: '1.1.2.1' },
];

/** A store with a four-player bracket loaded from "Toornament" (loadId = the load's command id), everyone checked in, sync on. */
function ready(over: { sync?: boolean; players?: Player[]; toornament?: boolean } = {}): Store {
  let store = fixtureStore('s1', 'e1', null) as unknown as Store;
  store.toornament = { url: URL_, stageId: '222', stageName: 'Playoffs', tournamentName: 'Test Cup', ...(over.sync === false ? {} : { sync: { on: true } }) };
  store = run(store, { type: 'bracket.load', base: 0, players: over.players ?? players, ...(over.toornament === false ? {} : { toornament: nodes }) }, 'load-1');
  store.toornament!.loadId = 'load-1';
  const at = '2026-10-24T09:00:00.000Z';
  store.day.checkIn = Object.fromEntries(store.day.players.map((p) => [p.id, at]));
  return store;
}
const m0 = 'load-1-0-0';
const start = (s: Store, id = m0) => run(s, { type: 'match.start', base: 0, matchId: id, station: 1 });
const finish = (s: Store, winner: string, extra: Partial<Extract<Command, { type: 'match.finish' }>> = {}, id = m0) => run(s, { type: 'match.finish', base: 0, matchId: id, winner, ...extra }, 'fin-0001');
const input = (before: Store, after: Store, cmd: Command, over: Partial<BuildInput> = {}): BuildInput => ({ before, after, cmd, commandId: 'cmd-job-1', now: '2026-10-24T10:05:00.000Z', lastRevision: 0, last: null, ...over });

function played() {
  const live = start(ready());
  const cmd: Command = { type: 'match.finish', base: 0, matchId: m0, winner: 'p1' };
  const done = run(live, cmd, 'fin-0001');
  return { live, cmd, done };
}

test('finish → match.result: the contract’s fields, W/L only, no scores', () => {
  const { live, done, cmd } = played();
  const r = buildToornamentJob(input(live, done, cmd));
  assert.ok(r.job, r.reason);
  assert.deepEqual(r.job, {
    schemaVersion: 1,
    origin: 'field-desk',
    sourceCommandId: 'cmd-job-1',
    createdAt: '2026-10-24T10:05:00.000Z',
    storeId: 's1',
    entityId: m0,
    bracketGenerationId: 'load-1',
    revision: 1,
    expectedPreviousRevision: 0,
    kind: 'match.result',
    tournamentId: '111',
    stageId: '222',
    expectedTournamentName: 'Test Cup',
    expectedStageName: 'Playoffs',
    matchId: '333',
    publicNodeId: '333',
    mappingVerified: true,
    toornamentLabel: 'Match #1.1.1.1',
    participants: [
      { id: '1001', name: 'Asha' },
      { id: '1004', name: 'Dev' },
    ],
    expectedPrevious: {
      status: 'pending',
      sides: [
        { id: '1001', score: null, result: null, forfeit: false },
        { id: '1004', score: null, result: null, forfeit: false },
      ],
    },
    desired: { outcome: 'played', winnerId: '1001' },
  });
  assert.ok(!('scores' in r.job.desired!));
});

test('the winner is the second side: winnerId follows the player, participants stay in side order', () => {
  const live = start(ready());
  const cmd: Command = { type: 'match.finish', base: 0, matchId: m0, winner: 'p4' };
  const r = buildToornamentJob(input(live, run(live, cmd, 'fin-0001'), cmd));
  assert.deepEqual(r.job!.participants.map((p) => p.id), ['1001', '1004']);
  assert.equal(r.job!.desired!.winnerId, '1004');
});

test('walkover → forfeit, the loser forfeiting', () => {
  const store = ready();
  store.day.checkIn = { p1: '2026-10-24T09:00:00.000Z' }; // only Asha came
  const cmd: Command = { type: 'match.finish', base: 0, matchId: m0, winner: 'p1', walkover: true };
  const after = run(store, cmd, 'fin-0001');
  const r = buildToornamentJob(input(store, after, cmd));
  assert.deepEqual(r.job!.desired, { outcome: 'forfeit', winnerId: '1001', forfeitingParticipantId: '1004' });
});

test('undo → match.reset with no desired, expectedPrevious = the result sent', () => {
  const { done, cmd, live } = played();
  const sent = buildToornamentJob(input(live, done, cmd)).job!;
  const undone = run(done, { type: 'match.undo', base: 0, matchId: m0 }, 'undo-001');
  const r = buildToornamentJob(input(done, undone, { type: 'match.undo', base: 0, matchId: m0 }, { lastRevision: 1, last: sent }));
  assert.ok(r.job, r.reason);
  assert.equal(r.job.kind, 'match.reset');
  assert.ok(!('desired' in r.job));
  assert.equal(r.job.revision, 2);
  assert.equal(r.job.expectedPreviousRevision, 1);
  assert.deepEqual(r.job.expectedPrevious, {
    status: 'completed',
    sides: [
      { id: '1001', score: null, result: 'win', forfeit: false },
      { id: '1004', score: null, result: 'loss', forfeit: false },
    ],
  });
});

test('expectedPrevious after a forfeit marks the forfeiting side; after a reset the match is pending again', () => {
  const store = ready();
  store.day.checkIn = { p1: '2026-10-24T09:00:00.000Z' };
  const walk: Command = { type: 'match.finish', base: 0, matchId: m0, winner: 'p1', walkover: true };
  const done = run(store, walk, 'fin-0001');
  const sent = buildToornamentJob(input(store, done, walk)).job!;
  const undo: Command = { type: 'match.undo', base: 0, matchId: m0 };
  const reset = buildToornamentJob(input(done, run(done, undo, 'undo-001'), undo, { lastRevision: 1, last: sent })).job!;
  assert.deepEqual(reset.expectedPrevious.sides, [
    { id: '1001', score: null, result: 'win', forfeit: false },
    { id: '1004', score: null, result: 'loss', forfeit: true },
  ]);
  // finished again later: the worker finds the match cleared
  const again = buildToornamentJob(input(start(ready()), done, { type: 'match.finish', base: 0, matchId: m0, winner: 'p1' }, { lastRevision: 2, last: reset })).job!;
  assert.equal(again.revision, 3);
  assert.equal(again.expectedPreviousRevision, 2);
  assert.equal(again.expectedPrevious.status, 'pending');
  assert.deepEqual(again.expectedPrevious.sides.map((s) => s.result), [null, null]);
});

test('a result sent, never reset, then finished again: expectedPrevious is that result', () => {
  const { live, done, cmd } = played();
  const sent = buildToornamentJob(input(live, done, cmd)).job!;
  const r = buildToornamentJob(input(live, done, cmd, { lastRevision: 1, last: sent })).job!;
  assert.equal(r.expectedPrevious.status, 'completed');
  assert.equal(r.revision, 2);
});

test('tournament name falls back to the store’s name; stage name to empty', () => {
  const { live, done, cmd } = played();
  for (const s of [live, done]) {
    delete s.toornament!.tournamentName;
    delete s.toornament!.stageName;
  }
  const r = buildToornamentJob(input(live, done, cmd)).job!;
  assert.equal(r.expectedTournamentName, 'Store s1');
  assert.equal(r.expectedStageName, '');
});

test('no job, with the reason: sync off, no participant id, hand-built bracket, no match number, no stage, no link', () => {
  const reasonFor = (tweak: (live: Store, done: Store) => void) => {
    const { live, done, cmd } = played();
    tweak(live, done);
    const r = buildToornamentJob(input(live, done, cmd));
    assert.equal(r.job, null);
    return r.reason;
  };
  assert.equal(reasonFor((l, d) => [l, d].forEach((s) => (s.toornament!.sync = { on: false }))), 'sync-off');
  assert.equal(reasonFor((l, d) => [l, d].forEach((s) => delete s.toornament!.sync)), 'sync-off');
  assert.equal(reasonFor((l, d) => [l, d].forEach((s) => delete s.day.players[0].toornamentId)), 'not-mapped:no-participant-id');
  assert.equal(reasonFor((l, d) => [l, d].forEach((s) => delete s.day.players.find((p) => p.id === 'p4')!.toornamentId)), 'not-mapped:no-participant-id');
  assert.equal(reasonFor((l, d) => [l, d].forEach((s) => (s.toornament!.loadId = 'someone-else'))), 'not-mapped:not-from-toornament');
  assert.equal(reasonFor((l, d) => [l, d].forEach((s) => delete s.toornament!.loadId)), 'not-mapped:no-load-id');
  assert.equal(reasonFor((l, d) => [l, d].forEach((s) => delete s.toornament!.stageId)), 'not-mapped:no-stage');
  assert.equal(reasonFor((l, d) => [l, d].forEach((s) => (s.toornament!.url = 'https://example.com/x'))), 'not-mapped:no-tournament');
  assert.equal(reasonFor((l, d) => [l, d].forEach((s) => s.day.matches.forEach((m) => delete m.toornament))), 'not-mapped:no-match-id');
  assert.equal(reasonFor((l, d) => [l, d].forEach((s) => delete s.toornament)), 'sync-off');
  for (const r of ['sync-off', 'bye', 'not-mapped:no-participant-id'] as const) assert.ok(blockReasonText(r).length > 5);
});

test('never a job for a bye, nor for commands that are not results', () => {
  const store = ready({ players: players.slice(0, 3) }); // 3 players → one bye
  const bye = store.day.matches.find((m) => m.bye)!;
  assert.ok(bye);
  assert.equal(jobsBlockReason(store, bye), 'bye');
  // the bye's own (made-up) finish/undo commands are refused by the handlers; the builder refuses too
  const fake: Command = { type: 'match.finish', base: 0, matchId: bye.id, winner: bye.a ?? bye.b! };
  assert.deepEqual(buildToornamentJob(input(store, store, fake)), { job: null, reason: 'bye' });
  const other: Command = { type: 'stations.set', base: 0, count: 3 };
  assert.deepEqual(buildToornamentJob(input(store, store, other)), { job: null, reason: 'not-a-result' });
  assert.equal(jobMatchId(other), null);
  assert.equal(jobMatchId({ type: 'match.undo', base: 0, matchId: 'x' }), 'x');
});

test('finishing a match that was already done, or undoing one that was not, makes nothing', () => {
  const { live, done, cmd } = played();
  assert.equal(buildToornamentJob(input(done, done, cmd)).reason, 'not-finished');
  const undo: Command = { type: 'match.undo', base: 0, matchId: m0 };
  assert.equal(buildToornamentJob(input(live, run(live, undo, 'undo-001'), undo)).reason, 'not-finished'); // a live match called back isn't on Toornament
});

test('jobsBlockReason: null when everything is in place', () => {
  const s = ready();
  assert.equal(jobsBlockReason(s, s.day.matches.find((m) => m.id === m0)!), null);
  const final = s.day.matches.find((m) => m.round === 1)!;
  assert.equal(jobsBlockReason(s, final), 'not-mapped:no-players'); // nobody in it yet
});

/* ---------- Player.toornamentId ---------- */

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/toornament/${name}.json`, import.meta.url), 'utf8'));

test('planImport sets toornamentId from the participant id — for matched and for added players', () => {
  const f = fixture('se8');
  const stage = pickStage(readStages(f.stages));
  const bracket = bracketFromNodes(f.nodes.items, readParticipants(f.participants), stage!)!;
  assert.equal(bracket.mode, 'pairs');
  assert.equal(bracket.playerIds!.length, bracket.players.length);
  const idOf = new Map<string, string>();
  for (const n of f.nodes.items) for (const o of n.opponents) if (o.participant) idOf.set(o.participant.name.replace(/\s+/g, ' ').trim(), o.participant.id);
  bracket.players.forEach((name, i) => assert.equal(bracket.playerIds![i], idOf.get(name), name));

  const existing: Player[] = [{ id: 'old-1', name: bracket.players[0].toUpperCase(), seed: 1, phone: '9820011111', toornamentId: '777' }];
  const plan = planImport(bracket, existing);
  assert.equal(plan.matched.length, 1);
  assert.equal(plan.matched[0].id, 'old-1');
  for (const p of plan.players) assert.equal(p.toornamentId, idOf.get(p.id === 'old-1' ? bracket.players[0] : p.name), p.name);
  assert.notEqual(plan.matched[0].toornamentId, '777', 'the fresh id replaces an earlier import’s');
  assert.ok(plan.added.every((p) => p.toornamentId));

  // and through bracket.load: it survives the handler
  let store = fixtureStore('s1', 'e1', null) as unknown as Store;
  store = run(store, { type: 'bracket.load', base: 0, players: plan.players, pairs: plan.pairs, toornament: plan.nodes }, 'load-2');
  assert.deepEqual(store.day.players.map((p) => p.toornamentId), plan.players.map((p) => p.toornamentId));
});

test('a plan without participant ids (seeded fallback, hand-made bracket) sets none, and ids that aren’t digits are ignored', () => {
  const plan = planImport({ players: ['A', 'B'], pairs: [['A', 'B']] }, []);
  assert.deepEqual(plan.players.map((p) => p.toornamentId), [undefined, undefined]);
  const odd = planImport({ players: ['A', 'B'], pairs: [['A', 'B']], playerIds: ['12', 'x<script>'] }, []);
  assert.deepEqual(odd.players.map((p) => p.toornamentId), ['12', undefined]);
});

test('bracket.load and players.set keep toornamentId; hand edits do not touch it; bad ids are refused', () => {
  const store = ready();
  assert.deepEqual(store.day.players.map((p) => p.toornamentId).sort(), ['1001', '1002', '1003', '1004']);
  const empty = { ...store, day: { ...store.day, matches: [] } } as Store;
  const set = run(empty, { type: 'players.set', base: empty.day.version ?? 0, players: [...store.day.players, { id: 'p5', name: 'Esha', seed: 5 }] });
  assert.deepEqual(set.day.players.map((p) => p.toornamentId), ['1001', '1002', '1003', '1004', undefined]);
  const edited = run(store, { type: 'players.edit', base: 0, playerId: 'p2', name: 'Bilal K', ign: 'bk' });
  assert.equal(edited.day.players.find((p) => p.id === 'p2')!.toornamentId, '1002');
  const bad = (v: unknown) => () => run(empty, { type: 'players.set', base: empty.day.version ?? 0, players: [{ id: 'p1', name: 'A', seed: 1, toornamentId: v as string }] });
  for (const v of ['abc', '', '1'.repeat(25), 12]) assert.throws(bad(v), /Toornament id/);
});

test('schema: toornamentId, toornament.sync and toornament.tournamentName are checked', () => {
  const ctx2 = { events: { e1: event }, admins: {}, accounts: {} };
  const problems = (s: unknown) => validateDocument('stores', s, ctx2);
  assert.deepEqual(problems(ready()), []);
  const s = ready();
  s.day.players[0].toornamentId = 'abc';
  assert.ok(problems(s).some((p) => /toornamentId/.test(p)));
  const t = ready();
  (t.toornament as any).sync = { on: 'yes' };
  assert.ok(problems(t).some((p) => /sync/.test(p)));
  const u = ready();
  (u.toornament as any).tournamentName = 5;
  assert.ok(problems(u).some((p) => /tournamentName/.test(p)));
});

// keep the type import honest
void ({} as ToornamentJobDraft);
