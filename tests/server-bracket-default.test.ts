import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic, fixtureStore, writeDocForTests, SUPER } from './helpers/server.ts';
import { BRACKET_TOKEN } from '../src/lib/schema.ts';

/* The public bracket is on by default: the server gives every store a link, and the check-in page tells players about it. */

const CHECKIN = 'tok_S1-synthetic-0001';
const CHECKIN2 = 'tok_S2-synthetic-0002';
const KEPT = 'brk_S1-kept-0000000001';
const OFF = 'brk_S3-off-00000000003';
const players = [
  { id: 'hash-a', name: 'Asha Rao', seed: 1, phone: '9820011111', ign: 'AshaX' },
  { id: 'hash-b', name: 'Vikram', seed: 2, phone: '9820022222' },
];
const day = (token: string) => ({ players, checkIn: {}, matches: [], stations: 2, version: 1, selfCheckIn: { token, open: true, openedAt: '2026-10-24T09:00:00.000Z' } });
const link = (token: string, on: boolean) => ({ token, on, createdAt: '2026-10-24T08:00:00.000Z' });

/**
 * s1 keeps its link, s2 has none (a store from before the default), s3 was turned off by HQ — written straight to
 * the database, then the server (re)starts on it.
 */
async function setup() {
  const t0 = await startTestServer();
  await seedBasic(t0);
  await t0.close();
  writeDocForTests(t0.dataDir, 'stores', fixtureStore('s1', 'e1', 'a1', { day: day(CHECKIN), publicBracket: link(KEPT, true) }));
  writeDocForTests(t0.dataDir, 'stores', fixtureStore('s2', 'e1', 'a2', { day: day(CHECKIN2) }));
  writeDocForTests(t0.dataDir, 'stores', fixtureStore('s3', 'e1', 'a2', { publicBracket: link(OFF, false) }));
  const t = await startTestServer({ dataDir: t0.dataDir });
  return { t, hq: await t.login(SUPER) };
}

const stores = async (t: Awaited<ReturnType<typeof setup>>['t'], hq: string) => (await t.json('/api/state', { cookie: hq })).body.stores as Record<string, any>;

test('default on: a store with no link gets one at start; existing tokens are kept; a link HQ turned off stays off', async () => {
  const { t, hq } = await setup();
  try {
    const all = await stores(t, hq);
    assert.deepEqual([all.s1.publicBracket.token, all.s1.publicBracket.on], [KEPT, true], 'an existing token is not replaced');
    assert.deepEqual([all.s3.publicBracket.token, all.s3.publicBracket.on], [OFF, false], 'off stays off, with its token');
    const made = all.s2.publicBracket;
    assert.equal(made.on, true);
    assert.match(made.token, BRACKET_TOKEN);
    assert.ok(!Object.values(all).some((s) => s.id !== 's2' && s.publicBracket?.token === made.token), 'unique');
    assert.equal((await t.json(`/api/public/bracket/${made.token}`)).status, 200, 'works at once, before any match exists');
    assert.equal((await t.json(`/api/public/bracket/${OFF}`)).status, 404);
    // HQ's link is HQ's: the store's own admin never receives it
    const a2 = await t.login('BBB3');
    assert.ok(!JSON.stringify((await t.json('/api/state', { cookie: a2 })).body).includes(made.token));
  } finally {
    await t.close();
  }
});

test('default on: a second start changes nothing (same tokens, no new version)', async () => {
  const { t, hq } = await setup();
  let first: Record<string, any>, seq: number;
  try {
    first = await stores(t, hq);
    seq = (await t.json('/api/state', { cookie: hq })).body.seq;
  } finally {
    await t.close();
  }
  const t2 = await startTestServer({ dataDir: t.dataDir });
  try {
    const hq2 = await t2.login(SUPER);
    const again = await stores(t2, hq2);
    for (const id of ['s1', 's2', 's3']) assert.deepEqual(again[id].publicBracket, first[id].publicBracket, id);
    assert.equal((await t2.json('/api/state', { cookie: hq2 })).body.seq, seq);
  } finally {
    await t2.close();
  }
});

