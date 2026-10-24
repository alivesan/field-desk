import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBackup, planImport, planSummary, type ParsedBackup } from '../src/lib/backupPlan.ts';
import type { AppState, PhotoRef } from '../src/lib/types.ts';
import { fixtureAdmin, fixtureEvent, fixtureStore } from './helpers/server.ts';

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==';
const SHA = 'a'.repeat(64);
const ref = (id: string): PhotoRef => ({ id, label: 'Play area', takenAt: '2026-10-23T10:00:00.000Z', fileTime: '2026-10-23T10:00:00.000Z', live: true, source: 'camera', geo: null });

function file(over: Record<string, unknown> = {}, stateOver: Record<string, unknown> = {}) {
  const s1 = fixtureStore('s1', 'e1', 'a1', { updatedAt: '2026-10-20T00:00:00.000Z' });
  (s1.recce.venue.photos as PhotoRef[]).push(ref('photo01'), ref('photo02'));
  return JSON.stringify({
    kind: 'field-desk-backup',
    format: 2,
    state: { version: 1, events: { e1: fixtureEvent('e1') }, stores: { s1, s9: fixtureStore('s9', 'e1', null) }, admins: { a1: fixtureAdmin('a1', 'OLD2') }, ...stateOver },
    photos: { photo01: JPEG },
    manifest: { complete: false, photos: { photo01: { sha256: SHA, bytes: 10, type: 'image/jpeg' } }, missing: [{ id: 'photo02', storeId: 's1', label: 'Venue · Play area' }] },
    ...over,
  });
}

const current = (): AppState => ({
  version: 1,
  events: { e1: fixtureEvent('e1') as never },
  stores: { s1: fixtureStore('s1', 'e1', 'a1', { updatedAt: '2026-10-22T00:00:00.000Z', city: 'Elsewhere' }) as never },
  admins: { a1: fixtureAdmin('a1', 'NEW3') as never },
  accounts: {},
});

const parsed = (text = file()): ParsedBackup => {
  const r = parseBackup(text);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.backup;
};

test('malformed files are rejected whole, with no plan', () => {
  const bad = [
    '{not json',
    JSON.stringify({ kind: 'something-else' }),
    JSON.stringify({ kind: 'field-desk-backup', state: { version: 2, events: {}, stores: {} } }),
    file({}, { stores: [] }),
    file({}, { stores: { s1: { id: 'other', name: 'x', eventId: 'e1', recce: {}, day: {} } } }),
    file({}, { stores: { s1: { id: 's1', name: 'x', eventId: 'e1' } } }),
    file().replace('"events":{', '"events":{"__proto__":{"id":"__proto__","name":"x","date":"x","games":[]},'),
    file({ photos: { photo01: 'javascript:alert(1)' } }),
    file({ photos: { photo01: 'data:text/html;base64,PHNjcmlwdD4=' } }),
    file({ manifest: { photos: { photo01: { sha256: 'nothex' } } } }),
    file({ format: 99 }),
  ];
  for (const t of bad) {
    const r = parseBackup(t);
    assert.equal(r.ok, false, t.slice(0, 80));
    if (!r.ok) assert.ok(r.errors.length > 0);
  }
});

test('a store whose campaign is missing fails validation: no edits, no photos', () => {
  const b = parsed(file({}, { events: {} }));
  const plan = planImport(b, { version: 1, events: {}, stores: {}, admins: {}, accounts: {} });
  assert.equal(plan.ok, false);
  assert.ok(plan.errors.some((e) => e.includes('campaign')));
  assert.deepEqual(plan.edits, []);
  assert.deepEqual(plan.photos, []);
});

