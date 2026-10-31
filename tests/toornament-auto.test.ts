/*
 * The Toornament auto-check (server/toornament-auto.ts, src/lib/toornament-auto.ts): from 12:30 India
 * time on a store's day the server looks at its Toornament stage every 5 minutes, loads the bracket
 * once the players are placed, and stops. Real API on a temp dir, a fake clock, and a fake Toornament
 * built from the trimmed answers in tests/fixtures/toornament/ — no network, no timers waited for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestServer, seedBasic, fixtureEvent, fixtureStore, SUPER, type TestServer } from './helpers/server.ts';
import { RosterFetchError } from '../server/roster-fetch.ts';
import { bracketFromNodes, parseToornamentLink, pickStage, readParticipants, readStages, readTournament, applyToornamentLink, type ToornamentFetch, type ToornamentLink } from '../src/lib/toornament.ts';
import { autoDue, autoFinished, autoLine, autoWindow, bracketOrigin, bracketReady, inZone } from '../src/lib/toornament-auto.ts';
import { validateDocument } from '../src/lib/schema.ts';
import type { Store, TournamentEvent } from '../src/lib/types.ts';

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/toornament/${name}.json`, import.meta.url), 'utf8'));
const FIXTURES = new Map<string, any>(['se8', 'se7', 'se12', 'multi', 'de'].map((n) => fixture(n)).map((f) => [f.tournament.id, f]));
const SE8 = '2606138892358238208'; // 7 players in 8 slots: Diya Patel has the bye
const SE7 = '2100882557444374528';
const MULTI = '1341889430865920000'; // a league, then a single-elimination stage nobody is placed in
const DE = '2001331429601337344';
const link = (tid: string) => `https://play.toornament.com/en_US/tournaments/${tid}/`;

/** The IST wall clock the tests talk about: 12:30 on 24 Oct 2026 is 07:00 UTC. */
const ist = (hm: string, date = '2026-10-24') => new Date(`${date}T${hm}:00+05:30`);

type Variant = 'placed' | 'unplaced' | 'none';
/** A stand-in for fetchToornament: the same ToornamentFetch, made from the fixtures. `variant` is what Toornament shows right now. */
function fakeToornament() {
  const state = { variant: 'placed' as Variant, calls: 0, links: [] as string[], fail: undefined as unknown, active: 0, maxActive: 0, delayMs: 0, by: new Map<string, Variant>() };
  const fetch = async (raw: string, stageId?: string): Promise<ToornamentFetch> => {
    state.calls++;
    state.links.push(raw);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.fail) throw state.fail;
      const parsed = parseToornamentLink(raw) as ToornamentLink;
      const f = FIXTURES.get(parsed.tournamentId)!;
      const variant = state.by.get(parsed.tournamentId) ?? state.variant;
      const items: any[] = variant === 'none' ? [] : variant === 'unplaced' ? f.nodes.items.map((n: any) => ({ ...n, opponents: n.opponents.map((o: any) => ({ ...o, participant: null })) })) : (f.nodes?.items ?? []);
      const stages = readStages(f.stages);
      const stage = pickStage(stages, stageId ?? parsed.stageId);
      const participants = readParticipants(f.participants);
      return {
        link: parsed,
        tournament: readTournament(f.tournament),
        stages,
        stage,
        participants,
        participantsTotal: participants.length,
        bracket: stage?.supported ? bracketFromNodes(items, participants, stage) : null,
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      state.active--;
    }
  };
  return { state, fetch };
}

