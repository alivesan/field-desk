/*
 * The Steam Guard (OTP) automation over the real API (server/steam-otp.ts, docs/steam-otp-api.md): the bearer key and
 * nothing else on /api/v1/steam/*, the account list and who holds each account now, a code posted with idempotency and
 * ordering, the code reaching HQ and the holding stores (live, and only while unexpired), no client forging one, and
 * the signed "Request code" webhook. Synthetic accounts and codes, a temp data dir, a fake clock, a local receiver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { startTestServer, seedBasic, fixtureStore, SUPER, type TestServer } from './helpers/server.ts';
import { currentSteamStore, steamHolders } from '../src/lib/steam.ts';
import type { Logger } from '../server/log.ts';

const KEY = 'synthetic-steam-api-key-0123456789abcdef';
const HOOK_SECRET = 'synthetic-webhook-secret-for-tests';
const TEAM1 = 'TEM2'; // s1
const TEAM2 = 'TEM3'; // s2
const T0 = Date.parse('2026-10-24T06:00:00.000Z'); // Saturday 24 Oct 2026, 11:30 in Asia/Kolkata; the test campaign is on this day
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const account = (id: string, username: string, email?: string) => ({ id, username, password: `fake-pass-${id}`, ...(email ? { email } : {}), createdAt: '2026-10-20T00:00:00.000Z' });
const assignment = (accountId: string, purpose = 'play') => ({ accountId, purpose, assignedAt: '2026-10-22T00:00:00.000Z' });

interface Hit {
  raw: Buffer;
  headers: IncomingHttpHeaders;
}

/** A local webhook receiver. `script(n)` (n counts from 1) says how request n is answered: a status, or 'hang'. */
async function startReceiver(script: (n: number) => number | 'hang' = () => 202) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ raw: Buffer.concat(chunks), headers: req.headers });
      const mode = script(hits.length);
      if (mode === 'hang') return;
      res.writeHead(mode, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
  const close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return { url, hits, close };
}

const signatureOf = (raw: Buffer, secret = HOOK_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

async function until(pred: () => boolean, what = 'condition', ms = 4000) {
  for (let i = 0; i < ms / 20; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SetupOpts {
  steam?: Record<string, unknown> | null; // null = the automation isn't configured
  log?: Logger;
  dataDir?: string;
}

/**
 * Stores: s1 (admin a1, team TEM2) plays with x; s3 (a1, event day last Saturday) has x for downloads; s2 (a2, team TEM3) downloads
 * with y; s4 and s5 (a2) both download with z; nobody has w. Event day = T0.
 */
async function setup(o: SetupOpts = {}) {
  const clock = { t: T0 };
  const t = await startTestServer({ now: () => clock.t, ...(o.log ? { log: o.log } : {}), ...(o.dataDir ? { dataDir: o.dataDir } : {}), steam: o.steam === null ? { apiKey: '' } : { apiKey: KEY, ...o.steam } } as Parameters<typeof startTestServer>[0]);
  const hq = await seedBasic(t);
  let n = 0;
  const batch = (cookie: string, ops: unknown[]) => t.json('/api/batch', { method: 'POST', cookie, body: { id: `steam-otp-batch-${String(++n).padStart(4, '0')}`, ops } });
  const ok = async (r: Promise<{ status: number; body: any }>) => {
    const x = await r;
    assert.equal(x.status, 200, JSON.stringify(x.body));
  };
  await ok(
    batch(hq, [
      { k: 'stores', id: 's1', p: ['access'], v: { code: TEAM1, createdAt: '2026-10-23T00:00:00.000Z' } },
      { k: 'stores', id: 's2', p: ['access'], v: { code: TEAM2, createdAt: '2026-10-23T00:00:00.000Z' } },
      { k: 'stores', id: 's3', p: [], v: fixtureStore('s3', 'e1', 'a1', { date: '2026-10-17' }) },
      { k: 'stores', id: 's4', p: [], v: fixtureStore('s4', 'e1', 'a2') },
      { k: 'stores', id: 's5', p: [], v: fixtureStore('s5', 'e1', 'a2') },
      { k: 'accounts', id: 'x', p: [], v: account('x', 'test_rog_x', 'Rog.X@example.test') },
      { k: 'accounts', id: 'y', p: [], v: account('y', 'test_rog_y') },
      { k: 'accounts', id: 'z', p: [], v: account('z', 'test_rog_z', 'rog.z@example.test') },
      { k: 'accounts', id: 'w', p: [], v: account('w', 'test_rog_w') },
    ]),
  );
  await ok(
    batch(hq, [
      { k: 'stores', id: 's1', p: ['steam'], v: assignment('x', 'play') },
      { k: 'stores', id: 's3', p: ['steam'], v: assignment('x', 'download') },
      { k: 'stores', id: 's2', p: ['steam'], v: assignment('y', 'download') },
      { k: 'stores', id: 's4', p: ['steam'], v: assignment('z', 'download') },
      { k: 'stores', id: 's5', p: ['steam'], v: assignment('z', 'download') },
    ]),
  );

  /** A call as the automation (key) — or with another credential. `body` objects are sent as JSON, strings as they are. */
  const call = async (method: string, path: string, init: { key?: string | null; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers);
    const key = init.key === undefined ? KEY : init.key;
    if (key) headers.set('Authorization', `Bearer ${key}`);
    if (init.cookie) headers.set('Cookie', init.cookie);
    let body: string | undefined;
    if (init.body !== undefined) {
      body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      headers.set('Content-Type', 'application/json');
    }
    const r = await fetch(t.base + path, { method, headers, body });
    const text = await r.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    return { status: r.status, body: parsed, headers: r.headers, text };
  };
  const accounts = () => call('GET', '/api/v1/steam/accounts');
  const post = (body: Record<string, unknown>, init: { key?: string | null; headers?: Record<string, string> } = {}) =>
    call('POST', '/api/v1/steam/otp', { ...init, body: { accountUsername: 'test_rog_x', code: 'AB3DE', receivedAt: iso(clock.t - 1000), ...body } });
  const state = async (cookie: string) => (await t.json('/api/state', { cookie })).body;
  return { t, hq, clock, batch, call, accounts, post, state };
}

/** /api/stream as a signed-in device sees it. */
function openStream(t: TestServer, cookie: string) {
  const msgs: any[] = [];
  const u = new URL(t.base + '/api/stream');
  let ready!: () => void;
  const connected = new Promise<void>((r) => (ready = r));
  const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { Cookie: cookie } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      if (buf.includes(': connected')) ready();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: {'));
        buf = buf.slice(i + 2);
        if (line) msgs.push(JSON.parse(line.slice(6)));
      }
    });
  });
  req.on('error', () => {});
  const until = async (pred: (m: any) => boolean) => {
    for (let i = 0; i < 40; i++) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no matching stream message within 2 s');
  };
  return { connected, msgs, until, close: () => req.destroy() };
}

