/*
 * HQ's side of the Toornament result queue over the real API (docs/toornament-jobs.md "HQ"): GET /api/toornament/jobs and
 * POST /api/toornament/jobs/:id/resolve — HQ only, newest first, nothing secret in the listing, settling only a job that is
 * needs-human or failed, "manual" → done (resolved-by-hq), "retry" → pending with attempts back to 0 and a recovery claim.
 * Synthetic names, ids and keys; a temp data dir; a fake clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, seedBasic, type TestServer } from './helpers/server.ts';
import { DB_FILE } from '../server/migrate.ts';

const T0 = Date.parse('2026-10-24T06:00:00.000Z');
const SEC = 1000;
const clock = { t: T0 };
const SCOPES = [{ tournamentId: '111', stageId: '222' }];

const command = (t: TestServer, cookie: string, id: string, cmd: unknown, storeId = 's1') => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId, cmd } });
const NAMES = ['Asha', 'Bilal', 'Chen', 'Dev'];
const players = NAMES.map((name, i) => ({ id: `p${i + 1}`, name, seed: i + 1, toornamentId: String(1001 + i), phone: `98765000${i + 1}0` }));
const m = (i: number) => `load-0001-${i === 2 ? '1-0' : `0-${i}`}`;

async function start() {
  clock.t = T0;
  const t = await startTestServer({ now: () => clock.t });
  const hq = await seedBasic(t);
  const nodes = [
    { round: 0, index: 0, id: '333', label: '1.1.1.1' },
    { round: 0, index: 1, id: '334', label: '1.1.1.2' },
    { round: 1, index: 0, id: '335', label: '1.1.2.1' },
  ];
  let r = await command(t, hq, 'load-0001', { type: 'bracket.load', base: 0, players, toornament: nodes });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await t.json('/api/batch', {
    method: 'POST',
    cookie: hq,
    body: {
      id: 'setup-s1-0001',
      ops: [
        { k: 'stores', id: 's1', p: ['toornament'], v: { url: 'https://play.toornament.com/en_US/tournaments/111/stages/222/', stageId: '222', stageName: 'Playoffs', tournamentName: 'Test Cup', loadId: 'load-0001', sync: { on: true } } },
        { k: 'stores', id: 's1', p: ['day', 'checkIn'], v: Object.fromEntries(players.map((p) => [p.id, '2026-10-24T09:00:00.000Z'])) },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { t, hq };
}
/** Finishes a first-round match (start, then finish) and returns the job it made. */
async function finish(t: TestServer, hq: string, i: number, tag: string) {
  const w = i === 0 ? 'p1' : 'p3';
  let r = await command(t, hq, `start-${tag}`, { type: 'match.start', base: 0, matchId: m(i), station: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  clock.t += SEC;
  r = await command(t, hq, `fin-${tag}`, { type: 'match.finish', base: 0, matchId: m(i), winner: w });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  clock.t += SEC;
}
const jobs = (t: TestServer) => t.api.toornamentJobs;
const ident = (c: NonNullable<ReturnType<ReturnType<typeof jobs>['claim']>>, workerId = 'w1') => ({ jobId: c.job.jobId, payloadHash: c.job.payloadHash, revision: c.job.revision, claimToken: c.claimToken, workerId });
const claim = (t: TestServer) => jobs(t).claim('w1', SCOPES);
/** Claims the oldest job and acks it with this status / code; returns the job id. */
function settleWith(t: TestServer, status: 'done' | 'failed' | 'needs-human' | 'retry', code: string) {
  const c = claim(t);
  assert.ok(c, 'a job was expected');
  const r = jobs(t).ack(ident(c), { status, code });
  assert.ok(r.ok, JSON.stringify(r));
  return c.job.jobId;
}
const rowOf = (t: TestServer, id: string): any => {
  const db = new DatabaseSync(path.join(t.dataDir, DB_FILE), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM toornament_jobs WHERE id = ?').get(id);
  } finally {
    db.close();
  }
};
const resolve = (t: TestServer, cookie: string | undefined, id: string, body: unknown) => t.json(`/api/toornament/jobs/${id}/resolve`, { method: 'POST', cookie, body });
const list = (t: TestServer, cookie: string | undefined, q = '') => t.json(`/api/toornament/jobs${q}`, { cookie });

test('only HQ: nobody signed in gets 401, a field admin 403 — for the listing and for resolve — and nothing changes', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, 0, 'a1');
    const id = settleWith(t, 'needs-human', 'REVIEW_REQUIRED');
    const a1 = await t.login('AAA2');
    assert.equal((await list(t, undefined)).status, 401);
    assert.equal((await list(t, a1)).status, 403);
    assert.equal((await list(t, a1, '?storeId=s1')).status, 403);
    for (const action of ['manual', 'retry']) {
      assert.equal((await resolve(t, undefined, id, { action })).status, 401);
      assert.equal((await resolve(t, a1, id, { action })).status, 403);
    }
    assert.equal(rowOf(t, id).state, 'needs-human');
    assert.equal((await list(t, hq)).status, 200);
  } finally {
    await t.close();
  }
});

