/*
 * winners.clear — HQ drops a store's saved winner + runner-up details. The handler (pure, over an
 * in-memory store): clears only day.winners, conflict when empty, HQ only. Then over the real API:
 * admin 403, HQ 200, /api/state has no day.winners afterwards, retries apply once, the admin can
 * collect again, and a batch writing or deleting day.winners is still 403.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, CommandError, dayVersion, validateCommand, type Command, type CommandContext } from '../src/lib/commands.ts';
import { winnersState } from '../src/lib/winnerInput.ts';
import type { Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureStore, seedBasic, startTestServer, SUPER } from './helpers/server.ts';

const event: TournamentEvent = { id: 'e1', name: 'Test Cup', date: '2026-10-23', games: [], collateral: [], gameReadyTarget: 0, minDownMbps: 0, createdAt: '2026-10-01T00:00:00.000Z' };
let seq = 0;
const ctx = (role: 'super' | 'admin' = 'super', name = 'HQ'): CommandContext => ({
  commandId: `wc${++seq}`,
  now: new Date(Date.UTC(2026, 9, 23, 10, 0, seq)).toISOString(),
  actor: { principal: role === 'super' ? 'super' : 'a1', name, role },
  event,
});
const run = (s: Store, cmd: Command, c = ctx()) => applyCommand(s, cmd, c);
const players = [
  { id: 'p1', name: 'Asha R.', seed: 1, phone: '9820011111' },
  { id: 'p2', name: 'Bilal', seed: 2 },
];

/** Two players, both checked in, the final played (p2 wins) and the winners saved. */
function withWinners(): Store {
  const s = fixtureStore('s1', 'e1', 'a1') as unknown as Store;
  const l = run(s, { type: 'bracket.load', base: 0, players });
  const checked = { ...l, day: { ...l.day, checkIn: { p1: '2026-10-23T09:00:00.000Z', p2: '2026-10-23T09:00:00.000Z' } } };
  const m = checked.day.matches[0];
  const started = run(checked, { type: 'match.start', base: 0, matchId: m.id, station: 1 }, ctx('admin', 'Rhea'));
  const done = run(started, { type: 'match.finish', base: 0, matchId: m.id, winner: 'p2' }, ctx('admin', 'Rhea'));
  return run(done, { type: 'winners.set', base: 0, winner: { realName: 'Bilal Khan' }, runnerUp: { realName: 'Asha Rao' } }, ctx('admin', 'Rhea'));
}

const isErr = (code: string, msg?: RegExp) => (e: unknown) => e instanceof CommandError && e.code === code && (!msg || msg.test(e.message));

test('winners.clear removes day.winners and nothing else; the admin collects again', () => {
  const s = withWinners();
  assert.ok(s.day.winners);
  assert.equal(winnersState(s.day).kind, 'saved');
  const out = run(s, { type: 'winners.clear', base: dayVersion(s) });
  assert.equal('winners' in out.day, false, 'the key is gone, not just undefined');
  assert.equal(out.day.version, (s.day.version ?? 0) + 1);
  assert.deepEqual(out.day.matches, s.day.matches);
  assert.deepEqual(out.day.players, s.day.players);
  assert.deepEqual(out.day.checkIn, s.day.checkIn);
  assert.equal(out.day.stations, s.day.stations);
  assert.equal(winnersState(out.day).kind, 'collect');
  const again = run(out, { type: 'winners.set', base: 0, winner: { realName: 'Bilal K' }, runnerUp: { realName: '' } }, ctx('admin', 'Rhea'));
  assert.equal(again.day.winners?.winner.realName, 'Bilal K');
});

test('base is informational, and details left over from a reset final can be cleared too', () => {
  const s = withWinners();
  assert.doesNotThrow(() => run(s, { type: 'winners.clear', base: 0 }));
  const reset = run(s, { type: 'bracket.reset', base: dayVersion(s) });
  assert.ok(reset.day.winners, 'bracket.reset keeps the details');
  assert.equal(winnersState(reset.day).kind, 'stale');
  const out = run(reset, { type: 'winners.clear', base: 99 });
  assert.equal(out.day.winners, undefined);
  assert.equal(winnersState(out.day).kind, 'none');
});

test('nothing to clear is a plain conflict', () => {
  const s = fixtureStore('s1', 'e1', 'a1') as unknown as Store;
  assert.throws(() => run(s, { type: 'winners.clear', base: 0 }), isErr('conflict', /no winner details/i));
  const cleared = run(withWinners(), { type: 'winners.clear', base: 0 });
  assert.throws(() => run(cleared, { type: 'winners.clear', base: 0 }), isErr('conflict'));
});

test('HQ only; the shape check wants just a base', () => {
  const s = withWinners();
  assert.throws(() => run(s, { type: 'winners.clear', base: 0 }, ctx('admin', 'Rhea')), isErr('forbidden'));
  assert.deepEqual(validateCommand({ type: 'winners.clear', base: 3 }), { type: 'winners.clear', base: 3 });
  assert.throws(() => validateCommand({ type: 'winners.clear' }), isErr('invalid'));
});

/* ---------- over the real API ---------- */

