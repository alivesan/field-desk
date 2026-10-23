import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic, SUPER } from './helpers/server.ts';

type T = Awaited<ReturnType<typeof startTestServer>>;
const login = (t: T, code: string, xff?: string) =>
  t.req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(xff ? { 'X-Forwarded-For': xff } : {}) }, body: JSON.stringify({ code }) });

test('F21: spoofed X-Forwarded-For is ignored by default (TRUST_PROXY=0)', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    for (let i = 0; i < 10; i++) assert.equal((await login(t, 'ZZZ9', `10.0.0.${i}`)).status, 401);
    // a fresh "address" in the header doesn't buy more guesses — and the right code is blocked too
    const r = await login(t, 'ZZZ8', '10.9.9.9');
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal((await login(t, 'AAA2', '10.9.9.10')).status, 429);
  } finally {
    await t.close();
  }
});

test('F21: with TRUST_PROXY=1 each client behind the proxy has its own bucket', async () => {
  const t = await startTestServer({ trustProxy: 1 });
  try {
    await seedBasic(t);
    for (let i = 0; i < 10; i++) assert.equal((await login(t, 'ZZZ9', 'spoofed, 203.0.113.7')).status, 401);
    assert.equal((await login(t, 'ZZZ9', '203.0.113.7')).status, 429);
    // a client can't escape by prepending its own entries: the proxy-appended one counts
    assert.equal((await login(t, 'ZZZ9', '1.2.3.4, 203.0.113.7')).status, 429);
    // a different real client behind the same proxy isn't locked out
    assert.equal((await login(t, 'AAA2', '198.51.100.20')).status, 200);
  } finally {
    await t.close();
  }
});

test('F21: guessing 4-character codes can’t lock HQ out (separate buckets, global ceiling is admin-only)', async () => {
  const t = await startTestServer({ trustProxy: 1, loginLimits: { adminGlobal: 20 } });
  try {
    await seedBasic(t);
    // a distributed guesser: many sources, few attempts each
    for (let i = 0; i < 20; i++) assert.equal((await login(t, 'ZZZ9', `198.51.100.${i}`)).status, 401);
    assert.equal((await login(t, 'AAA2', '192.0.2.1')).status, 429, 'global admin-code ceiling reached');
    // HQ still signs in, even from an address that was guessing admin codes
    assert.equal((await login(t, SUPER, '198.51.100.1')).status, 200);
    assert.equal((await login(t, SUPER, '192.0.2.1')).status, 200);
  } finally {
    await t.close();
  }
});

test('F21: wrong HQ codes from one source are limited per source', async () => {
  const t = await startTestServer({ trustProxy: 1 });
  try {
    await seedBasic(t);
    for (let i = 0; i < 10; i++) assert.equal((await login(t, 'not-the-hq-code', '192.0.2.50')).status, 401);
    assert.equal((await login(t, SUPER, '192.0.2.50')).status, 429);
    assert.equal((await login(t, SUPER, '192.0.2.51')).status, 200);
    // admin sign-in from the HQ-guessing source isn't affected
    assert.equal((await login(t, 'AAA2', '192.0.2.50')).status, 200);
  } finally {
    await t.close();
  }
});