test('preview counts creates vs replacements, keeps newer local copies, lists missing photos', () => {
  const b = parsed();
  const plan = planImport(b, current());
  assert.equal(plan.ok, true, plan.errors.join('\n'));
  assert.deepEqual(plan.counts.events, { create: 0, replace: 0, same: 1, keptNewer: 0, skipped: 0 });
  // s1 is newer here → kept by default; s9 is new
  assert.equal(plan.counts.stores.create, 1);
  assert.equal(plan.counts.stores.keptNewer, 1);
  assert.deepEqual(plan.localNewer.map((x) => [x.id, x.kept]), [['s1', true]]);
  assert.deepEqual(plan.edits.map((e) => [e.kind, e.id, e.action]), [['stores', 's9', 'create']]);
  assert.match(planSummary(plan), /1 new store/);
  assert.ok(plan.warnings.some((w) => w.includes('incomplete')));

  const overwrite = planImport(b, current(), { keepNewerLocal: false });
  assert.equal(overwrite.ok, true, overwrite.errors.join(" | "));
  assert.deepEqual(overwrite.edits.map((e) => [e.id, e.action]).sort(), [['s1', 'replace'], ['s9', 'create']]);
  assert.deepEqual(overwrite.photos.map((p) => [p.id, p.storeId, p.sha256]), [['photo01', 's1', SHA]]);
  assert.deepEqual(overwrite.missingPhotos.map((p) => p.id), ['photo02']);
});

test('admins and their codes are excluded by default; opting in warns about old links', () => {
  const b = parsed();
  const def = planImport(b, current(), { keepNewerLocal: false });
  assert.equal(def.admins.included, false);
  assert.equal(def.counts.admins.skipped, 1);
  assert.ok(!def.edits.some((e) => e.kind === 'admins'));

  const opt = planImport(b, current(), { includeAdmins: true, keepNewerLocal: false });
  assert.equal(opt.counts.admins.replace, 1);
  assert.deepEqual(opt.admins.reactivated.map((a) => a.id), ['a1']);
  assert.match(opt.admins.reactivated[0].why, /old link would work again/);
});

test('assignments to admins that will not exist are not imported', () => {
  const b = parsed(file({}, { admins: { ghost: fixtureAdmin('ghost', 'GGG4') }, stores: { s9: fixtureStore('s9', 'e1', 'ghost') } }));
  const plan = planImport(b, current());
  const s9 = plan.edits.find((e) => e.id === 's9')!.doc as { adminId: string | null };
  assert.equal(s9.adminId, null);
  assert.ok(plan.warnings.some((w) => w.includes('isn’t on this server')));
});

test('submission history is never fabricated by import', () => {
  const withSubs = fixtureStore('s9', 'e1', null, { submissions: [{ id: 'sub-x', rev: 1 }] });
  const plan = planImport(parsed(file({}, { stores: { s9: withSubs } })), current());
  const doc = plan.edits.find((e) => e.id === 's9')!.doc as { submissions?: unknown };
  assert.equal(doc.submissions, undefined);
  assert.ok(plan.warnings.some((w) => w.includes('revision')));
});

test('tournament state is never overwritten by import (server-command fields stay as on the server)', () => {
  const players = [
    { id: 'p1', name: 'One', seed: 1 },
    { id: 'p2', name: 'Two', seed: 2 },
  ];
  const day = { players, checkIn: { p1: '2026-10-23T09:00:00.000Z', ghost: '2026-10-23T09:00:00.000Z' }, matches: [{ id: 'm1', round: 0, index: 0, a: 'p1', b: 'p2', winner: null, status: 'pending', score: '' }], stations: 3, version: 4 };
  const plan = planImport(parsed(file({}, { stores: { s1: fixtureStore('s1', 'e1', 'a1', { updatedAt: '2026-10-25T00:00:00.000Z', day }), s9: fixtureStore('s9', 'e1', null, { day }) } })), current());
  assert.deepEqual(plan.errors ?? [], []);
  for (const id of ['s1', 's9']) {
    const doc = plan.edits.find((e) => e.id === id)!.doc as { day: { players: unknown[]; matches: unknown[]; stations: number; version: number; checkIn: Record<string, string> } };
    // s1 exists on the server with an empty bracket → stays empty; s9 is new → starts empty
    assert.deepEqual(doc.day.players, []);
    assert.deepEqual(doc.day.matches, []);
    assert.equal(doc.day.version, 0);
    assert.deepEqual(doc.day.checkIn, {}, 'check-ins for players not kept are dropped');
  }
  assert.equal((plan.edits.find((e) => e.id === 's1')!.doc as { day: { stations: number } }).day.stations, 2, 'existing store keeps the server station count');
  assert.ok(plan.warnings.some((w) => w.includes('bracket')));
});