test('the listing: newest first, one store on request, only what HQ needs, and no secrets or phone numbers', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, 0, 'a1');
    clock.t += 5 * SEC;
    await finish(t, hq, 1, 'a2');
    const c = claim(t)!;
    const claimToken = c.claimToken;
    const hash = c.job.payloadHash;
    const all = await list(t, hq);
    assert.equal(all.status, 200);
    assert.equal(all.body.jobs.length, 2);
    assert.deepEqual(
      all.body.jobs.map((j: any) => j.entityId),
      [m(1), m(0)],
      'newest first',
    );
    const [newest, oldest] = all.body.jobs;
    assert.deepEqual(Object.keys(newest).sort(), ['attempt', 'code', 'createdAt', 'desired', 'entityId', 'history', 'id', 'kind', 'participants', 'revision', 'state', 'storeId', 'toornamentLabel', 'updatedAt']);
    assert.equal(oldest.state, 'claimed');
    assert.equal(oldest.attempt, 1);
    assert.equal(oldest.kind, 'match.result');
    assert.equal(oldest.storeId, 's1');
    assert.equal(oldest.toornamentLabel, 'Match #1.1.1.1');
    assert.deepEqual(oldest.participants, ['Asha', 'Dev']);
    assert.deepEqual(oldest.desired, { outcome: 'played', winnerName: 'Asha' });
    assert.deepEqual(newest.desired, { outcome: 'played', winnerName: 'Chen' });
    assert.equal(newest.state, 'pending');
    assert.ok(Array.isArray(oldest.history) && oldest.history.length >= 2);
    assert.equal(oldest.createdAt, new Date(T0 + SEC).toISOString());

    // Nothing secret or personal anywhere in the text: token, hash, participant ids, phones, the worker key, the lease.
    const text = JSON.stringify(all.body);
    for (const bad of [claimToken, hash, '1001', '1002', '1003', '1004', '98765000', 'claimToken', 'payloadHash', 'lease', 'payload', 'phone']) assert.ok(!text.includes(bad), `the listing leaks ${bad}`);

    assert.equal((await list(t, hq, '?storeId=s2')).body.jobs.length, 0);
    assert.equal((await list(t, hq, '?storeId=s1')).body.jobs.length, 2);
    assert.equal(jobs(t).list(undefined, 1).length, 1, 'a limit is kept');
  } finally {
    await t.close();
  }
});

test('resolve only takes a job that is needs-human or failed; anything else is a 409, an unknown job a 404, a bad action a 400', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, 0, 'a1');
    const pending = (await list(t, hq)).body.jobs[0].id;
    for (const action of ['manual', 'retry']) assert.equal((await resolve(t, hq, pending, { action })).status, 409, `pending ${action}`);
    claim(t);
    for (const action of ['manual', 'retry']) assert.equal((await resolve(t, hq, pending, { action })).status, 409, `claimed ${action}`);
    assert.equal(rowOf(t, pending).state, 'claimed');
    const c = jobs(t).get(pending)!;
    assert.ok(c);
    // done: ack it done, then it can't be settled again.
    const row = rowOf(t, pending);
    const ok = jobs(t).ack({ jobId: pending, payloadHash: row.payload_hash, revision: row.revision, claimToken: row.claim_token, workerId: 'w1' }, { status: 'done', code: 'VERIFIED' });
    assert.ok(ok.ok);
    for (const action of ['manual', 'retry']) {
      const r = await resolve(t, hq, pending, { action });
      assert.equal(r.status, 409, `done ${action}`);
      assert.equal(r.body.code, 'conflict');
    }
    assert.equal(rowOf(t, pending).state, 'done');
    assert.equal((await resolve(t, hq, 'tj_doesnotexist', { action: 'manual' })).status, 404);

    await finish(t, hq, 1, 'a2');
    const id = settleWith(t, 'needs-human', 'UNCERTAIN_EFFECT');
    for (const body of [{}, { action: 'cancel' }, { action: 1 }, null, { action: ['manual'] }]) assert.equal((await resolve(t, hq, id, body)).status, 400, JSON.stringify(body));
    assert.equal(rowOf(t, id).state, 'needs-human', 'a refused request changed nothing');
  } finally {
    await t.close();
  }
});

