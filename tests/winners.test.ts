/*
 * winners.set — the real handler via applyCommand over in-memory stores: only after the final,
 * ids come from the final, field cleaning, re-saves, and the bracket commands that must leave
 * the saved details alone. Plus the pure helpers (instagram / email parsing, winnersState).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, CommandError, dayVersion, validateCommand, type Command, type CommandContext } from '../src/lib/commands.ts';
import { cleanWinnerInput, detailsComplete, missingFields, parseEmail, parseInstagram, winnersState } from '../src/lib/winnerInput.ts';
import { validateDocument } from '../src/lib/schema.ts';
import type { Player, Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureStore } from './helpers/server.ts';

const event: TournamentEvent = { id: 'e1', name: 'Test Cup', date: '2026-10-23', games: [], collateral: [], gameReadyTarget: 0, minDownMbps: 0, createdAt: '2026-10-01T00:00:00.000Z' };
let seq = 0;
const ctx = (role: 'super' | 'admin' = 'admin', name = 'Rhea'): CommandContext => ({
  commandId: `w${++seq}`,
  now: new Date(Date.UTC(2026, 9, 23, 10, 0, seq)).toISOString(),
  actor: { principal: role === 'super' ? 'super' : 'a1', name, role },
  event,
});
const run = (s: Store, cmd: Command, c = ctx()) => applyCommand(s, cmd, c);
const hq = (s: Store, cmd: Command) => run(s, cmd, ctx('super', 'HQ'));
const players = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, seed: i + 1, ...(i === 0 ? { phone: '9820011111', ign: 'One' } : {}) }));

/** A 4-player bracket, everyone checked in. */
function loaded(): Store {
  const s = fixtureStore('s1', 'e1', 'a1') as unknown as Store;
  const l = hq(s, { type: 'bracket.load', base: 0, players: players(4), stations: 2 });
  return { ...l, day: { ...l.day, checkIn: Object.fromEntries(l.day.players.map((p) => [p.id, '2026-10-23T09:00:00.000Z'])) } };
}
const play = (s: Store, round: number, index: number, winner: string): Store => {
  const m = s.day.matches.find((x) => x.round === round && x.index === index)!;
  const started = run(s, { type: 'match.start', base: 0, matchId: m.id, station: 1 });
  return run(started, { type: 'match.finish', base: 0, matchId: m.id, winner });
};
/** Seeds 1v4 and 2v3 → p1 and p2 meet in the final; p1 wins. */
function finished(): Store {
  let s = loaded();
  s = play(s, 0, 0, 'p1');
  s = play(s, 0, 1, 'p2');
  return play(s, 1, 0, 'p1');
}

const win = { realName: ' Asha   Rao ', ign: 'AshaX', phone: '+91 98200 11111', email: 'Asha@Example.COM', instagram: '@Asha.Rao' };
const runnerUp = { realName: 'Bilal Khan' };
const set = (s: Store, over: Record<string, unknown> = {}, c = ctx()) => run(s, { type: 'winners.set', base: 0, winner: win, runnerUp, ...over } as Command, c);

function rejects(fn: () => unknown, code: 'conflict' | 'invalid' | 'forbidden', msg?: RegExp) {
  assert.throws(fn, (e: unknown) => e instanceof CommandError && e.code === code && (!msg || msg.test(e.message)), `expected ${code} ${msg ?? ''}`);
}

test('refused until the final has a winner — no bracket, mid-bracket, final live', () => {
  rejects(() => set(fixtureStore('s1', 'e1', 'a1') as unknown as Store), 'conflict', /Record the final first/);
  let s = loaded();
  rejects(() => set(s), 'conflict', /Record the final first/);
  s = play(s, 0, 0, 'p1');
  s = play(s, 0, 1, 'p2');
  rejects(() => set(s), 'conflict', /Record the final first/);
  const fin = s.day.matches.find((x) => x.round === 1)!;
  s = run(s, { type: 'match.start', base: 0, matchId: fin.id, station: 1 });
  rejects(() => set(s), 'conflict', /Record the final first/);
});

test('the ids come from the final — a sneaked playerId is ignored — and the fields are cleaned', () => {
  const s = finished();
  const out = set(s, { winner: { ...win, playerId: 'p4' }, runnerUp: { ...runnerUp, playerId: 'p3' } });
  const w = out.day.winners!;
  assert.equal(w.winner.playerId, 'p1');
  assert.equal(w.runnerUp.playerId, 'p2');
  assert.equal(w.finalMatchId, s.day.matches.find((x) => x.round === 1)!.id);
  assert.deepEqual(w.winner, { playerId: 'p1', realName: 'Asha Rao', ign: 'AshaX', phone: '9820011111', email: 'asha@example.com', instagram: 'asha.rao' });
  assert.deepEqual(w.runnerUp, { playerId: 'p2', realName: 'Bilal Khan' });
  assert.equal(w.by, 'Rhea');
  assert.equal(out.day.version, dayVersion(s) + 1);
  assert.deepEqual(validateDocument('stores', out, { events: { e1: event } }), []);
});