test('auth: only the key is accepted on /api/v1/steam/*, and it is accepted nowhere else; unset means 503', async () => {
  const { t, hq, call, accounts } = await setup();
  try {
    const team = await t.login(TEAM1);
    for (const [method, path] of [['GET', '/api/v1/steam/accounts'], ['POST', '/api/v1/steam/otp']] as const) {
      const none = await call(method, path, { key: null, body: method === 'POST' ? {} : undefined });
      assert.deepEqual([none.status, none.body.error], [401, 'unauthorized'], `${path}: no key`);
      assert.equal(typeof none.body.message, 'string');
      const wrong = await call(method, path, { key: KEY.slice(0, -1) + 'X', body: method === 'POST' ? {} : undefined });
      assert.equal(wrong.status, 401, `${path}: wrong key of the same length`);
      assert.equal((await call(method, path, { key: 'short', body: method === 'POST' ? {} : undefined })).status, 401, `${path}: wrong key of another length`);
      // an HQ, admin or store-team session is refused, with or without a (wrong) key
      for (const cookie of [hq, team, await t.login('AAA2')]) {
        assert.equal((await call(method, path, { key: null, cookie, body: method === 'POST' ? {} : undefined })).status, 401, `${path}: session only`);
        assert.equal((await call(method, path, { key: 'nope', cookie, body: method === 'POST' ? {} : undefined })).status, 401, `${path}: session + wrong key`);
      }
      // no echo of the key or the header in any error
      assert.ok(!wrong.text.includes(KEY.slice(0, 10)) && !/bearer/i.test(wrong.text));
    }
    assert.equal((await call('GET', '/api/v1/steam/accounts', { key: KEY, cookie: hq })).status, 200, 'the key works whatever cookie rides along');

    // the key is no session anywhere else
    for (const [method, path, body] of [['GET', '/api/state'], ['GET', '/api/me'], ['POST', '/api/batch', { id: 'steam-key-batch', ops: [] }], ['GET', '/api/stream']] as const) {
      const r = await call(method, path, { body });
      assert.ok(r.status === 401 || (path === '/api/me' && r.body?.role === null), `${method} ${path}: ${r.status} ${r.text}`);
    }
    // the key can't be used to log in either
    assert.equal((await t.json('/api/login', { method: 'POST', body: { code: KEY } })).status, 401);

    assert.equal((await call('DELETE', '/api/v1/steam/accounts')).status, 405);
    assert.equal((await call('GET', '/api/v1/steam/nope')).status, 404);
    assert.equal((await accounts()).status, 200);
  } finally {
    await t.close();
  }
});

test('not configured: both routes answer 503 not_configured, whatever is sent', async () => {
  const { t, call } = await setup({ steam: null });
  try {
    for (const key of [null, KEY]) {
      const get = await call('GET', '/api/v1/steam/accounts', { key });
      assert.deepEqual([get.status, get.body.error], [503, 'not_configured']);
      const post = await call('POST', '/api/v1/steam/otp', { key, body: {} });
      assert.deepEqual([post.status, post.body.error], [503, 'not_configured']);
    }
  } finally {
    await t.close();
  }
});

