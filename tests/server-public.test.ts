import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, seedBasic, fixtureStore, writeDocForTests, SUPER, type TestServer } from './helpers/server.ts';
import type { Logger } from '../server/log.ts';

/* Player self check-in: GET/POST /api/public/checkin/:token, no session. */

const TOKEN = 'tok_S1-synthetic-0001';
const TOKEN2 = 'tok_S2-synthetic-0002';
const players = [
  { id: 'p1', name: 'Asha Rao', seed: 1, phone: '9820011111' },
  { id: 'p2', name: 'Vikram', seed: 2, phone: '9820022222' },
  { id: 'p3', name: 'Twin One', seed: 3, phone: '9820033333' },
  { id: 'p4', name: 'Twin Two', seed: 4, phone: '9820033333' },
  { id: 'p5', name: 'No Phone', seed: 5 },
];

/** seedBasic, then players with phones + self check-in written straight to the database (only commands may set players). */
async function setup(opts: Record<string, unknown> = {}, s1Open = true) {
  const t0 = await startTestServer();
  await seedBasic(t0);
  await t0.close();
  const day = (token: string, open: boolean) => ({ players, checkIn: {}, matches: [], stations: 2, version: 1, selfCheckIn: { token, open, openedAt: '2026-10-24T09:00:00.000Z' } });
  writeDocForTests(t0.dataDir, 'stores', fixtureStore('s1', 'e1', 'a1', { day: day(TOKEN, s1Open) }));
  writeDocForTests(t0.dataDir, 'stores', fixtureStore('s2', 'e1', 'a2', { day: day(TOKEN2, false) }));
  const t = await startTestServer({ dataDir: t0.dataDir, ...opts });
  return { t, hq: await t.login(SUPER), a1: await t.login('AAA2'), a2: await t.login('BBB3') };
}

const checkin = (t: TestServer, token: string, body: unknown, headers: Record<string, string> = {}) =>
  t.json(`/api/public/checkin/${token}`, { method: 'POST', body, headers });
const seqOf = async (t: TestServer, cookie: string) => (await t.json('/api/state', { cookie })).body.seq as number;
const batch = (t: TestServer, cookie: string, id: string, ops: unknown[]) => t.json('/api/batch', { method: 'POST', cookie, body: { id, ops } });

/** Opens /api/stream; `next(pred)` resolves with the first data message matching pred. */
function openStream(t: TestServer, cookie: string) {
  const msgs: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
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
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: {'));
        if (!line) continue;
        const m = JSON.parse(line.slice(6));
        msgs.push(m);
        for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
      }
    });
  });
  req.on('error', () => {});
  return {
    connected,
    next: (pred: (m: any) => boolean) =>
      new Promise<any>((resolve, reject) => {
        const hit = msgs.find(pred);
        if (hit) return resolve(hit);
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('no matching stream message within 2 s')), 2000).unref();
      }),
    close: () => req.destroy(),
  };
}

