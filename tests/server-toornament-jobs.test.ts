/*
 * Toornament result jobs on the server (server/toornament-jobs.ts, commit() in server/api.ts): a finished or undone
 * match makes a job in the same transaction as the command; a replaced bracket cancels the pending ones.
 * Real API on a temp directory, synthetic data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, seedBasic, SUPER } from './helpers/server.ts';
import { canonical } from '../server/canonical.ts';
import { DB_FILE } from '../server/migrate.ts';

type T = Awaited<ReturnType<typeof startTestServer>>;
const command = (t: T, cookie: string, id: string, storeId: string, cmd: unknown) => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId, cmd } });
const batch = (t: T, cookie: string, id: string, ops: unknown[]) => t.json('/api/batch', { method: 'POST', cookie, body: { id, ops } });

const URL_ = 'https://play.toornament.com/en_US/tournaments/111/stages/222/';
const players = [
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
const M0 = 'load-0001-0-0';
const M1 = 'load-0001-0-1';

const rows = (t: T): any[] => {
  const db = new DatabaseSync(path.join(t.dataDir, DB_FILE), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM toornament_jobs ORDER BY created_at, revision, rowid').all();
  } finally {
    db.close();
  }
};
const payload = (r: any) => JSON.parse(r.payload);
const stateOf = async (t: T, hq: string) => (await t.json('/api/state', { cookie: hq })).body;

/** HQ loads a four-player Toornament bracket on s1, sets the Toornament record (sync on unless told), everyone checks in. */
async function setup(t: T, o: { sync?: boolean; players?: unknown[]; link?: boolean } = {}) {
  const hq = await seedBasic(t);
  const r = await command(t, hq, 'load-0001', 's1', { type: 'bracket.load', base: 0, players: o.players ?? players, toornament: nodes });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const at = '2026-10-24T09:00:00.000Z';
  const t1 = await batch(t, hq, 'setup-tn-01', [
    { k: 'stores', id: 's1', p: ['toornament'], v: { url: URL_, stageId: '222', stageName: 'Playoffs', tournamentName: 'Test Cup', loadId: 'load-0001', ...(o.sync === false ? {} : { sync: { on: true } }) } },
    { k: 'stores', id: 's1', p: ['day', 'checkIn'], v: Object.fromEntries((o.players ?? players).map((p) => [(p as { id: string }).id, at])) },
  ]);
  assert.equal(t1.status, 200, JSON.stringify(t1.body));
  return hq;
}
const play = async (t: T, hq: string, tag: string, matchId: string, winner: string, extra: Record<string, unknown> = {}) => {
  let r = await command(t, hq, `start-${tag}`, 's1', { type: 'match.start', base: 0, matchId, station: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await command(t, hq, `fin-${tag}`, 's1', { type: 'match.finish', base: 0, matchId, winner, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.seq as number;
};
const undo = (t: T, hq: string, tag: string, matchId: string) => command(t, hq, `undo-${tag}`, 's1', { type: 'match.undo', base: 0, matchId });

test('a finished match makes one pending job, hashed, saved with the result', async () => {
  const t = await startTestServer();
  try {
    const hq = await setup(t);
    assert.equal(rows(t).length, 0, 'loading the bracket makes no job');
    await play(t, hq, 'a1', M0, 'p1');
    const [row, ...more] = rows(t);
    assert.equal(more.length, 0);
    assert.match(row.id, /^tj_[A-Za-z0-9_-]{16}$/);
    assert.equal(row.store_id, 's1');
    assert.equal(row.entity_id, M0);
    assert.equal(row.revision, 1);
    assert.equal(row.state, 'pending');
    assert.equal(row.attempt, 0);
    assert.equal(row.tournament_id, '111');
    assert.equal(row.stage_id, '222');
    assert.equal(row.claim_token, null);
    assert.equal(row.lease_until, null);
    assert.deepEqual(JSON.parse(row.history).map((h: any) => [h.state, h.code, h.attempt]), [['pending', 'created', 0]]);
    const p = payload(row);
    assert.equal(p.kind, 'match.result');
    assert.equal(p.sourceCommandId, 'fin-a1');
    assert.equal(p.bracketGenerationId, 'load-0001');
    assert.equal(p.matchId, '333');
    assert.equal(p.toornamentLabel, 'Match #1.1.1.1');
    assert.equal(p.expectedTournamentName, 'Test Cup');
    assert.deepEqual(p.desired, { outcome: 'played', winnerId: '1001' });
    assert.ok(!('jobId' in p) && !('payloadHash' in p), 'the stored payload is the hashed part only');
    assert.equal(row.payload_hash, createHash('sha256').update(canonical(p)).digest('hex'));
    // the same job as the worker will get it
    const job = t.api.toornamentJobs.get(row.id)!;
    assert.equal(job.payload_hash, row.payload_hash);
  } finally {
    await t.close();
  }
});

test('no job when sync is off, a player has no participant id, or the bracket isn’t from Toornament', async () => {
  for (const [name, o] of [['sync off', { sync: false }], ['no participant ids', { players: players.map(({ toornamentId: _t, ...p }) => p) }]] as const) {
    const t = await startTestServer();
    try {
      const hq = await setup(t, o);
      await play(t, hq, 'b1', M0, 'p1');
      assert.equal(rows(t).length, 0, name);
    } finally {
      await t.close();
    }
  }
  const t = await startTestServer();
  try {
    const hq = await setup(t);
    const r = await batch(t, hq, 'detach-0001', [{ k: 'stores', id: 's1', p: ['toornament', 'loadId'], v: 'another-load' }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await play(t, hq, 'b2', M0, 'p1');
    assert.equal(rows(t).length, 0, 'hand-built bracket');
  } finally {
    await t.close();
  }
});

test('no job for a bye', async () => {
  const t = await startTestServer();
  try {
    const hq = await setup(t, { players: players.slice(0, 3) });
    const s = (await stateOf(t, hq)).stores.s1;
    const bye = s.day.matches.find((m: any) => m.bye);
    assert.ok(bye, 'three players → a bye');
    const live = s.day.matches.find((m: any) => !m.bye && m.round === 0);
    await play(t, hq, 'c1', live.id, live.a);
    assert.equal(rows(t).length, 1);
    assert.notEqual(payload(rows(t)[0]).entityId, bye.id);
  } finally {
    await t.close();
  }
});

test('a walkover is a forfeit', async () => {
  const t = await startTestServer();
  try {
    const hq = await setup(t);
    await batch(t, hq, 'only-asha-001', [{ k: 'stores', id: 's1', p: ['day', 'checkIn'], v: { p1: '2026-10-24T09:00:00.000Z', p2: '2026-10-24T09:00:00.000Z', p3: '2026-10-24T09:00:00.000Z' } }]);
    const r = await command(t, hq, 'fin-walk-01', 's1', { type: 'match.finish', base: 0, matchId: M0, winner: 'p1', walkover: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(payload(rows(t)[0]).desired, { outcome: 'forfeit', winnerId: '1001', forfeitingParticipantId: '1004' });
  } finally {
    await t.close();
  }
});

test('undo makes a reset whose expectedPrevious is the result sent; revisions count up per match; a result after a reset starts clean', async () => {
  const t = await startTestServer();
  try {
    const hq = await setup(t);
    await play(t, hq, 'd1', M0, 'p1');
    await play(t, hq, 'd2', M1, 'p2'); // another match: its own revisions
    assert.equal((await undo(t, hq, 'd1', M0)).status, 200);
    let [first, other, reset] = rows(t);
    assert.deepEqual([first.revision, other.revision, reset.revision], [1, 1, 2]);
    const r = payload(reset);
    assert.equal(r.kind, 'match.reset');
    assert.equal(r.entityId, M0);
    assert.ok(!('desired' in r));
    assert.equal(r.expectedPreviousRevision, 1);
    assert.deepEqual(r.expectedPrevious, { status: 'completed', sides: [{ id: '1001', score: null, result: 'win', forfeit: false }, { id: '1004', score: null, result: 'loss', forfeit: false }] });
    assert.equal(r.sourceCommandId, 'undo-d1');

    await play(t, hq, 'd3', M0, 'p4'); // played again after the reset
    const third = payload(rows(t)[3]);
    assert.equal(third.revision, 3);
    assert.equal(third.expectedPreviousRevision, 2);
    assert.equal(third.expectedPrevious.status, 'pending');
    assert.deepEqual(third.desired, { outcome: 'played', winnerId: '1004' });
    assert.deepEqual(rows(t).map((x) => x.revision), [1, 1, 2, 3]);
  } finally {
    await t.close();
  }
});

test('a cancelled job is skipped when the next one looks for what was last sent; its revision is not reused', async () => {
  const t = await startTestServer();
  try {
    const hq = await setup(t);
    await play(t, hq, 'e1', M0, 'p1');
    const db = new DatabaseSync(path.join(t.dataDir, DB_FILE));
    db.prepare("UPDATE toornament_jobs SET state = 'cancelled' WHERE entity_id = ?").run(M0);
    db.close();
    await undo(t, hq, 'e1', M0);
    const [, reset] = rows(t);
    assert.equal(reset.revision, 2, 'revision = 1 + the highest, cancelled ones included');
    assert.equal(payload(reset).expectedPrevious.status, 'pending', 'nothing live was sent before it');
  } finally {
    await t.close();
  }
});

test('reloading or resetting the bracket cancels the store’s pending jobs (superseded) but not a claimed one', async () => {
  for (const how of ['bracket.reset', 'bracket.load'] as const) {
    const t = await startTestServer();
    try {
      const hq = await setup(t);
      await play(t, hq, 'f1', M0, 'p1');
      await play(t, hq, 'f2', M1, 'p2');
      assert.equal((await undo(t, hq, 'f1', M0)).status, 200);
      assert.equal((await undo(t, hq, 'f2', M1)).status, 200);
      const db = new DatabaseSync(path.join(t.dataDir, DB_FILE));
      const [one] = rows(t);
      db.prepare("UPDATE toornament_jobs SET state = 'claimed', attempt = 1 WHERE id = ?").run(one.id);
      db.close();
      assert.deepEqual(rows(t).map((r) => r.state), ['claimed', 'pending', 'pending', 'pending']);

      const base = (await stateOf(t, hq)).stores.s1.day.version;
      const cmd = how === 'bracket.reset' ? { type: how, base } : { type: how, base, players, toornament: nodes };
      const r = await command(t, hq, `redo-${how.length}-001`, 's1', cmd);
      assert.equal(r.status, 200, JSON.stringify(r.body));

      const after = rows(t);
      assert.deepEqual(after.map((x) => x.state), ['claimed', 'cancelled', 'cancelled', 'cancelled'], how);
      for (const x of after.slice(1)) {
        assert.equal(x.code, 'superseded');
        assert.deepEqual(JSON.parse(x.history).map((h: any) => [h.state, h.code]), [['pending', 'created'], ['cancelled', 'superseded']]);
      }
      assert.equal(JSON.parse(after[0].history).length, 1, 'a claimed job is left alone');
    } finally {
      await t.close();
    }
  }
});

test('a job for another store survives a reset of this one', async () => {
  const t = await startTestServer();
  try {
    const hq = await setup(t);
    await play(t, hq, 'g1', M0, 'p1');
    await undo(t, hq, 'g1', M0);
    // a pending job that belongs to s2
    const db = new DatabaseSync(path.join(t.dataDir, DB_FILE));
    db.prepare("UPDATE toornament_jobs SET store_id = 's2' WHERE revision = 1").run();
    db.close();
    const base = (await stateOf(t, hq)).stores.s1.day.version;
    assert.equal((await command(t, hq, 'reset-s1-0001', 's1', { type: 'bracket.reset', base })).status, 200);
    assert.deepEqual(rows(t).map((r) => [r.store_id, r.state]), [['s2', 'pending'], ['s1', 'cancelled']]);
  } finally {
    await t.close();
  }
});

test('the job and the command commit together: if the job can’t be saved, the result isn’t either', async () => {
  const t = await startTestServer();
  try {
    const hq = await setup(t);
    let r = await command(t, hq, 'start-h1', 's1', { type: 'match.start', base: 0, matchId: M0, station: 1 });
    assert.equal(r.status, 200);
    const seqBefore = (await stateOf(t, hq)).seq;
    const db = new DatabaseSync(path.join(t.dataDir, DB_FILE));
    db.exec("CREATE TRIGGER no_jobs BEFORE INSERT ON toornament_jobs BEGIN SELECT RAISE(ABORT, 'disk says no'); END");
    r = await command(t, hq, 'fin-h1', 's1', { type: 'match.finish', base: 0, matchId: M0, winner: 'p1' });
    assert.equal(r.status, 500);
    let s = await stateOf(t, hq);
    assert.equal(s.seq, seqBefore, 'no new seq');
    assert.equal(s.stores.s1.day.matches.find((m: any) => m.id === M0).status, 'live', 'the result was not saved');
    assert.equal(rows(t).length, 0);
    db.exec('DROP TRIGGER no_jobs');
    db.close();
    // the same command goes through once the database works again (its id was not used up)
    r = await command(t, hq, 'fin-h1', 's1', { type: 'match.finish', base: 0, matchId: M0, winner: 'p1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s = await stateOf(t, hq);
    assert.equal(s.stores.s1.day.matches.find((m: any) => m.id === M0).status, 'done');
    assert.equal(rows(t).length, 1);
  } finally {
    await t.close();
  }
});

test('a retried command makes no second job; a refused command makes none', async () => {
  const t = await startTestServer();
  try {
    const hq = await setup(t);
    await command(t, hq, 'start-i1', 's1', { type: 'match.start', base: 0, matchId: M0, station: 1 });
    const fin = { type: 'match.finish', base: 0, matchId: M0, winner: 'p1' };
    const a = await command(t, hq, 'fin-i1', 's1', fin);
    const b = await command(t, hq, 'fin-i1', 's1', fin);
    assert.equal(a.body.seq, b.body.seq);
    assert.equal(rows(t).length, 1);
    const again = await command(t, hq, 'fin-i2', 's1', fin); // already done: refused
    assert.equal(again.status, 409);
    assert.equal(rows(t).length, 1);
  } finally {
    await t.close();
  }
});

test('toornamentId survives a bracket.load and a players.set through the server; a bad one is refused', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    let r = await command(t, hq, 'load-ids-01', 's1', { type: 'bracket.load', base: 0, players });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let s = await stateOf(t, hq);
    assert.deepEqual(s.stores.s1.day.players.map((p: any) => p.toornamentId), ['1001', '1002', '1003', '1004']);
    r = await command(t, hq, 'reset-ids-01', 's1', { type: 'bracket.reset', base: s.stores.s1.day.version });
    assert.equal(r.status, 200);
    s = await stateOf(t, hq);
    r = await command(t, hq, 'set-ids-0001', 's1', { type: 'players.set', base: s.stores.s1.day.version, players: s.stores.s1.day.players });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s = await stateOf(t, hq);
    assert.deepEqual(s.stores.s1.day.players.map((p: any) => p.toornamentId), ['1001', '1002', '1003', '1004']);
    r = await command(t, hq, 'set-ids-0002', 's1', { type: 'players.set', base: s.stores.s1.day.version, players: [{ id: 'p1', name: 'A', seed: 1, toornamentId: 'nope' }] });
    assert.equal(r.status, 400);
    assert.equal((await t.json('/api/state', { cookie: await t.login('AAA2') })).body.stores.s1.day.players[0].toornamentId, '1001', 'the desk sees it too (it is not a secret)');
  } finally {
    await t.close();
  }
});

test('only HQ can switch the store’s sync on; the table survives a restart', async () => {
  const t = await startTestServer();
  const dataDir = t.dataDir;
  try {
    const hq = await setup(t);
    const a1 = await t.login('AAA2');
    const r = await batch(t, a1, 'sync-by-admin1', [{ k: 'stores', id: 's1', p: ['toornament', 'sync'], v: { on: true } }]);
    assert.equal(r.status, 403);
    await play(t, hq, 'j1', M0, 'p1');
  } finally {
    await t.close();
  }
  const again = await startTestServer({ dataDir });
  try {
    assert.equal(rows(again).length, 1, 'opening the database again keeps the table and its rows');
    const hq = await again.login(SUPER);
    assert.equal((await undo(again, hq, 'j1', M0)).status, 200);
    assert.deepEqual(rows(again).map((r) => r.revision), [1, 2]);
  } finally {
    await again.close();
  }
});