async function setup(over: { storeOver?: Record<string, unknown>; eventOver?: Record<string, unknown>; at?: Date; log?: (level: string, event: string, fields?: Record<string, unknown>) => void; auto?: Record<string, unknown> } = {}) {
  const toornament = fakeToornament();
  const clock = { at: over.at ?? ist('12:00') };
  const t = await startTestServer({
    log: over.log,
    toornamentAuto: { now: () => clock.at, gapMs: 0, fetch: toornament.fetch, ...over.auto },
  });
  const hq = await seedBasic(t);
  const admin = await t.login('AAA2');
  const put = (docs: unknown[]) => t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: `setup-${Math.random().toString(36).slice(2, 10)}`, ops: docs } });
  if (over.eventOver) assert.equal((await put([{ k: 'events', id: 'e1', p: [], v: fixtureEvent('e1', over.eventOver) }])).status, 200);
  assert.equal((await put([{ k: 'stores', id: 's1', p: ['toornament'], v: { url: link(SE8) } }, ...Object.entries(over.storeOver ?? {}).map(([k, v]) => ({ k: 'stores', id: 's1', p: [k], v }))])).status, 200);
  let n = 0;
  const cmd = async (cookie: string, c: unknown, storeId = 's1') => {
    const r = await t.json('/api/command', { method: 'POST', cookie, body: { id: `cmd-${++n}-${Math.random().toString(36).slice(2, 8)}`, storeId, cmd: c } });
    return r;
  };
  const store = async (cookie = hq, id = 's1'): Promise<Store> => (await t.json('/api/state', { cookie })).body.stores[id];
  const version = async () => (await store()).day.version ?? 0;
  const tick = () => t.api.toornamentAuto.tick();
  const batch = (cookie: string, ops: unknown[]) => t.json('/api/batch', { method: 'POST', cookie, body: { id: `b-${++n}-${Math.random().toString(36).slice(2, 8)}`, ops } });
  const roster = async () => {
    // On HQ's list: two who are on Toornament (one with a phone, checked in), one who isn't.
    const players = [
      { id: 'p-asha', name: 'Asha Rao', seed: 1, phone: '9820011111' },
      { id: 'p-aarav', name: 'Aarav Shah', seed: 2, phone: '9820022222', ign: 'AaravX' },
      { id: 'p-zed', name: 'Zed Stale', seed: 3 },
    ];
    assert.equal((await cmd(hq, { type: 'players.set', base: await version(), players })).status, 200);
    assert.equal((await batch(hq, [{ k: 'stores', id: 's1', p: ['day', 'checkIn', 'p-asha'], v: '2026-10-24T06:40:00.000Z' }])).status, 200);
  };
  const walkIn = async () => {
    const r = await cmd(admin, { type: 'players.onspot', base: 0, name: 'Walk Inn', phone: '9820033333' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  return { t, hq, admin, clock, toornament, store, version, tick, cmd, batch, roster, walkIn, close: () => t.close() };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const statusOf = async (s: Setup) => (await s.store()).toornament?.auto;
const inBracket = (store: Store) => new Set(store.day.matches.flatMap((m) => [m.a, m.b]).filter(Boolean) as string[]);

/* ---------- when ---------- */

test('auto-check: nothing before 12:30 India time; at 12:30 the first look; then every 5 minutes', async () => {
  const s = await setup({ at: ist('12:29') });
  try {
    s.toornament.state.variant = 'none';
    await s.tick();
    assert.equal(s.toornament.state.calls, 0, '12:29: too early');
    assert.equal((await s.store()).toornament?.auto, undefined, 'and nothing recorded');

    s.clock.at = ist('12:30');
    await s.tick();
    assert.equal(s.toornament.state.calls, 1);
    const a = (await statusOf(s))!;
    assert.equal(a.lastResult, 'waiting');
    assert.equal(a.lastCheckAt, ist('12:30').toISOString());
    assert.equal(a.enabled, true);
    assert.match(a.message!, /No bracket on Toornament yet/);

    for (const hm of ['12:31', '12:34']) {
      s.clock.at = ist(hm);
      await s.tick();
    }
    assert.equal(s.toornament.state.calls, 1, 'not before 5 minutes are up');
    s.clock.at = ist('12:35');
    await s.tick();
    assert.equal(s.toornament.state.calls, 2);
    s.clock.at = ist('12:40');
    await s.tick();
    assert.equal(s.toornament.state.calls, 3);
    assert.equal((await statusOf(s))!.lastCheckAt, ist('12:40').toISOString());
  } finally {
    await s.close();
  }
});

test('auto-check: only on the store’s own day — other days, and the campaign’s date when the store has none', async () => {
  const s = await setup({ at: ist('13:00', '2026-10-23') });
  try {
    await s.tick();
    s.clock.at = ist('13:00', '2026-10-25');
    await s.tick();
    assert.equal(s.toornament.state.calls, 0, 'the day before / after');
    // 23:30 on the day still counts, 00:05 the next day doesn't.
    s.clock.at = ist('23:30');
    await s.tick();
    assert.equal(s.toornament.state.calls, 1, 'until the day ends');
    s.clock.at = ist('00:05', '2026-10-25');
    await s.tick();
    assert.equal(s.toornament.state.calls, 1);
  } finally {
    await s.close();
  }
  const own = await setup({ at: ist('13:00', '2026-10-25'), storeOver: { date: '2026-10-25' } });
  try {
    await own.tick();
    assert.equal(own.toornament.state.calls, 1, 'the store’s own date wins over the campaign’s');
  } finally {
    await own.close();
  }
});

test('auto-check: the campaign can move the start time; a store without a link, or switched off, is left alone', async () => {
  const s = await setup({ at: ist('12:45'), eventOver: { toornamentAuto: { from: '13:15' } } });
  try {
    await s.tick();
    assert.equal(s.toornament.state.calls, 0, 'campaign says 13:15');
    s.clock.at = ist('13:15');
    await s.tick();
    assert.equal(s.toornament.state.calls, 1);

    // Switched off (HQ's toggle): nothing more, and the record keeps saying so.
    assert.equal((await s.batch(s.hq, [{ k: 'stores', id: 's1', p: ['toornament', 'auto'], v: { enabled: false } }])).status, 200);
    s.clock.at = ist('14:00');
    await s.tick();
    assert.equal(s.toornament.state.calls, 1);
    // No link at all.
    assert.equal((await s.batch(s.hq, [{ k: 'stores', id: 's1', p: ['toornament'], d: 1 }])).status, 200);
    await s.tick();
    assert.equal(s.toornament.state.calls, 1);
  } finally {
    await s.close();
  }
});

test('auto-check: a bad start time is refused by the campaign’s schema', () => {
  const ev = (from: unknown) => validateDocument('events', fixtureEvent('e1', { toornamentAuto: { from } }));
  assert.deepEqual(ev('12:30'), []);
  assert.deepEqual(ev('00:00'), []);
  for (const bad of ['24:00', '12:60', '1230', '9:30', '', 5, null]) assert.match(ev(bad).join('|'), /toornamentAuto\.from/, String(bad));
});

/* ---------- what counts, and applying it ---------- */

test('auto-check: waits while there is no bracket or nobody is placed, then loads it once and stops', async () => {
  const s = await setup({ at: ist('12:30') });
  try {
    await s.roster();
    await s.walkIn();
    const before = await s.version();

    s.toornament.state.variant = 'none';
    await s.tick();
    assert.equal((await statusOf(s))!.lastResult, 'waiting');

    s.clock.at = ist('12:35');
    s.toornament.state.variant = 'unplaced';
    await s.tick();
    let a = (await statusOf(s))!;
    assert.equal(a.lastResult, 'not-placed');
    assert.match(a.message!, /players aren’t placed/);
    assert.equal(await s.version(), before, 'nothing loaded while waiting');
    assert.equal((await s.store()).day.matches.length, 0);

    s.clock.at = ist('12:40');
    s.toornament.state.variant = 'placed';
    await s.tick();
    a = (await statusOf(s))!;
    assert.equal(a.lastResult, 'applied');
    assert.equal(a.appliedAt, ist('12:40').toISOString());
    assert.match(a.message!, /7 players placed/);
    const st = await s.store();
    assert.equal(st.day.version, before + 1, 'one bracket.load');
    assert.equal(st.day.matches.filter((m) => m.round === 0).length, 4, 'Toornament’s first round: four matches');
    // Every Field Desk match is the Toornament match at its position (all seven of the stage's), by id and "stage.group.round.match" label.
    assert.equal(st.day.matches.filter((m) => m.toornament).length, 7);
    assert.match(st.day.matches.find((m) => m.round === 2 && m.index === 0)!.toornament!.label, /^1\.1\.3\.1$/);
    assert.ok(st.day.matches.filter((m) => m.round === 0).every((m) => /^1\.1\.1\.[1-4]$/.test(m.toornament!.label)));
    assert.equal(st.toornament!.by, 'system:toornament');
    assert.equal(st.toornament!.appliedAt, ist('12:40').toISOString());
    assert.equal(st.toornament!.stageName, 'Playoffs');
    assert.equal(st.toornament!.tournamentName, 'Synthetic Cup — 8 slots', 'the name the result jobs expect');
    assert.ok(st.day.players.filter((p) => !p.id.startsWith('os-')).every((p) => /^\d+$/.test(p.toornamentId ?? '')), 'every player carries Toornament’s participant id');
    assert.equal(bracketOrigin(st), 'toornament');
    assert.ok(autoFinished(st, ist('12:41')));

    // Stopped: no more looks, today.
    const calls = s.toornament.state.calls;
    for (const hm of ['12:45', '13:00', '15:00']) {
      s.clock.at = ist(hm);
      await s.tick();
    }
    assert.equal(s.toornament.state.calls, calls);
    assert.equal(await s.version(), before + 1);
  } finally {
    await s.close();
  }
});

test('auto-check: matched players keep phone, in-game name and check-in; walk-ins not on Toornament stay on the list outside the bracket', async () => {
  const s = await setup({ at: ist('12:30') });
  try {
    await s.roster();
    await s.walkIn();
    await s.tick();
    const st = await s.store();
    assert.equal((await statusOf(s))!.lastResult, 'applied');
    const byName = new Map(st.day.players.map((p) => [p.name, p]));
    const asha = byName.get('Asha Rao')!;
    assert.equal(asha.id, 'p-asha');
    assert.equal(asha.phone, '9820011111');
    assert.ok(st.day.checkIn['p-asha'], 'check-in kept');
    assert.equal(byName.get('Aarav Shah')!.ign, 'AaravX');
    assert.equal(byName.get('Diya Patel')!.phone, undefined, 'new from Toornament: no phone');
    assert.equal(byName.has('Zed Stale'), false, 'on the list but not on Toornament, not a walk-in: removed, as HQ’s button does');
    const walk = byName.get('Walk Inn')!;
    assert.ok(walk, 'the walk-in is still on the list');
    assert.ok(st.day.checkIn[walk.id], 'still checked in');
    assert.equal(walk.seed, st.day.players.length, 'after the bracket’s players');
    assert.equal(inBracket(st).has(walk.id), false, 'and in no pairing');
    assert.equal(inBracket(st).size, 7);
    assert.match((await statusOf(s))!.message!, /1 walk-in not on Toornament yet stays on the list, outside the bracket/);
    assert.match((await statusOf(s))!.message!, /1 on the list but not on Toornament was removed/);
    assert.equal(st.day.onSpot!.length, 1, 'the registration itself is untouched');
  } finally {
    await s.close();
  }
});

test('auto-check: the load is a normal command — one seq, broadcast to HQ’s stream, same result as HQ pressing the button', async () => {
  const s = await setup({ at: ist('12:30') });
  try {
    await s.roster();
    const res = await fetch(`${s.t.base}/api/stream`, { headers: { Cookie: s.hq } });
    const reader = res.body!.getReader();
    const seen: string[] = [];
    let buf = '';
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        const parts = buf.split('\n\n');
        buf = parts.pop()!;
        for (const p of parts) if (p.startsWith('data: ')) seen.push(p.slice(6));
      }
    })();
    const seq0 = (await s.t.json('/api/me', { cookie: s.hq })).body.seq;
    await s.tick();
    await new Promise((r) => setTimeout(r, 50));
    const seq1 = (await s.t.json('/api/me', { cookie: s.hq })).body.seq;
    assert.equal(seq1, seq0 + 1, 'the bracket and its record are one commit');
    const msg = seen.map((x) => JSON.parse(x)).find((m) => m.seq === seq1);
    assert.ok(msg && /^ta-[0-9a-f]{24}$/.test(msg.id), JSON.stringify(msg));
    assert.ok(msg.ops.some((o: any) => o.p[0] === 'day' && o.p[1] === 'matches'), 'HQ’s screen is told about the matches');
    assert.ok(msg.ops.some((o: any) => o.p[0] === 'toornament'), 'and about the record');
    await reader.cancel();
    await pump.catch(() => {});

    // The same plan HQ's "Use this bracket" builds → same bracket shape.
    const st = await s.store();
    assert.deepEqual(st.day.matches.filter((m) => m.round === 0).map((m) => [m.a ? 1 : 0, m.b ? 1 : 0]), [[1, 0], [1, 1], [1, 1], [1, 1]]);
    assert.ok(st.day.matches.find((m) => m.bye), 'the bye comes across as a bye');
  } finally {
    await s.close();
  }
});