test('public GET: store, campaign, date and open — never players; unknown / malformed token → 404', async () => {
  const { t } = await setup();
  try {
    const r = await t.json(`/api/public/checkin/${TOKEN}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { store: 'Store s1', campaign: 'Synthetic Campaign', date: '2026-10-24', open: true });
    const raw = JSON.stringify(r.body);
    for (const p of players) {
      assert.ok(!raw.includes(p.name), 'no player names');
      if (p.phone) assert.ok(!raw.includes(p.phone.slice(-4)), 'no phone digits');
    }
    assert.deepEqual((await t.json(`/api/public/checkin/${TOKEN2}`)).body.open, false);
    for (const bad of ['tok_unknown-000000000', 'short', 'has.dot.in.it.0000000', `${'x'.repeat(65)}`]) {
      const n = await t.json(`/api/public/checkin/${bad}`);
      assert.equal(n.status, 404, bad);
      assert.equal(n.body.code, 'not-found');
    }
  } finally {
    await t.close();
  }
});

test('public POST: a matching number checks the player in (source self) with a new seq; again → already, no new seq', async () => {
  const { t, hq } = await setup();
  try {
    const before = await seqOf(t, hq);
    const r = await checkin(t, TOKEN, { phone: '+91 98200 11111' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, name: 'Asha R.', already: false });
    assert.equal(await seqOf(t, hq), before + 1);
    const s = (await t.json('/api/state', { cookie: hq })).body.stores.s1;
    assert.ok(Date.parse(s.day.checkIn.p1) > 0);
    assert.equal(s.day.checkInSource.p1, 'self');

    const again = await checkin(t, TOKEN, { phone: '09820011111' });
    assert.deepEqual(again.body, { ok: true, name: 'Asha R.', already: true });
    assert.equal(await seqOf(t, hq), before + 1, 'idempotent: no new seq');
    assert.equal((await t.json('/api/state', { cookie: hq })).body.stores.s1.day.checkIn.p1, s.day.checkIn.p1, 'time unchanged');
  } finally {
    await t.close();
  }
});

test('public POST: someone the desk already checked in → already, source stays staff', async () => {
  const { t, a1, hq } = await setup();
  try {
    assert.equal((await batch(t, a1, 'staff-checkin-01', [{ k: 'stores', id: 's1', p: ['day', 'checkIn', 'p2'], v: '2026-10-24T09:30:00.000Z' }])).status, 200);
    const seq = await seqOf(t, hq);
    const r = await checkin(t, TOKEN, { phone: '9820022222' });
    assert.deepEqual(r.body, { ok: true, name: 'Vikram', already: true });
    assert.equal(await seqOf(t, hq), seq);
    const day = (await t.json('/api/state', { cookie: hq })).body.stores.s1.day;
    assert.equal(day.checkIn.p2, '2026-10-24T09:30:00.000Z');
    assert.equal(day.checkInSource?.p2, undefined);
  } finally {
    await t.close();
  }
});

test('public POST: no match 404, shared number 409, not a phone 400, closed 403 — none commit', async () => {
  const { t, hq, a1 } = await setup();
  try {
    const seq = await seqOf(t, hq);
    let r = await checkin(t, TOKEN, { phone: '9999999999' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { code: 'no-match', error: 'We couldn’t find that number. Check it, or ask at the desk.' });
    r = await checkin(t, TOKEN, { phone: '98200 33333' });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { code: 'ambiguous', error: 'ask at the desk' });
    for (const bad of [{}, { phone: 'abc' }, { phone: 9820011111 }, { phone: '12' }, { phone: '9'.repeat(50) }]) {
      r = await checkin(t, TOKEN, bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.code, 'bad-request');
    }
    r = await checkin(t, TOKEN2, { phone: '9820011111' });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { code: 'closed', error: 'Check-in isn’t open yet — ask at the desk' });
    assert.equal(await seqOf(t, hq), seq);

    // the admin closes s1: same 403, and it says nothing about whether the number is registered
    assert.equal((await batch(t, a1, 'close-checkin-1', [{ k: 'stores', id: 's1', p: ['day', 'selfCheckIn', 'open'], v: false }])).status, 200);
    assert.equal((await checkin(t, TOKEN, { phone: '9820011111' })).status, 403);
    assert.equal((await checkin(t, TOKEN, { phone: '9999999999' })).status, 403);
  } finally {
    await t.close();
  }
});

test('public POST: broadcast to the store’s admin and HQ (not other admins); admin state shows source self', async () => {
  const { t, hq, a1, a2 } = await setup();
  const sa1 = openStream(t, a1);
  const sa2 = openStream(t, a2);
  const shq = openStream(t, hq);
  try {
    await Promise.all([sa1.connected, sa2.connected, shq.connected]);
    const seq = await seqOf(t, hq);
    assert.equal((await checkin(t, TOKEN, { phone: '9820011111' })).status, 200);
    const m1 = await sa1.next((m) => m.seq === seq + 1);
    const paths = m1.ops.map((o: any) => `${o.k}/${o.id}:${o.p.join('.')}`);
    assert.ok(paths.includes('stores/s1:day.checkIn.p1'), JSON.stringify(paths));
    assert.ok(paths.some((p: string) => p.startsWith('stores/s1:day.checkInSource')), JSON.stringify(paths));
    assert.match(m1.id, /^player-/);
    assert.ok((await shq.next((m) => m.seq === seq + 1)).ops.length > 0);
    assert.deepEqual((await sa2.next((m) => m.seq === seq + 1)).ops, [], 'a2 gets the seq, not s1’s data');

    const st = (await t.json('/api/state', { cookie: a1 })).body.stores.s1.day;
    assert.equal(st.checkInSource.p1, 'self');
    assert.ok(st.checkIn.p1);
  } finally {
    sa1.close();
    sa2.close();
    shq.close();
    await t.close();
  }
});

test('public: a rotated token stops working at once; tokens must be unique across stores', async () => {
  const { t, a1, a2 } = await setup();
  try {
    const NEW = 'tok_S1-rotated-000099';
    assert.equal((await batch(t, a1, 'rotate-token-01', [{ k: 'stores', id: 's1', p: ['day', 'selfCheckIn', 'token'], v: NEW }])).status, 200);
    assert.equal((await t.json(`/api/public/checkin/${TOKEN}`)).status, 404);
    const r = await checkin(t, TOKEN, { phone: '9820011111' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'not-found');
    assert.equal((await t.json(`/api/public/checkin/${NEW}`)).status, 200);
    assert.equal((await checkin(t, NEW, { phone: '9820011111' })).body.ok, true);

    const dup = await batch(t, a2, 'dup-token-00001', [{ k: 'stores', id: 's2', p: ['day', 'selfCheckIn', 'token'], v: NEW }]);
    assert.equal(dup.status, 400);
    assert.ok(dup.body.problems.some((p: string) => /selfCheckIn\.token: is already used by another store/.test(p)), JSON.stringify(dup.body));
  } finally {
    await t.close();
  }
});

test('public: per-address limit — failures cost more, spoofed X-Forwarded-For ignored by default', async () => {
  const { t } = await setup({ publicLimits: { perIp: 10, failCost: 4 } });
  try {
    // 1 success (1) + 2 misses (8) = 9 < 10: a third miss is still let through (→ 13), then nothing is
    assert.equal((await checkin(t, TOKEN, { phone: '9820011111' })).status, 200);
    assert.equal((await checkin(t, TOKEN, { phone: '9000000001' }, { 'X-Forwarded-For': '10.0.0.1' })).status, 404);
    assert.equal((await checkin(t, TOKEN, { phone: '9000000002' }, { 'X-Forwarded-For': '10.0.0.2' })).status, 404);
    assert.equal((await checkin(t, TOKEN, { phone: '9000000003' }, { 'X-Forwarded-For': '10.0.0.3' })).status, 404);
    const r = await checkin(t, TOKEN, { phone: '9820022222' }, { 'X-Forwarded-For': '10.9.9.9' });
    assert.equal(r.status, 429, 'a fresh "address" in the header buys nothing — even the right number is refused');
    assert.equal(r.body.code, 'rate-limited');
    const raw = await t.req(`/api/public/checkin/${TOKEN}`);
    assert.equal(raw.status, 429, 'the GET is limited too');
    assert.ok(Number(raw.headers.get('retry-after')) > 0);
  } finally {
    await t.close();
  }
});

test('public: per-address limit honours TRUST_PROXY; per-store limit caps a distributed guesser', async () => {
  const { t } = await setup({ trustProxy: 1, publicLimits: { perIp: 8, failCost: 4, perStore: 5 } });
  try {
    const from = (ip: string) => ({ 'X-Forwarded-For': ip });
    assert.equal((await checkin(t, TOKEN, { phone: '9000000001' }, from('198.51.100.1'))).status, 404);
    assert.equal((await checkin(t, TOKEN, { phone: '9000000002' }, from('198.51.100.1'))).status, 404);
    assert.equal((await checkin(t, TOKEN, { phone: '9000000003' }, from('198.51.100.1'))).status, 429, 'that address is out');
    assert.equal((await checkin(t, TOKEN, { phone: '9820011111' }, from('198.51.100.2'))).status, 200, 'another address is not');
    // store bucket: 3 attempts so far (the 429 didn't count); two more from fresh addresses fill it
    assert.equal((await checkin(t, TOKEN, { phone: '9000000004' }, from('198.51.100.3'))).status, 404);
    assert.equal((await checkin(t, TOKEN, { phone: '9000000005' }, from('198.51.100.4'))).status, 404);
    const r = await t.req(`/api/public/checkin/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...from('198.51.100.5') }, body: JSON.stringify({ phone: '9820022222' }) });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    // the per-store cap is that store's alone, and the GET stays available
    assert.equal((await t.json(`/api/public/checkin/${TOKEN}`, { headers: from('198.51.100.6') })).status, 200);
    assert.equal((await checkin(t, TOKEN2, { phone: '9820022222' }, from('198.51.100.7'))).status, 403);
  } finally {
    await t.close();
  }
});

