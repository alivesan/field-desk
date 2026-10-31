/*
 * The Toornament browser worker's routes over the real API (server/toornament-worker.ts, server/toornament-jobs.ts,
 * docs/toornament-jobs.md "The worker's routes"): its own bearer key and nothing else, claim rules (scope, sync, order,
 * one per stage, revision order), heartbeat / checkpoint / ack with their 409s, lease expiry, the attempts cap, strict
 * input, and that nothing but ids and codes reaches the history and the logs. Synthetic keys, names and ids; a temp data
 * dir; a fake clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, seedBasic, SUPER, type TestServer } from './helpers/server.ts';
import { DB_FILE } from '../server/migrate.ts';
import type { Logger } from '../server/log.ts';
import { LEASE_MS, MAX_ATTEMPTS } from '../server/toornament-jobs.ts';

const KEY = 'synthetic-toornament-worker-key-0123456789abcdef';
const STEAM_KEY = 'synthetic-steam-api-key-0123456789abcdef';
const T0 = Date.parse('2026-10-24T06:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
const BASE = '/api/v1/toornament/worker/v1/jobs/';

const clock = { t: T0 };
const command = (t: TestServer, cookie: string, id: string, storeId: string, cmd: unknown) => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId, cmd } });
const batch = (t: TestServer, cookie: string, id: string, ops: unknown[]) => t.json('/api/batch', { method: 'POST', cookie, body: { id, ops } });

const NAMES = ['Asha', 'Bilal', 'Chen', 'Dev'];
const playersOf = (base: number) => NAMES.map((name, i) => ({ id: `p${i + 1}`, name, seed: i + 1, toornamentId: String(base + i) }));

interface Layout {
  storeId: string;
  tag: string; // the bracket.load command id, so also the prefix of its match ids
  tournament: string;
  stage: string;
  nodes: string[]; // Toornament ids of [first-round match 0, match 1, final]
  playerBase: number;
}
const L1: Layout = { storeId: 's1', tag: 'load-0001', tournament: '111', stage: '222', nodes: ['333', '334', '335'], playerBase: 1001 };
const L2: Layout = { storeId: 's2', tag: 'load-0002', tournament: '777', stage: '888', nodes: ['433', '434', '435'], playerBase: 2001 };
const match = (l: Layout, i: number) => `${l.tag}-${i === 2 ? '1-0' : `0-${i}`}`;

/** Loads a four-player Toornament bracket on a store, sets its Toornament record (sync on unless told) and checks everyone in. */
async function setupStore(t: TestServer, hq: string, l: Layout, o: { sync?: boolean } = {}) {
  const players = playersOf(l.playerBase);
  const nodes = [
    { round: 0, index: 0, id: l.nodes[0], label: '1.1.1.1' },
    { round: 0, index: 1, id: l.nodes[1], label: '1.1.1.2' },
    { round: 1, index: 0, id: l.nodes[2], label: '1.1.2.1' },
  ];
  let r = await command(t, hq, l.tag, l.storeId, { type: 'bracket.load', base: 0, players, toornament: nodes });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await batch(t, hq, `setup-${l.storeId}-01`, [
    { k: 'stores', id: l.storeId, p: ['toornament'], v: { url: `https://play.toornament.com/en_US/tournaments/${l.tournament}/stages/${l.stage}/`, stageId: l.stage, stageName: 'Playoffs', tournamentName: 'Test Cup', loadId: l.tag, ...(o.sync === false ? {} : { sync: { on: true } }) } },
    { k: 'stores', id: l.storeId, p: ['day', 'checkIn'], v: Object.fromEntries(players.map((p) => [p.id, '2026-10-24T09:00:00.000Z'])) },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
const finish = async (t: TestServer, hq: string, l: Layout, i: number, tag: string, winner = i === 0 ? 'p1' : 'p2') => {
  let r = await command(t, hq, `start-${tag}`, l.storeId, { type: 'match.start', base: 0, matchId: match(l, i), station: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  clock.t += SEC;
  r = await command(t, hq, `fin-${tag}`, l.storeId, { type: 'match.finish', base: 0, matchId: match(l, i), winner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  clock.t += SEC;
};
const undo = async (t: TestServer, hq: string, l: Layout, i: number, tag: string) => {
  const r = await command(t, hq, `undo-${tag}`, l.storeId, { type: 'match.undo', base: 0, matchId: match(l, i) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  clock.t += SEC;
};

async function start(o: { sync?: boolean; stores?: Layout[]; log?: Logger; key?: string | null } = {}) {
  clock.t = T0;
  const t = await startTestServer({
    now: () => clock.t,
    ...(o.log ? { log: o.log } : {}),
    toornamentWorker: { apiKey: o.key === null ? '' : (o.key ?? KEY) },
    steam: { apiKey: STEAM_KEY },
  } as Parameters<typeof startTestServer>[0]);
  const hq = await seedBasic(t);
  for (const l of o.stores ?? [L1]) await setupStore(t, hq, l, { sync: o.sync });
  return { t, hq };
}

/** A route of the worker API; `key: null` sends no Authorization header. */
async function call(t: TestServer, route: string, body: unknown, o: { key?: string | null; method?: string; raw?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (o.key !== null) headers.Authorization = `Bearer ${o.key ?? KEY}`;
  const r = await fetch(t.base + BASE + route, { method: o.method ?? 'POST', headers, body: o.method === 'GET' ? undefined : (o.raw ?? JSON.stringify(body)) });
  const text = await r.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: r.status, body: parsed, text };
}
const SCOPE1 = [{ tournamentId: '111', stageId: '222' }];
const SCOPE2 = [{ tournamentId: '777', stageId: '888' }];
const claim = (t: TestServer, workerId = 'worker-1', scopes: unknown = [...SCOPE1, ...SCOPE2]) => call(t, 'claim', { workerId, scopes });
const idOf = (c: any, workerId = 'worker-1') => ({ jobId: c.job.jobId, payloadHash: c.job.payloadHash, revision: c.job.revision, claimToken: c.claimToken, workerId });
/** Claims and expects a job. */
async function claimed(t: TestServer, workerId = 'worker-1', scopes?: unknown) {
  const r = await claim(t, workerId, scopes);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body, 'a job was expected');
  return r.body;
}
const ack = (t: TestServer, c: any, status: string, code: string, extra: Record<string, unknown> = {}, workerId = 'worker-1') => call(t, 'ack', { ...idOf(c, workerId), status, code, ...extra });

const rowsOf = (t: TestServer): any[] => {
  const db = new DatabaseSync(path.join(t.dataDir, DB_FILE), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM toornament_jobs ORDER BY created_at, revision, rowid').all();
  } finally {
    db.close();
  }
};
const rowOf = (t: TestServer, jobId: string) => rowsOf(t).find((r) => r.id === jobId);
const historyOf = (t: TestServer, jobId: string): any[] => JSON.parse(rowOf(t, jobId).history);

/* ---------- auth ---------- */

test('the worker routes need their own key: none, a wrong one, the Steam key and a session all get 401; unconfigured is 503', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    const body = { workerId: 'worker-1', scopes: SCOPE1 };
    assert.equal((await call(t, 'claim', body, { key: null })).status, 401);
    assert.equal((await call(t, 'claim', body, { key: 'wrong-key-wrong-key' })).status, 401);
    assert.equal((await call(t, 'claim', body, { key: STEAM_KEY })).status, 401);
    const viaCookie = await t.json(BASE + 'claim', { method: 'POST', cookie: hq, body });
    assert.equal(viaCookie.status, 401);
    for (const r of ['heartbeat', 'checkpoint', 'ack']) assert.equal((await call(t, r, {}, { key: null })).status, 401, r);
    assert.equal(rowsOf(t)[0].state, 'pending', 'nothing was claimed by any of those');
    const ok = await call(t, 'claim', body);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.job);
    // the worker key is no good for the Steam routes
    const steam = await fetch(t.base + '/api/v1/steam/accounts', { headers: { Authorization: `Bearer ${KEY}` } });
    assert.equal(steam.status, 401);
    // wrong method / route
    const get = await call(t, 'claim', null, { method: 'GET' });
    assert.equal(get.status, 405);
    const none = await fetch(t.base + '/api/v1/toornament/worker/v1/jobs/other', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } });
    assert.equal(none.status, 404);
  } finally {
    await t.close();
  }
  const off = await start({ key: null });
  try {
    const r = await call(off.t, 'claim', { workerId: 'worker-1', scopes: SCOPE1 });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'not_configured');
  } finally {
    await off.t.close();
  }
});

/* ---------- claim ---------- */

test('claim answers null when nothing is waiting, when the store’s sync is off, and for a scope that isn’t asked', async () => {
  const { t, hq } = await start();
  try {
    let r = await claim(t);
    assert.equal(r.status, 200);
    assert.equal(r.body, null);
    await finish(t, hq, L1, 0, 'a1');
    r = await claim(t, 'worker-1', SCOPE2);
    assert.equal(r.body, null, 'another stage’s scope');
    r = await claim(t, 'worker-1', [{ tournamentId: '111', stageId: '999' }, { tournamentId: '999', stageId: '222' }]);
    assert.equal(r.body, null, 'the tournament and the stage must both match');
    // HQ turns the sync off: the waiting job can't be claimed
    let b = await batch(t, hq, 'sync-off-0001', [{ k: 'stores', id: 's1', p: ['toornament', 'sync'], v: { on: false } }]);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    r = await claim(t, 'worker-1', SCOPE1);
    assert.equal(r.body, null, 'sync off');
    b = await batch(t, hq, 'sync-on-00001', [{ k: 'stores', id: 's1', p: ['toornament', 'sync'], v: { on: true } }]);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    r = await claim(t, 'worker-1', SCOPE1);
    assert.ok(r.body?.job, 'on again');
  } finally {
    await t.close();
  }
});

test('claim gives the job, a fresh token, attempt 1, no recovery, and a 2-minute lease', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    const c = await claimed(t);
    assert.deepEqual(Object.keys(c).sort(), ['attempt', 'claimToken', 'job', 'recoveryRequired']);
    assert.equal(c.attempt, 1);
    assert.equal(c.recoveryRequired, false);
    assert.match(c.claimToken, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(c.job.kind, 'match.result');
    assert.equal(c.job.matchId, '333');
    assert.match(c.job.jobId, /^tj_/);
    const row = rowOf(t, c.job.jobId);
    assert.equal(row.state, 'claimed');
    assert.equal(row.worker_id, 'worker-1');
    assert.equal(row.lease_until, clock.t + LEASE_MS);
    assert.equal(row.checkpoint_at, null);
    // the job is exactly the stored one, with its id and hash
    assert.equal(c.job.payloadHash, row.payload_hash);
    assert.equal(JSON.parse(row.payload).matchId, '333');
  } finally {
    await t.close();
  }
});

test('claim takes the oldest job first and never two of one stage at once; another stage is free', async () => {
  const { t, hq } = await start({ stores: [L1, L2] });
  try {
    await finish(t, hq, L1, 0, 'a1');
    await finish(t, hq, L2, 0, 'b1');
    await finish(t, hq, L1, 1, 'a2');
    const first = await claimed(t, 'worker-1');
    assert.equal(first.job.matchId, '333', 'the oldest');
    // the same stage is busy: the next claim gets the other stage's job, not 334
    const second = await claimed(t, 'worker-2');
    assert.equal(second.job.matchId, '433');
    assert.equal((await claim(t, 'worker-3')).body, null, 'both stages are busy');
    assert.equal((await claim(t, 'worker-3', SCOPE1)).body, null);
    // done frees the stage
    assert.equal((await ack(t, first, 'done', 'VERIFIED')).status, 200);
    const third = await claimed(t, 'worker-3', SCOPE1);
    assert.equal(third.job.matchId, '334');
  } finally {
    await t.close();
  }
});

test('a later revision of a match waits for the earlier one: pending, claimed and needs-human block it; done and failed do not', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1'); // revision 1
    await undo(t, hq, L1, 0, 'a1'); // revision 2: match.reset
    const rows = rowsOf(t);
    assert.deepEqual(rows.map((r) => [r.revision, r.state]), [[1, 'pending'], [2, 'pending']]);
    assert.equal(JSON.parse(rows[1].payload).kind, 'match.reset');

    // revision 1 goes first, and while it's claimed nothing else is given
    const c1 = await claimed(t);
    assert.equal(c1.job.revision, 1);
    assert.equal((await claim(t, 'worker-2')).body, null);
    // needs-human blocks revision 2 too
    assert.equal((await ack(t, c1, 'needs-human', 'REVIEW_REQUIRED')).status, 200);
    assert.equal((await claim(t)).body, null, 'revision 1 needs a person; revision 2 waits');
    assert.equal(rowsOf(t)[1].state, 'pending');
  } finally {
    await t.close();
  }
  // failed lets it through
  const f = await start();
  try {
    await finish(f.t, f.hq, L1, 0, 'a1');
    await undo(f.t, f.hq, L1, 0, 'a1');
    const c1 = await claimed(f.t);
    assert.equal((await ack(f.t, c1, 'failed', 'REMOTE_REJECTED')).status, 200);
    const c2 = await claimed(f.t);
    assert.equal(c2.job.revision, 2);
    assert.equal(c2.job.kind, 'match.reset');
    assert.equal((await ack(f.t, c2, 'done', 'VERIFIED')).status, 200);
  } finally {
    await f.t.close();
  }
  // a retry that is not due yet keeps revision 2 waiting, then revision 1 comes first
  const w = await start();
  try {
    await finish(w.t, w.hq, L1, 0, 'a1');
    await undo(w.t, w.hq, L1, 0, 'a1');
    const c1 = await claimed(w.t);
    const later = new Date(clock.t + 5 * MIN).toISOString();
    const r = await ack(w.t, c1, 'retry', 'PRE_SAVE_TRANSIENT', { nextAttemptAt: later });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.state, 'pending');
    assert.equal((await claim(w.t)).body, null, 'not due, and revision 2 waits behind it');
    clock.t += 5 * MIN + SEC;
    const again = await claimed(w.t);
    assert.equal(again.job.revision, 1);
    assert.equal(again.attempt, 2);
    assert.equal(again.recoveryRequired, false, 'a proven pre-save retry needs no recovery');
  } finally {
    await w.t.close();
  }
});

