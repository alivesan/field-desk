import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, compactInto, diffDocs, validateOps, type Docs, type Op } from '../src/lib/ops.ts';

/* F02: id-keyed collection ops. Synthetic docs only. */

const photo = (id: string) => ({ id, label: 'Venue', takenAt: '2026-10-24T10:00:00.000Z', fileTime: '2026-10-24T10:00:00.000Z', live: true, geo: null });
const laptop = (id: string, notes = '') => ({ id, label: id, role: 'game', games: {}, drivers: false, windows: false, notes, photos: [] as unknown[] });

function base(): Docs {
  return {
    events: {},
    admins: {},
    accounts: {},
    stores: { s1: { id: 's1', recce: { venue: { photos: [photo('P1')] }, laptops: [laptop('L1'), laptop('L2'), laptop('L3')] }, day: { checkIn: {} } } },
  };
}
const edit = (docs: Docs, fn: (d: Docs) => void) => {
  const next = structuredClone(docs);
  fn(next);
  return diffDocs(docs, next);
};
const roundTrip = (ops: Op[]) => validateOps(JSON.parse(JSON.stringify(ops)));

test('concurrent photo additions from two devices both survive', () => {
  const server = base();
  const a = edit(server, (d) => d.stores.s1.recce.venue.photos.push(photo('P2')));
  const b = edit(server, (d) => d.stores.s1.recce.venue.photos.push(photo('P3')));
  assert.deepEqual(a, [{ k: 'stores', id: 's1', p: ['recce', 'venue', 'photos'], ins: photo('P2'), after: 'P1' }]);
  applyOps(server, roundTrip(a));
  applyOps(server, roundTrip(b));
  assert.deepEqual(server.stores.s1.recce.venue.photos.map((p: { id: string }) => p.id).sort(), ['P1', 'P2', 'P3']);
});

test('an edit to laptop L2 still targets L2 after another device removed L1', () => {
  const server = base();
  const editL2 = edit(server, (d) => (d.stores.s1.recce.laptops[1].notes = 'fan noisy'));
  assert.deepEqual(editL2, [{ k: 'stores', id: 's1', p: ['recce', 'laptops', { id: 'L2' }, 'notes'], v: 'fan noisy' }]);
  const removeL1 = edit(server, (d) => d.stores.s1.recce.laptops.splice(0, 1));
  assert.deepEqual(removeL1, [{ k: 'stores', id: 's1', p: ['recce', 'laptops'], rm: 'L1' }]);
  applyOps(server, roundTrip(removeL1));
  applyOps(server, roundTrip(editL2));
  const laptops = server.stores.s1.recce.laptops;
  assert.deepEqual(
    laptops.map((l: { id: string; notes: string }) => [l.id, l.notes]),
    [
      ['L2', 'fan noisy'],
      ['L3', ''],
    ],
  );
});

test('remove vs concurrent edit: the removed item stays removed, nothing else is touched', () => {
  const server = base();
  const editL1 = edit(server, (d) => (d.stores.s1.recce.laptops[0].notes = 'late edit'));
  const removeL1 = edit(server, (d) => d.stores.s1.recce.laptops.splice(0, 1));
  applyOps(server, removeL1);
  const before = structuredClone(server);
  applyOps(server, editL1); // selector target missing → skipped, no stray containers created
  assert.deepEqual(server, before);
});

test('re-applying the same ops is idempotent (insert of existing id, remove of missing id)', () => {
  const server = base();
  const ops = edit(server, (d) => {
    d.stores.s1.recce.venue.photos.push(photo('P2'));
    d.stores.s1.recce.laptops.splice(2, 1);
    d.stores.s1.recce.laptops[0].notes = 'x';
  });
  applyOps(server, ops);
  const once = structuredClone(server);
  applyOps(server, ops);
  applyOps(server, ops);
  assert.deepEqual(server, once);
});

test('insert position: after a known id, first for null, at the end when the anchor is gone', () => {
  const docs: Docs = { events: {}, admins: {}, accounts: {}, stores: { s: { list: [{ id: 'a' }, { id: 'b' }] } } };
  applyOps(docs, [
    { k: 'stores', id: 's', p: ['list'], ins: { id: 'x' }, after: 'a' },
    { k: 'stores', id: 's', p: ['list'], ins: { id: 'y' }, after: null },
    { k: 'stores', id: 's', p: ['list'], ins: { id: 'z' }, after: 'gone' },
    { k: 'stores', id: 's', p: ['fresh'], ins: { id: 'n' }, after: null }, // missing array is created
  ]);
  assert.deepEqual(
    docs.stores.s.list.map((x: { id: string }) => x.id),
    ['y', 'a', 'x', 'b', 'z'],
  );
  assert.deepEqual(docs.stores.s.fresh, [{ id: 'n' }]);
});

test('arrays without ids keep the old behaviour; reordering id arrays replaces the array', () => {
  const docs: Docs = { events: { e: { games: ['A'], laps: [{ id: 'a' }, { id: 'b' }] } }, admins: {}, accounts: {}, stores: {} };
  assert.deepEqual(
    edit(docs, (d) => d.events.e.games.push('B')),
    [{ k: 'events', id: 'e', p: ['games'], v: ['A', 'B'] }],
  );
  assert.deepEqual(
    edit(docs, (d) => (d.events.e.games[0] = 'Z')),
    [{ k: 'events', id: 'e', p: ['games', 0], v: 'Z' }],
  );
  assert.deepEqual(
    edit(docs, (d) => d.events.e.laps.reverse()),
    [{ k: 'events', id: 'e', p: ['laps'], v: [{ id: 'b' }, { id: 'a' }] }],
  );
});

