import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedBasic } from './helpers/server.ts';
import { device, network, realEngine, waitFor } from './sync-harness.ts';
import { PREF_PERSON, isTeamPrincipal, principalOf, type Engine } from '../src/lib/sync/engine.ts';
import { cleanPersonName, shortStoreName, teamActorName, usedCodes } from '../src/lib/teams.ts';

/*
 * Store team links on the device: the pure helpers, and the engine against the real API —
 * a team code signs in as "store:<id>", asks for a name once, remembers it, and signs out when HQ rotates the code.
 */

test('shortStoreName / cleanPersonName / teamActorName', () => {
  assert.equal(shortStoreName('ASUS ROG Exclusive Store — San Infotech'), 'San Infotech');
  assert.equal(shortStoreName('ASUS ROG Exclusive Store - Incredible Technologies'), 'Incredible Technologies');
  assert.equal(shortStoreName('Incredible Technologies'), 'Incredible Technologies');
  assert.equal(shortStoreName('ASUS ROG Exclusive Store'), 'ASUS ROG Exclusive Store', 'a name that is only the prefix stays whole');
  assert.equal(shortStoreName('x'.repeat(80)).length, 40);
  assert.equal(shortStoreName('  '), 'Store');

  assert.equal(cleanPersonName('  Rhea   (HQ)\n'), 'Rhea HQ');
  assert.equal(cleanPersonName('<b>Sam</b>'), 'b Sam /b');
  assert.equal(cleanPersonName(42), '');
  assert.equal(cleanPersonName('y'.repeat(60)).length, 40);

  assert.equal(teamActorName('Rhea', 'ASUS ROG Exclusive Store — San Infotech'), 'Rhea (San Infotech team)');
  assert.equal(teamActorName('', 'ASUS ROG Exclusive Store — San Infotech'), 'San Infotech team');
});

test('usedCodes lists admin codes and store team codes', () => {
  const state = {
    admins: { a: { id: 'a', name: 'A', phone: '', code: 'AAA2', createdAt: '' } },
    stores: { s1: { id: 's1', access: { code: 'TEM2', createdAt: '' } }, s2: { id: 's2' } },
  } as unknown as Parameters<typeof usedCodes>[0];
  assert.deepEqual(usedCodes(state).sort(), ['AAA2', 'TEM2']);
});

test('principalOf / isTeamPrincipal understand store:<id>', () => {
  assert.equal(principalOf({ role: 'admin', principal: 'store:s1' }), 'store:s1');
  assert.ok(isTeamPrincipal('store:s1'));
  assert.ok(!isTeamPrincipal('admin:a1') && !isTeamPrincipal('super') && !isTeamPrincipal(null));
});

async function setup() {
  const t = await startTestServer();
  const hq = await seedBasic(t);
  const give = (code: string, createdAt: string, id: string) =>
    t.json('/api/batch', { method: 'POST', cookie: hq, body: { id, ops: [{ k: 'stores', id: 's1', p: ['access'], v: { code, createdAt } }] } });
  assert.equal((await give('TEM2', '2026-10-23T00:00:00.000Z', 'give-code-000001')).status, 200);
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
  return { t, hq, give, dev, net, make, done };
}

test('a team code signs the device in to its store, asks for a name once, and remembers it', async () => {
  const { t, hq, dev, net, make, done } = await setup();
  try {
    const e = make();
    await e.start('TEM2');
    await waitFor(() => e.getSync().principal === 'store:s1' && e.getSync().connection === 'live', 'team live');
    assert.deepEqual([e.getSync().role, e.getSync().team, e.getSync().needsName, e.getSync().name], ['admin', 'Store s1', true, undefined]);
    assert.deepEqual(Object.keys(e.getState().stores), ['s1']);
    assert.equal(e.getState().stores.s1.access, undefined);

    assert.equal(await e.setMyName('  '), 'Type your name.');
    assert.equal(await e.setMyName('Rhea'), null);
    assert.deepEqual([e.getSync().name, e.getSync().needsName], ['Rhea', false]);
    assert.equal(dev.prefs.get(PREF_PERSON), 'Rhea');

    // the walk-in is shown (and finally recorded) as the person plus the team
    e.sendCommand('s1', { type: 'players.onspot', base: 0, name: 'Ravi K.' });
    await waitFor(() => e.getPending().length === 0 && (e.getState().stores.s1.day.onSpot ?? []).length === 1, 'walk-in sent');
    assert.equal(e.getState().stores.s1.day.onSpot![0].by, 'Rhea (Store s1 team)');
    assert.equal((await t.json('/api/state', { cookie: hq })).body.stores.s1.day.onSpot[0].by, 'Rhea (Store s1 team)');

    // a reload: no question again; "Change name" asks, and saving changes later records
    e.stop();
    const e2 = make();
    await e2.start();
    await waitFor(() => e2.getSync().principal === 'store:s1' && e2.getSync().connection === 'live', 'reload live');
    assert.deepEqual([e2.getSync().name, e2.getSync().team, e2.getSync().needsName], ['Rhea', 'Store s1', false]);
    e2.askName();
    assert.equal(e2.getSync().needsName, true);
    assert.equal(await e2.setMyName('Rhea D'), null);
    assert.equal(e2.getSync().needsName, false);

    // signing out is "not my phone": the remembered name goes
    assert.equal(await e2.logout(), true);
    assert.equal(dev.prefs.get(PREF_PERSON), null);
    assert.ok(net.log.some((l) => l.path === '/api/me/name'));
  } finally {
    await done();
  }
});

test('a name remembered on the device goes with the login — and is re-sent if the session lacks it', async () => {
  const { t, dev, net, make, done } = await setup();
  try {
    dev.prefs.set(PREF_PERSON, 'Sam');
    const e = make();
    await e.start('TEM2');
    await waitFor(() => e.getSync().principal === 'store:s1' && e.getSync().connection === 'live', 'live');
    assert.deepEqual([e.getSync().name, e.getSync().needsName], ['Sam', false], 'no question');
    assert.ok(!net.log.some((l) => l.path === '/api/me/name'), 'the login carried it');
    e.stop();

    // a session made without a name (cookie from elsewhere) + a remembered name → sent quietly
    const dev2 = device();
    dev2.cookies.set('fd_session', (await t.login('TEM2')).split('=')[1]);
    dev2.prefs.set(PREF_PERSON, 'Omar');
    const net2 = network(dev2, t.base);
    const e2 = realEngine(dev2, net2);
    try {
      await e2.start();
      await waitFor(() => e2.getSync().name === 'Omar' && e2.getSync().connection === 'live', 'name re-sent');
      assert.equal(e2.getSync().needsName, false);
      assert.ok(net2.log.some((l) => l.path === '/api/me/name'));
    } finally {
      e2.stop();
      net2.streams.forEach((s) => s.close());
    }
  } finally {
    await done();
  }
});

test('HQ giving the store a new code signs the device out', async () => {
  const { give, make, done } = await setup();
  try {
    const e = make();
    await e.start('TEM2');
    await waitFor(() => e.getSync().principal === 'store:s1' && e.getSync().connection === 'live', 'live');
    assert.equal((await give('TEM3', '2026-10-24T00:00:00.000Z', 'give-code-000002')).status, 200);
    await waitFor(() => e.getSync().connection === 'locked', 'signed out');
    assert.equal(e.getSync().role, null);
    assert.deepEqual(e.getState().stores, {});
  } finally {
    await done();
  }
});