test('GET accounts: a bare array in the contract’s shape; assignedStoreId from the weekend’s play, a single holder, else null', async () => {
  const { t, clock, call, accounts, post } = await setup();
  try {
    const r = await accounts();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(Array.isArray(r.body), 'a bare array');
    const by = Object.fromEntries(r.body.map((a: any) => [a.accountUsername, a]));
    assert.deepEqual(Object.keys(by).sort(), ['test_rog_w', 'test_rog_x', 'test_rog_y', 'test_rog_z']);
    // x: s1 plays this weekend (s3, last weekend's download, doesn't matter)
    assert.deepEqual(by.test_rog_x, {
      accountUsername: 'test_rog_x',
      accountEmail: 'Rog.X@example.test',
      username: 'test_rog_x', // what the worker reads
      email: 'Rog.X@example.test',
      assignedStoreId: 's1',
      assignedStoreName: 'Store s1',
      active: false,
      receivedAt: null,
      expiresAt: null,
    });
    assert.equal(by.test_rog_y.assignedStoreId, 's2', 'the only store holding it, for downloads');
    assert.equal(by.test_rog_y.accountEmail, null);
    assert.equal(by.test_rog_z.assignedStoreId, null, 'two stores download with it: ambiguous');
    assert.equal(by.test_rog_z.assignedStoreName, null);
    assert.equal(by.test_rog_w.assignedStoreId, null, 'nobody has it');

    // an active code shows as times only — never the code
    assert.equal((await post({ receivedAt: iso(clock.t - 2 * MIN) })).status, 200);
    const again = await accounts();
    const x = again.body.find((a: any) => a.accountUsername === 'test_rog_x');
    assert.deepEqual([x.active, x.receivedAt, x.expiresAt], [true, iso(clock.t - 2 * MIN), iso(clock.t + 8 * MIN)]);
    assert.ok(!again.text.includes('AB3DE'), 'no code in the list');
    assert.ok(!/"code"/.test(again.text));

    // after the weekend nobody holds x (the play week is over, every event day has passed)
    clock.t = Date.parse('2026-10-26T06:00:00.000Z');
    const later = await accounts();
    assert.equal(later.body.find((a: any) => a.accountUsername === 'test_rog_x').assignedStoreId, null);
    assert.equal(later.body.find((a: any) => a.accountUsername === 'test_rog_x').active, false, 'expired by then');
  } finally {
    await t.close();
  }
});

test('currentSteamStore: the weekend’s play beats other holders; several players is ambiguous; downloads need exactly one live holder', () => {
  const ev = { e: { id: 'e', date: '2026-10-24' } } as any;
  const st = (id: string, purpose: 'play' | 'download', date = '', accountId = 'a') => ({ id, eventId: 'e', name: id, date, steam: { accountId, purpose, assignedAt: '' } }) as any;
  const world = (...stores: any[]) => ({ events: ev, stores: Object.fromEntries(stores.map((s) => [s.id, s])) });
  assert.equal(currentSteamStore(world(st('p', 'play'), st('d1', 'download'), st('d2', 'download')), 'a', '2026-10-24')?.id, 'p');
  assert.equal(currentSteamStore(world(st('p1', 'play'), st('p2', 'play')), 'a', '2026-10-24'), null);
  assert.equal(currentSteamStore(world(st('d1', 'download'), st('d2', 'download')), 'a', '2026-10-24'), null);
  assert.equal(currentSteamStore(world(st('d1', 'download'), st('old', 'download', '2026-10-10')), 'a', '2026-10-24')?.id, 'd1', 'a past event day isn’t a holder');
  assert.equal(currentSteamStore(world(st('next', 'download', '2026-11-07')), 'a', '2026-10-24')?.id, 'next', 'a coming store is the only holder');
  assert.deepEqual(steamHolders(world(st('d1', 'download'), st('old', 'download', '2026-10-10')), 'a', '2026-10-24').map((s) => s.id), ['d1']);
  assert.equal(currentSteamStore(world(), 'a', '2026-10-24'), null);
});

test('POST otp: success shape, matching by username / email (trimmed, any case), the code reaches HQ and nobody sees it in the list', async () => {
  const { t, hq, clock, post, state } = await setup();
  try {
    const at = iso(clock.t - 30_000);
    const r = await post({ receivedAt: at });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { ok: true, accountUsername: 'test_rog_x', accountEmail: 'Rog.X@example.test', assignedStoreId: 's1', receivedAt: at, expiresAt: iso(clock.t - 30_000 + 10 * MIN) });
    assert.ok(!r.text.includes('AB3DE'), 'the answer never echoes the code');
    assert.deepEqual((await state(hq)).accounts.x.otp, { code: 'AB3DE', receivedAt: at, expiresAt: iso(clock.t - 30_000 + 10 * MIN) });

    // matching: email alone, username with spaces and capitals, both agreeing
    const newer = iso(clock.t - 10_000);
    assert.equal((await post({ accountUsername: undefined, accountEmail: '  ROG.x@EXAMPLE.test ', code: 'ZZ9ZZ', receivedAt: newer })).status, 200);
    assert.equal((await post({ accountUsername: ' TEST_ROG_X ', accountEmail: 'rog.x@example.test', code: 'ZZ9ZZ', receivedAt: newer })).body.duplicate, true);
    // unknown / disagreeing / ambiguous / nothing named
    for (const body of [
      { accountUsername: 'nobody' },
      { accountUsername: 'test_rog_x', accountEmail: 'rog.z@example.test' },
      { accountUsername: undefined, accountEmail: 'rog.q@example.test' },
      { accountUsername: '' },
    ]) {
      const bad = await post(body);
      assert.deepEqual([bad.status, bad.body.error], [400, 'unknown_account'], JSON.stringify(body));
    }
    assert.equal((await post({ accountUsername: undefined })).body.error, 'invalid_body', 'neither named');
    assert.equal((await post({ accountUsername: 42 })).body.error, 'invalid_body');
    // an account's email can only be used when it has one: y has none
    assert.equal((await post({ accountUsername: undefined, accountEmail: '' })).body.error, 'unknown_account');
  } finally {
    await t.close();
  }
});