test('concurrent claims never give a job twice, nor two jobs of one stage', async () => {
  const { t, hq } = await start({ stores: [L1, L2] });
  try {
    await finish(t, hq, L1, 0, 'a1');
    await finish(t, hq, L1, 1, 'a2');
    await finish(t, hq, L2, 0, 'b1');
    await finish(t, hq, L2, 1, 'b2');
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => claim(t, `worker-${i}`)));
    const got = results.map((r) => r.body).filter(Boolean);
    assert.equal(got.length, 2, 'one job per stage, two stages');
    assert.equal(new Set(got.map((c: any) => c.job.jobId)).size, 2);
    assert.equal(new Set(got.map((c: any) => c.job.stageId)).size, 2);
    assert.equal(rowsOf(t).filter((r) => r.state === 'claimed').length, 2);
    assert.equal(new Set(got.map((c: any) => c.claimToken)).size, 2);
  } finally {
    await t.close();
  }
});

/* ---------- heartbeat, checkpoint, ack ---------- */

test('heartbeat extends the lease; a late worker, a stale token, a wrong hash, revision or worker are 409 with a fixed code', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    const c = await claimed(t);
    clock.t += MIN;
    const hb = await call(t, 'heartbeat', idOf(c));
    assert.equal(hb.status, 200, hb.text);
    assert.equal(hb.body.ok, true);
    assert.equal(hb.body.leaseUntil, new Date(clock.t + LEASE_MS).toISOString());
    assert.equal(rowOf(t, c.job.jobId).lease_until, clock.t + LEASE_MS);
    // 90 s later the first lease would be over, the extended one is not
    clock.t += 90 * SEC;
    assert.equal((await call(t, 'heartbeat', idOf(c))).status, 200);

    const refused = async (patch: Record<string, unknown>, code: string, route = 'heartbeat') => {
      const r = await call(t, route, { ...idOf(c), ...(route === 'checkpoint' ? { phase: 'before-save' } : {}), ...patch });
      assert.equal(r.status, 409, `${code}: ${r.text}`);
      assert.equal(r.body.error, code);
    };
    await refused({ claimToken: 'x'.repeat(32) }, 'stale_token');
    await refused({ payloadHash: 'a'.repeat(64) }, 'wrong_hash');
    await refused({ revision: 2 }, 'wrong_revision');
    await refused({ workerId: 'worker-2' }, 'wrong_worker');
    await refused({ claimToken: 'x'.repeat(32) }, 'stale_token', 'checkpoint');
    assert.equal((await call(t, 'ack', { ...idOf(c), claimToken: 'x'.repeat(32), status: 'done', code: 'VERIFIED' })).status, 409);
    assert.equal(rowOf(t, c.job.jobId).state, 'claimed', 'none of those changed the job');
    const unknown = await call(t, 'heartbeat', { ...idOf(c), jobId: 'tj_doesnotexist0000' });
    assert.equal(unknown.status, 404);

    // after the lease runs out the worker is too late: not_claimed (or someone else's claim)
    clock.t += LEASE_MS + SEC;
    const late = await call(t, 'heartbeat', idOf(c));
    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'not_claimed');
    const again = await claimed(t, 'worker-2');
    assert.equal(again.job.jobId, c.job.jobId);
    assert.notEqual(again.claimToken, c.claimToken);
    const old = await call(t, 'heartbeat', idOf(c));
    assert.equal(old.status, 409);
    assert.equal(old.body.error, 'stale_token', 'the first claim is stale once the job is claimed again');
  } finally {
    await t.close();
  }
});

