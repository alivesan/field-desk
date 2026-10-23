import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic, fixtureStore, TINY_JPEG, type TestServer } from './helpers/server.ts';
import { device, network, realEngine, waitFor, deferred, json, type Device, type Net } from './sync-harness.ts';
import type { Engine } from '../src/lib/sync/engine.ts';

/*
 * Sync engine against the real API on a temp dir (tests/helpers/server.ts). Synthetic codes:
 * a1 = AAA2 (store s1), a2 = BBB3 (store s2), HQ = SUPER.
 */

async function setup() {
  const t = await startTestServer();
  const hq = await seedBasic(t);
  const dev = device();
  const net = network(dev, t.base);
  const engines: Engine[] = [];
  const make = () => {
    const e = realEngine(dev, net);
    engines.push(e);
    return e;
  };
  const done = async () => {
    engines.forEach((e) => e.stop());
    net.streams.forEach((s) => s.close());
    await t.close();
  };
  return { t, hq, dev, net, make, done };
}

const live = (e: Engine, principal: string) => waitFor(() => e.getSync().principal === principal && e.getSync().connection === 'live', `${principal} live`);
const serverStore = async (t: TestServer, hq: string, id: string) => (await t.json('/api/state', { cookie: hq })).body.stores[id];
const stateKV = (dev: Device, principal: string) => dev.storage.open(`field-desk:${principal}`);
const photoKV = (dev: Device, principal: string) => dev.storage.open(`field-desk-photos:${principal}`);
const blockBatches = (net: Net) => (net.intercept = async (path) => (path === '/api/batch' || path === '/api/command' ? Promise.reject(new TypeError('no signal')) : undefined));

test('F01: response lost after commit — edit again, reload — both edits applied exactly once', async () => {
  const { t, hq, dev, net, make, done } = await setup();
  try {
    const e1 = make();
    await e1.start('AAA2');
    await live(e1, 'admin:a1');
    const seq0 = (await t.json('/api/state', { cookie: hq })).body.seq;

    let committed = 0;
    net.intercept = async (path, _init, real) => {
      if (path !== '/api/batch' || committed) return undefined;
      committed++;
      net.streams.forEach((s) => (s.muted = true)); // the stream confirmation is lost too
      const r = await real();
      await r.text(); // the server has committed…
      net.offline = true; // …and the device drops off before reading the answer
      throw new TypeError('connection reset');
    };
    e1.update((d) => (d.stores.s1.recce.summary = 'first edit'));
    await waitFor(() => committed === 1, 'first batch committed');
    await waitFor(() => e1.getSync().connection === 'offline', 'offline');
    const [x] = e1.debug().entries;
    assert.ok(x.body, 'entry was frozen before it was sent');

    e1.update((d) => (d.stores.s1.recce.furniture.chairType = 'plastic'));
    const entries = e1.debug().entries;
    assert.equal(entries.length, 2, 'the later edit is a new entry, not appended to the sent one');
    assert.notEqual(entries[1].id, x.id);
    assert.equal(entries[0].body, x.body, 'frozen body unchanged');
    await waitFor(() => e1.getPending().every((w) => w.saved), 'both saved on the device');

    // "reload": a new engine on the same device storage
    e1.stop();
    net.offline = false;
    net.intercept = null;
    const e2 = make();
    await e2.start();
    await live(e2, 'admin:a1');
    await waitFor(() => e2.getSync().pending === 0 && e2.debug().entries.length === 0, 'outbox drained');

    const s1 = await serverStore(t, hq, 's1');
    assert.equal(s1.recce.summary, 'first edit');
    assert.equal(s1.recce.furniture.chairType, 'plastic');
    assert.equal((await t.json('/api/state', { cookie: hq })).body.seq, seq0 + 2, 'each edit committed exactly once');
    const sends = net.log.filter((l) => l.path === '/api/batch' && l.body?.includes(x.id));
    assert.ok(sends.length >= 2);
    assert.ok(
      sends.every((l) => l.body === x.body),
      'retries are byte-identical',
    );
  } finally {
    await done();
  }
});