test('POST otp: bad bodies — invalid_body, invalid_code, bad Idempotency-Key, body too large', async () => {
  const { t, call, post } = await setup();
  try {
    const bodyOf = (b: unknown) => call('POST', '/api/v1/steam/otp', { body: b });
    for (const raw of ['not json at all LEAKME', '[]', 'null', '"x"', '']) {
      const r = await bodyOf(raw);
      assert.deepEqual([r.status, r.body.error], [400, 'invalid_body'], raw);
      assert.ok(!r.text.includes('LEAKME'), 'nothing of the body comes back');
    }
    assert.equal((await post({ receivedAt: undefined })).body.error, 'invalid_body');
    assert.equal((await post({ receivedAt: 12345 })).body.error, 'invalid_body');
    for (const code of ['ab3de', 'AB3D', 'AB3DEF', 'AB-DE', 12345, null, undefined, 'AB3 E']) {
      const r = await post({ code });
      assert.deepEqual([r.status, r.body.error], [400, 'invalid_code'], String(code));
    }
    for (const k of ['x'.repeat(129), 'has space', 'tab\there', 'é']) {
      const r = await post({}, { headers: { 'Idempotency-Key': k } }).catch(() => null);
      if (r) assert.deepEqual([r.status, r.body.error], [400, 'invalid_idempotency_key'], k);
    }
    const big = await call('POST', '/api/v1/steam/otp', { body: JSON.stringify({ accountUsername: 'test_rog_x', code: 'AB3DE', receivedAt: iso(T0), pad: 'x'.repeat(17 * 1024) }) });
    assert.deepEqual([big.status, big.body.error], [413, 'body_too_large']);
    // 16 KB exactly is still read (and refused for what it is, not its size)
    const edge = JSON.stringify({ pad: 'y'.repeat(16 * 1024 - 10) });
    assert.equal((await call('POST', '/api/v1/steam/otp', { body: edge })).status, 400);
  } finally {
    await t.close();
  }
});

test('POST otp: receivedAt must be ISO and within (now − 10 min, now + 30 s]', async () => {
  const { t, clock, post } = await setup();
  try {
    const stale = async (ms: number) => post({ receivedAt: iso(clock.t + ms) });
    for (const ms of [-10 * MIN, -11 * MIN, 30_001, 5 * MIN]) {
      const r = await stale(ms);
      assert.deepEqual([r.status, r.body.error], [400, 'stale_or_future'], `${ms}`);
    }
    for (const s of ['yesterday', '2026-10-24', '2026-10-24T06:00:00', '1761285600000', '']) {
      const r = await post({ receivedAt: s });
      assert.deepEqual([r.status, r.body.error], [400, 'stale_or_future'], s);
    }
    assert.equal((await stale(-10 * MIN + 1000)).status, 200, 'just inside the past edge');
    assert.equal((await stale(30_000)).status, 200, 'exactly 30 s ahead is allowed');
  } finally {
    await t.close();
  }
});

test('POST otp: an account no store holds (nobody, ambiguous, event past) is 409 not_assigned', async () => {
  const { t, clock, post } = await setup();
  try {
    for (const username of ['test_rog_w', 'test_rog_z']) {
      const r = await post({ accountUsername: username });
      assert.deepEqual([r.status, r.body.error], [409, 'not_assigned'], username);
    }
    assert.equal((await post({ accountUsername: 'test_rog_y' })).body.assignedStoreId, 's2', 'a single download holder is enough');
    clock.t = Date.parse('2026-10-26T06:00:00.000Z'); // Monday: the weekend and every event day are over
    const late = await post({ accountUsername: 'test_rog_y', receivedAt: iso(clock.t - 1000), code: 'QQ1QQ' });
    assert.deepEqual([late.status, late.body.error], [409, 'not_assigned']);
  } finally {
    await t.close();
  }
});

test('POST otp: idempotency — same key + payload repeats the stored answer, another payload is refused, keys outlive a restart and a closed window', async () => {
  const { t, clock, post, state, hq, batch } = await setup();
  let t2: TestServer | undefined;
  try {
    const at = iso(clock.t - MIN);
    const first = await post({ receivedAt: at }, { headers: { 'Idempotency-Key': 'steam-email-aaa111' } });
    assert.equal(first.status, 200);
    assert.equal(first.body.duplicate, undefined);
    const seq = (await state(hq)).seq;
    clock.t += 2 * MIN;
    const again = await post({ receivedAt: at }, { headers: { 'Idempotency-Key': 'steam-email-aaa111' } });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { ...first.body, duplicate: true });
    assert.equal((await state(hq)).seq, seq, 'nothing was committed again');

    for (const change of [{ code: 'ZZ9ZZ' }, { receivedAt: iso(clock.t - 1000) }, { accountUsername: 'test_rog_y' }]) {
      const reused = await post(change, { headers: { 'Idempotency-Key': 'steam-email-aaa111' } });
      assert.deepEqual([reused.status, reused.body.error], [409, 'idempotency_key_reused'], JSON.stringify(change));
    }
    assert.ok(!(await state(hq)).accounts.x.otp.code.includes('ZZ9ZZ'));

    // a key only counts once something was stored under it: a refused request leaves it free
    const refused = await post({ receivedAt: iso(clock.t + 10 * MIN) }, { headers: { 'Idempotency-Key': 'steam-email-bbb222' } });
    assert.equal(refused.status, 400);
    assert.equal((await post({ receivedAt: iso(clock.t - 1000), code: 'KK2KK' }, { headers: { 'Idempotency-Key': 'steam-email-bbb222' } })).status, 200);

    // …even when the retry comes after the code's own window closed, and after a restart (the table is in the database)
    clock.t += 20 * MIN;
    const late = await post({ receivedAt: at }, { headers: { 'Idempotency-Key': 'steam-email-aaa111' } });
    assert.deepEqual([late.status, late.body.duplicate], [200, true]);
    const dataDir = t.dataDir;
    await t.close();
    t2 = await startTestServer({ dataDir, now: () => clock.t, steam: { apiKey: KEY } } as Parameters<typeof startTestServer>[0]);
    const r = await fetch(t2.base + '/api/v1/steam/otp', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Idempotency-Key': 'steam-email-aaa111' }, body: JSON.stringify({ accountUsername: 'test_rog_x', code: 'AB3DE', receivedAt: at }) });
    assert.deepEqual([r.status, (await r.json()).duplicate], [200, true]);
    void batch;
  } finally {
    await (t2 ?? t).close().catch(() => {});
  }
});