test('default on: a store HQ creates later has its link on from the first version', async () => {
  const { t, hq } = await setup();
  try {
    const r = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'new-store-000001', ops: [{ k: 'stores', id: 's4', p: [], v: fixtureStore('s4', 'e1', 'a1') }] } });
    assert.equal(r.status, 200);
    const s4 = (await stores(t, hq)).s4.publicBracket;
    assert.equal(s4.on, true);
    assert.match(s4.token, BRACKET_TOKEN);
    // a link HQ gave the new store itself is not replaced
    const mine = link('brk_S5-chosen-000000005', false);
    const r5 = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'new-store-000002', ops: [{ k: 'stores', id: 's5', p: [], v: fixtureStore('s5', 'e1', 'a1', { publicBracket: mine }) }] } });
    assert.equal(r5.status, 200);
    assert.deepEqual((await stores(t, hq)).s5.publicBracket, mine);
  } finally {
    await t.close();
  }
});

test('check-in GET: bracketPath only while the store’s link is on, and it opens the bracket', async () => {
  const { t, hq } = await setup();
  try {
    const on = await t.json(`/api/public/checkin/${CHECKIN}`);
    assert.equal(on.status, 200);
    assert.equal(on.body.bracketPath, `/b/${KEPT}`);
    assert.equal((await t.json(`/api${on.body.bracketPath.replace('/b/', '/public/bracket/')}`)).status, 200);

    // a store that had no link: it has one by now, so its QR page offers it
    const made = (await stores(t, hq)).s2.publicBracket.token;
    assert.equal((await t.json(`/api/public/checkin/${CHECKIN2}`)).body.bracketPath, `/b/${made}`);

    // HQ turns s1's off: the path goes, and the old link answers 404
    assert.equal((await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'off-s1-00000001', ops: [{ k: 'stores', id: 's1', p: ['publicBracket', 'on'], v: false }] } })).status, 200);
    const off = await t.json(`/api/public/checkin/${CHECKIN}`);
    assert.equal(off.status, 200);
    assert.ok(!('bracketPath' in off.body), JSON.stringify(off.body));
    assert.equal((await t.json(`/api/public/bracket/${KEPT}`)).status, 404);

    // on again: the same link comes back
    assert.equal((await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'on-s1-000000001', ops: [{ k: 'stores', id: 's1', p: ['publicBracket', 'on'], v: true }] } })).status, 200);
    assert.equal((await t.json(`/api/public/checkin/${CHECKIN}`)).body.bracketPath, `/b/${KEPT}`);
  } finally {
    await t.close();
  }
});

test('public answers carry no player id, phone or in-game name — the check-in page, a check-in, and the empty bracket', async () => {
  const { t } = await setup();
  try {
    const info = await t.req(`/api/public/checkin/${CHECKIN}`);
    const bracket = await t.req(`/api/public/bracket/${KEPT}`);
    const done = await t.req(`/api/public/checkin/${CHECKIN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9820011111' }) });
    assert.equal(done.status, 200);
    const texts = await Promise.all([info, bracket, done].map((res) => res.text()));
    for (const text of texts) for (const secret of ['hash-a', 'hash-b', '9820011111', '9820022222', 'AshaX', 'phone', 'checkIn"']) assert.ok(!text.includes(secret), `${secret} in ${text}`);
    // a check-in still answers with the first name + initial only
    assert.deepEqual(JSON.parse(texts[2]), { ok: true, name: 'Asha R.', already: false });
    assert.deepEqual(Object.keys(JSON.parse(texts[0])).sort(), ['bracketPath', 'campaign', 'date', 'open', 'store']);
  } finally {
    await t.close();
  }
});