test('public: works without a session, ignores one if present, and keeps the cross-origin check', async () => {
  const { t, a2 } = await setup();
  try {
    // a2's cookie (another store's admin) on the player's phone doesn't matter either way
    const r = await t.json(`/api/public/checkin/${TOKEN}`, { method: 'POST', cookie: a2, headers: { 'X-Field-Desk-Principal': 'admin:someone-else' }, body: { phone: '9820011111' } });
    assert.equal(r.status, 200);
    const x = await t.json(`/api/public/checkin/${TOKEN}`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: { phone: '9820022222' } });
    assert.equal(x.status, 403);
    assert.equal(x.body.code, 'forbidden');
    assert.equal((await t.json(`/api/public/checkin/${TOKEN}`, { method: 'PUT', body: { phone: '9820022222' } })).status, 405);
  } finally {
    await t.close();
  }
});

test('public: logs never carry the token or a phone number', async () => {
  const lines: string[] = [];
  const log: Logger = (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields }));
  const { t } = await setup({ log, publicLimits: { perIp: 6 } });
  try {
    await checkin(t, TOKEN, { phone: '9820011111' });
    await checkin(t, TOKEN, { phone: '9000000001' });
    await checkin(t, TOKEN, { phone: '9000000002' });
    await checkin(t, 'tok_unknown-000000000', { phone: '9000000003' });
    assert.ok(lines.some((l) => l.includes('"self-checkin"') && l.includes('"principal":"player"')), lines.join('\n'));
    for (const l of lines) {
      assert.ok(!l.includes(TOKEN) && !l.includes('tok_unknown'), `token in log: ${l}`);
      assert.ok(!/98200|90000000/.test(l), `phone in log: ${l}`);
    }
  } finally {
    await t.close();
  }
});