test('POST otp: an older code never replaces a newer one; the same time with another code is refused; the same code again is a duplicate that doesn’t extend expiry', async () => {
  const { t, clock, post, state, hq } = await setup();
  try {
    const t1 = clock.t - 5 * MIN;
    assert.equal((await post({ receivedAt: iso(t1), code: 'CODE1' })).status, 200);

    const older = await post({ receivedAt: iso(t1 - 1000), code: 'CODE0' });
    assert.deepEqual([older.status, older.body.error], [409, 'older_than_current']);
    const clash = await post({ receivedAt: iso(t1), code: 'CODE2' });
    assert.deepEqual([clash.status, clash.body.error], [409, 'conflicting_code']);
    assert.equal((await state(hq)).accounts.x.otp.code, 'CODE1', 'neither changed the stored code');

    // the same code again, minutes later, without a key: 200 duplicate, same expiry
    clock.t += 3 * MIN;
    const seq = (await state(hq)).seq;
    const dup = await post({ receivedAt: iso(t1), code: 'CODE1' });
    assert.equal(dup.status, 200);
    assert.deepEqual([dup.body.duplicate, dup.body.expiresAt], [true, iso(t1 + 10 * MIN)]);
    assert.equal((await state(hq)).accounts.x.otp.expiresAt, iso(t1 + 10 * MIN), 'expiry stays receivedAt + 10 min');
    assert.equal((await state(hq)).seq, seq, 'nothing committed');

    // a genuinely newer code replaces it, and its own expiry counts from its own receivedAt
    const t2 = clock.t - MIN;
    const newer = await post({ receivedAt: iso(t2), code: 'CODE3' });
    assert.deepEqual([newer.status, newer.body.duplicate, newer.body.expiresAt], [200, undefined, iso(t2 + 10 * MIN)]);
    assert.equal((await state(hq)).accounts.x.otp.code, 'CODE3');
  } finally {
    await t.close();
  }
});

test('nobody can write a code but the server: HQ batches (field, whole document, new account), admins and teams are refused', async () => {
  const { t, hq, clock, batch, post, state } = await setup();
  try {
    const forged = { code: 'FAKE1', receivedAt: iso(clock.t - 1000), expiresAt: iso(clock.t + 9 * MIN) };
    const field = await batch(hq, [{ k: 'accounts', id: 'x', p: ['otp'], v: forged }]);
    assert.deepEqual([field.status, field.body.code], [403, 'protected']);
    const sub = await batch(hq, [{ k: 'accounts', id: 'x', p: ['otp', 'code'], v: 'FAKE1' }]);
    assert.equal(sub.status, 403);
    const whole = await batch(hq, [{ k: 'accounts', id: 'x', p: [], v: { ...account('x', 'test_rog_x'), otp: forged } }]);
    assert.equal(whole.status, 403);
    const fresh = await batch(hq, [{ k: 'accounts', id: 'n', p: [], v: { ...account('n', 'test_rog_n'), otp: forged } }]);
    assert.equal(fresh.status, 403);
    assert.equal((await state(hq)).accounts.n, undefined);
    assert.equal((await state(hq)).accounts.x.otp, undefined);

    // admins and teams can't touch accounts at all
    for (const code of ['AAA2', TEAM1]) {
      const cookie = await t.login(code);
      assert.equal((await batch(cookie, [{ k: 'accounts', id: 'x', p: ['otp'], v: forged }])).status, 403, code);
    }

    // with a real code stored: HQ's ordinary edits go through; erasing or swapping the code doesn't
    assert.equal((await post({ receivedAt: iso(clock.t - 1000), code: 'REAL1' })).status, 200);
    const real = (await state(hq)).accounts.x;
    assert.equal((await batch(hq, [{ k: 'accounts', id: 'x', p: ['notes'], v: 'moved' }])).status, 200);
    assert.equal((await batch(hq, [{ k: 'accounts', id: 'x', p: [], v: { ...real, label: 'ROG X' } }])).status, 200, 'a whole document that keeps the code as it is');
    assert.equal((await batch(hq, [{ k: 'accounts', id: 'x', p: [], v: { ...real, otp: undefined } }])).status, 403, 'dropping it');
    assert.equal((await batch(hq, [{ k: 'accounts', id: 'x', p: ['otp'], v: forged }])).status, 403, 'swapping it');
    assert.equal((await batch(hq, [{ k: 'accounts', id: 'x', p: ['otp'], d: 1 }])).status, 403, 'deleting it');
    assert.equal((await state(hq)).accounts.x.otp.code, 'REAL1');
    // deleting the whole account is HQ's call and takes its code with it
    assert.equal((await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], d: 1 }, { k: 'stores', id: 's3', p: ['steam'], d: 1 }, { k: 'accounts', id: 'x', p: [], d: 1 }])).status, 200);
  } finally {
    await t.close();
  }
});

