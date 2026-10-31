/*
 * On-the-spot registration over the real API: field admins register walk-ins at the desk
 * (players.onspot), HQ ticks them off once they're on Toornament (onspot.mark), and the record
 * changes only through those commands.
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
  const hq = await t.login(SUPER);
  const cmd = (cookie: string, id: string, c: unknown, storeId = 's1') => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId, cmd: c } });
  const day = async (cookie = hq) => (await t.json('/api/state', { cookie })).body.stores.s1.day;
  return { t, admin, hq, cmd, day };
}

test('an admin registers a walk-in: checked in, recorded, bracket untouched — until the bracket is out, then only HQ can', async () => {
  const { t, admin, hq, cmd, day } = await setup();
  try {
    assert.equal((await cmd(hq, 'hq-set-onspot1', { type: 'players.set', base: 0, players })).status, 200);
    const before = await day();

    const r = await cmd(admin, 'desk-reg-00001', { type: 'players.onspot', base: before.version, name: 'Ravi K.', phone: '+91 98200 55555', ign: 'RaviOP' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let d = await day(admin);
    const ravi = d.players.find((p: { name: string }) => p.name === 'Ravi K.');
    assert.deepEqual({ seed: ravi.seed, phone: ravi.phone, ign: ravi.ign }, { seed: 3, phone: '9820055555', ign: 'RaviOP' });
    assert.ok(d.checkIn[ravi.id]);
    assert.equal(d.checkInSource[ravi.id], 'staff');
    assert.equal(d.onSpot.length, 1);
    assert.deepEqual({ id: d.onSpot[0].id, playerId: d.onSpot[0].playerId, by: d.onSpot[0].by, toornament: d.onSpot[0].toornament }, { id: 'os-desk-reg-00001', playerId: ravi.id, by: 'Synthetic a1', toornament: undefined });
    assert.deepEqual(d.matches, before.matches, 'bracket untouched');

    // the bracket goes out with the walk-in left off it (they're not on Toornament yet)
    assert.equal((await cmd(hq, 'hq-build-onspot1', { type: 'bracket.build', base: (await day()).version, pairs: [['p1', 'p2']] })).status, 200);
    await t.json('/api/batch', { method: 'POST', cookie: admin, body: { id: 'ci-onspot-0001', ops: [{ k: 'stores', id: 's1', p: ['day', 'checkIn', 'p1'], v: '2026-10-24T09:00:00.000Z' }, { k: 'stores', id: 's1', p: ['day', 'checkIn', 'p2'], v: '2026-10-24T09:00:00.000Z' }] } });
    d = await day();
    assert.equal((await cmd(admin, 'desk-start-0001', { type: 'match.start', base: d.version, matchId: d.matches[0].id, station: 1 })).status, 200);
    const live = (await day()).matches;
    // the desk is shut out now — a stale base changes nothing; HQ can still register one
    const shut = await cmd(admin, 'desk-reg-00002', { type: 'players.onspot', base: 0, name: 'Late Comer' });
    assert.equal(shut.status, 409, JSON.stringify(shut.body));
    assert.match(shut.body.error, /on-spot registration is closed here/);
    assert.equal((await day()).players.length, 3);
    const late = await cmd(hq, 'hq-reg-00000002', { type: 'players.onspot', base: 0, name: 'Late Comer' });
    assert.equal(late.status, 200, JSON.stringify(late.body));
    d = await day();
    assert.deepEqual(d.matches, live);
    assert.equal(d.players.length, 4);
    assert.equal(d.onSpot.length, 2);
  } finally {
    await t.close();
  }
});

test('duplicate phone refused; same name needs "different"; retries are applied once', async () => {
  const { t, admin, hq, cmd, day } = await setup();
  try {
    assert.equal((await cmd(hq, 'hq-set-onspot2', { type: 'players.set', base: 0, players })).status, 200);
    const dup = await cmd(admin, 'desk-dup-00001', { type: 'players.onspot', base: 1, name: 'Someone', phone: '098200 11111' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /number ending 1111 is already on the list as Asha R\./);

    const same = await cmd(admin, 'desk-same-0001', { type: 'players.onspot', base: 1, name: 'asha r.' });
    assert.equal(same.status, 409);
    assert.match(same.body.error, /already on the list/);
    const diff = await cmd(admin, 'desk-same-0002', { type: 'players.onspot', base: 1, name: 'asha r.', sameName: 'different' });
    assert.equal(diff.status, 200, JSON.stringify(diff.body));
    assert.ok((await day()).players.some((p: { name: string }) => p.name === 'asha r. (2)'));

    const bad = await cmd(admin, 'desk-bad-00001', { type: 'players.onspot', base: 1, name: 'Ravi', sameName: 'yes' });
    assert.equal(bad.status, 400);

    // the sync engine retries after a lost response: byte-identical → the same seq, one entry
    const body = { type: 'players.onspot', base: 2, name: 'Retry Me', phone: '9000000007' };
    const first = await cmd(admin, 'desk-retry-001', body);
    const again = await cmd(admin, 'desk-retry-001', body);
    assert.equal(first.status, 200);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body);
    const d = await day();
    assert.equal(d.onSpot.filter((e: { name: string }) => e.name === 'Retry Me').length, 1);
    assert.equal(d.players.filter((p: { name: string }) => p.name === 'Retry Me').length, 1);
  } finally {
    await t.close();
  }
});

test('only HQ marks a walk-in as on Toornament; a batch can’t touch day.onSpot; HQ’s list changes keep it', async () => {
  const { t, admin, hq, cmd, day } = await setup();
  try {
    assert.equal((await cmd(admin, 'desk-reg-00003', { type: 'players.onspot', base: 0, name: 'Meera' })).status, 200);
    const entryId = 'os-desk-reg-00003';

    const byAdmin = await cmd(admin, 'desk-mark-0001', { type: 'onspot.mark', base: 1, entryId, done: true });
    assert.equal(byAdmin.status, 403);
    const byHq = await cmd(hq, 'hq-mark-000001', { type: 'onspot.mark', base: 1, entryId, done: true });
    assert.equal(byHq.status, 200, JSON.stringify(byHq.body));
    assert.ok((await day()).onSpot[0].toornament);
    assert.equal((await cmd(hq, 'hq-mark-000002', { type: 'onspot.mark', base: 2, entryId: 'os-nope', done: true })).status, 409);

    // generic batches (admin or HQ) can't add, edit or remove registrations
    for (const [who, id, ops] of [
      [admin, 'b-onspot-00001', [{ k: 'stores', id: 's1', p: ['day', 'onSpot'], v: [] }]],
      [admin, 'b-onspot-00002', [{ k: 'stores', id: 's1', p: ['day', 'onSpot', 0, 'toornament'], v: '2026-10-24T12:00:00.000Z' }]],
      [hq, 'b-onspot-00003', [{ k: 'stores', id: 's1', p: ['day', 'onSpot'], v: [] }]],
    ] as const) {
      const r = await t.json('/api/batch', { method: 'POST', cookie: who, body: { id, ops } });
      assert.equal(r.status, 403, `${id}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'protected');
    }
    // a brand-new store can't arrive with a forged record either
    const d0 = await day();
    const forged = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'b-onspot-00004', ops: [{ k: 'stores', id: 's7', p: [], v: { ...(await t.json('/api/state', { cookie: hq })).body.stores.s2, id: 's7', day: { ...d0, players: [], checkIn: {}, checkInSource: {}, version: 0 } } }] } });
    assert.equal(forged.status, 403, JSON.stringify(forged.body));
    assert.match(forged.body.error, /day.onSpot/);

    // HQ replaces the list without Meera: the record stays (HQ's Toornament to-do)
    const d = await day();
    assert.equal((await cmd(hq, 'hq-set-onspot3', { type: 'players.set', base: d.version, players })).status, 200);
    const after = await day();
    assert.deepEqual(after.onSpot, d.onSpot);
    assert.ok(!after.players.some((p: { name: string }) => p.name === 'Meera'));
  } finally {
    await t.close();
  }
});

test('an admin can’t register walk-ins at a store that isn’t theirs', async () => {
  const { t, admin, cmd } = await setup();
  try {
    const r = await cmd(admin, 'desk-other-001', { type: 'players.onspot', base: 0, name: 'Ravi' }, 's2');
    assert.equal(r.status, 403);
  } finally {
    await t.close();
  }
});

test('players.edit: the desk gives a no-number player a number and still only sees its last 4 until check-in; HQ sees it and can change any', async () => {
  const { t, admin, hq, cmd, day } = await setup();
  try {
    assert.equal((await cmd(hq, 'hq-set-edit0001', { type: 'players.set', base: 0, players })).status, 200);
    const add = await cmd(admin, 'desk-edit-0001', { type: 'players.edit', base: 1, playerId: 'p2', phone: '+91 98200 33333', ign: 'Bil' });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    // the admin's view: p2 isn't checked in, so only the end of the number he just typed comes back
    let seen = (await day(admin)).players.find((p: { id: string }) => p.id === 'p2');
    assert.deepEqual({ phone: seen.phone, phoneEnd: seen.phoneEnd, ign: seen.ign }, { phone: undefined, phoneEnd: '3333', ign: 'Bil' });
    seen = (await day(hq)).players.find((p: { id: string }) => p.id === 'p2');
    assert.deepEqual({ phone: seen.phone, phoneEnd: seen.phoneEnd }, { phone: '9820033333', phoneEnd: undefined });

    // the desk can't change a number that's there (nor rename), nor take Asha's; HQ can
    const v = (await day()).version;
    for (const [id, c] of [
      ['desk-edit-0002', { playerId: 'p2', phone: '9820099999' }],
      ['desk-edit-0003', { playerId: 'p1', phone: '' }],
      ['desk-edit-0004', { playerId: 'p2', name: 'Bilal K.' }],
    ] as const) {
      const r = await cmd(admin, id, { type: 'players.edit', base: v, ...c });
      assert.equal(r.status, 403, `${id}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /Only HQ can/);
    }
    const dup = await cmd(hq, 'hq-edit-000001', { type: 'players.edit', base: v, playerId: 'p2', phone: '98200 11111' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already on the list as Asha R\./);
    const byHq = await cmd(hq, 'hq-edit-000002', { type: 'players.edit', base: v, playerId: 'p2', name: 'Bilal K.', phone: '9820044444' });
    assert.equal(byHq.status, 200, JSON.stringify(byHq.body));
    assert.equal((await day()).players.find((p: { id: string }) => p.id === 'p2').name, 'Bilal K.');

    // checked in, the admin sees the whole number
    const ci = await t.json('/api/batch', { method: 'POST', cookie: admin, body: { id: 'ci-edit-000001', ops: [{ k: 'stores', id: 's1', p: ['day', 'checkIn', 'p2'], v: '2026-10-24T09:00:00.000Z' }] } });
    assert.equal(ci.status, 200, JSON.stringify(ci.body));
    assert.equal((await day(admin)).players.find((p: { id: string }) => p.id === 'p2').phone, '9820044444');
  } finally {
    await t.close();
  }
});
