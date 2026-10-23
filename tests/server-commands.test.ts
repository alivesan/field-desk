import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic, TINY_JPEG, SUPER } from './helpers/server.ts';
import { tournamentCommand } from '../src/lib/tournament.ts';
import { submissionCommand } from '../src/lib/submission.ts';
import { CommandError } from '../src/lib/command-types.ts';

type T = Awaited<ReturnType<typeof startTestServer>>;
const command = (t: T, cookie: string, id: string, storeId: string, cmd: unknown) => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId, cmd } });

// The handlers live in other workstreams' files; tests that need them are marked todo while they're stubs.
const isStub = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof CommandError && /not implemented/.test(e.message);
  }
};
const ctx = { commandId: 'probe-0001', now: '2026-10-24T10:00:00.000Z', actor: { principal: 'super', name: 'HQ', role: 'super' as const }, event: {} as any };
const tournamentReady = !isStub(() => tournamentCommand({ day: { players: [], checkIn: {}, matches: [], stations: 2 } } as any, { type: 'stations.set', base: 0, count: 2 }, ctx));
const submissionReady = !isStub(() => submissionCommand({ recce: {}, submissions: [] } as any, { type: 'recce.submit', base: 0 }, ctx));

const players = [
  { id: 'p1', name: 'Asha', seed: 1 },
  { id: 'p2', name: 'Bilal', seed: 2 },
  { id: 'p3', name: 'Chen', seed: 3 },
  { id: 'p4', name: 'Dev', seed: 4 },
];

/** HQ loads the bracket (HQ-only); the admin (cookie) then checks everyone in. */
async function bracketReady(t: T, cookie: string) {
  const hq = await t.login(SUPER);
  const r = await command(t, hq, 'load-bracket-01', 's1', { type: 'bracket.load', base: 0, players });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const at = '2026-10-24T09:00:00.000Z';
  const ci = await t.json('/api/batch', { method: 'POST', cookie, body: { id: 'checkin-all-01', ops: [{ k: 'stores', id: 's1', p: ['day', 'checkIn'], v: { p1: at, p2: at, p3: at, p4: at } }] } });
  assert.equal(ci.status, 200, JSON.stringify(ci.body));
  const s = await t.json('/api/state', { cookie });
  return s.body.stores.s1.day;
}

test('command endpoint: envelope and role checks', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    const a1 = await t.login('AAA2');
    let r = await command(t, a1, 'x', 's1', { type: 'stations.set', base: 0, count: 2 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'bad-request');
    r = await command(t, a1, 'cmd-shape-0001', 's1', { type: 'nope', base: 0 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid');
    r = await command(t, a1, 'cmd-shape-0002', 's1', { type: 'stations.set', base: 0, count: 999 });
    assert.equal(r.status, 400);
    r = await command(t, a1, 'cmd-other-0001', 's2', { type: 'stations.set', base: 0, count: 3 });
    assert.equal(r.status, 403);
    r = await command(t, a1, 'cmd-role-00001', 's1', { type: 'recce.review', base: 0, submissionId: 'whatever' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'forbidden');
    r = await command(t, hq, 'cmd-nostore-01', 'nope', { type: 'stations.set', base: 0, count: 3 });
    assert.equal(r.status, 404);
    assert.equal((await t.json('/api/command', { method: 'POST', body: { id: 'cmd-anon-0001', storeId: 's1', cmd: { type: 'stations.set', base: 0, count: 2 } } })).status, 401);
  } finally {
    await t.close();
  }
});

test('command endpoint: commits like a batch — new seq, broadcast, idempotent retry, id reuse 409', { todo: tournamentReady ? undefined : 'needs tournament handler' }, async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const before = (await t.json('/api/state', { cookie: a1 })).body;
    const cmd = { type: 'stations.set', base: 0, count: 4 };
    const r = await command(t, a1, 'cmd-stations-1', 's1', cmd);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seq, before.seq + 1);
    const after = (await t.json('/api/state', { cookie: a1 })).body;
    assert.equal(after.stores.s1.day.stations, 4);
    assert.equal(after.stores.s1.day.version, 1);
    // retry after a lost response: same seq, applied once
    const retry = await command(t, a1, 'cmd-stations-1', 's1', { count: 4, base: 0, type: 'stations.set' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.seq, r.body.seq);
    assert.equal((await t.json('/api/state', { cookie: a1 })).body.stores.s1.day.version, 1);
    // same id, different command
    const reused = await command(t, a1, 'cmd-stations-1', 's1', { type: 'stations.set', base: 1, count: 5 });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.code, 'batch-id-reused');
    // command ids and batch ids are separate namespaces
    const b = await t.json('/api/batch', { method: 'POST', cookie: a1, body: { id: 'cmd-stations-1', ops: [{ k: 'stores', id: 's1', p: ['recce', 'summary'], v: 'x' }] } });
    assert.equal(b.status, 200);
  } finally {
    await t.close();
  }
});