test('admins may write day.selfCheckIn / day.checkInSource (checked), not store.roster; HQ may write roster', async () => {
  const { t, hq, a1 } = await setup();
  try {
    assert.equal((await batch(t, a1, 'admin-src-00001', [{ k: 'stores', id: 's1', p: ['day', 'checkInSource', 'p2'], v: 'staff' }])).status, 200);
    let r = await batch(t, a1, 'admin-src-00002', [{ k: 'stores', id: 's1', p: ['day', 'checkInSource', 'ghost'], v: 'self' }]);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /checkInSource\.ghost: isn’t a player/);
    r = await batch(t, a1, 'admin-src-00003', [{ k: 'stores', id: 's1', p: ['day', 'checkInSource', 'p2'], v: 'robot' }]);
    assert.equal(r.status, 400);
    r = await batch(t, a1, 'admin-tok-00001', [{ k: 'stores', id: 's1', p: ['day', 'selfCheckIn'], v: { token: 'bad token!', open: 'yes' } }]);
    assert.equal(r.status, 400);
    assert.equal((await batch(t, a1, 'admin-tok-00002', [{ k: 'stores', id: 's1', p: ['day', 'selfCheckIn'], v: { token: 'tok_S1-fresh-00000001', open: true, openedAt: '2026-10-24T10:00:00.000Z' } }])).status, 200);

    const roster = { kind: 'link', url: 'https://docs.google.com/spreadsheets/d/x/export?format=csv', fetchedAt: '2026-10-23T10:00:00.000Z', rows: 4, by: 'super' };
    r = await batch(t, a1, 'admin-roster-001', [{ k: 'stores', id: 's1', p: ['roster'], v: roster }]);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'forbidden');
    r = await batch(t, a1, 'admin-roster-002', [{ k: 'stores', id: 's1', p: ['roster', 'rows'], v: 9 }]);
    assert.equal(r.status, 403);
    assert.equal((await batch(t, hq, 'hq-roster-00001', [{ k: 'stores', id: 's1', p: ['roster'], v: roster }])).status, 200);
    r = await batch(t, hq, 'hq-roster-00002', [{ k: 'stores', id: 's1', p: ['roster', 'kind'], v: 'fax' }]);
    assert.equal(r.status, 400);
    // players stay command-only, phones included
    r = await batch(t, hq, 'hq-phone-000001', [{ k: 'stores', id: 's1', p: ['day', 'players', 0, 'phone'], v: '9820099999' }]);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'protected');
  } finally {
    await t.close();
  }
});