test('F09: a rejected batch for one store does not drop edits for another', async () => {
  const { t, hq, net, make, done } = await setup();
  try {
    await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'seed-s3-0001', ops: [{ k: 'stores', id: 's3', p: [], v: fixtureStore('s3', 'e1', 'a1') }] } });
    const e = make();
    await e.start('AAA2');
    await live(e, 'admin:a1');
    await waitFor(() => e.getState().stores.s3, 's3 visible');

    blockBatches(net);
    e.update((d) => {
      d.stores.s1.recce.summary = 'kept';
      d.stores.s3.recce.summary = 'lost access';
    });
    assert.deepEqual(
      e.debug().entries.map((x) => x.doc?.id),
      ['s1', 's3'],
      'one entry per document',
    );
    await waitFor(() => net.log.some((l) => l.path === '/api/batch'), 'a send attempt');

    const r = await t.json('/api/batch', {
      method: 'POST',
      cookie: hq,
      body: {
        id: 'reassign-s3-01',
        ops: [
          { k: 'stores', id: 's3', p: ['adminId'], v: 'a2' },
          { k: 'stores', id: 's3', p: ['admin'], v: 'Synthetic a2' },
        ],
      },
    });
    assert.equal(r.status, 200);
    await waitFor(() => !e.getState().stores.s3, 's3 gone from the view');

    net.intercept = null;
    void e.flush();
    await waitFor(() => e.getSync().pending === 0 && e.getSync().failed === 1, 'one sent, one failed');
    assert.equal((await serverStore(t, hq, 's1')).recce.summary, 'kept');
    assert.notEqual((await serverStore(t, hq, 's3')).recce.summary, 'lost access');
    const [failed] = e.getPending();
    assert.equal(failed.storeId, 's3');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.reason, 'forbidden');
    assert.equal(failed.status, 403);
    assert.match(failed.error!, /access/);
  } finally {
    await done();
  }
});

test('F09: rejected photo uploads are kept with their reason and blob; transient ones retry', async () => {
  const { t, hq, dev, net, make, done } = await setup();
  try {
    const e = make();
    await e.start('AAA2');
    await live(e, 'admin:a1');

    let unavailable = true;
    net.intercept = async (path) => (path.startsWith('/api/photos/flaky') && unavailable ? json(503, { error: 'busy' }) : undefined);
    await e.savePhoto('notjpeg001', new Blob(['not a jpeg'], { type: 'image/jpeg' }), 's1'); // 415 (B validates bytes)
    await e.savePhoto('otherstore1', new Blob([TINY_JPEG], { type: 'image/jpeg' }), 's2'); // 403: not a1's store
    await e.savePhoto('flakyphoto1', new Blob([TINY_JPEG], { type: 'image/jpeg' }), 's1'); // 503 → stays queued
    await waitFor(() => e.getSync().failed === 2, 'two rejected uploads');

    const work = Object.fromEntries(e.getPending().map((w) => [w.id, w]));
    assert.equal(work.notjpeg001.state, 'failed');
    assert.equal(work.notjpeg001.reason, 'bad-media');
    assert.equal(work.otherstore1.reason, 'forbidden');
    assert.equal(work.flakyphoto1.state, 'queued', 'a 5xx is not a rejection');
    assert.ok(photoKV(dev, 'admin:a1').data.has('notjpeg001'), 'the rejected photo is still on the device');
    assert.ok(stateKV(dev, 'admin:a1').data.has('u:notjpeg001'), 'and its failure is persisted');

    unavailable = false;
    void e.flush();
    await waitFor(() => !e.getPending().some((w) => w.id === 'flakyphoto1'), 'flaky photo uploaded');
    assert.equal((await t.req('/api/photos/flakyphoto1', { cookie: hq })).status, 200);

    e.discardWork('notjpeg001');
    await waitFor(() => e.getSync().failed === 1, 'discarded');
    assert.ok(!photoKV(dev, 'admin:a1').data.has('notjpeg001'));
  } finally {
    await done();
  }
});