test('command endpoint: two concurrent match.start on one station → exactly one wins, the other 409 conflict', { todo: tournamentReady ? undefined : 'needs tournament handler' }, async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const hq = await t.login('synthetic-hq-code-for-tests-0001');
    const day = await bracketReady(t, a1);
    const firstRound = day.matches.filter((m: any) => m.round === 0 && m.a && m.b);
    assert.equal(firstRound.length, 2);
    const [x, y] = firstRound;
    const [r1, r2] = await Promise.all([
      command(t, a1, 'start-x-st1-01', 's1', { type: 'match.start', base: day.version, matchId: x.id, station: 1 }),
      command(t, hq, 'start-y-st1-01', 's1', { type: 'match.start', base: day.version, matchId: y.id, station: 1 }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify([r1.body, r2.body]));
    const lost = r1.status === 409 ? r1 : r2;
    assert.equal(lost.body.code, 'conflict');
    assert.equal(typeof lost.body.error, 'string');
    const after = (await t.json('/api/state', { cookie: a1 })).body.stores.s1.day;
    assert.equal(after.matches.filter((m: any) => m.status === 'live' && m.station === 1).length, 1);
    // the loser can take station 2
    const other = r1.status === 409 ? x : y;
    const r3 = await command(t, a1, 'start-other-s2', 's1', { type: 'match.start', base: after.version, matchId: other.id, station: 2 });
    assert.equal(r3.status, 200, JSON.stringify(r3.body));
  } finally {
    await t.close();
  }
});

test('command endpoint: server time and actor are used, not the device’s', { todo: tournamentReady ? undefined : 'needs tournament handler' }, async () => {
  const clock = Date.parse('2026-10-24T11:22:33.000Z');
  const t = await startTestServer({ now: () => clock });
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const day = await bracketReady(t, a1);
    const m = day.matches.find((x: any) => x.round === 0 && x.a && x.b);
    const r = await command(t, a1, 'start-time-001', 's1', { type: 'match.start', base: day.version, matchId: m.id, station: 1, startedAt: '1999-01-01T00:00:00.000Z' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const live = (await t.json('/api/state', { cookie: a1 })).body.stores.s1.day.matches.find((x: any) => x.id === m.id);
    assert.equal(live.startedAt, '2026-10-24T11:22:33.000Z');
  } finally {
    await t.close();
  }
});

test('command endpoint: recce.submit freezes a revision with server actor; its photos stay owned by the store', { todo: submissionReady ? undefined : 'needs submission handler' }, async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const up = await t.req('/api/photos/subphoto1?store=s1', { method: 'PUT', cookie: a1, headers: { 'Content-Type': 'image/jpeg' }, body: TINY_JPEG });
    assert.equal(up.status, 201);
    const ref = { id: 'subphoto1', label: 'Venue', takenAt: '2026-10-20T10:00:00.000Z', fileTime: '2026-10-20T10:00:00.000Z', live: true, geo: null };
    assert.equal((await t.json('/api/batch', { method: 'POST', cookie: a1, body: { id: 'sub-photo-ref1', ops: [{ k: 'stores', id: 's1', p: ['recce', 'venue', 'photos'], v: [ref] }] } })).status, 200);
    const r = await command(t, a1, 'submit-recce-1', 's1', { type: 'recce.submit', base: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = (await t.json('/api/state', { cookie: a1 })).body.stores.s1;
    assert.equal(s.submissions.length, 1);
    assert.equal(s.submissions[0].by, 'admin:a1');
    assert.deepEqual(s.submissions[0].recce.venue.photos.map((p: any) => p.id), ['subphoto1']);
    // stale base → conflict
    const stale = await command(t, a1, 'submit-recce-2', 's1', { type: 'recce.submit', base: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'conflict');
  } finally {
    await t.close();
  }
});
