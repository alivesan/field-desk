/*
 * Store team links over the real API: one shared 4-character code per store (Store.access) signs
 * a phone in as "store:<id>" — that store only, like an admin assigned to it — and each person
 * names themselves once so records read "Rhea (Store s1 team)". HQ makes, rotates and turns off
 * the code; admins never see it and can't write it. Personal admin codes keep working as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startTestServer, seedBasic, SUPER, type TestServer } from './helpers/server.ts';
import { DB_FILE } from '../server/migrate.ts';

const CODE1 = 'TEM2';
const CODE2 = 'TEM3';
const access = (code: string, createdAt = '2026-10-23T00:00:00.000Z') => ({ code, createdAt });
const players = [
  { id: 'p1', name: 'Asha R.', seed: 1, phone: '9820011111' },
  { id: 'p2', name: 'Bilal', seed: 2, phone: '9820022222' },
];

async function setup(opts: Record<string, unknown> = {}) {
  const t = await startTestServer(opts);
  const hq = await seedBasic(t);
  let n = 0;
  const give = (id: string, code: string, createdAt?: string) =>
    t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: `give-${++n}-${id}-${code}`, ops: [{ k: 'stores', id, p: ['access'], v: access(code, createdAt) }] } });
  assert.equal((await give('s1', CODE1)).status, 200);
  assert.equal((await give('s2', CODE2)).status, 200);
  const cmd = (cookie: string, id: string, c: unknown, storeId = 's1') => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId, cmd: c } });
  const batch = (cookie: string, id: string, ops: unknown[]) => t.json('/api/batch', { method: 'POST', cookie, body: { id, ops } });
  const state = async (cookie: string) => (await t.json('/api/state', { cookie })).body;
  const me = async (cookie: string) => (await t.json('/api/me', { cookie })).body;
  return { t, hq, give, cmd, batch, state, me };
}

test('a store code signs in as that store: sees only it (and its campaign), never the code, admins or other stores', async () => {
  const { t, hq, me, state } = await setup();
  try {
    const team = await t.login(CODE1);
    assert.deepEqual(await me(team), { role: 'admin', principal: 'store:s1', name: '', store: 's1', team: 'Store s1', needsName: true, expiresAt: (await me(team)).expiresAt, seq: (await me(team)).seq });
    const s = await state(team);
    assert.equal(s.principal, 'store:s1');
    assert.deepEqual(Object.keys(s.stores), ['s1']);
    assert.deepEqual(Object.keys(s.events), ['e1']);
    assert.deepEqual(s.admins, {});
    assert.equal(s.stores.s1.access, undefined);
    assert.doesNotMatch(JSON.stringify(s), new RegExp(`${CODE1}|${CODE2}`));
    assert.equal((await state(hq)).stores.s1.access.code, CODE1, 'HQ sees the code');

    // lower-case typing works like it does for admin codes
    const lower = await t.login(CODE1.toLowerCase());
    assert.equal((await me(lower)).principal, 'store:s1');
    // a person-admin assigned to the same store still sees it, with the code stripped
    const a1 = await t.login('AAA2');
    assert.equal((await state(a1)).stores.s1.access, undefined);
  } finally {
    await t.close();
  }
});

test('the team does admin things in its store — check-in, on-spot, results, winners — and the record names the person and the team', async () => {
  const { t, hq, cmd, batch, state } = await setup();
  try {
    assert.equal((await cmd(hq, 'hq-set-team-01', { type: 'players.set', base: 0, players })).status, 200);
    const rhea = await t.login(CODE1, 'Rhea');
    const sam = await t.login(CODE1, 'Sam');

    // the same player list as an admin gets: numbers only after check-in
    let day = (await state(rhea)).stores.s1.day;
    assert.equal(day.players[0].phone, undefined);
    assert.equal(day.players[0].phoneEnd, '1111');

    const ci = await batch(rhea, 'team-checkin-001', ['p1', 'p2'].map((p) => ({ k: 'stores', id: 's1', p: ['day', 'checkIn', p], v: '2026-10-24T09:00:00.000Z' })));
    assert.equal(ci.status, 200, JSON.stringify(ci.body));
    day = (await state(sam)).stores.s1.day;
    assert.equal(day.players[0].phone, '9820011111', 'checked in → the number, for the whole team');

    // a walk-in registered by Rhea, another by Sam
    assert.equal((await cmd(rhea, 'team-walkin-0001', { type: 'players.onspot', base: day.version, name: 'Ravi K.', phone: '+91 98200 55555' })).status, 200);
    assert.equal((await cmd(sam, 'team-walkin-0002', { type: 'players.onspot', base: 0, name: 'Late Comer' })).status, 200);
    const onSpot = (await state(hq)).stores.s1.day.onSpot;
    assert.deepEqual(onSpot.map((e: { by: string }) => e.by), ['Rhea (Store s1 team)', 'Sam (Store s1 team)']);

    // the bracket goes out with the walk-ins left off it; from then on the team can't register more
    assert.equal((await cmd(hq, 'hq-build-team-01', { type: 'bracket.build', base: (await state(hq)).stores.s1.day.version, pairs: [['p1', 'p2']] })).status, 200);
    assert.equal((await cmd(sam, 'team-walkin-0003', { type: 'players.onspot', base: 0, name: 'Too Late' })).status, 409);
    day = (await state(sam)).stores.s1.day;

    // play the final, then save winners
    const m = day.matches[0];
    assert.equal((await cmd(rhea, 'team-start-00001', { type: 'match.start', base: day.version, matchId: m.id, station: 1 })).status, 200);
    assert.equal((await cmd(rhea, 'team-finish-0001', { type: 'match.finish', base: day.version, matchId: m.id, winner: 'p2' })).status, 200);
    const w = await cmd(sam, 'team-winners-001', { type: 'winners.set', base: 0, winner: { realName: 'Bilal Khan' }, runnerUp: { realName: 'Asha Rao' } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal((await state(hq)).stores.s1.day.winners.by, 'Sam (Store s1 team)');

    // the recce: working copy edits are allowed, the submission is recorded under the team principal
    const edit = await batch(rhea, 'team-recce-00001', [{ k: 'stores', id: 's1', p: ['recce', 'summary'], v: 'All good' }]);
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const sub = await cmd(rhea, 'team-submit-0001', { type: 'recce.submit', base: 0 });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const last = (await state(hq)).stores.s1.submissions.at(-1);
    assert.equal(last.by, 'store:s1');
    assert.equal(last.byName, 'Rhea (Store s1 team)');
  } finally {
    await t.close();
  }
});

test('a store team can’t see, write or command another store, and can’t read or write the team code', async () => {
  const { t, hq, cmd, batch, state } = await setup();
  try {
    const team = await t.login(CODE1, 'Rhea');
    // another store: nothing to read, 403 to write
    const other = await batch(team, 'team-other-00001', [{ k: 'stores', id: 's2', p: ['day', 'checkIn', 'p1'], v: '2026-10-24T09:00:00.000Z' }]);
    assert.equal(other.status, 403);
    assert.equal((await cmd(team, 'team-other-cmd-1', { type: 'players.onspot', base: 0, name: 'Nobody' }, 's2')).status, 403);
    assert.equal((await t.json('/api/photos/abcdef123?store=s2', { method: 'PUT', cookie: team, headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) })).status, 403);
    // HQ-only fields of its own store
    for (const [p, v] of [
      [['access'], access('ZZZ2')],
      [['access', 'code'], 'ZZZ2'],
      [['name'], 'Renamed'],
      [['adminId'], 'a2'],
    ] as [string[], unknown][]) {
      const r = await batch(team, `team-hq-${p.join('-')}-1`, [{ k: 'stores', id: 's1', p, v }]);
      assert.equal(r.status, 403, `${p.join('.')} → ${JSON.stringify(r.body)}`);
    }
    // not HQ's endpoints, and no admins / events writes
    assert.equal((await t.json('/api/roster/fetch?url=https://example.com/x', { cookie: team })).status, 403);
    assert.equal((await batch(team, 'team-admin-00001', [{ k: 'admins', id: 'x1', p: [], v: { id: 'x1', name: 'X', phone: '', code: 'XXX2', createdAt: '2026-10-01T00:00:00.000Z' } }])).status, 403);
    assert.equal((await state(hq)).stores.s1.access.code, CODE1, 'unchanged');
  } finally {
    await t.close();
  }
});

test('HQ rotating a store’s code signs everyone out; the old code and old cookies stop; turning it off disables the link', async () => {
  const { t, hq, give, state, me } = await setup();
  try {
    const rhea = await t.login(CODE1, 'Rhea');
    const sam = await t.login(CODE1, 'Sam');
    const other = await t.login(CODE2, 'Omar');
    assert.equal((await me(rhea)).name, 'Rhea');

    // a new code (new letters)
    assert.equal((await give('s1', 'TEM4', '2026-10-24T01:00:00.000Z')).status, 200);
    assert.equal((await t.json('/api/state', { cookie: rhea })).status, 401);
    assert.equal((await t.json('/api/state', { cookie: sam })).status, 401);
    assert.equal((await me(rhea)).role, null);
    assert.equal((await t.json('/api/state', { cookie: other })).status, 200, 'another store’s team is untouched');
    assert.equal((await t.req('/api/login', { method: 'POST', body: JSON.stringify({ code: CODE1 }) })).status, 401);
    const fresh = await t.login('TEM4');
    assert.equal((await state(fresh)).principal, 'store:s1');
    assert.equal((await me(fresh)).needsName, true, 'a new session asks who it is again (the app sends the remembered name with the login)');

    // the same letters again but a new creation time is still a new link: old sessions don't revive
    assert.equal((await give('s1', 'TEM4', '2026-10-24T02:00:00.000Z')).status, 200);
    assert.equal((await t.json('/api/state', { cookie: fresh })).status, 401);
    // rotating back to a code an old session used doesn't bring that session back
    assert.equal((await give('s1', CODE1)).status, 200);
    assert.equal((await t.json('/api/state', { cookie: rhea })).status, 401);

    // turn off: delete `access`
    const live = await t.login(CODE1);
    const off = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'access-off-0001', ops: [{ k: 'stores', id: 's1', p: ['access'], d: 1 }] } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await t.json('/api/state', { cookie: live })).status, 401);
    assert.equal((await t.req('/api/login', { method: 'POST', body: JSON.stringify({ code: CODE1 }) })).status, 401);
    assert.equal((await state(hq)).stores.s1.access, undefined);

    // deleting the store ends its team's sessions too
    const o2 = await t.login(CODE2);
    assert.equal((await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'store-gone-0001', ops: [{ k: 'stores', id: 's2', p: [], d: 1 }] } })).status, 200);
    assert.equal((await t.json('/api/state', { cookie: o2 })).status, 401);
  } finally {
    await t.close();
  }
});

test('codes are unique across admins and stores: a duplicate is refused with a plain message', async () => {
  const { t, hq, give, batch, state } = await setup();
  try {
    // two stores, one code
    const dupStore = await give('s2', CODE1, '2026-10-24T00:00:00.000Z');
    assert.equal(dupStore.status, 400, JSON.stringify(dupStore.body));
    assert.match(dupStore.body.error, /access\.code: is already used by another store/);
    // a store taking a person-admin's code
    const dupAdmin = await give('s2', 'AAA2', '2026-10-24T00:00:00.000Z');
    assert.equal(dupAdmin.status, 400);
    assert.match(dupAdmin.body.error, /already used by an admin/);
    // an admin taking a store's code (new admin and a changed code)
    const newAdmin = await batch(hq, 'admin-dup-000001', [{ k: 'admins', id: 'a3', p: [], v: { id: 'a3', name: 'Third', phone: '', code: CODE1, createdAt: '2026-10-01T00:00:00.000Z' } }]);
    assert.equal(newAdmin.status, 400);
    assert.match(newAdmin.body.error, /already used by a store team link/);
    const changeAdmin = await batch(hq, 'admin-dup-000002', [{ k: 'admins', id: 'a1', p: ['code'], v: CODE2 }]);
    assert.equal(changeAdmin.status, 400);
    // two new codes in one batch
    const both = await batch(hq, 'both-dup-0000001', [
      { k: 'stores', id: 's1', p: ['access'], v: access('TEM5', '2026-10-24T03:00:00.000Z') },
      { k: 'stores', id: 's2', p: ['access'], v: access('TEM5', '2026-10-24T03:00:00.000Z') },
    ]);
    assert.equal(both.status, 400);
    // nothing changed
    const s = await state(hq);
    assert.deepEqual([s.stores.s1.access.code, s.stores.s2.access.code, s.admins.a1.code], [CODE1, CODE2, 'AAA2']);
    // a bad shape is refused too
    assert.equal((await give('s1', 'toolong', '2026-10-24T04:00:00.000Z')).status, 400);
  } finally {
    await t.close();
  }
});

test('wrong store codes count against the same sign-in limits as admin codes', async () => {
  const { t } = await setup();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await t.req('/api/login', { method: 'POST', body: JSON.stringify({ code: 'ZZZ9' }) })).status, 401);
    const blocked = await t.req('/api/login', { method: 'POST', body: JSON.stringify({ code: CODE1 }) });
    assert.equal(blocked.status, 429, 'even the right store code waits');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally {
    await t.close();
  }
});

test('the person’s name: typed once, kept per phone, cleaned; HQ and personal admins have no name step', async () => {
  const { t, hq, cmd, state, me } = await setup();
  try {
    const phone1 = await t.login(CODE1);
    const phone2 = await t.login(CODE1);
    assert.equal((await me(phone1)).needsName, true);
    // before anyone is named, records say just the team
    assert.equal((await cmd(phone1, 'team-walkin-0010', { type: 'players.onspot', base: 0, name: 'Before Name' })).status, 200);
    assert.equal((await state(hq)).stores.s1.day.onSpot[0].by, 'Store s1 team');

    const named = await t.json('/api/me/name', { method: 'POST', cookie: phone1, body: { name: '  Rhea   (HQ)\n ' } });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    assert.equal(named.body.name, 'Rhea HQ', 'brackets can’t fake another team');
    assert.deepEqual([(await me(phone1)).name, (await me(phone1)).needsName], ['Rhea HQ', false]);
    assert.equal((await me(phone2)).name, '', 'the other phone is its own person');
    assert.equal((await t.json('/api/me/name', { method: 'POST', cookie: phone2, body: { name: 'Sam' } })).status, 200);
    assert.equal((await t.json('/api/me/name', { method: 'POST', cookie: phone2, body: { name: '   ' } })).status, 400);
    assert.equal((await t.json('/api/me/name', { method: 'POST', cookie: phone2, body: { name: 'x'.repeat(100) } })).body.name.length, 40);

    assert.equal((await cmd(phone1, 'team-walkin-0011', { type: 'players.onspot', base: 0, name: 'After Name' })).status, 200);
    assert.deepEqual((await state(hq)).stores.s1.day.onSpot.map((e: { by: string }) => e.by), ['Store s1 team', 'Rhea HQ (Store s1 team)']);

    // changing the name later changes later records only
    await t.json('/api/me/name', { method: 'POST', cookie: phone1, body: { name: 'Rhea D' } });
    assert.equal((await cmd(phone1, 'team-walkin-0012', { type: 'players.onspot', base: 0, name: 'Third' })).status, 200);
    assert.equal((await state(hq)).stores.s1.day.onSpot.at(-1).by, 'Rhea D (Store s1 team)');

    // HQ and personal admins: no name step, no endpoint
    assert.equal((await t.json('/api/me/name', { method: 'POST', cookie: hq, body: { name: 'HQ Person' } })).status, 403);
    const a1 = await t.login('AAA2', 'Not Applied');
    assert.equal((await t.json('/api/me/name', { method: 'POST', cookie: a1, body: { name: 'Nope' } })).status, 403);
    const meAdmin = await me(a1);
    assert.deepEqual([meAdmin.principal, meAdmin.name, meAdmin.needsName, meAdmin.store], ['admin:a1', 'Synthetic a1', undefined, undefined]);
    assert.equal((await t.json('/api/me/name', { method: 'POST', body: { name: 'Nobody' } })).status, 401);
  } finally {
    await t.close();
  }
});

test('a name remembered on the phone goes with the login; names survive a server restart; an older database gets the column', async () => {
  const first = await setup();
  const dataDir = first.t.dataDir;
  let cookie: string;
  try {
    cookie = await first.t.login(CODE1, 'Rhea');
    assert.equal((await first.me(cookie)).name, 'Rhea');
  } finally {
    await first.t.close();
  }
  // an older database: the sessions table without the name column
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.exec('ALTER TABLE sessions DROP COLUMN name');
  } finally {
    db.close();
  }
  const t2 = await startTestServer({ dataDir });
  try {
    // old sessions still valid (they just have no name), new ones carry it
    const old = await t2.json('/api/me', { cookie: cookie! });
    assert.equal(old.body.principal, 'store:s1');
    assert.equal(old.body.name, '');
    const again = await t2.login(CODE1, 'Rhea');
    assert.equal((await t2.json('/api/me', { cookie: again })).body.name, 'Rhea');
  } finally {
    await t2.close();
  }
  const t3 = await startTestServer({ dataDir });
  try {
    assert.equal((await t3.json('/api/me', { cookie: cookie! })).body.principal, 'store:s1');
  } finally {
    await t3.close();
  }
});

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

test('the live stream gives the team its store without the code, never the other store, and ends when the code is rotated', async () => {
  const { t, hq, batch, give } = await setup();
  try {
    const team = await t.login(CODE1, 'Rhea');
    const s = openStream(t, team);
    await s.connected;
    assert.equal((await batch(hq, 'stream-city-00001', [{ k: 'stores', id: 's1', p: ['city'], v: 'Nashik' }, { k: 'stores', id: 's2', p: ['city'], v: 'Pune' }])).status, 200);
    const m = await s.until((x) => x.id === 'stream-city-00001');
    const text = JSON.stringify(m);
    assert.match(text, /Nashik/);
    assert.doesNotMatch(text, /Pune|"access"|TEM2|TEM3/);

    assert.equal((await give('s1', 'TEM4', '2026-10-24T05:00:00.000Z')).status, 200);
    const ended = await s.until((x) => x.resync === true && x.id === '');
    assert.ok(ended, 'the stream is closed with a resync, and a reconnect finds a 401');
    assert.equal((await t.json('/api/state', { cookie: team })).status, 401);
    s.close();
  } finally {
    await t.close();
  }
});

test('personal admin codes keep working exactly as before, alongside a store’s team code', async () => {
  const { t, hq, cmd, state, me } = await setup();
  try {
    const a1 = await t.login('AAA2');
    assert.deepEqual(await me(a1).then((m) => [m.role, m.principal, m.name]), ['admin', 'admin:a1', 'Synthetic a1']);
    assert.deepEqual(Object.keys((await state(a1)).stores), ['s1']);
    assert.equal((await cmd(a1, 'admin-walkin-0001', { type: 'players.onspot', base: 0, name: 'Walk In' })).status, 200);
    assert.equal((await state(hq)).stores.s1.day.onSpot[0].by, 'Synthetic a1');
    // an admin can't see store s2, and rotating the admin's code doesn't touch a store team's sessions
    const team = await t.login(CODE1, 'Rhea');
    assert.equal((await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'rotate-admin-001', ops: [{ k: 'admins', id: 'a1', p: ['code'], v: 'AAA3' }] } })).status, 200);
    assert.equal((await t.json('/api/state', { cookie: a1 })).status, 401);
    assert.equal((await t.json('/api/state', { cookie: team })).status, 200);
    // and unassigning the admin from s1 leaves the team's access alone
    assert.equal((await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'unassign-0000001', ops: [{ k: 'stores', id: 's1', p: ['adminId'], v: null }] } })).status, 200);
    assert.deepEqual(Object.keys((await state(team)).stores), ['s1']);
  } finally {
    await t.close();
  }
});