test('a job that is acked is no longer claimed: a second ack, heartbeat or checkpoint is 409', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    const c = await claimed(t);
    const r = await ack(t, c, 'done', 'VERIFIED', { observedRemoteIds: ['333', '1001'] });
    assert.deepEqual(r.body, { ok: true, state: 'done', code: 'VERIFIED' });
    for (const route of ['heartbeat', 'checkpoint', 'ack']) {
      const x = await call(t, route, { ...idOf(c), phase: 'before-save', status: 'done', code: 'VERIFIED' });
      assert.equal(x.status, 409, route);
      assert.equal(x.body.error, 'not_claimed');
    }
    const row = rowOf(t, c.job.jobId);
    assert.equal(row.state, 'done');
    assert.equal(row.code, 'VERIFIED');
    assert.equal(row.claim_token, null);
    assert.equal(row.lease_until, null);
    const last = historyOf(t, c.job.jobId).at(-1);
    assert.deepEqual(last, { at: new Date(clock.t).toISOString(), state: 'done', code: 'VERIFIED', attempt: 1, workerId: 'worker-1', observedRemoteIds: ['333', '1001'] });
  } finally {
    await t.close();
  }
});

test('after a checkpoint a retry is refused (409), but done, failed and needs-human are accepted', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    await finish(t, hq, L1, 1, 'a2');
    const c = await claimed(t);
    const cp = await call(t, 'checkpoint', { ...idOf(c), phase: 'before-save' });
    assert.equal(cp.status, 200, cp.text);
    assert.equal(rowOf(t, c.job.jobId).checkpoint_at, clock.t);
    assert.equal((await call(t, 'checkpoint', { ...idOf(c), phase: 'before-save' })).status, 200, 'saying it twice changes nothing');
    assert.equal(historyOf(t, c.job.jobId).filter((h) => h.code === 'checkpoint').length, 1);
    const retry = await ack(t, c, 'retry', 'PRE_SAVE_TRANSIENT');
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, 'checkpoint_reached');
    const pending = await ack(t, c, 'pending', 'PRE_SAVE_TRANSIENT'); // the client’s word for retry
    assert.equal(pending.status, 409);
    assert.equal(rowOf(t, c.job.jobId).state, 'claimed', 'still the worker’s to settle');
    const nh = await ack(t, c, 'needs-human', 'UNCERTAIN_EFFECT');
    assert.deepEqual(nh.body, { ok: true, state: 'needs-human', code: 'UNCERTAIN_EFFECT' });
  } finally {
    await t.close();
  }
});

