import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManualSpeed, hasDownload } from '../src/lib/speedtest.ts';
import { assess, photoFlags } from '../src/lib/assess.ts';
import { coordsFromMapsUrl, isShortMapsLink, laptopsLostOnResize, mapsUrlProblem, allEvidenceRefs, allPhotoRefs } from '../src/lib/recce.ts';
import { freshFix } from '../src/lib/geo.ts';
import { diffManifest, evidenceBanner, expectedPhotos, provenanceSummary, sha256Hex, storeEvidence } from '../src/lib/evidence.ts';
import { parseGames } from '../src/lib/games.ts';
import type { Laptop, PhotoRef, Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

const event = () => fixtureEvent('e1') as TournamentEvent;
const store = (over: Record<string, unknown> = {}) => fixtureStore('s1', 'e1', null, over) as unknown as Store;
const T = '2026-10-23T10:00:00.000Z';
const photo = (over: Partial<PhotoRef> = {}): PhotoRef => ({ id: 'p1', label: 'Play area', takenAt: T, fileTime: T, live: true, source: 'camera', geo: { lat: 19.07, lng: 72.87, accuracy: 10 }, geoFrom: 'device', geoAt: T, ...over });

/* ---------- F17 speed ---------- */

test('manual speed: validation matrix', () => {
  const ok = (down: string, up = '', ping = '') => parseManualSpeed({ down, up, ping });
  assert.deepEqual(ok('42.5'), { ok: true, value: { down: 42.5, up: null, ping: null } });
  assert.deepEqual(ok('0', '0', '0'), { ok: true, value: { down: 0, up: 0, ping: 0 } });
  assert.deepEqual(ok('100', '20', '15'), { ok: true, value: { down: 100, up: 20, ping: 15 } });
  for (const [down, up, ping, field] of [
    ['', '', '', 'down'],
    ['   ', '', '', 'down'],
    ['-1', '', '', 'down'],
    ['NaN', '', '', 'down'],
    ['Infinity', '', '', 'down'],
    ['1e400', '', '', 'down'],
    ['0x10', '', '', 'down'],
    ['1,000', '', '', 'down'],
    ['abc', '', '', 'down'],
    ['10', '-3', '', 'up'],
    ['10', 'Infinity', '', 'up'],
    ['10', '', '-5', 'ping'],
    ['10', '', 'NaN', 'ping'],
  ] as const) {
    const r = ok(down, up, ping);
    assert.equal(r.ok, false, `${down}/${up}/${ping} should be rejected`);
    if (!r.ok) assert.ok(r.errors[field], `error on ${field} for ${down}/${up}/${ping}`);
  }
});

test('assessment: speed only counts with a finite download', () => {
  const ev = event();
  const base = { wifi: 'yes', lan: 'yes', photos: [photo({ id: 'shot' })] };
  const net = (speed: unknown) => assess(ev, store({ recce: { ...store().recce, network: { ...base, speed } } })).sections.find((s) => s.key === 'network')!;
  // F17 repro: blank manual entry + screenshot used to complete the section.
  assert.equal(net({ down: null, up: null, ping: null, method: 'manual', at: T }).done, false);
  assert.equal(net({ down: Number.NaN, up: null, ping: null, method: 'manual', at: T }).done, false);
  assert.equal(net({ down: Number.POSITIVE_INFINITY, up: null, ping: null, method: 'auto', at: T }).done, false);
  assert.equal(net({ down: -5, up: null, ping: null, method: 'manual', at: T }).done, false);
  assert.equal(net(null).todo.includes('Run the speed test'), true);
  const good = net({ down: 10, up: null, ping: null, method: 'manual', at: T });
  assert.equal(good.done, true);
  assert.ok(good.issues.some((i) => i.includes('below the 25 Mbps')));
  assert.equal(hasDownload({ down: 0, up: null, ping: null, method: 'auto', at: T }), true);
});

/* ---------- F18 provenance ---------- */

test('photoFlags: camera-path photo that is not live is flagged', () => {
  const s = store({ geo: { lat: 19.07, lng: 72.87, accuracy: 0 } });
  assert.deepEqual(photoFlags(photo(), s), []);
  const stale = photoFlags(photo({ live: false, fileTime: '2026-09-01T08:00:00.000Z' }), s);
  assert.ok(stale.some((f) => f.startsWith('Not taken just now')), stale.join('|'));
});

test('photoFlags: poor accuracy and a fix measured long before the photo', () => {
  const s = store({ geo: { lat: 19.07, lng: 72.87, accuracy: 0 } });
  assert.ok(photoFlags(photo({ geo: { lat: 19.07, lng: 72.87, accuracy: 350 } }), s).some((f) => f.includes('±350 m')));
  assert.deepEqual(photoFlags(photo({ geo: { lat: 19.07, lng: 72.87, accuracy: 100 } }), s), [], '100 m is still fine');
  assert.ok(photoFlags(photo({ geoAt: '2026-10-23T09:50:00.000Z' }), s).some((f) => f.startsWith('Location was measured')));
});

test('photoFlags + assess: a first-photo pin is provisional, not HQ-verified', () => {
  const far = photo({ id: 'p2', geo: { lat: 19.2, lng: 72.87, accuracy: 10 } });
  const provisional = store({ pin: { lat: 19.07, lng: 72.87, accuracy: 10 } });
  const f = photoFlags(far, provisional);
  assert.ok(f.some((x) => x.includes('not verified by HQ')), f.join('|'));
  const verified = store({ geo: { lat: 19.07, lng: 72.87, accuracy: 0 } });
  assert.ok(photoFlags(far, verified).some((x) => x.endsWith('from the venue')));

  const withPhoto = (s: Store) => {
    s.recce.venue.photos = [photo()];
    return assess(event(), s);
  };
  assert.ok(withPhoto(store({ pin: { lat: 19.07, lng: 72.87, accuracy: 10 } })).issues.some((i) => i.startsWith('Venue location not verified by HQ')));
  assert.ok(withPhoto(store()).issues.some((i) => i.startsWith('No venue location')));
  assert.ok(!withPhoto(store({ geo: { lat: 19.07, lng: 72.87, accuracy: 0 } })).issues.some((i) => i.includes('venue location') || i.includes('Venue location')));
});

test('photoFlags: upload without EXIF time or GPS', () => {
  const s = store({ geo: { lat: 19.07, lng: 72.87, accuracy: 0 } });
  const f = photoFlags(photo({ source: 'upload', live: false, shotAt: undefined, geo: null, geoFrom: undefined, geoAt: undefined }), s);
  assert.ok(f.some((x) => x.includes('no capture time')));
  assert.ok(f.some((x) => x.includes('No GPS in the photo')));
  assert.ok(!f.some((x) => x.startsWith('Not taken just now')), 'uploads are not judged as camera shots');
});

test('freshFix: reuse a prewarmed fix only when under 60 s old', () => {
  const now = Date.parse(T);
  const at = (ms: number) => ({ fix: { lat: 1, lng: 2, accuracy: 5 }, at: new Date(now - ms).toISOString() });
  assert.ok(freshFix(at(30_000), now));
  assert.equal(freshFix(at(61_000), now), null);
  assert.equal(freshFix(new Error('denied'), now), null);
  assert.equal(freshFix(null, now), null);
  assert.equal(freshFix({ fix: { lat: 1, lng: 2, accuracy: 5 }, at: 'garbage' }, now), null);
});

test('provenance footer is only as strong as the photos', () => {
  assert.match(provenanceSummary([photo()]), /^Every photo was taken in the app/);
  const mixed = provenanceSummary([photo(), photo({ id: 'u', source: 'upload', live: false, geo: null, geoFrom: undefined })]);
  assert.match(mixed, /^1 of 2 photos were taken in the app/);
  assert.match(mixed, /1 have no location/);
  assert.match(provenanceSummary([photo({ live: false })]), /^0 of 1/);
  assert.equal(provenanceSummary([]), 'No proof photos.');
});

/* ---------- F19 Maps ---------- */

test('coordsFromMapsUrl never throws on malformed or hostile input', () => {
  const huge = 'https://maps.google.com/?q=' + '1'.repeat(2_000_000);
  const nasty = ['https://maps.google.com/%', 'https://maps.google.com/%E0%A4%A', 'javascript:alert(1)//19.0,72.8', 'data:text/html,@19.07,72.87', 'file:///etc/passwd@19.07,72.87', '', '   ', 'not a url', huge, 'https://' + '%'.repeat(5000), 'https://maps.google.com/@' + '9'.repeat(4000)];
  for (const u of nasty) assert.doesNotThrow(() => coordsFromMapsUrl(u), u.slice(0, 40));
  assert.equal(coordsFromMapsUrl('https://maps.google.com/%'), null);
  assert.equal(coordsFromMapsUrl('javascript:alert(1)//@19.07,72.87'), null, 'non-http schemes rejected');
  assert.equal(coordsFromMapsUrl(huge), null);
  assert.equal(coordsFromMapsUrl(undefined as unknown as string), null);
  assert.doesNotThrow(() => isShortMapsLink(huge));
  // Valid links still parse — including one with bad percent-encoding elsewhere.
  assert.deepEqual(coordsFromMapsUrl('https://www.google.com/maps/place/X/@19.0760,72.8777,17z'), { lat: 19.076, lng: 72.8777, accuracy: 0 });
  assert.deepEqual(coordsFromMapsUrl('https://www.google.com/maps?q=19.0760,72.8777'), { lat: 19.076, lng: 72.8777, accuracy: 0 });
  assert.deepEqual(coordsFromMapsUrl('https://www.google.com/maps/place/%/@19.0760,72.8777,17z'), { lat: 19.076, lng: 72.8777, accuracy: 0 });
});

test('mapsUrlProblem explains unusable links', () => {
  assert.equal(mapsUrlProblem(''), '');
  assert.equal(mapsUrlProblem('https://maps.google.com/%'), '');
  assert.notEqual(mapsUrlProblem('javascript:alert(1)'), '');
  assert.notEqual(mapsUrlProblem('maps.google.com/foo'), '');
  assert.notEqual(mapsUrlProblem('https://x/' + 'a'.repeat(5000)), '');
});

/* ---------- F12 manifest ---------- */

test('manifest diff: missing and undecodable photos make it incomplete, with a banner', () => {
  const s = store();
  s.recce.venue.photos = [photo({ id: 'v1' })];
  s.recce.network.photos = [photo({ id: 'n1', label: 'Speed result' })];
  s.recce.collateral.standeePhotos = [photo({ id: 'c1', label: 'Standee' }), photo({ id: 'v1' })]; // duplicate id counted once
  const exp = expectedPhotos(s.recce, s.id);
  assert.deepEqual(exp.map((e) => e.id), ['v1', 'n1', 'c1']);

  const all = diffManifest(exp, { v1: { ok: true }, n1: { ok: true }, c1: { ok: true } });
  assert.equal(all.complete, true);
  assert.equal(evidenceBanner(all), null);

  const some = diffManifest(exp, { v1: { ok: true }, n1: { ok: false, problem: 'undecodable' } });
  assert.equal(some.complete, false);
  assert.equal(some.included, 1);
  assert.deepEqual(some.missing.map((m) => [m.id, m.problem]), [['n1', 'undecodable'], ['c1', 'missing']]);
  const b = evidenceBanner(some)!;
  assert.match(b.title, /2 of 3 proof photos are missing/);
  assert.equal(b.lines.length, 2);
  assert.match(b.lines[0], /^Internet · Speed result/);
});

test('storeEvidence / allEvidenceRefs include submitted revisions once', () => {
  const s = store();
  s.recce.venue.photos = [photo({ id: 'now' })];
  const old = structuredClone(s.recce);
  old.venue.photos = [photo({ id: 'old' }), photo({ id: 'now' })];
  s.submissions = [{ id: 'sub-1', rev: 1, submittedAt: T, by: 'admin:a1', byName: 'A', recce: old, policy: { games: [], gameReadyTarget: 1, minDownMbps: 1 } }];
  assert.deepEqual(allPhotoRefs(s).map((p) => p.id), ['now'], 'allPhotoRefs keeps its meaning');
  assert.deepEqual(allEvidenceRefs(s).map((p) => p.id), ['now', 'old']);
  assert.deepEqual(storeEvidence(s).map((p) => p.id), ['now', 'old']);
});

test('sha256Hex', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

/* ---------- §6.8 / F20 ---------- */

test('laptopsLostOnResize lists only dropped laptops that hold evidence', () => {
  const lap = (id: string, over: Partial<Laptop> = {}): Laptop => ({ id, label: id, role: 'game', games: {}, launched: {}, drivers: false, windows: false, notes: '', photos: [], ...over });
  const list = [lap('a', { drivers: true }), lap('b'), lap('c', { photos: [photo()] }), lap('d', { notes: 'Dell' })];
  assert.deepEqual(laptopsLostOnResize(list, 1).map((l) => l.id), ['c', 'd']);
  assert.deepEqual(laptopsLostOnResize(list, 4), []);
  assert.deepEqual(laptopsLostOnResize(list, 0).map((l) => l.id), ['a', 'c', 'd']);
});

test('parseGames: trims, collapses spaces, dedupes', () => {
  assert.deepEqual(parseGames('Valorant,  Tekken   8 ,valorant,,\nEA FC 25'), ['Valorant', 'Tekken 8', 'EA FC 25']);
  assert.deepEqual(parseGames('Valorant,'), ['Valorant']);
  assert.deepEqual(parseGames('  '), []);
});
