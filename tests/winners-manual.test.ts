/*
 * winners.manual — HQ types the winner and runner-up for a store whose bracket ran elsewhere.
 * The handler over in-memory stores (no bracket needed, winner’s name required, runner-up
 * optional, re-save keeps `at`, HQ only, the desk can’t overwrite it, winners.clear removes it),
 * then the rows / CSV it produces and the schema's view of a manual record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, CommandError, dayVersion, validateCommand, type Command, type CommandContext } from '../src/lib/commands.ts';
import { validateDocument } from '../src/lib/schema.ts';
import { winnersState } from '../src/lib/winnerInput.ts';
import { storeWinnerRows, summarize, winnerRows, winnersCsv } from '../src/lib/winners.ts';
import type { WinnerInput } from '../src/lib/command-types.ts';
import type { Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureStore } from './helpers/server.ts';

const event: TournamentEvent = { id: 'e1', name: 'Test Cup', date: '2026-10-23', games: [], collateral: [], gameReadyTarget: 0, minDownMbps: 0, createdAt: '2026-10-01T00:00:00.000Z' };
let seq = 0;
const ctx = (role: 'super' | 'admin' = 'super', name = 'HQ'): CommandContext => ({
  commandId: `wm${++seq}`,
  now: new Date(Date.UTC(2026, 9, 23, 10, 0, seq)).toISOString(),
  actor: { principal: role === 'super' ? 'super' : 'a1', name, role },
  event,
});
const run = (s: Store, cmd: Command, c = ctx()) => applyCommand(s, cmd, c);
const empty = (id = 's1', name = 'Pune Store') => fixtureStore(id, 'e1', null, { name, city: 'Pune' }) as unknown as Store;
const isErr = (code: string, msg?: RegExp) => (e: unknown) => e instanceof CommandError && e.code === code && (!msg || msg.test(e.message));
const full = { realName: 'Asha  Rao', ign: 'AshaX', phone: '98200 11111', email: 'Asha@Example.com', instagram: '@asha.rao' };
const second = { realName: 'Bilal Khan', phone: '9820022222' };
const manual = (s: Store, winner: WinnerInput = full, runnerUp: WinnerInput = second, c = ctx()) =>
  run(s, { type: 'winners.manual', base: dayVersion(s), winner, runnerUp }, c);

test('HQ saves winners with no bracket at all; ids stay empty and the details are cleaned', () => {
  const s = empty();
  assert.equal(s.day.matches.length, 0);
  const out = manual(s);
  const w = out.day.winners!;
  assert.equal(w.manual, true);
  assert.equal(w.finalMatchId, '');
  assert.deepEqual(w.winner, { playerId: '', realName: 'Asha Rao', ign: 'AshaX', phone: '9820011111', email: 'asha@example.com', instagram: 'asha.rao' });
  assert.deepEqual(w.runnerUp, { playerId: '', realName: 'Bilal Khan', phone: '9820022222' });
  assert.equal(w.by, 'HQ');
  assert.equal(w.at, w.updatedAt);
  assert.equal(out.day.version, dayVersion(s) + 1);
  assert.equal(winnersState(out.day).kind, 'manual');
  assert.deepEqual(validateDocument('stores', out, { events: { e1: event } }), []);
});

test('the winner’s name is required; the runner-up may be left entirely empty', () => {
  const s = empty();
  assert.throws(() => manual(s, { ...full, realName: '  ' }), isErr('invalid', /Type the winner’s name\./));
  assert.throws(() => manual(s, { ...full, email: 'nope' }), isErr('invalid', /Winner’s email/));
  assert.throws(() => manual(s, full, { realName: 'B', phone: '12' }), isErr('invalid', /Runner-up’s phone/));
  const out = manual(s, full, { realName: '' });
  assert.deepEqual(out.day.winners!.runnerUp, { playerId: '', realName: '' });
  assert.deepEqual(winnersState(out.day), { kind: 'manual', missing: true });
});

test('saving again edits it: "at" stays, updatedAt and by move on; the details are replaced', () => {
  const first = manual(empty());
  const next = manual(first, { realName: 'Asha Rao-Shah' }, second, ctx('super', 'Priya'));
  const a = first.day.winners!;
  const b = next.day.winners!;
  assert.equal(b.at, a.at);
  assert.notEqual(b.updatedAt, a.updatedAt);
  assert.equal(b.by, 'Priya');
  assert.deepEqual(b.winner, { playerId: '', realName: 'Asha Rao-Shah' });
  assert.equal(winnersState(next.day).kind, 'manual');
});

test('HQ only: the desk is refused, and the shape check wants both people as objects', () => {
  assert.throws(() => manual(empty(), full, { realName: 'B' }, ctx('admin', 'Rhea')), isErr('forbidden'));
  const cmd = { type: 'winners.manual', base: 0, winner: full, runnerUp: { realName: '' } };
  assert.deepEqual(validateCommand(cmd), cmd);
  assert.throws(() => validateCommand({ ...cmd, runnerUp: undefined }), isErr('invalid'));
  assert.throws(() => validateCommand({ ...cmd, winner: { realName: 5 } }), isErr('invalid'));
});

test('the desk’s winners.set cannot overwrite a manual record', () => {
  const s = manual(empty());
  const set: Command = { type: 'winners.set', base: 0, winner: { realName: 'X' }, runnerUp: { realName: 'Y' } };
  assert.throws(() => run(s, set, ctx('admin', 'Rhea')), isErr('conflict', /HQ entered this store’s winners by hand — ask HQ to change them\./));
  assert.equal(s.day.winners!.winner.realName, 'Asha Rao');
});

test('winners.clear removes a manual record, and nothing else', () => {
  const s = manual(empty());
  const out = run(s, { type: 'winners.clear', base: 0 });
  assert.equal('winners' in out.day, false);
  assert.equal(winnersState(out.day).kind, 'none');
  assert.deepEqual(out.day.players, s.day.players);
});

/* ---------- rows, summary, CSV ---------- */