test('retry goes back to pending with a backoff, status "pending" means retry, and the fifth attempt’s retry fails the job', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    let id = '';
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      const c = await claimed(t);
      id = c.job.jobId;
      assert.equal(c.attempt, n);
      const r = await ack(t, c, n % 2 ? 'retry' : 'pending', 'REMOTE_READ_TRANSIENT');
      assert.equal(r.status, 200, r.text);
      if (n < MAX_ATTEMPTS) {
        assert.equal(r.body.state, 'pending');
        assert.ok(rowOf(t, id).next_attempt_at > clock.t, 'a backoff, not at once');
        assert.equal((await claim(t)).body, null, 'not due yet');
        clock.t += MIN + SEC;
      } else assert.deepEqual(r.body, { ok: true, state: 'failed', code: 'too-many-attempts' });
    }
    const row = rowOf(t, id);
    assert.equal(row.state, 'failed');
    assert.equal(row.code, 'too-many-attempts');
    assert.equal(row.attempt, MAX_ATTEMPTS);
    clock.t += 10 * MIN;
    assert.equal((await claim(t)).body, null, 'never claimed again');
  } finally {
    await t.close();
  }
});

test('a job that keeps losing its lease runs out of attempts instead of being claimed forever', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      const c = await claimed(t);
      assert.equal(c.attempt, n);
      clock.t += LEASE_MS + SEC;
    }
    assert.equal((await claim(t)).body, null);
    const row = rowsOf(t)[0];
    assert.equal(row.state, 'failed');
    assert.equal(row.code, 'too-many-attempts');
  } finally {
    await t.close();
  }
});