test('on-the-spot registrations are never overwritten by import (command-only, like the bracket)', () => {
  const entry = (id: string, over: Record<string, unknown> = {}) => ({ id, playerId: `p-${id}`, name: `Walk ${id}`, at: '2026-10-23T09:00:00.000Z', by: 'Rhea', ...over });
  const cur = current();
  (cur.stores.s1 as { day: { onSpot?: unknown[] } }).day.onSpot = [entry('os-a')];
  const forged = { onSpot: [entry('os-a', { toornament: '2026-10-23T10:00:00.000Z' }), entry('os-b')] };
  const b = parsed(file({}, { stores: { s1: fixtureStore('s1', 'e1', 'a1', { updatedAt: '2026-10-25T00:00:00.000Z', day: { players: [], checkIn: {}, matches: [], stations: 2, version: 0, ...forged } }), s9: fixtureStore('s9', 'e1', null, { day: { players: [], checkIn: {}, matches: [], stations: 2, version: 0, ...forged } }) } }));
  const plan = planImport(b, cur);
  assert.deepEqual(plan.errors, []);
  const doc = (id: string) => plan.edits.find((e) => e.id === id)!.doc as { day: { onSpot?: unknown[] } };
  assert.deepEqual(doc('s1').day.onSpot, [entry('os-a')], 'the server’s record stays');
  assert.equal(doc('s9').day.onSpot, undefined, 'a new store starts with none');
  assert.ok(plan.warnings.some((w) => w.includes('on-the-spot')));
});

test('the parse result is not mutated by planning', () => {
  const b = parsed();
  const before = JSON.stringify(b);
  planImport(b, current(), { includeAdmins: true, keepNewerLocal: false });
  assert.equal(JSON.stringify(b), before);
});

test('Steam accounts come in with the file; a store assigned one needs it to exist; a team’s computed login is never imported', () => {
  const acct = { id: 'x', username: 'test_rog_x', password: 'fake-pass-123', createdAt: '2026-10-20T00:00:00.000Z' };
  const assigned = { ...fixtureStore('s9', 'e1', null), steam: { accountId: 'x', purpose: 'play', assignedAt: '2026-10-22T00:00:00.000Z' }, steamLogin: { username: 'test_rog_x', password: 'fake-pass-123', purpose: 'play' } };
  const withAccount = parsed(file({}, { accounts: { x: acct }, stores: { s9: assigned } }));
  const plan = planImport(withAccount, current());
  assert.equal(plan.ok, true, plan.errors.join('\n'));
  assert.deepEqual(plan.counts.accounts, { create: 1, replace: 0, same: 0, keptNewer: 0, skipped: 0 });
  assert.match(planSummary(plan), /1 new Steam account/);
  const store = plan.edits.find((e) => e.kind === 'stores' && e.id === 's9')!.doc as { steamLogin?: unknown };
  assert.equal(store.steamLogin, undefined);
  // already on the server: nothing to do, and the store may point at it
  const here = { ...current(), accounts: { x: structuredClone(acct) } };
  assert.equal(planImport(withAccount, here).counts.accounts.same, 1);
  // a file without the account the store points at can't be imported
  const dangling = planImport(parsed(file({}, { stores: { s9: assigned } })), current());
  assert.equal(dangling.ok, false);
  assert.ok(dangling.errors.some((e) => /Steam account x doesn’t exist/.test(e)), dangling.errors.join('\n'));
  // a file from before accounts existed imports as before
  assert.equal(parsed().state.accounts && Object.keys(parsed().state.accounts).length, 0);
});