async function setup() {
  const t = await startTestServer();
  await seedBasic(t);
  const admin = await t.login('AAA2');
  const hq = await t.login(SUPER);
  const cmd = (cookie: string, id: string, c: unknown) => t.json('/api/command', { method: 'POST', cookie, body: { id, storeId: 's1', cmd: c } });
  const store = async (cookie = hq) => (await t.json('/api/state', { cookie })).body.stores.s1;
  assert.equal((await cmd(hq, 'hq-load-reset-1', { type: 'bracket.load', base: 0, players })).status, 200);
  const d = (await store()).day;
  const ci = await t.json('/api/batch', { method: 'POST', cookie: admin, body: { id: 'ci-reset-000001', ops: ['p1', 'p2'].map((p) => ({ k: 'stores', id: 's1', p: ['day', 'checkIn', p], v: '2026-10-24T09:00:00.000Z' })) } });
  assert.equal(ci.status, 200, JSON.stringify(ci.body));
  const m = d.matches[0];
  assert.equal((await cmd(admin, 'st-reset-0000001', { type: 'match.start', base: d.version, matchId: m.id, station: 1 })).status, 200);
  assert.equal((await cmd(admin, 'fin-reset-000001', { type: 'match.finish', base: d.version, matchId: m.id, winner: 'p2' })).status, 200);
  assert.equal((await cmd(admin, 'win-reset-000001', { type: 'winners.set', base: 0, winner: { realName: 'Bilal Khan' }, runnerUp: { realName: 'Asha Rao' } })).status, 200);
  return { t, admin, hq, cmd, store };
}

test('API: admin 403 and nothing changes; HQ 200 and /api/state has no day.winners', async () => {
  const { t, admin, hq, cmd, store } = await setup();
  try {
    const before = await store();
    assert.ok(before.day.winners);
    const denied = await cmd(admin, 'clr-admin-000001', { type: 'winners.clear', base: before.day.version });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.deepEqual((await store()).day, before.day);

    const ok = await cmd(hq, 'clr-hq-00000001', { type: 'winners.clear', base: before.day.version });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    for (const who of [hq, admin]) {
      const after = (await store(who)).day;
      assert.equal('winners' in after, false);
      assert.deepEqual(after.matches, before.day.matches);
      assert.deepEqual(after.players, before.day.players);
      assert.deepEqual(after.checkIn, before.day.checkIn);
      assert.equal(after.version, before.day.version + 1);
    }

    const twice = await cmd(hq, 'clr-hq-00000002', { type: 'winners.clear', base: 0 });
    assert.equal(twice.status, 409, JSON.stringify(twice.body));
    assert.match(twice.body.error, /no winner details/i);
  } finally {
    await t.close();
  }
});

test('API: a retry of the same command id applies once; the admin can collect again afterwards', async () => {
  const { t, admin, hq, cmd, store } = await setup();
  try {
    const v0 = (await store()).day.version;
    const first = await cmd(hq, 'clr-retry-000001', { type: 'winners.clear', base: v0 });
    const again = await cmd(hq, 'clr-retry-000001', { type: 'winners.clear', base: v0 });
    assert.equal(first.status, 200);
    assert.deepEqual(again.body, first.body);
    assert.equal((await store()).day.version, v0 + 1, 'one bump, not two');

    const redo = await cmd(admin, 'win-reset-000002', { type: 'winners.set', base: 0, winner: { realName: 'Bilal K' }, runnerUp: { realName: '' } });
    assert.equal(redo.status, 200, JSON.stringify(redo.body));
    assert.equal((await store()).day.winners.winner.realName, 'Bilal K');
  } finally {
    await t.close();
  }
});

test('API: day.winners stays command-only — a batch that writes or deletes it is still 403', async () => {
  const { t, admin, hq, cmd, store } = await setup();
  try {
    const forged = { winner: { playerId: 'p2', realName: 'Mallory' }, runnerUp: { playerId: 'p1' }, finalMatchId: 'x', at: '2026-10-24T10:00:00.000Z', updatedAt: '2026-10-24T10:00:00.000Z', by: 'me' };
    const drop = [{ k: 'stores', id: 's1', p: ['day', 'winners'], d: 1 }];
    const tries = [
      { who: admin, ops: drop },
      { who: hq, ops: drop },
      { who: hq, ops: [{ k: 'stores', id: 's1', p: ['day', 'winners'], v: forged }] },
    ];
    for (const [i, x] of tries.entries()) {
      const r = await t.json('/api/batch', { method: 'POST', cookie: x.who, body: { id: `b-clr-forge-0000${i}`, ops: x.ops } });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.deepEqual(r.body.paths, ['stores/s1.day.winners']);
    }
    assert.equal((await store()).day.winners.winner.realName, 'Bilal Khan');
    // after a command clear, a batch still cannot put details back
    assert.equal((await cmd(hq, 'clr-batch-000001', { type: 'winners.clear', base: 0 })).status, 200);
    const put = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'b-clr-forge-00009', ops: [{ k: 'stores', id: 's1', p: ['day', 'winners'], v: forged }] } });
    assert.equal(put.status, 403, JSON.stringify(put.body));
    assert.equal('winners' in (await store()).day, false);
  } finally {
    await t.close();
  }
});
