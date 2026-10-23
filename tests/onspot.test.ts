/*
 * On-spot registrations (src/lib/onspot.ts) — which player an entry is now, "in bracket?",
 * what HQ copies and downloads, and walk-ins kept when HQ replaces the list (through the real
 * players.set handler). Walk-ins are written into day.onSpot directly, the way players.onspot
 * leaves them (player appended and checked in, entry appended), so these don't depend on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyText, csvRows, filterOnSpot, inBracket, keepOnSpot, localStamp, onSpotByPlayer, onSpotCounts, onSpotPlayer, onSpotStates, prettyPhone, toCsv } from '../src/lib/onspot.ts';
import { applyCommand, dayVersion, type CommandContext } from '../src/lib/commands.ts';
import { playerIdFor } from '../src/lib/phone.ts';
import type { OnSpotEntry, Player, Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureStore } from './helpers/server.ts';

let seq = 0;
const event: TournamentEvent = { id: 'e1', name: 'Synthetic Campaign', date: '2026-10-24', games: [], collateral: [], gameReadyTarget: 4, minDownMbps: 25, createdAt: '2026-10-01T00:00:00.000Z' };
const ctx = (): CommandContext => ({ commandId: `os-${++seq}`, now: '2026-10-24T10:00:00.000Z', actor: { principal: 'super', name: 'HQ', role: 'super' }, event });
const player = (name: string, phone: string | undefined, seed: number, ign?: string): Player => ({ id: playerIdFor(phone, name), name, seed, ...(phone ? { phone } : {}), ...(ign ? { ign } : {}) });

function listed(players: Player[]) {
  const s = fixtureStore('s1', 'e1', 'a1') as unknown as Store;
  return applyCommand(s, { type: 'players.set', base: 0, players }, ctx());
}

/** What players.onspot leaves behind: the player on the list, checked in, and the registration. */
function walkIn(store: Store, name: string, phone?: string, ign?: string, extra: Partial<OnSpotEntry> = {}): Store {
  const p = player(name, phone, store.day.players.length + 1, ign);
  const e: OnSpotEntry = { id: `os-${name.toLowerCase().replace(/\W+/g, '')}`, playerId: p.id, name, at: '2026-10-24T09:30:00.000Z', by: 'Priya (admin)', ...(phone ? { phone } : {}), ...(ign ? { ign } : {}), ...extra };
  return { ...store, day: { ...store.day, players: [...store.day.players, p], checkIn: { ...store.day.checkIn, [p.id]: '2026-10-24T09:30:00.000Z' }, onSpot: [...(store.day.onSpot ?? []), e] } };
}

const base = () => listed([player('Asha Rao', '9820011111', 1), player('Rohan Mehta', '9820022222', 2), player('Kabir Singh', undefined, 3)]);

test('an entry is found on the list by id, then phone, then name — and tagged for HQ’s player list', () => {
  let s = walkIn(base(), 'Ravi Kumar', '9820044444', 'RaviK');
  s = walkIn(s, 'Meera Nair');
  const [ravi, meera] = s.day.onSpot!;
  assert.equal(onSpotPlayer(s.day.players, ravi)!.name, 'Ravi Kumar');
  // HQ's list since gave Ravi a new id (say a new spelling) but the same phone; Meera only by name.
  const moved = s.day.players.map((p) => (p.name === 'Ravi Kumar' ? { ...p, id: 'other-id', name: 'Ravi K' } : p.name === 'Meera Nair' ? { ...p, id: 'm2', name: 'meera  NAIR' } : p));
  assert.equal(onSpotPlayer(moved, ravi)!.id, 'other-id');
  assert.equal(onSpotPlayer(moved, meera)!.id, 'm2');
  assert.equal(onSpotPlayer(moved.filter((p) => p.id !== 'm2'), meera), undefined);
  const tags = onSpotByPlayer(s.day);
  assert.deepEqual([...tags.keys()].sort(), [ravi.playerId, meera.playerId].sort());
  assert.ok(!tags.has(s.day.players[0].id), 'listed players aren’t tagged');
});

test('in bracket: only once their player is in a match — the proof after HQ’s Toornament refresh', () => {
  let s = walkIn(base(), 'Ravi Kumar', '9820044444');
  const ravi = s.day.onSpot![0];
  assert.equal(inBracket(s.day, ravi), false);
  s = applyCommand(s, { type: 'bracket.build', base: dayVersion(s) }, ctx());
  assert.equal(inBracket(s.day, ravi), true);
  const [st] = onSpotStates(s.day);
  assert.equal(st.checkedIn, true);
  assert.equal(st.inBracket, true);
  // Off the list: no player, not in the bracket, not checked in.
  const gone = { ...s.day, players: s.day.players.filter((p) => p.id !== ravi.playerId), matches: [] };
  assert.deepEqual(onSpotStates(gone).map((x) => [x.player, x.checkedIn, x.inBracket]), [[undefined, false, false]]);
});

test('filters and counts: to add / added / all, across stores', () => {
  let a = walkIn(base(), 'Ravi Kumar', '9820044444');
  a = walkIn(a, 'Meera Nair', undefined, undefined, { toornament: '2026-10-24T09:45:00.000Z' });
  const b = walkIn(base(), 'Dev Patel');
  const list = a.day.onSpot!;
  assert.deepEqual(filterOnSpot(list, 'todo').map((e) => e.name), ['Ravi Kumar']);
  assert.deepEqual(filterOnSpot(list, 'done').map((e) => e.name), ['Meera Nair']);
  assert.equal(filterOnSpot(onSpotStates(a.day), 'all').length, 2);
  assert.deepEqual(onSpotCounts([a, b, base()]), { total: 3, todo: 2 });
});

