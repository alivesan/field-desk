import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureEvent, fixtureStore, TINY_JPEG } from './helpers/server.ts';
import { device, engineOn, waitFor, deferred, json, FakeEventSource, type Device } from './sync-harness.ts';
import type { Engine } from '../src/lib/sync/engine.ts';
import type { MemoryKV } from '../src/lib/sync/storage.ts';

/*
 * Sync engine against a scripted fake API — for orderings the real server can't produce on
 * demand (sequence gaps, delayed snapshots during identity changes, storage failures).
 */

type Who = { role: 'super' | 'admin' | null; principal?: string; name?: string };

function fakeApi(dev: Device) {
  const api = {
    me: { role: 'admin', principal: 'admin:a1', name: 'Synthetic a1' } as Who,
    seq: 5,
    docs: (): any => ({ events: { e1: fixtureEvent('e1') }, stores: { s1: fixtureStore('s1', 'e1', 'a1') }, admins: {} }),
    snapshots: [] as any[], // served in order; when empty, docs() at api.seq
    stateGate: null as Promise<void> | null,
    stateCalls: 0,
    requests: [] as { path: string; body?: string; principal?: string | null }[],
    onBatch: (body: any): Response | Promise<Response> => {
      api.seq++;
      api.streams.forEach((s) => s.readyState === 1 && s.push({ seq: api.seq, id: body.id, ops: body.ops }));
      return json(200, { seq: api.seq });
    },
    onCommand: (_body: any): Response | Promise<Response> => json(200, { seq: ++api.seq }),
    onPhoto: (): Response | Promise<Response> => json(201, { ok: true }),
    streams: [] as FakeEventSource[],
    logins: {} as Record<string, Who>,
  };
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const path = url.split('?')[0];
    const body = typeof init.body === 'string' ? init.body : undefined;
    api.requests.push({ path, body, principal: new Headers(init.headers).get('X-Field-Desk-Principal') });
    if (path === '/api/me') return json(200, api.me);
    if (path === '/api/login') {
      const who = api.logins[JSON.parse(body!).code];
      if (!who) return json(401, { error: 'That code isn’t right.' });
      api.me = who;
      return json(200, { ok: true });
    }
    if (path === '/api/logout') return json(200, { ok: true });
    if (path === '/api/state') {
      api.stateCalls++;
      const asked = api.me;
      const gate = api.stateGate;
      const snap = api.snapshots.shift() ?? { seq: api.seq, ...api.docs() };
      if (gate) await gate;
      return json(200, { ...snap, principal: asked.principal });
    }
    if (path === '/api/batch') return api.onBatch(JSON.parse(body!));
    if (path === '/api/command') return api.onCommand(JSON.parse(body!));
    if (path.startsWith('/api/photos/')) return api.onPhoto();
    return json(404, { error: 'not found' });
  };
  const make = (extra = {}) =>
    engineOn(
      dev,
      { fetch: fetchImpl as typeof fetch },
      () => {
        const s = new FakeEventSource();
        api.streams.push(s);
        queueMicrotask(() => s.open());
        return s;
      },
      extra,
    );
  const stream = () => api.streams[api.streams.length - 1];
  return { api, make, stream };
}

const live = (e: Engine) => waitFor(() => e.getSync().connection === 'live', 'live');
const kv = (dev: Device, name: string) => dev.storage.open(name) as MemoryKV;
const sent = (api: ReturnType<typeof fakeApi>['api'], path: string) => api.requests.filter((r) => r.path === path);