test('who sees the code: HQ, and the team and admin of every store holding the account (event not past), only while unexpired', async () => {
  const { t, hq, clock, post, state } = await setup();
  try {
    const team1 = await t.login(TEAM1); // s1: plays with x
    const team2 = await t.login(TEAM2); // s2: has y
    const admin1 = await t.login('AAA2'); // a1: s1 and s3 (x's past download)
    const admin2 = await t.login('BBB3'); // a2: s2, s4, s5
    const otpOf = async (cookie: string, storeId: string) => (await state(cookie)).stores[storeId]?.steamLogin?.otp;

    assert.equal(await otpOf(team1, 's1'), undefined, 'nothing yet');
    const at = iso(clock.t - MIN);
    assert.equal((await post({ receivedAt: at, code: 'SHOW1' })).status, 200);
    const expected = { code: 'SHOW1', receivedAt: at, expiresAt: iso(clock.t - MIN + 10 * MIN) };

    assert.deepEqual(await otpOf(team1, 's1'), expected, 'the store’s team');
    assert.deepEqual(await otpOf(admin1, 's1'), expected, 'the store’s named admin');
    assert.equal(await otpOf(admin1, 's3'), undefined, 'a store holding x whose event day has passed gets no code');
    assert.ok((await state(admin1)).stores.s3.steamLogin, 'it still has its login');
    assert.equal(await otpOf(team2, 's2'), undefined, 'another store, another account');
    assert.equal(await otpOf(admin2, 's2'), undefined);
    assert.equal((await state(admin2)).stores.s1, undefined, 'admins of other stores don’t even get that store');
    assert.ok(!JSON.stringify(await state(team2)).includes('SHOW1'), 'nowhere in another team’s snapshot');
    assert.ok(!JSON.stringify(await state(admin2)).includes('SHOW1'));
    assert.deepEqual((await state(hq)).accounts.x.otp, expected, 'HQ has it on the account');
    assert.equal((await state(team1)).accounts && Object.keys((await state(team1)).accounts).length, 0, 'the account itself never reaches a team');

    // any purpose counts: s2 takes x for downloads too (after its y is dropped) and sees the same code
    assert.equal((await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'steam-otp-move-0001', ops: [{ k: 'stores', id: 's2', p: ['steam', 'accountId'], v: 'x' }] } })).status, 200);
    assert.deepEqual(await otpOf(team2, 's2'), expected, 'a second holder, for downloads');
    assert.deepEqual(await otpOf(admin2, 's2'), expected);

    // only while unexpired at projection time
    clock.t += 9 * MIN + 1000;
    assert.equal(await otpOf(team1, 's1'), undefined, 'expired a second ago');
    assert.equal(await otpOf(team2, 's2'), undefined);
    assert.ok((await state(hq)).accounts.x.otp, 'HQ’s account keeps the last code on record');
  } finally {
    await t.close();
  }
});

test('a posted code reaches HQ and the holding stores live (SSE) — and no other store’s device', async () => {
  const { t, hq, clock, post } = await setup();
  const streams: { close(): void }[] = [];
  try {
    const team1 = await t.login(TEAM1);
    const team2 = await t.login(TEAM2);
    const open = async (cookie: string) => {
      const s = openStream(t, cookie);
      streams.push(s);
      await s.connected;
      return s;
    };
    const [sHq, sTeam1, sTeam2] = [await open(hq), await open(team1), await open(team2)];
    assert.equal((await post({ receivedAt: iso(clock.t - 1000), code: 'LIVE1' })).status, 200);

    const hqMsg = await sHq.until((m) => m.ops?.some((o: any) => o.k === 'accounts' && o.id === 'x'));
    assert.ok(JSON.stringify(hqMsg).includes('LIVE1'));
    const teamMsg = await sTeam1.until((m) => m.ops?.some((o: any) => o.k === 'stores' && o.id === 's1'));
    assert.equal(teamMsg.ops.find((o: any) => o.id === 's1').v.steamLogin.otp.code, 'LIVE1');
    await pause(150);
    assert.ok(!sTeam1.msgs.some((m) => JSON.stringify(m).includes('"accounts"')), 'the team never gets the account');
    assert.ok(!JSON.stringify(sTeam2.msgs).includes('LIVE1'), 'another store’s team hears nothing of it');
  } finally {
    for (const s of streams) s.close();
    await t.close();
  }
});