test('manual: needs-human becomes done (resolved-by-hq), the history says who, and the next revision of the match is unblocked', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, 0, 'a1');
    const id = settleWith(t, 'needs-human', 'UNCERTAIN_EFFECT');
    // Undoing the finished match queues a reset behind it; it can't be claimed while the earlier one needs a person.
    let r = await command(t, hq, 'undo-a1', { type: 'match.undo', base: 0, matchId: m(0) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    clock.t += SEC;
    assert.equal(claim(t), null);

    const res = await resolve(t, hq, id, { action: 'manual' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.job.state, 'done');
    assert.equal(res.body.job.code, 'resolved-by-hq');
    const row = rowOf(t, id);
    assert.equal(row.state, 'done');
    assert.equal(row.code, 'resolved-by-hq');
    assert.equal(row.claim_token, null);
    assert.equal(row.lease_until, null);
    assert.equal(row.next_attempt_at, null);
    const last = JSON.parse(row.history).at(-1);
    assert.deepEqual({ state: last.state, code: last.code, by: last.by }, { state: 'done', code: 'resolved-by-hq', by: 'hq' });
    assert.equal(JSON.stringify(last).includes('super'), false, 'a role, not a name or a code');

    const next = claim(t);
    assert.ok(next, 'the reset can go now');
    assert.equal(next.job.kind, 'match.reset');
    assert.equal(next.job.revision, 2);
    assert.equal(next.recoveryRequired, false, 'its own history is clean');
  } finally {
    await t.close();
  }
});

test('retry: failed or needs-human goes back to pending with attempts at 0, and the next claim is a recovery claim', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, 0, 'a1');
    await finish(t, hq, 1, 'a2');

    // A job that failed outright (a plain failure has no recovery marks of its own).
    const failed = settleWith(t, 'failed', 'wrong-tournament');
    assert.equal(rowOf(t, failed).state, 'failed');
    const second = settleWith(t, 'needs-human', 'REVIEW_REQUIRED');
    assert.notEqual(second, failed);
    assert.equal(rowOf(t, second).attempt, 1);

    for (const id of [failed, second]) {
      const r = await resolve(t, hq, id, { action: 'retry' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.job.state, 'pending');
      assert.equal(r.body.job.attempt, 0);
      const row = rowOf(t, id);
      assert.equal(row.state, 'pending');
      assert.equal(row.attempt, 0);
      assert.equal(row.code, 'retry-by-hq');
      assert.equal(row.next_attempt_at, null);
      assert.equal(row.claim_token, null);
      assert.equal(row.worker_id, null);
      assert.equal(row.lease_until, null);
      assert.equal(row.checkpoint_at, null);
      const last = JSON.parse(row.history).at(-1);
      assert.deepEqual({ state: last.state, code: last.code, attempt: last.attempt, by: last.by }, { state: 'pending', code: 'retry-by-hq', attempt: 0, by: 'hq' });
    }

    const a = claim(t)!;
    assert.ok(a);
    assert.equal(a.attempt, 1, 'a new run of attempts');
    assert.equal(a.recoveryRequired, true, 'the worker reads Toornament first, it never just saves again');
    jobs(t).ack(ident(a), { status: 'done', code: 'VERIFIED' });
    const b = claim(t)!;
    assert.ok(b);
    assert.equal(b.recoveryRequired, true);
  } finally {
    await t.close();
  }
});

test('retry also takes a job that gave up after five attempts, and it gets five new ones', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, 0, 'a1');
    const id = (await list(t, hq)).body.jobs[0].id;
    for (let i = 0; i < 5; i++) {
      const c = claim(t)!;
      assert.ok(c, `attempt ${i + 1}`);
      assert.ok(jobs(t).ack(ident(c), { status: 'retry', code: 'pending', nextAttemptAt: clock.t }).ok);
      clock.t += 5 * SEC;
    }
    assert.equal(claim(t), null, 'out of attempts: it fails instead of being claimed');
    assert.equal(rowOf(t, id).state, 'failed');
    assert.equal(rowOf(t, id).code, 'too-many-attempts');

    const r = await resolve(t, hq, id, { action: 'retry' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = claim(t)!;
    assert.ok(c);
    assert.equal(c.attempt, 1);
    assert.equal(c.recoveryRequired, true);
    // Settling twice in a row: the second one finds a job that is no longer waiting for a person.
    assert.equal((await resolve(t, hq, id, { action: 'retry' })).status, 409);
  } finally {
    await t.close();
  }
});
