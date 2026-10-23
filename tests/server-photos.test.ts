import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic, TINY_JPEG } from './helpers/server.ts';

type T = Awaited<ReturnType<typeof startTestServer>>;
const jpeg = (marker: number) => {
  const b = new Uint8Array(TINY_JPEG);
  b[b.length - 3] = marker; // different bytes, still a JPEG
  return b;
};
const put = (t: T, cookie: string, id: string, store: string | null, body: Uint8Array | string, type = 'image/jpeg') =>
  t.req(`/api/photos/${id}${store === null ? '' : `?store=${store}`}`, { method: 'PUT', cookie, headers: { 'Content-Type': type }, body });
const ref = (id: string) => ({ id, label: 'Venue', takenAt: '2026-10-20T10:00:00.000Z', fileTime: '2026-10-20T10:00:00.000Z', live: true, geo: null });
const attach = (t: T, cookie: string, batchId: string, store: string, id: string) =>
  t.json('/api/batch', { method: 'POST', cookie, body: { id: batchId, ops: [{ k: 'stores', id: store, p: ['recce', 'venue', 'photos'], v: [ref(id)] }] } });

test('F08: a photo id from another store can’t be attached, and isn’t readable even if referenced', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    const a1 = await t.login('AAA2');
    const a2 = await t.login('BBB3');
    assert.equal((await put(t, a2, 'photob2', 's2', TINY_JPEG)).status, 201);
    assert.equal((await attach(t, a2, 'attach-own-001', 's2', 'photob2')).status, 200);

    // admin A tries the old trick: reference B's photo from A's own store
    const r = await attach(t, a1, 'attach-foreign1', 's1', 'photob2');
    assert.equal(r.status, 400);
    assert.ok(r.body.problems.some((p: string) => /photo photob2 hasn’t been uploaded for this store/.test(p)));
    assert.equal((await t.req('/api/photos/photob2', { cookie: a1 })).status, 404);
    // …and A can't claim it by re-uploading under A's store either
    assert.equal((await put(t, a1, 'photob2', 's1', TINY_JPEG)).status, 409);

    // HQ referencing it from another store is refused too (ownership is per store)
    assert.equal((await attach(t, hq, 'attach-foreign2', 's1', 'photob2')).status, 400);
    // owner and HQ can read
    const own = await t.req('/api/photos/photob2', { cookie: a2 });
    assert.equal(own.status, 200);
    assert.deepEqual(new Uint8Array(await own.arrayBuffer()), TINY_JPEG);
    assert.equal((await t.req('/api/photos/photob2', { cookie: hq })).status, 200);
    // reassigning the store moves read access with it
    await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'reassign-s2-01', ops: [{ k: 'stores', id: 's2', p: ['adminId'], v: 'a1' }] } });
    assert.equal((await t.req('/api/photos/photob2', { cookie: a1 })).status, 200);
    assert.equal((await t.req('/api/photos/photob2', { cookie: a2 })).status, 404);
  } finally {
    await t.close();
  }
});

test('F08: upload needs write access to the named store', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    assert.equal((await put(t, a1, 'photoa1', null, TINY_JPEG)).status, 400);
    assert.equal((await put(t, a1, 'photoa1', 'nostore', TINY_JPEG)).status, 400);
    assert.equal((await put(t, a1, 'photoa1', 's2', TINY_JPEG)).status, 403);
    assert.equal((await t.req('/api/photos/photoa1?store=s1', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: TINY_JPEG })).status, 401);
  } finally {
    await t.close();
  }
});

test('F08: non-JPEG bodies and wrong content types are refused', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let r = await put(t, a1, 'notjpeg1', 's1', png);
    assert.equal(r.status, 415);
    r = await put(t, a1, 'notjpeg2', 's1', '<html>', 'image/jpeg');
    assert.equal(r.status, 415);
    r = await put(t, a1, 'notjpeg3', 's1', TINY_JPEG, 'image/png');
    assert.equal(r.status, 415);
    assert.equal((await t.req('/api/photos/notjpeg1', { cookie: a1 })).status, 404);
  } finally {
    await t.close();
  }
});

test('F08: size and per-store count limits', async () => {
  const t = await startTestServer({ maxPhotoBytes: 1000, maxPhotosPerStore: 2 });
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const big = new Uint8Array(2000);
    big.set([0xff, 0xd8, 0xff]);
    const r = await put(t, a1, 'bigphoto', 's1', big);
    assert.equal(r.status, 413);
    assert.equal((await put(t, a1, 'quota01', 's1', jpeg(1))).status, 201);
    assert.equal((await put(t, a1, 'quota02', 's1', jpeg(2))).status, 201);
    const over = await put(t, a1, 'quota03', 's1', jpeg(3));
    assert.equal(over.status, 413);
    assert.equal((await over.json()).code, 'too-many-photos');
    // a retry of an existing one isn't a new photo
    assert.equal((await put(t, a1, 'quota01', 's1', jpeg(1))).status, 200);
  } finally {
    await t.close();
  }
});

test('F08: write-once — concurrent first PUTs with different bytes: exactly one wins, content never replaced', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    const a1 = await t.login('AAA2');
    const bodies = Array.from({ length: 8 }, (_, i) => jpeg(10 + i));
    const results = await Promise.all(bodies.map((b) => put(t, a1, 'racephoto', 's1', b)));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(statuses));
    assert.equal(statuses.filter((s) => s === 409).length, 7, JSON.stringify(statuses));
    const winner = bodies[statuses.indexOf(201)];
    const got = new Uint8Array(await (await t.req('/api/photos/racephoto', { cookie: hq })).arrayBuffer());
    assert.deepEqual(got, winner);
    // later a different photo under the same id: 409, still the winner's bytes
    assert.equal((await put(t, a1, 'racephoto', 's1', jpeg(99))).status, 409);
    assert.deepEqual(new Uint8Array(await (await t.req('/api/photos/racephoto', { cookie: hq })).arrayBuffer()), winner);
  } finally {
    await t.close();
  }
});

test('F08: identical concurrent / retried uploads are idempotent', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const results = await Promise.all(Array.from({ length: 5 }, () => put(t, a1, 'samephoto', 's1', TINY_JPEG)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 201]);
    assert.equal((await put(t, a1, 'samephoto', 's1', TINY_JPEG)).status, 200);
    assert.equal((await attach(t, a1, 'attach-same-01', 's1', 'samephoto')).status, 200);
  } finally {
    await t.close();
  }
});
