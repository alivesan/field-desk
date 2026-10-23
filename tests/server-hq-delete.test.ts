/*
 * HQ deleting test data over the real API: onspot.remove, recce.delete and recce.reset are
 * HQ-only commands (admin → 403), idempotent on retry, and the data they touch stays
 * command-only (generic batches are still refused).
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
  const store = async (cookie = hq) => (await t.json('/api/state', { cookie })).body.stores.s1;
  return { t, admin, other, hq, cmd, store };
}

test('onspot.remove: admin 403, unknown id 409, one command removes all, a retry is applied once', async () => {
  const { t, admin, hq, cmd, store } = await setup();
  try {
    assert.equal((await cmd(admin, 'desk-reg-10001', { type: 'players.onspot', base: 0, name: 'Ravi K.', phone: '9820055555' })).status, 200);
    assert.equal((await cmd(admin, 'desk-reg-10002', { type: 'players.onspot', base: 1, name: 'Meera' })).status, 200);
    let s = await store();
    assert.equal(s.day.onSpot.length, 2);

    // a generic batch still can’t empty the record
    const batch = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'b-rm-00000001', ops: [{ k: 'stores', id: 's1', p: ['day', 'onSpot'], v: [] }] } });
    assert.equal(batch.status, 403);

    const asAdmin = await cmd(admin, 'desk-rm-10001', { type: 'onspot.remove', base: s.day.version, entryIds: ['os-desk-reg-10001'] });
    assert.equal(asAdmin.status, 403);
    assert.equal((await store()).day.onSpot.length, 2);

    const unknown = await cmd(hq, 'hq-rm-100001', { type: 'onspot.remove', base: s.day.version, entryIds: ['os-desk-reg-10001', 'os-nope'] });
    assert.equal(unknown.status, 409);
    assert.equal((await store()).day.onSpot.length, 2, 'nothing removed when one id is unknown');

    assert.equal((await cmd(hq, 'hq-rm-100002', { type: 'onspot.remove', base: s.day.version, entryIds: ['os-desk-reg-10001'] })).status, 200);
    s = await store();
    assert.deepEqual(s.day.onSpot.map((e: { name: string }) => e.name), ['Meera']);
    assert.equal(s.day.players.length, 2, 'the players stay');

    // retry after a lost response: byte-identical → same seq, nothing more removed
    const body = { type: 'onspot.remove', base: s.day.version, entryIds: ['os-desk-reg-10002'], alsoPlayers: true };
    const first = await cmd(hq, 'hq-rm-100003', body);
    const again = await cmd(hq, 'hq-rm-100003', body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(again.body, first.body);
    s = await store();
    assert.deepEqual(s.day.onSpot, []);
    assert.deepEqual(s.day.players.map((p: { name: string }) => p.name), ['Ravi K.'], 'alsoPlayers took Meera off the list');
    assert.equal(s.day.checkIn['meera'], undefined);
  } finally {
    await t.close();
  }
});

test('recce.delete / recce.reset: HQ only, revisions go, the draft is blanked by reset, a retry is applied once', async () => {
  const { t, admin, other, hq, cmd, store } = await setup();
  try {
    // the admin fills in a bit of recce through a normal batch and submits twice
    const edit = (id: string, text: string) => t.json('/api/batch', { method: 'POST', cookie: admin, body: { id, ops: [{ k: 'stores', id: 's1', p: ['recce', 'summary'], v: text }] } });
    assert.equal((await edit('ed-recce-0001', 'dummy one')).status, 200);
    assert.equal((await cmd(admin, 'submit-rec-001', { type: 'recce.submit', base: 0 })).status, 200);
    assert.equal((await edit('ed-recce-0002', 'dummy two')).status, 200);
    assert.equal((await cmd(admin, 'submit-rec-002', { type: 'recce.submit', base: 1 })).status, 200);
    let s = await store();
    const [r1, r2] = s.submissions;
    assert.deepEqual([r1.rev, r2.rev], [1, 2]);

    // field admins (assigned or not) can do neither
    for (const [who, id] of [[admin, 'adm-del-00001'], [other, 'oth-del-00001']] as const) {
      const d = await cmd(who, id, { type: 'recce.delete', base: 2, submissionId: r1.id });
      assert.equal(d.status, 403, `${id}: ${JSON.stringify(d.body)}`);
      const r = await cmd(who, `${id}-r`, { type: 'recce.reset', base: 2 });
      assert.equal(r.status, 403);
    }
    assert.equal((await store()).submissions.length, 2);
    // …nor can a batch remove a revision or empty the list
    for (const [who, id, ops] of [
      [admin, 'b-sub-00000001', [{ k: 'stores', id: 's1', p: ['submissions'], v: [] }]],
      [hq, 'b-sub-00000002', [{ k: 'stores', id: 's1', p: ['submissions'], v: [] }]],
    ] as const) {
      const b = await t.json('/api/batch', { method: 'POST', cookie: who, body: { id, ops } });
      assert.equal(b.status, 403, `${id}: ${JSON.stringify(b.body)}`);
    }

    // delete rev 1: rev 2 and the draft stay
    const body = { type: 'recce.delete', base: 2, submissionId: r1.id };
    const first = await cmd(hq, 'hq-delrev-0001', body);
    const again = await cmd(hq, 'hq-delrev-0001', body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(again.body, first.body);
    s = await store();
    assert.deepEqual(s.submissions.map((x: { rev: number }) => x.rev), [2]);
    assert.equal(s.recce.summary, 'dummy two');
    assert.equal((await cmd(hq, 'hq-delrev-0002', { type: 'recce.delete', base: 1, submissionId: r1.id })).status, 409, 'already gone');

    // the admin submits again: rev 3, not a second rev 2
    assert.equal((await cmd(admin, 'submit-rec-003', { type: 'recce.submit', base: 1 })).status, 200);
    assert.deepEqual((await store()).submissions.map((x: { rev: number }) => x.rev), [2, 3]);

    // reset: stale base refused, then everything goes
    assert.equal((await cmd(hq, 'hq-reset-0001', { type: 'recce.reset', base: 1 })).status, 409);
    const reset = await cmd(hq, 'hq-reset-0002', { type: 'recce.reset', base: 2 });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    s = await store();
    assert.deepEqual(s.submissions, []);
    assert.equal(s.recce.summary, '');
    assert.equal(s.recce.status, 'draft');
    assert.equal(s.recce.submittedAt, undefined);

    // the admin's own view of their store is blank too, and they can submit afresh as rev 1
    const mine = (await t.json('/api/state', { cookie: admin })).body.stores.s1;
    assert.equal(mine.recce.summary, '');
    assert.equal((await cmd(admin, 'submit-rec-004', { type: 'recce.submit', base: 0 })).status, 200);
    assert.deepEqual((await store()).submissions.map((x: { rev: number }) => x.rev), [1]);
  } finally {
    await t.close();
  }
});
