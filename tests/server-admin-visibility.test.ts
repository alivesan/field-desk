import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, seedBasic, type TestServer } from './helpers/server.ts';

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

test('admins see a player’s full number only after check-in; before that just the last 4 digits; HQ always sees it', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    const cmd = (cookie: string, id: string, c: unknown) => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId: 's1', cmd: c } });
    const players = [
      { id: 'p1', name: 'Asha Rao', seed: 1, phone: '9820011111' },
      { id: 'p2', name: 'Bilal Khan', seed: 2, phone: '9820022222' },
    ];
    assert.equal((await cmd(hq, 'set-players-1', { type: 'players.set', base: 0, players })).status, 200);
    const admin = await t.login('AAA2');
    const store = async (cookie: string) => (await t.json('/api/state', { cookie })).body.stores.s1;

    let s = await store(admin);
    assert.equal(s.day.players[0].phone, undefined, 'not checked in → no full number');
    assert.equal(s.day.players[0].phoneEnd, '1111');
    assert.doesNotMatch(JSON.stringify(s), /9820011111|9820022222/);

    const r = await t.json('/api/batch', { method: 'POST', cookie: admin, body: { id: 'checkin-p1', ops: [{ k: 'stores', id: 's1', p: ['day', 'checkIn', 'p1'], v: '2026-10-24T06:00:00.000Z' }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s = await store(admin);
    assert.equal(s.day.players[0].phone, '9820011111', 'checked in → the admin can call them');
    assert.equal(s.day.players[0].phoneEnd, undefined);
    assert.equal(s.day.players[1].phone, undefined);

    const h = await store(hq);
    assert.equal(h.day.players[1].phone, '9820022222', 'HQ always sees numbers');
    assert.equal(h.day.players[1].phoneEnd, undefined, 'phoneEnd is never stored');
  } finally {
    await t.close();
  }
});

/** /api/stream as an admin sees it: every data message, in order. */
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

test('the live stream gives admins the same filtered copy: no phones before check-in, the number right after', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    const admin = await t.login('AAA2');
    const s = openStream(t, admin);
    await s.connected;
    const cmd = (id: string, c: unknown) => t.json('/api/command', { method: 'POST', cookie: hq, body: { id, storeId: 's1', cmd: c } });
    const players = [
      { id: 'p1', name: 'Asha Rao', seed: 1, phone: '9820011111' },
      { id: 'p2', name: 'Bilal Khan', seed: 2, phone: '9820022222' },
    ];
    assert.equal((await cmd('stream-players-1', { type: 'players.set', base: 0, players })).status, 200);
    const loaded = await s.until((m) => m.id === 'stream-players-1');
    assert.doesNotMatch(JSON.stringify(loaded), /9820011111|9820022222/, 'HQ’s player list reaches the admin without numbers');
    assert.match(JSON.stringify(loaded), /"phoneEnd":"1111"/);

    const r = await t.json('/api/batch', { method: 'POST', cookie: admin, body: { id: 'stream-checkin-p1', ops: [{ k: 'stores', id: 's1', p: ['day', 'checkIn', 'p1'], v: '2026-10-24T06:00:00.000Z' }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const checked = await s.until((m) => m.id === 'stream-checkin-p1');
    assert.match(JSON.stringify(checked), /9820011111/, 'after check-in the number arrives over the stream');
    assert.doesNotMatch(JSON.stringify(checked), /9820022222/, 'the other player’s number stays hidden');

    // HQ's sheet link set on the campaign never reaches the admin's stream either.
    const b = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'stream-sheet-1', ops: [{ k: 'events', id: 'e1', p: ['storeSheet'], v: { url: 'https://docs.google.com/spreadsheets/d/e/STREAMSECRET/pub?output=csv', fetchedAt: '2026-10-24T05:00:00.000Z' } }] } });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const ev = await s.until((m) => m.id === 'stream-sheet-1');
    assert.doesNotMatch(JSON.stringify(ev), /STREAMSECRET/);
    s.close();
  } finally {
    await t.close();
  }
});