test('saving again updates: "at" stays from the first save, updatedAt and by move on; the details are replaced', () => {
  const first = set(finished(), {}, ctx('admin', 'Rhea'));
  const second = run(first, { type: 'winners.set', base: 0, winner: { realName: 'Asha Rao' }, runnerUp: { realName: 'Bilal K.', email: 'b@x.in' } }, ctx('super', 'HQ'));
  const a = first.day.winners!;
  const b = second.day.winners!;
  assert.equal(b.at, a.at);
  assert.ok(b.updatedAt > a.updatedAt);
  assert.equal(b.by, 'HQ');
  assert.deepEqual(b.winner, { playerId: 'p1', realName: 'Asha Rao' }, 'a field left empty is cleared');
  assert.equal(b.runnerUp.email, 'b@x.in');
});

test('an empty name is allowed (not given yet); invalid fields are refused with a plain, per-field message', () => {
  const s = finished();
  const out = set(s, { winner: { realName: '' }, runnerUp: { realName: '' } });
  assert.equal(out.day.winners!.winner.realName, '');
  rejects(() => set(s, { winner: { ...win, email: 'asha@' } }), 'invalid', /^Winner’s email doesn’t look right/);
  rejects(() => set(s, { runnerUp: { realName: 'B', email: 'no at sign.com' } }), 'invalid', /^Runner-up’s email doesn’t look right/);
  rejects(() => set(s, { winner: { ...win, instagram: 'not a handle!' } }), 'invalid', /^Winner’s Instagram/);
  rejects(() => set(s, { winner: { ...win, instagram: 'a'.repeat(31) } }), 'invalid', /Instagram/);
  rejects(() => set(s, { runnerUp: { realName: 'B', phone: '12' } }), 'invalid', /^Runner-up’s phone number/);
  rejects(() => set(s, { winner: { ...win, realName: 'x'.repeat(101) } }), 'invalid', /name is longer than 100/);
  rejects(() => set(s, { winner: { ...win, ign: 'x'.repeat(41) } }), 'invalid', /in-game name is longer/);
  rejects(() => set(s, { winner: { ...win, email: `${'a'.repeat(200)}@x.co` } }), 'invalid', /email/);
  rejects(() => set(s, { winner: { ...win, realName: 5 } }), 'invalid', /should be text/);
  rejects(() => set(s, { winner: null }), 'invalid', /details are missing/);
});

test('instagram: @handle, handle and instagram.com URLs all become the bare handle', () => {
  for (const [raw, handle] of [['@asha_r', 'asha_r'], ['asha.r', 'asha.r'], ['https://www.instagram.com/Asha_R/', 'asha_r'], ['instagram.com/asha_r?igsh=abc', 'asha_r'], ['http://instagram.com/asha_r/#x', 'asha_r'], ['  @@asha  ', 'asha'], ['', '']] as const)
    assert.equal(parseInstagram(raw), handle, raw);
  for (const raw of ['two words', 'asha-r', 'https://facebook.com/asha', 'https://www.instagram.com/', 'a'.repeat(31), 'ash@a']) assert.equal(parseInstagram(raw), null, raw);
  assert.equal(parseEmail(' A@B.co '), 'a@b.co');
  assert.equal(parseEmail(''), '');
  for (const raw of ['a@b', '@b.co', 'a b@c.co', 'a@@b.co']) assert.equal(parseEmail(raw), null, raw);
});

test('winners are kept through bracket.reset, bracket.build, players.set and bracket.load', () => {
  const saved = set(finished());
  const keep = saved.day.winners;
  assert.ok(keep);
  const reset = hq(saved, { type: 'bracket.reset', base: dayVersion(saved) });
  assert.deepEqual(reset.day.winners, keep);
  assert.equal(reset.day.matches.length, 0);
  const rebuilt = hq(reset, { type: 'bracket.build', base: dayVersion(reset) });
  assert.deepEqual(rebuilt.day.winners, keep);
  const roster = hq(rebuilt, { type: 'players.set', base: dayVersion(rebuilt), players: players(4) });
  assert.deepEqual(roster.day.winners, keep);
  const reloaded = hq(roster, { type: 'bracket.load', base: dayVersion(roster), players: players(4) });
  assert.deepEqual(reloaded.day.winners, keep);
  // …and the record is flagged as no longer matching the (new) bracket
  assert.equal(winnersState(reloaded.day).kind, 'stale');
});