test('request webhook: signed over the exact bytes, the payload the worker verifies, who may press, and the 60 s limit', async () => {
  const rx = await startReceiver(() => 202);
  const { t, hq, clock, state } = await setup({ steam: { webhookUrl: rx.url, webhookSecret: HOOK_SECRET } });
  try {
    const team1 = await t.login(TEAM1);
    const team2 = await t.login(TEAM2);
    const admin1 = await t.login('AAA2');
    const admin2 = await t.login('BBB3');
    const press = (cookie: string, storeId = 's1') => t.json('/api/steam/otp-request', { method: 'POST', cookie, body: { storeId } });

    assert.equal((await state(team1)).stores.s1.steamLogin.otpRequest, true, 'the card is told the button works');
    assert.equal((await state(team1)).stores.s1.steamLogin.otpRequestedAt, undefined);

    const first = await press(team1);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual([first.body.ok, first.body.duplicate, first.body.requestedAt], [true, false, iso(clock.t)]);
    await until(() => rx.hits.length === 1, 'the webhook');

    const hit = rx.hits[0];
    assert.equal(hit.headers['content-type'], 'application/json');
    assert.equal(hit.headers['x-fielddesk-signature'], signatureOf(hit.raw), 'HMAC-SHA256 over the raw bytes received');
    const payload = JSON.parse(hit.raw.toString('utf8'));
    assert.deepEqual(Object.keys(payload).sort(), ['accountEmail', 'accountUsername', 'at', 'id', 'storeId', 'storeName', 'type']);
    assert.match(payload.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(
      { ...payload, id: 'ID' },
      { id: 'ID', type: 'steam.otp.requested', at: iso(clock.t), storeId: 's1', storeName: 'Store s1', accountUsername: 'test_rog_x', accountEmail: 'Rog.X@example.test' },
    );
    assert.notEqual(hit.headers['x-fielddesk-signature'], signatureOf(Buffer.from(hit.raw.toString('utf8').replace('s1', 's2')), HOOK_SECRET), 'a changed body wouldn’t verify');
    assert.notEqual(hit.headers['x-fielddesk-signature'], signatureOf(hit.raw, 'another-secret'));

    // the team can see it was asked (every device on the store, after a reload)
    assert.equal((await state(team1)).stores.s1.steamLogin.otpRequestedAt, iso(clock.t));
    assert.equal((await state(admin1)).stores.s1.steamLogin.otpRequestedAt, iso(clock.t));

    // inside the minute: the existing request comes back, nothing is sent
    clock.t += 59_000;
    const second = await press(admin1);
    assert.deepEqual([second.status, second.body.duplicate, second.body.requestedAt], [200, true, first.body.requestedAt]);
    await pause(150);
    assert.equal(rx.hits.length, 1);
    // after it: a new request with a new id
    clock.t += 2000;
    const third = await press(team1);
    assert.deepEqual([third.status, third.body.duplicate], [200, false]);
    await until(() => rx.hits.length === 2, 'the second webhook');
    assert.notEqual(JSON.parse(rx.hits[1].raw.toString('utf8')).id, payload.id);
    assert.equal(rx.hits[1].headers['x-fielddesk-signature'], signatureOf(rx.hits[1].raw));

    // who may press: the store’s team or admin, and HQ — not another store’s people, nobody signed out, no account to ask for
    assert.equal((await press(team2)).status, 404, 'another store’s team');
    assert.equal((await press(admin2)).status, 404, 'another store’s admin');
    assert.equal((await t.json('/api/steam/otp-request', { method: 'POST', body: { storeId: 's1' } })).status, 401);
    assert.equal((await press(team1, 'nope')).status, 404);
    assert.equal((await t.json('/api/steam/otp-request', { method: 'POST', cookie: team1, body: { storeId: 'bad id!' } })).status, 400);
    const viaHq = await press(hq, 's2');
    assert.equal(viaHq.status, 200, 'HQ, for a store holding y');
    await until(() => rx.hits.length === 3, 'HQ’s webhook');
    assert.equal(JSON.parse(rx.hits[2].raw.toString('utf8')).accountEmail, undefined, 'no email on y: the field is left out');
    assert.equal(JSON.parse(rx.hits[2].raw.toString('utf8')).accountUsername, 'test_rog_y');
    assert.equal((await press(hq, 's5')).status, 200);
    await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'steam-otp-unassign-1', ops: [{ k: 'stores', id: 's4', p: ['steam'], d: 1 }] } });
    assert.equal((await press(hq, 's4')).status, 409, 'a store with no Steam account');
    clock.t = Date.parse('2026-10-26T06:00:00.000Z');
    assert.equal((await press(hq, 's1')).status, 409, 'its event day has passed');
  } finally {
    await t.close();
    await rx.close();
  }
});

test('request webhook: off without both settings — no button, and pressing it is refused', async () => {
  for (const steam of [{}, { webhookUrl: 'http://127.0.0.1:9/hook' }, { webhookSecret: HOOK_SECRET }, { webhookUrl: 'ftp://example.test/x', webhookSecret: HOOK_SECRET }]) {
    const { t } = await setup({ steam });
    try {
      const team1 = await t.login(TEAM1);
      assert.equal((await t.json('/api/state', { cookie: team1 })).body.stores.s1.steamLogin.otpRequest, undefined, JSON.stringify(steam));
      const r = await t.json('/api/steam/otp-request', { method: 'POST', cookie: team1, body: { storeId: 's1' } });
      assert.deepEqual([r.status, r.body.code], [404, 'not-configured']);
    } finally {
      await t.close();
    }
  }
});

test('request webhook delivery: 5xx, a timeout and a dropped connection are retried with the same id and bytes; 2xx ends it', async () => {
  const rx = await startReceiver((n) => (n === 1 ? 'hang' : n === 2 ? 503 : n === 3 ? 500 : 202));
  const { t } = await setup({ steam: { webhookUrl: rx.url, webhookSecret: HOOK_SECRET, retryDelaysMs: [20], attemptTimeoutMs: 150 } });
  try {
    const team1 = await t.login(TEAM1);
    assert.equal((await t.json('/api/steam/otp-request', { method: 'POST', cookie: team1, body: { storeId: 's1' } })).status, 200);
    await until(() => rx.hits.length === 4, 'four attempts');
    await pause(250);
    assert.equal(rx.hits.length, 4, 'the 202 ended it');
    const [a, ...rest] = rx.hits;
    for (const h of rest) {
      assert.ok(h.raw.equals(a.raw), 'the very same bytes');
      assert.equal(h.headers['x-fielddesk-signature'], a.headers['x-fielddesk-signature']);
    }
    assert.equal(a.headers['x-fielddesk-signature'], signatureOf(a.raw));
    assert.equal(new Set(rx.hits.map((h) => JSON.parse(h.raw.toString('utf8')).id)).size, 1, 'one id throughout');
  } finally {
    await t.close();
    await rx.close();
  }
});

