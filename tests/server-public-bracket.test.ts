import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic, fixtureStore, writeDocForTests, SUPER, type TestServer } from './helpers/server.ts';
import { buildBracket, resolve } from '../src/lib/bracket.ts';
import type { Logger } from '../server/log.ts';

/* The public live bracket: GET /api/public/bracket/:token, no session. */

const TOKEN = 'brk_S1-synthetic-0001';
const TOKEN2 = 'brk_S2-synthetic-0002';
const NEW_TOKEN = 'brk_S1-rotated-0000003';
const players = [
  { id: 'hash-a', name: 'Asha Rao', seed: 1, phone: '9820011111', ign: 'AshaX' },
  { id: 'hash-b', name: 'Vikram', seed: 2, phone: '9820022222' },
  { id: 'hash-c', name: 'Meera Nair', seed: 3, phone: '9820033333' },
  { id: 'hash-d', name: 'Kabir Singh', seed: 4, phone: '9820044444' },
];
const SECRETS = ['9820011111', '9820022222', '9820033333', '9820044444', '9820055555', 'asha.private@example.test', 'asha_private_ig', 'Asha Realname', '2026-10-24T09:01', 'hash-a', 'hash-d'];

function dayOf(withBracket = true) {
  let matches = withBracket ? buildBracket(players, null, 'm') : [];
  if (withBracket) {
    Object.assign(matches.find((m) => m.round === 0 && m.index === 0)!, { status: 'done', winner: 'hash-a', score: '2-0', endedAt: '2026-10-24T10:00:00.000Z' });
    Object.assign(matches.find((m) => m.round === 0 && m.index === 1)!, { status: 'live', station: 2, startedAt: '2026-10-24T10:05:00.000Z' });
    matches = resolve(matches).matches; // the winner moves on to the final
  }
  return {
    players,
    checkIn: { 'hash-a': '2026-10-24T09:01:00.000Z', 'hash-b': '2026-10-24T09:02:00.000Z' },
    checkInSource: { 'hash-b': 'self' },
    matches,
    stations: 2,
    version: 4,
    selfCheckIn: { token: 'tok_S1-checkin-0000001', open: true, openedAt: '2026-10-24T09:00:00.000Z' },
    onSpot: [{ id: 'os1', playerId: 'hash-e', name: 'Walk In', phone: '9820055555', at: '2026-10-24T09:30:00.000Z', by: 'Synthetic a1' }],
    winners: {
      winner: { playerId: 'hash-a', realName: 'Asha Realname', phone: '9820011111', email: 'asha.private@example.test', instagram: 'asha_private_ig' },
      runnerUp: { playerId: 'hash-d', realName: '' },
      finalMatchId: 'm-1-0',
      at: '2026-10-24T11:00:00.000Z',
      updatedAt: '2026-10-24T11:00:00.000Z',
      by: 'Synthetic a1',
    },
  };
}

/** seedBasic, then s1 with a played bracket and the bracket link on, s2 with the link off — written straight to the database (only commands may set players and matches). */
async function setup(opts: Record<string, unknown> = {}) {
  const t0 = await startTestServer();
  await seedBasic(t0);
  await t0.close();
  const link = (token: string, on: boolean) => ({ token, on, createdAt: '2026-10-24T08:00:00.000Z' });
  writeDocForTests(t0.dataDir, 'stores', fixtureStore('s1', 'e1', 'a1', { name: 'ASUS ROG Exclusive Store — Croma Andheri', day: dayOf(), publicBracket: link(TOKEN, true) }));
  writeDocForTests(t0.dataDir, 'stores', fixtureStore('s2', 'e1', 'a2', { name: 'ASUS ROG Exclusive Store — Croma Bandra', day: dayOf(), publicBracket: link(TOKEN2, false) }));
  const t = await startTestServer({ dataDir: t0.dataDir, ...opts });
  return { t, hq: await t.login(SUPER), a1: await t.login('AAA2'), a2: await t.login('BBB3') };
}

const get = (t: TestServer, token: string, headers: Record<string, string> = {}) => t.json(`/api/public/bracket/${token}`, { headers });
const batch = (t: TestServer, cookie: string, id: string, ops: unknown[]) => t.json('/api/batch', { method: 'POST', cookie, body: { id, ops } });
const link = (token: string, on = true) => ({ token, on, createdAt: '2026-10-24T12:00:00.000Z' });