test('winnersState: none → collect → saved (missing until names + phones) → stale after an undo', () => {
  assert.equal(winnersState(loaded().day).kind, 'none');
  const s = finished();
  assert.equal(winnersState(s.day).kind, 'collect');
  let saved = set(s);
  const partial = winnersState(saved.day);
  assert.ok(partial.kind === 'saved' && partial.missing && partial.result.winner === 'p1' && partial.result.runnerUp === 'p2', 'the runner-up has no phone yet');
  saved = set(s, { runnerUp: { realName: 'Bilal Khan', phone: '9820022222' } });
  const st = winnersState(saved.day);
  assert.ok(st.kind === 'saved' && !st.missing);
  assert.ok(detailsComplete(saved.day.winners));
  assert.deepEqual(missingFields(saved.day.winners!.winner), []);
  assert.deepEqual(missingFields(saved.day.winners!.runnerUp), ['email', 'instagram']);
  const fin = saved.day.matches.find((m) => m.round === 1)!;
  const undone = run(saved, { type: 'match.undo', base: 0, matchId: fin.id });
  assert.deepEqual(undone.day.winners, saved.day.winners, 'undo keeps the details');
  assert.equal(winnersState(undone.day).kind, 'stale');
  rejects(() => set(undone), 'conflict', /Record the final first/);
  // the final won by the other player: the saved record is for different people now
  const startedAgain = run(undone, { type: 'match.start', base: 0, matchId: fin.id, station: 1 });
  const other = run(startedAgain, { type: 'match.finish', base: 0, matchId: fin.id, winner: 'p2' });
  assert.equal(winnersState(other.day).kind, 'stale');
  const resaved = set(other);
  assert.equal(resaved.day.winners!.winner.playerId, 'p2');
  assert.equal(resaved.day.winners!.at, saved.day.winners!.at);
});

test('cleanWinnerInput leaves out what is empty', () => {
  assert.deepEqual(cleanWinnerInput({ realName: ' A ', ign: '', phone: '', email: ' ', instagram: '' }, 'Winner'), { ok: true, value: { realName: 'A' } });
});

test('validateCommand: shape only; admin and HQ may issue it', () => {
  const ok = validateCommand({ type: 'winners.set', base: 0, winner: win, runnerUp });
  assert.equal(ok.type, 'winners.set');
  for (const bad of [{ winner: win }, { winner: win, runnerUp: 'x' }, { winner: [], runnerUp }, { winner: { ...win, email: 3 }, runnerUp }, { winner: { ...win, email: 'x'.repeat(401) }, runnerUp }])
    assert.throws(() => validateCommand({ type: 'winners.set', base: 0, ...bad }), CommandError);
  assert.ok(applyCommand(finished(), { type: 'winners.set', base: 0, winner: win, runnerUp }, ctx('admin')));
});

test('the schema refuses a malformed winners record', () => {
  const good = set(finished());
  const bad = (w: unknown) => validateDocument('stores', { ...good, day: { ...good.day, winners: w } }, { events: { e1: event } });
  assert.deepEqual(bad(good.day.winners), []);
  assert.ok(bad({ ...good.day.winners, winner: { ...good.day.winners!.winner, instagram: '@no' } }).some((p) => p.includes('winners.winner.instagram')));
  assert.ok(bad({ ...good.day.winners, at: 'yesterday-ish' }).some((p) => p.includes('winners.at')));
  assert.ok(bad('nope').length > 0);
});

test('backup import keeps the server’s winners (command-only, like the bracket)', async () => {
  const { parseBackup, planImport } = await import('../src/lib/backupPlan.ts');
  const { fixtureAdmin, fixtureEvent } = await import('./helpers/server.ts');
  const kept = set(finished()).day.winners!;
  const forged = { ...kept, winner: { ...kept.winner, realName: 'Forged' } };
  const withDay = (id: string, winners?: unknown) => fixtureStore(id, 'e1', 'a1', { updatedAt: '2026-10-25T00:00:00.000Z', day: { players: [], checkIn: {}, matches: [], stations: 2, version: 0, ...(winners ? { winners } : {}) } });
  const text = JSON.stringify({
    kind: 'field-desk-backup',
    format: 2,
    state: { version: 1, events: { e1: fixtureEvent('e1') }, stores: { s1: withDay('s1', forged), s9: withDay('s9', forged) }, admins: { a1: fixtureAdmin('a1', 'OLD2') } },
    photos: {},
    manifest: { complete: true, photos: {}, missing: [] },
  });
  const parsed = parseBackup(text);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'));
  const cur = { version: 1, events: { e1: fixtureEvent('e1') }, stores: { s1: { ...fixtureStore('s1', 'e1', 'a1', { updatedAt: '2026-10-22T00:00:00.000Z' }), day: { players: [], checkIn: {}, matches: [], stations: 2, version: 0, winners: kept } } }, admins: { a1: fixtureAdmin('a1', 'NEW3') } };
  const plan = planImport(parsed.backup, cur as never);
  assert.deepEqual(plan.errors, []);
  const doc = (id: string) => plan.edits.find((e) => e.id === id)!.doc as unknown as { day: { winners?: unknown } };
  assert.deepEqual(doc('s1').day.winners, kept, 'the server’s record stays');
  assert.equal(doc('s9').day.winners, undefined, 'a new store starts with none');
  assert.ok(plan.warnings.some((w) => w.includes('winner and runner-up')));
});
