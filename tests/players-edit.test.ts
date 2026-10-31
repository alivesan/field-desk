/*
 * players.edit — HQ corrects a player's name, in-game name and number; the desk only adds a number to a
 * player who has none (and sets the in-game name). Real handlers via applyCommand, over in-memory stores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, CommandError, dayVersion, validateCommand, type Command, type CommandContext } from '../src/lib/commands.ts';
import { playerIdFor } from '../src/lib/phone.ts';
import type { Player, Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureStore } from './helpers/server.ts';

const event: TournamentEvent = { id: 'e1', name: 'Synthetic Campaign', date: '2026-10-24', games: [], collateral: [], gameReadyTarget: 4, minDownMbps: 25, createdAt: '2026-10-01T00:00:00.000Z' };
let seq = 0;
const ctx = (role: 'super' | 'admin' = 'super'): CommandContext => ({ commandId: `pe-${++seq}`, now: '2026-10-24T10:00:00.000Z', actor: { principal: role === 'super' ? 'super' : 'admin:a1', name: role === 'super' ? 'HQ' : 'Priya', role }, event });
const hq = () => ctx('super');
const desk = () => ctx('admin');

const asha: Player = { id: 'p1', name: 'Asha Rao', seed: 1, phone: '9820011111', ign: 'AshaR' };
const rohit: Player = { id: 'p2', name: 'Rohit Rajan', seed: 2 }; // no number
const kabir: Player = { id: 'p3', name: 'Kabir Singh', seed: 3, phone: '9820033333' };
const zoya: Player = { id: 'p4', name: 'Zoya Ali', seed: 4 };

function listed(): Store {
  const s = fixtureStore('s1', 'e1', 'a1') as unknown as Store;
  return applyCommand(s, { type: 'players.set', base: 0, players: [asha, rohit, kabir, zoya] }, hq());
}
const edit = (s: Store, playerId: string, fields: { name?: string; ign?: string; phone?: string }, c = hq()) => applyCommand(s, { type: 'players.edit', base: dayVersion(s), playerId, ...fields }, c);
const playerOf = (s: Store, id: string) => s.day.players.find((p) => p.id === id)!;

function rejects(fn: () => unknown, code: 'conflict' | 'invalid' | 'forbidden', msg?: RegExp) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof CommandError, `expected CommandError, got ${e}`);
    assert.equal(e.code, code);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

test('HQ renames a player (spacing cleaned), sets and removes the in-game name', () => {
  let s = listed();
  const v = dayVersion(s);
  s = edit(s, 'p2', { name: '  Rohit   Rajan Nair ' });
  assert.equal(playerOf(s, 'p2').name, 'Rohit Rajan Nair');
  assert.equal(dayVersion(s), v + 1);
  s = edit(s, 'p2', { ign: '  Ro  Hit ' });
  assert.equal(playerOf(s, 'p2').ign, 'Ro Hit');
  s = edit(s, 'p2', { ign: '' });
  assert.ok(!('ign' in playerOf(s, 'p2')));
  // id, seed and the other players are untouched
  assert.deepEqual(playerOf(s, 'p2'), { id: 'p2', name: 'Rohit Rajan Nair', seed: 2 });
  assert.deepEqual(s.day.players.filter((p) => p.id !== 'p2'), [asha, kabir, zoya]);
});

test('HQ sets, changes and removes a number (normalised)', () => {
  let s = listed();
  s = edit(s, 'p2', { phone: '+91 98200 44444' });
  assert.equal(playerOf(s, 'p2').phone, '9820044444');
  s = edit(s, 'p1', { phone: '098200 55555' });
  assert.equal(playerOf(s, 'p1').phone, '9820055555');
  s = edit(s, 'p1', { phone: '' });
  assert.ok(!('phone' in playerOf(s, 'p1')));
  assert.equal(playerOf(s, 'p1').ign, 'AshaR', 'the rest of the player stays');
  // the same number in other spelling, or nothing to change: the same day, no version bump
  const same = edit(s, 'p2', { phone: '9820044444', name: 'Rohit Rajan', ign: '' });
  assert.equal(same, s);
});

test('HQ can’t take a name or number that’s already on the list; bad input is invalid', () => {
  const s = listed();
  rejects(() => edit(s, 'p2', { name: ' kabir   SINGH ' }), 'conflict', /Kabir Singh is already on the list/);
  assert.equal(playerOf(edit(s, 'p3', { name: 'KABIR singh' }), 'p3').name, 'KABIR singh', 'a player may change the case of their own name');
  rejects(() => edit(s, 'p2', { phone: '098200 11111' }), 'conflict', /That number is already on the list as Asha Rao\./);
  rejects(() => edit(s, 'p2', { name: '   ' }), 'invalid', /name/);
  rejects(() => edit(s, 'p2', { name: 'x'.repeat(81) }), 'invalid', /80/);
  rejects(() => edit(s, 'p2', { phone: '12345' }), 'invalid', /phone number doesn’t look right/);
  rejects(() => edit(s, 'p2', { ign: 'x'.repeat(41) }), 'invalid', /40/);
  rejects(() => edit(s, 'nobody', { ign: 'x' }), 'conflict', /isn’t on the list any more/);
});

test('the desk adds a number to a player who has none, and sets the in-game name', () => {
  let s = listed();
  s = edit(s, 'p2', { phone: '98200 66666', ign: 'RoRa' }, desk());
  assert.deepEqual(playerOf(s, 'p2'), { id: 'p2', name: 'Rohit Rajan', seed: 2, phone: '9820066666', ign: 'RoRa' });
  s = edit(s, 'p1', { ign: 'Asha!' }, desk()); // replacing the in-game name of a player who has a number
  assert.equal(playerOf(s, 'p1').ign, 'Asha!');
  assert.equal(playerOf(s, 'p1').phone, '9820011111');
  // the same name or number as it is: nothing to refuse
  assert.equal(edit(s, 'p1', { name: 'Asha Rao', phone: '9820011111' }, desk()), s);
  // a duplicate number is still refused for the desk
  rejects(() => edit(s, 'p4', { phone: '9820011111' }, desk()), 'conflict', /already on the list as Asha Rao/);
});

test('the desk can’t change a number that’s there, or rename — also when its device holds only the last 4 digits', () => {
  const s = listed();
  rejects(() => edit(s, 'p1', { phone: '9820099999' }, desk()), 'forbidden', /Only HQ can change a number that’s already on the list\./);
  rejects(() => edit(s, 'p1', { phone: '' }, desk()), 'forbidden', /Only HQ can change a number/);
  rejects(() => edit(s, 'p2', { name: 'Rohit R.' }, desk()), 'forbidden', /Only HQ can rename a player\./);
  rejects(() => edit(s, 'p2', { name: 'rohit rajan' }, desk()), 'forbidden', /Only HQ can rename/);
  const admin = { ...s, day: { ...s.day, players: s.day.players.map((p) => (p.id === 'p3' ? { id: p.id, name: p.name, seed: p.seed, phoneEnd: '3333' } : p)) } };
  rejects(() => edit(admin, 'p3', { phone: '9820077777' }, desk()), 'forbidden', /Only HQ can change a number/);
  assert.equal(edit(admin, 'p4', { phone: '9820077777' }, desk()).day.players[3].phone, '9820077777', 'a player with no number at all can be given one');
});

test('a walk-in’s registration follows the edit, so a later Toornament import brings back the new details', () => {
  let s = listed();
  const ravi: Player = { id: playerIdFor(undefined, 'Ravi Kumar'), name: 'Ravi Kumar', seed: 5 };
  s = {
    ...s,
    day: {
      ...s.day,
      players: [...s.day.players, ravi],
      checkIn: { [ravi.id]: '2026-10-24T09:30:00.000Z' },
      onSpot: [
        { id: 'os-1', playerId: ravi.id, name: 'Ravi Kumar', at: '2026-10-24T09:30:00.000Z', by: 'Priya', toornament: '2026-10-24T09:40:00.000Z' },
        { id: 'os-2', playerId: 'someone-else', name: 'Meera Nair', at: '2026-10-24T09:31:00.000Z', by: 'Priya', phone: '9820099999' },
      ],
    },
  };
  s = edit(s, ravi.id, { name: 'Ravi K.', phone: '9820044444', ign: 'RaviK' });
  assert.deepEqual(s.day.onSpot![0], { id: 'os-1', playerId: ravi.id, name: 'Ravi K.', at: '2026-10-24T09:30:00.000Z', by: 'Priya', toornament: '2026-10-24T09:40:00.000Z', phone: '9820044444', ign: 'RaviK' });
  assert.equal(s.day.onSpot![1].name, 'Meera Nair', 'other registrations are not touched');
  s = edit(s, ravi.id, { phone: '', ign: '' });
  assert.deepEqual(Object.keys(s.day.onSpot![0]).sort(), ['at', 'by', 'id', 'name', 'playerId', 'toornament']);
  assert.equal(s.day.onSpot![0].name, 'Ravi K.');
  // the desk adding a number to a no-number walk-in updates the entry too, and the check-in stays
  const bare = edit(s, ravi.id, { phone: '98200 77777' }, desk());
  assert.equal(bare.day.onSpot![0].phone, '9820077777');
  assert.ok(bare.day.checkIn[ravi.id]);
});

test('it works after the bracket exists, without touching a match', () => {
  let s = listed();
  s = applyCommand(s, { type: 'bracket.build', base: dayVersion(s) }, hq());
  const before = structuredClone(s.day.matches);
  s = edit(s, 'p2', { name: 'Rohit Rajan Nair', phone: '9820066666' });
  s = edit(s, 'p4', { phone: '9820088888', ign: 'Zo' }, desk());
  assert.deepEqual(s.day.matches, before);
  assert.deepEqual([playerOf(s, 'p2').name, playerOf(s, 'p2').phone, playerOf(s, 'p4').phone, playerOf(s, 'p4').ign], ['Rohit Rajan Nair', '9820066666', '9820088888', 'Zo']);
});

test('validateCommand: players.edit shape', () => {
  assert.equal(validateCommand({ type: 'players.edit', base: 0, playerId: 'p1', phone: '98200' }).type, 'players.edit');
  assert.equal(validateCommand({ type: 'players.edit', base: 0, playerId: 'p1', name: 'A', ign: '', phone: '' }).type, 'players.edit');
  for (const bad of [
    { type: 'players.edit', base: 0, phone: '98200' },
    { type: 'players.edit', base: 0, playerId: 'p1' },
    { type: 'players.edit', base: 0, playerId: 'p1', name: 7 },
    { type: 'players.edit', base: 0, playerId: 'p1', phone: 98200 },
    { type: 'players.edit', base: 0, playerId: 'p1', ign: 'x'.repeat(201) },
    { type: 'players.edit', playerId: 'p1', name: 'A' },
  ])
    assert.throws(() => validateCommand(bad), CommandError);
  const c: Command = validateCommand({ type: 'players.edit', base: 3, playerId: 'p1', name: 'A' });
  assert.equal(c.type, 'players.edit');
});
