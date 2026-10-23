import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic, fixtureStore, fixtureAdmin } from './helpers/server.ts';

const batch = (t: Awaited<ReturnType<typeof startTestServer>>, cookie: string, id: string, ops: unknown[]) => t.json('/api/batch', { method: 'POST', cookie, body: { id, ops } });

test('F04: admin setting recce to null → 400 invalid, state and seq unchanged', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    const a1 = await t.login('AAA2');
    const before = await t.json('/api/state', { cookie: hq });
    const r = await batch(t, a1, 'bad-recce-0001', [{ k: 'stores', id: 's1', p: ['recce'], v: null }]);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid');
    assert.ok(r.body.problems.some((p: string) => p.startsWith('stores/s1: recce: must be an object')), JSON.stringify(r.body));
    const after = await t.json('/api/state', { cookie: hq });
    assert.deepEqual(after.body, before.body);
    // a valid edit still works afterwards
    const ok = await batch(t, a1, 'good-edit-0001', [{ k: 'stores', id: 's1', p: ['recce', 'network', 'wifi'], v: 'yes' }]);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.seq, before.body.seq + 1);
  } finally {
    await t.close();
  }
});

test('F04: survives a restart — rejected docs were never persisted', async () => {
  const t = await startTestServer();
  const dataDir = t.dataDir;
  const hq = await seedBasic(t);
  await batch(t, hq, 'bad-speed-0001', [{ k: 'stores', id: 's1', p: ['recce', 'network', 'speed'], v: { down: -5, up: null, ping: null, method: 'manual', at: '2026-10-20T00:00:00Z' } }]);
  await t.close();
  const t2 = await startTestServer({ dataDir });
  try {
    const hq2 = await t2.login('synthetic-hq-code-for-tests-0001');
    const s = await t2.json('/api/state', { cookie: hq2 });
    assert.equal(s.body.stores.s1.recce.network.speed, null);
  } finally {
    await t2.close();
  }
});

test('F04: referential integrity — deleting a campaign with stores, or a duplicate admin code, is refused', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    let r = await batch(t, hq, 'del-event-0001', [{ k: 'events', id: 'e1', p: [], d: 1 }]);
    assert.equal(r.status, 400);
    assert.ok(r.body.problems.some((p: string) => /stores\/s1: eventId/.test(p)));
    // deleting the campaign together with its stores is fine
    r = await batch(t, hq, 'del-event-0002', [
      { k: 'events', id: 'e1', p: [], d: 1 },
      { k: 'stores', id: 's1', p: [], d: 1 },
      { k: 'stores', id: 's2', p: [], d: 1 },
    ]);
    assert.equal(r.status, 200);
    r = await batch(t, hq, 'dup-code-0001', [{ k: 'admins', id: 'a3', p: [], v: fixtureAdmin('a3', 'AAA2') }]);
    assert.equal(r.status, 400);
    assert.ok(r.body.problems.some((p: string) => /admins\/a3: code: is already used/.test(p)));
    r = await batch(t, hq, 'store-ghost-01', [{ k: 'stores', id: 's3', p: [], v: fixtureStore('s3', 'e1', 'ghost') }]);
    assert.equal(r.status, 400);
  } finally {
    await t.close();
  }
});

test('F01: same batch id + same payload → original seq; different payload → 409 batch-id-reused', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const ops = [{ k: 'stores', id: 's1', p: ['recce', 'summary'], v: 'first' }];
    const first = await batch(t, a1, 'retry-batch-01', ops);
    assert.equal(first.status, 200);
    // the response was "lost": the client retries the identical payload (key order may differ)
    const retry = await batch(t, a1, 'retry-batch-01', [{ v: 'first', p: ['recce', 'summary'], id: 's1', k: 'stores' }]);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.seq, first.body.seq);
    // the client appended an edit to the same id: refused, not silently dropped
    const grown = await batch(t, a1, 'retry-batch-01', [...ops, { k: 'stores', id: 's1', p: ['recce', 'network', 'lan'], v: 'yes' }]);
    assert.equal(grown.status, 409);
    assert.equal(grown.body.code, 'batch-id-reused');
    const s = await t.json('/api/state', { cookie: a1 });
    assert.equal(s.body.seq, first.body.seq);
    assert.equal(s.body.stores.s1.recce.network.lan, null);
  } finally {
    await t.close();
  }
});