test('bracket: on → 200 with names, results and stations — and no phone, check-in, on-spot or winner detail anywhere', async () => {
  const { t } = await setup();
  try {
    const res = await t.req(`/api/public/bracket/${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.deepEqual([body.store, body.city, body.campaign, body.date, body.rounds, body.champion], ['Croma Andheri', 'Testville', 'Synthetic Campaign', '2026-10-24', 2, null]);
    assert.equal(body.game, 'Game A');
    assert.equal(body.updatedAt, '2026-10-24T10:05:00.000Z');
    const [done, live, final] = body.matches;
    assert.deepEqual([done.a, done.aIgn, done.b, done.winner, done.status, done.score, done.no], ['Asha Rao', 'AshaX', 'Kabir Singh', 'a', 'done', '2-0', 1]);
    assert.deepEqual([live.a, live.b, live.status, live.station, live.winner], ['Vikram', 'Meera Nair', 'live', 2, null]);
    assert.deepEqual([final.a, final.aSeed, final.b, final.status, final.no], ['Asha Rao', 1, null, 'pending', 3], 'the winner moved on; the other side waits');
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
    for (const key of ['phone', 'phoneEnd', 'checkIn', 'onSpot', 'winners', 'email', 'instagram', 'token']) assert.ok(!text.includes(`"${key}"`), `${key} key in the answer`);
  } finally {
    await t.close();
  }
});

test('bracket: off, unknown, malformed and rotated tokens all answer the same 404', async () => {
  const { t, hq } = await setup();
  try {
    const off = await get(t, TOKEN2);
    assert.deepEqual([off.status, off.body.code], [404, 'not-found']);
    for (const token of ['brk_unknown-00000000001', 'short', 'has%20space-000000000000', 'x'.repeat(65), 'tok_S1-checkin-0000001']) {
      const r = await get(t, token);
      assert.deepEqual([r.status, r.body], [404, off.body], token);
    }
    assert.equal((await get(t, TOKEN)).status, 200);

    // rotate: the old link is dead at once, the new one works; Off kills it too; On again brings the same link back
    assert.equal((await batch(t, hq, 'rotate-00000001', [{ k: 'stores', id: 's1', p: ['publicBracket'], v: link(NEW_TOKEN) }])).status, 200);
    assert.deepEqual([(await get(t, TOKEN)).status, (await get(t, NEW_TOKEN)).status], [404, 200]);
    assert.equal((await batch(t, hq, 'off-000000000001', [{ k: 'stores', id: 's1', p: ['publicBracket', 'on'], v: false }])).status, 200);
    assert.equal((await get(t, NEW_TOKEN)).status, 404);
    assert.equal((await batch(t, hq, 'on-0000000000001', [{ k: 'stores', id: 's1', p: ['publicBracket', 'on'], v: true }])).status, 200);
    assert.equal((await get(t, NEW_TOKEN)).status, 200);
    // the check-in QR's token is not a bracket token, and the other way round
    assert.equal((await t.json(`/api/public/checkin/${NEW_TOKEN}`)).status, 404);
  } finally {
    await t.close();
  }
});

test('bracket: turning a store’s link on makes it work at once; a store with no bracket yet answers an empty one', async () => {
  const { t, hq } = await setup();
  try {
    assert.equal((await get(t, TOKEN2)).status, 404);
    const t2 = await batch(t, hq, 'link-s2-0000001', [{ k: 'stores', id: 's2', p: ['publicBracket', 'on'], v: true }]);
    assert.equal(t2.status, 200);
    assert.equal((await get(t, TOKEN2)).status, 200);
  } finally {
    await t.close();
  }
  const t0 = await startTestServer();
  await seedBasic(t0);
  await t0.close();
  writeDocForTests(t0.dataDir, 'stores', fixtureStore('s1', 'e1', 'a1', { day: dayOf(false), publicBracket: link(TOKEN) }));
  const t3 = await startTestServer({ dataDir: t0.dataDir });
  try {
    const r = await get(t3, TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.rounds, r.body.matches, r.body.champion], [0, [], null]);
  } finally {
    await t3.close();
  }
});

test('bracket: the link is HQ’s — admins never receive it and can’t write it; the schema refuses a bad shape', async () => {
  const { t, hq, a1, a2 } = await setup();
  try {
    const mine = (await t.json('/api/state', { cookie: hq })).body;
    assert.equal(mine.stores.s1.publicBracket.token, TOKEN);
    for (const cookie of [a1, a2]) {
      const s = (await t.json('/api/state', { cookie })).body;
      for (const st of Object.values<any>(s.stores)) assert.equal(st.publicBracket, undefined);
      assert.ok(!JSON.stringify(s).includes(TOKEN) && !JSON.stringify(s).includes(TOKEN2), 'the token is nowhere in an admin’s state');
    }
    // not their own store's, not by whole field, not by part, not by deleting it
    for (const [n, op] of [
      ['set', { k: 'stores', id: 's1', p: ['publicBracket'], v: link(NEW_TOKEN) }],
      ['on', { k: 'stores', id: 's1', p: ['publicBracket', 'on'], v: false }],
      ['token', { k: 'stores', id: 's1', p: ['publicBracket', 'token'], v: NEW_TOKEN }],
      ['delete', { k: 'stores', id: 's1', p: ['publicBracket'] }],
    ] as const) {
      const r = await batch(t, a1, `admin-${n}-0000001`, [op]);
      assert.deepEqual([r.status, r.body.code], [403, 'forbidden'], n);
    }
    assert.equal((await get(t, TOKEN)).status, 200, 'still the same link');

    const bad = async (n: string, v: unknown, re: RegExp) => {
      const r = await batch(t, hq, `bad-${n}-0000001`, [{ k: 'stores', id: 's1', p: ['publicBracket'], v }]);
      assert.deepEqual([r.status, r.body.code], [400, 'invalid'], n);
      assert.match(JSON.stringify(r.body.problems), re, n);
    };
    await bad('short', link('short'), /publicBracket\.token/);
    await bad('chars', link('has space in it 0000000'), /publicBracket\.token/);
    await bad('on', { ...link(NEW_TOKEN), on: 'yes' }, /publicBracket\.on/);
    await bad('time', { ...link(NEW_TOKEN), createdAt: 'yesterday' }, /publicBracket\.createdAt/);
    await bad('dup', link(TOKEN2), /publicBracket\.token: is already used by another store/);
    await bad('string', 'on', /publicBracket: must be an object/);
  } finally {
    await t.close();
  }
});

test('bracket: per-address limit — 429 with Retry-After once spent; a wrong token costs more; spoofed X-Forwarded-For ignored', async () => {
  const { t } = await setup({ bracketLimits: { perIp: 12, failCost: 5 } });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await get(t, TOKEN)).status, 200); // 2
    assert.equal((await get(t, 'brk_unknown-00000000001', { 'X-Forwarded-For': '10.0.0.1' })).status, 404); // 7
    assert.equal((await get(t, 'brk_unknown-00000000002', { 'X-Forwarded-For': '10.0.0.2' })).status, 404); // 12
    const r = await t.req(`/api/public/bracket/${TOKEN}`, { headers: { 'X-Forwarded-For': '10.9.9.9' } });
    assert.equal(r.status, 429, 'the right link is refused too, and a fresh “address” in the header buys nothing');
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal((await r.json()).code, 'rate-limited');
  } finally {
    await t.close();
  }
  // the default budget is a polling page's: 4 a minute each for a roomful behind one Wi-Fi
  const { t: t2 } = await setup();
  try {
    for (let i = 0; i < 100; i++) assert.equal((await get(t2, TOKEN)).status, 200, `request ${i + 1}`);
  } finally {
    await t2.close();
  }
});

test('bracket: GET only, no session needed, one is ignored, the cross-origin check stays, and logs never carry the token', async () => {
  const lines: string[] = [];
  const log: Logger = (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields }));
  const { t, a2 } = await setup({ log });
  try {
    assert.equal((await t.json(`/api/public/bracket/${TOKEN}`, { cookie: a2 })).status, 200, 'another store’s admin cookie changes nothing');
    assert.equal((await t.json(`/api/public/bracket/${TOKEN}`, { method: 'POST', body: {} })).status, 405);
    assert.equal((await t.json(`/api/public/bracket/${TOKEN}`, { method: 'PUT', body: {} })).status, 405);
    const x = await t.json(`/api/public/bracket/${TOKEN}`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: {} });
    assert.equal(x.status, 403);
    await get(t, 'brk_unknown-00000000001');
    for (const l of lines) assert.ok(!l.includes(TOKEN) && !l.includes('brk_unknown') && !/98200/.test(l), `in a log line: ${l}`);
  } finally {
    await t.close();
  }
});