test('copy: one per line; the in-game variant uses the IGN where given', () => {
  let s = walkIn(base(), 'Ravi Kumar', '9820044444', 'RaviK');
  s = walkIn(s, 'Meera Nair');
  assert.equal(copyText(s.day.onSpot!), 'Ravi Kumar\nMeera Nair');
  assert.equal(copyText(s.day.onSpot!, 'ign'), 'RaviK\nMeera Nair');
});

test('CSV: the columns HQ asked for, full phone as text, quoted and never a formula', () => {
  let s = walkIn(base(), 'Ravi, "RK" Kumar', '9820044444', '=HYPERLINK()');
  s = walkIn(s, 'Meera Nair', undefined, undefined, { toornament: '2026-10-24T09:45:00.000Z' });
  const rows = csvRows([{ ...s, name: 'Store One' }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].slice(0, 4), ['Ravi, "RK" Kumar', '98200 44444', '=HYPERLINK()', 'Store One']);
  assert.equal(rows[0][4], localStamp('2026-10-24T09:30:00.000Z'));
  assert.match(rows[0][4], /^2026-10-2\d \d\d:\d\d$/);
  assert.deepEqual(rows[0].slice(5), ['Priya (admin)', 'No']);
  assert.equal(rows[1][6], localStamp('2026-10-24T09:45:00.000Z'));
  assert.deepEqual(csvRows([{ ...s, name: 'Store One' }], 'todo').length, 1);
  const csv = toCsv(rows).split('\r\n');
  assert.equal(csv[0], 'Name,Phone,In-game name,Store,Registered at,By,Added to Toornament');
  assert.ok(csv[1].startsWith('"Ravi, ""RK"" Kumar",98200 44444,\'=HYPERLINK(),Store One,'));
  assert.equal(csv.at(-1), '', 'ends with a line break');
  assert.equal(prettyPhone('9820044444'), '98200 44444');
  assert.equal(prettyPhone('447700900123'), '447700900123');
  assert.equal(localStamp('nonsense'), '');
});

test('HQ replaces the list: walk-ins not in the file are kept after it, with their check-ins', () => {
  let s = walkIn(base(), 'Ravi Kumar', '9820044444', 'RaviK');
  s = walkIn(s, 'Meera Nair');
  const file = [player('Asha Rao', '9820011111', 1), player('Zoya Ali', '9820033333', 2)];
  const { players, kept } = keepOnSpot(s.day, file);
  assert.deepEqual(kept.map((p) => p.name), ['Ravi Kumar', 'Meera Nair']);
  assert.deepEqual(players.map((p) => [p.name, p.seed]), [['Asha Rao', 1], ['Zoya Ali', 2], ['Ravi Kumar', 3], ['Meera Nair', 4]]);
  assert.equal(players[2].ign, 'RaviK');
  const after = applyCommand(s, { type: 'players.set', base: dayVersion(s), players }, ctx());
  assert.ok(after.day.checkIn[kept[0].id] && after.day.checkIn[kept[1].id], 'walk-ins stay checked in');
  assert.equal(after.day.onSpot!.length, 2, 'the registrations stay');
  // Dropping them is HQ's choice: the file alone.
  const dropped = applyCommand(s, { type: 'players.set', base: dayVersion(s), players: file }, ctx());
  assert.equal(dropped.day.players.length, 2);
  assert.deepEqual(onSpotStates(dropped.day).map((x) => x.player), [undefined, undefined], 'still listed for HQ, just not on the player list');
});

test('HQ replaces the list: a walk-in who IS in the file is the file’s row — same phone + name keeps the id and check-in', () => {
  let s = walkIn(base(), 'Ravi Kumar', '9820044444');
  s = walkIn(s, 'Meera Nair');
  s = walkIn(s, 'Dev Patel', '9820055555');
  const ravi = s.day.onSpot![0];
  const file = [
    player('Ravi Kumar', '9820044444', 1, 'RK'), // same phone + name → same id
    player('MEERA nair', '9820066666', 2), // same name (now with a phone)
    player('Devan P', '9820055555', 3), // same phone, other spelling
  ];
  const { players, kept } = keepOnSpot(s.day, file);
  assert.deepEqual(kept, []);
  assert.deepEqual(players, file);
  assert.equal(players[0].id, ravi.playerId);
  const after = applyCommand(s, { type: 'players.set', base: dayVersion(s), players }, ctx());
  assert.ok(after.day.checkIn[ravi.playerId], 'Ravi’s check-in carries over');
  assert.equal(after.day.players[0].ign, 'RK', 'the file’s row wins');
});

test('HQ replaces the list: no walk-ins, or walk-ins already gone, change nothing', () => {
  const plain = base();
  const file = [player('Asha Rao', '9820011111', 1)];
  assert.equal(keepOnSpot(plain.day, file).players, file);
  const s = walkIn(base(), 'Ravi Kumar', '9820044444');
  const gone = { ...s.day, players: s.day.players.filter((p) => p.name !== 'Ravi Kumar') };
  assert.deepEqual(keepOnSpot(gone, file).kept, [], 'a walk-in HQ already removed isn’t brought back by a re-import');
});