/* ---------- lease expiry ---------- */

test('a lease that runs out without a checkpoint puts the job back to pending, and the next claim must recover', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    const c = await claimed(t);
    clock.t += LEASE_MS + SEC;
    const next = await claimed(t, 'worker-2');
    assert.equal(next.job.jobId, c.job.jobId);
    assert.equal(next.attempt, 2);
    assert.equal(next.recoveryRequired, true);
    assert.deepEqual(historyOf(t, c.job.jobId).map((h) => [h.state, h.code, h.attempt]), [['pending', 'created', 0], ['claimed', 'claimed', 1], ['pending', 'lease-expired', 1], ['claimed', 'claimed', 2]]);
  } finally {
    await t.close();
  }
});

test('a lease that runs out after a checkpoint is needs-human, never claimed again', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    const c = await claimed(t);
    assert.equal((await call(t, 'checkpoint', { ...idOf(c), phase: 'before-save' })).status, 200);
    clock.t += LEASE_MS + SEC;
    assert.equal((await claim(t, 'worker-2')).body, null);
    const row = rowOf(t, c.job.jobId);
    assert.equal(row.state, 'needs-human');
    assert.equal(row.code, 'lease-expired-after-checkpoint');
    assert.equal(row.claim_token, null);
    assert.deepEqual(historyOf(t, c.job.jobId).map((h) => h.code), ['created', 'claimed', 'checkpoint', 'lease-expired-after-checkpoint']);
    clock.t += 60 * MIN;
    assert.equal((await claim(t)).body, null);
  } finally {
    await t.close();
  }
});

