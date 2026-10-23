import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic } from './helpers/server.ts';

test('harness: API starts on temp storage, HQ and admin sign in, admin sees only their store', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const { status, body } = await t.json('/api/state', { cookie: a1 });
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.stores), ['s1']);
  } finally {
    await t.close();
  }
});
