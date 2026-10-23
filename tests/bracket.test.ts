/*
 * Bracket paste parsing (audit F15) and the pure bracket helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBracket, parseFeed, resolve } from '../src/lib/bracket.ts';

const lines = (r: ReturnType<typeof parseFeed>) => r.errors.map((e) => e.line);

test('parseFeed: seeded list and pairings parse with their mode', () => {
  const a = parseFeed('1. Aarav Shah\n\n2) Meera  Nair\nKabir Singh\n');
  assert.deepEqual(a, { mode: 'names', names: ['Aarav Shah', 'Meera Nair', 'Kabir Singh'], pairs: null, errors: [] });
  const b = parseFeed('Aarav vs Kabir\nMeera v/s BYE');
  assert.deepEqual(b, { mode: 'pairs', names: ['Aarav', 'Kabir', 'Meera'], pairs: [['Aarav', 'Kabir'], ['Meera', null]], errors: [] });
  // "vs" wins over a weak separator, so an initial "V" survives
  assert.deepEqual(parseFeed('Arjun V Rao vs Meera').pairs, [['Arjun V Rao', 'Meera']]);
  assert.deepEqual(parseFeed('').errors, []);
});

test('parseFeed: mixed name-list / pairing input is rejected at the right lines', () => {
  const r = parseFeed('Asha vs Rohan\n\nKabir\nMeera vs Zoya\nDiya vs Neel');
  assert.equal(r.mode, null);
  assert.deepEqual(lines(r), [3]);
  assert.match(r.errors[0].message, /single name.*pairings/);
  const r2 = parseFeed('Asha\nRohan\nKabir vs Meera');
  assert.deepEqual(lines(r2), [3]);
  assert.match(r2.errors[0].message, /looks like a pairing/);
  // explicit names mode takes the line verbatim (escape hatch)
  assert.deepEqual(parseFeed('Asha\nRohan\nKabir vs Meera', 'names').names, ['Asha', 'Rohan', 'Kabir vs Meera']);
  // explicit pairs mode: a single name is an error, not a player
  assert.deepEqual(lines(parseFeed('Asha vs Rohan\nKabir', 'pairs')), [2]);
});

test('parseFeed: a pairing has exactly two sides', () => {
  const r = parseFeed('A vs B\nC vs D vs E\nF vs\nG vs H');
  assert.deepEqual(lines(r), [2, 3]);
  assert.match(r.errors[0].message, /3 sides/);
  assert.match(r.errors[1].message, /missing a name/);
  assert.equal(r.pairs, null);
  assert.deepEqual(r.names, []);
});

test('parseFeed: duplicates rejected (case-insensitive), pointing at the first occurrence', () => {
  const r = parseFeed('Asha\nRohan\nasha');
  assert.deepEqual(r.errors, [{ line: 3, message: '“asha” already appears on line 1. Names must be unique — add an initial or surname.' }]);
  const p = parseFeed('Asha vs Rohan\nKabir vs Asha');
  assert.deepEqual(lines(p), [2]);
  assert.match(p.errors[0].message, /line 1/);
});

test('parseFeed: BYE vs BYE, BYE in a seeded list, numbering with no name', () => {
  assert.deepEqual(lines(parseFeed('A vs B\nBYE vs bye')), [2]);
  assert.match(parseFeed('A vs B\nBYE vs bye').errors[0].message, /BYE vs BYE/);
  assert.deepEqual(lines(parseFeed('Asha\nBYE\nRohan')), [2]);
  assert.deepEqual(lines(parseFeed('Asha\n3.\nRohan')), [2]);
  assert.deepEqual(lines(parseFeed('Solo')), [1]);
});

test('parseFeed: non-power-of-two pairings point at the last pairing line', () => {
  const r = parseFeed('A vs B\nC vs D\n\nE vs BYE');
  assert.deepEqual(lines(r), [4]);
  assert.match(r.errors[0].message, /3 pairings.*Add 1 more/);
  assert.deepEqual(lines(parseFeed('A vs B\nC vs D\nE vs F\nG vs H\nI vs J')), [5]);
});

test('parseFeed: no non-empty line disappears — each is a player/pairing or an error', () => {
  const samples = ['A\nB\nC vs D\n4.\nE', 'x vs y vs z\nq', 'A vs B\nC - D\nE – F\nG v H', '  \n\tA\n  B  \n'];
  for (const s of samples) {
    const r = parseFeed(s);
    const nonEmpty = s.split('\n').filter((l) => l.trim()).length;
    const accounted = r.errors.length ? new Set(r.errors.map((e) => e.line)).size : r.pairs ? r.pairs.length : r.names.length;
    if (r.errors.length) assert.ok(accounted >= 1, s);
    else assert.equal(accounted, nonEmpty, s);
  }
});

test('buildBracket with an id prefix is deterministic; resolve reports disturbed started matches', () => {
  const players = [1, 2, 3, 4].map((i) => ({ id: `p${i}`, name: `P${i}`, seed: i }));
  const a = buildBracket(players, null, 'cmd1');
  assert.deepEqual(a, buildBracket(players, null, 'cmd1'));
  assert.deepEqual(a.map((m) => m.id), ['cmd1-0-0', 'cmd1-0-1', 'cmd1-1-0']);
  // Final already played between p1 and p2; re-pointing semi 1 at p4 must not keep it "done".
  const played = a.map((m) =>
    m.round === 0 ? { ...m, status: 'done' as const, winner: m.index === 0 ? 'p1' : 'p2' } : { ...m, a: 'p1', b: 'p2', status: 'done' as const, winner: 'p1', score: '2-0' },
  );
  const changed = played.map((m) => (m.round === 0 && m.index === 0 ? { ...m, winner: 'p4' } : m));
  const r = resolve(changed);
  assert.deepEqual(r.disturbed.map((m) => m.id), ['cmd1-1-0']);
  assert.equal(resolve(played).disturbed.length, 0);
});
