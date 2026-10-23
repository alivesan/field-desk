/*
 * Winner + runner-up details over the real API: the admin saves them for their own store only,
 * not before the final, who they are comes from the final, bad fields are refused, retries are
 * applied once, and day.winners changes only through winners.set (batches get 403).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic, SUPER } from './helpers/server.ts';

const players = [
  { id: 'p1', name: 'Asha R.', seed: 1, phone: '9820011111' },
  { id: 'p2', name: 'Bilal', seed: 2 },
];

async function setup() {
  const t = await startTestServer();
  await seedBasic(t);
  const admin = await t.login('AAA2');
  const other = await t.login('BBB3');
  const hq = await t.login(SUPER);
  const cmd = (cookie: string, id: string, c: unknown, storeId = 's1') => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId, cmd: c } });
  const store = async (cookie = hq, id = 's1') => (await t.json('/api/state', { cookie })).body.stores[id];
  /** HQ loads two players; the admin checks them in and plays the final (p2 wins). Returns the final's id. */
  const playFinal = async () => {
    assert.equal((await cmd(hq, 'hq-load-final-1', { type: 'bracket.load', base: 0, players })).status, 200);
    const d = (await store()).day;
    const ci = await t.json('/api/batch', { method: 'POST', cookie: admin, body: { id: 'ci-final-000001', ops: ['p1', 'p2'].map((p) => ({ k: 'stores', id: 's1', p: ['day', 'checkIn', p], v: '2026-10-24T09:00:00.000Z' })) } });
    assert.equal(ci.status, 200, JSON.stringify(ci.body));
    const m = d.matches[0];
    assert.equal((await cmd(admin, 'st-final-000001', { type: 'match.start', base: d.version, matchId: m.id, station: 1 })).status, 200);
    assert.equal((await cmd(admin, 'fin-final-00001', { type: 'match.finish', base: d.version, matchId: m.id, winner: 'p2' })).status, 200);
    return m.id as string;
  };
  return { t, admin, other, hq, cmd, store, playFinal };
}

const body = (over: Record<string, unknown> = {}) => ({
  type: 'winners.set',
  base: 0,
  winner: { realName: 'Bilal Khan', email: 'Bilal@Example.com', instagram: 'https://instagram.com/bilal.k/' },
  runnerUp: { realName: 'Asha Rao', phone: '+91 98200 11111' },
  ...over,
});

test('refused before the final; after it, the admin saves — ids from the final, even if the client sneaks playerId', async () => {
  const { t, admin, hq, cmd, store, playFinal } = await setup();
  try {
    const early = await cmd(admin, 'win-early-0001', body());
    assert.equal(early.status, 409, JSON.stringify(early.body));
    assert.match(early.body.error, /Record the final first/);

    const fid = await playFinal();
    const sneak = await cmd(admin, 'win-save-0001', body({ winner: { realName: 'Bilal Khan', playerId: 'p1' }, runnerUp: { realName: 'Asha Rao', playerId: 'p2' } }));
    assert.equal(sneak.status, 200, JSON.stringify(sneak.body));
    const w = (await store(admin)).day.winners;
    assert.equal(w.winner.playerId, 'p2');
    assert.equal(w.runnerUp.playerId, 'p1');
    assert.equal(w.finalMatchId, fid);
    assert.equal(w.by, 'Synthetic a1');

    // saving again (HQ too) updates; the first-saved time stays
    const again = await cmd(hq, 'win-save-0002', body());
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const w2 = (await store()).day.winners;
    assert.equal(w2.at, w.at);
    assert.equal(w2.by, 'HQ');
    assert.deepEqual(w2.winner, { playerId: 'p2', realName: 'Bilal Khan', email: 'bilal@example.com', instagram: 'bilal.k' });
    assert.deepEqual(w2.runnerUp, { playerId: 'p1', realName: 'Asha Rao', phone: '9820011111' });
  } finally {
    await t.close();
  }
});

test('an admin cannot save another store’s winners (403); the store is untouched', async () => {
  const { t, other, hq, cmd, store, playFinal } = await setup();
  try {
    await playFinal();
    const r = await cmd(other, 'win-other-0001', body());
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal((await store(hq)).day.winners, undefined);
  } finally {
    await t.close();
  }
});

test('invalid email / instagram / phone → 400 with a plain message; nothing saved', async () => {
  const { t, admin, hq, cmd, store, playFinal } = await setup();
  try {
    await playFinal();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ winner: { realName: 'B', email: 'bilal@' } }, /Winner’s email doesn’t look right/],
      [{ runnerUp: { realName: 'A', instagram: 'not valid!' } }, /Runner-up’s Instagram/],
      [{ runnerUp: { realName: 'A', phone: '123' } }, /Runner-up’s phone number/],
    ];
    for (const [i, [over, msg]] of cases.entries()) {
      const r = await cmd(admin, `win-bad-000${i}`, body(over));
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, msg);
    }
    const shape = await cmd(admin, 'win-bad-shape', { type: 'winners.set', base: 0, winner: 'Bilal', runnerUp: {} });
    assert.equal(shape.status, 400);
    assert.equal((await store(hq)).day.winners, undefined);
  } finally {
    await t.close();
  }
});

test('a retry after a lost response is applied once', async () => {
  const { t, admin, cmd, store, playFinal } = await setup();
  try {
    await playFinal();
    const v0 = (await store()).day.version;
    const first = await cmd(admin, 'win-retry-0001', body());
    const again = await cmd(admin, 'win-retry-0001', body());
    assert.equal(first.status, 200);
    assert.deepEqual(again.body, first.body);
    assert.equal((await store()).day.version, v0 + 1, 'one bump, not two');
  } finally {
    await t.close();
  }
});

test('day.winners is command-only: a batch that writes it is 403 protected, for HQ too', async () => {
  const { t, admin, hq, cmd, store, playFinal } = await setup();
  try {
    await playFinal();
    const forged = { winner: { playerId: 'p1', realName: 'Mallory' }, runnerUp: { playerId: 'p2', realName: 'X' }, finalMatchId: 'x', at: '2026-10-24T10:00:00.000Z', updatedAt: '2026-10-24T10:00:00.000Z', by: 'me' };
    for (const [i, who] of [admin, hq].entries()) {
      const r = await t.json('/api/batch', { method: 'POST', cookie: who, body: { id: `b-win-forge-000${i}`, ops: [{ k: 'stores', id: 's1', p: ['day', 'winners'], v: forged }] } });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.deepEqual(r.body.paths, ['stores/s1.day.winners']);
    }
    assert.equal((await cmd(admin, 'win-save-9999', body())).status, 200);
    const saved = (await store()).day.winners;
    const wipe = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'b-win-wipe-00001', ops: [{ k: 'stores', id: 's1', p: ['day', 'winners', 'by'], v: 'someone else' }] } });
    assert.equal(wipe.status, 403, JSON.stringify(wipe.body));
    assert.deepEqual((await store()).day.winners, saved);
  } finally {
    await t.close();
  }
});

test('bracket.reset keeps the saved winners', async () => {
  const { t, admin, hq, cmd, store, playFinal } = await setup();
  try {
    await playFinal();
    assert.equal((await cmd(admin, 'win-save-0003', body())).status, 200);
    const before = (await store()).day;
    const r = await cmd(hq, 'hq-reset-00001', { type: 'bracket.reset', base: before.version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = (await store()).day;
    assert.equal(after.matches.length, 0);
    assert.deepEqual(after.winners, before.winners);
  } finally {
    await t.close();
  }
});
