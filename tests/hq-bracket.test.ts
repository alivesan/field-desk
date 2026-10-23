import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic, SUPER } from './helpers/server.ts';

const players = [
  { id: 'p1', name: 'Asha', seed: 1 },
  { id: 'p2', name: 'Bilal', seed: 2 },
];

test('only HQ loads or resets a bracket; the admin still runs the matches', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const hq = await t.login(SUPER);
    const cmd = (cookie: string, id: string, c: unknown) => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId: 's1', cmd: c } });

    const byAdmin = await cmd(a1, 'admin-load-01', { type: 'bracket.load', base: 0, players });
    assert.equal(byAdmin.status, 403);
    assert.equal(byAdmin.body.code, 'forbidden');

    const byHq = await cmd(hq, 'hq-load-0001', { type: 'bracket.load', base: 0, players });
    assert.equal(byHq.status, 200, JSON.stringify(byHq.body));

    const resetByAdmin = await cmd(a1, 'admin-reset-1', { type: 'bracket.reset', base: 1 });
    assert.equal(resetByAdmin.status, 403);

    // the admin checks players in and calls the match
    const ci = await t.json('/api/batch', { method: 'POST', cookie: a1, body: { id: 'ci-both-0001', ops: [{ k: 'stores', id: 's1', p: ['day', 'checkIn'], v: { p1: '2026-10-24T09:00:00.000Z', p2: '2026-10-24T09:00:00.000Z' } }] } });
    assert.equal(ci.status, 200, JSON.stringify(ci.body));
    const day = (await t.json('/api/state', { cookie: a1 })).body.stores.s1.day;
    const start = await cmd(a1, 'admin-start-1', { type: 'match.start', base: day.version, matchId: day.matches[0].id, station: 1 });
    assert.equal(start.status, 200, JSON.stringify(start.body));
  } finally {
    await t.close();
  }
});

test('HQ can reset a bracket even after check-ins and a finished match', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const hq = await t.login(SUPER);
    const cmd = (cookie: string, id: string, c: unknown) => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId: 's1', cmd: c } });
    assert.equal((await cmd(hq, 'hq-load-0002', { type: 'bracket.load', base: 0, players })).status, 200);
    await t.json('/api/batch', { method: 'POST', cookie: a1, body: { id: 'ci-both-0002', ops: [{ k: 'stores', id: 's1', p: ['day', 'checkIn'], v: { p1: '2026-10-24T09:00:00.000Z', p2: '2026-10-24T09:00:00.000Z' } }] } });
    let day = (await t.json('/api/state', { cookie: hq })).body.stores.s1.day;
    assert.equal((await cmd(a1, 'start-0002', { type: 'match.start', base: day.version, matchId: day.matches[0].id, station: 1 })).status, 200);
    assert.equal((await cmd(a1, 'finish-0002', { type: 'match.finish', base: day.version + 1, matchId: day.matches[0].id, winner: 'p1' })).status, 200);
    day = (await t.json('/api/state', { cookie: hq })).body.stores.s1.day;
    const r = await cmd(hq, 'hq-reset-0002', { type: 'bracket.reset', base: day.version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await t.json('/api/state', { cookie: hq })).body.stores.s1.day.matches.length, 0);
  } finally {
    await t.close();
  }
});