test('the one-minute timer runs the expiry without any worker call', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    const c = await claimed(t);
    clock.t += LEASE_MS + SEC;
    assert.equal(rowOf(t, c.job.jobId).state, 'claimed', 'nothing has looked yet');
    assert.equal(t.api.toornamentJobs.expireLeases(), 1, 'what the timer calls');
    assert.equal(rowOf(t, c.job.jobId).state, 'pending');
    assert.equal(t.api.toornamentJobs.expireLeases(), 0);
  } finally {
    await t.close();
  }
});

/* ---------- strict input ---------- */

test('bad input is 400: not JSON, wrong types, too many scopes, bad ids, status, code and ids; an over-long body is 413', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    const c = await claimed(t);
    const id = idOf(c);
    const bad = async (route: string, body: unknown, what: string, o: { raw?: string } = {}) => {
      const r = await call(t, route, body, o);
      assert.equal(r.status, 400, `${what}: ${r.text}`);
      assert.equal(r.body.error, 'invalid_body');
      assert.ok(!r.text.includes(KEY));
    };
    await bad('claim', null, 'not JSON', { raw: '{nope' });
    await bad('claim', [], 'an array');
    await bad('claim', { scopes: SCOPE1 }, 'no workerId');
    await bad('claim', { workerId: '', scopes: SCOPE1 }, 'empty workerId');
    await bad('claim', { workerId: 'w'.repeat(65), scopes: SCOPE1 }, 'long workerId');
    await bad('claim', { workerId: 7, scopes: SCOPE1 }, 'numeric workerId');
    await bad('claim', { workerId: 'w' }, 'no scopes');
    await bad('claim', { workerId: 'w', scopes: [] }, 'empty scopes');
    await bad('claim', { workerId: 'w', scopes: Array.from({ length: 51 }, (_, i) => ({ tournamentId: String(i), stageId: '1' })) }, '51 scopes');
    await bad('claim', { workerId: 'w', scopes: [{ tournamentId: 111, stageId: '222' }] }, 'a numeric id');
    await bad('claim', { workerId: 'w', scopes: [{ tournamentId: '111' }] }, 'no stageId');
    await bad('claim', { workerId: 'w', scopes: ['111/222'] }, 'a string scope');
    await bad('claim', { workerId: 'w', scopes: [{ tournamentId: "1'; DROP", stageId: '2' }] }, 'odd characters');
    const okScopes = Array.from({ length: 50 }, (_, i) => ({ tournamentId: String(900 + i), stageId: '1' }));
    assert.equal((await call(t, 'claim', { workerId: 'w', scopes: okScopes })).status, 200, '50 scopes are fine');

    await bad('heartbeat', {}, 'no identity');
    await bad('heartbeat', { ...id, jobId: 5 }, 'numeric jobId');
    await bad('heartbeat', { ...id, jobId: 'job-1' }, 'jobId that is not ours');
    await bad('heartbeat', { ...id, payloadHash: 'abc' }, 'short hash');
    await bad('heartbeat', { ...id, revision: '1' }, 'string revision');
    await bad('heartbeat', { ...id, revision: 0 }, 'revision 0');
    await bad('heartbeat', { ...id, revision: 1.5 }, 'fractional revision');
    await bad('heartbeat', { ...id, claimToken: 'short' }, 'short token');
    await bad('heartbeat', { ...id, workerId: undefined }, 'no workerId');
    await bad('checkpoint', id, 'no phase');
    await bad('checkpoint', { ...id, phase: 'after-save' }, 'another phase');
    const a = { ...id, status: 'done', code: 'VERIFIED' };
    await bad('ack', { ...a, status: 'finished' }, 'unknown status');
    await bad('ack', { ...a, status: undefined }, 'no status');
    await bad('ack', { ...a, code: undefined }, 'no code');
    await bad('ack', { ...a, code: 'Has Spaces' }, 'code with spaces');
    await bad('ack', { ...a, code: 'x'.repeat(65) }, 'long code');
    await bad('ack', { ...a, code: 'lower_snake' }, 'lower_snake is neither style');
    await bad('ack', { ...a, nextAttemptAt: 'tomorrow' }, 'bad time');
    await bad('ack', { ...a, nextAttemptAt: 12345 }, 'numeric time');
    await bad('ack', { ...a, observedRemoteIds: '333' }, 'ids not a list');
    await bad('ack', { ...a, observedRemoteIds: [333] }, 'numeric id');
    await bad('ack', { ...a, observedRemoteIds: Array.from({ length: 101 }, (_, i) => String(i)) }, '101 ids');
    await bad('ack', { ...a, observedRemoteIds: ['has a space'] }, 'odd id');
    assert.equal(rowOf(t, c.job.jobId).state, 'claimed', 'none of the bad requests changed anything');

    const big = await call(t, 'claim', { workerId: 'w', scopes: SCOPE1, pad: 'x'.repeat(20 * 1024) });
    assert.equal(big.status, 413);
    assert.equal(big.body.error, 'body_too_large');
  } finally {
    await t.close();
  }
});

