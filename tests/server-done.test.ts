/*
 * Approve recce undone, and the event-finished mark, over the real API: recce.unreview, event.finish and
 * event.reopen are HQ-only commands (admin 403), idempotent on retry, the finish fields can't be written by
 * a batch (even HQ's), a field admin can't close a campaign, and the team sees what HQ marked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic, SUPER } from './helpers/server.ts';

async function setup() {
  const t = await startTestServer();
  await seedBasic(t);
  const admin = await t.login('AAA2');
  const other = await t.login('BBB3');
  const hq = await t.login(SUPER);
  const cmd = (cookie: string, id: string, c: unknown, storeId = 's1') => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId, cmd: c } });
  const batch = (cookie: string, id: string, ops: unknown[]) => t.json('/api/batch', { method: 'POST', cookie, body: { id, ops } });
  const store = async (cookie = hq, id = 's1') => (await t.json('/api/state', { cookie })).body.stores[id];
  return { t, admin, other, hq, cmd, batch, store };
}

test('recce.unreview: admin 403, HQ takes the approval back, a retry is applied once, approving again works', async () => {
  const { t, admin, other, hq, cmd, store } = await setup();
  try {
    assert.equal((await cmd(admin, 'submit-rec-001', { type: 'recce.submit', base: 0 })).status, 200);
    const sub = (await store()).submissions[0];
    assert.equal((await cmd(hq, 'review-rec-001', { type: 'recce.review', base: 1, submissionId: sub.id })).status, 200);
    assert.ok((await store(admin)).submissions[0].reviewedAt, 'the team sees the approval');

    for (const [who, id] of [[admin, 'adm-unrev-001'], [other, 'oth-unrev-001']] as const) {
      const r = await cmd(who, id, { type: 'recce.unreview', base: 1, submissionId: sub.id });
      assert.equal(r.status, 403, `${id}: ${JSON.stringify(r.body)}`);
    }
    assert.ok((await store()).submissions[0].reviewedAt, 'still approved');

    const body = { type: 'recce.unreview', base: 1, submissionId: sub.id };
    const first = await cmd(hq, 'hq-unrev-0001', body);
    const again = await cmd(hq, 'hq-unrev-0001', body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(again.body, first.body, 'a byte-identical retry is the same commit');
    const s = (await store()).submissions[0];
    assert.equal(s.reviewedAt, undefined);
    assert.equal(s.reviewedBy, undefined);
    // undoing a revision that isn't approved changes nothing; an unknown one is a conflict
    assert.equal((await cmd(hq, 'hq-unrev-0002', body)).status, 200);
    assert.equal((await cmd(hq, 'hq-unrev-0003', { ...body, submissionId: 'sub-nope' })).status, 409);
    assert.equal((await cmd(hq, 'review-rec-002', { type: 'recce.review', base: 1, submissionId: sub.id })).status, 200);
    assert.ok((await store()).submissions[0].reviewedAt);
  } finally {
    await t.close();
  }
});

test('event.finish / event.reopen: admin 403, HQ ok, idempotent, the team sees it, batches can’t write it', async () => {
  const { t, admin, other, hq, cmd, batch, store } = await setup();
  try {
    for (const [type, who, id] of [['event.finish', admin, 'adm-fin-00001'], ['event.reopen', admin, 'adm-reo-00001'], ['event.finish', other, 'oth-fin-00001']] as const) {
      const r = await cmd(who, id, { type, base: 0 });
      assert.equal(r.status, 403, `${id}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await store()).finishedAt, undefined);

    const body = { type: 'event.finish', base: 0 };
    const first = await cmd(hq, 'hq-fin-000001', body);
    const again = await cmd(hq, 'hq-fin-000001', body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(again.body, first.body);
    let s = await store();
    assert.ok(Date.parse(s.finishedAt) > 0);
    assert.equal(s.finishedBy, 'HQ');
    const asTeam = await store(admin);
    assert.deepEqual([asTeam.finishedAt, asTeam.finishedBy], [s.finishedAt, 'HQ'], 'the store team receives it');
    assert.equal((await store(other)), undefined, 'another admin doesn’t see the store');

    // marking it again (a new command) keeps the first mark and still succeeds
    assert.equal((await cmd(hq, 'hq-fin-000002', body)).status, 200);
    assert.equal((await store()).finishedAt, s.finishedAt);

    // nobody changes it with a batch: not the admin, not HQ
    for (const [who, id] of [[admin, 'b-fin-00000001'], [hq, 'b-fin-00000002']] as const)
      assert.equal((await batch(who, id, [{ k: 'stores', id: 's1', p: ['finishedAt'], v: '2026-01-01T00:00:00.000Z' }])).status, 403, id);
    assert.equal((await store()).finishedAt, s.finishedAt);

    assert.equal((await cmd(hq, 'hq-reo-000001', { type: 'event.reopen', base: 0 })).status, 200);
    s = await store();
    assert.equal(s.finishedAt, undefined);
    assert.equal(s.finishedBy, undefined);
    assert.equal((await store(admin)).finishedAt, undefined);
    assert.equal((await cmd(hq, 'hq-reo-000002', { type: 'event.reopen', base: 0 })).status, 200, 'reopening again is fine');
  } finally {
    await t.close();
  }
});

test('closedAt is HQ’s: it saves as an ordinary campaign edit, a field admin is refused, junk is invalid', async () => {
  const { t, admin, hq, batch } = await setup();
  try {
    const at = '2026-10-30T09:00:00.000Z';
    assert.equal((await batch(admin, 'b-close-000001', [{ k: 'events', id: 'e1', p: ['closedAt'], v: at }])).status, 403);
    assert.equal((await batch(hq, 'b-close-000002', [{ k: 'events', id: 'e1', p: ['closedAt'], v: 'someday' }])).status, 400);
    assert.equal((await batch(hq, 'b-close-000003', [{ k: 'events', id: 'e1', p: ['closedAt'], v: at }])).status, 200);
    assert.equal((await t.json('/api/state', { cookie: admin })).body.events.e1.closedAt, at, 'the team can see the campaign is closed');
    assert.equal((await batch(hq, 'b-close-000004', [{ k: 'events', id: 'e1', p: ['closedAt'] }])).status, 200);
    assert.equal((await t.json('/api/state', { cookie: hq })).body.events.e1.closedAt, undefined);
  } finally {
    await t.close();
  }
});