test('request webhook delivery: a 4xx is final (no retry); a refusal doesn’t block the next press after a minute; retries stop 10 minutes after `at`', async () => {
  const rx4 = await startReceiver(() => 400);
  const a = await setup({ steam: { webhookUrl: rx4.url, webhookSecret: HOOK_SECRET, retryDelaysMs: [20] } });
  try {
    const team1 = await a.t.login(TEAM1);
    assert.equal((await a.t.json('/api/steam/otp-request', { method: 'POST', cookie: team1, body: { storeId: 's1' } })).status, 200);
    await until(() => rx4.hits.length === 1, 'the first attempt');
    await pause(300);
    assert.equal(rx4.hits.length, 1, 'a 400 is not retried');
  } finally {
    await a.t.close();
    await rx4.close();
  }

  const rx5 = await startReceiver(() => 503);
  const b = await setup({ steam: { webhookUrl: rx5.url, webhookSecret: HOOK_SECRET, retryDelaysMs: [20] } });
  try {
    const team1 = await b.t.login(TEAM1);
    assert.equal((await b.t.json('/api/steam/otp-request', { method: 'POST', cookie: team1, body: { storeId: 's1' } })).status, 200);
    await until(() => rx5.hits.length >= 3, 'retries');
    b.clock.t += 10 * MIN + 1000; // past `at` + 10 minutes: the next retry is out of time
    await pause(200);
    const settled = rx5.hits.length;
    await pause(300);
    assert.equal(rx5.hits.length, settled, 'gave up');
    // pressing again after the minute starts a fresh request
    const again = await b.t.json('/api/steam/otp-request', { method: 'POST', cookie: team1, body: { storeId: 's1' } });
    assert.deepEqual([again.status, again.body.duplicate], [200, false]);
  } finally {
    await b.t.close();
    await rx5.close();
  }
});

test('privacy: nothing logged holds a code, the key, an Authorization header or any part of a request body', async () => {
  const lines: string[] = [];
  const log: Logger = (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields }));
  const rx = await startReceiver(() => 202);
  const { t, clock, call, post } = await setup({ log, steam: { webhookUrl: rx.url, webhookSecret: HOOK_SECRET } });
  try {
    await post({ receivedAt: iso(clock.t - 1000), code: 'SEKRT' }, { headers: { 'Idempotency-Key': 'steam-email-privacy1' } });
    await post({ code: 'SEKRT', receivedAt: iso(clock.t - 1000) }, { key: 'wrong-key-LEAKME-123' });
    await call('POST', '/api/v1/steam/otp', { body: '{"code": "SEKRT", LEAKME' });
    await call('POST', '/api/v1/steam/otp', { body: JSON.stringify({ pad: 'x'.repeat(20000), code: 'SEKRT' }) });
    await call('GET', '/api/v1/steam/accounts');
    const team1 = await t.login(TEAM1);
    await t.json('/api/steam/otp-request', { method: 'POST', cookie: team1, body: { storeId: 's1' } });
    await pause(100);
    const all = lines.join('\n');
    for (const secret of ['SEKRT', KEY, 'LEAKME', 'wrong-key', 'Bearer', 'Authorization', HOOK_SECRET, rx.url, 'steam-email-privacy1']) {
      assert.ok(!all.includes(secret), `the log mentions ${secret}`);
    }
    assert.ok(lines.some((l) => l.includes('steam-otp-stored')), 'the one line about a stored code names accounts and stores only');
  } finally {
    await t.close();
    await rx.close();
  }
});

test('the code and the request state survive what they should: a restart keeps the code, loses the pending request', async () => {
  const rx = await startReceiver(() => 202);
  const first = await setup({ steam: { webhookUrl: rx.url, webhookSecret: HOOK_SECRET } });
  let second: TestServer | undefined;
  try {
    assert.equal((await first.post({ receivedAt: iso(first.clock.t - 1000), code: 'KEEP1' })).status, 200);
    const team1 = await first.t.login(TEAM1);
    await first.t.json('/api/steam/otp-request', { method: 'POST', cookie: team1, body: { storeId: 's1' } });
    const dataDir = first.t.dataDir;
    await first.t.close();
    second = await startTestServer({ dataDir, now: () => first.clock.t, steam: { apiKey: KEY, webhookUrl: rx.url, webhookSecret: HOOK_SECRET } } as Parameters<typeof startTestServer>[0]);
    const cookie = await second.login(TEAM1);
    const login = (await second.json('/api/state', { cookie })).body.stores.s1.steamLogin;
    assert.equal(login.otp.code, 'KEEP1');
    assert.equal(login.otpRequestedAt, undefined, 'a request is a polling hint, kept in memory only');
    void SUPER;
  } finally {
    await (second ?? first.t).close().catch(() => {});
    await rx.close();
  }
});