test('auto-check: never replaces a bracket that is under way, nor one built by hand', async () => {
  const s = await setup({ at: ist('12:30') });
  try {
    await s.roster();
    // Built by hand (bracket.build): left alone, and that ends today's checking.
    assert.equal((await s.cmd(s.hq, { type: 'bracket.build', base: await s.version() })).status, 200);
    const before = await s.store();
    await s.tick();
    let a = (await statusOf(s))!;
    assert.equal(a.lastResult, 'skipped-manual');
    assert.match(a.message!, /by hand/);
    assert.equal(s.toornament.state.calls, 0, 'no need to even ask Toornament');
    assert.deepEqual((await s.store()).day.matches, before.day.matches);
    s.clock.at = ist('12:40');
    await s.tick();
    assert.equal(s.toornament.state.calls, 0, 'stopped for the day');

    // "Check again" (HQ writes {enabled:true}) with a match under way → skipped-underway.
    const live = (await s.store()).day.matches.find((m) => !m.bye && m.a && m.b)!;
    assert.equal((await s.batch(s.hq, [{ k: 'stores', id: 's1', p: ['day', 'checkIn', live.a!], v: '2026-10-24T07:00:00.000Z' }, { k: 'stores', id: 's1', p: ['day', 'checkIn', live.b!], v: '2026-10-24T07:00:00.000Z' }])).status, 200);
    assert.equal((await s.cmd(s.hq, { type: 'match.start', base: 0, matchId: live.id, station: 1 })).status, 200);
    assert.equal((await s.batch(s.hq, [{ k: 'stores', id: 's1', p: ['toornament', 'auto'], v: { enabled: true } }])).status, 200);
    assert.equal((await statusOf(s))!.lastResult, undefined, 'cleared');
    s.clock.at = ist('12:45');
    await s.tick();
    a = (await statusOf(s))!;
    assert.equal(a.lastResult, 'skipped-underway');
    assert.match(a.message!, /under way/);
    assert.equal(s.toornament.state.calls, 0);
    assert.deepEqual((await s.store()).day.matches.map((m) => m.id), before.day.matches.map((m) => m.id), 'the bracket is untouched');
  } finally {
    await s.close();
  }
});