test('F10: a gap in buffered messages restarts snapshot acquisition; live only after a clean drain', async () => {
  const dev = device();
  const { api, make, stream } = fakeApi(dev);
  const gate = deferred();
  api.stateGate = gate.promise;
  api.snapshots = [
    { seq: 5, ...api.docs() },
    { seq: 9, ...api.docs(), stores: { s1: fixtureStore('s1', 'e1', 'a1', { name: 'Fresh' }) } },
  ];
  const e = make();
  const seen: { connection: string; calls: number }[] = [];
  e.subscribe(() => seen.push({ connection: e.getSync().connection, calls: api.stateCalls }));
  try {
    await e.start();
    await waitFor(() => api.stateCalls === 1, 'first snapshot requested');
    stream().push({ seq: 7, id: 'remote-1', ops: [{ k: 'stores', id: 's1', p: ['name'], v: 'Mid' }] }); // seq 6 is missing
    api.stateGate = null;
    gate.resolve();
    await live(e);
    assert.equal(api.stateCalls, 2);
    assert.equal(e.getState().stores.s1.name, 'Fresh');
    assert.ok(
      seen.filter((s) => s.connection === 'live').every((s) => s.calls === 2),
      'never reported live off the gapped drain',
    );

    // contiguous messages while buffering are simply applied
    const gate2 = deferred();
    api.stateGate = gate2.promise;
    api.snapshots = [{ seq: 9, ...api.docs(), stores: { s1: fixtureStore('s1', 'e1', 'a1', { name: 'Fresh' }) } }];
    stream().open(); // the stream reconnects → resync
    await waitFor(() => api.stateCalls === 3, 'resync requested');
    stream().push({ seq: 10, id: 'remote-2', ops: [{ k: 'stores', id: 's1', p: ['city'], v: 'Buffered City' }] });
    api.stateGate = null;
    gate2.resolve();
    await waitFor(() => e.getState().stores.s1.city === 'Buffered City', 'buffered op applied');
    assert.equal(api.stateCalls, 3);
  } finally {
    e.stop();
  }
});

test('commands: optimistic apply with ctx from the entry, FIFO with edits, conflict leaves the overlay', async () => {
  const dev = device();
  const { api, make } = fakeApi(dev);
  api.me = { role: 'super', principal: 'super', name: 'HQ' }; // bracket.load is HQ-only
  const order: string[] = [];
  api.onBatch = (b) => (order.push(`batch:${JSON.stringify(b.ops)}`), json(200, { seq: ++api.seq }));
  let conflict = true;
  api.onCommand = (b) => {
    order.push(`cmd:${b.cmd.type}`);
    return conflict ? json(409, { code: 'conflict', error: 'Another device loaded a bracket first' }) : json(200, { seq: ++api.seq });
  };
  const e = make();
  try {
    await e.start();
    await live(e);
    const players = [
      { id: 'p1', name: 'Asha', seed: 1 },
      { id: 'p2', name: 'Ben', seed: 2 },
    ];
    e.update((d) => (d.stores.s1.day.checkIn.p1 = '2026-10-24T10:00:00.000Z'));
    const id = e.sendCommand('s1', { type: 'bracket.load', base: 0, players });
    e.update((d) => (d.stores.s1.day.checkIn.p2 = '2026-10-24T10:01:00.000Z'));

    // optimistic: the bracket is there at once, with ids derived from the work id
    const day = e.getState().stores.s1.day;
    assert.ok(day.matches.length >= 1);
    assert.ok(day.matches.every((m: { id: string }) => m.id.includes(id)), 'match ids come from ctx.commandId = work id');
    assert.equal(e.debug().entries.length, 3, 'the edit after the command is a new entry');

    await waitFor(() => order.length === 3, 'all three sent');
    assert.match(order[0], /^batch:.*p1/);
    assert.equal(order[1], 'cmd:bracket.load');
    assert.match(order[2], /^batch:.*p2/);

    await waitFor(() => e.getPending().some((w) => w.state === 'conflict'), 'conflict recorded');
    const w = e.getPending().find((x) => x.id === id)!;
    assert.equal(w.kind, 'cmd');
    assert.match(w.error!, /Another device loaded a bracket first/);
    assert.equal(e.getState().stores.s1.day.matches.length, 0, 'the view shows server truth');
    assert.equal(e.getSync().failed, 1);

    // a command that doesn't apply to what this device shows is recorded, not sent
    const before = sent(api, '/api/command').length;
    const bad = e.sendCommand('s1', { type: 'match.start', base: 0, matchId: 'nope', station: 1 });
    const badWork = e.getPending().find((x) => x.id === bad)!;
    assert.ok(badWork.state === 'conflict' || badWork.state === 'failed');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(sent(api, '/api/command').length, before);

    // retry = same command under a new id
    conflict = false;
    e.retryWork(id);
    await waitFor(() => sent(api, '/api/command').length === before + 1, 'retried');
    const retried = JSON.parse(sent(api, '/api/command').at(-1)!.body!);
    assert.notEqual(retried.id, id);
    assert.equal(retried.cmd.type, 'bracket.load');
    e.discardWork(bad);
    await waitFor(() => e.getSync().failed === 0, 'discarded');
  } finally {
    e.stop();
  }
});

