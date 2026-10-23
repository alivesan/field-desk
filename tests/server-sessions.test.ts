import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startTestServer, seedBasic, SUPER } from './helpers/server.ts';

const DAY = 864e5;

/** Reads an SSE response until it ends; resolves with everything received. */
async function readStream(r: Response, timeoutMs = 3000) {
  const reader = r.body!.getReader();
  let text = '';
  const timer = setTimeout(() => reader.cancel(), timeoutMs);
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done) break;
    text += Buffer.from(value!).toString('utf8');
  }
  clearTimeout(timer);
  return { text, ended: true };
}

test('F22: /api/me and /api/state report the principal; logout revokes server-side', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const me = await t.json('/api/me', { cookie: a1 });
    assert.equal(me.body.role, 'admin');
    assert.equal(me.body.principal, 'admin:a1');
    assert.equal(me.body.name, 'Synthetic a1');
    assert.ok(Date.parse(me.body.expiresAt) > Date.now() + 29 * DAY);
    assert.equal((await t.json('/api/state', { cookie: a1 })).body.principal, 'admin:a1');

    const out = await t.req('/api/logout', { method: 'POST', cookie: a1 });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie')!, /Max-Age=0/);
    // a copy of the old cookie no longer works
    assert.equal((await t.json('/api/state', { cookie: a1 })).status, 401);
    assert.equal((await t.json('/api/me', { cookie: a1 })).body.role, null);
  } finally {
    await t.close();
  }
});

test('F22: sessions expire on the server (admin 30 days, HQ 7 days by default)', async () => {
  let clock = Date.parse('2026-10-23T00:00:00Z');
  const t = await startTestServer({ now: () => clock });
  try {
    const hq = await seedBasic(t);
    const a1 = await t.login('AAA2');
    assert.equal((await t.json('/api/me', { cookie: hq })).body.expiresAt, new Date(clock + 7 * DAY).toISOString());
    clock += 7 * DAY + 1000;
    assert.equal((await t.json('/api/state', { cookie: hq })).status, 401);
    assert.equal((await t.json('/api/state', { cookie: a1 })).status, 200);
    clock += 23 * DAY;
    assert.equal((await t.json('/api/state', { cookie: a1 })).status, 401);
  } finally {
    await t.close();
  }
});

test('F22: session lifetimes are configurable', async () => {
  let clock = Date.parse('2026-10-23T00:00:00Z');
  const t = await startTestServer({ now: () => clock, sessionDays: { admin: 1, super: 2 } });
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    clock += DAY + 1;
    assert.equal((await t.json('/api/state', { cookie: a1 })).status, 401);
  } finally {
    await t.close();
  }
});

test('F22: rotating an admin’s code ends that admin’s sessions (and only theirs)', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    const a1 = await t.login('AAA2');
    const a2 = await t.login('BBB3');
    const r = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'rotate-a1-0001', ops: [{ k: 'admins', id: 'a1', p: ['code'], v: 'CCC4' }] } });
    assert.equal(r.status, 200);
    assert.equal((await t.json('/api/state', { cookie: a1 })).status, 401);
    assert.equal((await t.json('/api/state', { cookie: a2 })).status, 200);
    assert.equal((await t.req('/api/login', { method: 'POST', body: JSON.stringify({ code: 'AAA2' }) })).status, 401);
    await t.login('CCC4');
    // rotating back to the old code doesn't revive the old session
    await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'rotate-a1-0002', ops: [{ k: 'admins', id: 'a1', p: ['code'], v: 'AAA2' }] } });
    assert.equal((await t.json('/api/state', { cookie: a1 })).status, 401);
    // deleting an admin ends their sessions
    await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'delete-a2-0001', ops: [{ k: 'stores', id: 's2', p: ['adminId'], v: null }, { k: 'admins', id: 'a2', p: [], d: 1 }] } });
    assert.equal((await t.json('/api/state', { cookie: a2 })).status, 401);
  } finally {
    await t.close();
  }
});

test('F22: changing SUPER_ADMIN_CODE ends HQ sessions; old deterministic tokens never work', async () => {
  const t = await startTestServer();
  const dataDir = t.dataDir;
  const hq = await seedBasic(t);
  await t.close();

  const t2 = await startTestServer({ dataDir, superCode: 'a-completely-different-hq-code' });
  try {
    assert.equal((await t2.json('/api/state', { cookie: hq })).status, 401);
    assert.equal((await t2.req('/api/login', { method: 'POST', body: JSON.stringify({ code: SUPER }) })).status, 401);
    // the pre-upgrade cookie format: s.<hmac(secret, "super:<code>")> — forge one with the real secret
    const db = new DatabaseSync(path.join(dataDir, 'field-desk.db'), { readOnly: true });
    const secret = (db.prepare("SELECT v FROM meta WHERE k = 'secret'").get() as { v: string }).v;
    db.close();
    const legacySuper = `s.${createHmac('sha256', secret).update('super:a-completely-different-hq-code').digest('hex')}`;
    const legacyAdmin = `a.a1.${createHmac('sha256', secret).update('admin:a1:AAA2').digest('hex')}`;
    for (const token of [legacySuper, legacyAdmin]) assert.equal((await t2.json('/api/state', { cookie: `fd_session=${token}` })).status, 401);
  } finally {
    await t2.close();
  }
});

test('F22: event streams are closed when their session is revoked or expires', async () => {
  let clock = Date.now();
  const t = await startTestServer({ now: () => clock, streamCheckMs: 50 });
  try {
    const hq = await seedBasic(t);
    const a1 = await t.login('AAA2');
    const s1 = await t.req('/api/stream', { cookie: a1 });
    assert.equal(s1.status, 200);
    const ended = readStream(s1);
    await t.req('/api/logout', { method: 'POST', cookie: a1 });
    const got = await ended;
    assert.match(got.text, /"resync":true/);

    const s2 = await t.req('/api/stream', { cookie: hq });
    const ended2 = readStream(s2);
    clock += 8 * DAY; // past HQ's 7 days; the periodic check notices
    const got2 = await ended2;
    assert.match(got2.text, /"resync":true/);

    assert.equal((await t.req('/api/stream', { cookie: a1 })).status, 401);
  } finally {
    await t.close();
  }
});

test('F22: cookie name is configurable, so a test instance can’t clobber a developer’s session', async () => {
  const t = await startTestServer({ cookieName: 'fd_test_session' });
  try {
    const r = await t.req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: SUPER }) });
    assert.match(r.headers.get('set-cookie')!, /^fd_test_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/);
    const cookie = r.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await t.json('/api/me', { cookie })).body.role, 'super');
    assert.equal((await t.json('/api/me', { cookie: cookie.replace('fd_test_session', 'fd_session') })).body.role, null);
  } finally {
    await t.close();
  }
});