test('auto-check: a bracket an earlier Toornament load built, not started, may be replaced; once started it may not', async () => {
  const s = await setup({ at: ist('12:30') });
  try {
    await s.roster();
    s.toornament.state.by.set(SE8, 'placed');
    await s.tick();
    const first = await s.store();
    assert.equal((await statusOf(s))!.lastResult, 'applied');

    // HQ presses "Check again"; Toornament now shows a different tournament's bracket (same link, new draw).
    s.toornament.state.by.set(SE8, 'placed');
    s.clock.at = ist('12:50');
    assert.equal((await s.batch(s.hq, [{ k: 'stores', id: 's1', p: ['toornament', 'url'], v: link(SE7) }, { k: 'stores', id: 's1', p: ['toornament', 'auto'], v: { enabled: true } }])).status, 200);
    await s.tick();
    const second = await s.store();
    assert.equal((await statusOf(s))!.lastResult, 'applied');
    assert.notEqual(second.toornament!.loadId, first.toornament!.loadId, 'a new load replaced the old one');
    assert.equal(second.day.version, (first.day.version ?? 0) + 1);
    assert.ok(second.day.players.some((p) => p.name === 'Meera Iyer'), 'SE7’s players');

    // Now play: no replacing.
    const m = second.day.matches.find((x) => !x.bye && x.a && x.b)!;
    assert.equal((await s.batch(s.hq, [{ k: 'stores', id: 's1', p: ['day', 'checkIn', m.a!], v: '2026-10-24T07:30:00.000Z' }, { k: 'stores', id: 's1', p: ['day', 'checkIn', m.b!], v: '2026-10-24T07:30:00.000Z' }])).status, 200);
    assert.equal((await s.cmd(s.hq, { type: 'match.start', base: 0, matchId: m.id, station: 1 })).status, 200);
    assert.equal((await s.batch(s.hq, [{ k: 'stores', id: 's1', p: ['toornament', 'auto'], v: { enabled: true } }])).status, 200);
    s.clock.at = ist('13:00');
    await s.tick();
    assert.equal((await statusOf(s))!.lastResult, 'skipped-underway');
  } finally {
    await s.close();
  }
});