test('storage write failure is reported, never counted as saved, and recovers', async () => {
  const dev = device();
  const { api, make } = fakeApi(dev);
  api.onBatch = () => json(503, { error: 'down' });
  const e = make();
  try {
    await e.start();
    await live(e);
    kv(dev, 'field-desk:admin:a1').fail = 'writes';
    e.update((d) => (d.stores.s1.recce.summary = 'unsaved'));
    await waitFor(() => e.getSync().status === 'storage-error', 'storage-error status');
    assert.match(e.getSync().storageError!, /storage/i);
    assert.equal(e.getPending()[0].saved, false);
    assert.equal(e.getState().stores.s1.recce.summary, 'unsaved', 'still usable in memory');

    kv(dev, 'field-desk:admin:a1').fail = false;
    void e.flush();
    await waitFor(() => e.getPending()[0]?.saved && e.getSync().status !== 'storage-error', 'saved after storage recovers');
  } finally {
    e.stop();
  }

  // a device whose storage refuses everything still starts
  const dev2 = device();
  dev2.prefs.set('fd-principal', 'admin:a1');
  kv(dev2, 'field-desk:admin:a1').fail = 'all';
  kv(dev2, 'field-desk').fail = 'all';
  const { make: make2 } = fakeApi(dev2);
  const e2 = make2();
  try {
    await e2.start();
    await live(e2);
    assert.equal(e2.getSync().status, 'storage-error');
    assert.ok(e2.getState().stores.s1);
  } finally {
    e2.stop();
  }
});

test('legacy unscoped storage is held for an explicit decision, never auto-sent', async () => {
  const dev = device();
  const legacy = kv(dev, 'field-desk');
  const oldOps = [{ k: 'stores', id: 's1', p: ['recce', 'summary'], v: 'from the old version' }];
  legacy.data.set('outbox', [
    { id: 'oldbatch0001', tab: 'x', ops: oldOps },
    { id: 'oldbatch0002', tab: 'x', ops: oldOps, sentSeq: 3 },
  ]);
  legacy.data.set('server', {
    seq: 3,
    events: {},
    stores: { s1: fixtureStore('s1', 'e1', 'a1', { recce: { ...fixtureStore('s1', 'e1', 'a1').recce, venue: { photos: [{ id: 'legacyphoto1', label: 'Venue' }] } } }) },
    admins: {},
  });
  legacy.data.set('uploads', ['legacyphoto1', 'orphanphoto1']);
  kv(dev, 'field-desk-photos').data.set('legacyphoto1', new Blob([TINY_JPEG]));
  kv(dev, 'field-desk-photos').data.set('orphanphoto1', new Blob([TINY_JPEG]));
  const { api, make } = fakeApi(dev);
  const e = make();
  try {
    await e.start();
    await live(e);
    await waitFor(() => e.getSync().held === 3, 'held work listed');
    assert.equal(e.getSync().pending, 0);
    const held = e.getPending();
    assert.deepEqual(held.map((w) => [w.id, w.kind, w.held, w.reason, w.storeId]).sort(), [
      ['legacyphoto1', 'upload', true, 'legacy', 's1'],
      ['oldbatch0001', 'ops', true, 'legacy', 's1'],
      ['orphanphoto1', 'upload', true, 'no-store', undefined],
    ]);
    assert.equal(legacy.data.size, 0, 'legacy snapshot and queue removed');
    assert.ok(kv(dev, 'field-desk-photos:admin:a1').data.has('legacyphoto1'), 'photo moved into this person’s store');
    await e.flush();
    assert.equal(sent(api, '/api/batch').length, 0, 'nothing sent automatically');
    assert.notEqual(e.getState().stores.s1.recce.summary, 'from the old version', 'held work is not in the view');

    e.sendHeldWork();
    await waitFor(() => e.getSync().held === 0 && e.getSync().pending === 0, 'sent');
    const orphan = e.getPending().find((w) => w.id === 'orphanphoto1')!;
    assert.equal(orphan.state, 'failed', 'a photo with no known store is never sent store-less');
    assert.equal(orphan.reason, 'no-store');
    assert.equal(sent(api, '/api/photos/orphanphoto1').length, 0);
    assert.equal(sent(api, '/api/batch')[0].body, JSON.stringify({ id: 'oldbatch0001', ops: oldOps }), 'sent exactly as the old version would have');
    assert.equal(sent(api, '/api/photos/legacyphoto1').length, 1);
  } finally {
    e.stop();
  }
});