test('old-format (index path) ops from existing outboxes still validate and apply', () => {
  const server = base();
  const old = validateOps([
    { k: 'stores', id: 's1', p: ['recce', 'laptops', 1, 'notes'], v: 'legacy' },
    { k: 'stores', id: 's1', p: ['recce', 'venue', 'photos'], v: [photo('P1'), photo('P9')] },
    { k: 'stores', id: 's1', p: ['day', 'checkIn', 'pl1'], d: 1 },
  ]);
  applyOps(server, old);
  assert.equal(server.stores.s1.recce.laptops[1].notes, 'legacy');
  assert.equal(server.stores.s1.recce.venue.photos.length, 2);
});

test('validateOps rejects malformed shapes and forbidden keys', () => {
  const bad: unknown[] = [
    { k: 'stores', id: 's1', p: ['__proto__'], v: 1 },
    { k: 'stores', id: 's1', p: ['a', { id: 'x', extra: 1 }, 'b'], v: 1 },
    { k: 'stores', id: 's1', p: ['a', { id: 5 }], v: 1 },
    { k: 'stores', id: 's1', p: ['a', { id: '' }, 'b'], v: 1 },
    { k: 'stores', id: 's1', p: ['a', { id: 'x' }], v: 1 }, // whole-item replace via selector
    { k: 'stores', id: 's1', p: ['a'], ins: { id: 'x' } }, // missing after
    { k: 'stores', id: 's1', p: ['a'], ins: { id: 'x' }, after: 3 },
    { k: 'stores', id: 's1', p: ['a'], ins: { noId: true }, after: null },
    { k: 'stores', id: 's1', p: ['a'], ins: 'x', after: null },
    { k: 'stores', id: 's1', p: [], ins: { id: 'x' }, after: null },
    { k: 'stores', id: 's1', p: ['a'], rm: 7 },
    { k: 'stores', id: 's1', p: ['a'], rm: 'x', v: 1 },
    { k: 'stores', id: 's1', p: ['a'], ins: { id: 'x' }, after: null, d: 1 },
    { k: 'stores', id: 's1', p: ['a'], v: 1, after: 'x' },
    { k: 'stores', id: 's1', p: ['a'], ins: { id: 'x', constructor: 1 }, after: null },
    { k: 'nope', id: 's1', p: [], v: {} },
  ];
  for (const op of bad) assert.throws(() => validateOps([op]), Error, JSON.stringify(op));
  // and accepts the new shapes
  const good = validateOps([
    { k: 'stores', id: 's1', p: ['a'], ins: { id: 'x', n: 1 }, after: null },
    { k: 'stores', id: 's1', p: ['a'], ins: { id: 'y' }, after: 'x' },
    { k: 'stores', id: 's1', p: ['a'], rm: 'x' },
    { k: 'stores', id: 's1', p: ['a', { id: 'y' }, 'n'], v: 2 },
    { k: 'stores', id: 's1', p: ['a', { id: 'y' }, 'n'], d: 1 },
  ]);
  assert.equal(good.length, 5);
});

test('compactInto never drops inserts or removals, and still collapses repeated sets', () => {
  const target: Op[] = [
    { k: 'stores', id: 's1', p: ['recce', 'laptops'], ins: { id: 'L4' }, after: 'L3' },
    { k: 'stores', id: 's1', p: ['recce', 'laptops', { id: 'L4' }, 'notes'], v: 'a' },
    { k: 'stores', id: 's1', p: ['recce', 'laptops'], rm: 'L1' },
  ];
  compactInto(target, [
    { k: 'stores', id: 's1', p: ['recce', 'laptops', { id: 'L4' }, 'notes'], v: 'b' },
    { k: 'stores', id: 's1', p: ['recce', 'laptops'], ins: { id: 'L5' }, after: 'L4' },
    { k: 'stores', id: 's1', p: ['recce', 'laptops'], rm: 'L1' },
  ]);
  assert.deepEqual(target, [
    { k: 'stores', id: 's1', p: ['recce', 'laptops'], ins: { id: 'L4' }, after: 'L3' },
    { k: 'stores', id: 's1', p: ['recce', 'laptops'], rm: 'L1' },
    { k: 'stores', id: 's1', p: ['recce', 'laptops', { id: 'L4' }, 'notes'], v: 'b' },
    { k: 'stores', id: 's1', p: ['recce', 'laptops'], ins: { id: 'L5' }, after: 'L4' },
    { k: 'stores', id: 's1', p: ['recce', 'laptops'], rm: 'L1' },
  ]);
  // selector paths are distinct keys: an edit to L2 never collapses an edit to L3
  const t2: Op[] = [{ k: 'stores', id: 's1', p: ['l', { id: 'L2' }, 'n'], v: 1 }];
  compactInto(t2, [{ k: 'stores', id: 's1', p: ['l', { id: 'L3' }, 'n'], v: 2 }]);
  assert.equal(t2.length, 2);
});