test('F05: admin A → admin B on one device — B never sees A’s cache, A’s work waits for A', async () => {
  const { t, hq, dev, net, make, done } = await setup();
  try {
    const e = make();
    await e.start('AAA2');
    await live(e, 'admin:a1');
    await waitFor(() => stateKV(dev, 'admin:a1').data.has('server'), 'A snapshot cached');
    blockBatches(net);
    e.update((d) => (d.stores.s1.recce.summary = 'A offline edit'));
    await waitFor(() => e.getPending()[0]?.saved, 'A edit saved');

    assert.equal(await e.login('BBB3'), null);
    await live(e, 'admin:a2');
    assert.deepEqual(Object.keys(e.getState().stores), ['s2'], 'only B’s store');
    assert.equal(e.getPending().length, 0, 'A’s queue is not B’s');
    assert.ok(!stateKV(dev, 'admin:a1').data.has('server'), 'A’s readable snapshot deleted');
    assert.ok([...stateKV(dev, 'admin:a1').data.keys()].some((k) => k.startsWith('w:')), 'A’s queued work kept (quarantined)');
    assert.equal(dev.prefs.get('fd-principal'), 'admin:a2');

    net.intercept = null;
    await e.flush();
    e.update((d) => (d.stores.s2.recce.summary = 'B edit'));
    await waitFor(() => e.getSync().pending === 0, 'B edit sent');
    assert.equal((await serverStore(t, hq, 's2')).recce.summary, 'B edit');
    assert.notEqual((await serverStore(t, hq, 's1')).recce.summary, 'A offline edit', 'A’s work never sent under B');
    assert.ok(
      net.log.filter((l) => l.path === '/api/batch' && l.body?.includes('A offline edit')).every((l) => l.principal === 'admin:a1'),
      'any attempt at A’s work was made as A',
    );

    // A signs in again: the work resumes
    assert.equal(await e.login('AAA2'), null);
    await live(e, 'admin:a1');
    await waitFor(async () => (await serverStore(t, hq, 's1')).recce.summary === 'A offline edit', 'A’s edit delivered');
    assert.ok(!stateKV(dev, 'admin:a2').data.has('server'), 'B’s snapshot deleted in turn');
  } finally {
    await done();
  }
});

test('F05: HQ → field admin — no admin records or other stores survive the switch', async () => {
  const { dev, make, done } = await setup();
  try {
    const e = make();
    await e.start('synthetic-hq-code-for-tests-0001');
    await live(e, 'super');
    assert.deepEqual(Object.keys(e.getState().admins).sort(), ['a1', 'a2']);
    await waitFor(() => stateKV(dev, 'super').data.has('server'), 'HQ snapshot cached');

    assert.equal(await e.login('AAA2'), null);
    await live(e, 'admin:a1');
    assert.deepEqual(e.getState().admins, {});
    assert.deepEqual(Object.keys(e.getState().stores), ['s1']);
    assert.ok(!stateKV(dev, 'super').data.has('server'), 'HQ snapshot (with admin codes) deleted');
    const cached = stateKV(dev, 'admin:a1');
    await waitFor(() => cached.data.has('server'), 'admin snapshot cached');
    assert.deepEqual((cached.data.get('server') as { admins: object }).admins, {});
  } finally {
    await done();
  }
});

test('F10: a store reassigned while the snapshot is in flight disappears without another event', async () => {
  const { t, hq, net, make, done } = await setup();
  try {
    const fetched = deferred();
    const release = deferred();
    let calls = 0;
    net.intercept = async (path, _init, real) => {
      if (path !== '/api/state') return undefined;
      if (++calls > 1) return undefined;
      const r = await real(); // captured before the reassignment
      fetched.resolve();
      await release.promise;
      return r;
    };
    const e = make();
    await e.start('AAA2');
    await fetched.promise;
    const stream = net.streams[net.streams.length - 1];
    const before = stream.received;
    const r = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'reassign-s1-01', ops: [{ k: 'stores', id: 's1', p: ['adminId'], v: 'a2' }] } });
    assert.equal(r.status, 200);
    await waitFor(() => stream.received > before, 'reassignment buffered');
    assert.notEqual(e.getSync().connection, 'live');
    release.resolve();
    await live(e, 'admin:a1');
    assert.equal(calls, 2, 'the buffered resync restarted snapshot acquisition');
    assert.equal(e.getState().stores.s1, undefined);
  } finally {
    await done();
  }
});