test('auto-check: HQ already pressed "Use this bracket" today → nothing more to do, no second load', async () => {
  const s = await setup({ at: ist('12:30') });
  try {
    await s.roster();
    // What HQ's button does: bracket.load under a command id, then records that id on the store.
    const id = 'hq-use-0001';
    const r = await s.t.json('/api/command', { method: 'POST', cookie: s.hq, body: { id, storeId: 's1', cmd: { type: 'bracket.load', base: await s.version(), players: [{ id: 'p-asha', name: 'Asha Rao', seed: 1 }, { id: 'p-aarav', name: 'Aarav Shah', seed: 2 }], pairs: [['p-asha', 'p-aarav']] } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await s.batch(s.hq, [{ k: 'stores', id: 's1', p: ['toornament', 'loadId'], v: id }, { k: 'stores', id: 's1', p: ['toornament', 'appliedAt'], v: ist('12:20').toISOString() }, { k: 'stores', id: 's1', p: ['toornament', 'by'], v: 'super' }])).status, 200);
    assert.equal(bracketOrigin(await s.store()), 'toornament');
    const v = await s.version();
    await s.tick();
    const a = (await statusOf(s))!;
    assert.equal(a.lastResult, 'applied');
    assert.match(a.message!, /HQ already loaded/);
    assert.equal(s.toornament.state.calls, 0);
    assert.equal(await s.version(), v, 'the bracket is as HQ left it');
    assert.match(autoLine(await s.store(), fixtureEvent('e1') as TournamentEvent, ist('12:31')).text, /^Loaded by HQ at 12:20 ✓/);
  } finally {
    await s.close();
  }
});

test('auto-check: a stage that cannot be used, or a Toornament that is down, is an error that is tried again in 5 minutes', async () => {
  const s = await setup({ at: ist('12:30'), storeOver: { toornament: { url: link(DE) } } });
  try {
    await s.tick();
    const a = (await statusOf(s))!;
    assert.equal(a.lastResult, 'error');
    assert.match(a.message!, /double elimination.*only single elimination/i);
    s.clock.at = ist('12:35');
    s.toornament.state.fail = new RosterFetchError(502, 'upstream', 'Toornament: The site took too long to answer.');
    await s.tick();
    assert.equal(s.toornament.state.calls, 2);
    assert.match((await statusOf(s))!.message!, /took too long/);
    s.clock.at = ist('12:40');
    s.toornament.state.fail = new Error('boom with a secret');
    await s.tick();
    assert.equal((await statusOf(s))!.lastResult, 'error');
    assert.doesNotMatch((await statusOf(s))!.message!, /secret/, 'unexpected errors are not shown to HQ');
    assert.equal(s.toornament.state.calls, 3);
  } finally {
    await s.close();
  }
});

test('auto-check: a 429 pauses every store for a while, longer each time', async () => {
  const s = await setup({ at: ist('12:30') });
  try {
    s.toornament.state.fail = new RosterFetchError(502, 'upstream', 'Toornament: The site answered 429.', { status: 429 });
    await s.tick();
    assert.equal(s.toornament.state.calls, 1);
    assert.match((await statusOf(s))!.message!, /slow down/);
    s.clock.at = ist('12:35');
    await s.tick();
    assert.equal(s.toornament.state.calls, 1, 'paused for 10 minutes');
    s.clock.at = ist('12:40');
    s.toornament.state.fail = new RosterFetchError(502, 'upstream', 'Toornament: The site answered 429.', { status: 429 });
    await s.tick();
    assert.equal(s.toornament.state.calls, 2);
    s.clock.at = ist('12:55');
    await s.tick();
    assert.equal(s.toornament.state.calls, 2, 'paused for 20 minutes this time');
    s.clock.at = ist('13:00');
    s.toornament.state.fail = undefined;
    await s.tick();
    assert.equal(s.toornament.state.calls, 3);
    assert.equal((await statusOf(s))!.lastResult, 'applied');
  } finally {
    await s.close();
  }
});

test('auto-check: one store at a time, each with its own link; a failure at one does not stop the next', async () => {
  const s = await setup({ at: ist('12:30') });
  try {
    // A second store on SE7 and a third on a tournament that 404s.
    const put = (id: string, tid: string) => s.t.json('/api/batch', { method: 'POST', cookie: s.hq, body: { id: `more-${id}-0001`, ops: [{ k: 'stores', id, p: [], v: fixtureStore(id, 'e1', 'a1', { toornament: { url: link(tid) } }) }] } });
    assert.equal((await put('s3', SE7)).status, 200);
    assert.equal((await put('s4', '424242')).status, 200);
    s.toornament.state.delayMs = 15;
    await s.tick();
    assert.equal(s.toornament.state.maxActive, 1, 'never two fetches at once');
    assert.equal(s.toornament.state.calls, 3);
    const states = (await s.t.json('/api/state', { cookie: s.hq })).body.stores;
    assert.equal(states.s1.toornament.auto.lastResult, 'applied');
    assert.equal(states.s3.toornament.auto.lastResult, 'applied');
    assert.equal(states.s4.toornament.auto.lastResult, 'error', 'the unknown tournament: its fixture is missing → fake throws');
  } finally {
    await s.close();
  }
});

/* ---------- who can write what ---------- */

test('auto-check: the record is HQ-only — a field admin’s batch is refused; HQ’s toggle and the campaign start time work', async () => {
  const s = await setup({ at: ist('12:30') });
  try {
    await s.tick(); // a record exists now
    for (const p of [['toornament', 'auto'], ['toornament', 'auto', 'enabled'], ['toornament', 'auto', 'lastResult'], ['toornament', 'loadId'], ['toornament']]) {
      const r = await s.batch(s.admin, [{ k: 'stores', id: 's1', p, v: p.length === 2 && p[1] === 'auto' ? { enabled: false } : p.length === 1 ? { url: link(SE8) } : 'applied' }]);
      assert.equal(r.status, 403, p.join('.'));
      assert.equal(r.body.code, 'forbidden');
    }
    const ev = await s.t.json('/api/batch', { method: 'POST', cookie: s.admin, body: { id: 'admin-event-0001', ops: [{ k: 'events', id: 'e1', p: ['toornamentAuto'], v: { from: '10:00' } }] } });
    assert.equal(ev.status, 403);
    // The admin sees the status line (it carries no link), HQ can change it.
    const seen = (await s.store(s.admin)).toornament;
    assert.ok(seen?.auto?.lastCheckAt);
    assert.equal((await s.batch(s.hq, [{ k: 'stores', id: 's1', p: ['toornament', 'auto', 'enabled'], v: false }])).status, 200);
    assert.equal((await s.batch(s.hq, [{ k: 'events', id: 'e1', p: ['toornamentAuto'], v: { from: '10:00' } }])).status, 200, 'HQ sets the campaign’s start time');
    assert.equal((await s.batch(s.hq, [{ k: 'events', id: 'e1', p: ['toornamentAuto'], v: { from: '25:00' } }])).status, 400);
  } finally {
    await s.close();
  }
});

test('auto-check: bad values in the record are refused by the schema', () => {
  const store = (auto: unknown, extra: Record<string, unknown> = {}) => ({ ...fixtureStore('s1', 'e1', null), toornament: { url: link(SE8), auto, ...extra } });
  const probs = (auto: unknown, extra?: Record<string, unknown>) => validateDocument('stores', store(auto, extra)).join(' | ');
  assert.equal(probs({ enabled: true, lastCheckAt: '2026-10-24T07:00:00.000Z', lastResult: 'waiting', message: 'No bracket on Toornament yet.' }), '');
  assert.equal(probs({ enabled: false }), '');
  assert.match(probs({}), /auto\.enabled/);
  assert.match(probs({ enabled: 'yes' }), /auto\.enabled/);
  assert.match(probs({ enabled: true, lastResult: 'done' }), /auto\.lastResult/);
  assert.match(probs({ enabled: true, lastCheckAt: 'yesterday' }), /auto\.lastCheckAt/);
  assert.match(probs({ enabled: true, message: 'x'.repeat(401) }), /auto\.message/);
  assert.match(probs({ enabled: true }, { loadId: 5 }), /toornament\.loadId/);
});

test('auto-check: changing the store’s link starts over, but a switched-off check stays off', () => {
  const s = { toornament: { url: link(SE8), loadId: 'x', auto: { enabled: true, lastResult: 'applied' } } } as unknown as Store;
  applyToornamentLink(s, link(SE7));
  assert.deepEqual(s.toornament, { url: link(SE7) });
  s.toornament!.auto = { enabled: false, lastResult: 'waiting' };
  applyToornamentLink(s, link(SE8));
  assert.deepEqual(s.toornament, { url: link(SE8), auto: { enabled: false } });
});

/* ---------- the timer, logs ---------- */

test('auto-check: off unless asked for; when on, the timer runs the check by itself and close() stops it', async () => {
  const off = await setup({ at: ist('12:30'), auto: { tickMs: 10 } });
  try {
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(off.toornament.state.calls, 0, 'createApi without enabled: no timer');
  } finally {
    await off.close();
  }
  const on = await setup({ at: ist('12:30'), auto: { tickMs: 10, enabled: true } });
  try {
    for (let i = 0; i < 100 && !on.toornament.state.calls; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(on.toornament.state.calls >= 1, 'the timer ticked');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await statusOf(on))!.lastResult, 'applied');
    assert.equal(on.toornament.state.calls, 1, 'and stopped asking once it had the bracket');
  } finally {
    await on.close();
  }
});