const events = { e1: event };

test('rows: a manual record is complete or partial by the usual rule, tagged "Entered by HQ", never a mismatch', () => {
  const [w, r] = storeWinnerRows(manual(empty()), event);
  assert.equal(w.place, 'Winner');
  assert.equal(w.status, 'complete');
  assert.equal(w.manual, true);
  assert.equal(w.note, 'Entered by HQ');
  assert.equal(w.realName, 'Asha Rao');
  assert.equal(w.phone, '9820011111');
  assert.equal(w.finalDone, false);
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.missing, ['email', 'instagram']);
  assert.equal(r.note, 'Entered by HQ');
  assert.equal(r.savedBy, 'HQ');

  const blank = storeWinnerRows(manual(empty(), { realName: 'Asha Rao' }, { realName: '' }), event);
  assert.deepEqual(blank.map((x) => x.status), ['partial', 'partial']);
  assert.deepEqual(blank[1].missing, ['realName', 'phone', 'email', 'instagram']);

  const [plain] = storeWinnerRows(empty(), event);
  assert.equal(plain.manual, false);
  assert.equal(plain.status, 'no-final');
});

test('summary counts a store with typed winners as having a winner', () => {
  const a = manual(empty('s1', 'A'));
  const b = manual(empty('s2', 'B'));
  const none = empty('s3', 'C');
  const rows = winnerRows({ events, stores: { s1: a, s2: b, s3: none } });
  assert.deepEqual(summarize(rows), { stores: 3, played: 2, full: 0, check: 0 });
});

test('CSV: a Source column — "By hand" for typed winners, "Bracket" otherwise', () => {
  const csv = winnersCsv(winnerRows({ events, stores: { s1: manual(empty('s1', 'Hand Store')), s3: empty('s3', 'Open Store') } }));
  const lines = csv.slice(1).split('\r\n');
  assert.ok(lines[0].endsWith(',Saved by,Source'));
  const line = (store: string, place: string) => lines.find((l) => l.includes(store) && l.includes(`,${place},`))!;
  assert.match(line('Hand Store', 'Winner'), /,Complete,2026-10-23 \d\d:\d\d,HQ,By hand$/);
  assert.match(line('Hand Store', 'Runner-up'), /,"Partial — missing email, Instagram",.*,HQ,By hand$/);
  assert.match(line('Open Store', 'Winner'), /,Final not played,,,Bracket$/);
});

/* ---------- schema ---------- */

test('schema: a manual record is accepted; the empty ids are allowed only on one', () => {
  const good = manual(empty());
  const bad = (w: unknown) => validateDocument('stores', { ...good, day: { ...good.day, winners: w } }, { events });
  const w = good.day.winners!;
  assert.deepEqual(bad(w), []);
  assert.deepEqual(bad({ ...w, winner: { ...w.winner, playerId: 'p1' } }), [], 'HQ may have picked someone from the list');
  const { manual: _m, ...bracketBased } = w;
  assert.ok(bad(bracketBased).some((p) => p.includes('winners.finalMatchId')), 'a bracket record still needs its final');
  assert.ok(bad({ ...w, manual: false }).some((p) => p.includes('winners.manual')));
  assert.ok(bad({ ...w, winner: { ...w.winner, instagram: '@no' } }).some((p) => p.includes('winners.winner.instagram')), 'everything else is still validated');
  assert.ok(bad({ ...w, at: 'yesterday-ish' }).some((p) => p.includes('winners.at')));
});
