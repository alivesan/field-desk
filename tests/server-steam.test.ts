/*
 * HQ's Steam accounts over the real API: a new HQ-only document kind (`accounts`), a per-store assignment
 * (`store.steam`, HQ-only) and what a store's team gets instead — `store.steamLogin`, the login of the
 * account HQ gave that store, worked out per request. Other stores, other accounts and the assignment
 * itself never reach field devices; a password change reaches the right team live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, seedBasic, type TestServer } from './helpers/server.ts';
import { createBackup, restoreBackup, verifyBackup } from '../server/backup.ts';

const TEAM1 = 'TEM2';
const TEAM2 = 'TEM3';
const PASS_X = 'fake-pass-123';
const PASS_Y = 'fake-pass-456';
const account = (id: string, over: Record<string, unknown> = {}) => ({ id, label: `ROG ${id}`, username: `test_rog_${id}`, password: id === 'y' ? PASS_Y : PASS_X, email: '', notes: `HQ note for ${id}`, createdAt: '2026-10-20T00:00:00.000Z', ...over });
const assignment = (accountId: string, purpose = 'play') => ({ accountId, purpose, assignedAt: '2026-10-22T00:00:00.000Z' });

async function setup() {
  const t = await startTestServer();
  const hq = await seedBasic(t);
  let n = 0;
  const batch = (cookie: string, ops: unknown[]) => t.json('/api/batch', { method: 'POST', cookie, body: { id: `steam-batch-${String(++n).padStart(4, '0')}`, ops } });
  const state = async (cookie: string) => (await t.json('/api/state', { cookie })).body;
  assert.equal((await batch(hq, [{ k: 'stores', id: 's1', p: ['access'], v: { code: TEAM1, createdAt: '2026-10-23T00:00:00.000Z' } }, { k: 'stores', id: 's2', p: ['access'], v: { code: TEAM2, createdAt: '2026-10-23T00:00:00.000Z' } }])).status, 200);
  assert.equal((await batch(hq, [{ k: 'accounts', id: 'x', p: [], v: account('x') }, { k: 'accounts', id: 'y', p: [], v: account('y') }])).status, 200);
  return { t, hq, batch, state };
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

test('HQ adds, edits and deletes Steam accounts; they are in HQ’s snapshot', async () => {
  const { t, hq, batch, state } = await setup();
  try {
    const s = await state(hq);
    assert.deepEqual(Object.keys(s.accounts).sort(), ['x', 'y']);
    assert.equal(s.accounts.x.password, PASS_X);

    assert.equal((await batch(hq, [{ k: 'accounts', id: 'x', p: ['password'], v: 'fake-new-pass-9' }, { k: 'accounts', id: 'x', p: ['notes'], v: 'moved to Pune' }])).status, 200);
    assert.deepEqual([(await state(hq)).accounts.x.password, (await state(hq)).accounts.x.notes], ['fake-new-pass-9', 'moved to Pune']);

    assert.equal((await batch(hq, [{ k: 'accounts', id: 'y', p: [], d: 1 }])).status, 200);
    assert.deepEqual(Object.keys((await state(hq)).accounts), ['x']);
  } finally {
    await t.close();
  }
});

test('an account needs a username and a password, and a username is listed once', async () => {
  const { t, hq, batch } = await setup();
  try {
    const bad = async (v: unknown, re: RegExp) => {
      const r = await batch(hq, [{ k: 'accounts', id: 'z', p: [], v }]);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, re);
    };
    await bad(account('z', { username: '  ' }), /username: must be text/);
    await bad(account('z', { password: '' }), /password: must be text/);
    await bad(account('z', { password: 'p'.repeat(201) }), /password: must be text/);
    await bad(account('z', { username: 'TEST_ROG_X' }), /username: is already in the Steam accounts list/);
    await bad(account('z', { createdAt: 'yesterday' }), /createdAt/);
    assert.equal((await batch(hq, [{ k: 'accounts', id: 'z', p: [], v: account('z', { label: undefined, email: undefined, notes: undefined }) }])).status, 200);
  } finally {
    await t.close();
  }
});

test('a store can only be given an account that exists, with a known purpose; an assigned account can’t be deleted', async () => {
  const { t, hq, batch, state } = await setup();
  try {
    const none = await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], v: assignment('ghost') }]);
    assert.equal(none.status, 400);
    assert.match(none.body.error, /steam\.accountId: Steam account ghost doesn’t exist/);
    const odd = await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], v: assignment('x', 'stream') }]);
    assert.equal(odd.status, 400);
    assert.match(odd.body.error, /steam\.purpose/);

    assert.equal((await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], v: assignment('x') }])).status, 200);
    assert.equal((await state(hq)).stores.s1.steam.accountId, 'x');
    const del = await batch(hq, [{ k: 'accounts', id: 'x', p: [], d: 1 }]);
    assert.equal(del.status, 400, 'still given to s1');
    assert.match(del.body.error, /Steam account x doesn’t exist/);
    assert.ok((await state(hq)).accounts.x, 'nothing was deleted');

    // unassign and delete in one go is fine
    assert.equal((await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], d: 1 }, { k: 'accounts', id: 'x', p: [], d: 1 }])).status, 200);
    assert.equal((await state(hq)).accounts.x, undefined);
  } finally {
    await t.close();
  }
});

test('field admins and store teams never receive accounts, and can’t write them', async () => {
  const { t, hq, batch, state } = await setup();
  try {
    assert.equal((await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], v: assignment('x') }])).status, 200);
    const a1 = await t.login('AAA2');
    const team = await t.login(TEAM1, 'Rhea');
    for (const cookie of [a1, team]) {
      const s = await state(cookie);
      assert.deepEqual(s.accounts, {});
      const text = JSON.stringify(s);
      assert.doesNotMatch(text, /HQ note|ROG x|ROG y|test_rog_y|fake-pass-456|"accountId"/);
    }
    for (const cookie of [a1, team]) {
      for (const [id, op] of [
        ['create', { k: 'accounts', id: 'z', p: [], v: account('z') }],
        ['edit', { k: 'accounts', id: 'x', p: ['password'], v: 'fake-hijack-1' }],
        ['delete', { k: 'accounts', id: 'x', p: [], d: 1 }],
      ] as const) {
        const r = await t.json('/api/batch', { method: 'POST', cookie, body: { id: `deny-${id}-${cookie.slice(-6)}`, ops: [op] } });
        assert.equal(r.status, 403, `${id}: ${JSON.stringify(r.body)}`);
        assert.match(r.body.error, /Only HQ/);
      }
    }
    assert.equal((await state(hq)).accounts.x.password, PASS_X);
  } finally {
    await t.close();
  }
});

test('the assigned store’s team gets the login (and purpose) on its store; other stores and teams get nothing', async () => {
  const { t, hq, batch, state } = await setup();
  try {
    assert.equal((await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], v: assignment('x', 'download') }, { k: 'stores', id: 's2', p: ['steam'], v: assignment('y', 'play') }])).status, 200);
    assert.equal((await batch(hq, [{ k: 'accounts', id: 'x', p: ['email'], v: 'hq-x@example.test' }])).status, 200);
    const team1 = await t.login(TEAM1, 'Rhea');
    const team2 = await t.login(TEAM2, 'Sam');
    const a1 = await t.login('AAA2');

    const one = (await state(team1)).stores.s1;
    assert.deepEqual(one.steamLogin, { username: 'test_rog_x', password: PASS_X, purpose: 'download' }, 'the email stays with HQ');
    assert.equal(one.steam, undefined, 'the assignment itself (account id) stays with HQ');
    assert.deepEqual(Object.keys((await state(team1)).stores), ['s1']);
    assert.doesNotMatch(JSON.stringify(await state(team1)), /test_rog_y|fake-pass-456|ROG x|HQ note/);

    const two = (await state(team2)).stores.s2;
    assert.deepEqual(two.steamLogin, { username: 'test_rog_y', password: PASS_Y, purpose: 'play' }, 'no email key without an email');
    assert.doesNotMatch(JSON.stringify(await state(team2)), /test_rog_x|fake-pass-123/);

    // the admin assigned to s1 sees it too; HQ's own copy is the raw assignment, never a steamLogin
    assert.equal((await state(a1)).stores.s1.steamLogin.username, 'test_rog_x');
    const hqS1 = (await state(hq)).stores.s1;
    assert.equal(hqS1.steam.accountId, 'x');
    assert.equal(hqS1.steamLogin, undefined);

    // a store with no account has no steamLogin at all
    assert.equal((await batch(hq, [{ k: 'stores', id: 's2', p: ['steam'], d: 1 }])).status, 200);
    assert.equal('steamLogin' in (await state(team2)).stores.s2, false);
    assert.equal(JSON.stringify(await state(team2)).includes('steam'), false);
  } finally {
    await t.close();
  }
});

test('a store team can’t assign an account or write a login of its own', async () => {
  const { t, hq, batch, state } = await setup();
  try {
    const team = await t.login(TEAM1, 'Rhea');
    const mine = await batch(team, [{ k: 'stores', id: 's1', p: ['steam'], v: assignment('x') }]);
    assert.equal(mine.status, 403);
    assert.match(mine.body.error, /Only HQ can change “steam”/);
    const login = await batch(team, [{ k: 'stores', id: 's1', p: ['steamLogin'], v: { username: 'x', password: 'y', purpose: 'play' } }]);
    assert.equal(login.status, 403);
    // not even HQ can save a computed login
    const saved = await batch(hq, [{ k: 'stores', id: 's1', p: ['steamLogin'], v: { username: 'x', password: 'y', purpose: 'play' } }]);
    assert.equal(saved.status, 400);
    assert.match(saved.body.error, /steamLogin/);
    assert.equal((await state(hq)).stores.s1.steam, undefined);
  } finally {
    await t.close();
  }
});

test('live: a new password reaches the assigned team’s stream — and only that team’s', async () => {
  const { t, hq, batch } = await setup();
  try {
    assert.equal((await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], v: assignment('x') }, { k: 'stores', id: 's2', p: ['steam'], v: assignment('y', 'download') }])).status, 200);
    const team1 = openStream(t, await t.login(TEAM1, 'Rhea'));
    const team2 = openStream(t, await t.login(TEAM2, 'Sam'));
    const hqStream = openStream(t, hq);
    await Promise.all([team1.connected, team2.connected, hqStream.connected]);

    const edit = await batch(hq, [{ k: 'accounts', id: 'x', p: ['password'], v: 'fake-rotated-77' }]);
    assert.equal(edit.status, 200);
    const mine = await team1.until((m) => m.seq === edit.body.seq);
    assert.equal(mine.ops.length, 1);
    assert.equal(mine.ops[0].k, 'stores');
    assert.equal(mine.ops[0].id, 's1');
    assert.equal(mine.ops[0].v.steamLogin.password, 'fake-rotated-77');
    assert.equal(mine.ops[0].v.steam, undefined);

    const other = await team2.until((m) => m.seq === edit.body.seq);
    assert.deepEqual(other.ops, [], 'the other store hears that something changed, nothing more');
    assert.doesNotMatch(JSON.stringify(team2.msgs), /fake-rotated-77|test_rog_x/);

    // HQ gets the account op as written
    const hqMsg = await hqStream.until((m) => m.seq === edit.body.seq);
    assert.deepEqual(hqMsg.ops.map((o: { k: string; p: string[] }) => [o.k, o.p.join('.')]), [['accounts', 'password']]);

    // an account change nobody holds stays invisible to every team
    const unheld = await batch(hq, [{ k: 'accounts', id: 'y', p: ['notes'], v: 'only HQ reads this' }]);
    const seen1 = await team1.until((m) => m.seq === unheld.body.seq);
    assert.deepEqual(seen1.ops, []);
    assert.doesNotMatch(JSON.stringify(team1.msgs), /only HQ reads this/);
    // …while the store that downloads with y does hear of it as a changed store (its login is unchanged)
    const seen2 = await team2.until((m) => m.seq === unheld.body.seq);
    assert.equal(seen2.ops[0].v.steamLogin.username, 'test_rog_y');
    assert.doesNotMatch(JSON.stringify(team2.msgs), /only HQ reads this/);
    for (const s of [team1, team2, hqStream]) s.close();
  } finally {
    await t.close();
  }
});

test('live: assigning, switching and unassigning an account reach the team at once', async () => {
  const { t, hq, batch, state } = await setup();
  try {
    const team = await t.login(TEAM1, 'Rhea');
    const stream = openStream(t, team);
    await stream.connected;

    const give = await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], v: assignment('x') }]);
    assert.equal((await stream.until((m) => m.seq === give.body.seq)).ops[0].v.steamLogin.username, 'test_rog_x');

    const swap = await batch(hq, [{ k: 'stores', id: 's1', p: ['steam', 'accountId'], v: 'y' }, { k: 'stores', id: 's1', p: ['steam', 'purpose'], v: 'download' }]);
    const swapped = (await stream.until((m) => m.seq === swap.body.seq)).ops[0].v.steamLogin;
    assert.deepEqual([swapped.username, swapped.purpose], ['test_rog_y', 'download']);

    const off = await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], d: 1 }]);
    const gone = (await stream.until((m) => m.seq === off.body.seq)).ops[0].v;
    assert.equal(gone.steamLogin, undefined, 'the whole store is replaced, so the old login is gone');
    assert.equal(JSON.stringify(await state(team)).includes('test_rog'), false);
    stream.close();
  } finally {
    await t.close();
  }
});

test('server backups count and carry the accounts, and a restored server serves them', async () => {
  const { t, hq, batch } = await setup();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-steam-bk-'));
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-steam-rs-'));
  fs.rmSync(path.join(out, 'b'), { recursive: true, force: true });
  let t2: TestServer | undefined;
  try {
    assert.equal((await batch(hq, [{ k: 'stores', id: 's1', p: ['steam'], v: assignment('x') }])).status, 200);
    const m = createBackup(t.dataDir, path.join(out, 'b'));
    assert.equal(m.counts.accounts, 2);
    assert.deepEqual(verifyBackup(path.join(out, 'b')), []);
    // the manifest's count is checked on verify: a database with another number of accounts fails
    const man = path.join(out, 'b', 'manifest.json');
    const edited = JSON.parse(fs.readFileSync(man, 'utf8'));
    edited.counts.accounts = 5;
    fs.writeFileSync(man, JSON.stringify(edited));
    assert.ok(verifyBackup(path.join(out, 'b')).some((p) => /count of accounts: manifest 5, database 2/.test(p)));
    edited.counts.accounts = 2;
    fs.writeFileSync(man, JSON.stringify(edited));

    const dir = path.join(restored, 'data');
    restoreBackup(path.join(out, 'b'), dir);
    t2 = await startTestServer({ dataDir: dir });
    const hq2 = await t2.login('synthetic-hq-code-for-tests-0001');
    const s = (await t2.json('/api/state', { cookie: hq2 })).body;
    assert.deepEqual(Object.keys(s.accounts).sort(), ['x', 'y']);
    assert.equal(s.stores.s1.steam.accountId, 'x');
  } finally {
    await t2?.close();
    await t.close();
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(restored, { recursive: true, force: true });
  }
});
