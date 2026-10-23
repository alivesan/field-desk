import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic } from './helpers/server.ts';

/*
 * HQ's source links are capabilities (a published-sheet link reads the whole sheet), so field
 * admins never receive them: not the campaign's store sheet, not a store's player-list link.
 */

test('admins never receive event.storeSheet or store.roster; HQ does', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    const r = await t.json('/api/batch', {
      method: 'POST',
      cookie: hq,
      body: {
        id: 'hq-links-0001',
        ops: [
          { k: 'events', id: 'e1', p: ['storeSheet'], v: { url: 'https://docs.google.com/spreadsheets/d/e/SYNTHETIC/pub?output=csv', fetchedAt: '2026-10-24T05:00:00.000Z' } },
          { k: 'stores', id: 's1', p: ['roster'], v: { kind: 'link', url: 'https://docs.google.com/spreadsheets/d/e/SYNTHETIC2/pub?output=csv', fetchedAt: '2026-10-24T05:00:00.000Z', rows: 3, by: 'HQ' } },
        ],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const asHq = (await t.json('/api/state', { cookie: hq })).body;
    assert.ok(asHq.events.e1.storeSheet, 'HQ sees the sheet link');
    assert.ok(asHq.stores.s1.roster, 'HQ sees the player-list link');

    const admin = await t.login('AAA2');
    const asAdmin = (await t.json('/api/state', { cookie: admin })).body;
    assert.ok(asAdmin.events.e1, 'the admin still sees their campaign');
    assert.equal(asAdmin.events.e1.storeSheet, undefined);
    assert.ok(asAdmin.stores.s1, 'and their store');
    assert.equal(asAdmin.stores.s1.roster, undefined);
    assert.doesNotMatch(JSON.stringify(asAdmin), /SYNTHETIC/);
  } finally {
    await t.close();
  }
});
