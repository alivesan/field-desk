import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStore, validateDocument } from '../src/lib/schema.ts';
import { fixtureAdmin, fixtureEvent, fixtureStore } from './helpers/server.ts';

const ctx = () => ({ events: { e1: fixtureEvent('e1') as any }, admins: { a1: fixtureAdmin('a1', 'AAA2') as any, a2: fixtureAdmin('a2', 'BBB3') as any } });
const store = (over: Record<string, unknown> = {}) => fixtureStore('s1', 'e1', 'a1', over) as any;
const has = (problems: string[], re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}, got ${JSON.stringify(problems)}`);

const photo = (id: string) => ({ id, label: 'x', takenAt: '2026-10-20T10:00:00.000Z', fileTime: '2026-10-20T10:00:00.000Z', live: true, geo: { lat: 12.9, lng: 77.6, accuracy: 10 } });
const players = [
  { id: 'p1', name: 'One', seed: 1 },
  { id: 'p2', name: 'Two', seed: 2 },
  { id: 'p3', name: 'Three', seed: 3 },
  { id: 'p4', name: 'Four', seed: 4 },
];
const match = (id: string, a: string | null, b: string | null, over: Record<string, unknown> = {}) => ({ id, round: 0, index: 0, a, b, winner: null, status: 'pending', score: '', ...over });
const day = (over: Record<string, unknown> = {}) => ({ players, checkIn: {}, matches: [], stations: 2, version: 3, ...over });

test('schema: the fixtures are valid', () => {
  assert.deepEqual(validateDocument('events', fixtureEvent('e1'), ctx()), []);
  assert.deepEqual(validateDocument('admins', fixtureAdmin('a1', 'AAA2'), ctx()), []);
  assert.deepEqual(validateDocument('stores', store(), ctx()), []);
});

test('schema: store recce null / missing sections are rejected (F04)', () => {
  has(validateDocument('stores', store({ recce: null }), ctx()), /^recce: must be an object/);
  const s = store();
  delete s.recce.network;
  has(validateDocument('stores', s, ctx()), /^recce\.network: must be an object/);
  has(validateDocument('stores', store({ day: null }), ctx()), /^day: must be an object/);
});

test('schema: speed numbers must be finite and ≥ 0, or null', () => {
  const s = store();
  s.recce.network.speed = { down: -1, up: Infinity, ping: null, method: 'manual', at: '2026-10-20T10:00:00.000Z' };
  const p = validateDocument('stores', s, ctx());
  has(p, /speed\.down: must be a number/);
  has(p, /speed\.up: must be a number/);
  assert.ok(!p.some((x) => /speed\.ping/.test(x)));
  s.recce.network.speed.down = 'fast';
  has(validateDocument('stores', s, ctx()), /speed\.down/);
});

test('schema: photo refs, laptops and furniture are checked; paths use ids', () => {
  const s = store();
  s.recce.laptops = [{ id: 'l1', label: 'Laptop 01', role: 'game', games: { 'Game A': 'yes' }, drivers: true, windows: true, notes: '', photos: [{ ...photo('abcdef1'), geo: { lat: 200, lng: 0, accuracy: 1 } }] }];
  s.recce.furniture.chairCount = -3;
  s.recce.venue.photos = [photo('BAD ID')];
  const p = validateDocument('stores', s, ctx());
  has(p, /recce\.laptops\[id=l1\]\.games\.Game A: must be true or false/);
  has(p, /recce\.laptops\[id=l1\]\.photos\[id=abcdef1\]\.geo\.lat/);
  has(p, /recce\.furniture\.chairCount/);
  has(p, /recce\.venue\.photos\[0\]\.id: must be a photo id/);
  s.recce.network.photos = [{ ...photo('abcdef2'), geoAt: 'yesterday' }];
  has(validateDocument('stores', s, ctx()), /network\.photos\[id=abcdef2\]\.geoAt: must be a date-time/);
  s.recce.network.photos = [{ ...photo('abcdef2'), geoAt: '2026-10-20T10:00:05.000Z', source: 'camera', geoFrom: 'device' }];
  assert.ok(!validateDocument('stores', s, ctx()).some((x) => /network/.test(x)));
});

test('schema: dates are yyyy-mm-dd real calendar dates; store date may be blank', () => {
  has(validateDocument('events', fixtureEvent('e1', { date: '2026-02-30' })), /^date:/);
  has(validateDocument('events', fixtureEvent('e1', { date: '' })), /^date:/);
  assert.deepEqual(validateDocument('stores', store({ date: '' }), ctx()), []);
  has(validateDocument('stores', store({ date: '24/10/2026' }), ctx()), /^date:/);
});

test('schema: ids and references', () => {
  has(validateDocument('stores', store({ eventId: 'nope' }), ctx()), /^eventId: campaign nope doesn’t exist/);
  has(validateDocument('stores', store({ adminId: 'ghost' }), ctx()), /^adminId: admin ghost doesn’t exist/);
  assert.deepEqual(validateDocument('stores', store({ adminId: null }), ctx()), []);
  has(validateDocument('stores', store({ id: 'has space' }), ctx()), /^id:/);
  has(validateDocument('stores', store({ id: 'x'.repeat(65) }), ctx()), /^id:/);
});

test('schema: admin code format and uniqueness across admins', () => {
  has(validateDocument('admins', fixtureAdmin('a3', 'AAO2'), ctx()), /^code: must be 4 characters/);
  has(validateDocument('admins', fixtureAdmin('a3', 'aaa2'), ctx()), /^code:/);
  has(validateDocument('admins', fixtureAdmin('a3', 'AAA2'), ctx()), /^code: is already used/);
  assert.deepEqual(validateDocument('admins', fixtureAdmin('a1', 'AAA2'), ctx()), []); // itself
});

test('schema: check-ins and match participants must be players', () => {
  has(validateDocument('stores', store({ day: day({ checkIn: { ghost: '2026-10-24T10:00:00.000Z' } }) }), ctx()), /day\.checkIn\.ghost: isn’t a player/);
  has(validateDocument('stores', store({ day: day({ matches: [match('m1', 'p1', 'ghost')] }) }), ctx()), /day\.matches\[id=m1\]\.b/);
  has(validateDocument('stores', store({ day: day({ matches: [match('m1', 'p1', 'p2', { winner: 'p3', status: 'done' })] }) }), ctx()), /\.winner: must be one of/);
  has(validateDocument('stores', store({ day: day({ matches: [match('m1', 'p1', 'p1')] }) }), ctx()), /can’t play themselves/);
});

test('schema: on-the-spot registrations — a record whose player may since have been replaced; malformed entries rejected', () => {
  const entry = (over: Record<string, unknown> = {}) => ({ id: 'os-c1', playerId: 'gone', name: 'Ravi K.', phone: '9820055555', ign: 'RaviOP', at: '2026-10-24T10:00:00.000Z', by: 'Rhea', ...over });
  assert.deepEqual(validateDocument('stores', store({ day: day({ onSpot: [entry(), entry({ id: 'os-c2', toornament: '2026-10-24T11:00:00.000Z', phone: undefined, ign: undefined })] }) }), ctx()), []);
  has(validateDocument('stores', store({ day: day({ onSpot: {} }) }), ctx()), /day\.onSpot: must be a list/);
  has(validateDocument('stores', store({ day: day({ onSpot: [entry(), entry()] }) }), ctx()), /day\.onSpot\[id=os-c1\]: duplicate id/);
  has(validateDocument('stores', store({ day: day({ onSpot: [entry({ name: ' ' })] }) }), ctx()), /onSpot\[id=os-c1\]\.name/);
  has(validateDocument('stores', store({ day: day({ onSpot: [entry({ phone: '98-20' })] }) }), ctx()), /onSpot\[id=os-c1\]\.phone: must be 6–15 digits/);
  has(validateDocument('stores', store({ day: day({ onSpot: [entry({ ign: 'x'.repeat(41) })] }) }), ctx()), /onSpot\[id=os-c1\]\.ign/);
  has(validateDocument('stores', store({ day: day({ onSpot: [entry({ at: 'yesterday' })] }) }), ctx()), /onSpot\[id=os-c1\]\.at: must be a date-time/);
  has(validateDocument('stores', store({ day: day({ onSpot: [entry({ by: 7 })] }) }), ctx()), /onSpot\[id=os-c1\]\.by/);
  has(validateDocument('stores', store({ day: day({ onSpot: [entry({ toornament: true })] }) }), ctx()), /onSpot\[id=os-c1\]\.toornament/);
  has(validateDocument('stores', store({ day: day({ onSpot: [entry({ playerId: 'has space' })] }) }), ctx()), /onSpot\[id=os-c1\]\.playerId/);
  has(validateDocument('stores', store({ day: day({ onSpot: ['x'] }) }), ctx()), /onSpot\[0\]: must be an object/);
});

test('schema: at most one live match per station and per player; stations in range', () => {
  const live = (id: string, a: string, b: string, station: number) => match(id, a, b, { status: 'live', station, startedAt: '2026-10-24T10:00:00.000Z' });
  assert.deepEqual(validateDocument('stores', store({ day: day({ matches: [live('m1', 'p1', 'p2', 1), live('m2', 'p3', 'p4', 2)] }) }), ctx()), []);
  has(validateDocument('stores', store({ day: day({ matches: [live('m1', 'p1', 'p2', 1), live('m2', 'p3', 'p4', 1)] }) }), ctx()), /station 1 is already playing match m1/);
  has(validateDocument('stores', store({ day: day({ matches: [live('m1', 'p1', 'p2', 1), live('m2', 'p1', 'p4', 2)] }) }), ctx()), /player p1 is already playing/);
  has(validateDocument('stores', store({ day: day({ matches: [live('m1', 'p1', 'p2', 3)] }) }), ctx()), /station: must be within 1–2/);
  has(validateDocument('stores', store({ day: day({ matches: [match('m1', 'p1', 'p2', { status: 'live' })] }) }), ctx()), /needs a station/);
  has(validateDocument('stores', store({ day: day({ stations: 0 }) }), ctx()), /day\.stations/);
  has(validateDocument('stores', store({ day: day({ version: -1 }) }), ctx()), /day\.version/);
});

test('schema: absent optional match fields are fine (handlers delete keys)', () => {
  const m = { id: 'm1', round: 0, index: 0, a: 'p1', b: 'p2', status: 'pending', score: '' };
  assert.deepEqual(validateDocument('stores', store({ day: day({ matches: [m] }) }), ctx()), []);
});

test('schema: submissions are validated, including their frozen recce', () => {
  const sub = (id: string, rev: number, over: Record<string, unknown> = {}) => ({
    id,
    rev,
    submittedAt: '2026-10-20T10:00:00.000Z',
    by: 'admin:a1',
    byName: 'A1',
    recce: store().recce,
    policy: { games: ['Game A'], gameReadyTarget: 4, minDownMbps: 25 },
    ...over,
  });
  assert.deepEqual(validateDocument('stores', store({ submissions: [sub('r1', 1), sub('r2', 2)] }), ctx()), []);
  has(validateDocument('stores', store({ submissions: [sub('r1', 1), sub('r2', 1)] }), ctx()), /duplicate revision/);
  has(validateDocument('stores', store({ submissions: [sub('r1', 1, { recce: null })] }), ctx()), /submissions\[id=r1\]\.recce: must be an object/);
});

test('normalizeStore: upgrades a legacy store to a valid current one, idempotently', () => {
  const legacy: any = {
    id: 's9',
    eventId: 'e1',
    name: 'Old',
    city: 'X',
    address: '',
    admin: '',
    pin: null,
    recce: { status: 'submitted', submittedAt: '2026-09-01T10:00:00.000Z', venue: { photos: [], area: 'corner', notes: '' }, laptops: [], network: { wifi: 'yes', lan: null, speed: null, photos: [] }, collateral: { placed: { Standee: true }, handedTo: 'Ravi', photos: [photo('abcdef9')] }, summary: '' },
    day: { players: [], checkIn: {}, matches: [], stations: 2 },
  };
  has(validateDocument('stores', legacy, ctx()), /recce\.furniture/);
  normalizeStore(legacy);
  assert.deepEqual(validateDocument('stores', legacy, ctx()), []);
  assert.equal(legacy.day.version, 0);
  assert.equal(legacy.adminId, null);
  assert.equal(legacy.recce.collateral.standee, true);
  assert.deepEqual(legacy.recce.collateral.standeePhotos.map((p: any) => p.id), ['abcdef9']);
  const once = JSON.stringify(legacy);
  normalizeStore(legacy);
  assert.equal(JSON.stringify(legacy), once);

  const broken: any = { id: 's8', eventId: 'e1', name: 'B', city: '', address: '', admin: '', recce: null };
  normalizeStore(broken);
  assert.deepEqual(validateDocument('stores', broken, ctx()), []);
});