test('generations: a snapshot that arrives after switching identity is ignored', async () => {
  const dev = device();
  const { api, make } = fakeApi(dev);
  api.logins = { BBB3: { role: 'admin', principal: 'admin:a2', name: 'Synthetic a2' } };
  const gate = deferred();
  api.stateGate = gate.promise;
  api.snapshots = [{ seq: 5, events: { e1: fixtureEvent('e1') }, stores: { s1: fixtureStore('s1', 'e1', 'a1', { name: 'A secret' }) }, admins: {} }];
  const e = make();
  try {
    await e.start();
    await waitFor(() => api.stateCalls === 1, 'A snapshot requested');
    api.stateGate = null;
    api.docs = () => ({ events: { e1: fixtureEvent('e1') }, stores: { s2: fixtureStore('s2', 'e1', 'a2') }, admins: {} });
    assert.equal(await e.login('BBB3'), null);
    await waitFor(() => e.getSync().principal === 'admin:a2' && e.getSync().connection === 'live', 'B live');
    gate.resolve(); // A's late response
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(Object.keys(e.getState().stores), ['s2']);
    assert.ok(!kv(dev, 'field-desk:admin:a1').data.has('server'), 'A’s late snapshot was not cached');
  } finally {
    e.stop();
  }
});

test('another tab signing in as someone else stops this tab sending its queue', async () => {
  const dev = device();
  const { api, make } = fakeApi(dev);
  api.logins = { BBB3: { role: 'admin', principal: 'admin:a2', name: 'Synthetic a2' } };
  let down = true;
  api.onBatch = () => (down ? json(503, { error: 'down' }) : json(200, { seq: ++api.seq }));
  const tab1 = make();
  const tab2 = make();
  try {
    await tab1.start();
    await live(tab1);
    tab1.update((d) => (d.stores.s1.recce.summary = 'A’s edit'));
    await waitFor(() => sent(api, '/api/batch').length >= 1, 'first attempt');

    api.docs = () => ({ events: { e1: fixtureEvent('e1') }, stores: { s2: fixtureStore('s2', 'e1', 'a2') }, admins: {} });
    await tab2.start('BBB3'); // same device: the cookie (api.me) now belongs to B
    await waitFor(() => tab2.getSync().principal === 'admin:a2', 'tab2 is B');
    down = false;
    const before = sent(api, '/api/batch').length;
    await tab1.flush();
    await waitFor(() => tab1.getSync().principal === 'admin:a2', 'tab1 noticed the switch');
    assert.equal(sent(api, '/api/batch').length, before, 'A’s edit was not sent under B');
    assert.ok([...kv(dev, 'field-desk:admin:a1').data.keys()].some((k) => k.startsWith('w:')), 'A’s edit is kept for A');
  } finally {
    tab1.stop();
    tab2.stop();
  }
});

test('logout wipes this principal’s data; export includes unsent work', async () => {
  const dev = device();
  const { api, make } = fakeApi(dev);
  api.onBatch = () => json(503, { error: 'down' });
  let exported = '';
  const e = make({ download: (j: string) => (exported = j), confirm: () => true });
  try {
    await e.start();
    await live(e);
    e.update((d) => (d.stores.s1.recce.summary = 'unsent'));
    await e.savePhoto('photoexport1', new Blob([TINY_JPEG]), 's1');
    assert.equal(await e.logout(), true);
    const doc = JSON.parse(exported);
    assert.equal(doc.kind, 'field-desk-unsent-work');
    assert.equal(doc.work.length, 1);
    assert.equal(doc.photos[0].id, 'photoexport1');
    assert.ok(doc.photos[0].jpegBase64);
    assert.equal(kv(dev, 'field-desk:admin:a1').data.size, 0);
    assert.equal(kv(dev, 'field-desk-photos:admin:a1').data.size, 0);
    assert.equal(e.getSync().connection, 'locked');
    assert.equal(dev.prefs.get('fd-principal'), null);
  } finally {
    e.stop();
  }
});