test('both code styles are accepted: lowercase-with-hyphens, and the automation’s UPPER_SNAKE', async () => {
  const { t, hq } = await start();
  try {
    await finish(t, hq, L1, 0, 'a1');
    await finish(t, hq, L1, 1, 'a2');
    const a = await claimed(t);
    assert.equal((await ack(t, a, 'done', 'verified-on-public-page')).status, 200);
    const b = await claimed(t);
    assert.equal((await ack(t, b, 'needs-human', 'SCOPE_DENIED')).status, 200);
    assert.equal(rowOf(t, b.job.jobId).code, 'SCOPE_DENIED');
  } finally {
    await t.close();
  }
});

/* ---------- what is kept and logged ---------- */

test('history holds codes, ids and times only; the logs hold no key, token, name or payload', async () => {
  const lines: string[] = [];
  const log: Logger = (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields }));
  const { t, hq } = await start({ log });
  try {
    await finish(t, hq, L1, 0, 'a1');
    const c = await claimed(t);
    await call(t, 'heartbeat', idOf(c));
    await call(t, 'checkpoint', { ...idOf(c), phase: 'before-save' });
    await ack(t, c, 'done', 'VERIFIED', { observedRemoteIds: ['333', 'x'.repeat(200), ...Array.from({ length: 20 }, (_, i) => `id${i}`)] });
    await call(t, 'claim', { workerId: 'w', scopes: SCOPE1 }, { key: 'not-the-key-not-the-key' });
    // a lease that runs out (second job) so that path logs too
    await finish(t, hq, L1, 1, 'a2');
    const d = await claimed(t, 'worker-2');
    clock.t += LEASE_MS + SEC;
    t.api.toornamentJobs.expireLeases();

    const history = historyOf(t, c.job.jobId);
    const allowed = new Set(['at', 'state', 'code', 'attempt', 'workerId', 'observedRemoteIds']);
    for (const h of history) for (const k of Object.keys(h)) assert.ok(allowed.has(k), `unexpected history field ${k}`);
    const last = history.at(-1);
    assert.equal(last.observedRemoteIds.length, 10, 'capped at 10');
    assert.ok(last.observedRemoteIds.every((s: string) => s.length <= 40), 'long ids are dropped');
    const everything = rowsOf(t).map((r) => r.history).join('\n') + '\n' + lines.join('\n');
    for (const secret of [KEY, STEAM_KEY, c.claimToken, d.claimToken, ...NAMES, 'Test Cup', 'Playoffs', 'expectedPrevious', 'toornamentLabel']) {
      assert.ok(!everything.includes(secret), `leaked ${secret.slice(0, 6)}…`);
    }
    assert.ok(lines.some((l) => l.includes('toornament-job-claimed')), 'ids and codes are logged');
  } finally {
    await t.close();
  }
});