test('auto-check: logs one short line per check — never the Toornament link', async () => {
  const lines: string[] = [];
  const s = await setup({ at: ist('12:30'), log: (level, event, fields) => void lines.push(JSON.stringify({ level, event, ...fields })) });
  try {
    s.toornament.state.variant = 'none';
    await s.tick();
    s.clock.at = ist('12:35');
    s.toornament.state.variant = 'placed';
    await s.tick();
    const mine = lines.filter((l) => l.includes('"toornament-auto"'));
    assert.ok(mine.length >= 2, lines.join('\n'));
    assert.match(mine[0], /"result":"waiting"/);
    assert.ok(mine.some((l) => /"result":"applied"/.test(l)));
    assert.ok(!lines.some((l) => /toornament\.com|\/tournaments\//.test(l)), 'no links in the logs');
  } finally {
    await s.close();
  }
});

/* ---------- the pure rules ---------- */

test('rules: India time, the window, due-ness and the stop-for-the-day marker', () => {
  assert.deepEqual(inZone(new Date('2026-10-24T07:00:00Z')), { date: '2026-10-24', hm: '12:30', minutes: 750 });
  assert.equal(inZone(new Date('2026-10-23T18:30:00Z')).date, '2026-10-24', 'midnight in India is 18:30 UTC the day before');
  assert.equal(inZone(new Date('2026-10-23T18:30:00Z')).hm, '00:00');
  const event = fixtureEvent('e1') as unknown as TournamentEvent;
  const store = fixtureStore('s1', 'e1', null, { toornament: { url: link(SE8) } }) as unknown as Store;
  assert.equal(autoWindow(store, event, ist('12:29')), 'before');
  assert.equal(autoWindow(store, event, ist('12:30')), 'open');
  assert.equal(autoWindow(store, event, ist('23:59')), 'open');
  assert.equal(autoWindow(store, event, ist('12:30', '2026-10-23')), 'future');
  assert.equal(autoWindow(store, event, ist('12:30', '2026-10-25')), 'past');
  assert.equal(autoWindow({ ...store, toornament: undefined }, event, ist('13:00')), 'off');
  assert.equal(autoWindow({ ...store, toornament: { url: link(SE8), auto: { enabled: false } } }, event, ist('13:00')), 'off');
  assert.equal(autoWindow(store, { ...event, toornamentAuto: { from: '14:00' } }, ist('13:59')), 'before');
  assert.equal(autoWindow(store, { ...event, toornamentAuto: { from: 'nonsense' } }, ist('12:30')), 'open', 'a bad value falls back to 12:30');

  assert.equal(autoDue(store, event, ist('12:30')), true);
  const checked = { ...store, toornament: { url: link(SE8), auto: { enabled: true, lastCheckAt: ist('12:30').toISOString(), lastResult: 'waiting' as const } } };
  assert.equal(autoDue(checked, event, ist('12:34')), false);
  assert.equal(autoDue(checked, event, new Date(ist('12:35').getTime() - 2000)), true, 'a few seconds of timer jitter are forgiven');
  const applied = { ...checked, toornament: { ...checked.toornament, auto: { ...checked.toornament.auto, lastResult: 'applied' as const } } };
  assert.equal(autoDue(applied, event, ist('13:00')), false);
  assert.equal(autoFinished(applied, ist('23:00')), true);
  assert.equal(autoFinished(applied, ist('00:10', '2026-10-25')), false, 'a new day starts clean');
});

test('rules: what counts as the bracket being there', () => {
  const ready = (tid: string, nodes?: (items: any[]) => any[]) => {
    const f = FIXTURES.get(tid)!;
    const stages = readStages(f.stages);
    const stage = pickStage(stages);
    const participants = readParticipants(f.participants);
    const items = f.nodes ? (nodes ? nodes(f.nodes.items) : f.nodes.items) : [];
    return bracketReady({ link: { tournamentId: tid }, tournament: readTournament(f.tournament), stages, stage, participants, participantsTotal: participants.length, bracket: stage?.supported ? bracketFromNodes(items, participants, stage) : null, fetchedAt: '' });
  };
  const ok = ready(SE8);
  assert.ok(ok.ok);
  assert.equal((ok as any).bracket.mode, 'pairs');
  assert.equal(ready(SE8, () => []).ok, false);
  assert.equal((ready(SE8, () => []) as any).result, 'waiting');
  assert.equal((ready(MULTI) as any).result, 'not-placed', 'a bracket, nobody placed');
  assert.equal((ready(DE) as any).result, 'error');
  assert.match((ready(DE) as any).message, /Double elimination/i);
  const twelve = ready('1146602957085786112');
  assert.equal(twelve.ok, false, 'a stage with an empty first-round match is not usable');
  assert.equal((twelve as any).result, 'not-placed');
  assert.match((twelve as any).message, /nobody in it/);
});

test('rules: the status line HQ reads', () => {
  const event = fixtureEvent('e1') as unknown as TournamentEvent;
  const base = fixtureStore('s1', 'e1', null) as unknown as Store;
  const line = (t: Store['toornament'], at = ist('12:00')) => autoLine({ ...base, toornament: t }, event, at);
  assert.match(line(undefined).text, /add the Toornament link/);
  assert.equal(line({ url: link(SE8), auto: { enabled: false } }).on, false);
  assert.equal(line({ url: link(SE8), auto: { enabled: false } }).text, 'Auto-check: off — the bracket is fetched by hand');
  assert.equal(line({ url: link(SE8) }).text, 'Auto-check: on — from 12:30 on 24 Oct, every 5 min');
  assert.equal(
    line({ url: link(SE8), auto: { enabled: true, lastCheckAt: ist('12:45').toISOString(), lastResult: 'waiting' } }, ist('12:46')).text,
    'Auto-check: on — from 12:30 on 24 Oct, every 5 min · last checked 12:45: no bracket on Toornament yet',
  );
  assert.equal(
    line({ url: link(SE8), auto: { enabled: true, lastCheckAt: ist('12:50').toISOString(), lastResult: 'applied', appliedAt: ist('12:50').toISOString() }, by: 'system:toornament' }, ist('13:00')).text,
    'Applied automatically at 12:50 ✓',
  );
  const stopped = line({ url: link(SE8), auto: { enabled: true, lastCheckAt: ist('12:50').toISOString(), lastResult: 'skipped-underway', message: 'Matches are already under way, so the bracket was left alone.' } }, ist('13:00'));
  assert.equal(stopped.tone, 'warn');
  assert.match(stopped.text, /^Auto-check stopped at 12:50: Matches are already under way/);
  assert.equal(line({ url: link(SE8), auto: { enabled: true, lastCheckAt: ist('12:50').toISOString(), lastResult: 'error' } }, ist('12:52')).tone, 'warn');
  assert.match(line({ url: link(SE8) }, ist('12:00', '2026-10-26')).text, /has passed/);
});

test('rules: the test server runs fine without the option, and SUPER stays a real session', async () => {
  const t: TestServer = await startTestServer();
  try {
    assert.equal(typeof t.api.toornamentAuto.tick, 'function');
    await t.api.toornamentAuto.tick(); // no stores: nothing happens
    assert.equal((await t.json('/api/me', { cookie: await t.login(SUPER) })).body.role, 'super');
  } finally {
    await t.close();
  }
});