test('protected paths: batches can’t write day.players/matches/stations/version or submissions — from anyone', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    const a1 = await t.login('AAA2');
    const cases: [string, unknown[]][] = [
      ['players', [{ k: 'stores', id: 's1', p: ['day', 'players'], v: [{ id: 'p1', name: 'X', seed: 1 }] }]],
      ['matches', [{ k: 'stores', id: 's1', p: ['day', 'matches'], v: [] }, { k: 'stores', id: 's1', p: ['day', 'version'], v: 9 }]],
      ['stations', [{ k: 'stores', id: 's1', p: ['day', 'stations'], v: 5 }]],
      ['whole day', [{ k: 'stores', id: 's1', p: ['day'], v: { players: [], checkIn: {}, matches: [], stations: 4, version: 0 } }]],
      ['submissions', [{ k: 'stores', id: 's1', p: ['submissions'], v: [{ id: 'x' }] }]],
    ];
    let n = 0;
    for (const who of [hq, a1]) {
      for (const [name, ops] of cases) {
        const r = await batch(t, who, `protect-${n++}-000`, ops);
        assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.body)}`);
        // field admins can't touch store.submissions at all (forbidden); everything else is 'protected'
        assert.equal(r.body.code, who === a1 && name === 'submissions' ? 'forbidden' : 'protected', name);
      }
    }
    // [] is the same as "no submissions": not a change, so allowed
    const empty = await batch(t, hq, 'protect-sub-01', [{ k: 'stores', id: 's1', p: ['submissions'], v: [] }]);
    assert.equal(empty.status, 200);
    // HQ replacing the whole store with a different bracket is also refused
    const whole = await batch(t, hq, 'protect-whole1', [{ k: 'stores', id: 's1', p: [], v: fixtureStore('s1', 'e1', 'a1', { day: { players: [{ id: 'p1', name: 'X', seed: 1 }], checkIn: {}, matches: [], stations: 2, version: 0 } }) }]);
    assert.equal(whole.status, 403);
    // a new store may choose its stations; existing state of other fields remains editable
    const created = await batch(t, hq, 'protect-new-01', [{ k: 'stores', id: 's3', p: [], v: fixtureStore('s3', 'e1', null, { day: { players: [], checkIn: {}, matches: [], stations: 6 } }) }]);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    // …but a new store can't arrive with a roster, bracket or submissions already in it
    for (const [n, over] of [
      ['players', { day: { players: [{ id: 'p1', name: 'X', seed: 1 }], checkIn: {}, matches: [], stations: 2 } }],
      ['submissions', { submissions: [{ id: 'sub-x' }] }],
    ] as const) {
      const r = await batch(t, hq, `protect-new-${n}`, [{ k: 'stores', id: `s4${n}`, p: [], v: fixtureStore(`s4${n}`, 'e1', null, over) }]);
      assert.equal(r.status, 403, n);
    }
  } finally {
    await t.close();
  }
});

test('protected paths: day.checkIn stays writable by batches, and is validated', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const r = await batch(t, a1, 'checkin-bad-01', [{ k: 'stores', id: 's1', p: ['day', 'checkIn', 'ghost'], v: '2026-10-24T10:00:00Z' }]);
    assert.equal(r.status, 400);
    assert.ok(r.body.problems.some((p: string) => /checkIn\.ghost/.test(p)));
    const ok = await batch(t, a1, 'checkin-ok-001', [{ k: 'stores', id: 's1', p: ['day', 'checkIn'], v: {} }]);
    assert.equal(ok.status, 200);
  } finally {
    await t.close();
  }
});

test('admin scope: only assigned stores, only field-admin fields', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    let r = await batch(t, a1, 'scope-other-01', [{ k: 'stores', id: 's2', p: ['recce', 'summary'], v: 'x' }]);
    assert.equal(r.status, 403);
    r = await batch(t, a1, 'scope-name-001', [{ k: 'stores', id: 's1', p: ['name'], v: 'x' }]);
    assert.equal(r.status, 403);
    r = await batch(t, a1, 'scope-event-01', [{ k: 'events', id: 'e1', p: ['name'], v: 'x' }]);
    assert.equal(r.status, 403);
  } finally {
    await t.close();
  }
});

test('malformed requests → 400 bad-request (not 500)', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    let r = await t.json('/api/batch', { method: 'POST', cookie: hq, body: '{not json', headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'bad-request');
    r = await batch(t, hq, 'x', []);
    assert.equal(r.status, 400);
    r = await batch(t, hq, 'okbatchid-1', [{ k: 'nope', id: 's1', p: [], v: {} }]);
    assert.equal(r.status, 400);
    const raw = await t.req('/api/%E0%A4%A', { cookie: hq });
    assert.ok(raw.status === 400 || raw.status === 404);
    r = await t.json('/api/me', { headers: { Cookie: 'fd_session=%E0%A4%A' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.role, null);
  } finally {
    await t.close();
  }
});
